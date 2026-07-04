// ---------------------------------------------------------------------------
// test/costs.test.mjs
// Locks the Indian transaction-cost model (backtest/costs.mjs) + its threading:
//   * every schedule component is HAND-COMPUTED here from the published rates,
//     so a typo in the model can't hide behind its own arithmetic,
//   * the SLB borrow fee actually accrues on a held short (EQ + PAIRS), and the
//     MASTER money invariant EXTENDS exactly with fees:
//         realised + unrealised − fees == equity − initialCash
//   * F&O legs genuinely pay spread/charges/brokerage (equity strictly lower),
//   * the volume-participation flag fires on oversized fills and stays quiet on
//     liquid ones,
//   * the Sharpe is excess-of-risk-free (and sharpeRf0 is reported alongside),
//   * the adjusted-close loader (toAdjusted) re-bases correctly and never mixes
//     adjusted and raw scales in one series.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  equityDeliveryCosts, equityIntradayCosts, indexOptionCosts, flatCosts,
  eqFillPrice, optFillPrice, borrowFee,
} from '../backtest/costs.mjs';
import { runBacktest } from '../backtest/backtester.mjs';
import { runFnoBacktest, FNO_STRATEGIES } from '../backtest/fno.mjs';
import { runPairsBacktest } from '../backtest/pairs.mjs';
import { feesCharged } from '../backtest/harness.mjs';
import { toAdjusted } from '../backtest/data.mjs';
import { sharpe, summarize } from '../backtest/metrics.mjs';

const DAY = 86400000;
const T0 = 1600000000000;

// --- the schedules, hand-computed from the published rates -------------------

test('equity delivery schedule matches the hand-computed all-in rates', () => {
  const m = equityDeliveryCosts(); // default 5bps slippage
  // buy: STT 0.10% + stamp 0.015% + exchange 0.00297%×1.18 GST + SEBI 0.0001% + 5bps slip
  const buy = 0.001 + 0.00015 + 0.0000297 * 1.18 + 0.000001 + 0.0005;
  const sell = 0.001 + 0.0000297 * 1.18 + 0.000001 + 0.0005; // no stamp on sell
  assert.ok(Math.abs(m.buyRate - buy) < 1e-12, `buyRate ${m.buyRate} != hand-computed ${buy}`);
  assert.ok(Math.abs(m.sellRate - sell) < 1e-12, `sellRate ${m.sellRate} != hand-computed ${sell}`);
  // A ₹100 buy costs a shade under ₹100.17; a ₹100 sell nets a shade over ₹99.84.
  assert.ok(Math.abs(eqFillPrice(m, 'BUY', 100) - 100 * (1 + buy)) < 1e-12);
  assert.ok(Math.abs(eqFillPrice(m, 'SELL', 100) - 100 * (1 - sell)) < 1e-12);
});

test('equity intraday schedule: STT sell-side only, lighter stamp', () => {
  const m = equityIntradayCosts(); // default 3bps slippage
  const buy = 0.00003 + 0.0000297 * 1.18 + 0.000001 + 0.0003; // NO STT on an intraday buy
  const sell = 0.00025 + 0.0000297 * 1.18 + 0.000001 + 0.0003; // STT 0.025% on the sell
  assert.ok(Math.abs(m.buyRate - buy) < 1e-12);
  assert.ok(Math.abs(m.sellRate - sell) < 1e-12);
  assert.ok(m.buyRate < equityDeliveryCosts().buyRate, 'intraday is cheaper than delivery');
  assert.equal(m.borrowRatePA, 0, 'an intraday short needs no SLB borrow');
});

