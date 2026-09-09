// ---------------------------------------------------------------------------
// backtest/hedge.mjs
// DELTA HEDGING of a short option book — Hull's simulation (RMFI Table 8.2 /
// OFOD §19.4) as a pure, testable function, plus a seeded path generator for
// the convergence experiments.
//
// WHY. The option-selling bots on the board are NAKED: they sell premium and
// hold nothing against it, so their P&L mixes two different questions — "was
// there a volatility premium?" and "did the market happen not to crash?". The
// textbook's point is that neither a naked nor a covered position is a hedge;
// the hedge is to hold delta × N units of the underlying and REBALANCE as delta
// moves [OFOD p.420]. A hedged seller's P&L is then (implied − realised)
// volatility, minus what the rebalancing costs — which isolates the premium
// question and makes the F&O honesty check (volPremium 1.2 vs 1.0) concrete.
//
// THE MECHANICS, exactly as Hull tabulates them [RMFI p.185–188]:
//   * at each rebalance point hold  delta × units  of the underlying (for a
//     SHORT option position: buy delta×N against short calls; sell |delta|×N
//     against short puts);
//   * the cumulative cost of the hedge earns interest at r per period
//     (2,557,800 × 0.05/52 ≈ 2,459 in week 1 of his table);
//   * at expiry, an exercised short CALL delivers the shares at K (cost − K×N);
//     an assigned short PUT buys them at K (cost + K×N); out of the money the
//     shares have been sold down to zero and the cost is what the rebalancing
//     lost — "a buy-high, sell-low trading strategy";
//   * "if the hedging scheme worked perfectly, the cost of hedging would, after
//     discounting, be exactly equal to the Black–Scholes–Merton price for every
//     simulated stock price path. The reason for the variation ... is that the
//     hedge is rebalanced only once a week." [RMFI p.188]
// That last sentence is a testable invariant and the test file locks it: cost
// converges on the BS price as the rebalance interval shrinks.
//
// COSTS. `costRate` charges a fraction of every hedge trade's value (crossing
// the spread + the statutory schedule on the hedge instrument). It is a
// parameter, not a claimed schedule: the study runs a sensitivity and states
// the assumption, because no sourced index-FUTURES cost schedule lives in this
// repo and a re-typed magic number is how a 10x cost error once shipped.
//
// Pure: no engine, no clock, no network. Reuses the app's own bsPrice/greeks.
// ---------------------------------------------------------------------------

import { bsPrice, greeks } from '../public/js/core/options.js';

// A leg of the SHORT book: { type: 'CE'|'PE', K, units }. `units` is the number of
// option units sold (lots × lot size). Every leg shares the same expiry.
const normaliseLegs = (legs) => legs.map((l) => ({ type: l.type, K: l.K, units: l.units }));

// Black-Scholes value of the whole short book per unit-of-spot at time-to-expiry T.
function bookValue(legs, S, T, r, sigma) {
  return legs.reduce((s, l) => s + l.units * bsPrice(l.type, S, l.K, T, r, sigma), 0);
}
// The book's delta (what the hedge must hold, in units of the underlying).
function bookDelta(legs, S, T, r, sigma) {
  return legs.reduce((s, l) => s + l.units * greeks(l.type, S, l.K, T, r, sigma).delta, 0);
}
// Intrinsic value the short book owes at expiry.
function bookIntrinsic(legs, S) {
  return legs.reduce((s, l) => s + l.units * (l.type === 'CE' ? Math.max(0, S - l.K) : Math.max(0, l.K - S)), 0);
}

