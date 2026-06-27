// ---------------------------------------------------------------------------
// core/strategies.js
// Multi-leg option strategy maths. Also pure and offline-friendly.
//
// A "leg" is one option/future position:
//   { type: 'CE' | 'PE' | 'FUT',   // call, put, or future
//     side: 'BUY' | 'SELL',
//     strike,                       // ignored for FUT
//     premium,                      // entry price PER UNIT (the future's entry
//                                   //   price for FUT legs)
//     lots, lotSize }               // quantity = lots * lotSize units
//
// This module computes the payoff AT EXPIRY across a range of underlying
// prices, the breakeven points, and the max profit / max loss (flagging
// "unbounded" when a naked leg makes the curve run off to infinity).
// ---------------------------------------------------------------------------

import { bsPrice, greeks } from './options.js';

// --- Strategy templates -----------------------------------------------------
// Each template builds an array of "leg blueprints" given the spot, the strike
// step (e.g. 50 for NIFTY) and the lot size. Premiums are left at 0 here; the
// UI prices them with Black-Scholes before drawing. `strike` is absolute.
function atm(spot, step) {
  return Math.round(spot / step) * step;
}

const TEMPLATES = {
  long_call: {
    name: 'Long Call',
    build: (s, step) => [leg('CE', 'BUY', atm(s, step))],
  },
  long_put: {
    name: 'Long Put',
    build: (s, step) => [leg('PE', 'BUY', atm(s, step))],
  },
  short_call: {
    name: 'Short Call (naked)',
    build: (s, step) => [leg('CE', 'SELL', atm(s, step))],
  },
  short_put: {
    name: 'Short Put (naked)',
    build: (s, step) => [leg('PE', 'SELL', atm(s, step))],
  },
  straddle: {
    name: 'Long Straddle',
    build: (s, step) => [leg('CE', 'BUY', atm(s, step)), leg('PE', 'BUY', atm(s, step))],
  },
  strangle: {
    name: 'Long Strangle',
    build: (s, step) => [
      leg('CE', 'BUY', atm(s, step) + 2 * step),
      leg('PE', 'BUY', atm(s, step) - 2 * step),
    ],
  },
  bull_call_spread: {
    name: 'Bull Call Spread',
    build: (s, step) => [
      leg('CE', 'BUY', atm(s, step)),
      leg('CE', 'SELL', atm(s, step) + 2 * step),
    ],
  },
  bear_put_spread: {
    name: 'Bear Put Spread',
    build: (s, step) => [
      leg('PE', 'BUY', atm(s, step)),
      leg('PE', 'SELL', atm(s, step) - 2 * step),
    ],
  },
  iron_condor: {
    name: 'Iron Condor',
    build: (s, step) => [
      leg('PE', 'BUY', atm(s, step) - 3 * step),
      leg('PE', 'SELL', atm(s, step) - 1 * step),
      leg('CE', 'SELL', atm(s, step) + 1 * step),
      leg('CE', 'BUY', atm(s, step) + 3 * step),
    ],
  },
  covered_call: {
    name: 'Covered Call',
    build: (s, step) => [leg('FUT', 'BUY', 0), leg('CE', 'SELL', atm(s, step) + 1 * step)],
  },
  long_call_butterfly: {
    name: 'Long Call Butterfly',
    build: (s, step) => [
      leg('CE', 'BUY', atm(s, step) - step),
      leg('CE', 'SELL', atm(s, step), 2), // sell 2 at the body
      leg('CE', 'BUY', atm(s, step) + step),
    ],
  },
  call_ratio_spread: {
    name: 'Call Ratio Spread (1x2)',
    build: (s, step) => [
      leg('CE', 'BUY', atm(s, step)),
      leg('CE', 'SELL', atm(s, step) + 2 * step, 2), // sell 2 further OTM
    ],
  },
  collar: {
    name: 'Collar (future + protective put + covered call)',
    build: (s, step) => [
      leg('FUT', 'BUY', 0),
      leg('PE', 'BUY', atm(s, step) - step), // downside protection
      leg('CE', 'SELL', atm(s, step) + step), // finances the put
    ],
  },
  // MULTI-EXPIRY templates: legs carry their own days-to-expiry. A long calendar
  // sells the near and buys the far at the SAME strike (profits from the near
  // decaying faster); a diagonal does the same with DIFFERENT strikes. The far
  // leg is ~30 days later than the near (`days` is the near horizon).
  calendar_call: {
    name: 'Calendar Call (sell near, buy far)',
    build: (s, step, days) => [
      leg('CE', 'SELL', atm(s, step), 1, days),
      leg('CE', 'BUY', atm(s, step), 1, days + 30),
    ],
  },
  diagonal_call: {
    name: 'Diagonal Call (sell near, buy far higher strike)',
    build: (s, step, days) => [
      leg('CE', 'SELL', atm(s, step), 1, days),
      leg('CE', 'BUY', atm(s, step) + step, 1, days + 30),
    ],
  },
};

