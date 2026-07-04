// ---------------------------------------------------------------------------
// test/research-xsmom.test.mjs
// Research strategy (cross-sectional 12-1 momentum basket) + the research
// harness's basket path: the 12-1 DSL rank expression, window/split integrity,
// the pre-run holdout gate, the regime gate, determinism, and the kill-switch
// breach report. All synthetic — offline-safe.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeXsmomSpec, rank12_1 } from '../backtest/research/xsmom.mjs';
import { evaluateBasket, killSwitchBreach, IN_SAMPLE_END } from '../backtest/research/harness.mjs';
import { evalNode } from '../backtest/dsl.mjs';

const DAY = 864e5;
function mkCandles(closes, startMs = Date.UTC(2015, 0, 1)) {
  return closes.map((c, i) => ({ t: startMs + i * DAY, o: c, h: c, l: c, c, v: 1e9 }));
}
// Deterministic per-symbol walks with different drifts, so ranks are distinct.
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
// A small synthetic universe + an always-up market proxy (gate open).
function mkUniverse(n = 900, startMs = Date.UTC(2015, 0, 1)) {
  const drifts = { AAA: 0.0012, BBB: 0.0008, CCC: 0.0004, DDD: 0.0000, EEE: -0.0006 };
  const data = {};
  Object.keys(drifts).forEach((s, j) => { data[s] = mkCandles(walk(n, drifts[s], 11 + j), startMs); });
  const market = mkCandles(walk(n, 0.0006, 99), startMs);
  return { data, market };
}
const SYMS = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];

test('rank12_1: exactly close[i-skip]/close[i-lookback]-1, null while unwarm', () => {
  const closes = walk(400, 0.0005, 42);
  const expr = rank12_1(252, 21);
  const i = 399;
  const expected = closes[i - 21] / closes[i - 252] - 1;
  assert.ok(Math.abs(evalNode(expr, closes, i) - expected) < 1e-12, '12-1 formula exact');
  assert.equal(evalNode(expr, closes, 251), null, 'unwarm (i < lookback) -> null, so the name is excluded');
  assert.ok(Number.isFinite(evalNode(expr, closes, 252)), 'warm exactly at i = lookback');
});

test('makeXsmomSpec: validates via the shared validateSpec; integer knobs rounded; skip < lookback enforced', () => {
  const { spec, params } = makeXsmomSpec(SYMS, { lookback: 126.4, skip: 10.6, k: 3.2, rebalanceBars: 10.5 });
  assert.equal(params.lookback, 126);
  assert.equal(params.skip, 11);
  assert.equal(params.k, 3);
  assert.equal(params.rebalanceBars, 11); // rounds, stays within the DSL's 5..63
  assert.equal(spec.kind, 'BASKET');
  assert.equal(spec.weighting, 'volinv');
  // skip can never reach the lookback (the expression would be degenerate).
  // (k passed explicitly: the default k=10 exceeds this 5-name test universe,
  // which the shared validator correctly rejects — locked below.)
  const clamped = makeXsmomSpec(SYMS, { lookback: 30, skip: 60, k: 2 });
  assert.ok(clamped.params.skip < clamped.params.lookback);
  // A bad spec still throws through the shared validator (k > universe).
  assert.throws(() => makeXsmomSpec(SYMS, { k: 50 }), /basket\.k/);
});

test('evaluateBasket: split integrity — data beyond `to` is clipped, so corrupting it changes nothing', () => {
  const { data, market } = mkUniverse();
  const { spec } = makeXsmomSpec(SYMS, { lookback: 126, skip: 10, k: 2, rebalanceBars: 10 });
  const from = new Date(data.AAA[400].t).toISOString().slice(0, 10);
  const to = new Date(data.AAA[700].t).toISOString().slice(0, 10);
  const win = { from, to, warmupFrom: new Date(data.AAA[100].t).toISOString().slice(0, 10) };

  const a = evaluateBasket({ spec, dataBySymbol: data, marketSeries: market, ...win });
  // Corrupt every bar AFTER the window end, in every series incl. the market.
  const corrupt = {};
  for (const s of SYMS) corrupt[s] = data[s].map((c, i) => (i > 700 ? { ...c, c: c.c * 7 } : c));
  const mCorrupt = market.map((c, i) => (i > 700 ? { ...c, c: c.c * 0.1 } : c));
  const b = evaluateBasket({ spec, dataBySymbol: corrupt, marketSeries: mCorrupt, ...win });
  assert.deepEqual(a.equity, b.equity, 'post-window data cannot influence the scored window');
  assert.deepEqual(a.metrics, b.metrics);

  // Determinism: identical inputs -> identical output (trades included).
  const c = evaluateBasket({ spec, dataBySymbol: data, marketSeries: market, ...win });
  assert.equal(JSON.stringify(a.metrics) + JSON.stringify(a.trades), JSON.stringify(c.metrics) + JSON.stringify(c.trades));

  // Scoring starts at the first master bar >= from; warmup bars are excluded.
  assert.equal(a.window.from, from);
  assert.ok(a.window.warmupBars > 0, 'warmup existed');
  assert.ok(a.trades.every((tr) => tr.t >= Date.parse(from)), 'no warmup trade is scored');
});

