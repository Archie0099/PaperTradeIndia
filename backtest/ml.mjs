// ---------------------------------------------------------------------------
// backtest/ml.mjs
// A genuine, FREE, LOCAL machine-learning stock ranker — the model that learns
// which names a BASKET bot should hold. All computation is local: it is plain
// supervised learning (cross-sectional regression) trained on the price data we
// already have, solved with hand-rolled linear algebra (no external services).
//
//   * Two model families, both pure maths:
//       - "ridge"    : L2-regularised LINEAR regression of forward return on the
//                      feature vector, solved in CLOSED FORM (normal equations +
//                      Gauss-Jordan). Deterministic, no iterations, no RNG.
//       - "logistic" : a binary classifier ("will this name be a TOP-tercile
//                      performer over the next horizon?") fit by IRLS / Newton
//                      with a FIXED iteration count from a zero start — so it,
//                      too, is fully deterministic.
//   * Training is strictly WALK-FORWARD: at a decision date `t`, a sample (the
//     features at bar j, the realised forward return at j) is used ONLY if its
//     entire forward window has CLOSED before t  (times[j+horizon] < t). There is
//     therefore no look-ahead: the model never sees a label it could not have
//     known at decision time.
//   * Features are z-scored using ONLY the training fold's mean/std (stored on the
//     model and re-applied at predict) — the standard guard against leakage.
//
// The model is DATA fit to numbers (a scalar score per stock); it can never alter
// control flow beyond ranking, exactly like a hand-written `rank` expression.
//
// Design constraints: ZERO new dependencies (pure Node + the DSL's own
// indicators), no Math.random / Date.now anywhere (so a re-run reproduces the
// same model — restart-safe), and free + local (no paid services).
// ---------------------------------------------------------------------------

import { evalNode, FEATURE_WHITELIST } from './dsl.mjs';

// Each whitelisted ML feature is just a DSL expression, so the feature maths is
// the SAME code path the hand-written ranks use (one source of truth, already
// unit-tested + look-ahead-safe). Higher-level (mom126, distHigh) need the most
// history; featuresAt returns null until ALL of a model's features are warm.
const FEATURE_EXPRS = {
  mom21: ['mom', 21],
  mom63: ['mom', 63],
  mom126: ['mom', 126],
  rsi14: ['rsi', 14],
  distHigh: ['distHigh', 252],
  volratio: ['volratio', 20, 63],
  smaSlope: ['slope', 50],
  zscore50: ['zscore', 50],
};

// Compute the feature vector for one stock at bar index `ri` (reads closes[0..ri]
// only — no look-ahead). Returns null if ANY selected feature is not yet finite,
// so a half-warmed stock is simply skipped rather than poisoning the model.
function featuresAt(closes, ri, features) {
  const out = new Array(features.length);
  for (let k = 0; k < features.length; k++) {
    const v = evalNode(FEATURE_EXPRS[features[k]], closes, ri);
    if (v == null || !Number.isFinite(v)) return null;
    out[k] = v;
  }
  return out;
}

// --- linear algebra (hand-rolled; no matrix library, zero dependencies) ------

