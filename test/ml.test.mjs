// ---------------------------------------------------------------------------
// test/ml.test.mjs
// Locks the LOCAL ML ranker (backtest/ml.mjs) IN ISOLATION (no tournament wiring):
//   * the hand-rolled linear algebra recovers known coefficients,
//   * featuresAt is null-until-warm then finite,
//   * the ranker is DETERMINISTIC (same data -> byte-identical scores),
//   * it has NO LOOK-AHEAD (future bars never change a past decision's score),
//   * it DEGRADES GRACEFULLY (too little history -> null, caller falls back),
//   * a zero-variance feature never produces NaN, and logistic predicts in (0,1).
// Pure + offline (deterministic synthetic candles, no network).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeRankSource, featuresAt, fitRidge, solveLinear, standardize } from '../backtest/ml.mjs';

// A small deterministic PRNG so the synthetic candles are byte-reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Five synthetic stocks, each a distinct drift + noise, daily bars. Deterministic.
function universeData(n = 540) {
  const syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'];
  const data = {};
  syms.forEach((s, k) => {
    const rng = mulberry32(1000 + k * 7);
    let p = 100 + k * 10;
    const candles = [];
    for (let i = 0; i < n; i++) {
      const drift = 0.0003 + k * 0.0002; // each name a slightly different trend
      p *= 1 + drift + (rng() - 0.5) * 0.02;
      candles.push({ t: i * 864e5, c: +p.toFixed(2) });
    }
    data[s] = candles;
  });
  return { syms, data };
}

