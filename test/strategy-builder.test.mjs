// ---------------------------------------------------------------------------
// test/strategy-builder.test.mjs
// Tests for the option strategy builder's maths (core/strategies.js), focused
// on the four silent-wrong-number traps:
//   1. a FUT leg priced as if entered at 0 (shifts the whole payoff by ~spot)
//   2. Greeks computed with a different vol than the one that priced the leg
//   3. the chart window not reaching a position's true max-loss at S -> 0
//   4. spurious breakevens for a zero-leg / identically-zero payoff
//
// Run with:  node --test
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, netGreeks, legPayoffPerUnit, totalPayoff, TEMPLATES } from '../public/js/core/strategies.js';
import { bsPrice, greeks } from '../public/js/core/options.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ===========================================================================
// 1. Covered call: long future + short OTM call.
// ===========================================================================
test('covered call max profit is (callStrike - spot + premium) * lot, NOT shifted by spot', () => {
  const spot = 23500;
  const lot = 75;
  const callPrem = 120;
  // Template build => [ FUT BUY (premium 0), CE SELL atm+step ]. The UI sets
  // the FUT entry to spot; replicate that, and price the short call premium.
  const built = TEMPLATES.covered_call.build(spot, 50);
  const callStrike = built.find((l) => l.type === 'CE').strike; // 23550
  const legs = built.map((l) => ({
    ...l,
    lots: 1,
    lotSize: lot,
    premium: l.type === 'FUT' ? spot : callPrem,
    iv: l.type === 'FUT' ? 0 : 15,
  }));

  const a = analyse(legs, spot);
  const expectedMax = (callStrike - spot + callPrem) * lot; // (23550-23500+120)*75 = 12750
  assert.ok(close(a.maxProfit, expectedMax, 1), `max profit ${a.maxProfit} vs ${expectedMax}`);
  // The buggy "entry = 0" would give (callStrike + premium)*lot ~ 1.78e6.
  assert.ok(a.maxProfit < (callStrike + callPrem) * lot - spot * lot * 0.5, 'max profit must not be shifted up by ~spot');
  assert.equal(a.unboundedProfit, false);
  assert.equal(a.unboundedLoss, false, 'covered-call downside is large but bounded (capped at S=0)');
  // Max loss is at S -> 0: long future loses ~spot, short call keeps premium.
  assert.ok(close(a.maxLoss, (callPrem - spot) * lot, 1), `max loss ${a.maxLoss}`);
  assert.ok(Number.isFinite(a.maxLoss));
});

test('a FUT leg with premium 0/unset is never silently treated as entry 0', () => {
  // legPayoffPerUnit must refuse a future with no entry price.
  assert.throws(() => legPayoffPerUnit({ type: 'FUT', side: 'BUY', premium: 0 }, 100), /entry price/);
  assert.throws(() => legPayoffPerUnit({ type: 'FUT', side: 'BUY' }, 100), /entry price/);
  // totalPayoff propagates the guard.
  assert.throws(() => totalPayoff([{ type: 'FUT', side: 'BUY', premium: 0, lots: 1, lotSize: 1 }], 100), /entry price/);

  // analyse() instead DEFAULTS the future's entry to spot (it knows spot), so
  // the result matches an explicitly-priced future and is not shifted.
  const spot = 23500;
  const built = TEMPLATES.covered_call.build(spot, 50);
  const rawZero = built.map((l) => ({ ...l, lots: 1, lotSize: 75, premium: l.type === 'FUT' ? 0 : 120, iv: l.type === 'FUT' ? 0 : 15 }));
  const explicit = built.map((l) => ({ ...l, lots: 1, lotSize: 75, premium: l.type === 'FUT' ? spot : 120, iv: l.type === 'FUT' ? 0 : 15 }));
  const aZero = analyse(rawZero, spot);
  const aExplicit = analyse(explicit, spot);
  assert.ok(close(aZero.maxProfit, aExplicit.maxProfit, 1), 'defaulted future must match an explicitly-priced one');
  assert.ok(close(aZero.maxLoss, aExplicit.maxLoss, 1));

  // And if spot is unknown, it must error rather than default to 0.
  assert.throws(() => analyse([{ type: 'FUT', side: 'BUY', premium: 0, lots: 1, lotSize: 1 }], 0), /spot is unknown/);
});