// Solve the linear system A x = b for a small square A (size n) by Gauss-Jordan
// elimination with partial pivoting. Returns the solution vector, or null if the
// matrix is singular (a near-zero pivot) — callers treat null as "model not ready".
function solveLinear(A, b) {
  const n = b.length;
  // Work on copies so the caller's matrices are untouched.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Partial pivot: swap in the row with the largest |value| in this column.
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null; // singular -> not invertible
    if (piv !== col) { const tmp = M[piv]; M[piv] = M[col]; M[col] = tmp; }
    const pivVal = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= pivVal; // normalise the pivot row
    for (let r = 0; r < n; r++) { // eliminate this column from every other row
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map((row) => row[n]);
}

// Build the (F+1)-wide design matrix [1, z-scored features] for a set of samples,
// using the train-fold means/stds. A zero-variance feature contributes 0 (we set
// std=1 so its z-score is a constant 0 instead of 0/0 = NaN). The leading 1 is the
// bias/intercept column (never penalised, never z-scored).
function standardize(samples) {
  const F = samples[0].f.length;
  const mean = new Array(F).fill(0), std = new Array(F).fill(0);
  for (const s of samples) for (let k = 0; k < F; k++) mean[k] += s.f[k];
  for (let k = 0; k < F; k++) mean[k] /= samples.length;
  for (const s of samples) for (let k = 0; k < F; k++) std[k] += (s.f[k] - mean[k]) ** 2;
  for (let k = 0; k < F; k++) {
    std[k] = Math.sqrt(std[k] / samples.length);
    if (!(std[k] > 1e-9)) std[k] = 1; // dead feature -> z becomes 0, never NaN
  }
  const X = samples.map((s) => {
    const row = new Array(F + 1);
    row[0] = 1;
    for (let k = 0; k < F; k++) row[k + 1] = (s.f[k] - mean[k]) / std[k];
    return row;
  });
  return { X, mean, std };
}

// Ridge regression: minimise ||Xw - y||^2 + lambda * ||w (excluding bias)||^2.
// Closed form: (X'X + lambda*I_nobias) w = X'y. Returns weights or null.
function fitRidge(X, y, lambda) {
  const p = X[0].length; // F + 1 (includes bias)
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i], yi = y[i];
    for (let a = 0; a < p; a++) {
      Xty[a] += xi[a] * yi;
      for (let b = 0; b < p; b++) XtX[a][b] += xi[a] * xi[b];
    }
  }
  for (let a = 1; a < p; a++) XtX[a][a] += lambda; // penalise everything but the bias
  return solveLinear(XtX, Xty);
}

const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
const dot = (w, x) => { let s = 0; for (let k = 0; k < w.length; k++) s += w[k] * x[k]; return s; };

// Logistic regression by IRLS / Newton steps: solve (X'WX + lambda*I) Δ = X'(y-p)
// each iteration, FIXED count from w=0 (deterministic). Falls back to the ridge
// fit if it produces a non-finite weight.
function fitLogistic(X, y, lambda, iterations = 8) {
  const p = X[0].length, n = X.length;
  let w = new Array(p).fill(0);
  for (let it = 0; it < iterations; it++) {
    const H = Array.from({ length: p }, () => new Array(p).fill(0));
    const g = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i];
      const pr = sigmoid(dot(w, xi));
      const wgt = Math.max(pr * (1 - pr), 1e-6); // IRLS weight, floored to stay PD
      const resid = y[i] - pr;
      for (let a = 0; a < p; a++) {
        g[a] += xi[a] * resid;
        for (let b = 0; b < p; b++) H[a][b] += xi[a] * xi[b] * wgt;
      }
    }
    for (let a = 1; a < p; a++) { H[a][a] += lambda; g[a] -= lambda * w[a]; } // L2 (skip bias)
    const delta = solveLinear(H, g);
    if (!delta) return null;
    for (let a = 0; a < p; a++) w[a] += delta[a];
    if (w.some((v) => !Number.isFinite(v))) return null;
  }
  return w;
}

// --- tree-based model families (gbm / forest) --------------------------------
// Both fit the FORWARD RETURN (regression, squared loss) on the standardised feature
// columns, are fully DETERMINISTIC (gbm is greedy with no RNG; forest uses a FIXED
// mulberry32 seed), and expose gain-based feature importances. Zero dependencies.

// A tiny deterministic PRNG (the same generator the rest of the codebase uses) so the
// forest's bootstrap + feature subsampling reproduce exactly on a re-run.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Normalise a vector of gain sums to non-negative fractions summing to 1 (feature
// importances). An all-zero vector (nothing learned) -> all zeros.
function normImp(imp) {
  let s = 0;
  for (const x of imp) s += Math.max(0, x);
  if (!(s > 0)) return imp.map(() => 0);
  return imp.map((x) => Math.max(0, x) / s);
}

