// ---------------------------------------------------------------------------
// backtest/risk.mjs
// Market-risk measures — VaR, Expected Shortfall, volatility models, and the
// back-testing statistics that judge a VaR model — as pure functions on return
// series. No engine, no network, no side effects, so every one is unit-testable
// against a textbook number.
//
// WHY THIS FILE EXISTS. The board already reports return, Sharpe, Sortino and max
// drawdown. None of those answers the two questions a risk desk actually asks
// [RMFI p.287]: VaR — "How bad can things get?" — and ES — "If things do get bad,
// what is the expected loss?" And none of them can be BACK-TESTED the way a VaR
// can: a VaR published every day makes a falsifiable claim ("a loss beyond this
// should happen ~1 day in 100"), and counting how often reality exceeded it is
// exactly the forward-test discipline this project is built on. A bot whose own
// 99% VaR is breached 3x more often than it should be is mis-measuring its risk,
// whatever its Sharpe says.
//
// SOURCES. Every formula below is taken from, and every test number is locked to,
// Hull, *Risk Management and Financial Institutions* 4e (cited as [RMFI p.N], PDF
// page). Nothing here is from general knowledge; where a
// convention differs between sources (Hull's "5th worst of 500" vs Excel's
// PERCENTILE.INC; 1.645 vs the rounded 1.65) BOTH are offered and the difference
// is named, because spreadsheets use one and the textbook the other.
//
// SIGN CONVENTION. Internally everything is in LOSS terms, as Hull does: a VaR is
// a POSITIVE number of rupees (or a positive fraction of equity) that you might
// LOSE. Inputs are RETURNS (fractions, +1% = 0.01); loss = -return. Some practitioner material
// works in return terms and prints VaR negative — same number,
// opposite sign; callers that want that can negate.
// ---------------------------------------------------------------------------

import { mean } from './metrics.mjs';

// --- Standard normal -------------------------------------------------------

// φ(z) — the standard normal density.
const normPdf = (z) => Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);

// N⁻¹(p) — the inverse standard normal (Excel's NORMSINV). Acklam's rational
// approximation with one Halley refinement step: relative error ~1e-9, far
// inside what any VaR needs. Self-contained rather than inverting options.js's
// normCdf by bisection, because that CDF is only ~1e-7 accurate and the z-table
// commonly printed to 3 decimals — we must reproduce
// 1.645 / 2.326 / 3.090 / 3.430 exactly, not to within 1e-7 of the wrong thing.
function normInv(p) {
  if (!(p > 0 && p < 1)) return NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
  const pLow = 0.02425;
  let x;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  // One step of Halley's method against an erfc-based CDF tightens the tail.
  const e = 0.5 * erfc(-x / Math.SQRT2) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  x = x - u / (1 + x * u / 2);
  return x;
}

// Complementary error function (Numerical Recipes' Chebyshev fit, |err| < 1.2e-7),
// used only inside normInv's refinement step.
function erfc(x) {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))));
  return x >= 0 ? r : 2 - r;
}

// --- Parametric (variance–covariance) VaR and ES ---------------------------

// Hull's equations (12.1) and (12.2) on the LOSS distribution [RMFI p.292]:
//   VaR = μ + σ·N⁻¹(X)          ES = μ + σ·φ(Y)/(1−X),  Y = N⁻¹(X)
// `mu` and `sigma` are the mean and standard deviation of the LOSS over the horizon.
// For a short horizon μ is usually taken as zero, making both proportional to σ.
// ⚠ `z` may be passed explicitly: a common spreadsheet convention rounds to
// z = 1.65 at 95%, where the textbook uses 1.645. Default is exact.
function parametricVaR(mu, sigma, conf = 0.99, z = normInv(conf)) {
  return mu + sigma * z;
}
function parametricES(mu, sigma, conf = 0.99, z = normInv(conf)) {
  return mu + sigma * normPdf(z) / (1 - conf);
}