// Strikes are absolute; lots defaults to 1 (butterflies/ratios pass a larger
// lots count). `days` (time-to-expiry for THIS leg) defaults to null, meaning
// "use the strategy-wide horizon" — only calendars/diagonals set it per leg.
function leg(type, side, strike, lots = 1, days = null) {
  return { type, side, strike, premium: 0, lots, lotSize: 1, days };
}

// --- Payoff of a single leg at expiry, for one underlying price S -----------
// Returns rupee P&L PER UNIT (not yet multiplied by quantity).
function legPayoffPerUnit(leg, S) {
  if (leg.type === 'FUT') {
    // A future's "premium" field is its ENTRY price. It cannot be 0/unset:
    // treating an unset entry as 0 would make the payoff (S - 0) = S and shift
    // the whole diagram by ~spot. Black-Scholes can't price a future, so the
    // caller (or normaliseLegs below) must set this to the spot/future price.
    if (!(leg.premium > 0)) {
      throw new Error('FUT leg has no entry price (premium). Set it to the spot/future price before analysing.');
    }
    // Long profits when price rises above entry; short is the opposite.
    const dir = leg.side === 'BUY' ? 1 : -1;
    return dir * (S - leg.premium);
  }
  // Options: long pays premium up front; short receives it.
  const intrinsic = leg.type === 'CE' ? Math.max(0, S - leg.strike) : Math.max(0, leg.strike - S);
  if (leg.side === 'BUY') return intrinsic - leg.premium;
  return leg.premium - intrinsic;
}

// Default any FUT leg's missing entry price to the current spot, so the payoff
// is never silently shifted by treating the entry as 0. Returns a shallow copy
// (originals untouched). Throws only if we genuinely cannot default (no spot).
function normaliseLegs(legs, spot) {
  return legs.map((lg) => {
    if (lg.type === 'FUT' && !(lg.premium > 0)) {
      if (!(spot > 0)) {
        throw new Error('FUT leg has no entry price and spot is unknown; cannot analyse.');
      }
      return { ...lg, premium: spot };
    }
    return lg;
  });
}

function units(leg) {
  return (leg.lots || 1) * (leg.lotSize || 1);
}

// Total strategy P&L at one underlying price (at expiry, intrinsic).
function totalPayoff(legs, S) {
  let pnl = 0;
  for (const lg of legs) pnl += legPayoffPerUnit(lg, S) * units(lg);
  return pnl;
}

// --- Multi-expiry valuation -------------------------------------------------
// Per-unit P&L of a leg when the underlying is S at the ANALYSIS HORIZON
// (`horizon` days from now = the nearest leg's expiry). A leg expiring AT the
// horizon is worth its intrinsic value; a leg expiring LATER still has time
// value, so it is priced with Black-Scholes for the remaining time (this is what
// makes calendar/diagonal payoffs correct — the far leg isn't intrinsic yet).
function legValueAtHorizon(leg, S, horizon, r, defaultDays) {
  if (leg.type === 'FUT') {
    return (leg.side === 'BUY' ? 1 : -1) * (S - leg.premium);
  }
  const legDays = leg.days != null ? leg.days : defaultDays;
  const remaining = (legDays - horizon) / 365;
  let value;
  if (remaining <= 1e-9) {
    value = leg.type === 'CE' ? Math.max(0, S - leg.strike) : Math.max(0, leg.strike - S);
  } else {
    // The still-alive leg needs an IV to value its remaining time. Don't assume
    // one silently (same principle as netGreeks) — the UI sets it (default 20%).
    if (!Number.isFinite(leg.iv)) {
      throw new Error(`A later-expiring ${leg.type} leg needs an IV% to value its remaining time.`);
    }
    value = bsPrice(leg.type, S, leg.strike, remaining, r, leg.iv / 100);
  }
  return (leg.side === 'BUY' ? 1 : -1) * (value - leg.premium);
}

