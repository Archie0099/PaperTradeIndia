// ---------------------------------------------------------------------------
// test/autopilot.test.mjs
// Locks the AUTO-PILOT ("let a bot trade for me"): the pure copy logic
// (pickChampion / mirrorSignature / computeRebalanceOrders / placeMirrorOrders),
// the copy applied THROUGH the real engine (positions match the bot at
// capital-ratio scale + the MASTER money invariant still holds), and the SERVER
// side (getBotDetail exposes a faithful `mirror` for every bot kind, incl. F&O).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

// localStorage stub BEFORE constructing any engine (the engine persists to it).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const { Engine } = await import('../public/js/core/engine.js');
const { pickChampion, mirrorSignature, computeRebalanceOrders, placeMirrorOrders, remarkOptionPositions, buildSeededState } = await import('../public/js/ui/autopilot.js');
const { createTournament } = await import('../tournament/tournament.mjs');

// A fresh user account at `cash` (default ₹1 crore — the new product default).
function freshUser(cash = 10_000_000) {
  store.clear();
  const e = new Engine();
  e.reset(cash);
  return e;
}
// MASTER invariant residual: realised + unrealised == equity - initialCash.
const masterResidual = (e) => Math.abs(e.realisedTotal() + e.unrealisedTotal() - (e.equity() - e.state.initialCash));
// A price source for the tests: the mirror's own mark price, else the engine's last
// seen price (for closing a held leg that isn't in the target).
const priceForEngine = (engine) => (key, spec) => (spec && spec.price > 0 ? spec.price : engine.state.lastPrices[key] > 0 ? engine.state.lastPrices[key] : null);

// ===========================================================================
// pickChampion
// ===========================================================================
test('pickChampion picks the best by metric, tie-broken by lifetime return', () => {
  const bots = [
    { id: 'a', sharpe: 0.5, trackReturnPct: 100 },
    { id: 'b', sharpe: 1.2, trackReturnPct: 50 },
    { id: 'c', sharpe: 1.2, trackReturnPct: 80 }, // ties b on Sharpe, higher lifetime -> wins
    { id: 'd', sharpe: NaN, trackReturnPct: 999 }, // non-finite Sharpe -> never the Sharpe champ
  ];
  assert.equal(pickChampion(bots, { metric: 'sharpe' }).id, 'c', 'best Sharpe, tie-broken by lifetime');
  assert.equal(pickChampion(bots, { metric: 'trackReturnPct' }).id, 'd', 'by lifetime, d (999%) wins');
  assert.equal(pickChampion([], { metric: 'sharpe' }), null, 'no bots -> null');
  assert.ok(pickChampion([{ id: 'x', sharpe: NaN }, { id: 'y', sharpe: NaN }], { metric: 'sharpe' }), 'all non-finite -> still returns one (no crash)');
});

// ===========================================================================
// mirrorSignature (the no-churn guard)
// ===========================================================================
test('mirrorSignature is PRICE-invariant and changes only when the bot rebalances (no churn)', () => {
  // The bot HOLDS the same 1000 shares while the price (and thus its equity) moves — the
  // signature must NOT change, or a calm market day would trigger spurious copy trades.
  const hold1 = { equity: 10_000_000, positions: [{ key: 'EQ:X', qty: 1000, price: 100 }] };
  const hold2 = { equity: 11_000_000, positions: [{ key: 'EQ:X', qty: 1000, price: 110 }] }; // price up, SAME holding
  assert.equal(mirrorSignature(hold1), mirrorSignature(hold2), 'a price move with unchanged holdings -> same signature');
  const rebal = { equity: 10_000_000, positions: [{ key: 'EQ:X', qty: 2000, price: 100 }] }; // the bot bought more
  assert.notEqual(mirrorSignature(hold1), mirrorSignature(rebal), 'an actual rebalance (qty change) -> a new signature');
  const flipped = { equity: 1e7, positions: [{ key: 'EQ:X', qty: -1000, price: 100 }] };
  assert.notEqual(mirrorSignature(hold1), mirrorSignature(flipped), 'a long->short flip -> a new signature');
  assert.equal(mirrorSignature({ equity: 1e7, positions: [] }), 'cash', 'a flat bot signs as "cash"');
  assert.equal(mirrorSignature(null), 'cash');
});

