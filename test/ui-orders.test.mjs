// ---------------------------------------------------------------------------
// test/ui-orders.test.mjs
// Drives the REAL Orders tab UI (public/js/ui/orders.js) in jsdom: the order
// ticket (place MARKET/LIMIT, BUY/SELL, EQ/FUT/OPT), the live margin estimate,
// the order-history table, and the click-to-prefill ("trade") flow.
//
// These were previously read-audited only — here we actually submit the form
// and assert the rendered result, the way a user would experience it.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { initOrders, renderOrders, renderEstimate } from '../public/js/ui/orders.js';

// Let async event handlers (e.g. "Get last price") settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

// Wire the orders UI up the way app.js does: init the ticket, and re-render the
// history whenever the engine changes (app.js does this via engine.subscribe).
function mountOrders(dom) {
  const app = dom.makeApp();
  initOrders(app);
  app.engine.subscribe(() => renderOrders(app));
  renderOrders(app);
  return app;
}

test('empty order history shows the empty state', () => {
  const dom = setupDom();
  mountOrders(dom);
  assert.match(dom.$('#orders-table').textContent, /No orders yet/);
});

test('MARKET buy equity fills and appears in history + makes a position', () => {
  const dom = setupDom();
  const app = mountOrders(dom);

  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-lots'), '10'); // EQ: "lots" field is share count
  dom.setValue(dom.$('#t-price'), '2500');
  dom.submit('#order-ticket');

  const order = app.engine.state.orders[0];
  assert.equal(order.status, 'FILLED');
  assert.equal(order.fillPrice, 2500);
  assert.equal(order.qty, 10);

  // The history table shows the fill, and a position now exists.
  const html = dom.$('#orders-table').textContent;
  assert.match(html, /RELIANCE/);
  assert.ok(dom.$('#orders-table .pill.FILLED'), 'a FILLED pill should render');
  assert.equal(app.engine.state.positions['EQ:RELIANCE'].qty, 10);

  // The ticket gives inline success feedback.
  assert.match(dom.$('#ticket-estimate').textContent, /Filled 10 @ 2500/);
});

test('MARKET order with no price and no last price is REJECTED with a reason', () => {
  const dom = setupDom();
  const app = mountOrders(dom);

  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'ZEEL');
  dom.setValue(dom.$('#t-price'), ''); // none typed
  dom.submit('#order-ticket');

  const order = app.engine.state.orders[0];
  assert.equal(order.status, 'REJECTED');
  assert.match(order.reason, /No valid price/);
  assert.match(dom.$('#ticket-estimate').textContent, /Rejected/);
});

test('a typed-blank MARKET order falls back to the engine last price (keyForInstrument matches engine)', () => {
  const dom = setupDom();
  const app = mountOrders(dom);

  // Seed a last price the way the polling loop would. If orders.js's local
  // keyForInstrument disagreed with engine.instrumentKey, this lookup would
  // miss and the order would be rejected instead of filling at 2600.
  app.engine.updateEquityPrice('RELIANCE', 2600);

  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-lots'), '5');
  dom.setValue(dom.$('#t-price'), ''); // blank -> fall back to last price
  dom.submit('#order-ticket');

  const order = app.engine.state.orders[0];
  assert.equal(order.status, 'FILLED');
  assert.equal(order.fillPrice, 2600);
});

test('LIMIT order rests as PENDING and updates the pending count', () => {
  const dom = setupDom();
  const app = mountOrders(dom);

  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-ordertype'), 'LIMIT');
  dom.setValue(dom.$('#t-lots'), '10');
  dom.setValue(dom.$('#t-price'), '2400'); // limit price
  dom.submit('#order-ticket');

  const order = app.engine.state.orders[0];
  assert.equal(order.status, 'PENDING');
  assert.match(dom.$('#pending-count').textContent, /1 pending/);
  assert.match(dom.$('#ticket-estimate').textContent, /Pending limit order/);
});

