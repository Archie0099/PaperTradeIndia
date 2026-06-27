// ---------------------------------------------------------------------------
// test/engine.adversarial.test.mjs
// Adversarial tests for the trading engine's position accounting — the places
// where a wrong average price, mis-scaled lot, or sloppy limit fill silently
// corrupts P&L:
//   * pyramiding (weighted average) and full-close realisation
//   * one-order reversal through zero (realise the closed part, open the rest)
//   * short -> cover P&L and sign of unrealised
//   * F&O lot scaling (premium move * lot size, not * 1)
//   * limit orders fill at the limit or BETTER, never worse; resting condition
//   * funds/margin rejection with reason; margin blocks on open, frees on close
//
// Run with:  node --test
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

// In-memory localStorage stub (the engine persists there).
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};
const { Engine } = await import('../public/js/core/engine.js');

function makeEngine() {
  store.clear();
  return new Engine();
}

const EQ = (symbol = 'RELIANCE') => ({ kind: 'EQ', symbol, lotSize: 1 });
const OPT = () => ({
  kind: 'OPT',
  symbol: 'NIFTY',
  expiry: '26-Jun-2026',
  strike: 23500,
  optType: 'CE',
  lotSize: 75,
  underlyingPrice: 23500,
});
const FUT = () => ({ kind: 'FUT', symbol: 'NIFTY', expiry: '26-Jun-2026', lotSize: 75 });
const market = (instrument, side, lots, price) => ({ instrument, side, orderType: 'MARKET', lots, price });
const limit = (instrument, side, lots, limitPrice) => ({ instrument, side, orderType: 'LIMIT', lots, limitPrice });

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ===========================================================================
// Pyramiding: averaging up must be quantity-weighted.
// ===========================================================================
test('pyramiding two buys gives the weighted-average price', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ(), 'BUY', 100, 1300));
  e.placeOrder(market(EQ(), 'BUY', 100, 1400));
  const pos = e.state.positions['EQ:RELIANCE'];
  assert.equal(pos.qty, 200);
  assert.ok(close(pos.avgPrice, 1350), `avg should be 1350, got ${pos.avgPrice}`);
});

// ===========================================================================
// Full close realises P&L, zeroes the position, accumulates across trips.
// ===========================================================================
test('full close realises P&L and account realised accumulates over round trips', () => {
  const e = makeEngine();
  // Trip 1: +100/share on 100 shares = +10,000.
  e.placeOrder(market(EQ(), 'BUY', 100, 1300));
  e.placeOrder(market(EQ(), 'SELL', 100, 1400));
  assert.equal(e.state.positions['EQ:RELIANCE'], undefined, 'position must be removed when flat');
  assert.ok(close(e.realisedTotal(), 10000), `after trip 1: ${e.realisedTotal()}`);

  // Trip 2: +100/share on 50 shares = +5,000. Running total 15,000.
  e.placeOrder(market(EQ('TCS'), 'BUY', 50, 1000));
  e.placeOrder(market(EQ('TCS'), 'SELL', 50, 1100));
  assert.ok(close(e.realisedTotal(), 15000), `after trip 2: ${e.realisedTotal()}`);
});

// ===========================================================================
// Reversal in one order: realise the closed part, open the residual.
// ===========================================================================
test('one SELL that exceeds a long realises the closed part and opens a short', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ(), 'BUY', 100, 1300)); // long 100 @ 1300
  const o = e.placeOrder(market(EQ(), 'SELL', 150, 1320)); // close 100 (+2,000), short 50 @ 1320
  assert.equal(o.status, 'FILLED');
  assert.ok(close(e.realisedTotal(), 2000), `realised should be 2000, got ${e.realisedTotal()}`);
  const pos = e.state.positions['EQ:RELIANCE'];
  assert.equal(pos.qty, -50, 'residual short of 50');
  assert.ok(close(pos.avgPrice, 1320), `new short avg ${pos.avgPrice}`);
});

