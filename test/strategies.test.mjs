// ---------------------------------------------------------------------------
// test/strategies.test.mjs
// Adversarial tests for the payoff analysis (core/strategies.js). The danger
// area is the UNBOUNDED detection and the max-profit / max-loss numbers: a
// slope-at-window-edge heuristic mislabels bounded positions, and a sampling
// window that doesn't reach S=0 understates the true max loss.
//
// Run with:  node --test
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, TEMPLATES, netGreeks, legValueAtHorizon, totalPayoffAtHorizon, bsPrice } from '../public/js/core/strategies.js';

const leg = (type, side, strike, premium, lots = 1, lotSize = 1) => ({
  type,
  side,
  strike,
  premium,
  lots,
  lotSize,
});

// ===========================================================================
// Unbounded detection: only naked SHORT CALL (or long future short, etc.)
// should be unbounded. Puts are always bounded because S can't go below 0.
// ===========================================================================
test('multi-expiry put calendar has NO spurious breakeven near S=0 (S=0 discontinuity)', () => {
  // A still-alive (later-expiring) leg priced by Black-Scholes used to be valued at
  // full intrinsic at exactly S=0 (bsPrice's S<=0 guard), a discontinuity that
  // fabricated a breakeven near ~75 and could overstate the headline max P&L.
  const legs = [
    { type: 'PE', side: 'SELL', strike: 20200, premium: 101.28, lots: 1, lotSize: 1, days: 10, iv: 26 },
    { type: 'PE', side: 'BUY', strike: 20300, premium: 121.54, lots: 1, lotSize: 1, days: 40, iv: 26 },
  ];
  const a = analyse(legs, 20256, { riskFreeRate: 0.065, days: 10 });
  assert.ok(!a.breakevens.some((b) => b < 1000), `no spurious low-S breakeven, got ${a.breakevens}`);
});

test('multi-expiry diagonal does NOT fabricate breakevens from float noise in a flat deep tail', () => {
  // A call diagonal (short near-dated, long far-dated) whose deep-OTM tail nets to ~0:
  // the short 100 CE has expired worthless (+3) and the long 105 CE is ~worthless (-3).
  // The Black-Scholes-priced multi-expiry payoff there is ~1e-14 float noise oscillating
  // around 0; before the eps deadband, the sign-change detector reported FAKE breakevens
  // (~65) alongside the genuine one (~101).
  const legs = [
    { type: 'CE', side: 'SELL', strike: 100, premium: 3, lots: 1, lotSize: 1, days: 7, iv: 20 },
    { type: 'CE', side: 'BUY', strike: 105, premium: 3, lots: 1, lotSize: 1, days: 37, iv: 20 },
  ];
  const bes = analyse(legs, 100, { days: 7 }).breakevens;
  assert.ok(bes.length >= 1, 'the genuine breakeven is still found');
  assert.ok(bes.every((b) => b > 90), `no spurious deep-tail (noise) breakevens, got ${JSON.stringify(bes)}`);
});

test('short PUT loss is BOUNDED (this is the classic false-unbounded bug)', () => {
  // Short put, strike 100, premium 5, spot 100.
  const a = analyse([leg('PE', 'SELL', 100, 5)], 100);
  assert.equal(a.unboundedLoss, false, 'a short put cannot lose more than strike - premium');
  assert.equal(a.unboundedProfit, false);
  // Max profit is the premium; max loss is (strike - premium) at S -> 0.
  assert.ok(Math.abs(a.maxProfit - 5) < 1e-6, `max profit ${a.maxProfit}`);
  assert.ok(Math.abs(a.maxLoss - -95) < 1e-6, `max loss should be -95 at S=0, got ${a.maxLoss}`);
});

test('short CALL loss is UNBOUNDED; long CALL profit is unbounded', () => {
  const sc = analyse([leg('CE', 'SELL', 100, 5)], 100);
  assert.equal(sc.unboundedLoss, true, 'short call has unbounded loss as S -> infinity');
  assert.equal(sc.unboundedProfit, false);
  assert.equal(sc.maxLoss, -Infinity);
  assert.ok(Math.abs(sc.maxProfit - 5) < 1e-6);

  const lc = analyse([leg('CE', 'BUY', 100, 5)], 100);
  assert.equal(lc.unboundedProfit, true);
  assert.equal(lc.unboundedLoss, false);
  assert.equal(lc.maxProfit, Infinity);
  assert.ok(Math.abs(lc.maxLoss - -5) < 1e-6, `long call max loss is the premium, got ${lc.maxLoss}`);
});

test('long PUT is bounded both ways; max profit at S=0 is strike - premium', () => {
  const a = analyse([leg('PE', 'BUY', 100, 5)], 100);
  assert.equal(a.unboundedProfit, false);
  assert.equal(a.unboundedLoss, false);
  assert.ok(Math.abs(a.maxProfit - 95) < 1e-6, `max profit should be 95, got ${a.maxProfit}`);
  assert.ok(Math.abs(a.maxLoss - -5) < 1e-6, `max loss is the premium, got ${a.maxLoss}`);
});

