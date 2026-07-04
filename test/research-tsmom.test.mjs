// ---------------------------------------------------------------------------
// test/research-tsmom.test.mjs
// The strategy research lab: the TSMOM vol-target strategy, the shared research
// evaluation harness (fixed split + one-shot holdout gate + profit factor /
// turnover), and the new Sortino metric. All on synthetic data — offline-safe.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeTsmom } from '../backtest/research/tsmom.mjs';
import { evaluate, sliceWindow, profitFactor, turnoverPerYear, IN_SAMPLE_END } from '../backtest/research/harness.mjs';
import { runBacktest } from '../backtest/backtester.mjs';
import { sortino, sharpe, summarize } from '../backtest/metrics.mjs';

// Deterministic candles: one bar per UTC day, huge volume so the participation
// flag never fires incidentally.
const DAY = 864e5;
function mkCandles(closes, startMs = Date.UTC(2015, 0, 1)) {
  return closes.map((c, i) => ({ t: startMs + i * DAY, o: c, h: c, l: c, c, v: 1e9 }));
}

// A deterministic pseudo-random walk (no Math.random — reproducible runs).
function walk(n, { start = 100, drift = 0.0004, amp = 0.01, seed = 7 } = {}) {
  const closes = [start];
  let a = seed >>> 0;
  const rnd = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + drift + amp * (rnd() * 2 - 1)));
  return closes;
}

// Drive a strategy's decide() directly over a close series; returns the weight
// decided at each bar. Lets tests assert on the SIGNAL without the engine between.
function decideAll(strategy, closes) {
  const d = strategy.make();
  return closes.map((_, i) => d({ closes, i, price: closes[i] }));
}

// --- sortino ----------------------------------------------------------------

test('sortino: penalises only downside, caps a wiped curve at <= 0, flat curve is 0', () => {
  // Steady climb with small dips: positive mean, downside dev < full dev, so
  // (at rf 0) Sortino must exceed Sharpe and both must be positive.
  const eq = [100];
  for (let i = 0; i < 100; i++) eq.push(eq[eq.length - 1] * (i % 3 === 2 ? 0.995 : 1.02));
  const so = sortino(eq, 252, 0);
  const sh = sharpe(eq, 252, 0);
  assert.ok(sh > 0, `sharpe positive (got ${sh})`);
  assert.ok(so > sh, `sortino ${so} should exceed sharpe ${sh} when vol is mostly upside`);

  // A wiped curve (touches <= 0) can never advertise a positive Sortino, even
  // with strong surviving early gains (mirrors the sharpe honesty cap).
  const wiped = [100, 150, 220, 300, -5, 1, 1, 1];
  assert.ok(sortino(wiped, 252, 0) <= 0, 'wiped curve must not show positive sortino');

  // No downside at all -> 0 by convention (never Infinity); flat curve -> 0.
  assert.equal(sortino([100, 100, 100, 100], 252, 0), 0);
  assert.equal(sortino([100, 101, 102.01, 103.03], 252, 0), 0);

  // summarize carries it alongside the existing fields (nothing removed).
  const m = summarize(eq);
  assert.ok(Number.isFinite(m.sortino));
  for (const k of ['sharpe', 'sharpeRf0', 'cagrPct', 'maxDrawdownPct']) assert.ok(k in m, `summarize keeps ${k}`);
});

// --- the TSMOM signal (decide() driven directly) ------------------------------

// Small, fast parameterisation for signal tests; killDD:1 disables the switch
// except where a test targets it.
const FAST = { smaLen: 20, volLookback: 5, exitBuffer: 0.05, volTarget: 0.12, deadband: 0, killDD: 1 };

