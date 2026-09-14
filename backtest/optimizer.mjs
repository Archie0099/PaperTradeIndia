// ---------------------------------------------------------------------------
// backtest/optimizer.mjs
// A small, deterministic PORTFOLIO OPTIMISER for basket weighting — the "headline"
// quant model. Given a trailing window of the chosen names' returns it builds a
// covariance matrix (with LEDOIT-WOLF shrinkage so it is invertible even with few
// names / a short window) and solves for either:
//
//   * MEAN-VARIANCE  (Markowitz):  w ∝ Σ⁻¹ μ, where μ = the names' selection scores
//     (the SAME signal that picked them) — more capital to higher-expected-return
//     names, penalised by their (co)variance.
//   * RISK-PARITY  (equal risk contribution): each name contributes the same share
//     of portfolio variance, solved by a deterministic fixed-iteration scheme.
//
// Both are LONG-ONLY, FULLY-INVESTED (weights sum to `gross`), with a per-name
// weight CAP, and DEGRADE GRACEFULLY to inverse-volatility (then equal) when the
// covariance is singular / there isn't enough data — mirroring the ML ranker's
// graceful fallback. (portfolio.mjs's weightsFor does that fallback.)
//
// Design note: ZERO new dependencies — it reuses ml.mjs's hand-rolled `solveLinear`
// (Gauss-Jordan) for the matrix inverse, and uses NO Math.random / Date.now (fixed
// iteration counts, pure data -> a re-run reproduces the result exactly).
//
// LOOK-AHEAD: every input return is from data at-or-before the decision bar (the
// caller slices each name's trailing window ending at its real bar index), so the
// optimiser, like the rest of the basket, can never see the future.
//
// NOTE on alignment: cols[i] is name i's OWN last T returns. For the liquid NSE
// large-caps a basket trades these are contemporaneous (same trading days); for a
// name with interior gaps the pairing is approximate.
//
// This note used to call that harmless on two grounds, neither of which had been measured.
// Both are now measured — `node backtest/research/cov-alignment.mjs`:
//   (a) "such names are rare in this universe" — roughly right, and now quantified. On the
//       full untrimmed timeline it is 6 of 185 solved rebalances for the risk-parity basket
//       (3.2%) and 4 of 173 for the mean-variance one (2.3%); cut to the market's own span,
//       1.1% / 0.6%. Say which basis you mean — they differ threefold — and note 3.2% is the
//       most flattering of three true framings: per displaced COLUMN it is 0.61%, per
//       displaced RETURN CELL 0.21%, and in absolute terms it is six rebalances in twenty
//       years.
//   (b) "the optimiser degrades to inverse-vol when the covariance is ill-conditioned anyway"
//       — WRONG. That fallback does not protect against this. Displacing a column in time does
//       not make the matrix ill-conditioned; it drives the off-diagonals toward zero, i.e.
//       TOWARD the diagonal shrinkage target, which is better conditioned, not worse. Every
//       misaligned rebalance measured solved cleanly and its answer was used. The fallback
//       fires on SHORT windows (a name without a full lookback), an unrelated cause.
//
// AND THE CAUSE IS NOT IN THIS FILE AT ALL. The affected names are not missing sessions; they
// have too FEW bars for a grid that has too MANY. `alignSeries` builds the master timeline from
// the UNION of every symbol's timestamps, so a date that two symbols printed on becomes a bar
// for all of them. The universe grid holds 4,938 bars against the index's 4,609, and exactly
// FIVE of those dates are held by under 99% of already-listed names — one of them 2010-02-06,
// a SATURDAY, held by 2 names out of 75. Those five dates account for 100% of the misalignment
// measured (4/4, 1/1, 6/6 and 2/2 across both optimiser baskets and both bases). Fixing the
// covariance window is therefore compensating downstream for a junk row upstream; dropping thin
// dates from the grid would remove the cause — and would also take them out of the price grid,
// out of marking, and out of the `rebalanceBars` counter, which counts GRID bars and so has its
// rebalance phase nudged by them. That is a larger change and it restates published figures, so
// it is left as an open decision rather than made silently.
//
// What the displacement does to a weight: the column loses its covariance with everyone else
// (measured: mean |corr| to the rest of the book falls 0.153, post-shrinkage mean |S_ij| for
// that row falls ~70%, while the Ledoit-Wolf intensity moves only 0.19 -> 0.24, so shrinkage
// does NOT mask it), the name looks like a diversifier, and both optimisers reward that.
// Confirmed three ways: a cyclic ROLL, which leaves the column's variance bit-identical,
// reproduces the effect (97.1%, +3.74pp) while a variance-only rescale does nothing (52.3%,
// +0.005pp) — so it is the correlation, not the variance; and on REAL misaligned bars 8 of the
// 9 displaced risk-parity columns lose weight when date-aligned (19.7%->12.5% on the worst).
// Quote the magnitude as a RANGE, not as +3.7pp: real displacement is always exactly one
// session but only ever PARTIAL (3-88% of a column, mean ~35%), so the whole-column figure is
// an upper bound and a mid-window gap gives ~+1.7pp.
// MEAN-VARIANCE IS NOT MEASURABLE THIS WAY: a placebo that changes the return horizon and
// lookback reach WITHOUT changing alignment moves its weights MORE than the whole own-vs-dates
// difference, because inv(S).mu under a 0.4 cap is that unstable. Risk-parity clears its
// placebo ~6:1 and is the only arm whose numbers mean anything here.
//
// The covariance window is NOT corrected here, deliberately. End to end the effect is far below
// the board's own noise and does not even have a stable sign: over 19 window starts it leans
// negative for risk-parity on both bases and positive for mean-variance on both, flipping in
// every one of the four combinations, with |change in excess-rf Sharpe| <= 0.008 against the
// ~0.25 spread that rebalance phase alone produces. `runPortfolioBacktest({ covAlign: 'dates' })`
// is the corrected construction, opt-in and off by default, so the decision stays open and
// re-measurable.
// ---------------------------------------------------------------------------