test('evaluateBasket: holdout gate throws BEFORE running unless explicitly allowed', () => {
  // Series spanning the real split boundary.
  const start = IN_SAMPLE_END - 800 * DAY;
  const data = {};
  for (const [j, s] of SYMS.entries()) data[s] = mkCandles(walk(900, 0.0005, j + 1), start);
  const { spec } = makeXsmomSpec(SYMS, { lookback: 126, skip: 10, k: 2, rebalanceBars: 10 });
  assert.throws(() => evaluateBasket({ spec, dataBySymbol: data }), /HOLDOUT LOCKED/);
  const ok = evaluateBasket({ spec, dataBySymbol: data, allowHoldout: true });
  assert.ok(ok.window.bars > 0);
  const inSample = evaluateBasket({ spec, dataBySymbol: data, to: '2019-12-31' });
  assert.ok(Date.parse(inSample.window.to) <= IN_SAMPLE_END);
});

test('evaluateBasket: the buffered market gate really sends the basket to cash in a downtrend', () => {
  const { data } = mkUniverse();
  // A market proxy in a PERSISTENT decline for the whole second half — price
  // stays well below 0.95×SMA200 throughout. (A merely FLAT market eventually
  // converges onto its own SMA and legitimately re-opens the buffered gate.)
  const mCloses = [];
  for (let i = 0; i < 900; i++) mCloses.push(i < 450 ? 100 + i * 0.05 : 122.5 * Math.pow(0.997, i - 450));
  const market = mkCandles(mCloses, data.AAA[0].t);
  const { spec } = makeXsmomSpec(SYMS, { lookback: 126, skip: 10, k: 2, rebalanceBars: 10 });
  const win = {
    from: new Date(data.AAA[600].t).toISOString().slice(0, 10),
    to: new Date(data.AAA[850].t).toISOString().slice(0, 10),
    warmupFrom: new Date(data.AAA[0].t).toISOString().slice(0, 10),
  };
  const r = evaluateBasket({ spec, dataBySymbol: data, marketSeries: market, ...win });
  assert.ok(r.trades.every((tr) => tr.side !== 'BUY'), 'gate closed -> no buys in the scored window');
  assert.equal(r.position, 'flat (cash)');
  // Same window with an always-up market: the basket does buy (the gate, not
  // the ranker, was what kept it out).
  const up = mkCandles(walk(900, 0.0008, 5), data.AAA[0].t);
  const r2 = evaluateBasket({ spec, dataBySymbol: data, marketSeries: up, ...win });
  assert.ok(r2.trades.some((tr) => tr.side === 'BUY'), 'gate open -> the basket invests');
});

test('killSwitchBreach: reports the first bar past the threshold, or null', () => {
  const times = [0, 1, 2, 3, 4].map((i) => Date.UTC(2019, 0, 1) + i * DAY);
  assert.equal(killSwitchBreach([100, 110, 105, 100, 120], times, 0.35), null, 'a 9% dip is no breach');
  const hit = killSwitchBreach([100, 110, 70, 65, 120], times, 0.35);
  assert.ok(hit, 'a 41% drawdown breaches');
  assert.equal(hit.t, times[2], 'flagged at the FIRST breaching bar');
  assert.ok(Math.abs(hit.dd - (1 - 70 / 110)) < 1e-3, 'dd reported (4dp-rounded)');
});