// ===========================================================================
// Short then cover.
// ===========================================================================
test('short then cover realises gain; unrealised is positive while price < entry', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ(), 'SELL', 100, 1300)); // short 100 @ 1300
  e.updateEquityPrice('RELIANCE', 1250); // price below entry => profit for a short
  assert.ok(e.unrealisedFor('EQ:RELIANCE') > 0, 'short is in profit when price falls');
  assert.ok(close(e.unrealisedFor('EQ:RELIANCE'), 5000), `unrealised ${e.unrealisedFor('EQ:RELIANCE')}`);

  e.placeOrder(market(EQ(), 'BUY', 100, 1250)); // cover
  assert.equal(e.state.positions['EQ:RELIANCE'], undefined);
  assert.ok(close(e.realisedTotal(), 5000), `realised should be 5000, got ${e.realisedTotal()}`);
});

// ===========================================================================
// F&O lot scaling.
// ===========================================================================
test('F&O P&L scales by lot size, not by 1', () => {
  const e = makeEngine();
  e.placeOrder(market(OPT(), 'BUY', 1, 100)); // 1 lot * 75 units @ premium 100
  e.onPriceUpdate('OPT:NIFTY:26-Jun-2026:23500:CE', 120); // premium 100 -> 120
  const u = e.unrealisedFor('OPT:NIFTY:26-Jun-2026:23500:CE');
  assert.ok(close(u, 1500), `1 lot of 75, +20 premium => +1,500 (not +20). got ${u}`);
});

// ===========================================================================
// Limit orders: fill at the limit price or BETTER, never worse; resting rule.
// ===========================================================================
test('a buy limit rests while LTP is above it, then fills at the limit or cheaper', () => {
  const e = makeEngine();
  const o = e.placeOrder(limit(EQ(), 'BUY', 10, 1280));
  assert.equal(o.status, 'PENDING');

  e.onPriceUpdate('EQ:RELIANCE', 1300); // LTP above the limit -> must NOT fill
  assert.equal(o.status, 'PENDING', 'buy limit must not fill while LTP (1300) > limit (1280)');

  e.onPriceUpdate('EQ:RELIANCE', 1260); // gaps below the limit -> fills at the BETTER price
  assert.equal(o.status, 'FILLED');
  assert.ok(o.fillPrice <= 1280 + 1e-9, `buy must never fill above its limit; got ${o.fillPrice}`);
  assert.ok(close(o.fillPrice, 1260), `should fill at the better 1260, got ${o.fillPrice}`);
});

test('a sell limit rests while LTP is below it, then fills at the limit or higher', () => {
  const e = makeEngine();
  const o = e.placeOrder(limit(EQ(), 'SELL', 10, 1300));
  assert.equal(o.status, 'PENDING');

  e.onPriceUpdate('EQ:RELIANCE', 1290); // below the limit -> must NOT fill
  assert.equal(o.status, 'PENDING');

  e.onPriceUpdate('EQ:RELIANCE', 1320); // gaps above the limit -> fills at the BETTER price
  assert.equal(o.status, 'FILLED');
  assert.ok(o.fillPrice >= 1300 - 1e-9, `sell must never fill below its limit; got ${o.fillPrice}`);
  assert.ok(close(o.fillPrice, 1320), `should fill at the better 1320, got ${o.fillPrice}`);
});

