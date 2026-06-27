// ---------------------------------------------------------------------------
// test/options.test.mjs
// Adversarial tests for the option maths (core/options.js). These target the
// ways the functions could SILENTLY return wrong numbers, not the happy path:
//   * put-call parity over 1000 random inputs
//   * Greeks vs a central finite-difference of the price (incl. high-priced
//     index options, where coarse rounding shows up)
//   * IV solver round-trip, and a clean non-number when no solution exists
//   * no NaN / Infinity at the edges (T->0, deep ITM/OTM, sigma->0)
//
// Run with:  node --test
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bsPrice, greeks, impliedVol, normCdf } from '../public/js/core/options.js';

// Deterministic PRNG so any failure is reproducible.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const between = (u, lo, hi) => lo + u * (hi - lo);

// Compare with a relative tolerance plus an absolute floor.
function near(actual, expected, rel = 1e-3, abs = 1e-6) {
  return Math.abs(actual - expected) <= abs + rel * Math.abs(expected);
}

// ===========================================================================
// Put-call parity:  C - P == S - K * e^(-rT)   (must hold to ~machine eps)
// ===========================================================================
test('put-call parity holds for 1000 random inputs (within 1e-6)', () => {
  const rnd = lcg(12345);
  let worst = 0;
  for (let i = 0; i < 1000; i++) {
    const S = between(rnd(), 50, 30000);
    const K = between(rnd(), 50, 30000);
    const T = between(rnd(), 1 / 365, 2);
    const r = between(rnd(), 0, 0.1);
    const vol = between(rnd(), 0.05, 1.0);
    const c = bsPrice('CE', S, K, T, r, vol);
    const p = bsPrice('PE', S, K, T, r, vol);
    const lhs = c - p;
    const rhs = S - K * Math.exp(-r * T);
    const diff = Math.abs(lhs - rhs);
    worst = Math.max(worst, diff);
    assert.ok(diff <= 1e-6, `parity broke: S=${S} K=${K} T=${T} r=${r} v=${vol} diff=${diff}`);
  }
  // normCdf is constructed so N(x)+N(-x)==1 exactly, which is what makes
  // parity exact regardless of the CDF approximation's accuracy.
  assert.ok(worst < 1e-6, `worst parity residual ${worst}`);
});

test('normCdf is a valid CDF: in [0,1], monotone, symmetric to its stated ~1e-7', () => {
  // The Abramowitz & Stegun 7.1.26 form is documented accurate to ~7.5e-8, so
  // symmetry holds to ~1e-7, not to machine epsilon. Assert the contract, not
  // more than it promises.
  let prev = -1;
  for (let x = -6; x <= 6; x += 0.25) {
    const a = normCdf(x);
    assert.ok(a >= 0 && a <= 1, `N(${x})=${a} out of [0,1]`);
    assert.ok(a >= prev - 1e-12, `not monotone increasing at x=${x} (${a} < ${prev})`);
    prev = a;
    assert.ok(near(a + normCdf(-x), 1, 0, 1e-7), `symmetry failed at ${x}`);
  }
  assert.ok(near(normCdf(0), 0.5, 0, 1e-7));
  assert.ok(near(normCdf(1.645), 0.95, 0, 1e-3)); // a known quantile, sanity check
});

// ===========================================================================
// Greeks vs central finite difference of the analytic price.
// ===========================================================================
function fdGreeks(type, S, K, T, r, vol) {
  const hS = S * 1e-4;
  const px = (s) => bsPrice(type, s, K, T, r, vol);
  const delta = (px(S + hS) - px(S - hS)) / (2 * hS);
  const gamma = (px(S + hS) - 2 * px(S) + px(S - hS)) / (hS * hS);

  const dv = 1e-4; // bump in vol (absolute)
  const vegaPerUnitVol = (bsPrice(type, S, K, T, r, vol + dv) - bsPrice(type, S, K, T, r, vol - dv)) / (2 * dv);
  const vega = vegaPerUnitVol / 100; // our convention: vega per 1% vol

  const dT = 1e-5;
  const dVdT = (bsPrice(type, S, K, T + dT, r, vol) - bsPrice(type, S, K, T - dT, r, vol)) / (2 * dT);
  const theta = -dVdT / 365; // per calendar day

  return { delta, gamma, vega, theta };
}