test('a position FLIP (long->short) on a fully-invested account lands SHORT, not stuck on the opposite side', () => {
  const user = freshUser(10_000_000);
  // Fully invest long NIFTY (cash -> ~0).
  const longMirror = { equity: 10_000_000, positions: [{ key: 'EQ:NIFTY', kind: 'EQ', symbol: 'NIFTY', lotSize: 1, qty: 400, price: 25000, side: 'BUY' }] };
  placeMirrorOrders(user, computeRebalanceOrders({ mirror: longMirror, current: [], userEquity: user.equity(), priceFor: priceForEngine(user) }));
  assert.equal(user.state.positions['EQ:NIFTY'].qty, 400, 'now long 400, fully invested');
  // Switch to a SHORT-NIFTY bot. A single combined SELL 800 would be REJECTED (the engine
  // funds the new short before the close frees cash); the split close+open must land short.
  const shortMirror = { equity: 10_000_000, positions: [{ key: 'EQ:NIFTY', kind: 'EQ', symbol: 'NIFTY', lotSize: 1, qty: -400, price: 25000, side: 'SELL' }] };
  const current = [{ key: 'EQ:NIFTY', instrument: user.state.positions['EQ:NIFTY'].instrument, qty: 400 }];
  const orders = computeRebalanceOrders({ mirror: shortMirror, current, userEquity: user.equity(), priceFor: priceForEngine(user) });
  assert.equal(orders.length, 2, 'a flip splits into a close + an open');
  assert.equal(orders[0].toQty, 0, 'the close-to-flat (funds-freeing) is ordered first');
  const results = placeMirrorOrders(user, orders);
  assert.ok(results.every((r) => r.status === 'FILLED'), 'both halves fill (not rejected)');
  assert.equal(user.state.positions['EQ:NIFTY'].qty, -400, 'the account is now SHORT, matching the bot');
  assert.ok(masterResidual(user) < 0.01, 'MASTER invariant holds');
});

test('copying a market-neutral pair (long + short) keeps BOTH legs full and dollar-neutral', () => {
  const user = freshUser(10_000_000);
  // A 70% long + 70% short book (a stat-arb pair). Opening the LONG first would truncate
  // the short to the remaining cash, leaving the copy net-directional — the bug. Shorts
  // must open first (a short is funds-neutral in this engine).
  const mirror = { equity: 10_000_000, positions: [
    { key: 'EQ:L', kind: 'EQ', symbol: 'L', lotSize: 1, qty: 70000, price: 100, side: 'BUY' },
    { key: 'EQ:SH', kind: 'EQ', symbol: 'SH', lotSize: 1, qty: -70000, price: 100, side: 'SELL' },
  ] };
  const orders = computeRebalanceOrders({ mirror, current: [], userEquity: user.equity(), priceFor: priceForEngine(user) });
  const li = orders.findIndex((o) => o.key === 'EQ:L');
  const si = orders.findIndex((o) => o.key === 'EQ:SH');
  assert.ok(si >= 0 && li >= 0 && si < li, 'the short open is ordered BEFORE the long open');
  placeMirrorOrders(user, orders);
  assert.equal(user.state.positions['EQ:L'].qty, 70000, 'the long leg is full');
  assert.equal(user.state.positions['EQ:SH'].qty, -70000, 'the short leg is FULL (not truncated)');
  assert.equal(user.state.positions['EQ:L'].qty, -user.state.positions['EQ:SH'].qty, 'the copy is dollar-neutral, like the bot');
  assert.ok(masterResidual(user) < 0.01, 'MASTER invariant holds');
});

// ===========================================================================
// computeRebalanceOrders + placeMirrorOrders THROUGH the real engine
// ===========================================================================
test('copies a mixed long / short / option portfolio onto a same-size account, invariant holds', () => {
  const user = freshUser(10_000_000);
  const mirror = {
    equity: 10_000_000, // same size as the account -> a 1:1 copy
    positions: [
      { key: 'EQ:X', kind: 'EQ', symbol: 'X', lotSize: 1, qty: 1000, price: 100, side: 'BUY' },
      { key: 'EQ:Y', kind: 'EQ', symbol: 'Y', lotSize: 1, qty: -500, price: 200, side: 'SELL' }, // a SHORT
      { key: 'OPT:NIFTY:cyc1:25000:CE', kind: 'OPT', symbol: 'NIFTY', expiry: 'cyc1', strike: 25000, optType: 'CE', lotSize: 75, qty: -75, price: 120, underlyingPrice: 25000, side: 'SELL' }, // a short option (F&O)
    ],
  };
  const orders = computeRebalanceOrders({ mirror, current: [], userEquity: user.equity(), priceFor: priceForEngine(user), botName: 'Bot' });
  assert.equal(orders.length, 3, 'one order per position');
  placeMirrorOrders(user, orders);
  assert.equal(user.state.positions['EQ:X'].qty, 1000, 'copied the long 1:1');
  assert.equal(user.state.positions['EQ:Y'].qty, -500, 'copied the short 1:1');
  assert.equal(user.state.positions['OPT:NIFTY:cyc1:25000:CE'].qty, -75, 'copied the option leg 1:1');
  assert.ok(masterResidual(user) < 0.01, 'MASTER invariant holds after the copy');
});

