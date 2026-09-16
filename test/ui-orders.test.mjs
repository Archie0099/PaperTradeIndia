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

test('the estimate for an order that merely CLOSES a position asks for no margin (never INSUFFICIENT)', () => {
  // Regression: the estimate box priced the FULL order quantity, while placeOrder funds
  // only the new-exposure part. Selling shares you already own was therefore shown in red
  // as "INSUFFICIENT" (and labelled a "Short proxy") — and then filled instantly on submit.
  const dom = setupDom();
  const app = mountOrders(dom);
  app.engine.reset(1_000_000);
  app.engine.placeOrder({ instrument: { kind: 'EQ', symbol: 'RELIANCE', lotSize: 1 }, side: 'BUY', orderType: 'MARKET', lots: 500, price: 1300 });
  assert.equal(app.engine.state.positions['EQ:RELIANCE'].qty, 500);

  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-side'), 'SELL');
  dom.setValue(dom.$('#t-lots'), '500');
  dom.setValue(dom.$('#t-price'), '1300');
  renderEstimate(app);

  const box = dom.$('#ticket-estimate').textContent;
  assert.match(box, /Quantity: 500 unit\(s\)/, 'the full quantity is still shown');
  assert.match(box, /Estimated requirement: ₹0/, 'a pure close needs no margin');
  assert.match(box, /Closes an existing position — no new margin required/);
  assert.doesNotMatch(box, /INSUFFICIENT/, 'exiting a position you own is never unaffordable');
  assert.doesNotMatch(box, /Short proxy/, 'a close is not a short');

  // A FLIP still funds the part that opens brand-new exposure, and says how much closes.
  dom.setValue(dom.$('#t-lots'), '600');
  renderEstimate(app);
  const flip = dom.$('#ticket-estimate').textContent;
  assert.match(flip, /Estimated requirement: ₹1,30,000/, 'only the 100 new short units are margined');
  assert.match(flip, /500 of 600 unit\(s\) just close the existing position/);
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

// --- a resting F&O order cannot fill unless its chain is on screen -----------
// A limit order fills inside onPriceUpdate, when a price crosses it. Equity prices arrive on a
// background poll wherever you are in the app; option and future prices arrive ONLY from
// feedEngineFromChain, whose 6-second refresh is gated on the Chain tab being active. So a
// resting F&O order is dormant on every other tab — including the Orders tab, where you would sit
// and watch it wait — while its funds stay reserved. The pill said only "PENDING".
test('a PENDING F&O order says it can only fill with its chain open, and names the contract', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  app.engine.placeOrder({
    instrument: { kind: 'OPT', symbol: 'NIFTY', expiry: '30-Oct-2026', strike: 23500, optType: 'CE', lotSize: 75, underlyingPrice: 23500 },
    side: 'BUY', orderType: 'LIMIT', lots: 1, price: 50, limitPrice: 50,
  });
  renderOrders(app);

  const txt = dom.$('#orders-table').textContent;
  assert.match(txt, /PENDING/, 'it is still shown as pending');
  assert.match(txt, /·chain only/, 'and marked as fillable only from the chain');
  const mark = dom.document.querySelector('#orders-table .stale-mark');
  const title = mark.getAttribute('title');
  assert.match(title, /only fill while the Option Chain tab is OPEN/, 'the hover states the condition');
  assert.match(title, /NIFTY 23500 CE 30-Oct-2026/, 'it names the exact contract');
  assert.match(title, /funds stay reserved/, 'and that the money is tied up meanwhile');
});

test('CONTROL: a PENDING EQUITY order is not marked — it fills on the background poll', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  app.engine.placeOrder({
    instrument: { kind: 'EQ', symbol: 'RELIANCE', lotSize: 1 },
    side: 'BUY', orderType: 'LIMIT', lots: 10, price: 1000, limitPrice: 1000,
  });
  renderOrders(app);
  assert.match(dom.$('#orders-table').textContent, /PENDING/, 'still pending');
  assert.ok(!dom.document.querySelector('#orders-table .stale-mark'),
    'an equity order fills wherever you are, so it must NOT carry the marker');
});

test('CONTROL: a FILLED F&O order is not marked — the caveat is about resting orders only', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  app.engine.placeOrder({
    instrument: { kind: 'OPT', symbol: 'NIFTY', expiry: '30-Oct-2026', strike: 23500, optType: 'CE', lotSize: 75, underlyingPrice: 23500 },
    side: 'BUY', orderType: 'MARKET', lots: 1, price: 120,
  });
  renderOrders(app);
  assert.match(dom.$('#orders-table').textContent, /FILLED/, 'it filled immediately');
  assert.ok(!dom.document.querySelector('#orders-table .stale-mark'),
    'nothing is waiting, so there is nothing to warn about');
});