test('Greeks match a central finite difference (incl. index-priced options)', () => {
  const cases = [];
  for (const type of ['CE', 'PE']) {
    // Equity-scale.
    for (const K of [90, 100, 110]) {
      for (const T of [30 / 365, 180 / 365]) {
        for (const vol of [0.15, 0.35]) cases.push([type, 100, K, T, 0.065, vol]);
      }
    }
    // Index-scale: high spot makes gamma small — this is where coarse
    // rounding inside greeks() silently loses precision.
    for (const K of [23000, 23500, 24000]) {
      for (const T of [7 / 365, 60 / 365]) {
        for (const vol of [0.12, 0.2]) cases.push([type, 23500, K, T, 0.065, vol]);
      }
    }
  }

  for (const [type, S, K, T, r, vol] of cases) {
    const g = greeks(type, S, K, T, r, vol);
    const fd = fdGreeks(type, S, K, T, r, vol);
    const tag = `${type} S=${S} K=${K} T=${T.toFixed(4)} v=${vol}`;
    assert.ok(near(g.delta, fd.delta, 1e-3, 1e-6), `delta ${tag}: ${g.delta} vs ${fd.delta}`);
    // Gamma is a SECOND difference, so it amplifies normCdf's ~1e-7 error in
    // the FD reference by ~1/h^2; the analytic gamma (pdf(d1)/(S*vol*sqrtT)) is
    // exact, the FD is the approximation. 5e-3 still catches the old 4-dp
    // rounding bug, which was ~2e-2 off on index-priced options.
    assert.ok(near(g.gamma, fd.gamma, 5e-3, 1e-7), `gamma ${tag}: ${g.gamma} vs ${fd.gamma}`);
    assert.ok(near(g.vega, fd.vega, 1e-3, 1e-6), `vega ${tag}: ${g.vega} vs ${fd.vega}`);
    assert.ok(near(g.theta, fd.theta, 2e-3, 1e-5), `theta ${tag}: ${g.theta} vs ${fd.theta}`);
  }
});

// ===========================================================================
// Implied-volatility solver.
// ===========================================================================
test('IV solver round-trips price -> IV -> price', () => {
  const rnd = lcg(999);
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const type = rnd() < 0.5 ? 'CE' : 'PE';
    const S = between(rnd(), 80, 25000);
    const K = S * between(rnd(), 0.8, 1.2);
    const T = between(rnd(), 7 / 365, 1.5);
    const r = between(rnd(), 0, 0.08);
    const vol = between(rnd(), 0.08, 0.9);
    const price = bsPrice(type, S, K, T, r, vol);
    if (price < 0.5) continue; // near-zero premiums make IV undetermined
    const iv = impliedVol(type, price, S, K, T, r);
    assert.ok(Number.isFinite(iv), `IV not finite for price=${price}`);
    const reprice = bsPrice(type, S, K, T, r, iv);
    assert.ok(near(reprice, price, 1e-3, 0.05), `reprice ${reprice} vs ${price} (iv ${iv})`);
    checked++;
  }
  assert.ok(checked > 200, `only ${checked} round-trips exercised`);
});

test('IV solver returns a non-number (not garbage) when there is no solution', () => {
  // Below intrinsic: an ITM call worth less than (S-K) is impossible.
  const belowIntrinsic = impliedVol('CE', 5, 120, 100, 0.5, 0.065); // intrinsic 20, target 5
  assert.ok(!Number.isFinite(belowIntrinsic), `expected non-number, got ${belowIntrinsic}`);
  assert.ok(Number.isNaN(belowIntrinsic), `expected NaN, got ${belowIntrinsic}`);

  // Above any achievable price: a call can never be worth more than S.
  const tooRich = impliedVol('CE', 130, 100, 100, 0.5, 0.065);
  assert.ok(Number.isNaN(tooRich), `expected NaN for impossible price, got ${tooRich}`);

  // Non-positive price and expired option.
  assert.ok(Number.isNaN(impliedVol('CE', 0, 100, 100, 0.5, 0.065)));
  assert.ok(Number.isNaN(impliedVol('CE', 10, 100, 100, 0, 0.065)));
});

