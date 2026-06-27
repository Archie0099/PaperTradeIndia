// ---------------------------------------------------------------------------
// test/chartwindow.test.mjs
// Locks the chart time-window helper (ui/chartwindow.js) that powers the
// 1D/1W/1M/1Y/5Y/10Y/MAX zoom buttons: tier selection, slicing, the never-<2-points
// guard, the too-long-window clamp, and the button-row DOM (active / disabled / onPick).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { windowed, windowMsOf, spanOf, effectiveWindow, pointsFor, isTiers, windowButtons, WINDOWS, axisIntervalForSpan } from '../public/js/ui/chartwindow.js';

const DAY = 864e5;
const T0 = 100000 * DAY; // a fixed base time (no Date.now() — keep it deterministic)

// A flat daily curve covering ~800 days.
const flat = Array.from({ length: 800 }, (_, i) => ({ t: T0 + i * DAY, c: 100 + i }));

test('axisIntervalForSpan: a long window uses a DATE axis even for an intraday bot', () => {
  const YEAR = 366 * DAY;
  // The bug: the per-bot equity chart passed the bot's RAW interval ('60m'), so an intraday bot's
  // multi-year MAX window drew HH:MM clock-time labels strewn across years (many off market hours).
  // A window longer than ~2 days must use a daily (date) axis regardless of the bot's bar size.
  assert.equal(axisIntervalForSpan(2 * YEAR, '60m'), '1d', 'a ~2y window -> date axis, not HH:MM');
  assert.equal(axisIntervalForSpan(30 * DAY, '60m'), '1d', 'a 1-month window -> date axis');
  // A genuinely SHORT window keeps the curve's own short-bar interval (clock-time labels read fine).
  assert.equal(axisIntervalForSpan(6 * 3600e3, '60m'), '60m', '6 hours -> the intraday axis');
  // A daily bot always gets a date axis, any span (its short interval IS '1d').
  assert.equal(axisIntervalForSpan(5 * DAY, '1d'), '1d');
  assert.equal(axisIntervalForSpan(0.5 * DAY, '1d'), '1d');
  // Degenerate span (no points) -> date axis (harmless; no labels matter).
  assert.equal(axisIntervalForSpan(0, '60m'), '1d');
});

test('windowMsOf maps the known keys (ascending) and defaults unknown to MAX (Infinity)', () => {
  assert.equal(windowMsOf('MAX'), Infinity);
  assert.ok(windowMsOf('1W') < windowMsOf('1M'));
  assert.ok(windowMsOf('1Y') < windowMsOf('5Y'));
  assert.equal(windowMsOf('nope'), Infinity);
  assert.equal(WINDOWS.length, 7, '1D · 1W · 1M · 1Y · 5Y · 10Y · MAX');
});

test('windowed on a flat curve: MAX returns all, a finite window slices the trailing span, never <2 points', () => {
  assert.equal(windowed(flat, Infinity).length, flat.length, 'MAX = the whole curve');
  const lastT = flat[flat.length - 1].t;
  const wk = windowed(flat, 7 * DAY);
  assert.ok(wk.length >= 2 && wk.length <= 9, `a 1-week slice of a daily curve is ~8 points (got ${wk.length})`);
  assert.ok(wk.every((p) => p.t >= lastT - 7 * DAY), 'every kept point is within the window');
  assert.equal(wk[wk.length - 1].t, lastT, 'the slice ends at the latest bar');
  // A window narrower than one bar still yields a drawable 2-point line (not the empty state).
  assert.equal(windowed(flat, DAY / 4).length, 2, 'a sub-bar window never returns <2 points');
  // Junk points (non-finite t/c) are dropped before slicing.
  assert.equal(windowed([{ t: NaN, c: 1 }, { t: T0, c: 2 }, { t: T0 + DAY, c: 3 }], Infinity).length, 2);
});

test('windowed on TIERS picks the finest tier that covers the window (a 1W zoom keeps full daily resolution)', () => {
  const lastT = T0 + 799 * DAY;
  const fineMonth = Array.from({ length: 31 }, (_, i) => ({ t: lastT - (30 - i) * DAY, c: 500 + i })); // daily, last ~month
  const coarseMax = [{ t: T0, c: 50 }, { t: T0 + 400 * DAY, c: 300 }, { t: lastT, c: 530 }]; // 3 coarse points
  const tiers = [
    { ms: 31 * DAY, points: fineMonth },
    { ms: 366 * DAY, points: coarseMax },
    { ms: 1e15, points: coarseMax },
  ];
  assert.ok(isTiers(tiers) && !isTiers(flat), 'isTiers distinguishes the tiers shape from a flat curve');
  // MAX -> falls through to the widest (whole-life) tier.
  assert.deepEqual(windowed(tiers, Infinity), coarseMax);
  // 1W -> the 31-day tier (full daily resolution), sliced to ~7-8 points — MORE than the 3-point MAX tier.
  const wk = windowed(tiers, 7 * DAY);
  assert.ok(wk.length >= 6 && wk.length <= 9, `1W drawn from the fine tier keeps daily resolution (got ${wk.length})`);
  assert.ok(wk.every((p) => p.c >= 500), 'the points came from the fine (last-month) tier, not the coarse MAX tier');
  assert.equal(pointsFor(tiers, 7 * DAY).length, 31, '1W selects the 31-day tier (before slicing)');
});

