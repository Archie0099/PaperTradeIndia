// ---------------------------------------------------------------------------
// test/ui-bootstrap.test.mjs
// The end-to-end boot test: it imports the REAL entry point (public/js/app.js),
// which runs main() — building the engine, wiring every UI module, starting the
// clock, and kicking off polling — then drives a real order through the ticket.
//
// This is the one test that exercises app.js's own glue (the part a per-module
// test can't reach). Because ES modules evaluate once per process, app.js's
// main() runs a single time, so ALL bootstrap assertions live in one test.
//
// We stub global fetch (canned /api data) and setInterval (so the polling loop
// doesn't leak a live timer and hang the runner).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, syntheticChain } from '../test-helpers/dom-harness.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));

// Route the same-origin /api/* calls app.js makes to canned data.
function installFetchStub() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    let data = {};
    if (u.includes('/api/status')) {
      data = { market: { state: 'REGULAR', isOpen: true }, health: { yahoo: { ok: true }, nse: { ok: true } }, holidays: [] };
    } else if (u.includes('/api/quote')) {
      // The deliberately-invalid symbol 404s, so its quote never arrives —
      // used to test that the chart header clears.
      if (u.includes('ZZINVALID')) return { ok: false, status: 404, json: async () => ({ error: 'Unknown symbol' }) };
      data = { symbol: 'NIFTY', ltp: 100, changePct: 1.5, source: 'live' };
    } else if (u.includes('/api/history')) {
      data = { candles: [{ t: 1, c: 100 }, { t: 2, c: 101 }, { t: 3, c: 99 }] };
    } else if (u.includes('/api/option-chain')) {
      data = syntheticChain('NIFTY');
    } else if (u.includes('/api/expiries')) {
      data = { symbol: 'NIFTY', expiries: ['26-Jun-2026'] };
    }
    return { ok: true, status: 200, json: async () => data };
  };
}

test('app.js boots, renders the initial UI, and places an order end-to-end', async () => {
  const dom = setupDom();
  installFetchStub();
  // Capture which /api/history and /api/quote requests are made (timeframe +
  // alert-polling wiring checks).
  const historyUrls = [];
  const quoteUrls = [];
  const baseFetch = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => {
    const u = String(url);
    if (u.includes('/api/history')) historyUrls.push(u);
    if (u.includes('/api/quote')) quoteUrls.push(u);
    return baseFetch(url, ...rest);
  };
  // Seed a price alert for a symbol that is NOT in the default watchlist; its
  // price is unreachable so it won't fire (no toast timer) — we only check it
  // gets polled (bug: symbolsToPoll used to omit alert symbols).
  dom.store.set('paper-trade-india:alerts', JSON.stringify([{ symbol: 'ZZALERT', op: 'above', price: 999999, triggered: false }]));

  // Import (and thereby run) the real app.js with timers stubbed so the polling
  // intervals it registers don't keep the test process alive.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try {
    await import('../public/js/app.js');
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  // Let the immediate (un-awaited) status/quote/history polls settle.
  await flush();
  await flush();

  // --- initial render -----------------------------------------------------
  assert.match(dom.$('#balance').textContent, /₹1,00,00,000/, 'balance shows the ₹1 crore starting equity (the real-app default)');
  assert.match(dom.$('#positions-table').textContent, /No open positions/);
  assert.notEqual(dom.$('#market-state').textContent, '—', 'market state was computed');
  assert.match(dom.$('#ist-clock').textContent, /^\d{2}:\d{2}:\d{2}$/, 'live clock ticking');
  assert.equal(dom.$('#chart-symbol').textContent, 'NIFTY', 'active symbol seeded the chart');
  assert.ok(quoteUrls.some((u) => /symbol=ZZALERT/.test(u)), 'an alert-only symbol is polled so the alert can fire');

  // --- place a real order through the ticket -------------------------------
  dom.setValue(dom.$('#t-kind'), 'EQ');
  dom.setValue(dom.$('#t-symbol'), 'RELIANCE');
  dom.setValue(dom.$('#t-lots'), '10');
  dom.setValue(dom.$('#t-price'), '2500');
  dom.submit('#order-ticket');

  // The order history shows a FILLED RELIANCE order and a position appears —
  // proving the full chain: form -> engine.placeOrder -> emit -> re-render.
  const orders = dom.$('#orders-table').textContent;
  assert.match(orders, /RELIANCE/);
  assert.ok(dom.$('#orders-table .pill.FILLED'), 'a FILLED pill should render');
  assert.match(dom.$('#positions-table').textContent, /RELIANCE/, 'a position now exists');
  assert.ok(dom.$('#tab-orders').classList.contains('active'), 'submitting jumps to Orders');

  // --- square off all (richer order types) -----------------------------------
  dom.fire(dom.$('#btn-square-off'), 'click');
  assert.match(dom.$('#positions-table').textContent, /No open positions/, 'square-off closed everything');

  // --- the strategy spot is seeded ONCE, then left alone ---------------------
  // Active symbol is still NIFTY (quote ltp 100). First open seeds the spot.
  dom.fire(dom.$('.nav-btn[data-tab="strategy"]'), 'click');
  assert.equal(dom.$('#strat-spot').value, '100', 'spot seeded from the live quote on first open');
  dom.setValue(dom.$('#strat-spot'), '12345'); // user overrides it
  dom.fire(dom.$('.nav-btn[data-tab="dashboard"]'), 'click');
  dom.fire(dom.$('.nav-btn[data-tab="strategy"]'), 'click'); // re-show
  assert.equal(dom.$('#strat-spot').value, '12345', 're-showing the tab must not clobber the typed spot');

  // --- resizing while on Strategy redraws without throwing -------------------
  assert.doesNotThrow(() => dom.fire(dom.window, 'resize'));

  // --- selecting a symbol with no quote clears the chart header --------------
  dom.setValue(dom.$('#watch-input'), 'ZZINVALID'); // its /api/quote 404s
  dom.submit('#watch-form');
  await flush();
  dom.fire(dom.$('#watchlist .watch-item[data-symbol="ZZINVALID"]'), 'click');
  await flush();
  assert.equal(dom.$('#chart-symbol').textContent, 'ZZINVALID');
  assert.equal(dom.$('#chart-ltp').textContent, '', 'header must not show the previous symbol\'s price');

  // --- chart timeframe buttons (1D / 1W / 1M / 1Y / Max) ---------------------
  // Default is 1M; switching to 1Y reloads history with range=1y and activates
  // the 1Y button (deactivating 1M).
  dom.fire(dom.$('#chart-timeframes .tf-btn[data-tf="1Y"]'), 'click');
  await flush();
  assert.ok(historyUrls.some((u) => /range=1y/.test(u)), 'switching to 1Y refetches with range=1y');
  assert.ok(dom.$('#chart-timeframes .tf-btn[data-tf="1Y"]').classList.contains('active'));
  assert.ok(!dom.$('#chart-timeframes .tf-btn[data-tf="1M"]').classList.contains('active'));
});
