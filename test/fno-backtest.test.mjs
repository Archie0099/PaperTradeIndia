// ---------------------------------------------------------------------------
// test/fno-backtest.test.mjs
// Locks the F&O (option-selling) backtester: the short-premium P&L logic must be
// directionally correct through the REAL engine. Pure + offline (Black-Scholes-
// modelled option prices, hand-made underlying series) — no network.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runFnoBacktest, FNO_STRATEGIES } from '../backtest/fno.mjs';
import { priceOptionAt } from '../backtest/options-model.mjs';

const candlesFrom = (closes) => closes.map((c, i) => ({ t: i * 864e5, c }));
const shortStraddle = FNO_STRATEGIES.find((s) => s.name.startsWith('Short straddle'));

test('option model: at expiry an option settles at intrinsic value', () => {
  assert.equal(priceOptionAt('CE', 20500, 20000, 0, 0.2), 500); // ITM call -> 500
  assert.equal(priceOptionAt('PE', 20500, 20000, 0, 0.2), 0); // OTM put -> 0
  assert.ok(priceOptionAt('CE', 20000, 20000, 30, 0.2) > 0); // ATM with time -> positive
});

test('flat market: a short straddle harvests premium and ENDS in profit', () => {
  const res = runFnoBacktest({ strategy: shortStraddle, candles: candlesFrom(new Array(300).fill(20000)), symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50 });
  assert.ok(res.metrics.finalEquity > 1_000_000, `flat market should profit a premium seller, got ₹${res.metrics.finalEquity}`);
  assert.ok(res.metrics.trades > 0, 'it should have traded');
});

test('crashing market: a naked short straddle LOSES (the short put goes deep ITM)', () => {
  let p = 20000;
  const closes = [];
  for (let i = 0; i < 300; i++) { closes.push(+p.toFixed(2)); p *= 0.997; } // ~ -60% drift
  const res = runFnoBacktest({ strategy: shortStraddle, candles: candlesFrom(closes), symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50 });
  assert.ok(res.metrics.finalEquity < 1_000_000, `a big move should hurt a naked seller, got ₹${res.metrics.finalEquity}`);
});

test('all F&O strategies run to finite metrics without throwing', () => {
  // A wobbly but rangey series.
  const closes = [];
  let p = 20000;
  for (let i = 0; i < 260; i++) { p *= 1 + Math.sin(i / 7) * 0.01; closes.push(+p.toFixed(2)); }
  for (const strat of FNO_STRATEGIES) {
    const res = runFnoBacktest({ strategy: strat, candles: candlesFrom(closes), symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50 });
    assert.ok(Number.isFinite(res.metrics.finalEquity), `${strat.name} finite equity`);
    assert.ok(res.metrics.finalEquity > 0, `${strat.name} long-wing/defined or capital floors keep equity > 0`);
  }
});

test('an unfundable multi-leg cycle opens NOTHING — never a half-legged (naked) book', () => {
  // Regression for the half-legged-strangle bug. Each leg is funded INDEPENDENTLY,
  // so a SELL leg reserves margin (premium + notional × %) which shrinks available
  // funds; with lots large enough that the account can fund the FIRST leg but not
  // the SECOND, the old code kept the lone filled leg — silently turning a 2-leg
  // straddle/strangle into a NAKED single-leg DIRECTIONAL position (with a totally
  // different, unbounded-risk profile, whose violent mark-to-market never matched a
  // logged trade). The atomic open must instead roll the first leg back and skip the
  // cycle (the book sits flat — exactly as fno.mjs's header documents).
  // A gently wavy series keeps realised vol > 0 (so legs are priceable, isolating the
  // FUNDS path) but rangey (no big directional P&L to muddy the assertion).
  const closes = [];
  let p = 20000;
  for (let i = 0; i < 80; i++) { p *= 1 + Math.sin(i / 7) * 0.01; closes.push(+p.toFixed(2)); }
  const bigStraddle = { name: 'big straddle', note: '', entry: (spot) => [
    { type: 'CE', side: 'SELL', strike: spot, lots: 4 },
    { type: 'PE', side: 'SELL', strike: spot, lots: 4 },
  ] };
  const res = runFnoBacktest({ strategy: bigStraddle, candles: candlesFrom(closes), symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, recordTrades: true });
  assert.equal(res.metrics.trades, 0, 'no half-legged cycle should open when a leg cannot be funded');
  assert.ok(Math.abs(res.metrics.finalEquity - 1_000_000) < 0.01, `a rolled-back partial fill leaves the account untouched, got ₹${res.metrics.finalEquity}`);
  assert.equal((res.trades || []).length, 0, 'the trade log shows no leg from a skipped cycle');
});