test('rebalance closes funds-freeing positions BEFORE opening new ones', () => {
  const user = freshUser(10_000_000);
  user.placeOrder({ instrument: { kind: 'EQ', symbol: 'Z', lotSize: 1 }, side: 'BUY', orderType: 'MARKET', lots: 100, price: 100 }); // a holding NOT in the target
  const current = [{ key: 'EQ:Z', instrument: { kind: 'EQ', symbol: 'Z', lotSize: 1 }, qty: 100 }];
  const mirror = { equity: 10_000_000, positions: [{ key: 'EQ:X', kind: 'EQ', symbol: 'X', lotSize: 1, qty: 1000, price: 100, side: 'BUY' }] };
  const orders = computeRebalanceOrders({ mirror, current, userEquity: user.equity(), priceFor: priceForEngine(user), botName: 'Bot' });
  assert.equal(orders[0].key, 'EQ:Z', 'the close (funds-freeing) is ordered first');
  assert.equal(orders[0].side, 'SELL');
  assert.equal(orders[orders.length - 1].key, 'EQ:X', 'the new open comes last');
});

test('already-matched account produces NO orders (no churn)', () => {
  const user = freshUser(10_000_000);
  const mirror = { equity: 10_000_000, positions: [{ key: 'EQ:X', kind: 'EQ', symbol: 'X', lotSize: 1, qty: 1000, price: 100, side: 'BUY' }] };
  placeMirrorOrders(user, computeRebalanceOrders({ mirror, current: [], userEquity: user.equity(), priceFor: priceForEngine(user) }));
  const current = [{ key: 'EQ:X', instrument: user.state.positions['EQ:X'].instrument, qty: user.state.positions['EQ:X'].qty }];
  const again = computeRebalanceOrders({ mirror, current, userEquity: user.equity(), priceFor: priceForEngine(user) });
  assert.equal(again.length, 0, 'already in sync -> no trades');
});

test('the copy scales to the account capital (half the equity -> half the size)', () => {
  const user = freshUser(5_000_000); // half the bot's equity
  const mirror = {
    equity: 10_000_000,
    positions: [
      { key: 'EQ:X', kind: 'EQ', symbol: 'X', lotSize: 1, qty: 1000, price: 100, side: 'BUY' },
      { key: 'EQ:Y', kind: 'EQ', symbol: 'Y', lotSize: 1, qty: -400, price: 200, side: 'SELL' },
    ],
  };
  const orders = computeRebalanceOrders({ mirror, current: [], userEquity: user.equity(), priceFor: priceForEngine(user) });
  const xo = orders.find((o) => o.key === 'EQ:X');
  const yo = orders.find((o) => o.key === 'EQ:Y');
  assert.equal(xo.lots, 500, 'half of 1000 shares');
  assert.equal(yo.lots, 200, 'half of the 400-share short');
  assert.equal(yo.side, 'SELL');
});

test('a fully-invested basket copy never rejects its last leg (affordability cap)', () => {
  // Two ~50% names that together round to slightly OVER 100% of the account — the cap
  // must trim the second buy so it still fills (instead of an "insufficient funds" reject).
  const user = freshUser(10_000_000);
  const mirror = {
    equity: 10_000_000,
    positions: [
      { key: 'EQ:A', kind: 'EQ', symbol: 'A', lotSize: 1, qty: 1667, price: 3000, side: 'BUY' }, // 5.001M
      { key: 'EQ:B', kind: 'EQ', symbol: 'B', lotSize: 1, qty: 1389, price: 3600, side: 'BUY' }, // 5.000M -> overshoots
    ],
  };
  const results = placeMirrorOrders(user, computeRebalanceOrders({ mirror, current: [], userEquity: user.equity(), priceFor: priceForEngine(user) }));
  assert.ok(results.every((r) => r.status === 'FILLED'), 'both legs fill (the second is capped, not rejected)');
  assert.ok(user.state.positions['EQ:A'] && user.state.positions['EQ:B'], 'both names are held');
  assert.ok(masterResidual(user) < 0.01, 'MASTER invariant holds');
});