test('index option schedule: premium-based charges + half-spread + tick floor + dust clamp', () => {
  const m = indexOptionCosts();
  const buy = 0.00003 + 0.003503 * 1.18 + 0.000001;          // stamp + exchange(GST) + SEBI
  const sell = 0.001 + 0.003503 * 1.18 + 0.000001;           // STT on sell premium instead of stamp
  assert.ok(Math.abs(m.buyRate - buy) < 1e-12);
  assert.ok(Math.abs(m.sellRate - sell) < 1e-12);
  // ₹100 mid: half-spread = max(0.5% of 100, one tick) = ₹0.50 crossed each way.
  assert.ok(Math.abs(optFillPrice(m, 'SELL', 100) - 99.5 * (1 - sell)) < 1e-12, 'sell = (mid − half-spread) × (1 − charges)');
  assert.ok(Math.abs(optFillPrice(m, 'BUY', 100) - 100.5 * (1 + buy)) < 1e-12, 'buy = (mid + half-spread) × (1 + charges)');
  // ₹2 mid: the proportional half-spread (1p) is under one tick — the ₹0.05 floor wins.
  assert.ok(Math.abs(optFillPrice(m, 'BUY', 2) - 2.05 * (1 + buy)) < 1e-12, 'half-spread floors at one ₹0.05 tick');
  // Selling dust: (0.05 − 0.05) would be ₹0 — clamped to ₹0.01 so the engine can book it.
  assert.equal(optFillPrice(m, 'SELL', 0.05), 0.01, 'a dust sell clamps to ₹0.01, never ≤ 0');
  assert.equal(m.brokeragePerOrder, 20);
  assert.ok(Math.abs(m.settleLongSttRate - 0.00125) < 1e-12);
});

test('flatCosts reproduces the legacy costBps behaviour exactly', () => {
  const m = flatCosts(5);
  assert.ok(Math.abs(eqFillPrice(m, 'BUY', 200) - 200 * 1.0005) < 1e-12);
  assert.ok(Math.abs(eqFillPrice(m, 'SELL', 200) - 200 * 0.9995) < 1e-12);
  assert.equal(m.borrowRatePA, 0);
});

test('borrowFee: 6%/yr on ₹10L held one year = ₹60,000; zero for no-short/no-rate/no-time', () => {
  assert.ok(Math.abs(borrowFee(1_000_000, 0.06, 365.25 * DAY) - 60_000) < 1e-6);
  assert.equal(borrowFee(0, 0.06, DAY), 0);
  assert.equal(borrowFee(1_000_000, 0, DAY), 0);
  assert.equal(borrowFee(1_000_000, 0.06, 0), 0);
});

// --- borrow accrual on a held EQ short --------------------------------------

const flatCandles = (n, price = 100, v = null) => Array.from({ length: n }, (_, i) => ({ t: T0 + i * DAY, c: price, ...(v != null ? { v } : {}) }));
const alwaysShort = { name: 'always short', make: () => () => -1 };
const buyHold = { name: 'buy & hold', make: () => () => 1 };

test('a held short accrues the SLB borrow fee — and equity drops by EXACTLY the fees', () => {
  const candles = flatCandles(30);
  const withBorrow = runBacktest({ strategy: alwaysShort, candles, cash: 1_000_000, costModel: equityDeliveryCosts({ borrowRatePA: 0.06 }) });
  const noBorrow = runBacktest({ strategy: alwaysShort, candles, cash: 1_000_000, costModel: equityDeliveryCosts({ borrowRatePA: 0 }) });
  const fees = withBorrow.costs.feesPaid;
  assert.ok(fees > 0, 'borrow fees accrued on the held short');
  // The equity gap is the fees PLUS a sliver of re-sizing churn: as fees drain
  // equity, target −1 shrinks the desired short by a few units each bar, and those
  // tiny covers pay trading costs too. So: gap ≥ fees, and the churn is tiny.
  const eqW = withBorrow.equityCurve[withBorrow.equityCurve.length - 1];
  const eqN = noBorrow.equityCurve[noBorrow.equityCurve.length - 1];
  const gap = eqN - eqW;
  assert.ok(gap >= fees - 0.01, `equity gap ${gap} covers the fees ${fees}`);
  assert.ok(gap - fees < 50, `beyond the fees only re-sizing churn remains (${gap - fees})`);
  // Magnitude sanity: ~₹10L notional short held ~28 days at 6%/yr ≈ ₹4,600.
  const expect = 1_000_000 * 0.06 * (28 / 365.25);
  assert.ok(fees > expect * 0.7 && fees < expect * 1.3, `fees ${fees} in the ballpark of ${expect}`);
  assert.equal(noBorrow.costs.feesPaid, 0);
});

