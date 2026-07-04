// ---------------------------------------------------------------------------
// test/research-s5.test.mjs
// Research risk overlays on a basket (S5): the opt-in dailyGate /
// gateConfirmBars / volTarget / volLookback knobs in backtest/portfolio.mjs.
// Locks: default-off is BYTE-IDENTICAL to the legacy path; a confirmed daily
// gate flip flattens the book mid-cycle (one-bar lag) while the legacy monthly
// gate waits for its rebalance bar; a re-entry is a full rebalance that resets
// the rebalance clock; gateConfirmBars suppresses a one-day whipsaw; volTarget
// scales gross ~inversely with realized market vol and NEVER levers up; the
// research harness's split/holdout/determinism guarantees hold with the knobs
// on. All synthetic — offline-safe.
//
// The market proxy uses FLAT STEP LEVELS (100 -> 60 -> ...) so every SMA and
// gate flip bar is exact integer arithmetic, not a hand-tuned approximation:
// with gate `price > 0.9*sma20` and a 100->60 step at bar 200,
//   sma20(200+j) = 98 - 2j  (for 0 <= j <= 19)
//   raw ON  <=>  60 > 0.9*(98-2j)  <=>  j > 15.67
// so the raw gate reads OFF at bars 200..215 and ON again from bar 216.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import { runPortfolioBacktest } from '../backtest/portfolio.mjs';
import { evaluateBasket } from '../backtest/research/harness.mjs';
import { validateSpec } from '../backtest/dsl.mjs';

const DAY = 864e5;
const START = Date.UTC(2015, 0, 1); // well inside the in-sample era
function mkCandles(closes, startMs = START) {
  return closes.map((c, i) => ({ t: startMs + i * DAY, o: c, h: c, l: c, c, v: 1e9 }));
}
// Deterministic per-symbol walks (same PRNG as the xsmom tests).
function walk(n, drift, seed) {
  const closes = [100];
  let a = seed >>> 0;
  const rnd = () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + drift + 0.01 * (rnd() * 2 - 1)));
  return closes;
}
const SYMS = ['AAA', 'BBB', 'CCC'];
const GATE = ['>', ['price'], ['*', 0.9, ['sma', 20]]];
function mkSpec(extra = {}) {
  return {
    kind: 'BASKET', name: 's5-overlay-test', universe: SYMS,
    rank: ['mom', 21], k: 2, weighting: 'equal', rebalanceBars: 21,
    marketGate: GATE, ...extra,
  };
}

// The shared CRASH scenario: everything rises to bar 199, then gaps to 60% and
// keeps falling 2%/bar. The market steps 100 -> 60 at bar 200 (raw gate OFF at
// 200..215, back ON from 216 — see the header arithmetic).
const N = 260;
function crashSeries() {
  const data = {};
  [0.0015, 0.001, 0.0005].forEach((drift, j) => {
    const c = walk(N, drift, 11 + j);
    for (let i = 200; i < N; i++) c[i] = c[199] * 0.6 * Math.pow(0.98, i - 200);
    data[SYMS[j]] = mkCandles(c);
  });
  const m = [];
  for (let i = 0; i < N; i++) m.push(i < 200 ? 100 : 60);
  return { data, market: mkCandles(m) };
}

test('S5: default-off is byte-identical — absent knobs, dailyGate:false, and inert knobs all match legacy', () => {
  const { data, market } = crashSeries();
  const run = (spec) => {
    const r = runPortfolioBacktest({ spec, dataBySymbol: data, marketSeries: market, recordTrades: true });
    return JSON.stringify({ eq: r.equityCurve, trades: r.trades, decision: r.decision, metrics: r.metrics });
  };
  const legacy = run(mkSpec());
  assert.equal(run(mkSpec({ dailyGate: false })), legacy, 'dailyGate:false is the legacy path');
  assert.equal(run(mkSpec({ gateConfirmBars: 3, volLookback: 40 })), legacy, 'confirm/lookback are inert without dailyGate/volTarget');
});