test('tsmom hysteresis: enters above the SMA, holds inside the buffer zone, exits below it', () => {
  const strat = makeTsmom(FAST);
  const closes = [];
  const d = strat.make();
  const w = [];
  const step = (px) => { closes.push(px); w.push(d({ closes, i: closes.length - 1, price: px })); };
  const smaNow = (n) => closes.slice(-n).reduce((a, b) => a + b, 0) / n;

  for (let k = 0; k < 25; k++) step(100);          // flat: price == SMA, never strictly above
  assert.equal(w[w.length - 1], 0, 'flat series never enters');
  for (let k = 0; k < 10; k++) step(110);          // jump above the SMA -> trend ON
  assert.ok(w[w.length - 1] > 0, 'enters above the SMA');

  // Craft a close INSIDE the buffer zone (0.95·SMA < px < SMA, both computed
  // WITH the candidate included): search downward from the current SMA.
  let inZone = null;
  for (let px = 109; px > 90; px -= 0.25) {
    const s = (closes.slice(-(FAST.smaLen - 1)).reduce((a, b) => a + b, 0) + px) / FAST.smaLen;
    if (px < s && px > 0.95 * s) { inZone = px; break; }
  }
  assert.ok(inZone != null, 'found a buffer-zone price');
  step(inZone);
  assert.ok(w[w.length - 1] > 0, `still long inside the buffer zone (px ${inZone}, sma ${smaNow(FAST.smaLen).toFixed(2)})`);

  step(0.90 * smaNow(FAST.smaLen));                 // decisively below 0.95·SMA -> OFF
  assert.equal(w[w.length - 1], 0, 'exits below the buffer');
});

test('tsmom vol targeting: weight ~halves when vol doubles, caps at 1 when calm', () => {
  // Uptrend + alternating oscillation of amplitude amp: realized vol scales
  // with amp, so the vol-target weight should scale ~inversely.
  const mk = (amp) => {
    const closes = [];
    for (let i = 0; i < 60; i++) closes.push(100 * Math.pow(1.004, i) * (1 + (i % 2 ? amp : -amp)));
    return closes;
  };
  const wLo = decideAll(makeTsmom(FAST), mk(0.004));
  const wHi = decideAll(makeTsmom(FAST), mk(0.008));
  const lo = wLo[55], hi = wHi[55];
  assert.ok(lo > 0 && hi > 0, `both in the trend (${lo}, ${hi})`);
  assert.ok(hi < lo, 'doubled vol -> smaller weight');
  assert.ok(hi / lo > 0.35 && hi / lo < 0.65, `~half (ratio ${(hi / lo).toFixed(2)})`);

  // Near-zero vol: the cap binds — never leveraged above 1.
  const calm = [];
  for (let i = 0; i < 60; i++) calm.push(100 * Math.pow(1.0004, i));
  const wCalm = decideAll(makeTsmom(FAST), calm);
  assert.equal(wCalm[55], 1, 'calm trend -> capped at exactly 1 (no leverage)');
  assert.ok(wCalm.every((x) => x >= 0 && x <= 1), 'long-only, never leveraged');
});

test('tsmom deadband: sizing drift below the band holds the position; exits always trade', () => {
  const p = { ...FAST, deadband: 0.5 }; // huge band: sizing should freeze while in-trend
  const closes = [];
  const d = makeTsmom(p).make();
  const w = [];
  const step = (px) => { closes.push(px); w.push(d({ closes, i: closes.length - 1, price: px })); };
  // Warm up into the trend with modest vol, then let vol drift.
  for (let i = 0; i < 30; i++) step(100 * Math.pow(1.003, i) * (1 + (i % 2 ? 0.004 : -0.004)));
  const entered = w.findIndex((x) => x > 0);
  assert.ok(entered > 0, 'entered the trend');
  for (let i = 30; i < 45; i++) step(closes[closes.length - 1] * (1 + (i % 2 ? 0.006 : -0.002)));
  const inTrend = w.slice(entered).filter((x) => x > 0);
  assert.ok(new Set(inTrend).size === 1, `deadband holds the size steady (saw ${new Set(inTrend).size} distinct sizes)`);
  // Crash far below the buffer: the exit must NOT be deadband-suppressed.
  step(closes[closes.length - 1] * 0.7);
  assert.equal(w[w.length - 1], 0, 'exit always trades, even with a huge deadband');
});

