// ---------------------------------------------------------------------------
// test/engine.test.mjs
// Unit tests for the simulation engine, run with Node's built-in test runner:
//
//     npm test            (or:  node --test)
//
// No test framework to install — just Node 18+. These lock the four money
// bugs fixed in engine.js so they can't silently regress.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The engine persists to localStorage, which doesn't exist in Node. Provide a
// tiny in-memory stub BEFORE we construct any engine.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};

const { Engine } = await import('../public/js/core/engine.js');

// Fresh engine with a clean storage each time (load() reads localStorage).
// These mechanics tests are calibrated to a ₹10,00,000 (₹10 lakh) account — e.g.
// "780k reserved out of 10,00,000", cash 8,70,000 after a buy. The PRODUCT default is
// now ₹1 crore (DEFAULT_CASH, so the personal account matches the tournament bots), so we
// explicitly reset each test engine to ₹10L here — keeping every calibrated number below
// meaningful and unchanged. A separate test (just below) locks the fresh default = ₹1cr.
function makeEngine() {
  store.clear();
  const e = new Engine();
  e.reset(1_000_000); // calibrate to ₹10L for the mechanics assertions in this file
  return e;
}

test('a fresh / reset account starts at the ₹1 crore default (DEFAULT_CASH)', () => {
  store.clear();
  const e = new Engine(); // no reset -> the product default
  assert.equal(e.state.cash, 10000000, 'a brand-new account starts at ₹1 crore');
  assert.equal(e.state.initialCash, 10000000);
  assert.equal(e.equity(), 10000000);
});

// (last-avg)*qty yields IEEE -0 for a short at entry (e.g. 0 * -100). That is
// numerically zero; collapse it so strict equality against 0 holds. This does
// not change any non-zero value, so the assertion stays exact.
const zero = (x) => x + 0;

test('importJson rejects corrupted lastPrices / settings (no NaN can brick the app)', () => {
  const e = makeEngine();
  const base = { cash: 1e6, initialCash: 1e6, realised: 0, orders: [], positions: {}, lastPrices: {}, settings: { futuresMarginPct: 12, shortOptionSpanPct: 10, riskFreeRate: 6.5 } };
  // A non-numeric last price would make unrealisedFor/equity NaN and persist it.
  assert.throws(() => e.importJson(JSON.stringify({ ...base, lastPrices: { 'EQ:RELIANCE': 'oops' } })), /lastPrices/);
  // A non-numeric margin setting would make estimateMargin NaN -> funds gate fails.
  assert.throws(() => e.importJson(JSON.stringify({ ...base, settings: { futuresMarginPct: 'oops', shortOptionSpanPct: 10, riskFreeRate: 6.5 } })), /settings/);
  // A rejected import leaves the portfolio untouched and finite.
  assert.ok(Number.isFinite(e.equity()));
  // A clean import still works.
  e.importJson(JSON.stringify({ ...base, lastPrices: { 'EQ:RELIANCE': 1300 } }));
  assert.ok(Number.isFinite(e.equity()));
});

// Shorthand instruments.
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
const limit = (instrument, side, lots, limitPrice) => ({
  instrument,
  side,
  orderType: 'LIMIT',
  lots,
  limitPrice,
});

// ===========================================================================
// FIX 1: equity() must not double-count principal for EQ/OPT positions.
// ===========================================================================
test('Fix 1: buying equity leaves account value unchanged (no principal double-count)', () => {
  const e = makeEngine();
  assert.equal(e.equity(), 1000000);

  const o = e.placeOrder(market(EQ(), 'BUY', 100, 1300));
  assert.equal(o.status, 'FILLED');
  // Cash dropped to 870,000 but the shares are worth 130,000 -> still 10,00,000.
  assert.equal(e.state.cash, 870000);
  assert.equal(e.equity(), 1000000, 'equity must be exactly 10,00,000, not 8,70,000');
  // Per-position unrealised P&L is unchanged behaviour: (last-avg)*qty = 0.
  assert.equal(e.unrealisedFor('EQ:RELIANCE'), 0);
});

test('Fix 1: shorting equity leaves account value unchanged (no inflation)', () => {
  const e = makeEngine();
  const o = e.placeOrder(market(EQ(), 'SELL', 100, 1300));
  assert.equal(o.status, 'FILLED');
  // Cash rose to 1,130,000 but we owe 130,000 of stock -> still 10,00,000.
  assert.equal(e.state.cash, 1130000);
  assert.equal(e.equity(), 1000000, 'short must not inflate account value');
  assert.equal(zero(e.unrealisedFor('EQ:RELIANCE')), 0);
});