test('S5: a confirmed daily-gate flip flattens the book mid-cycle; the legacy gate waits for its rebalance bar', () => {
  const { data, market } = crashSeries();
  const daily = runPortfolioBacktest({ spec: mkSpec({ dailyGate: true, gateConfirmBars: 2 }), dataBySymbol: data, marketSeries: market, recordTrades: true });
  const legacy = runPortfolioBacktest({ spec: mkSpec(), dataBySymbol: data, marketSeries: market, recordTrades: true });
  const t = (i) => market[i].t;

  // Daily: raw OFF at 200 (streak 1) and 201 (streak 2 = confirmed) -> the
  // flatten is DECIDED at 201 and EXECUTED at 202 (the one-bar lag holds).
  const exits = daily.trades.filter((tr) => /Daily regime gate exit/.test(tr.reason));
  assert.ok(exits.length >= 1, 'the daily gate exit fired');
  assert.ok(exits.every((tr) => tr.t === t(202) && tr.side === 'SELL'), 'every gate-exit SELL lands at bar 202');
  assert.ok(exits.every((tr) => /confirmed over 2 bars/.test(tr.reason)), 'the reason names the confirm buffer');
  assert.ok(daily.trades.every((tr) => !(tr.t > t(202) && tr.t < t(216))), 'flat while the gate stays off');

  // Legacy: the crash lands 11 bars into a cycle (last decision bar 189 + 21 =
  // 210), so the monthly-read gate only sees it at bar 210 and sells at 211.
  const legacyCrashSells = legacy.trades.filter((tr) => tr.side === 'SELL' && tr.t >= t(200));
  assert.ok(legacyCrashSells.length >= 1, 'legacy did exit eventually');
  assert.equal(legacyCrashSells[0].t, t(211), 'legacy exit waits for the scheduled rebalance');
  assert.ok(/Risk-off/.test(legacyCrashSells[0].reason), 'legacy keeps its scheduled risk-off wording');

  // Exiting 9 bars earlier in a 2%/bar decline leaves the daily-gated book richer
  // (compared BEFORE the daily run re-enters at 218, so re-entry P&L can't muddy it).
  assert.ok(daily.equityCurve[217] > legacy.equityCurve[217], 'the daily gate preserved capital through the crash');
});

test('S5: gate re-entry is a full rebalance at confirmed-ON + 1 and resets the rebalance clock', () => {
  const { data, market } = crashSeries();
  // Raw gate back ON from bar 216 (step arithmetic); confirm 2 -> confirmed at
  // 217, re-entry decision at 217, BUYs execute at 218.
  const daily = runPortfolioBacktest({ spec: mkSpec({ dailyGate: true, gateConfirmBars: 2 }), dataBySymbol: data, marketSeries: market, recordTrades: true });
  const t = (i) => market[i].t;
  const reentries = daily.trades.filter((tr) => /^Gate re-entry/.test(tr.reason));
  assert.ok(reentries.length >= 1, 're-entry buys happened');
  assert.ok(reentries.every((tr) => tr.t === t(218) && tr.side === 'BUY'), 're-entry BUYs land at bar 218 (confirmed 217 + one-bar lag)');

  // Clock reset: the re-entry decision at 217 makes the next SCHEDULED decision
  // bar 238 (217+21). Without the reset it would be 230 (the off-period schedule
  // 188 -> 209 -> 230). Slice the run to end at bar 238 so the LAST decision is
  // that scheduled one, and assert where it landed.
  const slice = (arr) => arr.slice(0, 239);
  const cut = {}; for (const s of SYMS) cut[s] = slice(data[s]);
  const sliced = runPortfolioBacktest({ spec: mkSpec({ dailyGate: true, gateConfirmBars: 2 }), dataBySymbol: cut, marketSeries: slice(market), recordTrades: true });
  assert.equal(sliced.decision.t, t(238), 'the next scheduled rebalance is a full cycle after the re-entry');
  assert.equal(sliced.decision.trigger, 'schedule', 'and it is labelled a scheduled one');
});