function totalPayoffAtHorizon(legs, S, horizon, r, defaultDays) {
  let pnl = 0;
  for (const lg of legs) pnl += legValueAtHorizon(lg, S, horizon, r, defaultDays) * units(lg);
  return pnl;
}

// Slope of the total payoff as S -> 0+ (below every strike). Puts and futures
// keep a slope down there; calls go flat. Used only to decide how far down the
// CHART window should reach so the true max-loss point isn't off-screen.
function leftTailSlope(legs) {
  let slope = 0;
  for (const lg of legs) {
    const u = units(lg);
    if (lg.type === 'PE') slope += (lg.side === 'BUY' ? -1 : 1) * u;
    else if (lg.type === 'FUT') slope += (lg.side === 'BUY' ? 1 : -1) * u;
    // CE contributes 0 as S -> 0
  }
  return slope;
}

// --- Build a payoff curve for the CHART -------------------------------------
// This is a DISPLAY SKETCH only: it is centred on the spot for readability.
// The authoritative numbers (max profit/loss, breakevens) come from analyse(),
// which evaluates the exact breakpoints over the full domain [0, far]. We do
// extend the window down to 0 when a leg makes the payoff slope as S -> 0 (any
// put or future), so the chart still shows that downside instead of stopping
// short of the true max-loss point.
function buildCurve(legs, spot, pnlAt) {
  const strikes = legs.filter((l) => l.type !== 'FUT').map((l) => l.strike);
  const reachesZero = Math.abs(leftTailSlope(legs)) > 1e-9;
  const lo = reachesZero ? 0 : Math.min(spot * 0.7, ...strikes) * 0.95;
  const hi = Math.max(spot * 1.3, ...strikes) * 1.05;
  const points = 240;
  const curve = [];
  for (let i = 0; i <= points; i++) {
    const s = lo + ((hi - lo) * i) / points;
    curve.push({ s, pnl: pnlAt(s) });
  }
  return curve;
}

// Dense sampling of a SMOOTH payoff (multi-expiry, Black-Scholes-priced legs),
// for max/min and breakevens — the curve is humped, not piecewise-linear, so the
// exact-breakpoint method doesn't apply.
function sampleExtremes(pnlAt, far, strikes = []) {
  // Sample on a uniform grid PLUS each strike: a same-strike calendar peaks
  // exactly at the strike and a diagonal near the short strike, so a plain grid
  // (whose step scales with `far` ~ 3·spot) would step over that sharp peak and
  // badly understate max profit/loss. Then refine locally around the extremum.
  const n = 600;
  // Start the grid just ABOVE 0: at exactly S=0, bsPrice's `S<=0` guard returns
  // full intrinsic for a still-alive (later-expiring) leg, which is DISCONTINUOUS
  // from its Black-Scholes right-limit — that spurious S=0 spike would fabricate a
  // fake breakeven and overstate the headline max profit/loss. Sampling from a
  // tiny epsilon uses the continuous limit instead.
  const lo0 = far * 1e-6;
  const xs = [];
  for (let i = 0; i <= n; i++) xs.push(lo0 + ((far - lo0) * i) / n);
  for (const k of strikes) if (k > lo0 && k < far) xs.push(k);
  xs.sort((a, b) => a - b);

  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  let argMax = xs[0];
  let argMin = xs[0];
  const breakevens = [];
  const addBe = (x) => {
    const r = +x.toFixed(2);
    if (!breakevens.some((v) => Math.abs(v - r) < 1e-6)) breakevens.push(r);
  };
  let prevX = xs[0];
  let prevV = pnlAt(prevX);
  maxProfit = prevV;
  maxLoss = prevV;
  for (let i = 1; i < xs.length; i++) {
    const x = xs[i];
    const v = pnlAt(x);
    if (v > maxProfit) {
      maxProfit = v;
      argMax = x;
    }
    if (v < maxLoss) {
      maxLoss = v;
      argMin = x;
    }
    // Count a sign change only when the payoff crosses CLEANLY through 0 (a tiny
    // deadband). A Black-Scholes-priced multi-expiry payoff can sit at ~1e-14 float
    // noise oscillating around 0 in a flat deep tail (every leg ~worthless, premiums
    // net to ~0); a raw sign test there fabricates fake breakevens. Genuine breakevens
    // swing through values far larger than 1e-6 rupees, so they are still detected.
    // (Mirrors exactBreakevens' 1e-9 sign deadband on the single-expiry path.)
    if ((prevV < -1e-6 && v > 1e-6) || (prevV > 1e-6 && v < -1e-6)) addBe(prevX + ((x - prevX) * (0 - prevV)) / (v - prevV));
    prevX = x;
    prevV = v;
  }

  // The curve is smooth, so ternary-search the small window around the best/worst
  // grid node to pin the true extremum to a fraction of a paisa.
  const step = far / n;
  const refine = (x0, dir) => {
    let lo = Math.max(far * 1e-6, x0 - step);
    let hi = x0 + step;
    for (let it = 0; it < 60; it++) {
      const m1 = lo + (hi - lo) / 3;
      const m2 = hi - (hi - lo) / 3;
      if (dir * pnlAt(m1) < dir * pnlAt(m2)) lo = m1;
      else hi = m2;
    }
    return pnlAt((lo + hi) / 2);
  };
  maxProfit = Math.max(maxProfit, refine(argMax, 1));
  maxLoss = Math.min(maxLoss, refine(argMin, -1));
  return { maxProfit, maxLoss, breakevens };
}