// ===========================================================================
// Iron condor: exactly two breakevens, bounded max profit AND max loss.
// ===========================================================================
test('iron condor has exactly two breakevens and bounded P&L', () => {
  // Wings 85/115, body 95/105. Credit = (3+3) - (1+1) = 4.
  const legs = [
    leg('PE', 'BUY', 85, 1),
    leg('PE', 'SELL', 95, 3),
    leg('CE', 'SELL', 105, 3),
    leg('CE', 'BUY', 115, 1),
  ];
  const a = analyse(legs, 100);
  assert.equal(a.unboundedProfit, false);
  assert.equal(a.unboundedLoss, false);
  assert.equal(a.breakevens.length, 2, `expected 2 breakevens, got ${JSON.stringify(a.breakevens)}`);
  const [lo, hi] = a.breakevens.slice().sort((x, y) => x - y);
  assert.ok(Math.abs(lo - 91) < 1e-6, `lower breakeven ${lo}`);
  assert.ok(Math.abs(hi - 109) < 1e-6, `upper breakeven ${hi}`);
  // Max profit = net credit (4); max loss = wing width (10) - credit (4) = -6.
  assert.ok(Math.abs(a.maxProfit - 4) < 1e-6, `max profit ${a.maxProfit}`);
  assert.ok(Math.abs(a.maxLoss - -6) < 1e-6, `max loss ${a.maxLoss}`);
});

test('bull call spread: one breakeven, bounded profit and loss', () => {
  const legs = TEMPLATES.bull_call_spread
    .build(100, 5)
    .map((l) => ({ ...l, premium: l.side === 'BUY' ? 6 : 2, lots: 1, lotSize: 1 }));
  const a = analyse(legs, 100);
  assert.equal(a.unboundedProfit, false);
  assert.equal(a.unboundedLoss, false);
  assert.equal(a.breakevens.length, 1);
  assert.ok(Math.abs(a.breakevens[0] - 104) < 1e-6, `breakeven ${a.breakevens[0]}`);
  assert.ok(Math.abs(a.maxProfit - 6) < 1e-6);
  assert.ok(Math.abs(a.maxLoss - -4) < 1e-6);
});

test('lot scaling flows through the payoff (covered by units in P&L)', () => {
  // 2 lots of 50 = 100 units. A long call's max loss is premium * units.
  const a = analyse([leg('CE', 'BUY', 100, 5, 2, 50)], 100);
  assert.ok(Math.abs(a.maxLoss - -500) < 1e-6, `max loss should be 5 * 100 units = -500, got ${a.maxLoss}`);
  assert.equal(a.unboundedProfit, true);
});

// --- regressions: no spurious breakevens on flat-zero regions ---------------

test('a zero-cost spread (flat-zero plateau, never loses) reports NO breakeven', () => {
  // BUY CE 100 + SELL CE 110, both premium 0: payoff is 0 below 100, rises to
  // +10 above 110. It never crosses into loss, so there is no breakeven. The old
  // code reported the plateau boundary (strike 100) as one.
  const a = analyse([leg('CE', 'BUY', 100, 0), leg('CE', 'SELL', 110, 0)], 105);
  assert.deepEqual(a.breakevens, []);
  assert.ok(Math.abs(a.maxLoss - 0) < 1e-6);
  assert.ok(Math.abs(a.maxProfit - 10) < 1e-6);
});

test('a position that is flat-zero in the right tail reports NO far/plateau breakeven', () => {
  // BUY PE 110 + SELL PE 100, both premium 0: payoff is +10 for S<=100, declines
  // to 0 at 110, then flat 0. The old code emitted both strike 110 and the
  // artificial "far" sampling point as breakevens.
  const a = analyse([leg('PE', 'BUY', 110, 0), leg('PE', 'SELL', 100, 0)], 105);
  assert.deepEqual(a.breakevens, []);
  assert.ok(Math.abs(a.maxProfit - 10) < 1e-6);
  assert.ok(Math.abs(a.maxLoss - 0) < 1e-6);
});

// --- new templates (strategy builder+) -------------------------------------

test('long call butterfly: bounded both ways, exactly two breakevens', () => {
  const prem = { 95: 8, 100: 5, 105: 3 };
  const legs = TEMPLATES.long_call_butterfly.build(100, 5).map((l) => ({ ...l, premium: prem[l.strike], iv: 20 }));
  // The body leg sells two lots.
  const body = legs.find((l) => l.strike === 100);
  assert.equal(body.side, 'SELL');
  assert.equal(body.lots, 2);

  const a = analyse(legs, 100);
  assert.equal(a.unboundedProfit, false);
  assert.equal(a.unboundedLoss, false);
  assert.equal(a.breakevens.length, 2);
});

test('call ratio spread sells two lots against one long', () => {
  const legs = TEMPLATES.call_ratio_spread.build(100, 5);
  const sell = legs.find((l) => l.side === 'SELL');
  const buys = legs.filter((l) => l.side === 'BUY');
  assert.equal(sell.lots, 2);
  assert.equal(buys.length, 1);
  assert.equal(buys[0].lots, 1);
});