test('Fix 1: equity tracks price moves; unrealised P&L formula unchanged', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ(), 'BUY', 100, 1300));
  e.updateEquityPrice('RELIANCE', 1350); // +50 per share on 100 shares = +5,000
  assert.equal(e.unrealisedFor('EQ:RELIANCE'), 5000); // (1350-1300)*100
  assert.equal(e.holdingsValue(), 135000); // 1350*100 market value
  assert.equal(e.equity(), 1005000);

  // Short side loses when price rises.
  const s = makeEngine();
  s.placeOrder(market(EQ(), 'SELL', 100, 1300));
  s.updateEquityPrice('RELIANCE', 1350);
  assert.equal(s.unrealisedFor('EQ:RELIANCE'), -5000); // (1350-1300)*(-100)
  assert.equal(s.equity(), 995000);
});

test('Fix 1: long option does not drop account value; futures mark-to-market works', () => {
  // Long option: premium leaves cash, but the option is worth that premium.
  const e = makeEngine();
  e.placeOrder(market(OPT(), 'BUY', 1, 120)); // 1 lot * 75 * 120 = 9,000
  assert.equal(e.state.cash, 991000);
  assert.equal(e.equity(), 1000000, 'buying an option must not change account value');

  // Futures: no premium at entry, so account value only moves on price change.
  const f = makeEngine();
  f.placeOrder(market(FUT(), 'BUY', 1, 23500));
  assert.equal(f.state.cash, 1000000, 'futures entry moves no cash');
  assert.equal(f.equity(), 1000000);
  f.onPriceUpdate('FUT:NIFTY:26-Jun-2026', 23600); // +100 * 75 = +7,500
  assert.equal(f.equity(), 1007500);
});

// ===========================================================================
// FIX 2: orders that flip through zero must fund the NEW exposure portion.
// ===========================================================================
test('Fix 2: flip that opens an unaffordable short is rejected', () => {
  const e = makeEngine();
  e.setCash(10000);
  e.placeOrder(market(EQ(), 'BUY', 5, 1300)); // cash 10,000 - 6,500 = 3,500, long 5
  assert.equal(e.state.positions['EQ:RELIANCE'].qty, 5);

  // SELL 55: closes 5 longs and tries to open a short 50 (needs ~65,000 margin).
  const o = e.placeOrder(market(EQ(), 'SELL', 55, 1300));
  assert.equal(o.status, 'REJECTED', 'the new short leg must be funds-checked');
  assert.match(o.reason, /Insufficient funds/);
  // Position untouched because the order was rejected before any fill.
  assert.equal(e.state.positions['EQ:RELIANCE'].qty, 5);
});

test('Fix 2: affordable flip fills and opens the residual short', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ(), 'BUY', 100, 1300)); // long 100
  const o = e.placeOrder(market(EQ(), 'SELL', 150, 1300)); // -> short 50
  assert.equal(o.status, 'FILLED');
  assert.equal(e.state.positions['EQ:RELIANCE'].qty, -50);
  assert.equal(e.state.positions['EQ:RELIANCE'].avgPrice, 1300);
});

test('Fix 2: pure reduce needs no new funds even when broke', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ(), 'BUY', 100, 1300)); // long 100
  e.setCash(0); // no spare cash at all
  const o = e.placeOrder(market(EQ(), 'SELL', 50, 1300)); // reduce only -> no new exposure
  assert.equal(o.status, 'FILLED');
  assert.equal(e.state.positions['EQ:RELIANCE'].qty, 50);
});

// ===========================================================================
// FIX 3: pending limit orders reserve funds and are re-checked at fill.
// ===========================================================================
test('Fix 3: a resting limit reserves funds so a later market order is blocked', () => {
  const e = makeEngine();
  const lim = e.placeOrder(limit(EQ(), 'BUY', 600, 1300)); // reserves 780,000
  assert.equal(lim.status, 'PENDING');
  assert.equal(e.availableFunds(), 220000, '780k reserved out of 10,00,000');

  // 200 @ 1300 = 260,000 would fit raw cash but NOT the reserved-adjusted funds.
  const mkt = e.placeOrder(market(EQ(), 'BUY', 200, 1300));
  assert.equal(mkt.status, 'REJECTED');
  assert.match(mkt.reason, /Insufficient funds/);
});