// A config that warms early (no 126/252-day features) so training engages on ~500 bars.
const cfg = (model = 'ridge') => ({
  model,
  features: ['mom21', 'mom63', 'rsi14', 'smaSlope', 'zscore50', 'volratio'],
  horizon: 21, lambda: 1, lookback: 504, trainEveryBars: 63, minTrain: 60,
});
const spec = (model = 'ridge') => ({ kind: 'BASKET', name: 'ml', universe: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE'], rank: ['mom', 63], k: 2, rebalanceBars: 21, mlConfig: cfg(model) });

test('solveLinear solves a known 2x2 system', () => {
  const x = solveLinear([[2, 1], [1, 3]], [3, 5]); // 2a+b=3, a+3b=5 -> a=0.8, b=1.4
  assert.ok(Math.abs(x[0] - 0.8) < 1e-9 && Math.abs(x[1] - 1.4) < 1e-9);
  assert.equal(solveLinear([[1, 1], [1, 1]], [2, 2]), null, 'a singular matrix returns null');
});

test('fitRidge recovers known coefficients on noiseless y = Xw', () => {
  const rng = mulberry32(99);
  const trueW = [0.5, 2, -1, 0.3]; // bias + 3 features
  const X = [], y = [];
  for (let i = 0; i < 200; i++) {
    const row = [1, rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1];
    X.push(row);
    y.push(row.reduce((s, v, k) => s + v * trueW[k], 0));
  }
  const w = fitRidge(X, y, 1e-6); // tiny penalty -> near-exact recovery
  for (let k = 0; k < trueW.length; k++) assert.ok(Math.abs(w[k] - trueW[k]) < 1e-2, `w[${k}]=${w[k]} ~ ${trueW[k]}`);
});

test('standardize turns a zero-variance feature into a constant 0 column (no NaN)', () => {
  const samples = [
    { f: [5, 1], label: 0 }, { f: [5, 2], label: 1 }, { f: [5, 3], label: 0 }, // first feature is constant
  ];
  const { X } = standardize(samples);
  for (const row of X) assert.ok(row.every(Number.isFinite), 'no NaN from a dead feature');
  assert.ok(X.every((r) => r[1] === 0), 'the constant feature z-scores to exactly 0');
  const w = fitRidge(X, samples.map((s) => s.label), 1);
  assert.ok(w.every(Number.isFinite), 'ridge stays finite with a dead feature');
});

test('featuresAt is null until warm, then finite', () => {
  const { data } = universeData();
  const closes = data.AAA.map((c) => c.c);
  const feats = cfg().features;
  assert.equal(featuresAt(closes, 5, feats), null, 'not enough history yet');
  const f = featuresAt(closes, 300, feats);
  assert.ok(Array.isArray(f) && f.length === feats.length && f.every(Number.isFinite));
});

test('the ranker is deterministic: same data -> identical scores', () => {
  const { syms, data } = universeData();
  const dt = data.AAA[400].t;
  const a = makeRankSource({ spec: spec(), dataBySymbol: data });
  const b = makeRankSource({ spec: spec(), dataBySymbol: data });
  for (const s of syms) {
    const sa = a(s, data[s].map((c) => c.c), 400, dt);
    const sb = b(s, data[s].map((c) => c.c), 400, dt);
    assert.equal(sa, sb, `${s} scores identically across runs`);
  }
});

test('NO LOOK-AHEAD: appending future bars never changes a past decision score', () => {
  const { syms, data } = universeData(540);
  const decisionBar = 400;
  const dt = data.AAA[decisionBar].t;
  // Instance A only knows bars 0..decisionBar; instance B knows the full future too.
  const dataA = {}, dataB = data;
  for (const s of syms) dataA[s] = data[s].slice(0, decisionBar + 1);
  const a = makeRankSource({ spec: spec(), dataBySymbol: dataA });
  const b = makeRankSource({ spec: spec(), dataBySymbol: dataB });
  let nonNull = 0;
  for (const s of syms) {
    const sa = a(s, dataA[s].map((c) => c.c), decisionBar, dt);
    const sb = b(s, dataB[s].map((c) => c.c), decisionBar, dt);
    assert.equal(sa, sb, `${s}: the score at the decision bar must ignore future bars`);
    if (sa != null) nonNull++;
  }
  assert.ok(nonNull > 0, 'the model actually trained and scored (test is meaningful)');
});

test('graceful degradation: too little training data -> null (caller falls back)', () => {
  const { data } = universeData();
  const hungry = spec();
  hungry.mlConfig = { ...cfg(), minTrain: 100000 }; // impossible to satisfy
  const rs = makeRankSource({ spec: hungry, dataBySymbol: data });
  assert.equal(rs('AAA', data.AAA.map((c) => c.c), 400, data.AAA[400].t), null);
});

test('the lookback knob bounds the training window (it is not a silent no-op)', () => {
  const { syms, data } = universeData(900); // long history so the windows really differ
  const dt = data.AAA[850].t;
  const short = makeRankSource({ spec: { ...spec(), mlConfig: { ...cfg(), lookback: 200, minTrain: 60 } }, dataBySymbol: data });
  const long = makeRankSource({ spec: { ...spec(), mlConfig: { ...cfg(), lookback: 756, minTrain: 60 } }, dataBySymbol: data });
  let differ = false;
  for (const s of syms) {
    const a = short(s, data[s].map((c) => c.c), 850, dt);
    const b = long(s, data[s].map((c) => c.c), 850, dt);
    if (a != null && b != null && Math.abs(a - b) > 1e-9) differ = true;
  }
  assert.ok(differ, 'a different lookback trains on a different window -> different scores');
});

test('logistic ranker predicts probabilities in (0,1) and is deterministic', () => {
  const { syms, data } = universeData();
  const dt = data.AAA[420].t;
  const a = makeRankSource({ spec: spec('logistic'), dataBySymbol: data });
  const b = makeRankSource({ spec: spec('logistic'), dataBySymbol: data });
  for (const s of syms) {
    const p = a(s, data[s].map((c) => c.c), 420, dt);
    const p2 = b(s, data[s].map((c) => c.c), 420, dt);
    assert.equal(p, p2, `${s} deterministic`);
    if (p != null) assert.ok(p > 0 && p < 1, `${s} score is a probability, got ${p}`);
  }
});

// --- the new tree-based model families (gbm / forest) -----------------------

test('gbm ranker: deterministic, finite, and exposes gain-based feature importances', () => {
  const { syms, data } = universeData();
  const dt = data.AAA[420].t;
  const a = makeRankSource({ spec: spec('gbm'), dataBySymbol: data });
  const b = makeRankSource({ spec: spec('gbm'), dataBySymbol: data });
  let scored = 0;
  for (const s of syms) {
    const x = a(s, data[s].map((c) => c.c), 420, dt);
    const y = b(s, data[s].map((c) => c.c), 420, dt);
    assert.equal(x, y, `${s} gbm score is deterministic`);
    if (x != null) { assert.ok(Number.isFinite(x)); scored++; }
  }
  assert.ok(scored > 0, 'the gbm actually trained + scored (test is meaningful)');
  const w = a.getWeights();
  assert.ok(w && w.importance === true && Array.isArray(w.features), 'gbm exposes gain-based importances (flagged)');
  assert.ok(w.features.every((f) => f.weight >= 0), 'importances are non-negative');
  assert.ok(Math.abs(w.features.reduce((s, f) => s + f.weight, 0) - 1) < 0.05, 'importances ~ sum to 1');
});

test('forest ranker: reproducible (fixed seed), finite, with importances', () => {
  const { syms, data } = universeData();
  const dt = data.AAA[440].t;
  const a = makeRankSource({ spec: spec('forest'), dataBySymbol: data });
  const b = makeRankSource({ spec: spec('forest'), dataBySymbol: data });
  let scored = 0;
  for (const s of syms) {
    const x = a(s, data[s].map((c) => c.c), 440, dt);
    const y = b(s, data[s].map((c) => c.c), 440, dt);
    assert.equal(x, y, `${s} forest score reproduces (fixed seed)`);
    if (x != null) { assert.ok(Number.isFinite(x)); scored++; }
  }
  assert.ok(scored > 0, 'the forest actually trained + scored');
  assert.equal(a.getWeights().importance, true, 'forest exposes importances');
});

test('NO LOOK-AHEAD for the tree models: future bars never change a past score', () => {
  const { syms, data } = universeData(560);
  const decisionBar = 420;
  const dt = data.AAA[decisionBar].t;
  for (const model of ['gbm', 'forest']) {
    const dataA = {};
    for (const s of syms) dataA[s] = data[s].slice(0, decisionBar + 1); // only the past
    const a = makeRankSource({ spec: spec(model), dataBySymbol: dataA });
    const b = makeRankSource({ spec: spec(model), dataBySymbol: data }); // knows the future too
    for (const s of syms) {
      const sa = a(s, dataA[s].map((c) => c.c), decisionBar, dt);
      const sb = b(s, data[s].map((c) => c.c), decisionBar, dt);
      assert.equal(sa, sb, `${model} ${s}: the decision-bar score must ignore future bars`);
    }
  }
});

test('gbm/forest degrade gracefully when they cannot train (null -> caller falls back)', () => {
  const { data } = universeData();
  for (const model of ['gbm', 'forest']) {
    const hungry = { ...spec(model), mlConfig: { ...cfg(model), minTrain: 100000 } }; // impossible to satisfy
    const rs = makeRankSource({ spec: hungry, dataBySymbol: data });
    assert.equal(rs('AAA', data.AAA.map((c) => c.c), 400, data.AAA[400].t), null, `${model} returns null when it can't train`);
  }
});