// --- multi-expiry (calendar / diagonal) ------------------------------------

test('legValueAtHorizon: an expiring leg is intrinsic; a later-expiring leg keeps time value', () => {
  const r = 0.065;
  // CE@100, spot 100, horizon 30d.
  const atHorizon = legValueAtHorizon({ type: 'CE', side: 'BUY', strike: 100, premium: 2, iv: 20, days: 30 }, 100, 30, r, 30);
  assert.ok(Math.abs(atHorizon - -2) < 1e-9, 'expiring ATM call -> intrinsic 0, P&L = -premium');
  const later = legValueAtHorizon({ type: 'CE', side: 'BUY', strike: 100, premium: 2, iv: 20, days: 60 }, 100, 30, r, 30);
  assert.ok(later > atHorizon, 'a leg with 30d left at the horizon still has time value');
});

test('a long call calendar is bounded, can profit, and has two breakevens', () => {
  const spot = 100, r = 0.065, iv = 20, near = 30, far = 60;
  const nearPrem = +bsPrice('CE', spot, 100, near / 365, r, iv / 100).toFixed(2);
  const farPrem = +bsPrice('CE', spot, 100, far / 365, r, iv / 100).toFixed(2);
  const legs = [
    { type: 'CE', side: 'SELL', strike: 100, premium: nearPrem, iv, lots: 1, lotSize: 1, days: near },
    { type: 'CE', side: 'BUY', strike: 100, premium: farPrem, iv, lots: 1, lotSize: 1, days: far },
  ];
  const a = analyse(legs, spot, { riskFreeRate: r, days: near });
  const netDebit = farPrem - nearPrem;
  assert.ok(netDebit > 0, 'a calendar is a net debit');
  assert.equal(a.unboundedProfit, false);
  assert.equal(a.unboundedLoss, false);
  assert.ok(a.maxProfit > 0, 'profits when the near decays while the far holds value');
  assert.ok(a.maxLoss < 0 && Math.abs(a.maxLoss) <= netDebit + 0.01, `max loss ~ -net debit, got ${a.maxLoss}`);
  assert.equal(a.breakevens.length, 2, 'two breakevens around the strike');
});

test('netGreeks of a long call calendar is net long vega and net positive theta (per-leg time)', () => {
  const legs = [
    { type: 'CE', side: 'SELL', strike: 100, premium: 2, iv: 20, lots: 1, lotSize: 1, days: 30 },
    { type: 'CE', side: 'BUY', strike: 100, premium: 3, iv: 20, lots: 1, lotSize: 1, days: 60 },
  ];
  const g = netGreeks(legs, 100, 30 / 365, 0.065);
  assert.ok(g.vega > 0, 'long the far (higher-vega) leg -> net long vega');
  assert.ok(g.theta > 0, 'short the faster-decaying near leg -> net positive theta');
});

test('calendar max profit resolves the peak at INDEX scale (not understated by a coarse grid)', () => {
  const spot = 23500, r = 0.065, iv = 20, near = 7, far = 37, atm = 23500;
  const nearPrem = +bsPrice('CE', spot, atm, near / 365, r, iv / 100).toFixed(2);
  const farPrem = +bsPrice('CE', spot, atm, far / 365, r, iv / 100).toFixed(2);
  const legs = [
    { type: 'CE', side: 'SELL', strike: atm, premium: nearPrem, iv, lots: 1, lotSize: 1, days: near },
    { type: 'CE', side: 'BUY', strike: atm, premium: farPrem, iv, lots: 1, lotSize: 1, days: far },
  ];
  const a = analyse(legs, spot, { riskFreeRate: r, days: near });
  // A same-strike calendar peaks AT the strike — the headline max profit must
  // match that, not a coarse-grid node that steps over the sharp peak.
  const peak = totalPayoffAtHorizon(legs, atm, near, r, near);
  assert.ok(peak > 0);
  assert.ok(Math.abs(a.maxProfit - peak) / peak < 0.01, `maxProfit ${a.maxProfit} should be within 1% of the true peak ${peak}`);
});

test('a FUT breakeven beyond 3x spot is still found (the entry price anchors the domain — regression)', () => {
  // A long future entered at 1000 while the underlying trades at 100 (a crashed
  // underlying): the genuine breakeven sits at S = 1000 — far beyond the old
  // 3*max(spot,strikes)+10 = 310 analysis window, so the authoritative breakevens
  // stat silently dropped it (the future contributes no strike to anchor on).
  const a = analyse([{ type: 'FUT', side: 'BUY', strike: 0, premium: 1000, lots: 1, lotSize: 1, days: null }], 100);
  assert.equal(a.breakevens.length, 1, 'the long future has exactly one breakeven');
  assert.ok(Math.abs(a.breakevens[0] - 1000) < 1e-6, `the breakeven is the entry price (got ${a.breakevens[0]})`);
  assert.ok(a.unboundedProfit, 'long future: unbounded upside');
  assert.equal(a.unboundedLoss, false, 'downside is bounded (S floors at 0)');
});