// --- PAIRS: borrow accrues on the short legs + the fee-extended MASTER invariant

// The same co-moving fixture pairs.test.mjs uses (deterministic, no RNG).
function makePairData(n = 260) {
  const A = [], B = [], C = [], D = [];
  for (let i = 0; i < n; i++) {
    const t = T0 + i * DAY;
    const common = 1000 * Math.exp(0.0002 * i);
    const osc1 = 0.045 * Math.sin(i / 11);
    const osc2 = 0.035 * Math.cos(i / 13);
    A.push({ t, c: common * (1 + osc1) });
    B.push({ t, c: common * 0.6 * (1 - osc1) });
    C.push({ t, c: common * 1.3 * (1 + osc2) });
    D.push({ t, c: common * 0.9 * (1 - osc2) });
  }
  return { A, B, C, D };
}
const pairSpec = {
  kind: 'PAIRS', name: 'test pairs', universe: ['A', 'B', 'C', 'D'],
  lookback: 30, entryZ: 2, exitZ: 0.5, stopZ: 4, maxPairs: 2, formationBars: 10, minCorr: 0, gross: 0.9,
};

test('PAIRS with the real cost model: borrow fees accrue and the fee-extended MASTER invariant holds', () => {
  let captured = null;
  const res = runPairsBacktest({
    spec: pairSpec, dataBySymbol: makePairData(), cash: 10_000_000,
    costModel: equityDeliveryCosts(), _hook: (engine) => { captured = engine; },
  });
  assert.ok(res.metrics.trades > 0, 'the fixture actually trades');
  assert.ok(res.costs.feesPaid > 0, 'short legs paid an SLB borrow fee');
  // realised + unrealised − fees == equity − initialCash, exact (float tolerance).
  const lhs = captured.realisedTotal() + captured.unrealisedTotal() - feesCharged(captured);
  const rhs = captured.equity() - captured.state.initialCash;
  assert.ok(Math.abs(lhs - rhs) < 0.01, `fee-extended MASTER invariant: ${lhs} vs ${rhs}`);
});

// --- F&O: legs genuinely pay costs -------------------------------------------

test('F&O with the option cost model pays spread + charges + brokerage (strictly worse than free)', () => {
  // A gently-trending index so cycles open, mark, and expire normally.
  const candles = Array.from({ length: 130 }, (_, i) => ({ t: T0 + i * DAY, c: 20000 * (1 + 0.0002 * i) }));
  const strangle = FNO_STRATEGIES.find((s) => /strangle/i.test(s.name));
  const free = runFnoBacktest({ strategy: strangle, candles, symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50 });
  const costed = runFnoBacktest({ strategy: strangle, candles, symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, costModel: indexOptionCosts() });
  assert.equal(free.costs.model, 'none');
  assert.equal(costed.costs.model, 'index-opt');
  assert.ok(costed.costs.feesPaid > 0, 'flat brokerage was charged');
  const eqFree = free.equityCurve[free.equityCurve.length - 1];
  const eqCosted = costed.equityCurve[costed.equityCurve.length - 1];
  assert.ok(eqCosted < eqFree, `with real costs the seller keeps less (${eqCosted} < ${eqFree})`);
});

test('F&O volPremium is honest: selling at fair value (1.0) earns less than at 1.2', () => {
  // NOISY series: a smooth ramp has ~zero realized vol, so modelIV would sit at its
  // 8% floor for EVERY volPremium and the knob would (correctly) do nothing. Real
  // sensitivity needs realized vol above the floor — add a deterministic wiggle.
  const candles = Array.from({ length: 130 }, (_, i) => ({ t: T0 + i * DAY, c: 20000 * (1 + 0.0002 * i) * (1 + 0.012 * Math.sin(i / 2)) }));
  const strangle = FNO_STRATEGIES.find((s) => /strangle/i.test(s.name));
  const fair = runFnoBacktest({ strategy: strangle, candles, symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, volPremium: 1.0 });
  const rich = runFnoBacktest({ strategy: strangle, candles, symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, volPremium: 1.2 });
  const eqFair = fair.equityCurve[fair.equityCurve.length - 1];
  const eqRich = rich.equityCurve[rich.equityCurve.length - 1];
  assert.ok(eqFair < eqRich, `the seller's edge scales with the vol premium (${eqFair} < ${eqRich})`);
});