// Exact breakevens for a piecewise-linear (single-expiry) payoff: sign changes
// within a segment, plus genuine sign-flips landing exactly on an interior kink.
function exactBreakevens(points, pnlAt) {
  const breakevens = [];
  const addBe = (x) => {
    const r = +x.toFixed(2);
    if (!breakevens.some((v) => Math.abs(v - r) < 1e-6)) breakevens.push(r);
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const va = pnlAt(a);
    const vb = pnlAt(b);
    if ((va < 0 && vb > 0) || (va > 0 && vb < 0)) addBe(a + ((b - a) * (0 - va)) / (vb - va));
  }
  const sgn = (v) => (v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0);
  for (let i = 1; i < points.length - 1; i++) {
    if (Math.abs(pnlAt(points[i])) > 1e-9) continue;
    const left = sgn(pnlAt((points[i - 1] + points[i]) / 2));
    const right = sgn(pnlAt((points[i] + points[i + 1]) / 2));
    if (left !== 0 && right !== 0 && left !== right) addBe(points[i]);
  }
  return breakevens;
}

// Slope of the total payoff as the underlying S -> +infinity, in signed units.
// Only CALLS and FUTURES keep a slope out there (puts go flat once past the
// strike), so this alone decides whether profit/loss is unbounded. The left
// side (S -> 0) can NEVER be unbounded: S is floored at zero, so the payoff
// reaches a finite value at S = 0. (This is why a short put is bounded.)
function rightTailSlope(legs) {
  let slope = 0;
  for (const lg of legs) {
    const signedUnits = units(lg) * (lg.side === 'BUY' ? 1 : -1);
    if (lg.type === 'CE' || lg.type === 'FUT') slope += signedUnits; // each adds slope +1
    // PE contributes 0 as S -> infinity
  }
  return slope;
}

