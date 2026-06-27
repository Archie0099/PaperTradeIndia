// ---------------------------------------------------------------------------
// test/ui-poll.test.mjs
// Locks the polling fix (external bug report, item 2): symbolsToPoll() must
// request a quote for the UNDERLYING of any open OPT/FUT position — not just for
// equity positions — so the portfolio Greeks (which reprice each option off the
// live underlying spot, see ui/positions.js portfolioGreeks) and the strategy
// spot stay current instead of frozen at the trade-time snapshot until that
// symbol happens to be in the watchlist or its chain tab is open.
//
// We boot the REAL app.js (its main() runs on import) with a portfolio seeded in
// localStorage that holds an option and a future on underlyings that are NOT in
// the default watchlist, then assert their underlyings were polled. node --test
// isolates each test file in its own process, so app.js's main() runs fresh here
// even though ui-bootstrap.test.mjs also imports it.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));

test('an open OPT/FUT position gets its underlying polled for quotes', async () => {
  const dom = setupDom();

  // Underlyings deliberately NOT in DEFAULT_WATCH (NIFTY/BANKNIFTY/RELIANCE/TCS/
  // INFY) and not the active symbol (NIFTY), so the ONLY route to a quote for
  // them is the open-position branch of symbolsToPoll().
  const optKey = 'OPT:ZZOPT:26-Jun-2026:100:CE';
  const futKey = 'FUT:ZZFUT:26-Jun-2026';
  const portfolio = {
    positions: {
      [optKey]: {
        instrument: { kind: 'OPT', symbol: 'ZZOPT', expiry: '26-Jun-2026', strike: 100, optType: 'CE', lotSize: 50, underlyingPrice: 100 },
        qty: 50, avgPrice: 5, realised: 0,
      },
      [futKey]: {
        instrument: { kind: 'FUT', symbol: 'ZZFUT', expiry: '26-Jun-2026', lotSize: 25 },
        qty: 25, avgPrice: 200, realised: 0,
      },
    },
    lastPrices: { [optKey]: 5, [futKey]: 200 },
    // A RESTING limit order on a symbol in neither the watchlist nor the positions —
    // regression: symbolsToPoll() used to omit pending-order symbols, so this order
    // could NEVER fill (its quote was never fetched) and its reserved funds stayed
    // locked until ZZLIMIT was watched again. The quote stub below returns ltp 45 for
    // ZZLIMIT, which crosses the BUY limit of 50 — so the very first poll must both
    // REQUEST the quote and FILL the order.
    orders: [{
      id: 'ord-zzlimit', ts: 1, instrument: { kind: 'EQ', symbol: 'ZZLIMIT', lotSize: 1 },
      label: 'ZZLIMIT', side: 'BUY', orderType: 'LIMIT', lots: 5, qty: 5, limitPrice: 50,
      status: 'PENDING', reason: null, fillPrice: null, fillTs: null,
    }],
  };
  // The engine reads this on construction (STORAGE_KEY = 'paper-trade-india:v1'),
  // which happens when app.js is evaluated below — so it MUST be set first.
  dom.store.set('paper-trade-india:v1', JSON.stringify(portfolio));

  // Capture every /api/quote symbol; return canned data for everything else.
  const quoteUrls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/quote')) {
      quoteUrls.push(u);
      // ZZLIMIT quotes at 45 so the seeded resting BUY LIMIT @50 crosses and fills.
      const ltp = /symbol=ZZLIMIT/.test(u) ? 45 : 100;
      return { ok: true, status: 200, json: async () => ({ symbol: 'X', ltp, changePct: 0, source: 'live' }) };
    }
    if (u.includes('/api/status')) {
      return { ok: true, status: 200, json: async () => ({ market: { state: 'REGULAR', isOpen: true }, health: { yahoo: { ok: true }, nse: { ok: true } }, holidays: [] }) };
    }
    if (u.includes('/api/history')) return { ok: true, status: 200, json: async () => ({ candles: [{ t: 1, c: 100 }] }) };
    if (u.includes('/api/option-chain')) return { ok: true, status: 200, json: async () => ({ symbol: 'NIFTY', underlying: 100, expiry: '26-Jun-2026', rows: [] }) };
    if (u.includes('/api/expiries')) return { ok: true, status: 200, json: async () => ({ symbol: 'NIFTY', expiries: ['26-Jun-2026'] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  // Stub setInterval so app.js's polling timers don't keep the runner alive.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try {
    await import('../public/js/app.js'); // runs main() -> immediate pollQuotes()
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  // Let the immediate (un-awaited) status/quote/history polls settle.
  await flush();
  await flush();

  assert.ok(quoteUrls.some((u) => /symbol=ZZOPT/.test(u)), "an open option's underlying (ZZOPT) must be polled");
  assert.ok(quoteUrls.some((u) => /symbol=ZZFUT/.test(u)), "an open future's underlying (ZZFUT) must be polled");
  // The pending-order symbol was polled AND the crossing quote actually filled it —
  // the resting limit no longer sits unfillable on an un-watched symbol (regression).
  assert.ok(quoteUrls.some((u) => /symbol=ZZLIMIT/.test(u)), 'a resting limit order symbol must be polled');
  const ordersText = dom.$('#orders-table').textContent;
  assert.match(ordersText, /ZZLIMIT/, 'the resting order is in the history');
  assert.ok(dom.$('#orders-table .pill.FILLED'), 'the crossing poll quote FILLED the resting limit');
});