// Change the confidence level of a zero-mean-normal VaR / ES without recomputing
// σ — equations (12.6) and (12.7) [RMFI p.295].
function convertVaRConfidence(varX, X, Xstar) {
  return varX * normInv(Xstar) / normInv(X);
}
function convertESConfidence(esX, X, Xstar) {
  const Y = normInv(X);
  const Ys = normInv(Xstar);
  return esX * ((1 - X) * Math.exp(-(Ys - Y) * (Ys + Y) / 2)) / (1 - Xstar);
}

// --- Time scaling -----------------------------------------------------------

// T-day VaR from 1-day VaR. With ρ = 0 this is the √T rule, equations (12.3)/(12.4),
// "exactly true when the changes ... on successive days have independent identical
// normal distributions with mean zero" [RMFI p.293]. With first-order autocorrelation
// ρ it is equation (12.5): σ√(T + 2(T−1)ρ + 2(T−2)ρ² + … + 2ρ^(T−1)). Ignoring a
// positive ρ makes a √T-scaled VaR TOO LOW [RMFI p.294].
function scaleHorizon(oneDay, T, rho = 0) {
  if (!(T >= 1)) return NaN;
  let s = T;
  for (let k = 1; k < T; k++) s += 2 * (T - k) * Math.pow(rho, k);
  return oneDay * Math.sqrt(s);
}

// --- Historical simulation --------------------------------------------------

// The tail-expectation helper both discrete VaR/ES and weighted historical simulation
// share. Given outcomes sorted WORST-FIRST with probability weights, fill a tail of
// exactly `tailProb` (= 1 − X): the first outcomes in full, the last one PARTIALLY so
// the weights sum to exactly tailProb, and return
//   { var: the loss at which the cumulative weight first reaches tailProb,
//     es:  Σ(w_i · L_i) / tailProb over that filled tail }.
// This partial-fill rule is Hull's own, not a choice made here: it is the only
// convention under which RMFI answer 13.6 reproduces — "ES = 0.948 × 477,841 +
// 0.052 × 345,435 = $470,917" [RMFI p.677], where 0.948 is the worst scenario's
// full weight as a share of the 1% tail and 0.052 is the REMAINDER, not the second
// scenario's own weight. Problem 12.5 fills the same way: "0.9% × 10M + 0.1% × 1M"
// [RMFI p.676].
function tailExpectation(worstFirst, tailProb) {
  let cum = 0;
  let acc = 0;
  for (const { loss, w } of worstFirst) {
    if (cum + w >= tailProb) {
      acc += (tailProb - cum) * loss;
      return { var: loss, es: acc / tailProb };
    }
    cum += w;
    acc += w * loss;
  }
  // Total probability short of the tail (malformed input): report what we have.
  const last = worstFirst[worstFirst.length - 1];
  return { var: last ? last.loss : NaN, es: cum > 0 ? acc / cum : NaN };
}

// VaR and ES of a DISCRETE loss distribution — Problem 12.5's shape [RMFI p.676]:
// `outcomes` = [{ loss, p }]. VaR at X is the smallest loss L with P(loss ≤ L) ≥ X;
// ES is the expectation over the worst (1 − X) of probability, filled as above.
function discreteVaR(outcomes, conf = 0.99) {
  const worst = outcomes.slice().sort((a, b) => b.loss - a.loss).map((o) => ({ loss: o.loss, w: o.p }));
  return tailExpectation(worst, 1 - conf).var;
}
function discreteES(outcomes, conf = 0.99) {
  const worst = outcomes.slice().sort((a, b) => b.loss - a.loss).map((o) => ({ loss: o.loss, w: o.p }));
  return tailExpectation(worst, 1 - conf).es;
}

