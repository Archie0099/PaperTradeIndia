// ---------------------------------------------------------------------------
// test/ui-shortcuts.test.mjs
// Keyboard shortcuts (public/js/ui/shortcuts.js): 1-4 switch tabs, "/" focuses
// the watchlist input, and shortcuts are ignored while typing in a field.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { initShortcuts } from '../public/js/ui/shortcuts.js';

const key = (dom, target, k) => target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true }));

test('number keys switch tabs and "/" focuses the watchlist input', () => {
  const dom = setupDom();
  const app = dom.makeApp(); // makeApp wires app.tabs via initTabs
  initShortcuts(app);

  key(dom, dom.document.body, '2');
  assert.ok(dom.$('#tab-chain').classList.contains('active'), '2 -> Option Chain');

  key(dom, dom.document.body, '3');
  assert.ok(dom.$('#tab-strategy').classList.contains('active'), '3 -> Strategy');

  key(dom, dom.document.body, '4');
  assert.ok(dom.$('#tab-orders').classList.contains('active'), '4 -> Orders');

  key(dom, dom.document.body, '/');
  assert.equal(dom.document.activeElement, dom.$('#watch-input'), '/ focuses the watch input');
});

test('shortcuts are ignored while typing in a field', () => {
  const dom = setupDom();
  const app = dom.makeApp();
  initShortcuts(app);
  app.tabs.show('strategy');

  const input = dom.$('#t-symbol');
  input.focus();
  key(dom, input, '4'); // would switch to Orders if not ignored
  assert.ok(!dom.$('#tab-orders').classList.contains('active'), 'typing a number must not switch tabs');
  assert.ok(dom.$('#tab-strategy').classList.contains('active'), 'still on Strategy');
});
