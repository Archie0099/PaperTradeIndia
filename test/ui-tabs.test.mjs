// ---------------------------------------------------------------------------
// test/ui-tabs.test.mjs
// The tab navigation (public/js/ui/tabs.js): clicking a nav button activates
// the right panel + button and fires the onShow hook; programmatic show() works.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { initTabs } from '../public/js/ui/tabs.js';

test('clicking a nav button switches the active panel + button and fires onShow', () => {
  const dom = setupDom();
  const shown = [];
  initTabs((name) => shown.push(name));

  const chainBtn = dom.$('.nav-btn[data-tab="chain"]');
  dom.fire(chainBtn, 'click');

  assert.ok(dom.$('#tab-chain').classList.contains('active'), 'chain panel active');
  assert.ok(chainBtn.classList.contains('active'), 'chain button active');
  assert.ok(!dom.$('#tab-dashboard').classList.contains('active'), 'dashboard panel inactive');
  assert.ok(!dom.$('.nav-btn[data-tab="dashboard"]').classList.contains('active'), 'dashboard button inactive');
  assert.deepEqual(shown, ['chain']);
});

test('programmatic show() activates the requested tab', () => {
  const dom = setupDom();
  const tabs = initTabs();
  tabs.show('strategy');
  assert.ok(dom.$('#tab-strategy').classList.contains('active'));
  assert.ok(dom.$('.nav-btn[data-tab="strategy"]').classList.contains('active'));
});