// Excel PERCENTILE.INC on an ASCENDING array: position 1 + p(n − 1) (1-based),
// linearly interpolated. This is the spreadsheet convention for
// "historical VaR" — NOT Hull's "k-th worst" counting rule.
function percentileInc(sortedAsc, p) {
  const n = sortedAsc.length;
  if (!n) return NaN;
  if (n === 1) return sortedAsc[0];
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const frac = pos - lo;
  // p·(n−1) is not exact in floating point (0.05 × 20 = 1.0000000000000002), and a 2e-16
  // fraction would nudge the cut a hair ABOVE the exact rank so that rank's own return
  // then counts as "strictly beyond" it — one extra point in the ES tail. Snap it.
  if (frac < 1e-9) return sortedAsc[lo];
  return sortedAsc[lo] + frac * (sortedAsc[hi] - sortedAsc[lo]);
}

// A practitioner interpolated-percentile convention, 1-based:
// q = int(pn), r = q + 1, IP(p) = (r − pn)·x_q + (pn − q)·x_r on an ascending series.
// Differs from PERCENTILE.INC (which uses 1 + p(n − 1)); offered because production
// systems use it and its worked number is locked in the tests.
function interpolatedPercentileCS(sortedAsc, p) {
  const n = sortedAsc.length;
  const pn = p * n;
  const q = Math.floor(pn);
  const r = q + 1;
  const xq = sortedAsc[Math.max(0, q - 1)];
  const xr = sortedAsc[Math.min(n - 1, r - 1)];
  return (r - pn) * xq + (pn - q) * xr;
}

// Historical-simulation VaR and ES from a series of RETURNS (fractions), at
// confidence `conf`, as POSITIVE loss fractions. Two conventions:
//   method 'hull'       — the k-th worst loss where k = n(1 − X): "the 99 percentile
//                         ... can be estimated as the fifth worst outcome" of 500
//                         [RMFI p.306]; ES = mean of the k worst [RMFI p.310].
//   method 'percentile' — Excel PERCENTILE.INC at p = 1 − X on the returns (the spreadsheet
//                         convention); ES = mean of the returns STRICTLY beyond
//                         that percentile.
// Returns null when there are too few observations for the tail to contain even one
// point (k < 1) — a VaR from 20 returns at 99% is not a number, it is a guess.
function historicalVaR(returns, { conf = 0.99, method = 'hull' } = {}) {
  const r = (returns || []).filter(Number.isFinite);
  const n = r.length;
  if (!n) return null;
  if (method === 'percentile') {
    const asc = r.slice().sort((a, b) => a - b);
    const cut = percentileInc(asc, 1 - conf);
    const tail = asc.filter((x) => x < cut);
    return { var: -cut, es: tail.length ? -mean(tail) : -cut, n, k: tail.length };
  }
  const k = Math.round(n * (1 - conf));
  if (k < 1) return null;
  const worst = worstKLosses(r, k); // worst first
  return { var: worst[k - 1], es: mean(worst), n, k };
}

// The k largest losses of a return series, worst first, in ONE pass (O(n·k)). The VaR only
// ever needs the tail, and a full sort of a 500-point window 250 times per bot cost ~40 ms
// a bot — ~1 s for the board on a free-tier vCPU, on the SYNCHRONOUS control-op path
// Same values as sort-then-slice; the four-index test locks that.
function worstKLosses(returns, k) {
  const buf = []; // kept sorted descending, length ≤ k
  for (const x of returns) {
    const l = -x;
    if (buf.length < k || l > buf[buf.length - 1]) {
      let i = buf.length;
      while (i > 0 && buf[i - 1] < l) i--;
      buf.splice(i, 0, l);
      if (buf.length > k) buf.pop();
    }
  }
  return buf;
}

