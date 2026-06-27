// ---------------------------------------------------------------------------
// test/ui-dom.test.mjs
// The shared number/format helpers (public/js/ui/dom.js). These are pure
// functions used everywhere a rupee/P&L/percentage is shown, so their edge
// cases (negatives, infinities, and values that round to zero) are worth
// pinning. No DOM needed for these helpers.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fmt, rupee, signed, moveClass, rangeChange } from '../public/js/ui/dom.js';

test('signed and fmt never emit a contradictory "-0.00"', () => {
  assert.equal(signed(-0.001, 2), '0.00'); // rounds to zero -> no sign
  assert.equal(signed(0.001, 2), '0.00');
  assert.equal(signed(-0.4, 0), '0'); // rounds to zero at 0 dp
  assert.equal(fmt(-0.0000001, 2), '0.00');
  assert.equal(fmt(-0, 2), '0.00');
});

test('signed keeps the correct sign and Indian grouping for real magnitudes', () => {
  assert.equal(signed(1234, 0), '+1,234');
  assert.equal(signed(-1234, 0), '-1,234');
  assert.equal(signed(100000, 0), '+1,00,000'); // Indian grouping
});

test('signed reports infinities (unbounded P&L) with a sign', () => {
  assert.equal(signed(Infinity), '+∞');
  assert.equal(signed(-Infinity), '-∞');
  assert.equal(signed(null), '–');
  assert.equal(signed(NaN), '–');
});

test('rupee formats a sign and the ₹ symbol; fmt/rupee guard non-numbers', () => {
  assert.equal(rupee(1500, 0), '₹1,500');
  assert.equal(rupee(-1500, 0), '-₹1,500');
  assert.equal(rupee(null), '–');
  assert.equal(fmt('abc'), '–');
});

test('moveClass colours up / down / flat', () => {
  assert.equal(moveClass(3), 'up');
  assert.equal(moveClass(-3), 'down');
  assert.equal(moveClass(0), 'flat');
});

test('rangeChange = the move from the first plotted close to the latest price (chart-header period change)', () => {
  // A +10% week: latest 110 vs the first plotted close 100.
  const up = rangeChange(110, [{ t: 1, c: 100 }, { t: 2, c: 105 }, { t: 3, c: 108 }]);
  assert.equal(up.change, 10);
  assert.equal(up.changePct, 10);
  // A negative range.
  const down = rangeChange(90, [{ t: 1, c: 100 }]);
  assert.equal(down.change, -10);
  assert.equal(down.changePct, -10);
  // A leading non-finite close is skipped — the baseline is the first REAL close.
  const skip = rangeChange(120, [{ t: 1, c: null }, { t: 2, c: 100 }]);
  assert.equal(skip.change, 20);
  // No usable baseline -> null, so the caller falls back to the quote's daily change.
  assert.equal(rangeChange(100, []), null);
  assert.equal(rangeChange(100, [{ c: 0 }]), null); // non-positive first close
  assert.equal(rangeChange(NaN, [{ c: 100 }]), null); // non-finite price
  assert.equal(rangeChange(100, null), null); // no candles
  // A literal null price must return null — NOT a fabricated -100% move. Number(null) === 0 is
  // finite, so without an explicit `ltp == null` check it would slip past the guard and compute
  // 0 - firstClose (a fake full -100% header + a red line for what is actually "no price").
  assert.equal(rangeChange(null, [{ c: 100 }, { c: 105 }]), null);
  assert.equal(rangeChange(undefined, [{ c: 100 }]), null);
});
