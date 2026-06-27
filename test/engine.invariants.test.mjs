// ---------------------------------------------------------------------------
// test/engine.invariants.test.mjs
// Property / invariant / fuzz tests for the trading engine's accounting.
//
// Money is floating point and random price walks accumulate rounding error, so
// EVERY equality on cash / equity / P&L uses an absolute tolerance of 0.01
// (one paisa). Exact == would false-fail.
//
// The headline check is the MASTER invariant, which must hold for ALL
// instrument types after EVERY operation:
//
//     realisedTotal + unrealisedTotal  ==  equity - initialCash
//
// This is an exact identity by construction (equity = cash + holdings, and
// holdings + realised reconcile to the cash that has moved), so any violation
// is a real bug, not numeric drift.
//
// Run with:  node --test
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
};
const { Engine, instrumentKey, DEFAULT_CASH } = await import('../public/js/core/engine.js');

function makeEngine() {
  store.clear();
  return new Engine();
}

// Money tolerance: one paisa.
const TOL = 0.01;
const moneyEq = (a, b) => Math.abs(a - b) < TOL;

// MASTER invariant residual (should be ~0 always).
const masterResidual = (e) =>
  e.realisedTotal() + e.unrealisedTotal() - (e.equity() - e.state.initialCash);

function assertMaster(e, ctx = '') {
  const r = masterResidual(e);
  assert.ok(Math.abs(r) < TOL, `MASTER invariant violated (residual=${r}) ${ctx}`);
}

// Instrument builders.
const EQ = (symbol = 'RELIANCE') => ({ kind: 'EQ', symbol, lotSize: 1 });
const OPT = (optType = 'CE') => ({
  kind: 'OPT',
  symbol: 'NIFTY',
  expiry: '26-Jun-2026',
  strike: 23500,
  optType,
  lotSize: 75,
  underlyingPrice: 23500,
});
const FUT = () => ({ kind: 'FUT', symbol: 'NIFTY', expiry: '26-Jun-2026', lotSize: 75 });
const mkt = (instrument, side, lots, price) => ({ instrument, side, orderType: 'MARKET', lots, price });

// ===========================================================================
// ANCHOR 1: opening with NO price move leaves equity at initialCash.
// (Pins the equity fix: the old "cash + unrealised" gave initial - cost here.)
// ===========================================================================
test('opening any position with no price move keeps equity == initialCash', () => {
  const opens = [
    ['long EQ', mkt(EQ(), 'BUY', 100, 1300), 100],
    ['short EQ', mkt(EQ(), 'SELL', 100, 1300), -100],
    ['long OPT', mkt(OPT('CE'), 'BUY', 1, 150), 75],
    ['short OPT', mkt(OPT('PE'), 'SELL', 1, 150), -75],
    ['long FUT', mkt(FUT(), 'BUY', 1, 23500), 75],
  ];
  for (const [name, order, expectQty] of opens) {
    const e = makeEngine();
    const o = e.placeOrder(order);
    assert.equal(o.status, 'FILLED', name);
    assert.ok(
      moneyEq(e.equity(), e.state.initialCash),
      `${name}: equity ${e.equity()} should equal initialCash ${e.state.initialCash}`
    );
    const pos = Object.values(e.state.positions)[0];
    assert.equal(pos.qty, expectQty, `${name} qty`);
    assertMaster(e, name);
  }
});

// ===========================================================================
// ANCHOR 2: marking up by x per unit moves equity by x * qty (signed).
// ===========================================================================
test('marking a position up by x per unit changes equity by x * qty', () => {
  const x = 37.5;
  const cases = [
    ['long EQ', mkt(EQ(), 'BUY', 100, 1300), 'EQ:RELIANCE', 1300, 100],
    ['short EQ', mkt(EQ(), 'SELL', 100, 1300), 'EQ:RELIANCE', 1300, -100],
    ['long OPT', mkt(OPT('CE'), 'BUY', 2, 150), 'OPT:NIFTY:26-Jun-2026:23500:CE', 150, 150],
    ['long FUT', mkt(FUT(), 'BUY', 1, 23500), 'FUT:NIFTY:26-Jun-2026', 23500, 75],
  ];
  for (const [name, order, key, basePx, qty] of cases) {
    const e = makeEngine();
    e.placeOrder(order);
    e.onPriceUpdate(key, basePx + x);
    assert.ok(
      moneyEq(e.equity(), e.state.initialCash + x * qty),
      `${name}: equity ${e.equity()} vs ${e.state.initialCash + x * qty}`
    );
    assertMaster(e, name);
  }
});