import { solveLinear } from './ml.mjs';

// Sample covariance of a returns MATRIX given as COLUMNS: cols[i] is name i's return
// series (length T). Population covariance (/T) — simple + consistent. Returns an
// n×n matrix, or null if a column is too short / mismatched (caller then falls back).
function sampleCov(cols) {
  const n = cols.length;
  if (n < 1) return null;
  const T = cols[0].length;
  if (T < 2 || cols.some((c) => c.length !== T)) return null;
  const mean = cols.map((c) => c.reduce((a, b) => a + b, 0) / T);
  const S = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (cols[i][t] - mean[i]) * (cols[j][t] - mean[j]);
      s /= T;
      S[i][j] = s;
      S[j][i] = s;
    }
  }
  return S;
}

// Ledoit-Wolf shrinkage toward a DIAGONAL target (keep each name's own variance,
// shrink the off-diagonal covariances toward 0):  Σ = (1-δ)·S + δ·diag(S).
// δ ∈ [0,1] is the LW-style optimal intensity, estimated from the data:
//   δ* = Σ_{i≠j} Var̂(s_ij)  /  Σ_{i≠j} (s_ij − target_ij)²
// where Var̂(s_ij) = (1/T²) Σ_t ( (x_it−μ_i)(x_jt−μ_j) − s_ij )² is the asymptotic
// variance of the sample covariance entry (Ledoit-Wolf 2003, diagonal target). A
// tiny ridge on the diagonal keeps Σ strictly positive-definite even when δ → 0.
// Deterministic. Returns { Sigma, delta }.
function shrinkCov(cols, S) {
  const n = S.length;
  const T = cols[0].length;
  const mean = cols.map((c) => c.reduce((a, b) => a + b, 0) / T);
  let num = 0; // Σ off-diagonal Var̂(s_ij)
  let den = 0; // Σ off-diagonal (s_ij − 0)²  (target off-diagonal = 0)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      let v = 0;
      for (let t = 0; t < T; t++) {
        const prod = (cols[i][t] - mean[i]) * (cols[j][t] - mean[j]);
        v += (prod - S[i][j]) ** 2;
      }
      num += v / (T * T);
      den += S[i][j] ** 2;
    }
  }
  // den ≈ 0 means there's essentially no off-diagonal structure to shrink — Σ is
  // already ~diagonal, so any δ gives the same matrix; pick 1 (fully diagonal).
  let delta = den > 1e-18 ? num / den : 1;
  delta = Math.max(0, Math.min(1, delta));
  let avgVar = 0;
  for (let i = 0; i < n; i++) avgVar += S[i][i];
  avgVar = avgVar / n || 1e-8;
  const ridge = 1e-6 * avgVar; // PD floor (keeps the inverse well-defined at δ=0)
  const Sigma = Array.from({ length: n }, () => new Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      Sigma[i][j] = (1 - delta) * S[i][j] + (i === j ? delta * S[i][i] + ridge : 0);
    }
  }
  return { Sigma, delta };
}