// ===========================================================================
// The resting-orders index (_pending) that powers the reservedForPending fast-path.
// PERF: reservedForPending() short-circuits to 0 when nothing is resting (so a long
// backtest doesn't rescan thousands of FILLED orders per funds check). This test locks
// that the short-circuit is CORRECT: funds are still fully reserved while limits rest,
// and the index is maintained through both a fill and a cancel.
// ===========================================================================
test('reservedForPending tracks resting limits (fast-path index stays correct)', () => {
  const e = makeEngine();
  e.setCash(200000);
  assert.equal(e._pending.size, 0, 'fresh engine has no resting orders');
  assert.equal(e.reservedForPending(), 0, 'and reserves nothing (the short-circuit)');

  // A resting BUY LIMIT (below LTP) reserves its full new-exposure cash.
  const o1 = e.placeOrder(limit(EQ(), 'BUY', 100, 1280));
  assert.equal(o1.status, 'PENDING');
  assert.equal(e._pending.size, 1, 'the resting limit is indexed');
  assert.ok(close(e.reservedForPending(), 100 * 1280), `reserves the full ~₹128000, got ${e.reservedForPending()}`);
  assert.ok(close(e.availableFunds(), 200000 - 100 * 1280), 'available = cash - reserved');

  // A second limit that needs more than what's left must be REJECTED — proving the
  // reservation is genuinely enforced (the fast-path did NOT wrongly zero it).
  const o2 = e.placeOrder(limit(EQ('TCS'), 'BUY', 100, 1280));
  assert.equal(o2.status, 'REJECTED', 'the second limit cannot be funded while the first reserves cash');
  assert.equal(e._pending.size, 1, 'a rejected order is not indexed as resting');

  // Fill the first (price gaps below its limit) -> the index empties, reservation clears.
  e.onPriceUpdate('EQ:RELIANCE', 1260);
  assert.equal(o1.status, 'FILLED');
  assert.equal(e._pending.size, 0, 'a filled limit leaves the resting index');
  assert.equal(e.reservedForPending(), 0, 'nothing resting -> reserves 0 again');

  // A resting limit that is CANCELLED also leaves the index.
  const o3 = e.placeOrder(limit(EQ('INFY'), 'BUY', 1, 100));
  assert.equal(e._pending.size, 1);
  e.cancelOrder(o3.id);
  assert.equal(o3.status, 'CANCELLED');
  assert.equal(e._pending.size, 0, 'a cancelled limit leaves the resting index');
  assert.equal(e.reservedForPending(), 0);
});

test('a resting LIMIT survives a localStorage reload (the _pending index is rebuilt)', () => {
  // The browser persists state to localStorage and reconstructs the Engine on reload.
  // _pending is a DERIVED cache (not serialized), so the constructor must rebuild it from
  // the loaded orders — else after a reload the short-circuit would wrongly return 0 while
  // a limit is actually resting, under-reserving funds. (Critic follow-up from the hunt.)
  const e1 = makeEngine();
  e1.setCash(500000);
  const o = e1.placeOrder(limit(EQ(), 'BUY', 100, 1280)); // rests + emit() persists to the store
  assert.equal(o.status, 'PENDING');
  const reservedBefore = e1.reservedForPending();
  assert.ok(reservedBefore > 0, 'the resting limit reserves funds');

  const e2 = new Engine(); // a fresh Engine loads the SAME persisted state (no store.clear)
  assert.equal(e2._pending.size, 1, 'the resting limit is re-indexed on load (_rebuildPending)');
  assert.ok(close(e2.reservedForPending(), reservedBefore), 'reload reserves the same funds (short-circuit not wrongly firing)');
  assert.ok(close(e2.availableFunds(), e1.availableFunds()), 'available funds match across the reload');
});

// ===========================================================================
// Funds / margin: rejection with reason; margin blocks on open, frees on close.
// ===========================================================================
test('an order beyond available margin is rejected with a reason', () => {
  const e = makeEngine();
  e.setCash(100000);
  // 1 lot NIFTY future: notional 75*23500 = 17.6L, margin ~12% = ~2.1L > 1L.
  const o = e.placeOrder(market(FUT(), 'BUY', 1, 23500));
  assert.equal(o.status, 'REJECTED');
  assert.ok(o.reason && /insufficient/i.test(o.reason), `reason should explain why: ${o.reason}`);
});

test('margin blocks while a derivative position is open and frees when closed', () => {
  const e = makeEngine();
  assert.equal(e.blockedMargin(), 0);

  e.placeOrder(market(FUT(), 'BUY', 1, 23500)); // opens a future
  const blocked = e.blockedMargin();
  assert.ok(blocked > 0, `margin should be blocked once open, got ${blocked}`);
  assert.ok(close(e.availableFunds(), e.state.cash - blocked), 'available = cash - blocked');

  e.placeOrder(market(FUT(), 'SELL', 1, 23500)); // closes it
  assert.equal(e.state.positions['FUT:NIFTY:26-Jun-2026'], undefined);
  assert.ok(close(e.blockedMargin(), 0), `margin should free on close, got ${e.blockedMargin()}`);
});