test('switching instrument type shows/hides F&O and option rows and relabels quantity', () => {
  const dom = setupDom();
  mountOrders(dom);

  const hidden = (sel) => dom.$$(sel).every((n) => n.classList.contains('hidden'));
  const label = () => dom.$('#lots-label').firstChild.textContent;

  dom.setValue(dom.$('#t-kind'), 'EQ');
  assert.ok(hidden('.fno-only'), 'EQ hides F&O rows');
  assert.ok(hidden('.opt-only'), 'EQ hides option rows');
  assert.equal(label(), 'Quantity (shares)');

  dom.setValue(dom.$('#t-kind'), 'FUT');
  assert.ok(!hidden('.fno-only'), 'FUT shows F&O rows');
  assert.ok(hidden('.opt-only'), 'FUT still hides option-only rows');
  assert.equal(label(), 'Quantity (lots)');

  dom.setValue(dom.$('#t-kind'), 'OPT');
  assert.ok(!hidden('.fno-only'), 'OPT shows F&O rows');
  assert.ok(!hidden('.opt-only'), 'OPT shows option rows');
});

test('the live estimate flips to INSUFFICIENT when the order exceeds funds', () => {
  const dom = setupDom();
  const app = mountOrders(dom);

  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-lots'), '100');
  dom.setValue(dom.$('#t-price'), '100000'); // 100 * 100000 = 1e7 >> 1e6 cash
  renderEstimate(app);

  const box = dom.$('#ticket-estimate').textContent;
  assert.match(box, /INSUFFICIENT/);
});

test('loadTicket (click-to-trade from the chain) prefills the ticket and switches tab', () => {
  const dom = setupDom();
  const app = mountOrders(dom);

  const inst = {
    kind: 'OPT',
    symbol: 'NIFTY',
    expiry: '26-Jun-2026',
    strike: 23500,
    optType: 'PE',
    lotSize: 75,
    underlyingPrice: 23500,
  };
  app.loadTicket(inst, 'SELL', 120.5, 2);

  assert.equal(dom.$('#t-kind').value, 'OPT');
  assert.equal(dom.$('#t-symbol').value, 'NIFTY');
  assert.equal(dom.$('#t-strike').value, '23500');
  assert.equal(dom.$('#t-opttype').value, 'PE');
  assert.equal(dom.$('#t-side').value, 'SELL');
  assert.equal(dom.$('#t-lots').value, '2');
  assert.equal(dom.$('#t-price').value, '120.5');
  // Option rows must be visible after a prefill, and we should be on Orders.
  assert.ok(!dom.$('.opt-only').classList.contains('hidden'));
  assert.ok(dom.$('#tab-orders').classList.contains('active'));
});

test('"Get last price" fetches the quote and drops it into the price field', async () => {
  const dom = setupDom();
  const app = dom.makeApp({ api: dom.makeApiStub({ quote: async () => ({ ltp: 2750.25, changePct: 0 }) }) });
  initOrders(app);

  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.fire(dom.$('#t-refresh-price'), 'click');
  await flush();

  assert.equal(dom.$('#t-price').value, '2750.25');
});

test('a pending LIMIT order can be cancelled from the history table', () => {
  const dom = setupDom();
  const app = mountOrders(dom);

  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-ordertype'), 'LIMIT');
  dom.setValue(dom.$('#t-lots'), '1');
  dom.setValue(dom.$('#t-price'), '2400');
  dom.submit('#order-ticket');
  assert.equal(app.engine.state.orders[0].status, 'PENDING');

  // Click the Cancel button rendered in the history row (next to Modify).
  const cancelBtn = dom.$$('#orders-table button').find((b) => b.textContent === 'Cancel');
  assert.ok(cancelBtn, 'a Cancel button should be present for a pending order');
  dom.fire(cancelBtn, 'click');

  assert.equal(app.engine.state.orders[0].status, 'CANCELLED');
  assert.match(dom.$('#orders-table').textContent, /Cancelled by user/);
});

// --- regression tests for confirmed UI bugs --------------------------------

test('a leftover F&O lot size cannot multiply an equity order', () => {
  const dom = setupDom();
  const app = mountOrders(dom);

  // Pick Future and give it a lot size of 75 (as a chain click would).
  dom.setValue(dom.$('#t-kind'), 'FUT');
  dom.setValue(dom.$('#t-lotsize'), '75');
  // Switch back to Equity (the lot-size row is now hidden but still holds 75)
  // and buy 10 shares.
  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-lots'), '10');
  dom.setValue(dom.$('#t-price'), '2500');
  dom.submit('#order-ticket');

  const order = app.engine.state.orders[0];
  assert.equal(order.qty, 10, 'equity order must be 10 shares, NOT 10 × 75');
  assert.equal(order.status, 'FILLED');
});

