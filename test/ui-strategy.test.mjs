// ---------------------------------------------------------------------------
// test/ui-strategy.test.mjs
// Drives the REAL Strategy Builder tab (public/js/ui/strategy.js): template
// loading, the legs table, add/delete leg, premium editing (without stealing
// focus), the FUT-leg seeding rule, the bounded/unbounded stat labels, and
// net credit/debit. The payoff/Greeks MATH is tested elsewhere; here we assert
// the tab WIRES and RENDERS those results correctly.
//
// Note: strategy.js keeps module-level state (current legs/spot), so each test
// sets spot/days/symbol explicitly rather than relying on leaked defaults.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { initStrategy, setStrategyContext } from '../public/js/ui/strategy.js';

// Mount the builder and set a known header (symbol/spot/days).
function mount(dom, { symbol = 'NIFTY', spot = 23500, days = 7 } = {}) {
  const app = dom.makeApp();
  initStrategy(app);
  dom.setValue(dom.$('#strat-symbol'), symbol);
  dom.setValue(dom.$('#strat-spot'), spot);
  dom.setValue(dom.$('#strat-days'), days);
  return app;
}

function loadTemplate(dom, key) {
  dom.$('#strat-template').value = key;
  dom.fire(dom.$('#btn-load-template'), 'click');
}

const rows = (dom) => dom.$$('#legs-table tbody tr');
const setNum = (dom, node, v) => { node.value = String(v); dom.fire(node, 'input'); };
const setSel = (dom, node, v) => { node.value = v; dom.fire(node, 'change'); };

test('the template dropdown lists every template and a default strategy renders', () => {
  const dom = setupDom();
  mount(dom);
  assert.equal(dom.$$('#strat-template option').length, 15); // 10 base + butterfly/ratio/collar + calendar/diagonal
  assert.ok(rows(dom).length >= 1, 'a default template should populate legs');
  assert.match(dom.$('#strat-stats').textContent, /Max Profit/);
  assert.match(dom.$('#strat-stats').textContent, /Breakeven/);
  assert.match(dom.$('#strat-greeks').textContent, /Net .*Delta/);
});

test('a long call shows UNBOUNDED max profit and a bounded max loss', () => {
  const dom = setupDom();
  mount(dom);
  loadTemplate(dom, 'long_call');
  const stats = dom.$('#strat-stats').textContent;
  assert.match(stats, /Max Profit/);
  assert.match(stats, /UNBOUNDED/);
  assert.match(stats, /Net Debit/); // you pay to buy a call
});

test('a naked short put is NOT mislabelled as unbounded (at the UI level)', () => {
  const dom = setupDom();
  mount(dom);
  loadTemplate(dom, 'short_put');
  const stats = dom.$('#strat-stats').textContent;
  assert.doesNotMatch(stats, /UNBOUNDED/);
  assert.match(stats, /Net Credit/); // you receive premium
});

test('"+ Leg" adds a row and the × button removes one', () => {
  const dom = setupDom();
  mount(dom);
  loadTemplate(dom, 'long_call'); // 1 leg
  assert.equal(rows(dom).length, 1);

  dom.fire(dom.$('#btn-add-leg'), 'click');
  assert.equal(rows(dom).length, 2);

  // Delete the last row via its × button (column 8).
  dom.fire(rows(dom)[1].querySelector('td:nth-child(9) button'), 'click');
  assert.equal(rows(dom).length, 1);
});

test('deleting every leg shows the empty state without crashing', () => {
  const dom = setupDom();
  mount(dom);
  loadTemplate(dom, 'long_call');
  // Remove all current legs.
  while (rows(dom).length) {
    dom.fire(rows(dom)[0].querySelector('td:nth-child(9) button'), 'click');
  }
  assert.match(dom.$('#legs-table').textContent, /No legs/);
});

test('editing a premium recomputes WITHOUT rebuilding the legs table (no focus steal)', () => {
  const dom = setupDom();
  mount(dom);
  loadTemplate(dom, 'long_call');

  const premInput = rows(dom)[0].querySelector('td:nth-child(4) input');
  const before = dom.$('#strat-stats').textContent;
  setNum(dom, premInput, 999);

  // The very same input node must still be live (recompute() must not re-render
  // the legs table, or a user typing would lose focus mid-keystroke).
  assert.ok(premInput.isConnected, 'the premium input node should survive a recompute');
  assert.equal(rows(dom)[0].querySelector('td:nth-child(4) input'), premInput);
  // And the stats must have actually changed (net debit reflects the new premium).
  assert.notEqual(dom.$('#strat-stats').textContent, before);
});

