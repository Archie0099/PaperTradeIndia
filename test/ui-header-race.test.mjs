// ---------------------------------------------------------------------------
// test/ui-header-race.test.mjs
// Locks the chart-header race (regression): while a symbol/timeframe switch's
// history fetch is IN FLIGHT, the 5s quote poll used to re-render the header by
// pairing the NEW symbol's quote with the PREVIOUS selection's candles —
// fabricating a wild cross-symbol "change" (e.g. "-94.58% 1W") and re-asserting
// it on every poll until the fetch landed. The candles are now STAMPED with the
// selection they were fetched for (app.js currentCandles), so a mismatch renders
// the price alone.
//
// Boots the REAL app.js (its main() runs on import) with a per-symbol-controllable
// /api/history stub, and fires the captured 5s quote-poll callback by hand.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));

test('the quote poll never pairs a symbol with another selection candles (header race regression)', async () => {
  const dom = setupDom();

  // /api/history is controllable per symbol: NIFTY resolves immediately with a
  // rising series (quote 100 vs first close 90 -> +11.11% range move); TCS HANGS
  // until released with a falling series (quote 3000 vs first close 3200 -> -6.25%).
  let releaseTcs;
  const tcsGate = new Promise((r) => { releaseTcs = r; });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/quote')) {
      const sym = (u.match(/symbol=([A-Z]+)/) || [])[1] || 'X';
      const ltp = sym === 'TCS' ? 3000 : 100;
      return { ok: true, status: 200, json: async () => ({ symbol: sym, ltp, change: 1, changePct: 1, source: 'live' }) };
    }
    if (u.includes('/api/status')) {
      return { ok: true, status: 200, json: async () => ({ market: { state: 'REGULAR', isOpen: true }, health: { yahoo: { ok: true }, nse: { ok: true } }, holidays: [] }) };
    }
    if (u.includes('/api/history')) {
      if (/symbol=TCS/.test(u)) {
        await tcsGate;
        return { ok: true, status: 200, json: async () => ({ candles: [{ t: 1, c: 3200 }, { t: 2, c: 2900 }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ candles: [{ t: 1, c: 90 }, { t: 2, c: 95 }] }) };
    }
    if (u.includes('/api/option-chain')) return { ok: true, status: 200, json: async () => ({ symbol: 'NIFTY', underlying: 100, expiry: '26-Jun-2026', rows: [] }) };
    if (u.includes('/api/expiries')) return { ok: true, status: 200, json: async () => ({ symbol: 'NIFTY', expiries: ['26-Jun-2026'] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };

  // Capture the polling intervals so the 5s quote poll can be fired BY HAND.
  const intervals = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return 0; };
  try {
    await import('../public/js/app.js');
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  await flush();
  await flush();
  const quotePoll = intervals.find((i) => i.ms === 5000);
  assert.ok(quotePoll, 'the 5s quote poll was registered');

  // Switch NIFTY to 1Y: its candles land and the header shows the +11.11% range move.
  dom.fire(dom.$('#chart-timeframes .tf-btn[data-tf="1Y"]'), 'click');
  await flush();
  await flush();
  assert.match(dom.$('#chart-ltp').innerHTML, /11\.11%/, 'NIFTY 1Y header shows its own range change');

  // Select TCS — its history fetch HANGS. The header shows the TCS price ALONE.
  dom.fire(dom.$('#watchlist .watch-item[data-symbol="TCS"]'), 'click');
  await flush();
  assert.match(dom.$('#chart-ltp').innerHTML, /3,000/, 'the TCS price shows immediately');
  assert.ok(!/%/.test(dom.$('#chart-ltp').innerHTML), 'no change figure while its candles are in flight');

  // THE RACE: a quote poll fires during the in-flight fetch. It used to pair the TCS
  // quote (3000) with NIFTY's 1Y candles (first close 90) -> a fabricated "+3233%"
  // re-asserted every 5 seconds.
  quotePoll.fn();
  await flush();
  await flush();
  const inFlight = dom.$('#chart-ltp').innerHTML;
  assert.match(inFlight, /3,000/, 'the TCS price still shows');
  assert.ok(!/%/.test(inFlight), 'the poll must NOT fabricate a change from the previous selection candles');

  // Release the TCS candles: the header now shows TCS's OWN -6.25% range move, and
  // the next poll KEEPS it (the stamp matches the live selection).
  releaseTcs();
  await flush();
  await flush();
  assert.match(dom.$('#chart-ltp').innerHTML, /6\.25%/, "TCS's own 1Y change appears once its candles land");
  quotePoll.fn();
  await flush();
  assert.match(dom.$('#chart-ltp').innerHTML, /6\.25%/, 'and the poll preserves the correct change');
});