// ===========================================================================
// SERVER: getBotDetail exposes a faithful `mirror` for every kind (incl. F&O)
// ===========================================================================
function niftySeries() {
  const candles = [];
  let p = 18000;
  for (let i = 0; i < 220; i++) { p *= 1 + Math.sin(i / 11) * 0.006 + 0.0006; candles.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  return candles;
}
const SEED = [
  { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
  { id: 'strangle', name: 'Strangle', kind: 'FNO', symbol: 'NIFTY', spec: { kind: 'FNO', name: 'Strangle', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.05 }, { type: 'PE', side: 'SELL', strikePct: 0.95 }] } },
];

test('getBotDetail exposes a mirror the Auto-Pilot can copy (instruments + signed sizes + equity)', async () => {
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  for (const b of t.getStandings().bots) {
    const d = t.getBotDetail(b.id);
    assert.ok(d.mirror, `${b.name} exposes a mirror`);
    assert.equal(d.mirror.followable, true);
    assert.ok(d.mirror.equity > 0, 'the mirror carries the bot equity (for scaling the copy)');
    assert.ok(Array.isArray(d.mirror.positions), 'the mirror has a positions array');
    for (const p of d.mirror.positions) {
      assert.ok(['EQ', 'FUT', 'OPT'].includes(p.kind), 'each position is a real instrument kind');
      assert.ok(p.qty !== 0 && Number.isFinite(p.qty), 'a signed, non-zero size');
      assert.ok(p.price > 0, 'a mark price to fill at');
      assert.equal(p.side, p.qty >= 0 ? 'BUY' : 'SELL', 'side matches the sign');
      if (p.kind === 'OPT') assert.ok(p.strike > 0 && p.optType && p.expiry, 'an option leg carries strike/type/expiry to reproduce it');
    }
  }
});

test('a real EQUITY bot mirror copies onto a fresh ₹1 crore account end-to-end', async () => {
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  const d = t.getBotDetail('bh');
  const botPos = d.mirror.positions.find((p) => p.kind === 'EQ');
  assert.ok(botPos, 'Buy & Hold holds an equity position');

  const user = freshUser(10_000_000);
  const orders = computeRebalanceOrders({ mirror: d.mirror, current: [], userEquity: user.equity(), priceFor: priceForEngine(user), botName: 'Buy & Hold' });
  placeMirrorOrders(user, orders);

  const expected = Math.round(botPos.qty * (10_000_000 / d.mirror.equity)); // capital-ratio scaling
  const userPos = user.state.positions[botPos.key];
  assert.ok(userPos, 'the account now holds the copied position');
  assert.equal(userPos.qty, expected, 'the account holds the bot qty scaled to its own capital');
  assert.ok(userPos.qty > 0, 'a long copy of a long bot');
  assert.ok(masterResidual(user) < 0.01, 'MASTER invariant holds after the copy');
});

test('a real F&O bot exposes its OPEN option legs and the Auto-Pilot copies them onto the account', async () => {
  // After the keepOpen fix, a solvent F&O bot is shown holding its OPEN option legs at the
  // data boundary (not force-settled to "flat"), so its mirror carries real legs the
  // Auto-Pilot can copy. (When a bot is genuinely between cycles its mirror is empty, which
  // is also valid — copying it then just holds cash.)
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  const d = t.getBotDetail('strangle');
  assert.ok(d.mirror && d.mirror.followable, 'the F&O bot exposes a followable mirror');
  const optLegs = d.mirror.positions.filter((p) => p.kind === 'OPT');
  assert.ok(optLegs.length >= 1, 'the live F&O bot now shows its OPEN option legs (keepOpen fix)');
  assert.ok(optLegs.every((p) => p.qty < 0 && p.side === 'SELL' && p.strike > 0 && p.optType && p.expiry), 'well-formed SHORT option legs (strike/type/expiry present)');
  const user = freshUser(10_000_000);
  placeMirrorOrders(user, computeRebalanceOrders({ mirror: d.mirror, current: [], userEquity: user.equity(), priceFor: priceForEngine(user), botName: 'Strangle' }));
  const heldOpts = Object.values(user.state.positions).filter((p) => p.qty !== 0 && p.instrument.kind === 'OPT');
  assert.equal(heldOpts.length, optLegs.length, 'every option leg was copied onto the account');
  assert.ok(heldOpts.every((p) => p.qty < 0), 'the copied legs are short, like the bot');
  assert.ok(masterResidual(user) < 0.01, 'MASTER invariant holds with the copied F&O book');
});