test('an option order with an empty strike is rejected before the engine', () => {
  const dom = setupDom();
  const app = mountOrders(dom);

  dom.setValue(dom.$('#t-kind'), 'OPT');
  dom.setValue(dom.$('#t-symbol'), 'NIFTY');
  dom.setValue(dom.$('#t-expiry'), '26-Jun-2026');
  dom.setValue(dom.$('#t-price'), '100');
  // #t-strike left empty (Number('') === 0)
  dom.submit('#order-ticket');

  assert.equal(app.engine.state.orders.length, 0, 'no garbage "SYMBOL 0 CE" order placed');
  assert.match(dom.$('#ticket-estimate').textContent, /valid strike/);
});

test('"Get last price" refuses to drop the underlying spot into an F&O ticket', async () => {
  const dom = setupDom();
  const app = dom.makeApp({ api: dom.makeApiStub({ quote: async () => ({ ltp: 23500, changePct: 0 }) }) });
  initOrders(app);

  dom.setValue(dom.$('#t-kind'), 'OPT');
  dom.setValue(dom.$('#t-price'), '');
  dom.fire(dom.$('#t-refresh-price'), 'click');
  await flush();

  assert.equal(dom.$('#t-price').value, '', 'the index level must not seed the option premium');
  assert.match(dom.$('#ticket-estimate').textContent, /Option Chain/);
});

test('a bracket order attaches stop-loss/target to the resulting position (order types)', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-lots'), '10');
  dom.setValue(dom.$('#t-price'), '2500');
  dom.$('#t-sl').value = '2400';
  dom.$('#t-target').value = '2700';
  dom.submit('#order-ticket');

  const pos = app.engine.state.positions['EQ:RELIANCE'];
  assert.ok(pos, 'position opened');
  assert.equal(pos.stopLoss, 2400);
  assert.equal(pos.target, 2700);
});

test('the Modify button changes a resting limit order price (order types)', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-ordertype'), 'LIMIT');
  dom.setValue(dom.$('#t-lots'), '10');
  dom.setValue(dom.$('#t-price'), '2400');
  dom.submit('#order-ticket');
  assert.equal(app.engine.state.orders[0].status, 'PENDING');

  dom.setPrompt('2450'); // the new limit price the prompt returns
  const modifyBtn = dom.$$('#orders-table button').find((b) => b.textContent === 'Modify');
  assert.ok(modifyBtn, 'a Modify button should be present for a pending order');
  dom.fire(modifyBtn, 'click');
  assert.equal(app.engine.state.orders[0].limitPrice, 2450);
});

test('the trade log shows realised P&L for a closing fill (analytics)', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  const inst = { kind: 'EQ', symbol: 'RELIANCE', lotSize: 1 };
  app.engine.placeOrder({ instrument: inst, side: 'BUY', orderType: 'MARKET', lots: 10, price: 100 });
  app.engine.placeOrder({ instrument: inst, side: 'SELL', orderType: 'MARKET', lots: 10, price: 130 });
  // Newest-first: the closing SELL is the first row; its Realised cell (col 7).
  const realisedCell = dom.$('#orders-table tbody tr td:nth-child(7)');
  assert.equal(realisedCell.textContent, '+300');
  assert.ok(realisedCell.classList.contains('up'));
});

test('a break-even close shows 0 (not "–") in the Realised column', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  const inst = { kind: 'EQ', symbol: 'X', lotSize: 1 };
  app.engine.placeOrder({ instrument: inst, side: 'BUY', orderType: 'MARKET', lots: 10, price: 100 });
  app.engine.placeOrder({ instrument: inst, side: 'SELL', orderType: 'MARKET', lots: 10, price: 100 }); // break-even close
  assert.equal(dom.$('#orders-table tbody tr td:nth-child(7)').textContent, '0');
});

test('Modify shows an alert when the new limit price cannot be funded', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  app.engine.setCash(100000);
  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'X');
  dom.setValue(dom.$('#t-ordertype'), 'LIMIT');
  dom.setValue(dom.$('#t-lots'), '10');
  dom.setValue(dom.$('#t-price'), '9000'); // reserves 90,000 < 100,000 -> rests
  dom.submit('#order-ticket');
  assert.equal(app.engine.state.orders[0].status, 'PENDING');

  dom.setPrompt('11000'); // would reserve 110,000 > 100,000 -> rejected
  dom.fire(dom.$$('#orders-table button').find((b) => b.textContent === 'Modify'), 'click');
  assert.equal(app.engine.state.orders[0].limitPrice, 9000, 'price unchanged on rejection');
  assert.ok(dom.alerts.some((m) => /Could not modify/.test(m)), 'user is told it was rejected');
});