// ===========================================================================
// 2. netGreeks uses each leg's own iv (consistent with its premium), no 20%.
// ===========================================================================
test('netGreeks uses the leg IV that priced the premium, not a 20% default', () => {
  const spot = 23500;
  const K = 23500;
  const T = 7 / 365;
  const r = 0.065;
  const v = 0.18; // 18% — deliberately not the old 20% default
  const premium = bsPrice('CE', spot, K, T, r, v);
  const lot = 75;
  const leg = { type: 'CE', side: 'SELL', strike: K, premium, iv: v * 100, lots: 1, lotSize: lot };

  // Premium and the IV used for Greeks describe the SAME option.
  assert.ok(close(bsPrice('CE', spot, K, T, r, leg.iv / 100), leg.premium, 1e-6), 'premium must match its IV');

  const ng = netGreeks([leg], spot, T, r);
  const g = greeks('CE', spot, K, T, r, v); // expected per-unit, at the SAME 18%
  const q = -lot; // short 1 lot
  assert.ok(close(ng.delta, g.delta * q, 1e-6), `delta ${ng.delta} vs ${g.delta * q}`);
  assert.ok(close(ng.gamma, g.gamma * q, 1e-6), `gamma ${ng.gamma}`);
  assert.ok(close(ng.theta, g.theta * q, 1e-6), `theta ${ng.theta}`);
  assert.ok(close(ng.vega, g.vega * q, 1e-6), `vega ${ng.vega}`);

  // Sanity: assuming 20% would give a different delta, so the test is meaningful.
  const g20 = greeks('CE', spot, K, T, r, 0.2);
  assert.ok(Math.abs(g.delta - g20.delta) > 1e-4, 'the 18% vs 20% delta must actually differ');
});

test('netGreeks refuses an option leg with no IV (no silent default)', () => {
  const leg = { type: 'CE', side: 'BUY', strike: 23500, premium: 150, lots: 1, lotSize: 75 }; // iv missing
  assert.throws(() => netGreeks([leg], 23500, 7 / 365, 0.065), /IV/);
});

test('netGreeks sums each leg with ITS OWN vol (two legs, two IVs)', () => {
  const spot = 23500;
  const T = 30 / 365;
  const r = 0.065;
  const a = { type: 'CE', side: 'BUY', strike: 23500, premium: 1, iv: 12, lots: 1, lotSize: 1 };
  const b = { type: 'PE', side: 'BUY', strike: 23500, premium: 1, iv: 25, lots: 1, lotSize: 1 };
  const ng = netGreeks([a, b], spot, T, r);
  const ga = greeks('CE', spot, 23500, T, r, 0.12);
  const gb = greeks('PE', spot, 23500, T, r, 0.25);
  assert.ok(close(ng.vega, ga.vega + gb.vega, 1e-6), 'vega must use 12% and 25% respectively');
  assert.ok(close(ng.delta, ga.delta + gb.delta, 1e-6));
});

// ===========================================================================
// 3. Chart window reaches the true max-loss point (S -> 0) when relevant.
// ===========================================================================
test('chart window extends to 0 for put/future legs, stays centred for call spreads', () => {
  // Long put: max profit is at S -> 0, so the window must reach down there.
  const putCurve = analyse([{ type: 'PE', side: 'BUY', strike: 23500, premium: 200, iv: 18, lots: 1, lotSize: 75 }], 23500).curve;
  assert.ok(putCurve[0].s <= 1, `put chart should reach ~0, lowest s = ${putCurve[0].s}`);

  // Long future: downside max-loss at S -> 0; window must reach down.
  const futCurve = analyse([{ type: 'FUT', side: 'BUY', premium: 23500, lots: 1, lotSize: 75 }], 23500).curve;
  assert.ok(futCurve[0].s <= 1, `future chart should reach ~0, lowest s = ${futCurve[0].s}`);

  // Bull call spread (calls only, flat as S -> 0): keep the readable centred window.
  const bcsCurve = analyse(
    [
      { type: 'CE', side: 'BUY', strike: 23500, premium: 200, iv: 18, lots: 1, lotSize: 75 },
      { type: 'CE', side: 'SELL', strike: 23700, premium: 120, iv: 18, lots: 1, lotSize: 75 },
    ],
    23500
  ).curve;
  assert.ok(bcsCurve[0].s > 1000, `call-spread chart should stay centred (not jump to 0), lowest s = ${bcsCurve[0].s}`);
});

// ===========================================================================
// 4. Zero-leg / identically-zero payoff produces NO spurious breakevens.
// ===========================================================================
test('analyse of an empty book yields no breakevens and zero P&L', () => {
  const a = analyse([], 23500);
  assert.deepEqual(a.breakevens, []);
  assert.equal(a.maxProfit, 0);
  assert.equal(a.maxLoss, 0);
  assert.equal(a.unboundedProfit, false);
  assert.equal(a.unboundedLoss, false);
});

test('analyse of a perfectly offsetting (identically-zero) book yields no breakevens', () => {
  // Long call and short identical call at the same premium => payoff 0 for all S.
  const legs = [
    { type: 'CE', side: 'BUY', strike: 100, premium: 5, iv: 20, lots: 1, lotSize: 1 },
    { type: 'CE', side: 'SELL', strike: 100, premium: 5, iv: 20, lots: 1, lotSize: 1 },
  ];
  const a = analyse(legs, 100);
  assert.deepEqual(a.breakevens, [], `expected no breakevens, got ${JSON.stringify(a.breakevens)}`);
  assert.equal(a.maxProfit, 0);
  assert.equal(a.maxLoss, 0);
});
