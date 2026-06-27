// ---------------------------------------------------------------------------
// test/ui-chart-header.test.mjs
// The chart-header change figure must TRACK THE SELECTED TIMEFRAME: on 1D it
// shows the quote's daily change (vs the previous close); switching to 1W/1M/…
// shows the move OVER THE DISPLAYED RANGE (latest price vs the first plotted
// close), labelled with the period.
//
// It boots the REAL app.js (entry point) against a stubbed /api, then clicks the
// 1W timeframe button and asserts #chart-ltp updates. (app.js's main() runs once
// per process; this is its own file so the boot is isolated.)
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, syntheticChain } from '../test-helpers/dom-harness.mjs';

const flush = () => new Promise((r) => setTimeout(r, 0));

test('the chart-header change tracks the selected timeframe (1D daily vs 1W range move)', async () => {
  const dom = setupDom();
  // A NIFTY quote with a small DAILY change (+0.50%), but a history whose FIRST
  // plotted close (100) is well below the live price (110) — so the RANGE move is
  // a clearly different +10%. That contrast is what proves the header switched
  // from "daily" to "this period".
  globalThis.fetch = async (url) => {
    const u = String(url);
    let data = {};
    if (u.includes('/api/status')) data = { market: { state: 'REGULAR', isOpen: true }, health: { yahoo: { ok: true }, nse: { ok: true } }, holidays: [] };
    else if (u.includes('/api/quote')) data = { symbol: 'NIFTY', ltp: 110, change: 0.55, changePct: 0.5, source: 'live' };
    else if (u.includes('/api/history')) data = { candles: [{ t: 1, c: 100 }, { t: 2, c: 104 }, { t: 3, c: 108 }] };
    else if (u.includes('/api/expiries')) data = { symbol: 'NIFTY', expiries: ['26-Jun-2026'] };
    else if (u.includes('/api/option-chain')) data = syntheticChain('NIFTY');
    return { ok: true, status: 200, json: async () => data };
  };
  // Stub setInterval so app.js's polling loop doesn't keep the process alive (and
  // so no background poll re-renders the header out from under the assertions).
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => 0;
  try {
    await import('../public/js/app.js');
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  await flush();
  await flush();

  // Default timeframe is 1D: the header shows the quote's DAILY change (+0.50%),
  // with NO period tag.
  const h1d = dom.$('#chart-ltp').innerHTML;
  assert.match(h1d, /0\.50%/, '1D shows the quote daily change');
  assert.ok(!/>1[WMY]</.test(h1d), '1D carries no period tag');

  // Switch to 1W: the header now shows the move OVER THE RANGE (110 vs first close
  // 100 = +₹10.00 / +10.00%) and a "1W" tag — the change now tracks the timeframe.
  dom.fire(dom.$('#chart-timeframes .tf-btn[data-tf="1W"]'), 'click');
  await flush();
  await flush();
  const h1w = dom.$('#chart-ltp').innerHTML;
  assert.match(h1w, /10\.00%/, '1W shows the +10% move over the displayed range (not the daily +0.50%)');
  assert.match(h1w, /\+₹10\.00/, 'the absolute ₹ range move is shown');
  assert.match(h1w, />1W</, '1W is labelled as the period');
  assert.ok(!/0\.50%/.test(h1w), 'the daily +0.50% is REPLACED by the period move, not shown alongside it');
});