test('spanOf reports the data span for both shapes; effectiveWindow clamps a too-long window to MAX', () => {
  assert.equal(spanOf(flat), 799 * DAY);
  const shortTiers = [{ ms: 1e15, points: flat.slice(0, 30) }]; // ~30 days of data
  assert.equal(spanOf(shortTiers), 29 * DAY);
  // A 5Y window over a ~30-day curve clamps to MAX (so the active highlight lands on an enabled button).
  assert.equal(effectiveWindow('5Y', 29 * DAY), 'MAX');
  // A window the data covers passes through; 1D and MAX always pass.
  assert.equal(effectiveWindow('1W', 799 * DAY), '1W');
  assert.equal(effectiveWindow('1D', 29 * DAY), '1D');
  assert.equal(effectiveWindow('MAX', 29 * DAY), 'MAX');
});

test('effectiveWindow + windowButtons honour minMs: a sub-resolution window is clamped up / disabled (race-chart overview)', () => {
  const dom = setupDom();
  const span = 20 * 366 * DAY; // a ~20-year flat race-chart curve
  const minMs = span / 40; // ≈ 3 of the ~120 samples ≈ 6 months — the finest window the flat curve resolves
  // A finite window FINER than minMs (1D/1W/1M on a 20y curve) clamps UP to the first resolvable window.
  assert.equal(effectiveWindow('1M', span, minMs), '1Y', '1M is sub-resolution -> clamps up to 1Y');
  assert.equal(effectiveWindow('1W', span, minMs), '1Y', '1W clamps up to 1Y');
  assert.equal(effectiveWindow('1D', span, minMs), '1Y', '1D clamps up too (no special-case under minMs)');
  // A window the flat curve DOES resolve passes through unchanged.
  assert.equal(effectiveWindow('1Y', span, minMs), '1Y');
  assert.equal(effectiveWindow('5Y', span, minMs), '5Y');
  assert.equal(effectiveWindow('MAX', span, minMs), 'MAX');
  // With minMs=0 (the default — the tiers-backed charts) nothing is fine-clamped (byte-identical to before).
  assert.equal(effectiveWindow('1W', span), '1W', 'no minMs -> the fine window passes through');
  // The buttons grey out the sub-resolution windows (1D/1W/1M) but keep 1Y/5Y/10Y/MAX clickable.
  const row = windowButtons({ current: '1Y', span, minMs, onPick: () => {} });
  const btns = [...row.querySelectorAll('.chart-window-btn')];
  assert.deepEqual(btns.filter((b) => b.disabled).map((b) => b.textContent), ['1D', '1W', '1M'], 'sub-resolution windows disabled');
  assert.deepEqual(btns.filter((b) => !b.disabled).map((b) => b.textContent), ['1Y', '5Y', '10Y', 'MAX'], 'resolvable windows stay enabled');
});

test('windowButtons: one button per window, highlights the current, disables windows longer than the data, fires onPick', () => {
  const dom = setupDom(); // installs document/window globals for el()
  const picks = [];
  const row = windowButtons({ current: '1Y', span: 800 * DAY, onPick: (k) => picks.push(k) });
  const btns = [...row.querySelectorAll('.chart-window-btn')];
  assert.equal(btns.length, 7, 'a button per window (1D..MAX)');
  const active = btns.filter((b) => b.classList.contains('active'));
  assert.equal(active.length, 1, 'exactly one active button');
  assert.equal(active[0].textContent, '1Y', 'the current window is highlighted');
  // With ~2.2y of data, 5Y and 10Y are longer than the span -> disabled (greyed, no listener).
  assert.deepEqual(btns.filter((b) => b.disabled).map((b) => b.textContent), ['5Y', '10Y'], 'windows longer than the data are disabled');
  // Clicking an enabled, non-active button fires onPick with its key.
  dom.fire(btns.find((b) => b.textContent === '1M'), 'click');
  assert.deepEqual(picks, ['1M'], 'onPick fires with the chosen window key');
  // A disabled button has no listener -> a click is a no-op.
  dom.fire(btns.find((b) => b.textContent === '5Y'), 'click');
  assert.deepEqual(picks, ['1M'], 'a disabled window button does nothing on click');
});