// ===========================================================================
// No NaN / Infinity at the edges.
// ===========================================================================
test('bsPrice and greeks stay finite at extreme inputs', () => {
  const edges = [
    // [type, S, K, T, r, vol]
    ['CE', 100, 100, 0, 0.065, 0.2], // expiry now (guard)
    ['PE', 100, 100, 0, 0.065, 0.2],
    ['CE', 100, 100, 1e-9, 0.065, 0.2], // micro time-to-expiry
    ['CE', 100, 100, 1, 0.065, 0], // zero vol (guard)
    ['PE', 100, 100, 1, 0.065, 1e-9], // micro vol
    ['CE', 100000, 1, 1, 0.065, 0.2], // deep ITM call
    ['CE', 1, 100000, 1, 0.065, 0.2], // deep OTM call
    ['PE', 100000, 1, 1, 0.065, 0.2], // deep OTM put
    ['PE', 1, 100000, 1, 0.065, 0.2], // deep ITM put
    ['CE', 100, 100, 1e-9, 0.065, 1e-9], // both tiny
    ['CE', 50000, 100, 2, 0, 2.0], // huge vol
  ];
  for (const [type, S, K, T, r, vol] of edges) {
    const tag = `${type} S=${S} K=${K} T=${T} v=${vol}`;
    const price = bsPrice(type, S, K, T, r, vol);
    assert.ok(Number.isFinite(price), `price NaN/Inf: ${tag} -> ${price}`);
    assert.ok(price >= -1e-9, `negative price: ${tag} -> ${price}`);
    const g = greeks(type, S, K, T, r, vol);
    for (const k of ['delta', 'gamma', 'theta', 'vega']) {
      assert.ok(Number.isFinite(g[k]), `${k} NaN/Inf: ${tag} -> ${g[k]}`);
    }
  }
});

// ===========================================================================
// Backend/core regressions.
// ===========================================================================
test('bsPrice/greeks stay finite for non-positive spot or strike', () => {
  // A strike typed as 0/negative in the strategy builder must not produce NaN
  // (log(S/K) of a non-positive ratio). Fall back to intrinsic + zero Greeks.
  for (const [type, S, K] of [
    ['CE', 100, 0], ['PE', 100, 0],
    ['CE', 100, -50], ['PE', 100, -50],
    ['CE', 0, 100], ['PE', 0, 100],
    ['CE', -10, 100], ['PE', -10, 100],
  ]) {
    const price = bsPrice(type, S, K, 0.5, 0.065, 0.2);
    assert.ok(Number.isFinite(price), `price NaN for ${type} S=${S} K=${K}`);
    assert.ok(price >= 0, `negative price for ${type} S=${S} K=${K}: ${price}`);
    const g = greeks(type, S, K, 0.5, 0.065, 0.2);
    for (const k of ['delta', 'gamma', 'theta', 'vega']) {
      assert.ok(Number.isFinite(g[k]), `${k} NaN for ${type} S=${S} K=${K}`);
    }
  }
});

test('greeks() guards NaN/undefined inputs (mirrors bsPrice), not just non-positive', () => {
  // greeks() must use the same `!(x > 0)` guard as bsPrice so a NaN/undefined spot,
  // strike, T or vol yields finite zeros rather than NaN Greeks.
  for (const args of [
    ['CE', 100, 100, NaN, 0.065, 0.2],
    ['PE', 100, 100, 0.5, 0.065, NaN],
    ['CE', undefined, 100, 0.5, 0.065, 0.2],
    ['PE', 100, 100, undefined, 0.065, 0.2],
  ]) {
    const g = greeks(...args);
    for (const k of ['delta', 'gamma', 'theta', 'vega']) {
      assert.ok(Number.isFinite(g[k]), `${k} NaN for greeks(${JSON.stringify(args)})`);
    }
  }
});

test('IV solver resolves an achievable vol above the old 500% bracket', () => {
  // Price a deep-OTM option at 800% vol, then recover it: the solver must expand
  // its bracket past 5.0 instead of returning a false NaN "no solution".
  const S = 100, K = 130, T = 0.5, r = 0.05, trueVol = 8.0; // 800%
  const price = bsPrice('CE', S, K, T, r, trueVol);
  const iv = impliedVol('CE', price, S, K, T, r);
  assert.ok(Number.isFinite(iv), `expected a finite IV, got ${iv}`);
  assert.ok(Math.abs(iv - trueVol) < 0.05, `recovered IV ${iv} != ${trueVol}`);
  // A genuinely impossible price (call worth more than spot) is still NaN.
  assert.ok(Number.isNaN(impliedVol('CE', S + 1, S, K, T, r)));
});
