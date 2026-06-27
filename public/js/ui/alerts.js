// ---------------------------------------------------------------------------
// ui/alerts.js
// Client-side price alerts: set "SYMBOL ≥/≤ price"; when a polled quote meets
// the condition, the alert fires once (marked triggered) and a toast pops up.
// Alerts persist in localStorage. Purely informational — no orders are placed.
// ---------------------------------------------------------------------------

import { $, el, clear } from './dom.js';

const ALERTS_KEY = 'paper-trade-india:alerts';
let idCounter = 0;

function loadAlerts() {
  try {
    const raw = localStorage.getItem(ALERTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .filter((a) => a && typeof a.symbol === 'string' && Number.isFinite(a.price))
          // Normalise the operator so a corrupted/missing op can't silently act
          // as 'below' (anything not exactly 'below' means 'above').
          .map((a) => ({ ...a, op: a.op === 'below' ? 'below' : 'above', triggered: !!a.triggered }));
      }
    }
  } catch {}
  return [];
}

function saveAlerts(list) {
  try {
    localStorage.setItem(ALERTS_KEY, JSON.stringify(list));
  } catch {}
}

function initAlerts(app) {
  app.state.alerts = loadAlerts();

  $('#alert-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const symbol = $('#alert-symbol').value.trim().toUpperCase();
    const op = $('#alert-op').value === 'below' ? 'below' : 'above';
    const price = Number($('#alert-price').value);
    if (!symbol || !Number.isFinite(price) || price <= 0) return;
    app.state.alerts.push({ id: `al-${++idCounter}-${Date.now().toString(36)}`, symbol, op, price, triggered: false });
    saveAlerts(app.state.alerts);
    $('#alert-symbol').value = '';
    $('#alert-price').value = '';
    renderAlerts(app);
  });

  renderAlerts(app);
}

function renderAlerts(app) {
  const root = clear($('#alerts-list'));
  const alerts = app.state.alerts || [];
  if (alerts.length === 0) {
    root.append(el('div', { class: 'empty-state' }, 'No alerts set.'));
    return;
  }
  for (const a of alerts) {
    const row = el('div', { class: 'alert-item' + (a.triggered ? ' triggered' : '') }, [
      el('span', {}, `${a.symbol} ${a.op === 'above' ? '≥' : '≤'} ${a.price}${a.triggered ? '  ✓ hit' : ''}`),
    ]);
    const rm = el('button', { class: 'w-remove', title: 'Remove', 'aria-label': `Remove alert ${a.symbol}` }, '×');
    rm.addEventListener('click', () => {
      app.state.alerts = app.state.alerts.filter((x) => x !== a);
      saveAlerts(app.state.alerts);
      renderAlerts(app);
    });
    row.append(rm);
    root.append(row);
  }
}

// Check every untriggered alert against the latest quotes; mark + return those
// that just fired. (Toasts are shown by the caller so this stays timer-free and
// easy to unit test.)
function checkAlerts(app) {
  const fired = [];
  for (const a of app.state.alerts || []) {
    if (a.triggered) continue;
    const q = app.state.quotes[a.symbol];
    if (!q || !(q.ltp > 0)) continue;
    const hit = a.op === 'above' ? q.ltp >= a.price : q.ltp <= a.price;
    if (hit) {
      a.triggered = true;
      fired.push(a);
    }
  }
  if (fired.length) {
    saveAlerts(app.state.alerts);
    renderAlerts(app);
  }
  return fired;
}

// A transient toast in the bottom-right. Self-removes after a few seconds.
function showToast(message) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = el('div', { id: 'toasts', class: 'toasts' });
    document.body.append(host);
  }
  const toast = el('div', { class: 'toast' }, message);
  host.append(toast);
  setTimeout(() => toast.remove(), 6000);
}

export { initAlerts, renderAlerts, checkAlerts, showToast };