test('every opened cycle carries its FULL set of legs (opens come in complete batches)', () => {
  // The complement of the test above: when a cycle CAN be funded, all its legs open
  // together. Group the "(open)" trades by bar timestamp (one batch per cycle) and
  // assert each batch has exactly the strategy's leg count — so a 2-leg straddle is
  // never recorded (nor run) as a lone leg. A wavy, well-funded (lots=1) run trades.
  const closes = [];
  let p = 20000;
  for (let i = 0; i < 120; i++) { p *= 1 + Math.sin(i / 7) * 0.01; closes.push(+p.toFixed(2)); }
  const res = runFnoBacktest({ strategy: shortStraddle, candles: candlesFrom(closes), symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, recordTrades: true });
  const openBatches = new Map();
  for (const tr of res.trades || []) if (tr.side.includes('(open)')) openBatches.set(tr.t, (openBatches.get(tr.t) || 0) + 1);
  assert.ok(openBatches.size > 0, 'the funded straddle should have opened at least one cycle');
  for (const [t, count] of openBatches) assert.equal(count, 2, `cycle opened at ${t} must have BOTH legs, had ${count}`);
});

test('keepOpen keeps the final un-expired cycle OPEN and marked-to-market (not force-settled)', () => {
  // The LIVE tournament passes keepOpen:true so the board can show a bot's CURRENT position.
  // The old code clamped the final cycle's expiry to the last bar and force-closed it there,
  // so every F&O bot looked "flat" and couldn't be copied. A flat market keeps the short
  // seller solvent, so the final cycle is genuinely open at the data boundary — it must now
  // be shown OPEN (its real legs), not settled.
  const res = runFnoBacktest({ strategy: shortStraddle, candles: candlesFrom(new Array(300).fill(20000)), symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, keepOpen: true });
  assert.match(res.position, /^open:/, 'the live F&O bot shows its OPEN position, not "flat"');
  assert.ok((res.finalPositions || []).length >= 1, 'it exposes its open legs (so the Auto-Pilot can copy it)');
  assert.ok(res.finalPositions.every((p) => p.kind === 'OPT' && p.qty < 0), 'they are SHORT option legs (sold premium)');
});

test('a BACKTEST (keepOpen=false) still settles the final cycle flat (close-out at the end of the run)', () => {
  const res = runFnoBacktest({ strategy: shortStraddle, candles: candlesFrom(new Array(300).fill(20000)), symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, keepOpen: false });
  assert.doesNotMatch(res.position, /^open:/, 'a finished backtest closes out, not left open');
  assert.equal((res.finalPositions || []).length, 0, 'no open legs after a settled backtest');
});

test('the keepOpen:false final-stub settle is LABELLED mark-to-market, not "intrinsic" (honest trade-history reason)', () => {
  // The final stub cycle (n=296 -> opens ~2 bars before the end) settles EARLY at its model MARK
  // (time value intact), not at a true expiry. The trade-history reason must say so, not claim
  // "intrinsic value" (it carries substantial time value here — ATM intrinsic is ₹0).
  const candles = candlesFrom(new Array(296).fill(20000));
  const res = runFnoBacktest({ strategy: shortStraddle, candles, symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, keepOpen: false, recordTrades: true });
  const closes = (res.trades || []).filter((t) => /\(close\)/.test(t.side));
  assert.ok(closes.length, 'has close trades');
  const last = closes[closes.length - 1];
  assert.doesNotMatch(last.reason, /intrinsic/, 'an early MTM settle is NOT labelled "intrinsic"');
  assert.match(last.reason, /mark-to-market/, 'it is honestly labelled an early mark-to-market close');
});