test('Fix 3: a second pending limit cannot double-commit the same cash', () => {
  const e = makeEngine();
  e.placeOrder(limit(EQ(), 'BUY', 600, 1300)); // reserves 780,000
  const second = e.placeOrder(limit(EQ(), 'BUY', 600, 1300)); // needs another 780,000
  assert.equal(second.status, 'REJECTED', 'only 220,000 left after the first reservation');
});

test('Fix 3: pending limit is re-checked at fill and rejected if funds dropped', () => {
  const e = makeEngine();
  const lim = e.placeOrder(limit(EQ(), 'BUY', 600, 1300)); // needs 780,000
  assert.equal(lim.status, 'PENDING');

  // Funds drop below what the pending order needs (e.g. user edits cash).
  e.setCash(100000);
  // Price crosses the limit -> the engine tries to fill.
  e.updateEquityPrice('RELIANCE', 1290);

  assert.equal(lim.status, 'REJECTED', 'must not fill cash negative');
  assert.match(lim.reason, /at fill/);
  assert.equal(e.state.cash, 100000, 'cash unchanged by the rejected fill');
  assert.equal(e.state.positions['EQ:RELIANCE'], undefined, 'no position opened');
});

test('Fix 3: an affordable pending limit still fills normally on cross', () => {
  const e = makeEngine();
  const lim = e.placeOrder(limit(EQ(), 'BUY', 10, 1250));
  assert.equal(lim.status, 'PENDING');
  e.updateEquityPrice('RELIANCE', 1240); // 1240 <= 1250 -> fills at the BETTER price 1240
  assert.equal(lim.status, 'FILLED');
  assert.equal(lim.fillPrice, 1240); // limit price or better, never worse
  assert.equal(e.state.positions['EQ:RELIANCE'].qty, 10);
  assert.equal(e.state.cash, 1000000 - 12400);
});

// ===========================================================================
// FIX 4: importJson validates SHAPE, not just JSON syntax.
// ===========================================================================
test('Fix 4: malformed JSON throws (a clean Error, not a crash)', () => {
  const e = makeEngine();
  assert.throws(() => e.importJson('{ not json'), Error);
});

test('Fix 4: importing non-objects throws a clear Error instead of TypeError', () => {
  const e = makeEngine();
  // The literal null used to throw an uncaught TypeError on spread.
  assert.throws(() => e.importJson('null'), /expected a JSON object/);
  assert.throws(() => e.importJson('[]'), /expected a JSON object/);
  assert.throws(() => e.importJson('42'), /expected a JSON object/);
});

test('Fix 4: non-numeric / NaN money fields are rejected', () => {
  const e = makeEngine();
  const base = { initialCash: 1000000, realised: 0, positions: {}, orders: [], lastPrices: {} };
  assert.throws(() => e.importJson(JSON.stringify({ ...base, cash: 'abc' })), /"cash" must be a finite number/);
  assert.throws(() => e.importJson(JSON.stringify({ ...base, cash: null })), /"cash" must be a finite number/);
  // A bad import must NOT mutate the existing portfolio.
  assert.equal(e.state.cash, 1000000);
});

test('Fix 4: corrupted positions / wrong container types are rejected', () => {
  const e = makeEngine();
  const base = { cash: 500000, initialCash: 500000, realised: 0, orders: [], lastPrices: {} };
  // positions must be an object map...
  assert.throws(() => e.importJson(JSON.stringify({ ...base, positions: [] })), /"positions" must be an object/);
  // ...and each position needs finite numeric qty/avgPrice.
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, positions: { 'EQ:X': { qty: 'oops', avgPrice: 1 } } })),
    /position "EQ:X" is corrupted/
  );
  // orders must be an array.
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, positions: {}, orders: {} })),
    /"orders" must be an array/
  );
});