// simulateDeltaHedge — run Hull's procedure over one price path.
//   legs           the SHORT option book (see above); a single { type, K, units } is accepted too
//   path           spot prices at the rebalance points, path[0] at t = 0 and path[n] at EXPIRY
//   T              life of the options in YEARS (the path spans it evenly)
//   r              continuously-compounded rate used for pricing; simple interest per period on the hedge cost
//   sigma          the volatility the hedge (and the premium) is computed with — the IMPLIED vol
//   lot            round the hedge holding to a multiple of this (Hull rounds to hundreds; 1 = exact)
//   costRate       fraction of each hedge trade's value charged as cost (0 = frictionless, Hull's table)
//   rebalanceEvery rebalance only every k path points (1 = every point)
// Returns Hull's numbers: the premium received (BS value at t=0), the cost of hedging (his
// "cumulative cost including interest", adjusted for exercise), that cost discounted to t=0,
// and the seller's P&L = premium − discounted cost. Plus the full trade table.
function simulateDeltaHedge({ legs, path, T, r, sigma, lot = 1, costRate = 0, rebalanceEvery = 1 }) {
  const book = normaliseLegs(Array.isArray(legs) ? legs : [legs]);
  const n = path.length - 1; // number of periods
  if (!(n >= 1) || !(T > 0)) throw new Error('simulateDeltaHedge: need a path of ≥ 2 points and T > 0');
  const dt = T / n;
  const roundTo = (x) => (lot > 1 ? Math.round(x / lot) * lot : x);

  const premium = bookValue(book, path[0], T, r, sigma);
  let held = 0;
  let cum = 0; // cumulative cost of the hedge, including interest and trading costs
  let tradingCosts = 0;
  const trades = [];
  for (let i = 0; i < n; i++) {
    const S = path[i];
    const tLeft = T - i * dt;
    if (i > 0) cum += cum * r * dt; // interest on last period's cumulative cost (Hull: simple, per period)
    if (i % rebalanceEvery === 0) {
      const delta = bookDelta(book, S, tLeft, r, sigma);
      const target = roundTo(delta);
      const traded = target - held;
      const value = traded * S;
      const cost = Math.abs(value) * costRate;
      cum += value + cost;
      tradingCosts += cost;
      held = target;
      trades.push({ i, S: +S.toFixed(4), delta: +delta.toFixed(4), held, traded, value: +value.toFixed(2), cumCost: +cum.toFixed(2) });
    }
  }
  // Expiry.
  const S_T = path[n];
  cum += cum * r * dt; // interest on the final period
  let exercised = false;
  for (const l of book) {
    const itm = l.type === 'CE' ? S_T > l.K : S_T < l.K;
    if (!itm) continue;
    exercised = true;
    // A short call delivers the hedge shares at K (we receive K×units); a short put is
    // assigned — we buy at K (we pay K×units) and the shares cover the short hedge.
    cum += l.type === 'CE' ? -l.K * l.units : l.K * l.units;
  }
  // Whatever hedge position is left after exercise/expiry is unwound at S_T. For a
  // single exercised call, held ≈ units and delivery consumed it; for an expired-worthless
  // option, held ≈ 0. Any residual (rounding, a straddle's mixed delta) is closed here.
  const deliveredUnits = book.reduce((s, l) => {
    const itm = l.type === 'CE' ? S_T > l.K : S_T < l.K;
    return s + (itm ? (l.type === 'CE' ? l.units : -l.units) : 0);
  }, 0);
  const residual = held - deliveredUnits;
  if (residual !== 0) {
    const value = -residual * S_T; // selling a long residual credits cash (negative cost)
    const cost = Math.abs(residual * S_T) * costRate;
    cum += value + cost;
    tradingCosts += cost;
  }
  const hedgeCost = cum;
  const hedgeCostPV = hedgeCost * Math.exp(-r * T);
  return {
    premium: +premium.toFixed(2),
    hedgeCost: +hedgeCost.toFixed(2),
    hedgeCostPV: +hedgeCostPV.toFixed(2),
    pnl: +(premium - hedgeCostPV).toFixed(2),
    intrinsicAtExpiry: +bookIntrinsic(book, S_T).toFixed(2),
    exercised,
    tradingCosts: +tradingCosts.toFixed(2),
    rebalances: trades.length,
    trades,
  };
}

// The NAKED seller on the same path, for comparison: premium received, intrinsic paid at
// expiry, nothing in between. (Interest on the premium is ignored on both sides.)
function nakedSellerPnl({ legs, path, T, r, sigma }) {
  const book = normaliseLegs(Array.isArray(legs) ? legs : [legs]);
  const premium = bookValue(book, path[0], T, r, sigma);
  const intrinsic = bookIntrinsic(book, path[path.length - 1]);
  return { premium: +premium.toFixed(2), intrinsicAtExpiry: +intrinsic.toFixed(2), pnl: +(premium - intrinsic).toFixed(2) };
}

// --- Seeded geometric-Brownian paths, for the convergence experiments -------------
// mulberry32 (the same tiny PRNG the GA uses) + Box–Muller. Deterministic per seed, so a
// test can lock a statistic and a reader can reproduce it.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// One GBM path with n steps over T years: S0, drift mu, REALISED volatility sigma.
function gbmPath({ S0, mu, sigma, T, n, seed }) {
  const rnd = mulberry32(seed);
  const dt = T / n;
  const out = [S0];
  let S = S0;
  for (let i = 0; i < n; i++) {
    const u1 = Math.max(1e-12, rnd());
    const u2 = rnd();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    S *= Math.exp((mu - 0.5 * sigma * sigma) * dt + sigma * Math.sqrt(dt) * z);
    out.push(S);
  }
  return out;
}

export { simulateDeltaHedge, nakedSellerPnl, gbmPath, bookDelta, bookValue, bookIntrinsic, mulberry32 };