// Project a raw weight vector onto the feasible set: LONG-ONLY (clip negatives to 0),
// a per-name CAP (= maxWeight·gross), and SUM = gross. Iterative water-filling: fix
// any name that exceeds the cap at the cap, redistribute the remaining budget across
// the uncapped names proportionally, repeat (a few passes converge). Returns the
// weight vector, or null if no positive-sum vector exists.
function projectWeights(raw, gross, maxWeight) {
  const n = raw.length;
  let w = raw.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  if (!(w.reduce((a, b) => a + b, 0) > 0)) return null;
  const cap = (maxWeight && maxWeight > 0 && maxWeight < 1 ? maxWeight : 1) * gross;
  const capped = new Array(n).fill(false);
  for (let iter = 0; iter < 8; iter++) {
    let fixedSum = 0;
    let freeSum = 0;
    for (let i = 0; i < n; i++) (capped[i] ? (fixedSum += w[i]) : (freeSum += w[i]));
    const budget = gross - fixedSum;
    if (freeSum > 0 && budget > 0) {
      const scale = budget / freeSum;
      for (let i = 0; i < n; i++) if (!capped[i]) w[i] *= scale;
    }
    let newlyCapped = false;
    for (let i = 0; i < n; i++) {
      if (!capped[i] && w[i] > cap + 1e-12) { w[i] = cap; capped[i] = true; newlyCapped = true; }
    }
    if (!newlyCapped) break;
  }
  return w;
}

// MEAN-VARIANCE weights: w ∝ Σ⁻¹ μ, projected long-only + capped to sum = gross.
// μ is shifted so its minimum is a tiny positive number (the chosen names are all
// "good" relative to the field, so a long-only tilt is sensible, and the shift keeps
// the RELATIVE structure while guaranteeing a meaningful long-only solution). With no
// μ (or a constant μ) this reduces to the MINIMUM-VARIANCE portfolio (w ∝ Σ⁻¹ 1).
// Returns the weight vector, or null on a singular / non-finite solve (caller falls back).
function meanVarWeights(cols, mu, gross = 1, maxWeight = 1) {
  const S = sampleCov(cols);
  if (!S) return null;
  const { Sigma } = shrinkCov(cols, S);
  const n = Sigma.length;
  let muVec;
  if (Array.isArray(mu) && mu.length === n && mu.every((x) => Number.isFinite(x))) {
    const lo = Math.min(...mu);
    muVec = mu.map((m) => m - lo + 1e-6); // shift so the smallest is just above 0
  } else {
    muVec = new Array(n).fill(1); // -> minimum-variance
  }
  const raw = solveLinear(Sigma, muVec);
  if (!raw || raw.some((x) => !Number.isFinite(x))) return null;
  return projectWeights(raw, gross, maxWeight);
}