test('placeMirrorOrders flags a funds-CLIPPED open as `capped` (so the tick retries instead of marking synced)', () => {
  // An over-leveraged market-neutral copy whose LONG leg gets clipped by the
  // affordability cap still returned status FILLED, so the tick recorded "in sync" and never
  // retried the shortfall -> a net-directional book. The clipped open must be flagged `capped`.
  const user = freshUser(1_000_000); // small account
  const orders = [{ key: 'EQ:Z', instrument: { kind: 'EQ', symbol: 'Z' }, side: 'BUY', lots: 100, price: 50_000, fromQty: 0, toQty: 100, reason: 'open' }];
  const results = placeMirrorOrders(user, orders);
  assert.equal(results.length, 1);
  assert.ok(results[0].lots < 100, 'the open was clipped to what the account could afford');
  assert.ok(results[0].capped, 'the clipped open is flagged capped -> the no-churn guard will not call it fully synced');
});

test('buildSeededState reflects the walk-forward track record into the account ("I earned it")', () => {
  // The account should BE the 16-years-in result: started ₹1cr, grew to ₹13.25cr by
  // auto-piloting, now holding the current champion's book. initialCash stays ₹1cr (the gain is
  // theirs), equity == the earned value, and the MASTER invariant must hold on the seeded state.
  const ap = { cash: 10_000_000, startedAt: 0, metrics: { finalEquity: 132_500_000 }, curve: [{ t: 0, c: 10_000_000 }, { t: 1, c: 132_500_000 }] };
  const mirror = { equity: 1_000_000_000, positions: [
    { key: 'EQ:X', kind: 'EQ', symbol: 'X', lotSize: 1, qty: 100000, price: 500, side: 'BUY' },   // long
    { key: 'EQ:Y', kind: 'EQ', symbol: 'Y', lotSize: 1, qty: -20000, price: 300, side: 'SELL' },  // short
  ] };
  const user = freshUser(10_000_000);
  user.importJson(JSON.stringify(buildSeededState(ap, mirror)));
  assert.ok(Math.abs(user.equity() - 132_500_000) < 1, 'account equity == the earned ₹13.25cr');
  assert.equal(user.state.initialCash, 10_000_000, 'baseline stays ₹1cr — the gain is the return, not the starting capital');
  assert.ok(Math.abs((user.equity() - user.state.initialCash) - 122_500_000) < 1, 'total return = the ₹12.25cr earned');
  assert.ok(user.state.positions['EQ:X'] && user.state.positions['EQ:X'].qty > 0, 'holds the champion long, scaled to the account');
  assert.ok(user.state.positions['EQ:Y'] && user.state.positions['EQ:Y'].qty < 0, 'and the champion short');
  assert.ok(Array.isArray(user.state.equityCurve) && user.state.equityCurve.length >= 2, 'the multi-year curve becomes the account history');
  assert.ok(masterResidual(user) < 0.01, 'MASTER invariant holds on the seeded account');
});