test('switching a leg to FUT seeds its entry price from spot and disables strike/IV', () => {
  const dom = setupDom();
  mount(dom, { spot: 23500 });
  // Start clean: one fresh blank leg (premium 0) so the FUT-seeding rule fires.
  while (rows(dom).length) dom.fire(rows(dom)[0].querySelector('td:nth-child(9) button'), 'click');
  dom.fire(dom.$('#btn-add-leg'), 'click');

  const typeSel = rows(dom)[0].querySelector('td:nth-child(2) select');
  setSel(dom, typeSel, 'FUT');

  const row = rows(dom)[0];
  assert.equal(row.querySelector('td:nth-child(4) input').value, '23500'); // premium seeded to spot
  assert.ok(row.querySelector('td:nth-child(3) input').disabled, 'strike disabled for FUT');
  assert.ok(row.querySelector('td:nth-child(5) input').disabled, 'IV disabled for FUT');
});

test('setStrategyContext pushes a symbol and spot into the builder', () => {
  const dom = setupDom();
  const app = mount(dom);
  setStrategyContext(app, 'BANKNIFTY', 45000);
  assert.equal(dom.$('#strat-symbol').value, 'BANKNIFTY');
  assert.equal(dom.$('#strat-spot').value, '45000');
});

// --- regression tests for confirmed UI bugs --------------------------------

test('seeding a new spot re-strikes the template legs to match it', () => {
  const dom = setupDom();
  const app = mount(dom, { symbol: 'NIFTY', spot: 23500 });
  loadTemplate(dom, 'long_call'); // CE struck ~23500
  setStrategyContext(app, 'NIFTY', 20000); // seed a very different spot
  const strike = Number(rows(dom)[0].querySelector('td:nth-child(3) input').value);
  assert.ok(Math.abs(strike - 20000) <= 50, `leg should re-strike near 20000, got ${strike}`);
});

test('blanking the Lots field normalises to 1 on blur', () => {
  const dom = setupDom();
  mount(dom);
  loadTemplate(dom, 'long_call');
  const lotsIn = rows(dom)[0].querySelector('td:nth-child(6) input'); // Side,Type,Strike,Premium,IV,Lots
  lotsIn.value = '';
  dom.fire(lotsIn, 'change');
  assert.equal(lotsIn.value, '1', 'an empty Lots field must not coexist with a 1-lot payoff');
});

test('Lots rejects zero / negative / fractional values', () => {
  const dom = setupDom();
  mount(dom);
  loadTemplate(dom, 'long_call');
  const lotsIn = rows(dom)[0].querySelector('td:nth-child(6) input');

  lotsIn.value = '0';
  dom.fire(lotsIn, 'change');
  assert.equal(lotsIn.value, '1');

  lotsIn.value = '-5';
  dom.fire(lotsIn, 'change');
  assert.equal(lotsIn.value, '1');

  lotsIn.value = '2.7';
  dom.fire(lotsIn, 'change');
  assert.equal(lotsIn.value, '2'); // floored to a whole lot
});

test('the strategy form suppresses Enter/submit so it never reloads the page (bug #5)', () => {
  const dom = setupDom();
  mount(dom);
  const ev = new dom.window.Event('submit', { bubbles: true, cancelable: true });
  dom.$('#strat-form').dispatchEvent(ev);
  assert.equal(ev.defaultPrevented, true, 'strat-form submit must be prevented');
});

// --- strategy builder+ -----------------------------------------------------

test('loading the butterfly template respects per-leg lots (the body sells 2)', () => {
  const dom = setupDom();
  mount(dom, { spot: 23500 });
  loadTemplate(dom, 'long_call_butterfly');
  const rs = rows(dom);
  assert.equal(rs.length, 3);
  // Body leg (2nd row) Lots input is column 6.
  assert.equal(rs[1].querySelector('td:nth-child(6) input').value, '2');
});