// ===========================================================================
// ANCHOR 3: the MASTER invariant after every step of a mixed sequence.
// ===========================================================================
test('MASTER invariant holds after every step of a mixed multi-instrument run', () => {
  const e = makeEngine();
  const steps = [
    () => e.placeOrder(mkt(EQ(), 'BUY', 100, 1300)),
    () => e.onPriceUpdate('EQ:RELIANCE', 1345.25),
    () => e.placeOrder(mkt(FUT(), 'SELL', 2, 23500)), // short futures
    () => e.onPriceUpdate('FUT:NIFTY:26-Jun-2026', 23380.5),
    () => e.placeOrder(mkt(OPT('CE'), 'BUY', 3, 142.75)),
    () => e.onPriceUpdate('OPT:NIFTY:26-Jun-2026:23500:CE', 168.4),
    () => e.placeOrder(mkt(EQ(), 'SELL', 250, 1352.6)), // flip long->short through zero
    () => e.placeOrder(mkt(OPT('CE'), 'SELL', 1, 171.2)), // partial close
    () => e.onPriceUpdate('EQ:RELIANCE', 1310.1),
    () => e.placeOrder(mkt(FUT(), 'BUY', 2, 23410.9)), // close the short future
  ];
  steps.forEach((step, i) => {
    step();
    assertMaster(e, `after step ${i + 1}`);
    assert.ok(Number.isFinite(e.equity()) && Number.isFinite(e.state.cash));
  });
});

// ===========================================================================
// ANCHOR 4: conservation — open then close at the SAME price is a no-op.
// ===========================================================================
test('open then close at the same price: realised 0, cash restored, book flat', () => {
  const trips = [
    ['EQ', [mkt(EQ(), 'BUY', 100, 1300), mkt(EQ(), 'SELL', 100, 1300)]],
    ['short EQ', [mkt(EQ(), 'SELL', 100, 1300), mkt(EQ(), 'BUY', 100, 1300)]],
    ['FUT', [mkt(FUT(), 'BUY', 2, 23500), mkt(FUT(), 'SELL', 2, 23500)]],
    ['long OPT', [mkt(OPT('CE'), 'BUY', 2, 150), mkt(OPT('CE'), 'SELL', 2, 150)]],
    ['short OPT', [mkt(OPT('PE'), 'SELL', 2, 150), mkt(OPT('PE'), 'BUY', 2, 150)]],
  ];
  for (const [name, orders] of trips) {
    const e = makeEngine();
    const start = e.state.cash;
    orders.forEach((o) => e.placeOrder(o));
    assert.ok(moneyEq(e.realisedTotal(), 0), `${name}: realised ${e.realisedTotal()} should be 0`);
    assert.ok(moneyEq(e.state.cash, start), `${name}: cash ${e.state.cash} should be ${start}`);
    assert.equal(Object.keys(e.state.positions).length, 0, `${name}: book should be flat`);
    assertMaster(e, name);
  }
});

// ===========================================================================
// ANCHOR 5: round trip with a move.
// ===========================================================================
test('buy 100@1300, mark 1350, sell 100@1350 -> realised +5000, cash +5000', () => {
  const e = makeEngine();
  const start = e.state.cash;
  e.placeOrder(mkt(EQ(), 'BUY', 100, 1300));
  e.onPriceUpdate('EQ:RELIANCE', 1350);
  e.placeOrder(mkt(EQ(), 'SELL', 100, 1350));
  assert.ok(moneyEq(e.realisedTotal(), 5000), `realised ${e.realisedTotal()}`);
  assert.ok(moneyEq(e.state.cash, start + 5000), `cash ${e.state.cash}`);
  assertMaster(e);
});