test('a copied F&O leg is RE-MARKED live from the underlying (not frozen at its fill price)', async () => {
  // The fidelity fix: a copied option leg lives under a modelled cyc{i} expiry with no real
  // chain feed, so without re-marking its price would freeze (static P&L + dropped roll P&L).
  // remarkOptionPositions reprices it from the live underlying via the same Black-Scholes model.
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  const d = t.getBotDetail('strangle');
  const optLegs = d.mirror.positions.filter((p) => p.kind === 'OPT');
  assert.ok(optLegs.length >= 1 && optLegs.every((p) => p.expiryMs > 0 && p.iv > 0), 'the mirror exposes each leg expiry + IV for client re-marking');

  const user = freshUser(10_000_000);
  placeMirrorOrders(user, computeRebalanceOrders({ mirror: d.mirror, current: [], userEquity: user.equity(), priceFor: priceForEngine(user), botName: 'Strangle' }));
  const optKeys = Object.keys(user.state.positions).filter((k) => user.state.positions[k].instrument.kind === 'OPT');
  assert.ok(optKeys.length >= 1, 'option legs were copied');
  const fillMarks = optKeys.map((k) => user.state.lastPrices[k]);
  const eqBefore = user.equity();

  // Re-mark from a MOVED underlying (a sharp +10% rise), 20 days before expiry.
  const inst0 = user.state.positions[optKeys[0]].instrument;
  const movedSpot = (inst0.underlyingPrice || 25000) * 1.1;
  const nowMs = inst0.expiryMs - 20 * 864e5; // 20 days of time value remaining
  const app = { engine: user, state: { quotes: { NIFTY: { ltp: movedSpot } } } };
  const changed = remarkOptionPositions(app, nowMs);

  assert.ok(changed, 'the re-mark ran on the copied legs');
  const newMarks = optKeys.map((k) => user.state.lastPrices[k]);
  assert.ok(optKeys.some((_, i) => Math.abs(newMarks[i] - fillMarks[i]) > 1), 'at least one leg re-priced materially (not frozen at fill)');
  assert.ok(Math.abs(user.equity() - eqBefore) > 1, 'the copied F&O P&L now moves with the underlying');
  assert.ok(masterResidual(user) < 0.01, 'MASTER invariant holds after re-marking');
});

// --- a name too small to act on must be REPORTED, not silently dropped ------------------------
// Scaling the champion's book to the user's capital rounds to whole shares, so a slice under half
// a share becomes zero units. With nothing held either, `toQty === fromQty` and the name used to
// vanish: no order, no line, no reason — while the panel's target table still listed it at full
// weight. The screen contradicted itself and the book was under-deployed in silence.

const bigChampion = () => ({
  followable: true,
  equity: 84_900_000,
  positions: [
    { key: 'EQ:RELIANCE', symbol: 'RELIANCE', price: 1400, lotSize: 1, kind: 'EQ', qty: Math.round((84_900_000 * 0.25) / 1400) },
    { key: 'EQ:TCS', symbol: 'TCS', price: 3900, lotSize: 1, kind: 'EQ', qty: Math.round((84_900_000 * 0.25) / 3900) },
    { key: 'EQ:BOSCHLTD', symbol: 'BOSCHLTD', price: 33000, lotSize: 1, kind: 'EQ', qty: Math.round((84_900_000 * 0.25) / 33000) },
  ],
});
const priceOfSpec = (key, spec) => spec.price;

test('a slice that rounds below one share is recorded as skipped, with what it needed', () => {
  const orders = computeRebalanceOrders({ mirror: bigChampion(), current: [], userEquity: 50_000, priceFor: priceOfSpec });
  const skipped = orders.skipped || [];
  assert.ok(skipped.length > 0, 'the expensive name cannot be bought at this size and must be reported');
  const b = skipped.find((s) => s.symbol === 'BOSCHLTD');
  assert.ok(b, `expected BOSCHLTD to be skipped, got ${JSON.stringify(skipped.map((s) => s.symbol))}`);
  assert.ok(b.wantUnits > 0 && b.wantUnits < 1, `it should want a fraction of a share (got ${b.wantUnits})`);
  assert.equal(b.price, 33000, 'and carry the price, so the panel can explain why');
  assert.ok(!orders.some((o) => o.key === 'EQ:BOSCHLTD'), 'and it must not also appear as an order');
});

test('nothing is reported as skipped when every slice is actionable (control)', () => {
  const orders = computeRebalanceOrders({ mirror: bigChampion(), current: [], userEquity: 10_000_000, priceFor: priceOfSpec });
  assert.deepEqual(orders.skipped, [], 'at a large size every name is buyable, so the note must not appear');
  assert.equal(orders.length, 3);
});