test('S5: gateConfirmBars suppresses a one-day whipsaw; confirm=1 does the honest one-bar round trip', () => {
  // Market flat at 100 with a single-day dip to 60 at bar 150 (raw gate OFF for
  // exactly that one bar — at 151 the window's sma20 is 98, and 100 > 88.2).
  const M = 200;
  const data = {};
  [0.0012, 0.0008, 0.0004].forEach((drift, j) => { data[SYMS[j]] = mkCandles(walk(M, drift, 21 + j)); });
  const dip = [], flat = [];
  for (let i = 0; i < M; i++) { dip.push(i === 150 ? 60 : 100); flat.push(100); }
  const spec3 = mkSpec({ dailyGate: true, gateConfirmBars: 3 });

  const withDip = runPortfolioBacktest({ spec: spec3, dataBySymbol: data, marketSeries: mkCandles(dip), recordTrades: true });
  const noDip = runPortfolioBacktest({ spec: spec3, dataBySymbol: data, marketSeries: mkCandles(flat), recordTrades: true });
  assert.deepEqual(withDip.trades, noDip.trades, 'a 1-day dip under a 3-bar confirm changes nothing');

  // Contrast: confirm=1 acts on the first flip — SELL-all executed at 151, and
  // the immediate re-open re-enters at 152. One honest, costed round trip.
  const twitchy = runPortfolioBacktest({ spec: mkSpec({ dailyGate: true, gateConfirmBars: 1 }), dataBySymbol: data, marketSeries: mkCandles(dip), recordTrades: true });
  const t = (i) => START + i * DAY;
  const exits = twitchy.trades.filter((tr) => /Daily regime gate exit/.test(tr.reason));
  assert.ok(exits.length >= 1 && exits.every((tr) => tr.t === t(151)), 'confirm=1 flattens on the dip');
  const reentries = twitchy.trades.filter((tr) => /^Gate re-entry/.test(tr.reason));
  assert.ok(reentries.length >= 1 && reentries.every((tr) => tr.t === t(152)), 'and re-enters the next bar');
});

test('S5: volTarget scales gross ~inversely with realized market vol and never levers up', () => {
  const M = 23; // decision at 21 (mom21 warm), execute at 22, read final state
  const data = {};
  [0.0012, 0.0008, 0.0004].forEach((drift, j) => { data[SYMS[j]] = mkCandles(walk(M, drift, 31 + j)); });
  const altMarket = (amp) => {
    const m = [100];
    for (let i = 1; i < M; i++) m.push(m[i - 1] * (i % 2 ? 1 + amp : 1 - amp));
    return mkCandles(m);
  };
  const invested = (r) => 1 - r.finalCash / r.equityCurve[r.equityCurve.length - 1];
  const specV = { ...mkSpec({ volTarget: 0.15, volLookback: 20 }) };
  delete specV.marketGate; // volTarget stands alone — no gate needed

  // ±3%/day alternating -> daily sd exactly 0.03 -> annVol 47.6% -> scalar 0.315.
  const hi = runPortfolioBacktest({ spec: specV, dataBySymbol: data, marketSeries: altMarket(0.03), recordTrades: true });
  const expect = 0.15 / (0.03 * Math.sqrt(252));
  assert.ok(Math.abs(invested(hi) - expect) < 0.01, `high vol trims exposure to ~${(expect * 100).toFixed(1)}% (got ${(invested(hi) * 100).toFixed(1)}%)`);
  assert.equal(hi.decision.volScalar, +expect.toFixed(4), 'the decision log reports the scalar');

  // Doubling the vol ~halves the exposure (inverse scaling).
  const hi2 = runPortfolioBacktest({ spec: specV, dataBySymbol: data, marketSeries: altMarket(0.06) });
  assert.ok(Math.abs(invested(hi2) / invested(hi) - 0.5) < 0.03, 'double vol -> ~half exposure');

  // Calm market (annVol ~3% < the 15% target): the cap holds at 1 — byte-identical
  // to the same spec WITHOUT volTarget. It can only de-risk, never lever.
  const calm = altMarket(0.002);
  const capped = runPortfolioBacktest({ spec: specV, dataBySymbol: data, marketSeries: calm, recordTrades: true });
  const specNoV = { ...specV }; delete specNoV.volTarget; delete specNoV.volLookback;
  const plain = runPortfolioBacktest({ spec: specNoV, dataBySymbol: data, marketSeries: calm, recordTrades: true });
  assert.equal(JSON.stringify(capped.equityCurve) + JSON.stringify(capped.trades), JSON.stringify(plain.equityCurve) + JSON.stringify(plain.trades), 'calm market -> scalar capped at 1 -> identical run');
});