test('Fix 4 (regression): a corrupt PENDING order is rejected BEFORE commit (no reload brick, portfolio untouched)', () => {
  const e = makeEngine();
  e.setCash(777777);
  const base = { cash: 500000, initialCash: 500000, realised: 0, positions: {}, lastPrices: {}, settings: { futuresMarginPct: 12, shortOptionSpanPct: 10, riskFreeRate: 6.5 } };
  // (a) A PENDING order with a null instrument used to pass (orders got ONLY an Array.isArray
  // check), commit + persist, then brick availableFunds()/every render — and survive a reload —
  // because reservedForPending() -> instrumentKey(order.instrument) reads inst.kind on null.
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, orders: [{ id: 1, status: 'PENDING', instrument: null, side: 'BUY', qty: 10, limitPrice: 100 }] })),
    /pending order has a missing\/invalid instrument/
  );
  // (b) A null order ELEMENT used to throw in _rebuildPending AFTER this.state was committed,
  // silently replacing the live portfolio while the caller saw "import failed".
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, orders: [null] })),
    /an order entry is not an object/
  );
  // (c) A PENDING order with a non-finite limit price / non-positive qty / bad side is rejected too.
  assert.throws(() => e.importJson(JSON.stringify({ ...base, orders: [{ id: 2, status: 'PENDING', instrument: { kind: 'EQ', symbol: 'X' }, side: 'BUY', qty: 10, limitPrice: 'nope' }] })), /non-finite limit price/);
  assert.throws(() => e.importJson(JSON.stringify({ ...base, orders: [{ id: 3, status: 'PENDING', instrument: { kind: 'EQ', symbol: 'X' }, side: 'BUY', qty: 0, limitPrice: 100 }] })), /non-finite\/non-positive qty/);
  assert.throws(() => e.importJson(JSON.stringify({ ...base, orders: [{ id: 4, status: 'PENDING', instrument: { kind: 'EQ', symbol: 'X' }, side: 'HOLD', qty: 10, limitPrice: 100 }] })), /invalid side/);
  // EVERY rejected import left the current portfolio untouched and the app un-bricked (the guarantee).
  assert.equal(e.state.cash, 777777, 'a bad import never mutates the live portfolio');
  assert.ok(Number.isFinite(e.availableFunds()), 'availableFunds() still works (not bricked)');
  // A non-PENDING (e.g. FILLED) order needs no instrument validation, but must still be an object.
  assert.doesNotThrow(() => e.importJson(JSON.stringify({ ...base, orders: [{ id: 5, status: 'FILLED', side: 'BUY', qty: 10 }] })));
});

test('importJson rejects a NEGATIVE pending limit price (regression: negative reservation inflated availableFunds past cash)', () => {
  const e = makeEngine();
  e.setCash(1000);
  const base = { cash: 1000, initialCash: 1000, realised: 0, positions: {}, lastPrices: {}, settings: { futuresMarginPct: 12, shortOptionSpanPct: 10, riskFreeRate: 6.5 } };
  // A finite-but-negative limit passed the old bare finiteness check; reservedForPending()
  // then computed margin = qty * (-50) = a NEGATIVE reservation, so availableFunds()
  // EXCEEDED cash and ordinary market orders could overspend the whole account. The
  // poisoned order could never fill or self-correct (onPriceUpdate rejects price <= 0).
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, orders: [{ id: 1, status: 'PENDING', instrument: { kind: 'EQ', symbol: 'X', lotSize: 1 }, side: 'BUY', qty: 100, lots: 100, limitPrice: -50 }] })),
    /non-positive\/non-finite limit price/
  );
  // Zero is rejected for the same reason (placeOrder's own refPrice gate is > 0).
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, orders: [{ id: 2, status: 'PENDING', instrument: { kind: 'EQ', symbol: 'X', lotSize: 1 }, side: 'BUY', qty: 100, lots: 100, limitPrice: 0 }] })),
    /non-positive\/non-finite limit price/
  );
  // A pending order with NO lots count is rejected too: modifyOrder recomputes
  // qty = lots * lotSize, so a price-only Modify on such an order would have
  // written qty = NaN and poisoned cash on the fill.
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, orders: [{ id: 3, status: 'PENDING', instrument: { kind: 'EQ', symbol: 'X', lotSize: 1 }, side: 'BUY', qty: 100, limitPrice: 100 }] })),
    /missing\/invalid lots count/
  );
  // A pending order with a truthy-but-non-numeric lotSize is rejected: it survives
  // modifyOrder's `|| 1` fallback, so qty = lots * 'abc' = NaN on a price-only Modify
  // would poison cash on the fill (the same hazard as the missing-lots case above).
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, orders: [{ id: 4, status: 'PENDING', instrument: { kind: 'EQ', symbol: 'X', lotSize: 'abc' }, side: 'BUY', qty: 100, lots: 100, limitPrice: 90 }] })),
    /bad lot size/
  );
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, orders: [{ id: 5, status: 'PENDING', instrument: { kind: 'EQ', symbol: 'X', lotSize: -5 }, side: 'BUY', qty: 100, lots: 100, limitPrice: 90 }] })),
    /bad lot size/
  );
  // Non-positive lastPrices are rejected (the engine only ever records prices > 0).
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, lastPrices: { 'EQ:X': -500 } })),
    /must be a positive finite number/
  );
  // The funds gate survives every rejected import: available never exceeds cash.
  assert.ok(e.availableFunds() <= e.state.cash + 1e-9, 'availableFunds can never exceed cash on an empty book');
});

