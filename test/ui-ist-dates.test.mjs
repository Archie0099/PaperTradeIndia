// ---------------------------------------------------------------------------
// test/ui-ist-dates.test.mjs
// Locks the IST-rendering discipline for displayed dates/times (regression):
// 'en-IN' in toLocaleDateString/toLocaleTimeString sets only the FORMAT — the
// timezone silently defaulted to the HOST's, so a viewer west of UTC saw NSE's
// 09:15-IST timestamps rendered a calendar day earlier than the same page's IST
// chart axis (and a fill "time" of 20:45 for the market open). Every date/time
// render site now passes { timeZone: 'Asia/Kolkata' }; this file re-runs one
// representative site (the Orders trade-log time) under a FORCED non-IST host
// timezone, so the regression genuinely fails without the option.
//
// The TZ override must land BEFORE the process touches any Date formatting —
// node --test gives each file its own process, and the imports below are DYNAMIC
// so this assignment executes first.
// ---------------------------------------------------------------------------
process.env.TZ = 'America/Los_Angeles';

const { test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { setupDom } = await import('../test-helpers/dom-harness.mjs');
const { renderOrders } = await import('../public/js/ui/orders.js');

test('the Orders trade-log time renders in IST regardless of the host timezone', () => {
  // Sanity: the TZ override took effect in this process (otherwise the test would
  // pass trivially on an IST host — make that visible instead of silent).
  const probe = new Date(1781667900000); // 2026-06-17T03:45:00Z = 09:15 IST market open
  const hostRender = probe.toLocaleTimeString('en-IN', { hour12: false });
  assert.notEqual(hostRender, '09:15:00', `expected a non-IST host clock for this test (TZ override not honoured? host rendered ${hostRender})`);

  const dom = setupDom();
  const app = dom.makeApp();
  app.engine.reset(1_000_000);
  const res = app.engine.placeOrder({
    instrument: { kind: 'EQ', symbol: 'RELIANCE', lotSize: 1 },
    side: 'BUY', orderType: 'MARKET', lots: 1, price: 2500,
  });
  res.ts = 1781667900000; // pin the fill to the 09:15 IST market open
  renderOrders(app);
  const row = dom.$('#orders-table tbody tr').textContent;
  assert.match(row, /09:15:00/, `the fill time renders as the IST market open, not the host's ${hostRender} (row: ${row.slice(0, 60)})`);
});