// --- liquidity participation flag --------------------------------------------

test('participation flag fires on oversized fills and stays quiet on liquid bars', () => {
  // Tiny volume: 50 shares × ₹100 = ₹5,000 traded/bar; the first buy is ~₹10L — flagged.
  const thin = runBacktest({ strategy: buyHold, candles: flatCandles(10, 100, 50), cash: 1_000_000, costBps: 0 });
  assert.ok(thin.liquidity.checked > 0);
  assert.ok(thin.liquidity.flagged > 0, 'a ₹10L fill against ₹5k of volume must be flagged');
  // Deep volume: 10M shares/bar — the same fill is a rounding error, no flags.
  const deep = runBacktest({ strategy: buyHold, candles: flatCandles(10, 100, 10_000_000), cash: 1_000_000, costBps: 0 });
  assert.ok(deep.liquidity.checked > 0);
  assert.equal(deep.liquidity.flagged, 0);
  // No volume data at all -> nothing checked (the flag never guesses).
  const noVol = runBacktest({ strategy: buyHold, candles: flatCandles(10, 100), cash: 1_000_000, costBps: 0 });
  assert.equal(noVol.liquidity.checked, 0);
});

// --- excess-rf Sharpe ---------------------------------------------------------

test('Sharpe is excess-of-risk-free by default; sharpeRf0 reported alongside', () => {
  // A noisy, upward-drifting curve (same construction as the annualisation test).
  const eq = [100];
  for (let i = 1; i < 200; i++) eq.push(eq[i - 1] * (1 + 0.0006 + (((i * 73) % 7) - 3) * 0.001));
  const excess = sharpe(eq);           // default rf ≈ 6.5%
  const raw = sharpe(eq, 252, 0);      // rf = 0
  assert.ok(excess < raw, `the rf hurdle must lower the Sharpe (${excess} < ${raw})`);
  const m = summarize(eq);
  assert.ok(Math.abs(m.sharpe - +excess.toFixed(2)) < 1e-9, 'summarize.sharpe is the excess figure');
  assert.ok(Math.abs(m.sharpeRf0 - +raw.toFixed(2)) < 1e-9, 'summarize.sharpeRf0 is the rf=0 figure');
});

// --- the adjusted-close loader -------------------------------------------------

test('toAdjusted re-bases onto the adjusted close and keeps the raw close as craw', () => {
  const raw = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * DAY, c: 100 + i, a: (100 + i) / 2, v: 1000 }));
  const { candles, adjusted } = toAdjusted(raw);
  assert.equal(adjusted, true);
  assert.equal(candles.length, 20);
  assert.equal(candles[0].c, 50);      // trades on the adjusted price
  assert.equal(candles[0].craw, 100);  // the raw print is preserved for display/volume value
  assert.equal(candles[0].v, 1000);
});

test('toAdjusted drops a bar missing its adjclose rather than mixing scales', () => {
  const raw = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * DAY, c: 100, a: i === 7 ? null : 50 }));
  const { candles, adjusted } = toAdjusted(raw);
  assert.equal(adjusted, true);
  assert.equal(candles.length, 19, 'the one a-less bar is dropped, not served raw');
  assert.ok(candles.every((c) => c.c === 50));
});

test('toAdjusted leaves an unadjusted (intraday / legacy) series untouched', () => {
  const raw = Array.from({ length: 20 }, (_, i) => ({ t: T0 + i * DAY, c: 100 + i }));
  const { candles, adjusted } = toAdjusted(raw);
  assert.equal(adjusted, false);
  assert.deepEqual(candles, raw);
  // Under 90% coverage counts as unadjusted too (never mix scales).
  const sparse = raw.map((c, i) => (i < 10 ? { ...c, a: 50 } : c));
  assert.equal(toAdjusted(sparse).adjusted, false);
});