test('importJson rejects a corrupt equityCurve entry (regression: recordEquitySample threw on every poll after commit)', () => {
  const e = makeEngine();
  const base = { cash: 1e6, initialCash: 1e6, realised: 0, positions: {}, orders: [], lastPrices: {}, settings: { futuresMarginPct: 12, shortOptionSpanPct: 10, riskFreeRate: 6.5 } };
  // A non-object LAST entry made recordEquitySample throw (`last.c = ...` on a string)
  // on every poll cycle: frozen renders, alerts never firing — and it persisted.
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, equityCurve: [{ t: 1700000000000, c: 1000000 }, 'corrupt'] })),
    /equity-curve entry is corrupted/
  );
  assert.throws(
    () => e.importJson(JSON.stringify({ ...base, equityCurve: [{ t: 'oops', c: 1000000 }] })),
    /equity-curve entry is corrupted/
  );
  // A valid curve (and a legacy export with NO curve) still import cleanly, and
  // sampling works right after.
  assert.doesNotThrow(() => e.importJson(JSON.stringify({ ...base, equityCurve: [{ t: 1700000000000, c: 1000000 }] })));
  assert.doesNotThrow(() => e.recordEquitySample(1700000100000));
  assert.doesNotThrow(() => e.importJson(JSON.stringify(base)));
});

test('modifyOrder guards a non-finite lots recompute (regression: NaN qty poisoned cash on fill)', () => {
  const e = makeEngine();
  e.setCash(500000);
  const o = e.placeOrder(limit(EQ('X'), 'BUY', 10, 100)); // rests below any market -> PENDING
  assert.equal(o.status, 'PENDING');
  // Garbage lots input must leave the original order fully intact (same contract
  // as an invalid price: "ignore the change, keep the resting order").
  e.modifyOrder(o.id, { lots: NaN });
  assert.equal(o.lots, 10);
  assert.ok(Number.isFinite(o.qty), 'qty stays finite after a garbage lots modify');
  // Defense-in-depth: even if an order somehow lost its lots (imports now reject
  // that, but state predating the fix may carry one), a price-only Modify must
  // not manufacture a NaN qty — the guard keeps the order untouched.
  delete o.lots;
  e.modifyOrder(o.id, { limitPrice: 99 });
  assert.ok(Number.isFinite(o.qty), 'a price-only modify on a lots-less order cannot write NaN qty');
  assert.equal(o.limitPrice, 100, 'the change was ignored outright (original kept)');
  // Same defense for a truthy-but-non-numeric lotSize (imports now reject it, but a
  // resting order predating the fix could carry one): qty = lots * lotSize must not
  // become NaN — the guard honours only a positive finite lotSize, else falls back to 1.
  const o2 = e.placeOrder(limit(EQ('X'), 'BUY', 10, 100));
  assert.equal(o2.status, 'PENDING');
  o2.instrument.lotSize = 'abc';
  const mod = e.modifyOrder(o2.id, { limitPrice: 98 });
  assert.ok(mod && Number.isFinite(mod.qty), 'a bad lotSize cannot produce a NaN qty on Modify');
  assert.equal(mod.qty, 10, 'qty falls back to lots * 1');
});