// Best depth-1 split of `y` over feature columns `Z` (rows listed in `idx`), choosing
// the (feature, threshold) that maximises the between-group sum of squares
//   gain = sumL²/nL + sumR²/nR − sum²/N
// (the SSE reduction of a constant-per-leaf fit). `feats` limits which features are
// considered (so the forest can subsample features per node). `minLeaf` forbids tiny
// leaves. Splits are evaluated on a value-then-index sorted order (a TOTAL order, so
// the choice is deterministic), and never inside a run of tied values. Returns the
// split { feat, thr, gain, left, right } (left/right are index arrays) or null.
function bestSplit(Z, y, idx, feats, minLeaf) {
  const N = idx.length;
  let total = 0;
  for (const i of idx) total += y[i];
  const baseGain = (total * total) / N;
  let best = null;
  for (const f of feats) {
    const sorted = idx.slice().sort((a, b) => Z[a][f] - Z[b][f] || a - b);
    let sumL = 0, nL = 0;
    for (let p = 0; p < N - 1; p++) {
      const i = sorted[p];
      sumL += y[i]; nL++;
      if (nL < minLeaf || N - nL < minLeaf) continue;
      if (Z[i][f] === Z[sorted[p + 1]][f]) continue; // never split inside tied values
      const sumR = total - sumL, nR = N - nL;
      const gain = (sumL * sumL) / nL + (sumR * sumR) / nR - baseGain;
      if (!best || gain > best.gain) best = { feat: f, thr: Z[i][f], gain, left: sorted.slice(0, p + 1), right: sorted.slice(p + 1) };
    }
  }
  return best;
}

// Best depth-1 split using PRE-SORTED feature columns. `orders[f]` is the full sample
// index list sorted by feature f (value-then-index — the SAME total order bestSplit uses).
// Identical result to bestSplit(Z, y, allIdx, allFeats, minLeaf), but it does NOT re-sort:
// in gradient boosting the feature columns never change across rounds (only the residual
// `y` does), so re-sorting on every boosting iteration was the dominant cost. Determinism is preserved
// (same order, same `gain > best.gain` first-wins tie-break). Used only by fitGBM.
function bestSplitPresorted(Z, y, orders, minLeaf) {
  const F = orders.length;
  const N = orders[0].length;
  let total = 0;
  for (let i = 0; i < N; i++) total += y[i];
  const baseGain = (total * total) / N;
  let best = null;
  for (let f = 0; f < F; f++) {
    const sorted = orders[f];
    let sumL = 0, nL = 0;
    for (let p = 0; p < N - 1; p++) {
      const i = sorted[p];
      sumL += y[i]; nL++;
      if (nL < minLeaf || N - nL < minLeaf) continue;
      if (Z[i][f] === Z[sorted[p + 1]][f]) continue; // never split inside tied values
      const sumR = total - sumL, nR = N - nL;
      const gain = (sumL * sumL) / nL + (sumR * sumR) / nR - baseGain;
      if (!best || gain > best.gain) best = { feat: f, thr: Z[i][f], gain, left: sorted.slice(0, p + 1), right: sorted.slice(p + 1) };
    }
  }
  return best;
}

// Gradient-boosted depth-1 regression stumps. Deterministic: each iteration greedily adds
// the best stump on the CURRENT residual (no RNG). Returns { base, stumps, importance }
// or null when nothing splits. `rounds`/`learnRate` are optional cfg knobs (defaults below).
function fitGBM(Z, y, cfg) {
  const n = Z.length;
  if (!n) return null;
  const F = Z[0].length;
  const rounds = Number.isInteger(cfg.rounds) ? cfg.rounds : 40;
  const lr = Number.isFinite(cfg.learnRate) ? cfg.learnRate : 0.1;
  const minLeaf = Math.max(1, Math.floor(n * 0.05));
  // Pre-sort the sample indices by each feature ONCE — reused every round (see
  // bestSplitPresorted). Cuts the GBM's cost ~`rounds`-fold (the old per-iteration re-sort
  // was ~40× the rest of the work) without changing a single stump it selects.
  const orders = [];
  for (let f = 0; f < F; f++) orders.push(Array.from({ length: n }, (_, i) => i).sort((a, b) => Z[a][f] - Z[b][f] || a - b));
  const base = y.reduce((a, b) => a + b, 0) / n;
  const pred = new Array(n).fill(base);
  const stumps = [];
  const importance = new Array(F).fill(0);
  for (let r = 0; r < rounds; r++) {
    const resid = new Array(n);
    for (let i = 0; i < n; i++) resid[i] = y[i] - pred[i];
    const best = bestSplitPresorted(Z, resid, orders, minLeaf);
    if (!best || !(best.gain > 1e-12)) break;
    let sumL = 0; for (const i of best.left) sumL += resid[i];
    let sumR = 0; for (const i of best.right) sumR += resid[i];
    const left = lr * (sumL / best.left.length), right = lr * (sumR / best.right.length);
    stumps.push({ feat: best.feat, thr: best.thr, left, right });
    importance[best.feat] += best.gain;
    for (let i = 0; i < n; i++) pred[i] += Z[i][best.feat] <= best.thr ? left : right;
  }
  if (!stumps.length) return null;
  return { base, stumps, importance: normImp(importance) };
}

