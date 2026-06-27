// ---------------------------------------------------------------------------
// test/ui-theme.test.mjs
// The light/dark theme toggle (public/js/ui/theme.js): flips data-theme on
// <html>, persists the choice, fires the redraw callback, and restores on init.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { initTheme, currentTheme, applyTheme } from '../public/js/ui/theme.js';

const THEME_KEY = 'paper-trade-india:theme';

test('toggling the theme flips data-theme, persists it, and fires onChange', () => {
  const dom = setupDom();
  let changes = 0;
  initTheme(() => changes++);

  assert.equal(currentTheme(), 'dark'); // default
  assert.equal(dom.$('#btn-theme').textContent, '☀ Light');

  dom.fire(dom.$('#btn-theme'), 'click');
  assert.equal(currentTheme(), 'light');
  assert.equal(dom.document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(changes, 1);
  assert.equal(dom.store.get(THEME_KEY), 'light', 'choice persisted');

  dom.fire(dom.$('#btn-theme'), 'click');
  assert.equal(currentTheme(), 'dark');
  assert.equal(dom.store.get(THEME_KEY), 'dark');
});

test('initTheme restores the saved theme on load', () => {
  const dom = setupDom();
  dom.store.set(THEME_KEY, 'light');
  applyTheme('dark'); // pretend the DOM starts dark
  initTheme();
  assert.equal(currentTheme(), 'light', 'saved light theme re-applied');
});