// ===========================================================================
// ANCHOR 6: account realised == sum of per-fill realised increments,
// cross-checked against an independent hand-computed expectation.
// ===========================================================================
test('account realised equals the running sum of per-fill increments', () => {
  const e = makeEngine();
  e.reset(10000000); // plenty of funds so nothing is rejected
  // Sequence with known realised increments (average-cost accounting):
  //   BUY 100@1300, BUY 100@1500 (avg 1400), SELL 50@1600 (+10000),
  //   SELL 200@1100 (close 150 @1400 -> -45000, flip to short 50@1100),
  //   BUY 50@1000 (cover short 50 -> +5000).
  const plan = [
    [mkt(EQ(), 'BUY', 100, 1300), 0],
    [mkt(EQ(), 'BUY', 100, 1500), 0],
    [mkt(EQ(), 'SELL', 50, 1600), 10000],
    [mkt(EQ(), 'SELL', 200, 1100), -45000],
    [mkt(EQ(), 'BUY', 50, 1000), 5000],
  ];
  let running = 0;
  let summedIncrements = 0;
  for (const [order, expectedIncrement] of plan) {
    const before = e.realisedTotal();
    e.placeOrder(order);
    const increment = e.realisedTotal() - before;
    summedIncrements += increment;
    running += expectedIncrement;
    assert.ok(
      moneyEq(increment, expectedIncrement),
      `per-fill increment ${increment} vs expected ${expectedIncrement}`
    );
    assert.ok(moneyEq(e.realisedTotal(), running), `running realised ${e.realisedTotal()} vs ${running}`);
  }
  assert.ok(moneyEq(e.realisedTotal(), summedIncrements), 'accumulator must equal sum of increments');
  assert.ok(moneyEq(e.realisedTotal(), -30000), `final realised ${e.realisedTotal()}`);
});

// ===========================================================================
// ANCHOR 7: margin is non-negative and available funds finite (explicit).
// ===========================================================================
test('blockedMargin >= 0 and availableFunds finite through a derivative round trip', () => {
  const e = makeEngine();
  const check = () => {
    assert.ok(e.blockedMargin() >= 0, `blockedMargin ${e.blockedMargin()}`);
    assert.ok(Number.isFinite(e.availableFunds()), 'availableFunds finite');
  };
  check();
  e.placeOrder(mkt(FUT(), 'BUY', 1, 23500));
  check();
  e.placeOrder(mkt(OPT('PE'), 'SELL', 1, 160)); // short option also blocks margin
  check();
  e.onPriceUpdate('FUT:NIFTY:26-Jun-2026', 24000);
  check();
  e.placeOrder(mkt(FUT(), 'SELL', 1, 24000));
  e.placeOrder(mkt(OPT('PE'), 'BUY', 1, 160));
  check();
});

// ===========================================================================
// FUZZ: 5000 random valid order sequences. After EVERY step, all invariants
// must hold. A break reports the exact steps that produced it.
// ===========================================================================
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const randInt = (rnd, n) => Math.floor(rnd() * n);

// Fresh contract set with independent starting prices each sequence. `label`
// is only for the failure log; the engine ignores unknown fields.
function buildInstruments() {
  return [
    { kind: 'EQ', symbol: 'RELIANCE', lotSize: 1, label: 'RELIANCE', basePrice: 1300 },
    { kind: 'EQ', symbol: 'TCS', lotSize: 1, label: 'TCS', basePrice: 3800 },
    { kind: 'FUT', symbol: 'NIFTY', expiry: '26-Jun-2026', lotSize: 75, label: 'NIFTY-FUT', basePrice: 23500 },
    { kind: 'OPT', symbol: 'NIFTY', expiry: '26-Jun-2026', strike: 23500, optType: 'CE', lotSize: 75, underlyingPrice: 23500, label: '23500CE', basePrice: 180 },
    { kind: 'OPT', symbol: 'NIFTY', expiry: '26-Jun-2026', strike: 23500, optType: 'PE', lotSize: 75, underlyingPrice: 23500, label: '23500PE', basePrice: 160 },
  ];
}