// WEIGHTED historical simulation (Boudoukh–Richardson–Whitelaw), the "Responsive
// VaR" of practitioner risk systems: scenario i of n (1 = oldest, n = most recent) carries weight
//   w_i = λ^(n−i) (1 − λ) / (1 − λ^n)                              [RMFI p.312]
// so "the most recent six months carries ~56% of the total weight" at λ = 0.994 over
// two years. Losses are ranked worst-first and the tail filled to exactly
// 1 − X (see tailExpectation). Practitioner systems commonly use λ = 0.994; RMFI's example uses 0.995;
// the regulatory floor (weighted-average observation period ≥ 130 days on a 2-year
// window) requires λ ≥ 0.9932.
function weightedHistoricalVaR(returns, { conf = 0.99, lambda = 0.994 } = {}) {
  const r = (returns || []).filter(Number.isFinite);
  const n = r.length;
  if (!n) return null;
  const denom = 1 - Math.pow(lambda, n);
  const rows = r.map((x, idx) => ({ loss: -x, w: Math.pow(lambda, n - (idx + 1)) * (1 - lambda) / denom }));
  rows.sort((a, b) => b.loss - a.loss);
  const { var: v, es } = tailExpectation(rows, 1 - conf);
  return { var: v, es, n, lambda };
}

// The BRW weight of a single scenario — exported so the tests can lock the formula
// itself against RMFI's printed 0.00528 for scenario 494 of 500 at λ = 0.995.
function brwWeight(i, n, lambda) {
  return Math.pow(lambda, n - i) * (1 - lambda) / (1 - Math.pow(lambda, n));
}

// --- Volatility models (variance rates, per bar) ---------------------------

// EWMA — equation (10.8) [RMFI p.241]:  σ²ₙ = λ σ²ₙ₋₁ + (1 − λ) u²ₙ₋₁.
// `u` is the PERCENTAGE change (Sₙ − Sₙ₋₁)/Sₙ₋₁, not the log return — the two
// definitions give different answers to the book's own examples.
// RiskMetrics used λ = 0.94 [RMFI p.241]. Returns the new VARIANCE rate.
function ewmaVariance(prevVar, u, lambda = 0.94) {
  return lambda * prevVar + (1 - lambda) * u * u;
}

// GARCH(1,1) — equation (10.10) [RMFI p.243]:  σ²ₙ = ω + α u²ₙ₋₁ + β σ²ₙ₋₁,
// with long-run variance V_L = ω / (1 − α − β) and the stability condition
// α + β < 1 ("otherwise the weight applied to the long-term variance is negative").
// EWMA is the special case ω = 0, α = 1 − λ, β = λ [RMFI p.242]. When a fitted ω
// comes out NEGATIVE the model is unstable — "switch to the EWMA model" [RMFI p.244].
function garchVariance(prevVar, u, { omega, alpha, beta }) {
  return omega + alpha * u * u + beta * prevVar;
}
function garchLongRunVariance({ omega, alpha, beta }) {
  const gamma = 1 - alpha - beta;
  return gamma > 0 ? omega / gamma : NaN;
}
// Expected variance t bars ahead — equation (10.14) [RMFI p.251]:
//   E[σ²ₙ₊ₜ] = V_L + (α + β)ᵗ (σ²ₙ − V_L)   — mean reversion to V_L at rate 1 − α − β.
function garchForecastVariance(currentVar, t, params) {
  const VL = garchLongRunVariance(params);
  return VL + Math.pow(params.alpha + params.beta, t) * (currentVar - VL);
}

// --- Back-testing a VaR model -----------------------------------------------

// P(at least m exceptions in n days) when each day is an exception with probability
// p = 1 − X, i.e. the one-tailed binomial test [RMFI p.299]. Summed in log space so
// n = 1000 does not overflow. Reject the model (5% significance) when this is < 0.05.
function binomialTailProb(m, n, p) {
  if (m <= 0) return 1;
  if (m > n) return 0;
  let logC = 0; // log C(n, k), built incrementally
  let total = 0;
  for (let k = 0; k <= n; k++) {
    if (k > 0) logC += Math.log(n - k + 1) - Math.log(k);
    if (k >= m) total += Math.exp(logC + k * Math.log(p) + (n - k) * Math.log(1 - p));
  }
  return Math.min(1, total);
}