test('recordEquitySample COMPACTS the curve instead of FIFO-erasing it (regression: seeded multi-year history gone in hours)', () => {
  const e = makeEngine();
  // Seed a sparse ~16-year history (like "Reflect this in my account" does).
  const YEAR = 365.25 * 864e5;
  const t0 = Date.UTC(2010, 0, 1);
  e.state.equityCurve = Array.from({ length: 120 }, (_, i) => ({ t: t0 + (i * 16 * YEAR) / 119, c: 1000000 + i * 100000 }));
  const firstT = e.state.equityCurve[0].t;
  const seededSpan = e.state.equityCurve[119].t - firstT;
  // Then sample far past the 500-point cap at the normal 30s cadence (~6 hours):
  // the old `shift()` erased the ENTIRE seeded history well before 700 samples.
  let now = e.state.equityCurve[119].t + 60000;
  for (let i = 0; i < 700; i++) { e.recordEquitySample(now); now += 30000; }
  const curve = e.state.equityCurve;
  assert.ok(curve.length <= 500, `stays bounded (got ${curve.length})`);
  assert.equal(curve[0].t, firstT, 'the OLDEST seeded point survives (span preserved, resolution coarsened)');
  assert.ok(curve[curve.length - 1].t - curve[0].t >= seededSpan, 'the curve still spans the full seeded history');
  // And the points stay in time order (compaction must not reorder).
  for (let i = 1; i < curve.length; i++) assert.ok(curve[i].t > curve[i - 1].t, 'monotonic timestamps');
});

test('Fix 4 (regression): a VALID resting PENDING order still round-trips through import', () => {
  const e = makeEngine();
  e.setCash(500000);
  e.placeOrder(market(EQ('X'), 'BUY', 100, 2500));
  const o = e.placeOrder(limit(EQ('X'), 'SELL', 100, 2600)); // rests above market -> PENDING
  assert.equal(o.status, 'PENDING');
  const snapshot = e.exportJson();
  const e2 = makeEngine();
  e2.importJson(snapshot); // a well-formed PENDING order must be ACCEPTED (not over-rejected)
  assert.equal(e2._pending.size, 1, 'the resting order is re-indexed after import');
  assert.ok(Number.isFinite(e2.availableFunds()));
});

test('Fix 4: a valid export round-trips through import', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ(), 'BUY', 10, 1300));
  e.updateEquityPrice('RELIANCE', 1350);
  const snapshot = e.exportJson();

  const e2 = makeEngine();
  e2.importJson(snapshot);
  assert.equal(e2.state.cash, e.state.cash);
  assert.equal(e2.realisedTotal(), e.realisedTotal());
  assert.deepEqual(e2.state.positions, e.state.positions);
});

// ===========================================================================
// Regression: multiple resting limit orders on the SAME instrument must
// not under-reserve funds. Each pending order used to be judged
// against the LIVE position independently, so two opposing limits both thought
// they merely closed it and the new exposure the later fill opens went
// unreserved.
// ===========================================================================
test('two resting SELL limits on one long do NOT under-reserve the second\'s new short', () => {
  const e = makeEngine();
  e.setCash(300000);
  e.placeOrder(market(EQ('X'), 'BUY', 100, 2500)); // long 100, cash -> 50,000
  assert.equal(e.state.positions['EQ:X'].qty, 100);

  // First SELL LIMIT 100 just CLOSES the long -> reserves nothing -> rests.
  const o1 = e.placeOrder(limit(EQ('X'), 'SELL', 100, 2600));
  assert.equal(o1.status, 'PENDING');

  // Second SELL LIMIT 100 would, after the first fills, open a NEW short 100
  // needing ~₹260,000 margin — far more than the ₹50,000 left. The old code
  // judged it against the live long (new exposure 0) and wrongly ACCEPTED it.
  const o2 = e.placeOrder(limit(EQ('X'), 'SELL', 100, 2600));
  assert.equal(o2.status, 'REJECTED');
  assert.match(o2.reason, /Insufficient funds/);
});

test('a single resting take-profit limit that merely closes a long reserves nothing (no over-reservation)', () => {
  const e = makeEngine();
  e.setCash(300000);
  e.placeOrder(market(EQ('X'), 'BUY', 100, 2500)); // long 100, cash -> 50,000
  const before = e.availableFunds();
  const o = e.placeOrder(limit(EQ('X'), 'SELL', 100, 2600)); // take-profit, just closes
  assert.equal(o.status, 'PENDING');
  assert.ok(Math.abs(e.availableFunds() - before) < 0.01, 'a closing take-profit must not reserve margin');
});