// Validate every invariant; throw with the full step log on any violation.
function checkInvariants(e, log) {
  const fails = [];
  const cash = e.state.cash;
  const real = e.realisedTotal();
  const un = e.unrealisedTotal();
  const eq = e.equity();
  if (!Number.isFinite(cash)) fails.push(`cash not finite (${cash})`);
  if (!Number.isFinite(real)) fails.push(`realised not finite (${real})`);
  if (!Number.isFinite(un)) fails.push(`unrealised not finite (${un})`);
  if (!Number.isFinite(eq)) fails.push(`equity not finite (${eq})`);
  if (!(e.blockedMargin() >= 0)) fails.push(`blockedMargin negative (${e.blockedMargin()})`);
  if (!Number.isFinite(e.availableFunds())) fails.push(`availableFunds not finite (${e.availableFunds()})`);
  for (const key in e.state.positions) {
    const p = e.state.positions[key];
    if (!Number.isInteger(p.qty)) fails.push(`qty not integer: ${key} = ${p.qty}`);
    if (!Number.isFinite(p.avgPrice)) fails.push(`avgPrice not finite: ${key} = ${p.avgPrice}`);
    if (!(p.avgPrice >= 0)) fails.push(`avgPrice negative: ${key} = ${p.avgPrice}`);
  }
  const resid = real + un - (eq - e.state.initialCash);
  if (Math.abs(resid) >= TOL) fails.push(`MASTER residual ${resid}`);
  if (fails.length) {
    throw new Error(`Invariant break:\n  ${fails.join('\n  ')}\nSequence:\n${log.join('\n')}`);
  }
}

test('fuzz: 5000 random valid order sequences preserve all invariants', () => {
  let totalSteps = 0;
  for (let seq = 0; seq < 5000; seq++) {
    const e = makeEngine();
    e.reset(100000000); // big book so most orders are fundable -> lots of fills
    const rnd = lcg((0x9e3779b9 ^ (seq * 2654435761)) >>> 0);
    const insts = buildInstruments();
    const prices = insts.map((i) => i.basePrice);
    const log = [`# sequence ${seq} (initialCash ${e.state.initialCash})`];
    const nSteps = 3 + randInt(rnd, 12);

    for (let s = 0; s < nSteps; s++) {
      const k = randInt(rnd, insts.length);
      const inst = insts[k];
      const key = instrumentKey(inst);

      if (rnd() < 0.35) {
        // Price mark: gentle positive random walk (stays > 0).
        prices[k] = Math.max(0.05, prices[k] * (0.95 + 0.1 * rnd()));
        e.onPriceUpdate(key, prices[k]);
        log.push(`mark ${inst.label} -> ${prices[k].toFixed(4)}`);
      } else {
        const side = rnd() < 0.5 ? 'BUY' : 'SELL';
        const lots = 1 + randInt(rnd, 5);
        const px = prices[k];
        if (rnd() < 0.4) {
          const limitPrice = px * (0.98 + 0.04 * rnd());
          e.placeOrder({ instrument: inst, side, orderType: 'LIMIT', lots, limitPrice });
          log.push(`LIMIT ${side} ${lots}lot ${inst.label} @ ${limitPrice.toFixed(4)}`);
        } else {
          e.placeOrder({ instrument: inst, side, orderType: 'MARKET', lots, price: px });
          log.push(`MARKET ${side} ${lots}lot ${inst.label} @ ${px.toFixed(4)}`);
        }
      }
      totalSteps++;
      checkInvariants(e, log); // throws with the offending sequence on any break
    }
  }
  assert.ok(totalSteps > 5000, `ran ${totalSteps} fuzz steps`);
});