// Kupiec's two-tailed likelihood-ratio test, equation (12.11) [RMFI p.300]:
//   −2 ln[(1−p)^(n−m) p^m] + 2 ln[(1 − m/n)^(n−m) (m/n)^m]  ~ χ²₁ ;  reject if > 3.84.
// Two-tailed by construction: it rejects for too FEW exceptions as well as too many
// (too few means the VaR is too high and capital is being wasted).
function kupiecStatistic(m, n, p) {
  if (n <= 0) return NaN;
  const f = m / n;
  const lnNull = (n - m) * Math.log(1 - p) + m * Math.log(p);
  const lnAlt = (n - m) * (f < 1 ? Math.log(1 - f) : 0) + (m > 0 ? m * Math.log(f) : 0);
  return -2 * lnNull + 2 * lnAlt;
}
const KUPIEC_CRITICAL = 3.84; // χ²₁ at 5%

// The Basel "traffic light": the capital multiplier m_c set by the number of
// exceptions in the last 250 days of one-day 99% VaR back-testing [RMFI p.364].
//   0–4 green (m_c = 3), 5–9 yellow (3.40 … 3.85), ≥ 10 red (m_c = 4).
// Expected exceptions in 250 days at 1% are 2.5; P(≥ 5) is 10.8%, so "regulators
// are using a confidence level of about 10%" in choosing to reject [RMFI p.682].
const BASEL_MC = [3, 3, 3, 3, 3, 3.4, 3.5, 3.65, 3.75, 3.85];
function baselZone(exceptions) {
  if (exceptions >= 10) return { zone: 'red', mc: 4 };
  if (exceptions >= 5) return { zone: 'yellow', mc: BASEL_MC[exceptions] };
  return { zone: 'green', mc: 3 };
}

// Score a VaR model's record: given the number of exceptions `m` seen over `n` days at
// confidence `conf`, return everything a reader needs to judge it.
function backtestSummary(m, n, conf = 0.99) {
  const p = 1 - conf;
  const stat = kupiecStatistic(m, n, p);
  return {
    exceptions: m,
    days: n,
    expected: +(n * p).toFixed(2),
    tooManyP: binomialTailProb(m, n, p),         // P(≥ m) under the model — small = too many
    kupiec: +stat.toFixed(3),
    kupiecReject: stat > KUPIEC_CRITICAL,
    // The Basel ladder is DEFINED on 250 days [RMFI p.364]. An earlier draft pro-rated the count
    // to 250 and produced a RED zone on a 25-day window whose own Kupiec line said "does not
    // reject" — two verdicts on one object contradicting each other On any
    // other span the zone is null and the UI shows the raw count without one.
    ...(n === 250 ? baselZone(m) : { zone: null, mc: null }),
  };
}

// --- Per-bar losses from an equity curve, and the wipe rule -------------------

// Per-bar LOSSES as fractions of the bar's opening equity, for the VaR machinery. Mirrors
// dailyReturns (skips steps whose opening equity is not positive) with ONE difference, and
// it is the same rule maxDrawdownPct already applies: a bar that ends at or below zero is a
// TOTAL loss, clamped at 100% — "once equity goes negative, (peak−c)/peak overstates a loss
// that is really capped at a total wipeout" [metrics.mjs]. Without the clamp a short blow-up
// from ₹20L to −₹5cr books a −2600% return, and one such bar anywhere in the 1% tail makes
// the ES read "524%" — a number with no meaning as a fraction of an account (found in
// review; reproduced deterministically in risk.test.mjs). The clamp is LOCAL to
// risk.mjs on purpose: dailyReturns feeds sharpe/sortino too, and their wiped-curve
// convention (cap Sharpe ≤ 0) must stay byte-identical. Nothing here caps
// what the ENGINE lets a short lose; it caps only how that loss is stated per rupee held.
function lossSeries(equity) {
  const out = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    if (!(prev > 0)) continue;
    const next = equity[i];
    out.push(next > 0 ? 1 - next / prev : 1);
  }
  return out;
}
// Did the account touch zero or below anywhere in this stretch of the curve? Surfaced as
// `wiped` so a reader sees "a total loss sits inside this tail" instead of a bare percentage.
const wipedWithin = (equity) => equity.some((e) => !(e > 0));