test('importJson rejects a position with a missing instrument and leaves state untouched (bug #2)', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ('SAFE'), 'BUY', 5, 100)); // an existing position to protect
  const cashBefore = e.state.cash;
  const bad = JSON.stringify({
    cash: 500000,
    initialCash: 1000000,
    realised: 0,
    positions: { 'EQ:X': { qty: 10, avgPrice: 100 } }, // NO instrument
    orders: [],
    lastPrices: {},
  });
  assert.throws(() => e.importJson(bad), /instrument/);
  // A bad import must NOT half-commit: the current portfolio is intact.
  assert.equal(e.state.cash, cashBefore);
  assert.ok(e.state.positions['EQ:SAFE'], 'existing position survived the rejected import');
});

test('setCash is a deposit/withdrawal: Total Return is preserved with an open position (bug #3)', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ('X'), 'BUY', 100, 5000)); // cash 5e5, holdings cost 5e5
  e.updateEquityPrice('X', 5000); // mark at cost -> unrealised 0
  const retBefore = e.equity() - e.state.initialCash;
  assert.ok(Math.abs(retBefore) < 0.01, `baseline Total Return ~0, got ${retBefore}`);

  e.setCash(e.state.cash + 200000); // inject ₹2,00,000 of virtual cash
  const retAfter = e.equity() - e.state.initialCash;
  assert.ok(Math.abs(retAfter) < 0.01, `a deposit must not show up as return, got ${retAfter}`);

  // On a fresh engine (cash == initialCash) setCash still sets a clean baseline.
  const e2 = makeEngine();
  e2.setCash(400000);
  assert.equal(e2.state.cash, 400000);
  assert.equal(e2.state.initialCash, 400000);
});

// --- Portfolio analytics ---------------------------------------------------

test('recordEquitySample builds the equity curve (throttled) and sets the day baseline', () => {
  const e = makeEngine();
  e.recordEquitySample(1_000_000);
  assert.equal(e.state.equityCurve.length, 1);
  assert.equal(e.state.equityCurve[0].c, 1000000); // starting equity
  assert.ok(e.state.dayStart && typeof e.state.dayStart.equity === 'number');

  e.recordEquitySample(1_000_000 + 10_000); // <30s later -> update latest, no new point
  assert.equal(e.state.equityCurve.length, 1);

  e.recordEquitySample(1_000_000 + 40_000); // >=30s later -> a new point
  assert.equal(e.state.equityCurve.length, 2);
});

test('dayPnl measures equity change since the start-of-day baseline', () => {
  const e = makeEngine();
  e.recordEquitySample(1_000_000); // baseline = 1,000,000
  assert.ok(Math.abs(e.dayPnl()) < 0.01);
  e.placeOrder(market(EQ('X'), 'BUY', 100, 100));
  e.updateEquityPrice('X', 120); // +20 * 100 = +2,000 unrealised
  assert.ok(Math.abs(e.dayPnl() - 2000) < 0.01, `day P&L should be +2000, got ${e.dayPnl()}`);
});

test('a closing fill records its realised P&L on the order (trade log)', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ('X'), 'BUY', 10, 100)); // opening fill -> realises nothing
  assert.equal(e.state.orders[0].realised, 0);
  e.placeOrder(market(EQ('X'), 'SELL', 10, 130)); // closing fill -> +300
  assert.ok(Math.abs(e.state.orders[0].realised - 300) < 0.01, `closing fill realised +300, got ${e.state.orders[0].realised}`);
});

// --- Bracket orders / modify / square-off ----------------------------------

test('a bracket TARGET auto-closes a long when price hits it (logged with reason + P&L)', () => {
  const e = makeEngine();
  e.placeOrder({ instrument: EQ('X'), side: 'BUY', orderType: 'MARKET', lots: 10, price: 100, target: 120 });
  assert.equal(e.state.positions['EQ:X'].target, 120);
  e.updateEquityPrice('X', 119); // not yet
  assert.ok(e.state.positions['EQ:X']);
  e.updateEquityPrice('X', 121); // hits the target
  assert.equal(e.state.positions['EQ:X'], undefined, 'position auto-closed at target');
  assert.match(e.state.orders[0].reason, /Target hit/);
  assert.ok(e.state.orders[0].realised > 0);
});

test('a bracket STOP-LOSS auto-closes a long when price hits it', () => {
  const e = makeEngine();
  e.placeOrder({ instrument: EQ('X'), side: 'BUY', orderType: 'MARKET', lots: 10, price: 100, stopLoss: 90 });
  e.updateEquityPrice('X', 89); // hits the stop
  assert.equal(e.state.positions['EQ:X'], undefined);
  assert.match(e.state.orders[0].reason, /Stop-loss hit/);
  assert.ok(e.state.orders[0].realised < 0);
});