// Analyse the whole strategy EXACTLY. The expiry payoff is piecewise-linear
// with kinks only at the strikes, so every extreme value and every breakeven
// lies at a strike, at S = 0, or out in the right tail. We evaluate at those
// breakpoints instead of trusting a sampling window — the old window started
// above S = 0 (truncating the true max loss) and judged "unbounded" from the
// window edge (mislabelling bounded positions like short puts).
function analyse(legs, spot, opts = {}) {
  const r = opts.riskFreeRate != null ? opts.riskFreeRate : 0.065;
  const defaultDays = opts.days != null ? opts.days : 7;
  // Default any FUT leg's entry price to spot first, so a future is never
  // priced as if entered at 0 (which would shift the whole payoff by ~spot).
  const norm = normaliseLegs(legs, spot);

  // The analysis HORIZON is the nearest leg expiry; legs expiring later keep
  // their time value (priced via Black-Scholes). When every option leg shares
  // one expiry this is a plain at-expiry, piecewise-linear payoff.
  const legDays = (l) => (l.days != null ? l.days : defaultDays);
  const optDays = norm.filter((l) => l.type !== 'FUT').map(legDays);
  const horizon = optDays.length ? Math.min(...optDays) : defaultDays;
  const multiExpiry = new Set(optDays).size > 1;
  const pnlAt = (S) => totalPayoffAtHorizon(norm, S, horizon, r, defaultDays);

  const curve = buildCurve(norm, spot, pnlAt); // sampled curve, used only for the chart

  const strikes = norm.filter((l) => l.type !== 'FUT').map((l) => l.strike);
  const far = Math.max(spot, ...(strikes.length ? strikes : [spot])) * 3 + 10;
  const points = [...new Set([0, spot, far, ...strikes])].filter((x) => x >= 0).sort((a, b) => a - b);

  // Zero-leg or identically-zero payoff: nothing to analyse, no breakevens.
  const isZeroEverywhere = points.every((p) => Math.abs(pnlAt(p)) < 1e-9);
  if (norm.length === 0 || isZeroEverywhere) {
    return { curve, breakevens: [], maxProfit: 0, maxLoss: 0, unboundedProfit: false, unboundedLoss: false };
  }

  // Unboundedness depends only on the asymptotic delta of the legs (±1 per call/
  // future as S→∞; S floored at 0 on the left), independent of expiry.
  const slope = rightTailSlope(norm);
  const unboundedProfit = slope > 1e-9;
  const unboundedLoss = slope < -1e-9;

  let maxProfit;
  let maxLoss;
  let breakevens;
  if (multiExpiry) {
    // Smooth, Black-Scholes-priced curve -> dense sampling over [0, far],
    // anchored at the strikes so a sharp peak isn't missed.
    const res = sampleExtremes(pnlAt, far, strikes);
    maxProfit = res.maxProfit;
    maxLoss = res.maxLoss;
    breakevens = res.breakevens;
  } else {
    // At-expiry, piecewise-linear -> exact breakpoints (the proven path).
    maxProfit = -Infinity;
    maxLoss = Infinity;
    for (const s of points) {
      const pnl = pnlAt(s);
      if (pnl > maxProfit) maxProfit = pnl;
      if (pnl < maxLoss) maxLoss = pnl;
    }
    breakevens = exactBreakevens(points, pnlAt);
  }

  return {
    curve,
    breakevens,
    maxProfit: unboundedProfit ? Infinity : maxProfit,
    maxLoss: unboundedLoss ? -Infinity : maxLoss,
    unboundedProfit,
    unboundedLoss,
  };
}

// Net Greeks of the whole strategy at the current spot (sum of per-leg Greeks
// times signed quantity). Needs time-to-expiry, rate and per-leg vol.
function netGreeks(legs, spot, T, r) {
  const totals = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const lg of legs) {
    if (lg.type === 'FUT') {
      // A future behaves like delta = +/- 1 per unit, no other Greeks.
      totals.delta += (lg.side === 'BUY' ? 1 : -1) * units(lg);
      continue;
    }
    // The Greeks MUST use the same vol that priced this leg's premium. Never
    // silently assume 20% — that would make the Greeks describe a different
    // option than the one the payoff/premium represents.
    if (!Number.isFinite(lg.iv)) {
      throw new Error(`netGreeks: option leg (${lg.side} ${lg.type} ${lg.strike}) has no IV set; refusing to assume a default vol.`);
    }
    const vol = lg.iv / 100;
    // Each leg is priced at ITS OWN time-to-expiry, so a calendar/diagonal's
    // near and far legs get the right (different) Greeks. Single-expiry legs
    // (no per-leg days) all use the passed T.
    const legT = lg.days != null ? lg.days / 365 : T;
    const g = greeks(lg.type, spot, lg.strike, legT, r, vol);
    const sign = lg.side === 'BUY' ? 1 : -1;
    const q = units(lg) * sign;
    totals.delta += g.delta * q;
    totals.gamma += g.gamma * q;
    totals.theta += g.theta * q;
    totals.vega += g.vega * q;
  }
  return totals;
}

export { TEMPLATES, totalPayoff, analyse, netGreeks, legPayoffPerUnit, legValueAtHorizon, totalPayoffAtHorizon, units, atm, bsPrice };
