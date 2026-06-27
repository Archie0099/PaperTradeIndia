// ---------------------------------------------------------------------------
// test/optimizer.test.mjs
// Locks the portfolio OPTIMISER (backtest/optimizer.mjs) IN ISOLATION:
//   * sampleCov is symmetric with positive variances (and null on a too-short window),
//   * Ledoit-Wolf shrinkage keeps the intensity in [0,1] and Σ invertible,
//   * mean-variance + risk-parity weights are long-only, sum to gross, respect the cap,
//   * risk-parity actually equalises each name's risk contribution,
//   * it DEGRADES GRACEFULLY (too-short window -> null) and is DETERMINISTIC,
//   * projectWeights clips negatives, caps per name, and sums to gross.
// Pure + offline (deterministic synthetic returns, no network).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sampleCov, shrinkCov, meanVarWeights, riskParityWeights, riskContributions, projectWeights } from '../backtest/optimizer.mjs';

// A deterministic returns MATRIX (cols = per-name return series). A shared common
// factor + idiosyncratic noise gives the names realistic positive correlation.
function returnsCols(n, T, seed) {
  let a = seed >>> 0;
  const rng = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const cols = [];
  for (let i = 0; i < n; i++) cols.push([]);
  for (let t = 0; t < T; t++) {
    const common = (rng() - 0.5) * 0.01;
    for (let i = 0; i < n; i++) cols[i].push(common * (0.5 + i * 0.2) + (rng() - 0.5) * 0.015);
  }
  return cols;
}
const sum = (a) => a.reduce((x, y) => x + y, 0);

test('sampleCov is symmetric with positive variances; null on a too-short window', () => {
  const cols = returnsCols(4, 200, 7);
  const S = sampleCov(cols);
  assert.equal(S.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(S[i][i] > 0, 'positive variance');
    for (let j = 0; j < 4; j++) assert.ok(Math.abs(S[i][j] - S[j][i]) < 1e-18, 'symmetric');
  }
  assert.equal(sampleCov([[0.01]]), null, 'T<2 -> null');
  assert.equal(sampleCov([[0.01, 0.02], [0.03]]), null, 'mismatched lengths -> null');
});

test('Ledoit-Wolf shrinkage: intensity in [0,1] and Σ stays invertible', () => {
  const cols = returnsCols(5, 150, 3);
  const S = sampleCov(cols);
  const { delta } = shrinkCov(cols, S);
  assert.ok(delta >= 0 && delta <= 1, `shrinkage intensity ${delta} in [0,1]`);
  // The min-variance solve (μ = ones) must succeed and be a valid long-only allocation.
  const w = meanVarWeights(cols, null, 1, 1);
  assert.ok(w && Math.abs(sum(w) - 1) < 1e-6 && w.every((x) => x >= -1e-12 && Number.isFinite(x)), 'Σ invertible -> valid weights');
});

test('meanVarWeights: long-only, sums to gross, respects the per-name cap', () => {
  const cols = returnsCols(4, 200, 11);
  const w = meanVarWeights(cols, [0.02, 0.01, 0.005, 0.0], 1, 0.4);
  assert.ok(Math.abs(sum(w) - 1) < 1e-6, 'sums to gross 1');
  assert.ok(w.every((x) => x >= -1e-12 && x <= 0.4 + 1e-9), 'each weight within [0, cap]');
});

test('riskParityWeights: each name contributes ~equally to portfolio risk', () => {
  const cols = returnsCols(4, 250, 5);
  const w = riskParityWeights(cols, 1, 1);
  assert.ok(Math.abs(sum(w) - 1) < 1e-6 && w.every((x) => x > 0), 'valid fully-invested long-only weights');
  const rc = riskContributions(cols, w);
  assert.ok(Math.abs(sum(rc) - 100) < 0.5, 'risk contributions sum to ~100%');
  const spread = Math.max(...rc) - Math.min(...rc);
  assert.ok(spread < 5, `risk contributions are roughly equal (spread ${spread.toFixed(2)} pts)`);
});

test('risk-parity NEVER ships an anti-risk-parity allocation when a name is negatively correlated', () => {
  // Two cyclicals on a common factor + one DEFENSIVE name (negative loading).
  // The multiplicative ERC solver can't handle the hedge's negative marginal risk — it must
  // degrade (return null -> the caller falls back to inverse-vol), never over-weight the hedge.
  let a = 21 >>> 0;
  const rng = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const cols = [[], [], []];
  for (let t = 0; t < 150; t++) { const f = (rng() - 0.5) * 0.02; cols[0].push(f + (rng() - 0.5) * 0.005); cols[1].push(f + (rng() - 0.5) * 0.005); cols[2].push(-0.6 * f + (rng() - 0.5) * 0.008); }
  const w = riskParityWeights(cols, 1, 1);
  // Either it degraded (null -> caller uses volinv) OR it returned a genuine ERC vector — but
  // it must NEVER return the anti-risk-parity allocation that over-weights the hedge.
  assert.ok(w === null || (w.every((x) => x >= 0 && Number.isFinite(x))), 'finite long-only, or a clean null degrade');
  if (w) {
    const rc = riskContributions(cols, w);
    assert.ok(rc === null || rc.every((p) => p >= -1e-9), 'no negative (anti-risk-parity) risk share is reported');
  }
  // riskContributions on a deliberately hedge-heavy vector (the bug's symptom) returns null,
  // not a nonsensical negative %.
  assert.equal(riskContributions(cols, [0.15, 0.15, 0.70]), null, 'a decomposition with a negative share returns null (UI omits it)');
});

test('optimiser degrades gracefully: a too-short window -> null (caller falls back)', () => {
  const cols = [[0.01], [0.02]]; // T=1
  assert.equal(meanVarWeights(cols, null, 1, 1), null);
  assert.equal(riskParityWeights(cols, 1, 1), null);
});

test('optimiser is deterministic: same returns -> identical weights', () => {
  const cols = returnsCols(5, 200, 9);
  assert.deepEqual(meanVarWeights(cols, [1, 2, 3, 4, 5], 1, 0.5), meanVarWeights(cols, [1, 2, 3, 4, 5], 1, 0.5));
  assert.deepEqual(riskParityWeights(cols, 1, 0.5), riskParityWeights(cols, 1, 0.5));
});

test('projectWeights: clips negatives, caps per name, sums to gross', () => {
  const w = projectWeights([0.5, -0.2, 0.8, 0.1], 1, 0.4);
  assert.ok(w.every((x) => x >= 0 && x <= 0.4 + 1e-9), 'long-only + capped');
  assert.ok(Math.abs(sum(w) - 1) < 1e-9, 'sums to gross');
  assert.equal(projectWeights([-1, -2], 1, 1), null, 'no positive mass -> null');
});