test('computeSuggestions carries skipped EXPLICITLY, because the book is JSON-persisted', async () => {
  // An array property does not survive JSON.stringify, so a name dropped for being under one
  // share would have come back as "nothing to say" on the next page load.
  const { computeSuggestions } = await import('../public/js/ui/autopilot.js');
  const entry = {
    date: '2026-09-15', equity: 84_900_000,
    targets: [
      { symbol: 'RELIANCE', qty: 15160, price: 1400, weight: 0.25 },
      { symbol: 'BOSCHLTD', qty: 643, price: 33000, weight: 0.25 },
    ],
  };
  const res = computeSuggestions({ entry, book: { cash: 50_000, positions: [] }, costRates: { buyRate: 0.001, sellRate: 0.001 } });
  assert.ok(Array.isArray(res.skipped), 'skipped must be a real field on the result');
  assert.ok(res.skipped.some((s) => s.symbol === 'BOSCHLTD'), 'and must survive as data, not as an array property');
  assert.deepEqual(JSON.parse(JSON.stringify(res.skipped)), res.skipped, 'and must round-trip through JSON intact');
});

// --- one row, one risk-free rate --------------------------------------------
// ★ `remarkOptionPositions` used to model a copied leg at a hardcoded 6.5% while `optionChain.js`,
// `strategy.js` and `portfolioGreeks` all read `engine.state.settings.riskFreeRate` — which
// `importJson` ACCEPTS from a file. So importing a portfolio carrying any other rate made one row
// disagree with itself.
//
// MEASURED before the fix, on a 30-day ATM leg whose own IV is 14.00%, with the setting at 15%: the
// mark stayed 441.18 (priced at 6.5% regardless), so `portfolioGreeks` back-solved the IV from it
// at 15% and recovered 10.24% — a 3.76-point drift — putting theta at -783 instead of -635, ~23%
// out. The mark looked right, which is exactly why it was hard to see: the error only surfaced in
// the Greeks, through an implied vol that had quietly absorbed the rate mismatch.
test('a copied leg is re-marked at the ACCOUNT\'s risk-free rate, not a hardcoded one', () => {
  const EXP = Date.parse('2026-12-31T10:00:00Z');
  const NOW = EXP - 30 * 864e5; // ★ pinned: a wall-clock `nowMs` would move T between the two arms
  const KEY = 'OPT:NIFTY:cyc1:23500:CE';
  const leg = () => ({ kind: 'OPT', symbol: 'NIFTY', expiry: 'cyc1', expiryMs: EXP, strike: 23500, optType: 'CE', lotSize: 75, iv: 0.14, underlyingPrice: 23500 });

  const markAt = (ratePct) => {
    const eng = freshUser(10_000_000);
    eng.state.settings.riskFreeRate = ratePct;
    eng.state.positions[KEY] = { instrument: leg(), qty: 75, avgPrice: 200 };
    remarkOptionPositions({ engine: eng, state: { quotes: { NIFTY: { ltp: 23500 } } } }, NOW);
    return eng.state.lastPrices[KEY];
  };

  const base = markAt(6.5);
  const high = markAt(15);
  assert.ok(base > 0 && high > 0, 'both arms produced a mark');
  assert.notEqual(high, base, 'the mark must follow the account setting — it used to ignore it entirely');
  assert.ok(high > base, 'a higher risk-free rate raises a call, which is the direction that says the rate is really reaching the model');
});

test('CONTROL: the default is unchanged, so nothing moves for an account that never imported a rate', () => {
  // The whole point of the fix is that it is a no-op at 6.5 — the engine's own default, and the
  // rate `backtest/options-model.mjs` prices the bot's own book at.
  const EXP = Date.parse('2026-12-31T10:00:00Z');
  const NOW = EXP - 30 * 864e5;
  const KEY = 'OPT:NIFTY:cyc1:23500:CE';
  const leg = () => ({ kind: 'OPT', symbol: 'NIFTY', expiry: 'cyc1', expiryMs: EXP, strike: 23500, optType: 'CE', lotSize: 75, iv: 0.14, underlyingPrice: 23500 });

  const withSetting = freshUser(10_000_000);
  withSetting.state.positions[KEY] = { instrument: leg(), qty: 75, avgPrice: 200 };
  remarkOptionPositions({ engine: withSetting, state: { quotes: { NIFTY: { ltp: 23500 } } } }, NOW);

  const missing = freshUser(10_000_000);
  delete missing.state.settings.riskFreeRate; // a state file that never carried the field
  missing.state.positions[KEY] = { instrument: leg(), qty: 75, avgPrice: 200 };
  remarkOptionPositions({ engine: missing, state: { quotes: { NIFTY: { ltp: 23500 } } } }, NOW);

  assert.equal(withSetting.state.lastPrices[KEY], missing.state.lastPrices[KEY],
    'a missing setting falls back to the same 6.5% the default carries');
});
