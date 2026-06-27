// ---------------------------------------------------------------------------
// test/portfolio.test.mjs
// Locks the MULTI-COMPANY (basket) backtester IN ISOLATION:
//   * alignSeries forward-fills correctly and never points past the current bar,
//   * a 1-symbol basket reproduces the single-symbol Buy & Hold (proves it really
//     runs THROUGH the same engine),
//   * the MASTER money invariant holds after a multi-symbol run,
//   * NO LOOK-AHEAD (flipping the last bar changes nothing before it),
//   * different lengths / missing bars give no NaN,
//   * it is DETERMINISTIC, gross < 1 leaves cash, and trading incurs cost.
// Pure + offline (deterministic synthetic candles, no network).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPortfolioBacktest, alignSeries, weightsFor } from '../backtest/portfolio.mjs';
import { runBacktest } from '../backtest/backtester.mjs';
import { safeCompile } from '../backtest/dsl.mjs';
import { makeRankSource } from '../backtest/ml.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// N symbols with distinct trends + noise so momentum ranking actually differs.
function universeData(syms = ['AAA', 'BBB', 'CCC', 'DDD'], n = 400) {
  const data = {};
  syms.forEach((s, k) => {
    const rng = mulberry32(2000 + k * 13);
    let p = 100 + k * 5;
    const candles = [];
    for (let i = 0; i < n; i++) { p *= 1 + (0.0002 + k * 0.0003) + (rng() - 0.5) * 0.025; candles.push({ t: i * 864e5, c: +p.toFixed(2) }); }
    data[s] = candles;
  });
  return data;
}
const CASH = 10_000_000;
const momSpec = (extra = {}) => ({ kind: 'BASKET', name: 'mom', universe: ['AAA', 'BBB', 'CCC', 'DDD'], rank: ['mom', 63], k: 2, weighting: 'equal', rebalanceBars: 21, ...extra });

