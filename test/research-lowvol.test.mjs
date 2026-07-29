// ---------------------------------------------------------------------------
// test/research-lowvol.test.mjs
// Phase-3 Strategy #6 (cross-sectional low-volatility basket) — the study that
// was NOT promoted. These lock the machinery the published NEGATIVE rests on:
// the rank expression's sign and its null-while-unwarm behaviour, spec validation
// and clamping, the pre-run holdout gate, the ablation controls being identical to
// the study except for the signal, and the seeded sampler's determinism.
// All synthetic — offline-safe.
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeLowvolSpec, makeControlSpec, sampleNames, rankLowVol, DEFAULTS } from '../backtest/research/lowvol.mjs';
import { evaluateBasket, IN_SAMPLE_END } from '../backtest/research/harness.mjs';
import { evalNode, validateSpec } from '../backtest/dsl.mjs';

const DAY = 864e5;
const mkCandles = (closes, startMs = Date.UTC(2015, 0, 1)) =>
  closes.map((c, i) => ({ t: startMs + i * DAY, o: c, h: c, l: c, c, v: 1e9 }));

// A deterministic walk with a controllable per-bar amplitude, so one symbol can be
// made unambiguously calmer than another without touching its drift.
function walk(n, drift, amp, seed) {
  const closes = [100];
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

test('rankLowVol NEGATES volatility, so the calmest name scores highest', () => {
  const n = 300;
  const calm = mkCandles(walk(n, 0.0004, 0.002, 11)).map((c) => c.c);
  const wild = mkCandles(walk(n, 0.0004, 0.030, 11)).map((c) => c.c);
  const expr = rankLowVol(252);
  const sCalm = evalNode(expr, calm, n - 1);
  const sWild = evalNode(expr, wild, n - 1);
  // Both are negative numbers (negated stdevs); the calm series must be the LARGER
  // (closer to zero) score, because the basket engine keeps the top-k by score.
  assert.ok(sCalm < 0 && sWild < 0, 'both scores are negated stdevs');
  assert.ok(sCalm > sWild, `calm (${sCalm}) must outrank wild (${sWild})`);
});

test('rankLowVol is null while unwarm, so a short-history name self-excludes', () => {
  const closes = mkCandles(walk(300, 0.0004, 0.01, 5)).map((c) => c.c);
  const expr = rankLowVol(252);
  // One bar short of the lookback -> no score at all (not a spuriously calm 0).
  assert.equal(evalNode(expr, closes, 251), null);
  assert.ok(Number.isFinite(evalNode(expr, closes, 252)), 'warm at exactly the lookback');
});

test('makeLowvolSpec produces a VALID spec and clamps out-of-range params', () => {
  const universe = ['A', 'B', 'C', 'D'];
  const { spec, params } = makeLowvolSpec(universe);
  assert.equal(validateSpec(spec), null);
  assert.equal(spec.kind, 'BASKET');
  assert.equal(spec.weighting, 'volinv');
  assert.equal(params.volLookback, DEFAULTS.volLookback);
  // No market gate, by design — the study must not confound the factor with timing.
  assert.equal(spec.marketGate, undefined);
  assert.equal(spec.killSwitch, undefined);

  // A perturbation cell can ask for absurd values; the factory must still emit a
  // valid spec rather than throwing or producing an unrunnable one.
  const lo = makeLowvolSpec(universe, { volLookback: 1, k: 0, rebalanceBars: 1 });
  assert.equal(validateSpec(lo.spec), null);
  assert.ok(lo.params.volLookback >= 5 && lo.params.k >= 1 && lo.params.rebalanceBars >= 5);
  const hi = makeLowvolSpec(universe, { rebalanceBars: 9999 });
  assert.ok(hi.params.rebalanceBars <= 63, 'cadence is capped');
});

test('the ablation controls differ from the study ONLY in the signal', () => {
  const universe = ['A', 'B', 'C'];
  const study = makeLowvolSpec(universe).spec;
  const low = makeControlSpec(universe, -1);
  const high = makeControlSpec(universe, 1);
  const none = makeControlSpec(universe, 0);
  for (const c of [low, high, none]) {
    assert.equal(validateSpec(c), null);
    // Every knob that could affect the result independently of the signal must match.
    assert.equal(c.k, study.k);
    assert.equal(c.weighting, study.weighting);
    assert.equal(c.rebalanceBars, study.rebalanceBars);
    assert.deepEqual(c.universe, study.universe);
    assert.equal(c.marketGate, undefined);
  }
  // The low-vol control must be byte-equal to the study's own rank expression — that
  // equality is what makes arm A a fair stand-in for the study in the ablation table.
  assert.deepEqual(low.rank, study.rank);
  // The no-signal arm still evaluates to a NUMBER (not a boolean or null-always), so
  // it exercises the identical selection path with zero information content.
  const closes = mkCandles(walk(300, 0.0004, 0.01, 7)).map((c) => c.c);
  assert.equal(evalNode(none.rank, closes, 299), 0);
  assert.equal(evalNode(none.rank, closes, 100), null, 'still unwarm-aware, like the study');
});

test('sampleNames is deterministic per seed, in-range, and does not mutate its input', () => {
  const names = Array.from({ length: 40 }, (_, i) => `S${i}`);
  const frozen = [...names];
  const a = sampleNames(names, 15, 123);
  const b = sampleNames(names, 15, 123);
  const c = sampleNames(names, 15, 124);
  assert.deepEqual(a, b, 'same seed -> same draw (a null distribution must reproduce)');
  assert.notDeepEqual(a, c, 'different seed -> different draw');
  assert.equal(a.length, 15);
  assert.equal(new Set(a).size, 15, 'no duplicates');
  assert.ok(a.every((s) => names.includes(s)));
  assert.deepEqual(names, frozen, 'the caller\'s array is untouched');
  // Asking for more than exist yields everything, not undefined padding.
  assert.equal(sampleNames(names, 999, 1).length, names.length);
});

test('evaluateBasket refuses a low-vol window that reaches into the holdout', () => {
  // Bars that run past the in-sample cutoff must throw unless allowHoldout is set —
  // the study's holdout was deliberately never spent, so this gate is what protects it.
  const past = IN_SAMPLE_END + 30 * DAY;
  const start = past - 400 * DAY;
  const dataBySymbol = {
    A: mkCandles(walk(400, 0.0005, 0.004, 1), start),
    B: mkCandles(walk(400, 0.0005, 0.020, 2), start),
    C: mkCandles(walk(400, 0.0005, 0.010, 3), start),
  };
  const { spec } = makeLowvolSpec(['A', 'B', 'C'], { volLookback: 60, k: 2 });
  assert.throws(
    () => evaluateBasket({ spec, dataBySymbol, cash: 1_000_000 }),
    /HOLDOUT LOCKED/,
    'a window past the cutoff must be refused by default',
  );
  // With the explicit opt-in the same call runs (that is the one-shot path).
  const ok = evaluateBasket({ spec, dataBySymbol, cash: 1_000_000, allowHoldout: true });
  assert.ok(ok.metrics && Number.isFinite(ok.metrics.sharpe));
});

test('the low-vol basket really does hold the calmer names (signal has bite)', () => {
  // Three symbols with the SAME drift and very different amplitudes: the top-2 basket
  // must end up holding the two calm ones, so the ablation's A-vs-B contrast is real
  // and not an artifact of how the engine breaks ties.
  const start = Date.UTC(2012, 0, 2);
  const n = 500;
  const dataBySymbol = {
    CALM1: mkCandles(walk(n, 0.0005, 0.003, 21), start),
    CALM2: mkCandles(walk(n, 0.0005, 0.004, 22), start),
    WILD1: mkCandles(walk(n, 0.0005, 0.035, 23), start),
  };
  const { spec } = makeLowvolSpec(['CALM1', 'CALM2', 'WILD1'], { volLookback: 120, k: 2, rebalanceBars: 21 });
  const r = evaluateBasket({
    spec, dataBySymbol, cash: 1_000_000,
    from: new Date(start + 200 * DAY).toISOString().slice(0, 10),
    to: '2019-12-31',
  });
  const held = (r.decision?.candidates || []).filter((c) => c.chosen).map((c) => c.sym);
  assert.equal(held.length, 2);
  assert.ok(!held.includes('WILD1'), `the wild name must not be held, got ${held.join(',')}`);
});