// --- The rolling, no-hindsight back-test on an EQUITY CURVE -------------------

// Walk the last `testDays` bars of an equity curve. On each, the VaR is the
// historical-simulation VaR of the PRECEDING `window` returns — known before the day
// began, never after — and the day is an exception if its realised loss exceeded it.
// This is the honest form: "VaR assumes an unchanged portfolio", and comparing against
// hypothetical (unchanged-book) P&L is "more theoretically correct" [RMFI p.299]; a
// bot's marked-to-market curve IS that hypothetical P&L. Needs at least `minWindow`
// returns before the first tested day, else the test is skipped (null) rather than
// run on a tail that cannot contain a point.
function rollingVaRBacktest(equity, { conf = 0.99, window = 500, testDays = 250, minWindow = 100, method = 'hull' } = {}) {
  const L = lossSeries(equity); // clamped losses (see above); a wipe bar is a 100% loss and always an exception
  const n = L.length;
  const first = Math.max(minWindow, n - testDays);
  if (n - first < 1) return null;
  let exceptions = 0;
  let tested = 0;
  const exceptionIdx = [];
  for (let d = first; d < n; d++) {
    const hist = L.slice(Math.max(0, d - window), d).map((l) => -l); // historicalVaR takes RETURNS
    const v = historicalVaR(hist, { conf, method });
    if (!v) continue;
    tested++;
    if (L[d] > v.var) { exceptions++; exceptionIdx.push(d); }
  }
  if (!tested) return null;
  return { ...backtestSummary(exceptions, tested, conf), method, window, exceptionIdx };
}

// Everything the board wants for one bot, from its equity curve: today's one-day
// VaR/ES (historical, on the trailing `window` returns) as fractions of equity, and
// the rolling back-test of that same model over the last `testDays`. Null-safe: a
// curve too short for a tail returns nulls, never a made-up number. `wiped` is true
// when the account touched zero or below INSIDE the trailing window — the VaR/ES are
// then capped at 100% (a total loss) and the UI must say so rather than print a bare
// figure; a total loss in the tail is the truth of that bot, not a display artifact.
function riskProfile(equity, { conf = 0.99, window = 500, testDays = 250 } = {}) {
  const L = lossSeries(equity);
  const recentLosses = L.slice(-window);
  const recent = recentLosses.map((l) => -l); // as RETURNS, for historicalVaR
  const hs = historicalVaR(recent, { conf });
  const bt = rollingVaRBacktest(equity, { conf, window, testDays });
  return {
    conf,
    window: recent.length,
    wiped: wipedWithin(equity.slice(-(recent.length + 1))),
    var1dPct: hs ? +(hs.var * 100).toFixed(3) : null,
    es1dPct: hs ? +(hs.es * 100).toFixed(3) : null,
    var10dPct: hs ? +(Math.min(1, scaleHorizon(hs.var, 10)) * 100).toFixed(3) : null, // √10 rule (12.3), capped at a total loss
    backtest: bt ? { exceptions: bt.exceptions, days: bt.days, expected: bt.expected, kupiec: bt.kupiec, kupiecReject: bt.kupiecReject, zone: bt.zone, mc: bt.mc } : null,
  };
}

export {
  normInv, normPdf,
  parametricVaR, parametricES, convertVaRConfidence, convertESConfidence,
  scaleHorizon,
  tailExpectation, discreteVaR, discreteES,
  percentileInc, interpolatedPercentileCS, historicalVaR, weightedHistoricalVaR, brwWeight,
  ewmaVariance, garchVariance, garchLongRunVariance, garchForecastVariance,
  binomialTailProb, kupiecStatistic, KUPIEC_CRITICAL, baselZone, backtestSummary,
  lossSeries, wipedWithin,
  rollingVaRBacktest, riskProfile,
};
