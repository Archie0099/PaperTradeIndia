// ---------------------------------------------------------------------------
// core/options.js
// Pure option mathematics. This module has NO dependencies and needs NO data
// feed — it is the heart of the offline option tools.
//
// It provides:
//   * Black-Scholes price for European call/put
//   * Greeks: delta, gamma, theta (per DAY), vega (per 1% vol)
//   * Implied-volatility solver using bisection (robust, always converges
//     within the bracket)
//
// Conventions used everywhere:
//   S  = spot price of the underlying
//   K  = strike price
//   T  = time to expiry in YEARS (e.g. 7 days = 7/365)
//   r  = risk-free rate as a decimal (0.065 = 6.5%)
//   vol= volatility as a decimal (0.20 = 20%)
//   type = 'CE' (call) or 'PE' (put)
// ---------------------------------------------------------------------------

// Standard normal probability density function  φ(x).
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Standard normal cumulative distribution function  N(x).
// Uses the Abramowitz & Stegun 7.1.26 approximation (accurate to ~1e-7).
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = normPdf(x);
  let p =
    d *
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  p = 1 - p;
  return x >= 0 ? p : 1 - p;
}

// d1 and d2 terms of the Black-Scholes formula.
function d1d2(S, K, T, r, vol) {
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (vol * vol) / 2) * T) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  return { d1, d2 };
}

// Black-Scholes theoretical price for a European option.
function bsPrice(type, S, K, T, r, vol) {
  // Guard against degenerate inputs (expiry today, zero vol, or a non-positive
  // spot/strike — e.g. a strike typed as 0/negative in the strategy builder):
  // fall back to intrinsic value so the tools never return NaN. The `!(x > 0)`
  // form (not `x <= 0`) also catches NaN/undefined inputs, which `<= 0` misses.
  if (!(T > 0) || !(vol > 0) || !(S > 0) || !(K > 0)) {
    return type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
  }
  const { d1, d2 } = d1d2(S, K, T, r, vol);
  if (type === 'CE') {
    return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  }
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

// All Greeks for one option. Theta is per CALENDAR DAY; vega is per 1% (one
// volatility point) — the units traders actually read on a screen.
function greeks(type, S, K, T, r, vol) {
  if (!(T > 0) || !(vol > 0) || !(S > 0) || !(K > 0)) {
    // At/after expiry, zero vol, or a non-positive spot/strike: Greeks collapse;
    // return zeros except delta's step. The `!(x > 0)` form (not `x <= 0`) also
    // catches NaN/undefined inputs, exactly mirroring bsPrice's guard above.
    const intrinsicDelta = type === 'CE' ? (S > K ? 1 : 0) : S < K ? -1 : 0;
    return { delta: intrinsicDelta, gamma: 0, theta: 0, vega: 0 };
  }
  const { d1, d2 } = d1d2(S, K, T, r, vol);
  const sqrtT = Math.sqrt(T);
  const pdfd1 = normPdf(d1);

  const delta = type === 'CE' ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = pdfd1 / (S * vol * sqrtT);
  const vega = S * pdfd1 * sqrtT; // per 1.00 (100%) vol...
  const vegaPer1pct = vega / 100; // ...scaled to per 1% vol

  // Theta per year, then divide by 365 for per-day.
  const term1 = -(S * pdfd1 * vol) / (2 * sqrtT);
  let thetaYear;
  if (type === 'CE') {
    thetaYear = term1 - r * K * Math.exp(-r * T) * normCdf(d2);
  } else {
    thetaYear = term1 + r * K * Math.exp(-r * T) * normCdf(-d2);
  }
  const thetaDay = thetaYear / 365;

  // Return FULL precision. Gamma on a high-priced index option is naturally
  // tiny (~1e-3 to 1e-4); rounding it to 4 decimals here silently threw away
  // most of its significant digits. Callers format for display themselves.
  return {
    delta: delta,
    gamma: gamma,
    theta: thetaDay,
    vega: vegaPer1pct,
  };
}

// Implied volatility via bisection. Given a market price, find the vol that
// reproduces it. Bisection cannot diverge: it just halves the bracket each
// step. Returns NaN (a clean "no answer", never a garbage number) when the
// price is outside the achievable range.
function impliedVol(type, marketPrice, S, K, T, r) {
  if (!(marketPrice > 0) || T <= 0) return NaN;

  // Lower bound for a EUROPEAN option uses the DISCOUNTED strike (the forward
  // intrinsic). A deep in-the-money European PUT legitimately trades below the
  // naive K - S, so checking against K - S wrongly rejected valid prices.
  const discountedK = K * Math.exp(-r * T);
  const lowerBound = type === 'CE' ? Math.max(0, S - discountedK) : Math.max(0, discountedK - S);
  if (marketPrice < lowerBound - 1e-6) return NaN; // below the no-arbitrage floor

  let lo = 0.0001; // 0.01% vol
  let hi = 5.0; // 500% vol — generous starting upper bound
  // Expand the upper bracket geometrically if the price implies a vol above
  // 500%, up to a sane cap (~16000%): hi doubles from 5.0 while hi < 100, so it
  // reaches 160 (= 16000% vol) before the guard stops it. This lets an achievable
  // (if extreme) IV still resolve instead of returning a false "no solution"; if
  // even the cap can't reach the price, it is genuinely out of range -> NaN.
  let expand = 0;
  while (bsPrice(type, S, K, T, r, hi) < marketPrice && hi < 100 && expand++ < 20) {
    hi *= 2;
  }
  if (bsPrice(type, S, K, T, r, hi) < marketPrice) return NaN;

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    const price = bsPrice(type, S, K, T, r, mid);
    if (Math.abs(price - marketPrice) < 1e-4) return round4(mid);
    if (price > marketPrice) hi = mid;
    else lo = mid;
  }
  return round4((lo + hi) / 2);
}

// Convenience: time to expiry in years from a Date / timestamp.
// A small floor avoids divide-by-zero on expiry day.
function yearsToExpiry(expiryMs, nowMs = Date.now()) {
  const ms = expiryMs - nowMs;
  return Math.max(ms / (365 * 24 * 3600 * 1000), 0.5 / 365);
}

function round4(x) {
  return Math.round(x * 10000) / 10000;
}

export { bsPrice, greeks, impliedVol, normCdf, normPdf, yearsToExpiry };