test('tsmom kill-switch: a >30% proxy drawdown goes flat permanently (control re-enters)', () => {
  // Calm, low-vol climb (weight pinned at 1), then a -35% single-bar crash,
  // then a strong recovery well above the SMA. The killDD:0.3 run must stay
  // flat forever after the crash; a killDD:1 control re-enters on recovery.
  const closes = [];
  for (let i = 0; i < 60; i++) closes.push(100 * Math.pow(1.001, i));
  closes.push(closes[59] * 0.65, closes[59] * 0.64); // crash: proxy DD ~35% (weight was ~1)
  for (let i = 0; i < 80; i++) closes.push(closes[closes.length - 1] * 1.01); // V-recovery
  const armed = decideAll(makeTsmom({ ...FAST, killDD: 0.30 }), closes);
  const control = decideAll(makeTsmom({ ...FAST, killDD: 1 }), closes);
  assert.ok(control.slice(70).some((x) => x > 0), 'control (no kill) re-enters after the recovery');
  assert.ok(armed.slice(62).every((x) => x === 0), 'killed run stays flat forever after the crash');
  assert.ok(armed.slice(0, 60).some((x) => x > 0), 'killed run WAS long before the crash');
});

// --- no look-ahead / determinism through the real backtester -----------------

test('tsmom no-look-ahead: corrupting every bar after k leaves the curve identical up to k', () => {
  const closes = walk(600, { seed: 11 });
  const k = 400;
  const strat = makeTsmom({ ...FAST, smaLen: 50 });
  const a = runBacktest({ strategy: strat, candles: mkCandles(closes), recordTrades: false });
  const mangled = closes.map((c, i) => (i > k ? c * (1 + 0.4 * Math.sin(i)) : c)); // finite+positive garbage
  const b = runBacktest({ strategy: strat, candles: mkCandles(mangled), recordTrades: false });
  assert.deepEqual(a.equityCurve.slice(0, k + 1), b.equityCurve.slice(0, k + 1),
    'equity up to bar k must not depend on bars after k');
  assert.notDeepEqual(a.equityCurve.slice(k + 1), b.equityCurve.slice(k + 1),
    'sanity: the corruption really changed the future');
});

test('research evaluate: deterministic, scores only past the warmup, honours the window', () => {
  const closes = walk(900, { seed: 3 });
  const start = Date.UTC(2016, 0, 1);
  const candles = mkCandles(closes, start);
  const from = new Date(start + 300 * DAY).toISOString().slice(0, 10);
  const to = new Date(start + 700 * DAY).toISOString().slice(0, 10);
  const opts = { strategy: makeTsmom(FAST), candles, from, to, warmupBars: 100, benchmark: true };

  const r1 = evaluate(opts);
  const r2 = evaluate(opts);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2), 'two identical runs -> identical output');

  // The scored window starts at `from` (warmup excluded) and never passes `to`.
  assert.equal(r1.window.from, from);
  assert.equal(r1.window.warmupBars, 100);
  const fromMs = Date.parse(from), toMs = Date.parse(to) + DAY - 1;
  assert.ok(r1.trades.every((tr) => tr.t >= fromMs && tr.t <= toMs), 'no scored trade outside the window');
  assert.equal(r1.times[0], fromMs, 'scoring starts exactly at the first bar >= from');
  assert.ok(r1.times[r1.times.length - 1] <= toMs, 'no bar after to');
  // Benchmark ran through the same window and the same cost model.
  assert.equal(r1.benchmark.window.from, r1.window.from);
  assert.equal(r1.benchmark.costs.model, r1.costs.model);
  assert.equal(r1.costs.model, 'eq-delivery', 'the lab default is the REAL delivery cost schedule');
});