test('the open final cycle is valued at honest mark-to-market — the backtest realises that SAME value (no phantom)', () => {
  // n=296 opens the final cycle only ~2 bars before the end (a "stub" with lots of remaining
  // time value). The OLD path priced its open at a full ~21-day premium but SETTLED it at
  // intrinsic, booking ~19 days of unearned decay as a phantom profit (and, for an ITM put, an
  // inconsistent discounted-vs-undiscounted gap). Now the keepOpen:false close realises each leg
  // at its CURRENT MARK (model price) — exactly the value the keepOpen:true open MTM shows — so
  // the two agree and neither over- nor under-credits. (This FAILS on the old intrinsic-settle.)
  const candles = candlesFrom(new Array(296).fill(20000));
  const open = runFnoBacktest({ strategy: shortStraddle, candles, symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, keepOpen: true });
  const settled = runFnoBacktest({ strategy: shortStraddle, candles, symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, keepOpen: false });
  assert.match(open.position, /^open:/, 'the final stub cycle is genuinely open (the case that used to phantom-profit)');
  assert.ok(Math.abs(open.metrics.finalEquity - settled.metrics.finalEquity) < 0.01, `the backtest realises the open cycle at its mark, not a phantom intrinsic — open ₹${open.metrics.finalEquity} vs settled ₹${settled.metrics.finalEquity}`);
});

test('a huge irregular gap at the FINAL bar still marks the open cycle to time value (not collapsed to intrinsic)', () => {
  // A long exchange closure right at the data edge could make the whole-series-average
  // extrapolated expiry land BEFORE the last bar → daysLeft 0 → the open cycle wrongly marked at
  // intrinsic (re-introducing the very mis-valuation the fix removes). The clamp (expiry strictly
  // after the last bar) keeps the open legs marked with real remaining time value.
  const candles = new Array(40).fill(20000).map((c, i) => ({ t: i * 864e5, c }));
  candles[39].t = candles[38].t + 700 * 864e5; // a ~700-day gap at the very end
  const res = runFnoBacktest({ strategy: shortStraddle, candles, symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, keepOpen: true });
  assert.match(res.position, /^open:/, 'the final cycle is shown open');
  const legs = (res.finalPositions || []).filter((p) => p.kind === 'OPT');
  assert.ok(legs.length >= 1 && legs.every((p) => p.price > 1), 'open legs are marked with real time value (model price), not collapsed to ~intrinsic 0.05');
});

test('a BACKTEST with a bad (zero/NaN) FINAL bar settles at the last valid price — no fabricated loss', () => {
  // A flat solvent series, then corrupt the last two bars (0 then NaN). The post-loop settle
  // of the still-open final cycle must use the last GOOD spot, not the garbage one — settling
  // a short straddle/put at spot 0 would fabricate a catastrophic full-strike intrinsic loss
  // (or a NaN equity). Clean data never hits this; the guard keeps a single bad print honest.
  const closes = new Array(300).fill(20000);
  closes[298] = 0;
  closes[299] = NaN;
  const res = runFnoBacktest({ strategy: shortStraddle, candles: candlesFrom(closes), symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 50, keepOpen: false });
  assert.ok(Number.isFinite(res.metrics.finalEquity), 'finite equity (no NaN from a garbage settle)');
  assert.ok(res.metrics.finalEquity > 500000, `no fabricated catastrophic loss from a bad final bar, got ₹${res.metrics.finalEquity}`);
  assert.doesNotMatch(res.position, /^open:/, 'the cycle was still settled (flat), not left open');
});

test('F&O legs that snap to the same strike are skipped, not silently netted to flat', () => {
  // A huge strikeStep rounds the condor's CE pair (and PE pair) to one strike
  // each → they'd share an instrument key and cancel. The cycle must be SKIPPED.
  const condor = { name: 'ic', note: '', entry: (spot) => [
    { type: 'CE', side: 'SELL', strike: spot * 1.03 }, { type: 'CE', side: 'BUY', strike: spot * 1.06 },
    { type: 'PE', side: 'SELL', strike: spot * 0.97 }, { type: 'PE', side: 'BUY', strike: spot * 0.94 },
  ] };
  const res = runFnoBacktest({ strategy: condor, candles: candlesFrom(new Array(60).fill(20000)), symbol: 'NIFTY', cash: 1_000_000, lotSize: 75, strikeStep: 5000 });
  assert.equal(res.metrics.trades, 0, 'every cycle collided on strike and was skipped');
  assert.equal(res.metrics.finalEquity, 1_000_000, 'no collapsed/half-hedged position was opened');
});
