// ---------------------------------------------------------------------------
// test/hedge.test.mjs
// Locks backtest/hedge.mjs — Hull's delta-hedging simulation — three ways:
//   1. against the FRAGMENTS of RMFI Table 8.2 that are printed (week 0 and
//      week 1 of the 100,000-call example), exactly;
//   2. against the INVARIANT Hull states in words: with fine enough rebalancing
//      the discounted cost of the hedge equals the Black–Scholes price on every
//      path, and the spread of outcomes shrinks as rebalancing gets finer;
//   3. against the SIGN RULE that makes a hedged seller's P&L meaningful: it
//      profits when realised volatility is below the volatility it sold, and
//      loses when realised is above.
// The full 20-week table is not in the sources available here, which is why the
// invariant and the sign rule — mathematical properties, not re-typed numbers —
// carry most of the weight. Pure + offline; every path is seeded.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateDeltaHedge, nakedSellerPnl, gbmPath, bookDelta } from '../backtest/hedge.mjs';

const near = (got, want, tol, msg) => assert.ok(Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want} ± ${tol}`);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1)); };

// Hull's example: 100,000 calls sold, S₀ = 49, K = 50, r = 5%, σ = 20%, 20 weeks [RMFI p.185]
const HULL = { legs: { type: 'CE', K: 50, units: 100000 }, T: 20 / 52, r: 0.05, sigma: 0.20, lot: 100 };

test('week 0 of RMFI Table 8.2: the premium is $240,000 and the hedge buys 52,200 shares for $2,557,800', () => {
  // A one-period path is enough to read the t=0 numbers off the trade table.
  const res = simulateDeltaHedge({ ...HULL, path: [49, 49] });
  near(res.premium, 240000, 500, 'the BS price of 100,000 calls is $240,000');
  const w0 = res.trades[0];
  assert.equal(w0.held, 52200, 'delta 0.522 → 52,200 shares (rounded to hundreds, as Hull does)');
  near(w0.value, 2557800, 1, 'cost of the shares = 52,200 × $49');
  // One week's interest on that at 5%: 2,557,800 × 0.05/52 ≈ $2,459 — Hull prints $2,500 (rounded)
  near(2557800 * 0.05 / 52, 2459, 1, 'the interest line');
});

test('week 1 of RMFI Table 8.2: the stock falls to $48.12, delta drops to 0.458, 6,400 shares are sold for ≈ $308,000', () => {
  // TWENTY weekly periods (21 points) so that period 1 really is "week 1 of 20" with 19 weeks
  // left — a 3-point path over the same T would have made each period ten weeks long. Only
  // the first two points matter for the week-1 line; the rest just complete the path.
  const path = [49, 48.12, ...Array(19).fill(48.12)];
  const res = simulateDeltaHedge({ ...HULL, path, T: 20 / 52 });
  const w1 = res.trades[1];
  // The trade table carries the BOOK delta (per-share delta × 100,000 units).
  near(w1.delta / 100000, 0.458, 0.0015, 'delta at week 1 (T = 19/52 remaining)');
  assert.equal(w1.held, 45800, 'holding rounds to 45,800');
  assert.equal(w1.traded, -6400, 'so 6,400 shares are sold');
  near(-w1.value, 307968, 1, '6,400 × $48.12 = $307,968 (Hull prints $308,000)');
  // Cumulative cost after week 1 = 2,557,800 + 2,459 − 307,968 = 2,252,291 (Hull prints 2,252,300)
  near(w1.cumCost, 2252291, 5, 'the cumulative-cost line');
});

test('the direction of the rebalancing is Hull’s "buy high, sell low"', () => {
  // Up move → delta rises → BUY more (after the rise). Down move → delta falls → SELL (after the fall).
  const up = simulateDeltaHedge({ ...HULL, path: [49, 51, 51] });
  const down = simulateDeltaHedge({ ...HULL, path: [49, 47, 47] });
  assert.ok(up.trades[1].traded > 0, 'bought after the price rose');
  assert.ok(down.trades[1].traded < 0, 'sold after the price fell');
});

test('INVARIANT: with fine rebalancing the discounted hedge cost converges on the Black–Scholes price, and the spread shrinks', () => {
  // Paths generated at EXACTLY the volatility the option was priced with (σ = 20%),
  // drift = r, so the only source of variation is the discreteness of the hedge.
  const PATHS = 80;
  const run = (n) => {
    const pnls = [];
    for (let s = 1; s <= PATHS; s++) {
      const path = gbmPath({ S0: 49, mu: 0.05, sigma: 0.20, T: 20 / 52, n, seed: 1000 + s });
      const r = simulateDeltaHedge({ ...HULL, lot: 1, path });
      pnls.push(r.pnl / r.premium); // P&L as a fraction of the premium: 0 = perfect hedge
    }
    return { mean: mean(pnls), sd: sd(pnls) };
  };
  const weekly = run(20);
  const daily = run(140);
  const fine = run(1000);
  // Hull: "the cost of hedging would, after discounting, be exactly equal to the BSM price"
  // with perfect rebalancing — so the mean P&L is ~0 and the dispersion falls with frequency.
  near(fine.mean, 0, 0.03, 'fine rebalancing: mean P&L ≈ 0 (within 3% of the premium)');
  assert.ok(daily.sd < weekly.sd, `daily dispersion (${daily.sd.toFixed(3)}) < weekly (${weekly.sd.toFixed(3)})`);
  assert.ok(fine.sd < daily.sd, `1000-step dispersion (${fine.sd.toFixed(3)}) < daily (${daily.sd.toFixed(3)})`);
  // The textbook's own two paths cost $263,300 and $256,600 against $240,000 — i.e. within ~10%
  // of the premium at WEEKLY rebalancing. The weekly dispersion here should be of that order.
  assert.ok(weekly.sd > 0.03 && weekly.sd < 0.35, `weekly dispersion is a real but bounded fraction of the premium (${weekly.sd.toFixed(3)})`);
});

test('SIGN RULE: a hedged seller profits when realised vol is below the vol sold, and loses when above', () => {
  const PATHS = 80;
  const avgPnl = (sigmaReal) => {
    const pnls = [];
    for (let s = 1; s <= PATHS; s++) {
      const path = gbmPath({ S0: 49, mu: 0.05, sigma: sigmaReal, T: 20 / 52, n: 140, seed: 5000 + s });
      pnls.push(simulateDeltaHedge({ ...HULL, lot: 1, path }).pnl / 240000);
    }
    return mean(pnls);
  };
  const calm = avgPnl(0.10);   // realised 10% vs 20% sold
  const wild = avgPnl(0.35);   // realised 35% vs 20% sold
  assert.ok(calm > 0.15, `calm markets: the seller keeps most of the premium (mean P&L ${calm.toFixed(3)} of premium)`);
  assert.ok(wild < -0.15, `wild markets: the seller loses more than the premium (mean P&L ${wild.toFixed(3)} of premium)`);
  // The naked seller on the same wild paths is FAR worse in the tail than the hedged one:
  // the hedge converts an unbounded payoff into a vol bet.
  let worstNaked = 0, worstHedged = 0;
  for (let s = 1; s <= PATHS; s++) {
    const path = gbmPath({ S0: 49, mu: 0.05, sigma: 0.35, T: 20 / 52, n: 140, seed: 5000 + s });
    worstNaked = Math.min(worstNaked, nakedSellerPnl({ ...HULL, path }).pnl);
    worstHedged = Math.min(worstHedged, simulateDeltaHedge({ ...HULL, lot: 1, path }).pnl);
  }
  assert.ok(worstHedged > worstNaked, `the hedged seller’s worst path (${worstHedged}) beats the naked seller’s (${worstNaked})`);
});

test('costs: charging every hedge trade raises the hedge cost monotonically, and a straddle hedges as one book', () => {
  const path = gbmPath({ S0: 49, mu: 0.05, sigma: 0.20, T: 20 / 52, n: 140, seed: 42 });
  const free = simulateDeltaHedge({ ...HULL, lot: 1, path, costRate: 0 });
  const c2 = simulateDeltaHedge({ ...HULL, lot: 1, path, costRate: 0.0002 });
  const c5 = simulateDeltaHedge({ ...HULL, lot: 1, path, costRate: 0.0005 });
  assert.ok(free.hedgeCost < c2.hedgeCost && c2.hedgeCost < c5.hedgeCost, 'more cost per trade → higher hedge cost');
  assert.equal(free.tradingCosts, 0);
  assert.ok(c5.tradingCosts > c2.tradingCosts && c2.tradingCosts > 0);
  // A short ATM straddle's delta is the SUM of its legs' — and with r > 0 it is NOT zero:
  // at S = K = 49, r = 5%, T = 20/52, σ = 20% the call's delta is ≈ 0.586 and the put's
  // ≈ −0.414, so the book carries ≈ +0.17 per unit. Lock the sum against the legs computed
  // independently, and that it is far smaller than either leg alone.
  const straddle = [{ type: 'CE', K: 49, units: 100 }, { type: 'PE', K: 49, units: 100 }];
  const d = bookDelta(straddle, 49, 20 / 52, 0.05, 0.20);
  const dCall = bookDelta([straddle[0]], 49, 20 / 52, 0.05, 0.20);
  const dPut = bookDelta([straddle[1]], 49, 20 / 52, 0.05, 0.20);
  near(d, dCall + dPut, 1e-9, 'the book delta is the sum of the legs');
  near(dCall / 100, 0.586, 0.005, 'the call leg’s delta');
  near(dPut / 100, -0.414, 0.005, 'the put leg’s delta');
  assert.ok(Math.abs(d) < Math.abs(dCall) / 2, `the straddle’s net delta (${d.toFixed(2)}) is well under half a leg’s`);
  const st = simulateDeltaHedge({ legs: straddle, path, T: 20 / 52, r: 0.05, sigma: 0.20 });
  assert.ok(st.premium > 0 && Number.isFinite(st.pnl), 'a multi-leg book simulates');
});

test('guards: a degenerate path or life is refused, never silently mis-simulated', () => {
  assert.throws(() => simulateDeltaHedge({ ...HULL, path: [49] }), /≥ 2 points/);
  assert.throws(() => simulateDeltaHedge({ ...HULL, path: [49, 50], T: 0 }), /T > 0/);
});