test('research holdout gate: refuses a window past 2019-12-31 unless explicitly allowed', () => {
  // Candles spanning the split boundary.
  const n = 800;
  const start = IN_SAMPLE_END - 700 * DAY;
  const candles = mkCandles(walk(n, { seed: 5 }), start);
  assert.throws(
    () => evaluate({ strategy: makeTsmom(FAST), candles }),
    /HOLDOUT LOCKED/,
    'an unbounded window reaches the holdout and must throw');
  const ok = evaluate({ strategy: makeTsmom(FAST), candles, allowHoldout: true, benchmark: false });
  assert.ok(ok.metrics && ok.window.bars > 0, 'explicit opt-in runs');
  const inSample = evaluate({ strategy: makeTsmom(FAST), candles, to: '2019-12-31', benchmark: false });
  assert.ok(Date.parse(inSample.window.to) <= IN_SAMPLE_END, 'in-sample window stays inside the cutoff');
});

test('research profitFactor + turnover conventions', () => {
  assert.equal(profitFactor([{ realised: 10 }, { realised: -5 }, { realised: 0 }]), 2);
  assert.equal(profitFactor([{ realised: 10 }]), Infinity);
  assert.equal(profitFactor([]), null);
  assert.equal(profitFactor([{ realised: 0 }]), null);
  // ₹1m traded in total (both sides) on a flat ₹1m book over 1 year = 0.5
  // round-trip turns/yr.
  const eq = new Array(10).fill(1_000_000);
  assert.equal(turnoverPerYear([{ value: 500_000 }, { value: 500_000 }], eq, 1), 0.5);
  assert.equal(turnoverPerYear([], eq, 0), null);
});

test('rebalanceBand: suppresses same-side sizing drift, never entries or exits; default off is byte-identical', () => {
  // A constant 50% target on a wandering price: cash sits still while the
  // position value moves, so without a band the engine micro-trades ~every bar.
  const half = { name: 'half', note: '', make: () => ({ closes, i }) => (i >= 1 ? 0.5 : 0) };
  const candles = mkCandles(walk(120, { seed: 9, amp: 0.02, drift: 0 }));
  const free = runBacktest({ strategy: half, candles, recordTrades: true });
  const banded = runBacktest({ strategy: half, candles, recordTrades: true, rebalanceBand: 0.10 });
  assert.ok(free.trades.length > 20, `unbanded drift-trades a lot (got ${free.trades.length})`);
  assert.equal(banded.trades.length, 1, 'banded: only the entry trades; all drift suppressed');
  assert.equal(banded.trades[0].side, 'BUY');

  // An EXIT must always trade, however large the band.
  const inOut = { name: 'inout', note: '', make: () => ({ i }) => (i >= 1 && i < 60 ? 0.5 : 0) };
  const exited = runBacktest({ strategy: inOut, candles, recordTrades: true, rebalanceBand: 0.99 });
  assert.equal(exited.trades.length, 2, 'entry + full exit, nothing else');
  assert.equal(exited.trades[1].side, 'SELL');
  assert.equal(exited.position, 'flat (cash)');

  // Default (no band) is byte-identical to a run before the option existed —
  // the tournament/legacy path must be untouched.
  const again = runBacktest({ strategy: half, candles, recordTrades: true, rebalanceBand: 0 });
  assert.deepEqual(again.equityCurve, free.equityCurve);
  assert.equal(again.trades.length, free.trades.length);
});

test('sliceWindow: warmup clamps at the series start; bad windows throw', () => {
  const candles = mkCandles(walk(100, { seed: 1 }));
  const w = sliceWindow(candles, { from: new Date(candles[10].t).toISOString().slice(0, 10), warmupBars: 50 });
  assert.equal(w.scoreStart, 10, 'only 10 warmup bars exist -> clamped');
  assert.equal(w.candles.length, 100);
  assert.throws(() => sliceWindow(candles, { from: '2030-01-01' }), /after the data ends/);
  assert.throws(() => sliceWindow(candles, { from: '2015-03-01', to: '2015-01-05' }), /empty window/);
});
