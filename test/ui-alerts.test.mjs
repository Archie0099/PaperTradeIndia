// ---------------------------------------------------------------------------
// test/ui-alerts.test.mjs
// Client-side price alerts (public/js/ui/alerts.js): add via the form, fire once
// when a quote crosses the threshold (above/below), render, and remove.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { initAlerts, checkAlerts } from '../public/js/ui/alerts.js';

function addAlert(dom, symbol, op, price) {
  dom.$('#alert-symbol').value = symbol;
  dom.$('#alert-op').value = op;
  dom.$('#alert-price').value = String(price);
  dom.submit('#alert-form');
}

test('an "above" alert fires exactly once when the quote crosses it', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initAlerts(app);

  addAlert(dom, 'NIFTY', 'above', 23600);
  assert.equal(app.state.alerts.length, 1);
  assert.match(dom.$('#alerts-list').textContent, /NIFTY/);

  app.state.quotes['NIFTY'] = { ltp: 23500 }; // below -> no fire
  assert.equal(checkAlerts(app).length, 0);

  app.state.quotes['NIFTY'] = { ltp: 23650 }; // crosses -> fires
  const fired = checkAlerts(app);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].symbol, 'NIFTY');
  assert.ok(app.state.alerts[0].triggered);
  assert.match(dom.$('#alerts-list').textContent, /hit/);

  assert.equal(checkAlerts(app).length, 0, 'does not re-fire once triggered');
});

test('a "below" alert fires when price drops, and can be removed', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initAlerts(app);

  addAlert(dom, 'RELIANCE', 'below', 2400);
  app.state.quotes['RELIANCE'] = { ltp: 2390 };
  assert.equal(checkAlerts(app).length, 1);

  dom.fire(dom.$('#alerts-list button'), 'click'); // remove via ×
  assert.equal(app.state.alerts.length, 0);
  assert.match(dom.$('#alerts-list').textContent, /No alerts/);
});

test('a persisted alert with a corrupt op is normalised to "above" on load', () => {
  const dom = setupDom();
  dom.store.set('paper-trade-india:alerts', JSON.stringify([{ symbol: 'NIFTY', op: 'GARBAGE', price: 100, triggered: false }]));
  const app = dom.makeApp();
  initAlerts(app);
  assert.equal(app.state.alerts[0].op, 'above', 'unknown op must not silently behave as "below"');
});