// The marker is built by positions.js's shared `staleMark`, so the Orders pill inherits the same
// role/tabindex/handlers as the Positions markers — but "inherits" is an assumption until it is
// driven. HOVERS DO NOT EXIST ON TOUCH, and this pill is the only place the reason is written, so
// on a phone a non-tappable marker means the caveat is unreadable rather than merely inconvenient.
// The positions table has this lock; the pill did not, and a divergence would be silent.
test('the ·chain only pill is tappable and keyboard-activatable, like the position markers', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  app.engine.placeOrder({
    instrument: { kind: 'OPT', symbol: 'NIFTY', expiry: '30-Oct-2026', strike: 23500, optType: 'CE', lotSize: 75, underlyingPrice: 23500 },
    side: 'BUY', orderType: 'LIMIT', lots: 1, price: 50, limitPrice: 50,
  });
  renderOrders(app);

  const mark = dom.document.querySelector('#orders-table .stale-mark');
  assert.ok(mark, 'the dormant order carries a marker');
  assert.equal(mark.getAttribute('role'), 'button', 'it is announced as something you can activate');
  assert.equal(mark.getAttribute('tabindex'), '0', 'and it is reachable by keyboard');

  mark.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(dom.alerts.length, 1, 'a tap shows the reason');
  assert.equal(dom.alerts[0], mark.getAttribute('title'), 'the same text the hover carries');
  assert.match(dom.alerts[0], /only fill while the Option Chain tab is OPEN/, 'and it is the dormancy reason');

  // A role with no key handler is a dead tab stop — worse than no role at all.
  mark.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  mark.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  mark.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  assert.equal(dom.alerts.length, 3, 'Enter and Space activate it; an ordinary key does not');
});

// --- the ticket fills a MARKET order at the same frozen price ----------------
// A MARKET order with no typed price fills at whatever the engine last saw. For a contract
// nothing is feeding, that is the frozen mark — so an offsetting sell typed into the ticket
// booked realised P&L against a stale price in silence, one tab away from the Close button that
// now asks. Same act, same consequence, so the same warning.
const optTicket = (dom, side) => {
  dom.setValue(dom.$('#t-kind'), 'OPT');
  dom.setValue(dom.$('#t-symbol'), 'NIFTY');
  dom.setValue(dom.$('#t-expiry'), '30-Oct-2026');
  dom.setValue(dom.$('#t-strike'), '23500');
  dom.setValue(dom.$('#t-opttype'), 'CE');
  dom.setValue(dom.$('#t-lotsize'), '75');
  dom.setValue(dom.$('#t-lots'), '1');
  dom.setValue(dom.$('#t-side'), side);
  dom.setValue(dom.$('#t-ordertype'), 'MARKET');
  dom.setValue(dom.$('#t-price'), ''); // no price typed -> the engine's last mark is used
  dom.submit('#order-ticket');
};

test('a MARKET ticket order on an unfed contract asks before filling at the frozen price', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  // A last-seen mark exists (as it would after a fill) but nothing is feeding the contract.
  app.engine.state.lastPrices['OPT:NIFTY:30-Oct-2026:23500:CE'] = 120;

  dom.setConfirm(false);
  optTicket(dom, 'BUY');
  assert.equal(dom.confirms.length, 1, 'it asked');
  const msg = dom.confirms[0];
  assert.match(msg, /NOT a live price/, 'and said why');
  assert.match(msg, /120\.00/, 'naming the price it would fill at');
  assert.match(msg, /NIFTY 30-Oct-2026/, 'and the contract nothing is feeding');
  // A ticket order may be OPENING the position: the mark came from the chain, not a fill, and
  // nothing realised is booked. The shared Close text once said both — false here, on both counts.
  assert.match(msg, /this order will fill against it/, 'the consequence is a fill, not a booked P&L');
  assert.ok(!/realised P&L/.test(msg), 'an opening order books no realised P&L');
  assert.ok(!/filled at/.test(msg), 'and there was no fill to have been "filled at"');
  assert.equal(app.engine.state.orders.length, 0, 'cancelling places NO order at all');
});

test('CONTROL: a MARKET ticket order on an EQUITY never asks', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  // ★ FED through the real door, not written into `lastPrices` by hand. `updateEquityPrice` is what
  // `app.pollQuotes` calls every 5s, and it is the only path that stamps `lastPriceAt`. Assigning
  // the price directly builds a state the app never sits in — a price nothing ever quoted — and the
  // control passed only because `priceIsLive` used to exempt equities by KIND. With that exemption
  // gone (a single dead symbol was being waved through), the fixture has to feed it for real.
  app.engine.updateEquityPrice('RELIANCE', 1200, true);
  dom.setConfirm(false);
  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-lots'), '10');
  dom.setValue(dom.$('#t-ordertype'), 'MARKET');
  dom.setValue(dom.$('#t-price'), '');
  dom.submit('#order-ticket');
  assert.equal(dom.confirms.length, 0, 'equities are polled wherever you are — no question to ask');
  assert.equal(app.engine.state.orders.length, 1, 'and the order went through in one step');
});

test('CONTROL: a TYPED price is your own number, so the ticket does not ask', () => {
  const dom = setupDom();
  const app = mountOrders(dom);
  app.engine.state.lastPrices['OPT:NIFTY:30-Oct-2026:23500:CE'] = 120;
  dom.setConfirm(false);
  dom.setValue(dom.$('#t-kind'), 'OPT');
  dom.setValue(dom.$('#t-symbol'), 'NIFTY');
  dom.setValue(dom.$('#t-expiry'), '30-Oct-2026');
  dom.setValue(dom.$('#t-strike'), '23500');
  dom.setValue(dom.$('#t-opttype'), 'CE');
  dom.setValue(dom.$('#t-lotsize'), '75');
  dom.setValue(dom.$('#t-lots'), '1');
  dom.setValue(dom.$('#t-ordertype'), 'MARKET');
  dom.setValue(dom.$('#t-price'), '135'); // typed by hand
  dom.submit('#order-ticket');
  assert.equal(dom.confirms.length, 0, 'the stale mark is not being used, so there is nothing to warn about');
  assert.equal(app.engine.state.orders.length, 1);
});
