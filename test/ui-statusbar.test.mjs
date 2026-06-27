// ---------------------------------------------------------------------------
// test/ui-statusbar.test.mjs
// Two things in one file:
//   1. The REAL status bar UI (public/js/ui/statusbar.js): balance, the data
//      -source health indicator + stale flag, the alert banner branches, and a
//      smoke test of the live clock wiring.
//   2. The client market-hours clock (public/js/core/marketHours.js), which was
//      a near-duplicate of the (tested) server logic but itself untested. We
//      pin it with absolute UTC instants so the result is the same on any
//      machine timezone.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { renderStatusBar, updateBanner, startClock } from '../public/js/ui/statusbar.js';
import { getMarketState, istClockString } from '../public/js/core/marketHours.js';

// --- status bar UI ---------------------------------------------------------

test('renderStatusBar shows the equity balance in rupees', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  renderStatusBar(app);
  assert.match(dom.$('#balance').textContent, /₹10,00,000/); // default ₹10L equity
});

test('the data-source indicator summarises upstream health and sets the stale flag', () => {
  const dom = setupDom();
  const app = dom.makeApp();

  app.state.status = { health: { yahoo: { ok: true }, nse: { ok: true } } };
  renderStatusBar(app);
  assert.equal(dom.$('#data-source').textContent, 'Yahoo✓ NSE✓');
  assert.equal(app.state.dataStale, false);

  app.state.status = { health: { yahoo: { ok: true }, nse: { ok: false } } };
  renderStatusBar(app);
  assert.equal(dom.$('#data-source').textContent, 'Yahoo✓ NSE✗');
  // An NSE-only outage must NOT raise the global stale banner: Yahoo still feeds
  // the visible quotes/chart, and the option chain labels its own source. Only a
  // Yahoo outage flips dataStale.
  assert.equal(app.state.dataStale, false);

  app.state.status = { health: { yahoo: { ok: false }, nse: { ok: true } } };
  renderStatusBar(app);
  assert.equal(app.state.dataStale, true); // Yahoo down -> visible prices stale
});

test('with no status payload the data source shows a dash', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  renderStatusBar(app); // status is null
  assert.equal(dom.$('#data-source').textContent, '—');
});

test('the alert banner reflects closed / pre-open / stale / clear states', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  const banner = dom.$('#alert-banner');

  updateBanner(app, { state: 'CLOSED', isOpen: false, reason: 'Weekend' });
  assert.match(banner.className, /\bbad\b/);
  assert.match(banner.textContent, /MARKET CLOSED/);

  updateBanner(app, { state: 'PREOPEN', isOpen: false, reason: 'Pre-open' });
  assert.match(banner.className, /\bbad\b/);
  assert.match(banner.textContent, /PRE-OPEN/);

  app.state.dataStale = true;
  updateBanner(app, { state: 'REGULAR', isOpen: true, reason: 'Regular session' });
  assert.match(banner.className, /\bwarn\b/);
  assert.match(banner.textContent, /LIVE DATA UNAVAILABLE/);

  app.state.dataStale = false;
  updateBanner(app, { state: 'REGULAR', isOpen: true, reason: 'Regular session' });
  assert.match(banner.className, /\bhidden\b/);
  assert.equal(banner.textContent, '');
});

test('startClock wires the live clock and market state without leaking a timer', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  dom.withoutTimers(() => startClock(app)); // setInterval stubbed -> no leak
  assert.match(dom.$('#ist-clock').textContent, /^\d{2}:\d{2}:\d{2}$/); // no "IST" suffix
  assert.notEqual(dom.$('#market-state').textContent, '—');
});

// --- client market-hours logic (timezone-independent) ----------------------

test('getMarketState: a weekday mid-session is REGULAR/open', () => {
  // 2026-06-15T04:30:00Z == Mon 10:00 IST
  const m = getMarketState(new Date('2026-06-15T04:30:00Z'));
  assert.equal(m.state, 'REGULAR');
  assert.equal(m.isOpen, true);
});

test('getMarketState: 09:00-09:15 IST is PREOPEN (not open)', () => {
  // 2026-06-15T03:35:00Z == Mon 09:05 IST
  const m = getMarketState(new Date('2026-06-15T03:35:00Z'));
  assert.equal(m.state, 'PREOPEN');
  assert.equal(m.isOpen, false);
});

test('getMarketState: before 09:00 and after 15:30 IST is CLOSED', () => {
  const before = getMarketState(new Date('2026-06-15T02:00:00Z')); // 07:30 IST
  const after = getMarketState(new Date('2026-06-15T11:00:00Z')); // 16:30 IST
  assert.equal(before.state, 'CLOSED');
  assert.equal(after.state, 'CLOSED');
});

test('getMarketState: weekends are CLOSED', () => {
  // 2026-06-13T05:00:00Z == Sat 10:30 IST
  const m = getMarketState(new Date('2026-06-13T05:00:00Z'));
  assert.equal(m.state, 'CLOSED');
  assert.match(m.reason, /Weekend/);
});

test('getMarketState: a listed exchange holiday on a weekday is CLOSED', () => {
  // 2026-10-02 is in the holiday list and falls on a Friday (10:30 IST here).
  const m = getMarketState(new Date('2026-10-02T05:00:00Z'));
  assert.equal(m.state, 'CLOSED');
  assert.match(m.reason, /holiday/i);
});

test('istClockString formats HH:MM:SS in IST', () => {
  // 2026-06-15T04:30:05Z == 10:00:05 IST (no "IST" suffix — the bar labels it)
  assert.equal(istClockString(new Date('2026-06-15T04:30:05Z')), '10:00:05');
});