test('bracket exits flip correctly for a SHORT (stop above, target below)', () => {
  const e = makeEngine();
  e.placeOrder({ instrument: EQ('X'), side: 'SELL', orderType: 'MARKET', lots: 10, price: 100, stopLoss: 110, target: 90 });
  assert.equal(e.state.positions['EQ:X'].qty, -10);
  e.updateEquityPrice('X', 89); // a falling price is the SHORT's target
  assert.equal(e.state.positions['EQ:X'], undefined);
  assert.match(e.state.orders[0].reason, /Target hit/);
});

test('setExits attaches and clears bracket exits on an open position', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ('X'), 'BUY', 10, 100));
  e.setExits('EQ:X', { stopLoss: 95, target: 130 });
  assert.equal(e.state.positions['EQ:X'].stopLoss, 95);
  assert.equal(e.state.positions['EQ:X'].target, 130);
  e.setExits('EQ:X', { stopLoss: null, target: null });
  assert.equal(e.state.positions['EQ:X'].stopLoss, null);
  assert.equal(e.state.positions['EQ:X'].target, null);
});

test('modifyOrder changes a resting limit price; closeAll squares off everything', () => {
  const e = makeEngine();
  const o = e.placeOrder(limit(EQ('X'), 'BUY', 10, 90));
  assert.equal(o.status, 'PENDING');
  e.modifyOrder(o.id, { limitPrice: 95 });
  assert.equal(e.state.orders[0].limitPrice, 95);

  e.placeOrder(market(EQ('A'), 'BUY', 10, 100));
  e.placeOrder(market(EQ('B'), 'BUY', 5, 200));
  assert.equal(Object.values(e.state.positions).filter((p) => p.qty !== 0).length, 2);
  e.closeAll();
  assert.equal(Object.values(e.state.positions).filter((p) => p.qty !== 0).length, 0, 'all positions squared off');
});

// --- additional regression fixes -------------------------------------------

test('bracket exits are cleared when a fill FLIPS the position through zero', () => {
  const e = makeEngine();
  e.setCash(10000000);
  e.placeOrder({ instrument: EQ('X'), side: 'BUY', orderType: 'MARKET', lots: 100, price: 100, stopLoss: 90, target: 110 });
  e.placeOrder(market(EQ('X'), 'SELL', 150, 95)); // long 100 -> short 50
  const pos = e.state.positions['EQ:X'];
  assert.equal(pos.qty, -50);
  assert.equal(pos.stopLoss, null, "old long's stop must not stick to the new short");
  assert.equal(pos.target, null);
  // A normal tick must NOT auto-close the new short with a bogus "Stop-loss hit".
  e.onPriceUpdate('EQ:X', 95);
  assert.ok(e.state.positions['EQ:X'], 'short survived');
  assert.equal(e.state.positions['EQ:X'].qty, -50);
});

test('setCash keeps Day P&L deposit/withdrawal-neutral', () => {
  const e = makeEngine();
  e.recordEquitySample(1_000_000); // day baseline
  assert.ok(Math.abs(e.dayPnl()) < 0.01);
  e.setCash(e.state.cash + 250000); // deposit
  assert.ok(Math.abs(e.dayPnl()) < 0.01, `a deposit must not show as Day P&L, got ${e.dayPnl()}`);
});

test('a silent price update applies the price but does not emit (batched poll)', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ('X'), 'BUY', 10, 100));
  let emits = 0;
  e.subscribe(() => emits++);
  e.onPriceUpdate('EQ:X', 110, true); // silent
  assert.equal(emits, 0);
  assert.equal(e.state.lastPrices['EQ:X'], 110, 'price still applied');
  e.onPriceUpdate('EQ:X', 111); // normal
  assert.equal(emits, 1);
});

test('a break-even close is flagged as a closing fill (trade log shows it)', () => {
  const e = makeEngine();
  e.placeOrder(market(EQ('X'), 'BUY', 10, 100));
  e.placeOrder(market(EQ('X'), 'SELL', 10, 100)); // break-even: realised 0
  assert.equal(e.state.orders[0].realised, 0);
  assert.equal(e.state.orders[0].closing, true, 'closing flagged even at break-even');
  assert.equal(e.state.orders[1].closing, false, 'opening fill not flagged');
});