test('the per-leg payoff breakdown renders one row per leg', () => {
  const dom = setupDom();
  mount(dom);
  loadTemplate(dom, 'long_call');
  assert.equal(dom.$$('#strat-legs-pnl tbody tr').length, 1);
  assert.match(dom.$('#strat-legs-pnl').textContent, /Payoff @ spot/);
});

test('a strategy can be saved and loaded back by name', () => {
  const dom = setupDom();
  mount(dom);
  loadTemplate(dom, 'long_call'); // 1 leg
  dom.setValue(dom.$('#strat-spot'), '20000');
  dom.$('#strat-name').value = 'my-call';
  dom.fire(dom.$('#btn-save-strat'), 'click');

  // Change to a different strategy/spot...
  dom.setValue(dom.$('#strat-spot'), '23500');
  loadTemplate(dom, 'iron_condor');
  assert.equal(rows(dom).length, 4);

  // ...then load the saved one back.
  dom.$('#strat-saved-list').value = 'my-call';
  dom.fire(dom.$('#btn-load-strat'), 'click');
  assert.equal(rows(dom).length, 1, 'restored the 1-leg saved strategy');
  assert.equal(dom.$('#strat-spot').value, '20000');
});

test('"Load my positions" pulls open F&O into the builder', () => {
  const dom = setupDom();
  const app = mount(dom, { symbol: 'NIFTY' });
  app.engine.placeOrder({
    instrument: { kind: 'OPT', symbol: 'NIFTY', expiry: '26-Jun-2026', strike: 23500, optType: 'CE', lotSize: 75, underlyingPrice: 23500 },
    side: 'BUY',
    orderType: 'MARKET',
    lots: 1,
    price: 120,
  });
  dom.fire(dom.$('#btn-load-positions'), 'click');

  const rs = rows(dom);
  assert.equal(rs.length, 1);
  assert.equal(rs[0].querySelector('td:nth-child(2) select').value, 'CE'); // type
  assert.equal(rs[0].querySelector('td:nth-child(3) input').value, '23500'); // strike
  assert.equal(rs[0].querySelector('td:nth-child(4) input').value, '120'); // premium = entry
});

test('changing the header Days re-times a single-expiry strategy (Greeks update)', () => {
  const dom = setupDom();
  mount(dom, { spot: 23500, days: 7 });
  loadTemplate(dom, 'long_call');
  const greeks7 = dom.$('#strat-greeks').textContent;
  dom.setValue(dom.$('#strat-days'), '60'); // re-time the whole (single-expiry) strategy
  const greeks60 = dom.$('#strat-greeks').textContent;
  assert.notEqual(greeks7, greeks60, 'the header Days must re-time the Greeks (legs are not baked to load-time days)');
});

test('the calendar template loads two legs with different expiries (multi-expiry)', () => {
  const dom = setupDom();
  mount(dom, { symbol: 'NIFTY', spot: 23500, days: 30 });
  loadTemplate(dom, 'calendar_call');
  const rs = rows(dom);
  assert.equal(rs.length, 2);
  // Days is column 8. Near = header days (30); far = +30 (60).
  const d0 = rs[0].querySelector('td:nth-child(8) input').value;
  const d1 = rs[1].querySelector('td:nth-child(8) input').value;
  assert.notEqual(d0, d1, 'the two legs have different expiries');
  // A long calendar sells the near and buys the far.
  assert.equal(rs[0].querySelector('td:nth-child(1) select').value, 'SELL');
  assert.equal(rs[1].querySelector('td:nth-child(1) select').value, 'BUY');
  // A calendar is bounded — not flagged UNBOUNDED.
  assert.doesNotMatch(dom.$('#strat-stats').textContent, /UNBOUNDED/);
});

test('"Load my positions" aligns the builder spot to the position underlying', () => {
  const dom = setupDom();
  const app = mount(dom, { symbol: 'NIFTY', spot: 1 }); // deliberately wrong spot
  app.engine.placeOrder({
    instrument: { kind: 'OPT', symbol: 'NIFTY', expiry: '26-Jun-2026', strike: 23500, optType: 'CE', lotSize: 75, underlyingPrice: 23500 },
    side: 'BUY',
    orderType: 'MARKET',
    lots: 1,
    price: 120,
  });
  dom.fire(dom.$('#btn-load-positions'), 'click');
  assert.equal(dom.$('#strat-spot').value, '23500', 'spot realigned to the underlying, not the stale 1');
});
