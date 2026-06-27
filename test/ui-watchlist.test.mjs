// ---------------------------------------------------------------------------
// test/ui-watchlist.test.mjs
// Drives the REAL watchlist (public/js/ui/watchlist.js): default list, add /
// remove, click + keyboard to select a symbol, live LTP/% rendering, the
// localStorage persistence, and the guard against corrupted stored data.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { initWatchlist, renderWatchlist } from '../public/js/ui/watchlist.js';

const WATCH_KEY = 'paper-trade-india:watchlist'; // legacy single-list key (migration)
const LISTS_KEY = 'paper-trade-india:watchlists'; // new multi-list key
const activeList = (dom) => JSON.parse(dom.store.get(LISTS_KEY)).lists.Default;

test('a fresh watchlist shows the five default symbols', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initWatchlist(app);
  renderWatchlist(app);

  const syms = dom.$$('#watchlist .w-sym').map((n) => n.textContent);
  assert.deepEqual(syms, ['NIFTY', 'BANKNIFTY', 'RELIANCE', 'TCS', 'INFY']);
});

test('adding a symbol persists it, clears the input, and refreshes quotes', () => {
  const dom = setupDom();
  let polled = false;
  const app = dom.makeApp({ pollQuotes: async () => { polled = true; } });
  initWatchlist(app);
  renderWatchlist(app);

  dom.$('#watch-input').value = 'wipro'; // lower-case on purpose
  dom.submit('#watch-form');

  assert.ok(app.state.watch.includes('WIPRO'));
  assert.equal(dom.$('#watch-input').value, '');
  assert.ok(polled, 'adding a symbol should poll quotes immediately');
  assert.ok(activeList(dom).includes('WIPRO'), 'persisted to the active list'); // persisted
});

test('adding a duplicate symbol is a no-op', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initWatchlist(app);
  const before = app.state.watch.length;

  dom.$('#watch-input').value = 'NIFTY'; // already present
  dom.submit('#watch-form');

  assert.equal(app.state.watch.length, before);
});

test('the × button removes a symbol and updates storage', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initWatchlist(app);
  renderWatchlist(app);

  // First row is NIFTY; click its remove button.
  const firstRemove = dom.$('#watchlist .watch-item .w-remove');
  dom.fire(firstRemove, 'click');

  assert.ok(!app.state.watch.includes('NIFTY'));
  // Check the PARSED active list (a substring check would false-positive on "BANKNIFTY").
  assert.ok(!activeList(dom).includes('NIFTY'));
});

test('clicking a row sets it as the active symbol', () => {
  const dom = setupDom();
  let active = null;
  const app = dom.makeApp({ setActiveSymbol: async (s) => { active = s; } });
  initWatchlist(app);
  renderWatchlist(app);

  dom.fire(dom.$('#watchlist .watch-item'), 'click');
  assert.equal(active, 'NIFTY');
});

test('pressing Enter on a focused row selects it (keyboard accessibility)', () => {
  const dom = setupDom();
  let active = null;
  const app = dom.makeApp({ setActiveSymbol: async (s) => { active = s; } });
  initWatchlist(app);
  renderWatchlist(app);

  const row = dom.$('#watchlist .watch-item');
  row.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(active, 'NIFTY');
});

test('live quotes render LTP and a signed, coloured % change', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initWatchlist(app);
  app.state.quotes['NIFTY'] = { ltp: 23456.7, changePct: -1.23 };
  renderWatchlist(app);

  const row = dom.$('#watchlist .watch-item');
  assert.match(row.querySelector('.w-ltp').textContent, /23,456\.70/);
  const chg = row.querySelector('.w-chg');
  assert.equal(chg.textContent, '-1.23%');
  assert.ok(chg.classList.contains('down'));
});

test('an empty watchlist shows the empty state', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  app.state.watch = [];
  renderWatchlist(app);
  assert.match(dom.$('#watchlist').textContent, /No symbols/);
});

test('corrupted stored data falls back to defaults instead of crashing', () => {
  const dom = setupDom();
  // Storage holds a non-array (e.g. from a bad import). loadWatch must not crash.
  dom.store.set(WATCH_KEY, JSON.stringify({ not: 'an array' }));
  const app = dom.makeApp();
  initWatchlist(app);
  renderWatchlist(app);
  assert.equal(app.state.watch.length, 5); // defaults restored
});

test('a stored array with non-string junk is filtered to strings only', () => {
  const dom = setupDom();
  dom.store.set(WATCH_KEY, JSON.stringify(['NIFTY', 123, null, 'TCS']));
  const app = dom.makeApp();
  initWatchlist(app);
  assert.deepEqual(app.state.watch, ['NIFTY', 'TCS']);
});

test('a periodic re-render preserves keyboard focus on a watch row', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initWatchlist(app);
  renderWatchlist(app);

  const row = dom.$('#watchlist .watch-item[data-symbol="NIFTY"]');
  row.focus();
  assert.equal(dom.document.activeElement, row);

  renderWatchlist(app); // simulate the 5s poll re-render

  const again = dom.$('#watchlist .watch-item[data-symbol="NIFTY"]');
  assert.equal(dom.document.activeElement, again, 'focus should follow the symbol across the rebuild');
});

// --- multiple watchlists (UX) ----------------------------------------------

test('creating a new watchlist switches to it and isolates its symbols', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initWatchlist(app);
  renderWatchlist(app);
  assert.equal(app.state.watch.length, 5); // Default

  dom.setPrompt('F&O'); // name returned by the new-list prompt
  dom.fire(dom.$('#btn-new-watchlist'), 'click');
  assert.equal(app.state.watch.length, 0, 'new list starts empty + active');

  dom.$('#watch-input').value = 'WIPRO';
  dom.submit('#watch-form');
  assert.deepEqual(app.state.watch, ['WIPRO']);

  // Switch back to Default — its original 5 are intact and isolated.
  dom.$('#watchlist-select').value = 'Default';
  dom.fire(dom.$('#watchlist-select'), 'change');
  assert.equal(app.state.watch.length, 5);
  assert.ok(!app.state.watch.includes('WIPRO'));

  const saved = JSON.parse(dom.store.get(LISTS_KEY));
  assert.deepEqual(Object.keys(saved.lists).sort(), ['Default', 'F&O']);
});

test('deleting the active watchlist falls back to another and never leaves zero', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initWatchlist(app);

  dom.setPrompt('Banks');
  dom.fire(dom.$('#btn-new-watchlist'), 'click'); // active = Banks
  dom.fire(dom.$('#btn-del-watchlist'), 'click'); // delete -> back to Default
  assert.equal(app.state.watch.length, 5);

  dom.fire(dom.$('#btn-del-watchlist'), 'click'); // last list -> no-op
  assert.ok(Object.keys(JSON.parse(dom.store.get(LISTS_KEY)).lists).length >= 1);
});

test('a watchlist named like an Object.prototype member (constructor) is created', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initWatchlist(app);
  dom.setPrompt('constructor'); // would collide with Object.prototype on a plain map
  dom.fire(dom.$('#btn-new-watchlist'), 'click');
  assert.equal(app.state.watch.length, 0, 'created + active (empty) list');
  const names = dom.$$('#watchlist-select option').map((o) => o.value);
  assert.ok(names.includes('constructor'));
});