// RISK-PARITY (equal-risk-contribution) weights via a deterministic multiplicative
// fixed-point. Start at inverse-vol; each iteration nudge w_i toward the target risk
// share (with a sqrt-damped step for stability), renormalise, repeat a FIXED number
// of times. RC_i = w_i·(Σw)_i is name i's risk contribution; at convergence every RC
// equals (wᵀΣw)/n. Returns the weight vector, or null on degenerate data.
function riskParityWeights(cols, gross = 1, maxWeight = 1, iterations = 60) {
  const S = sampleCov(cols);
  if (!S) return null;
  const { Sigma } = shrinkCov(cols, S);
  const n = Sigma.length;
  let w = Sigma.map((row, i) => (row[i] > 1e-18 ? 1 / Math.sqrt(row[i]) : 0)); // inverse-vol start
  let s0 = w.reduce((a, b) => a + b, 0);
  if (!(s0 > 0)) return null;
  w = w.map((x) => x / s0);
  for (let it = 0; it < iterations; it++) {
    const Sw = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Sw[i] += Sigma[i][j] * w[j];
    const port = w.reduce((a, wi, i) => a + wi * Sw[i], 0); // wᵀΣw
    if (!(port > 0)) break;
    const target = port / n;
    let s = 0;
    for (let i = 0; i < n; i++) {
      const rc = w[i] * Sw[i];
      const factor = rc > 1e-18 ? target / rc : 1;
      w[i] = w[i] * Math.sqrt(factor); // sqrt damps the step -> stable, monotone
      s += w[i];
    }
    if (!(s > 0)) break;
    for (let i = 0; i < n; i++) w[i] /= s;
  }
  // VALIDITY GATE: the multiplicative ERC scheme only converges when EVERY name has a
  // POSITIVE marginal risk contribution (Σw)_i. A negatively-correlated "hedge" name yields
  // a negative marginal contribution the scheme cannot correct (it oscillates and would ship
  // the OPPOSITE of risk parity — over-weighting the hedge). Detect that and bail to null, so
  // weightsFor degrades to inverse-vol (a sensible, fully-invested, risk-based fallback). For
  // the common all-positive-correlation case this never triggers and the proper equal-risk-
  // contribution weights are returned. (Long-only ERC with a hedging asset is ill-posed for
  // this simple solver; degrading is the correct, deterministic quant behaviour.)
  const Sw = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Sw[i] += Sigma[i][j] * w[j];
  if (Sw.some((x) => !(x > 0))) return null;
  return projectWeights(w, gross, maxWeight);
}

// Each name's share of total portfolio variance, as a percentage — for the per-bot
// page's "risk contributions" (computed only when recording a decision, off the hot
// path). RC_i = w_i·(Σw)_i / (wᵀΣw). Returns [pct] parallel to `weights`, or null.
function riskContributions(cols, weights) {
  const S = sampleCov(cols);
  if (!S || !weights || weights.length !== S.length) return null;
  const { Sigma } = shrinkCov(cols, S);
  const n = Sigma.length;
  const Sw = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) Sw[i] += Sigma[i][j] * weights[j];
  const port = weights.reduce((a, wi, i) => a + wi * Sw[i], 0);
  if (!(port > 0)) return null;
  const shares = weights.map((wi, i) => (wi * Sw[i]) / port);
  // A NEGATIVE share means the name reduces portfolio risk (a hedge) — a valid portfolio
  // fact, but not a clean risk-parity decomposition. Return null so the per-bot page omits a
  // confusing negative "Risk %" rather than displaying e.g. -18%.
  if (shares.some((x) => x < -1e-9)) return null;
  return shares.map((x) => +(x * 100).toFixed(1));
}

export { sampleCov, shrinkCov, projectWeights, meanVarWeights, riskParityWeights, riskContributions };
