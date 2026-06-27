// ---------------------------------------------------------------------------
// ui/statusbar.js
// Drives the top status bar: live IST clock, market state, data source health,
// balance, and the big "MARKET CLOSED / data is stale" alert banner.
// ---------------------------------------------------------------------------

import { $, rupee } from './dom.js';
import { getMarketState, istClockString } from '../core/marketHours.js';

// Tick the clock + market state every second (cheap, no network).
function startClock(app) {
  function tick() {
    $('#ist-clock').textContent = istClockString();
    const holidays = (app.state.status && app.state.status.holidays) || undefined;
    const m = getMarketState(new Date(), holidays);
    app.state.market = m;

    const stateEl = $('#market-state');
    stateEl.textContent = m.state === 'REGULAR' ? 'OPEN' : m.state;
    stateEl.className =
      'status-value ' +
      (m.isOpen ? 'state-open' : m.state === 'PREOPEN' ? 'state-preopen' : 'state-closed');

    updateBanner(app, m);
  }
  tick();
  setInterval(tick, 1000);
}

// Show the prominent banner when the market is closed or data is stale.
function updateBanner(app, market) {
  const banner = $('#alert-banner');
  const dataStale = app.state.dataStale;

  if (!market.isOpen) {
    banner.className = 'alert-banner bad';
    banner.textContent =
      market.state === 'PREOPEN'
        ? `PRE-OPEN — ${market.reason}. Orders simulate against last prices.`
        : `MARKET CLOSED — ${market.reason}. Prices shown are the last available and may be STALE.`;
  } else if (dataStale) {
    banner.className = 'alert-banner warn';
    banner.textContent = 'LIVE DATA UNAVAILABLE — showing last cached / synthetic prices. They may be stale.';
  } else {
    banner.className = 'alert-banner hidden';
    banner.textContent = '';
  }
}

// Update the data-source indicator + balance after each status/quote refresh.
function renderStatusBar(app) {
  const balance = app.engine.equity();
  $('#balance').textContent = rupee(balance, 0);

  const ds = $('#data-source');
  const health = app.state.status && app.state.status.health;
  if (!health) {
    ds.textContent = '—';
    return;
  }
  // Summarise which upstreams are reachable.
  const parts = [];
  if (health.yahoo.ok === true) parts.push('Yahoo✓');
  else if (health.yahoo.ok === false) parts.push('Yahoo✗');
  if (health.nse.ok === true) parts.push('NSE✓');
  else if (health.nse.ok === false) parts.push('NSE✗');
  ds.textContent = parts.length ? parts.join(' ') : 'Yahoo + NSE';

  // App-wide "stale" flag drives the big banner, so it must track only the
  // source feeding the VISIBLE prices — Yahoo (equity/index quotes + history).
  // An NSE outage affects only the option chain, which already falls back to
  // cached/synthetic data and labels its own source IN that tab; it must NOT
  // flip a global "all prices are stale" banner while Yahoo is live.
  app.state.dataStale = health.yahoo.ok === false;
}

// updateBanner is exported so tests can drive each banner branch (closed /
// pre-open / stale / clear) deterministically with a known market state,
// without waiting on the live clock's setInterval.
export { startClock, renderStatusBar, updateBanner };