test('S5: split integrity + determinism hold with every overlay knob on (through evaluateBasket)', () => {
  const M = 900;
  const data = {};
  [0.0012, 0.0008, 0.0004].forEach((drift, j) => { data[SYMS[j]] = mkCandles(walk(M, drift, 41 + j)); });
  const market = mkCandles(walk(M, 0.0006, 99));
  const spec = mkSpec({ dailyGate: true, gateConfirmBars: 2, volTarget: 0.15, volLookback: 20 });
  const iso = (i) => new Date(START + i * DAY).toISOString().slice(0, 10);
  const win = { from: iso(400), to: iso(700), warmupFrom: iso(100) };

  const a = evaluateBasket({ spec, dataBySymbol: data, marketSeries: market, ...win });
  // Corrupt every bar AFTER the window end, in every series incl. the market.
  const corrupt = {};
  for (const s of SYMS) corrupt[s] = data[s].map((c, i) => (i > 700 ? { ...c, c: c.c * 7 } : c));
  const mCorrupt = market.map((c, i) => (i > 700 ? { ...c, c: c.c * 0.1 } : c));
  const b = evaluateBasket({ spec, dataBySymbol: corrupt, marketSeries: mCorrupt, ...win });
  assert.deepEqual(a.equity, b.equity, 'post-window data cannot influence a knobs-on run');
  assert.deepEqual(a.metrics, b.metrics);

  const c = evaluateBasket({ spec, dataBySymbol: data, marketSeries: market, ...win });
  assert.equal(JSON.stringify(a.metrics) + JSON.stringify(a.trades), JSON.stringify(c.metrics) + JSON.stringify(c.trades), 'knobs-on runs are deterministic');
});

test('S5: makeS5Spec keeps the base bot\'s own gate signal, adds a buffer to an unbuffered one, and never mutates the base spec', async () => {
  const { makeS5Spec, gateParamsFrom, DEFAULTS } = await import('../backtest/research/s5-overlay.mjs');
  // Gate-param extraction: the two seed shapes + the no-gate fallback.
  assert.deepEqual(gateParamsFrom(['>', ['price'], ['*', 0.95, ['sma', 100]]]), { gateSma: 100, gateBuffer: 0.05 }, 'buffered quant gate extracted');
  assert.deepEqual(gateParamsFrom(['>', ['price'], ['sma', 200]]), { gateSma: 200, gateBuffer: DEFAULTS.gateBuffer }, 'an unbuffered gate keeps its SMA and GAINS the proven buffer');
  assert.deepEqual(gateParamsFrom(undefined), { gateSma: DEFAULTS.gateSma, gateBuffer: DEFAULTS.gateBuffer }, 'no gate -> the proven default shape');

  const base = mkSpec({ marketGate: ['>', ['price'], ['*', 0.95, ['sma', 100]]] });
  const frozen = JSON.stringify(base);
  const armB = makeS5Spec(base, {}, { daily: true, vol: false });
  assert.equal(armB.spec.dailyGate, true);
  assert.deepEqual(armB.spec.marketGate, ['>', ['price'], ['*', 0.95, ['sma', 100]]], 'the SAME signal, now read daily');
  assert.equal(armB.spec.volTarget, undefined, 'gate-only arm carries no vol knobs');
  const armC = makeS5Spec(base, {}, { daily: false, vol: true });
  assert.equal(armC.spec.dailyGate, undefined, 'vol-only arm leaves the gate cadence alone');
  assert.equal(armC.spec.volTarget, DEFAULTS.volTarget);
  assert.equal(JSON.stringify(base), frozen, 'the shared seed spec is never mutated');
});

test('S5: the validator accepts the overlay knobs in range and rejects them out of range', () => {
  const ok = mkSpec({ dailyGate: true, gateConfirmBars: 3, volTarget: 0.2, volLookback: 63 });
  assert.equal(validateSpec(ok), null, 'a fully-loaded overlay spec validates');
  const bad = (extra, re) => {
    const s = mkSpec(extra);
    if (extra._dropGate) delete s.marketGate;
    assert.match(String(validateSpec(s)), re);
  };
  bad({ dailyGate: true, _dropGate: true }, /dailyGate requires basket\.marketGate/);
  bad({ dailyGate: 'yes' }, /dailyGate must be a boolean/);
  bad({ gateConfirmBars: 0 }, /gateConfirmBars must be 1\.\.10/);
  bad({ gateConfirmBars: 11 }, /gateConfirmBars must be 1\.\.10/);
  bad({ volTarget: 0 }, /volTarget must be in \(0,1\)/);
  bad({ volTarget: 1 }, /volTarget must be in \(0,1\)/);
  bad({ volLookback: 19 }, /volLookback must be 20\.\.252/);
  bad({ volLookback: 253 }, /volLookback must be 20\.\.252/);
});