function predictGBM(model, zf) {
  let p = model.base;
  for (const s of model.stumps) p += zf[s.feat] <= s.thr ? s.left : s.right;
  return p;
}

// Pick up to `m` distinct feature indices using the seeded rng (forest subsampling).
function sampleFeatureSubset(F, m, rng) {
  const pool = Array.from({ length: F }, (_, i) => i);
  const out = [];
  const take = Math.max(1, Math.min(m, F));
  while (out.length < take && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out;
}

// Build one shallow regression tree over the bootstrap sample `idx` (a leaf is the
// mean of its rows). Recurses to maxDepth, subsampling `mtry` features per node.
function buildTree(Z, y, idx, depth, maxDepth, minLeaf, mtry, rng, importance) {
  let mean = 0; for (const i of idx) mean += y[i]; mean /= idx.length;
  if (depth >= maxDepth || idx.length < 2 * minLeaf) return { leaf: mean };
  const F = Z[0].length;
  const feats = sampleFeatureSubset(F, mtry, rng);
  const best = bestSplit(Z, y, idx, feats, minLeaf);
  if (!best || !(best.gain > 1e-12)) return { leaf: mean };
  importance[best.feat] += best.gain;
  return {
    feat: best.feat, thr: best.thr,
    L: buildTree(Z, y, best.left, depth + 1, maxDepth, minLeaf, mtry, rng, importance),
    R: buildTree(Z, y, best.right, depth + 1, maxDepth, minLeaf, mtry, rng, importance),
  };
}

// A small SEEDED random forest of shallow regression trees. The FIXED seed makes the
// bootstrap sampling + per-node feature subsampling reproducible (no Math.random),
// so a re-run yields a byte-identical forest. `trees`/`depth` are optional
// cfg knobs. Returns { trees, importance } or null.
function fitForest(Z, y, cfg) {
  const n = Z.length;
  if (n < 4) return null;
  const F = Z[0].length;
  const nTrees = Number.isInteger(cfg.trees) ? cfg.trees : 24;
  const maxDepth = Number.isInteger(cfg.depth) ? cfg.depth : 3;
  const minLeaf = Math.max(2, Math.floor(n * 0.05));
  const mtry = Math.max(1, Math.round(Math.sqrt(F)));
  const rng = mulberry32(0x9e3779b9); // FIXED seed -> deterministic forest
  const trees = [];
  const importance = new Array(F).fill(0);
  for (let t = 0; t < nTrees; t++) {
    const idx = new Array(n);
    for (let i = 0; i < n; i++) idx[i] = Math.floor(rng() * n); // bootstrap (with replacement)
    trees.push(buildTree(Z, y, idx, 0, maxDepth, minLeaf, mtry, rng, importance));
  }
  if (!trees.length) return null;
  return { trees, importance: normImp(importance) };
}

function predictTree(node, zf) {
  while (node && node.leaf === undefined) node = zf[node.feat] <= node.thr ? node.L : node.R;
  return node ? node.leaf : 0;
}
function predictForest(model, zf) {
  let s = 0;
  for (const t of model.trees) s += predictTree(t, zf);
  return s / model.trees.length;
}

// --- the public ranker -------------------------------------------------------

// Build a rank source from a basket's mlConfig + the candle data for its universe.
// Returns rankSource(sym, realCloses, ri, decisionTime) -> a score (higher = more
// attractive to hold) or null when the model can't help (not enough history, or
// features not warm), in which case the caller falls back to the rule `rank`.
//
// dataBySymbol: { SYMBOL: [{t, c}, ...] }  (the same shape the tournament uses).
// The trained model is MEMOISED on a retrain schedule (trainEveryBars) and the
// per-(symbol,bar) feature vectors are cached (they never change), so repeated
// scoring is cheap and, being a pure function of the data, fully deterministic.
function makeRankSource({ spec, dataBySymbol }) {
  const cfg = spec.mlConfig;
  if (!cfg) return null;
  const features = cfg.features;
  const horizon = cfg.horizon;

  // Iterate the universe in a CANONICAL (sorted) order so floating-point sums in
  // training are identical regardless of object key / array order -> determinism.
  const universe = [...spec.universe].filter((s) => Array.isArray(dataBySymbol[s]) && dataBySymbol[s].length).sort();
  const closesBy = {}, timesBy = {}, timeIdx = {};
  for (const s of universe) {
    closesBy[s] = dataBySymbol[s].map((c) => c.c);
    timesBy[s] = dataBySymbol[s].map((c) => c.t);
    const m = new Map();
    timesBy[s].forEach((t, i) => m.set(t, i)); // exact-date -> bar index, for cross-sections
    timeIdx[s] = m;
  }

  // Cache feature vectors by `${sym}:${bar}` — closes[0..bar] is fixed, so the
  // features there never change across retrains. (null is a valid cached result.)
  const featCache = new Map();
  const featAt = (sym, ri) => {
    const key = sym + ':' + ri;
    if (featCache.has(key)) return featCache.get(key);
    const f = featuresAt(closesBy[sym], ri, features);
    featCache.set(key, f);
    return f;
  };

  // Union of all real timestamps, deduped + NUMERIC-sorted, strided — the common
  // calendar we sample training cross-sections on (so same-date terciles line up).
  const allTimes = [...new Set(universe.flatMap((s) => timesBy[s]))].sort((a, b) => a - b);
  const STRIDE = 5;

  // Train one model whose labels' forward windows all CLOSED before decisionTime,
  // over a ROLLING window of the most-recent `lookback` bars (so the configured
  // lookback is honoured and the training set doesn't grow unbounded as live bars
  // accrue). Both bounds are pure functions of the data -> deterministic.
  function train(decisionTime) {
    const samples = []; // { f:[...], fwd, label }
    let decisionIdx = allTimes.length - 1;
    while (decisionIdx >= 0 && !(allTimes[decisionIdx] < decisionTime)) decisionIdx--;
    const minAnchorIdx = Math.max(0, decisionIdx - cfg.lookback + 1);
    for (let ai = minAnchorIdx; ai < allTimes.length; ai += STRIDE) {
      const ad = allTimes[ai];
      if (!(ad < decisionTime)) break; // anchors must precede the decision (walk-forward)
      const cross = []; // this date's cross-section across the universe
      for (const s of universe) {
        const js = timeIdx[s].get(ad);
        if (js === undefined) continue; // this name didn't trade that exact day
        const jf = js + horizon;
        if (jf > closesBy[s].length - 1) continue; // no realised forward bar yet
        if (!(timesBy[s][jf] < decisionTime)) continue; // WALK-FORWARD: window must have closed
        if (!(closesBy[s][js] > 0)) continue;
        const f = featAt(s, js);
        if (!f) continue; // features not warm
        cross.push({ f, fwd: closesBy[s][jf] / closesBy[s][js] - 1 });
      }
      if (!cross.length) continue;
      if (cfg.model === 'logistic') {
        // Top-tercile label, computed WITHIN this date's cross-section.
        const sorted = cross.map((x) => x.fwd).sort((a, b) => b - a);
        const numPos = Math.max(1, Math.floor(cross.length / 3));
        const threshold = sorted[numPos - 1];
        for (const x of cross) samples.push({ f: x.f, fwd: x.fwd, label: x.fwd >= threshold ? 1 : 0 });
      } else {
        for (const x of cross) samples.push({ f: x.f, fwd: x.fwd, label: x.fwd });
      }
    }
    if (samples.length < cfg.minTrain) return { ready: false };

    const { X, mean, std } = standardize(samples);
    const y = samples.map((s) => s.label);
    // Tree families (gbm/forest) split on thresholds, so they operate on the
    // standardised FEATURE columns only (X without the leading bias column). The
    // standardisation is a per-feature affine map, so learning thresholds in z-space
    // and re-applying the same map at predict is equivalent to raw space — it just
    // lets every family share one (mean,std) plumbing + the same walk-forward guard.
    if (cfg.model === 'gbm' || cfg.model === 'forest') {
      const Z = X.map((row) => row.slice(1));
      const fit = cfg.model === 'gbm' ? fitGBM(Z, y, cfg) : fitForest(Z, y, cfg);
      if (!fit) return { ready: false };
      return { ready: true, kind: cfg.model, mean, std, ...fit };
    }
    let w = cfg.model === 'logistic' ? fitLogistic(X, y, cfg.lambda) : fitRidge(X, y, cfg.lambda);
    if (!w) w = fitRidge(X, y, cfg.lambda); // logistic blew up -> fall back to ridge
    if (!w) return { ready: false };
    return { ready: true, kind: cfg.model, w, mean, std };
  }

  const predict = (model, f) => {
    // Re-apply the stored train-fold standardisation, then score per model family.
    const zf = new Array(f.length);
    for (let k = 0; k < f.length; k++) zf[k] = (f[k] - model.mean[k]) / model.std[k];
    if (model.kind === 'gbm') return predictGBM(model, zf);
    if (model.kind === 'forest') return predictForest(model, zf);
    let z = model.w[0]; // bias
    for (let k = 0; k < zf.length; k++) z += model.w[k + 1] * zf[k];
    return cfg.model === 'logistic' ? sigmoid(z) : z;
  };

  // Retrain every Nth rebalance, where N maps trainEveryBars onto the rebalance
  // cadence (so the schedule is in the SAME bar units the spec configured).
  const retrainEvery = Math.max(1, Math.round(cfg.trainEveryBars / spec.rebalanceBars));
  let lastDecisionTime = null, rebalCount = 0, model = null;

  const rankSource = function rankSource(sym, realCloses, ri, decisionTime) {
    if (decisionTime !== lastDecisionTime) { // first call of a new rebalance date
      lastDecisionTime = decisionTime;
      if (rebalCount % retrainEvery === 0) model = train(decisionTime);
      rebalCount++;
    }
    if (!model || !model.ready) return null; // caller falls back to the rule rank
    const f = featuresAt(realCloses, ri, features);
    if (!f) return null;
    return predict(model, f);
  };
  // Expose the CURRENT trained model's feature weights (for the per-bot page's "what
  // the model learned"). Weights are in z-scored space, so their magnitudes are a fair
  // feature-importance comparison. Returns null when the model hasn't trained (cold).
  rankSource.getWeights = () => {
    if (!model || !model.ready) return null;
    // Tree families (gbm/forest) have no linear weights — surface gain-based feature
    // IMPORTANCES (≥ 0, summing to 1) instead, in the SAME { model, bias, features }
    // shape (the UI sorts by |weight|, and flags `importance` to relabel the panel).
    if (model.kind === 'gbm' || model.kind === 'forest') {
      return {
        model: cfg.model,
        importance: true,
        bias: model.base != null ? +model.base.toFixed(4) : 0,
        features: features.map((f, k) => ({ feature: f, weight: +(model.importance[k] || 0).toFixed(4) })),
      };
    }
    return {
      model: cfg.model,
      bias: +model.w[0].toFixed(4),
      features: features.map((f, k) => ({ feature: f, weight: +model.w[k + 1].toFixed(4) })),
    };
  };
  return rankSource;
}

export { makeRankSource, featuresAt, FEATURE_EXPRS, fitRidge, fitLogistic, fitGBM, fitForest, solveLinear, standardize };