test('decision.mlWeights is null on a risk-off final rebalance (no STALE model weights shown)', () => {
  // Regression: rankSource (the only thing that retrains the model) is called ONLY inside
  // the risk-ON candidates loop. On a risk-off final rebalance
  // the model isn't consulted, so getWeights() would return a STALE model from an earlier
  // risk-on cycle — misdating the "what the model learned" panel. It must be null instead.
  const data = universeData(['AAA', 'BBB', 'CCC', 'DDD'], 500);
  // NIFTY rises, then crashes hard at the end so the marketGate fails on the final rebalance.
  const market = []; let p = 18000;
  for (let i = 0; i < 500; i++) { p *= i < 450 ? 1.0012 : 0.96; market.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  const mlCfg = { model: 'ridge', features: ['mom21', 'mom63'], horizon: 21, lambda: 1, lookback: 252, trainEveryBars: 42, minTrain: 40 };
  const base = { kind: 'BASKET', name: 'ml', universe: ['AAA', 'BBB', 'CCC', 'DDD'], rank: ['mom', 63], k: 2, weighting: 'equal', rebalanceBars: 21, mlConfig: mlCfg };

  // (a) WITH a market gate that is risk-off on the final rebalance -> mlWeights must be null.
  const gated = { ...base, name: 'ml gated', marketGate: ['>', ['price'], ['sma', 50]] };
  const rGated = runPortfolioBacktest({ spec: gated, dataBySymbol: data, marketSeries: market, cash: CASH, rankSource: makeRankSource({ spec: gated, dataBySymbol: data }), recordTrades: true });
  assert.equal(rGated.decision.riskOn, false, 'the final rebalance is risk-off (market below its average)');
  assert.equal(rGated.decision.mlWeights, null, 'no stale model weights are surfaced on a risk-off cycle');

  // (b) the SAME ML basket WITHOUT the gate (always risk-on) DOES surface trained weights —
  // proving (a)'s null is the risk-off guard, not a cold/untrained model.
  const open = { ...base, name: 'ml open' };
  const rOpen = runPortfolioBacktest({ spec: open, dataBySymbol: data, marketSeries: market, cash: CASH, rankSource: makeRankSource({ spec: open, dataBySymbol: data }), recordTrades: true });
  assert.notEqual(rOpen.decision.riskOn, false, 'no gate -> risk-on');
  assert.ok(rOpen.decision.mlWeights && Array.isArray(rOpen.decision.mlWeights.features), 'a risk-on ML basket surfaces its trained feature weights');
});

test('a shared alignCache is byte-identical to a fresh align (the pass-scoped grid memo is transparent)', () => {
  // computeStandings passes one alignCache across baskets so those over the SAME wide
  // universe build the forward-filled grid only once. The grid is read-only, so a cache hit must
  // produce EXACTLY the same result as a fresh align — this proves the optimisation changed nothing.
  const data = universeData(['AAA', 'BBB', 'CCC', 'DDD'], 400);
  const market = []; let p = 18000;
  for (let i = 0; i < 400; i++) { p *= 1.0008; market.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  const spec = momSpec();
  const fresh = runPortfolioBacktest({ spec, dataBySymbol: data, marketSeries: market, cash: CASH });
  const cache = new Map();
  const first = runPortfolioBacktest({ spec, dataBySymbol: data, marketSeries: market, cash: CASH, alignCache: cache });
  const second = runPortfolioBacktest({ spec, dataBySymbol: data, marketSeries: market, cash: CASH, alignCache: cache }); // a cache HIT (reuses the grid)
  assert.deepEqual(first.equityCurve, fresh.equityCurve, 'caching the grid does not change results');
  assert.deepEqual(second.equityCurve, fresh.equityCurve, 'a cache HIT is identical to a fresh align');
  assert.equal(cache.size, 1, 'one aligned grid cached for the shared universe (the saving)');
  // A DIFFERENT universe is a SEPARATE cache entry — no wrong-key collision.
  runPortfolioBacktest({ spec: momSpec({ universe: ['AAA', 'BBB', 'CCC'] }), dataBySymbol: data, marketSeries: market, cash: CASH, alignCache: cache });
  assert.equal(cache.size, 2, 'a different universe gets its own cache entry');
});

test('alignCache keys on the DATA not just the universe NAMES — same names + different data never collide', () => {
  // The latent landmine: a name-only key let two baskets over the SAME names
  // but DIFFERENT data (e.g. a future intraday basket, or a different market series) share one grid,
  // so the second silently traded the FIRST's prices (~33% wrong in the repro). The data-fingerprint
  // key (each name's first:last:length + the market fingerprint) prevents that collision.
  const up = universeData(['AAA', 'BBB'], 200); // rising-ish trends
  const down = {}; // the SAME names, DIFFERENT data (falling) — a stand-in for a different interval/source
  ['AAA', 'BBB'].forEach((s, k) => { const a = []; let p = 100 + k * 5; for (let i = 0; i < 200; i++) { p *= 1 - (0.001 + k * 0.0005); a.push({ t: i * 864e5, c: +p.toFixed(2) }); } down[s] = a; });
  const spec = { kind: 'BASKET', name: 'mom', universe: ['AAA', 'BBB'], rank: ['mom', 20], k: 1, weighting: 'equal', rebalanceBars: 21 };
  const truthUp = runPortfolioBacktest({ spec, dataBySymbol: up, cash: CASH });
  const truthDown = runPortfolioBacktest({ spec, dataBySymbol: down, cash: CASH });
  assert.notDeepEqual(truthUp.equityCurve, truthDown.equityCurve, 'the two datasets genuinely differ (the test is meaningful)');
  const cache = new Map();
  const cUp = runPortfolioBacktest({ spec, dataBySymbol: up, cash: CASH, alignCache: cache });
  const cDown = runPortfolioBacktest({ spec, dataBySymbol: down, cash: CASH, alignCache: cache }); // same names, DIFFERENT data
  assert.equal(cache.size, 2, 'same universe but different DATA -> two distinct cache entries (no collision)');
  assert.deepEqual(cUp.equityCurve, truthUp.equityCurve, 'the up-data basket is correct');
  assert.deepEqual(cDown.equityCurve, truthDown.equityCurve, 'the down-data basket is NOT corrupted by the shared cache');
});

test('basket trade reasons explain why each name was entered / exited (rank-based)', () => {
  const data = universeData(['AAA', 'BBB', 'CCC', 'DDD'], 400);
  const res = runPortfolioBacktest({ spec: momSpec(), dataBySymbol: data, cash: CASH, recordTrades: true });
  assert.ok(res.trades.length >= 2, 'the basket rebalanced at least once');
  for (const tr of res.trades) assert.ok(typeof tr.reason === 'string' && tr.reason.length > 0, 'every trade carries a reason');
  assert.ok(res.trades.some((t) => t.side === 'BUY' && /Entered|Increased/.test(t.reason)), 'a buy explains entry + rank');
  assert.ok(res.trades.some((t) => t.side === 'SELL' && /(Exited|Trimmed|Risk-off)/.test(t.reason)), 'a sell explains the exit');
  // The rank metric (the 63-day return) is named in an entry reason.
  assert.ok(res.trades.some((t) => /return/.test(t.reason)), 'the ranking metric is named in a reason');
});

test('alignSeries forward-fills, leaves leading gaps null, and never points past the current bar', () => {
  const data = { AAA: [{ t: 0, c: 10 }, { t: 1, c: 11 }, { t: 2, c: 12 }, { t: 3, c: 13 }], BBB: [{ t: 1, c: 20 }, { t: 3, c: 22 }] };
  const A = alignSeries(data);
  assert.deepEqual(A.master, [0, 1, 2, 3], 'master is the numeric-sorted union');
  assert.deepEqual(A.priceGrid.AAA, [10, 11, 12, 13]);
  assert.deepEqual(A.priceGrid.BBB, [null, 20, 20, 22], 'BBB: pre-listing null, then forward-filled across the gap');
  assert.deepEqual(A.realIdx.BBB, [-1, 0, 0, 1], 'realIdx is -1 pre-listing and holds across the interior gap');
  // realIdx must NEVER reference a bar later than the current master time.
  for (const s of Object.keys(data)) for (let gi = 0; gi < A.master.length; gi++) {
    const ri = A.realIdx[s][gi];
    if (ri >= 0) assert.ok(A.timesBy[s][ri] <= A.master[gi], `${s}@${gi} realIdx points at-or-before now`);
  }
});

test('weightsFor: equal / rankw / volinv all sum to gross and guard zero-vol', () => {
  const top = [{ sym: 'A', vol: 0.02 }, { sym: 'B', vol: 0 }, { sym: 'C', vol: null }];
  for (const w of ['equal', 'rankw', 'volinv']) {
    const ws = weightsFor(top, w, 0.9);
    assert.ok(Math.abs(ws.reduce((a, b) => a + b, 0) - 0.9) < 1e-9, `${w} sums to gross`);
    assert.ok(ws.every((x) => Number.isFinite(x) && x >= 0), `${w} weights finite & non-negative (no 1/0)`);
  }
});

test('a 1-symbol basket reproduces single-symbol Buy & Hold (runs through the same engine)', () => {
  const candles = universeData(['AAA'], 300).AAA;
  const basket = runPortfolioBacktest({ spec: { kind: 'BASKET', name: 'solo', universe: ['AAA'], rank: ['price'], k: 1, weighting: 'equal', rebalanceBars: 21 }, dataBySymbol: { AAA: candles }, cash: CASH });
  const bh = runBacktest({ strategy: safeCompile({ kind: 'EQ', name: 'bh', weight: 1 }).strategy, candles, symbol: 'AAA', cash: CASH });
  assert.ok(Math.abs(basket.metrics.totalReturnPct - bh.metrics.totalReturnPct) < 0.01,
    `basket ${basket.metrics.totalReturnPct}% should match Buy & Hold ${bh.metrics.totalReturnPct}%`);
});

test('MASTER invariant holds after a multi-symbol basket run', () => {
  let engine = null;
  runPortfolioBacktest({ spec: momSpec(), dataBySymbol: universeData(), cash: CASH, _hook: (e) => { engine = e; } });
  const lhs = engine.realisedTotal() + engine.unrealisedTotal();
  const rhs = engine.equity() - CASH;
  assert.ok(Math.abs(lhs - rhs) < 0.01, `realised+unrealised (${lhs}) == equity-initialCash (${rhs})`);
});

test('NO LOOK-AHEAD: flipping the last bar changes nothing on any earlier bar', () => {
  const data = universeData();
  const base = runPortfolioBacktest({ spec: momSpec(), dataBySymbol: data, cash: CASH });
  const flipped = JSON.parse(JSON.stringify(data));
  for (const s of Object.keys(flipped)) { const arr = flipped[s]; arr[arr.length - 1].c *= 1.5; } // change only the LAST bar
  const after = runPortfolioBacktest({ spec: momSpec(), dataBySymbol: flipped, cash: CASH });
  const n = base.equityCurve.length;
  for (let i = 0; i < n - 1; i++) assert.equal(base.equityCurve[i], after.equityCurve[i], `equity at bar ${i} must not depend on a future bar`);
});

test('different lengths / interior missing bars produce no NaN', () => {
  const data = universeData(['AAA', 'BBB', 'CCC', 'DDD'], 400);
  // CCC lists late (drop its first 120 bars) and DDD has an interior gap.
  data.CCC = data.CCC.slice(120);
  data.DDD = data.DDD.filter((_, i) => i % 7 !== 0);
  const res = runPortfolioBacktest({ spec: momSpec(), dataBySymbol: data, cash: CASH });
  assert.ok(res.equityCurve.every(Number.isFinite), 'no NaN anywhere in the curve');
  assert.ok(Number.isFinite(res.metrics.finalEquity) && res.metrics.finalEquity > 0);
});

test('deterministic: same spec + data -> identical equity curve and holdings', () => {
  const data = universeData();
  const a = runPortfolioBacktest({ spec: momSpec(), dataBySymbol: data, cash: CASH });
  const b = runPortfolioBacktest({ spec: momSpec(), dataBySymbol: data, cash: CASH });
  assert.deepEqual(a.equityCurve, b.equityCurve);
  assert.deepEqual(a.holdings, b.holdings);
});

test('gross < 1 leaves cash; trading the basket incurs cost', () => {
  const data = universeData();
  const partial = runPortfolioBacktest({ spec: momSpec({ k: 4, gross: 0.5 }), dataBySymbol: data, cash: CASH });
  const invested = partial.holdings.reduce((a, h) => a + h.weightPct, 0);
  assert.ok(invested > 30 && invested < 60, `~50% invested with gross 0.5, got ${invested}%`);
  assert.ok(partial.finalCash > 0, 'cash left over');

  const free = runPortfolioBacktest({ spec: momSpec(), dataBySymbol: data, cash: CASH, costBps: 0 });
  const costly = runPortfolioBacktest({ spec: momSpec(), dataBySymbol: data, cash: CASH, costBps: 50 });
  assert.ok(costly.metrics.trades >= 2, 'a top-2 basket trades at least twice');
  assert.ok(costly.metrics.totalReturnPct <= free.metrics.totalReturnPct + 1e-9, 'higher cost never helps');
});

// --- Quant Lab: FACTOR baskets + OPTIMISER weightings -----------------------
const factorSpec = (extra = {}) => ({
  kind: 'BASKET', name: 'factor', universe: ['AAA', 'BBB', 'CCC', 'DDD'], rank: ['mom', 63],
  factors: [{ name: 'mom', expr: ['mom', 63], weight: 1 }, { name: 'lowvol', expr: ['*', -1, ['vol', 20]], weight: 0.5 }],
  k: 2, weighting: 'equal', rebalanceBars: 21, ...extra,
});
const optSpec = (weighting, extra = {}) => ({
  kind: 'BASKET', name: weighting, universe: ['AAA', 'BBB', 'CCC', 'DDD'], rank: ['mom', 63],
  k: 3, weighting, rebalanceBars: 21, covLookback: 60, maxWeight: 0.6, ...extra,
});

test('FACTOR basket runs through the engine: MASTER invariant holds + no NaN', () => {
  let engine = null;
  const res = runPortfolioBacktest({ spec: factorSpec(), dataBySymbol: universeData(), cash: CASH, _hook: (e) => { engine = e; } });
  assert.ok(res.equityCurve.every(Number.isFinite), 'no NaN in the curve');
  const lhs = engine.realisedTotal() + engine.unrealisedTotal();
  assert.ok(Math.abs(lhs - (engine.equity() - CASH)) < 0.01, 'realised+unrealised == equity-initialCash');
});

test('FACTOR basket: deterministic + NO LOOK-AHEAD (flipping the last bar changes nothing earlier)', () => {
  const data = universeData();
  const base = runPortfolioBacktest({ spec: factorSpec(), dataBySymbol: data, cash: CASH });
  const again = runPortfolioBacktest({ spec: factorSpec(), dataBySymbol: data, cash: CASH });
  assert.deepEqual(base.equityCurve, again.equityCurve, 'same spec + data -> identical curve');
  const flipped = JSON.parse(JSON.stringify(data));
  for (const s of Object.keys(flipped)) { const a = flipped[s]; a[a.length - 1].c *= 1.5; }
  const after = runPortfolioBacktest({ spec: factorSpec(), dataBySymbol: flipped, cash: CASH });
  for (let i = 0; i < base.equityCurve.length - 1; i++) assert.equal(base.equityCurve[i], after.equityCurve[i], `bar ${i} independent of the future`);
});

test('FACTOR basket: the decision log carries each name’s per-factor z-scores', () => {
  const res = runPortfolioBacktest({ spec: factorSpec(), dataBySymbol: universeData(), cash: CASH, recordTrades: true });
  assert.ok(res.decision && Array.isArray(res.decision.candidates), 'a decision was recorded');
  const c = res.decision.candidates.find((x) => Array.isArray(x.factors));
  assert.ok(c, 'candidates carry a per-factor z breakdown');
  assert.equal(c.factors.length, 2, 'both factors are recorded');
  assert.ok(c.factors.every((f) => typeof f.name === 'string' && Number.isFinite(f.z)), 'each factor has a finite z');
});

test('OPTIMISER baskets (meanvar/riskparity): MASTER invariant, target weights capped + summing <= gross, deterministic', () => {
  for (const weighting of ['meanvar', 'riskparity']) {
    let engine = null;
    const data = universeData();
    const res = runPortfolioBacktest({ spec: optSpec(weighting), dataBySymbol: data, cash: CASH, recordTrades: true, _hook: (e) => { engine = e; } });
    assert.ok(res.equityCurve.every(Number.isFinite), `${weighting}: no NaN`);
    const lhs = engine.realisedTotal() + engine.unrealisedTotal();
    assert.ok(Math.abs(lhs - (engine.equity() - CASH)) < 0.01, `${weighting}: MASTER invariant holds`);
    const chosen = res.decision.candidates.filter((c) => c.chosen);
    for (const c of chosen) assert.ok(c.weightPct <= 60 + 1e-6, `${weighting}: ${c.sym} target weight within the 60% cap`);
    assert.ok(chosen.reduce((s, c) => s + c.weightPct, 0) <= 100 + 0.5, `${weighting}: target weights sum to <= gross`);
    // determinism
    const b = runPortfolioBacktest({ spec: optSpec(weighting), dataBySymbol: data, cash: CASH });
    assert.deepEqual(res.equityCurve, b.equityCurve, `${weighting}: deterministic`);
    // a chosen name carries a risk-contribution %
    assert.ok(chosen.some((c) => Number.isFinite(c.riskPct)), `${weighting}: a risk-contribution % is surfaced`);
  }
});

test('OPTIMISER falls back gracefully when the covariance window is unavailable (short history) — no NaN, no mislabelled Risk %', () => {
  // covLookback longer than the series -> the optimiser can't build a window -> inverse-vol fallback.
  const res = runPortfolioBacktest({ spec: optSpec('meanvar', { covLookback: 500 }), dataBySymbol: universeData(['AAA', 'BBB', 'CCC', 'DDD'], 200), cash: CASH, recordTrades: true });
  assert.ok(res.equityCurve.every(Number.isFinite) && res.metrics.finalEquity > 0, 'graceful fallback, no NaN');
  // When the optimiser FELL BACK to inverse-vol, the per-bot page must NOT surface a "Risk %" computed
  // on the fallback weights yet labelled as the optimiser's risk share.
  const chosen = res.decision.candidates.filter((c) => c.chosen);
  assert.ok(chosen.length && chosen.every((c) => c.riskPct == null), 'no optimiser Risk % is surfaced on the fallback path');
});

test('OPTIMISER with an infeasible per-name cap (maxWeight·k < 1) stays FULLY invested (falls back, no idle cash)', () => {
  // Cap 0.4 with k=2 can only deploy 0.8 of gross. The fix degrades to
  // inverse-vol (which sums to gross), so the basket is fully invested, not 80% in cash.
  const res = runPortfolioBacktest({ spec: optSpec('meanvar', { k: 2, maxWeight: 0.4, covLookback: 60 }), dataBySymbol: universeData(), cash: CASH, recordTrades: true });
  const chosen = res.decision.candidates.filter((c) => c.chosen);
  const totalTargetPct = chosen.reduce((s, c) => s + c.weightPct, 0);
  assert.ok(totalTargetPct >= 99, `target weights sum to ~100% (fully invested), got ${totalTargetPct}% (would be ~80% unfixed)`);
});
