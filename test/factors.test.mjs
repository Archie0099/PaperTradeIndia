// ---------------------------------------------------------------------------
// test/factors.test.mjs
// Locks the cross-sectional MULTI-FACTOR model (backtest/factors.mjs) IN ISOLATION:
//   * z-score is population standardisation; a dead (zero-variance) factor -> all 0,
//   * the composite is the weight-scaled sum of the factor z-scores,
//   * the per-factor breakdown is exposed,
//   * a name missing any factor is EXCLUDED (not poisoned to 0),
//   * it is deterministic + order-independent in the z-stats.
// Pure + offline (synthetic closes, no network).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeComposite, zscore } from '../backtest/factors.mjs';

test('zscore: population standardisation; a dead factor -> all zeros (no NaN)', () => {
  const z = zscore([1, 2, 3, 4, 5]);
  assert.ok(Math.abs(z[2]) < 1e-12, 'the mean value z-scores to 0');
  assert.ok(Math.abs(z.reduce((a, b) => a + b, 0)) < 1e-9, 'z-scores sum to 0');
  assert.deepEqual(zscore([7, 7, 7]), [0, 0, 0], 'zero-variance factor -> all 0, never NaN');
});

test('computeComposite: composite = weight × cross-sectional z-score', () => {
  const candidates = [
    { sym: 'A', closes: [10], ri: 0 },
    { sym: 'B', closes: [20], ri: 0 },
    { sym: 'C', closes: [30], ri: 0 },
  ];
  const { scored } = computeComposite(candidates, [{ name: 'px', expr: ['price'], weight: 1 }]);
  assert.equal(scored.length, 3);
  const by = Object.fromEntries(scored.map((s) => [s.sym, s.score]));
  assert.ok(Math.abs(by.B) < 1e-9, 'the middle name z-composite ~ 0');
  assert.ok(by.C > 0 && by.A < 0, 'a higher value -> a higher composite');
  // Doubling the weight doubles the contribution.
  const { scored: s2 } = computeComposite(candidates, [{ name: 'px', expr: ['price'], weight: 2 }]);
  const by2 = Object.fromEntries(s2.map((s) => [s.sym, s.score]));
  assert.ok(Math.abs(by2.C - 2 * by.C) < 1e-9, 'weight scales the factor contribution');
});

test('computeComposite: blends multiple factors and exposes the per-factor breakdown', () => {
  const candidates = [
    { sym: 'A', closes: [100, 110], ri: 1 }, // price 110, 1-bar return +10%
    { sym: 'B', closes: [100, 105], ri: 1 }, // +5%
    { sym: 'C', closes: [100, 90], ri: 1 },  // -10%
  ];
  const defs = [{ name: 'px', expr: ['price'], weight: 1 }, { name: 'mom', expr: ['mom', 1], weight: 1 }];
  const { scored } = computeComposite(candidates, defs);
  for (const s of scored) {
    assert.equal(s.factors.length, 2, 'both factor z-scores recorded');
    assert.ok(s.factors.every((f) => typeof f.name === 'string' && Number.isFinite(f.z) && Number.isFinite(f.raw)));
  }
  const by = Object.fromEntries(scored.map((s) => [s.sym, s.score]));
  assert.ok(by.A > by.B && by.B > by.C, 'A (best on both factors) ranks first');
});

test('computeComposite: a name whose factor is not warm is EXCLUDED (not scored 0)', () => {
  const candidates = [
    { sym: 'A', closes: [100, 110], ri: 1 },
    { sym: 'B', closes: [100, 105], ri: 1 },
    { sym: 'C', closes: [90], ri: 0 }, // mom(1) needs ri>=1 -> null -> excluded
  ];
  const { scored, dropped } = computeComposite(candidates, [{ name: 'mom', expr: ['mom', 1], weight: 1 }]);
  assert.deepEqual(scored.map((s) => s.sym).sort(), ['A', 'B'], 'only the warm names are scored');
  assert.deepEqual(dropped, ['C'], 'the cold name is dropped, not poisoned to 0');
});

test('computeComposite is deterministic + order-independent in the z-stats', () => {
  const mk = (sym, c) => ({ sym, closes: [100, c], ri: 1 });
  const defs = [{ name: 'mom', expr: ['mom', 1], weight: 1 }];
  const a = computeComposite([mk('A', 110), mk('B', 105), mk('C', 90)], defs);
  const b = computeComposite([mk('C', 90), mk('B', 105), mk('A', 110)], defs); // reversed input
  const sa = Object.fromEntries(a.scored.map((s) => [s.sym, s.score]));
  const sb = Object.fromEntries(b.scored.map((s) => [s.sym, s.score]));
  for (const k of ['A', 'B', 'C']) assert.ok(Math.abs(sa[k] - sb[k]) < 1e-12, `${k} score is order-independent`);
});
