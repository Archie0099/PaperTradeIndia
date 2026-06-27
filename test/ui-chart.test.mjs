// ---------------------------------------------------------------------------
// test/ui-chart.test.mjs
// The hand-rolled canvas charts (public/js/ui/chart.js). jsdom has no real 2D
// context (the harness stubs it) and no layout engine, so we can't assert
// pixels — but we CAN lock the setup logic and, crucially, the high-DPI
// growth fix by simulating the one browser behaviour that caused it.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { drawLineChart, drawMultiLine, drawPayoff, formatTick, lineRising, xAxisTicks } from '../public/js/ui/chart.js';

const candles = [{ t: 1, c: 100 }, { t: 2, c: 101 }, { t: 3, c: 99 }];

test('drawMultiLine (equity race): log scale tolerates a blown short, varied lengths + colours', () => {
  const dom = setupDom();
  const canvas = dom.$('#tourn-chart');
  // A big 20y winner, a flat bot, and a BLOWN SHORT whose equity touches ~0 — the log scale
  // must floor the ratio (not produce NaN/throw). Curves of different lengths + timestamps
  // exercise the time-aligned X path. Pixels can't be asserted (stubbed ctx); the lock is
  // "renders without throwing and sizes the canvas".
  const lines = [
    { values: [1e7, 5e7, 1.05e8], times: [1, 2, 3], color: '#22c55e', highlight: true },
    { values: [1e7, 1.01e7, 1.0e7], times: [1, 2, 3], color: '#8b7dff' },
    { values: [1e7, 2e6, 1], times: [1, 2, 3], color: '#ef4444' }, // a short driven toward 0 equity
  ];
  assert.doesNotThrow(() => drawMultiLine(canvas, lines, { title: 'race' }));
  assert.ok(canvas.height > 0, 'the canvas was set up');
  // The empty state must also be safe.
  assert.doesNotThrow(() => drawMultiLine(canvas, [], { emptyMsg: 'warming up…' }));
});

test('drawMultiLine: mixed/partial times + an interior non-finite value never produce NaN coords', () => {
  const dom = setupDom();
  const canvas = dom.$('#tourn-chart');
  // (1) ONE line has finite times, ANOTHER lacks them: the X-mode must fall back to index
  // for ALL lines (gated on the GLOBAL useTime), never call the time-scale with an unset
  // range — which would have produced NaN X-coordinates.
  const mixed = [
    { values: [1e7, 1.1e7, 1.2e7], times: [1, 2, 3] },
    { values: [1e7, 0.9e7, 1.0e7] }, // no times
  ];
  assert.doesNotThrow(() => drawMultiLine(canvas, mixed, {}));
  // (2) An interior NaN/Infinity equity value floors to ≈ −99.99% instead of poisoning the
  // whole chart (no NaN gridline label, no throw).
  const dirty = [{ values: [1e7, NaN, 5e6, Infinity, 9e6], times: [1, 2, 3, 4, 5] }];
  assert.doesNotThrow(() => drawMultiLine(canvas, dirty, {}));
});

test('drawLineChart runs against the stubbed canvas and pins the CSS height', () => {
  const dom = setupDom();
  const canvas = dom.$('#price-chart'); // height="220" in the markup
  drawLineChart(canvas, candles, { title: 'NIFTY' });
  assert.equal(canvas.dataset.cssHeight, '220');
  assert.equal(canvas.style.height, '220px');
});

test('canvas height stays BOUNDED across redraws on high-DPI screens', () => {
  const dom = setupDom();
  // Simulate a high-DPI display (jsdom defaults to 1, which would hide the bug).
  Object.defineProperty(dom.window, 'devicePixelRatio', { value: 2, configurable: true });

  const canvas = dom.$('#price-chart'); // height="220"
  // Simulate the BROWSER layout behaviour jsdom lacks: with no CSS height, the
  // element's layout height tracks its height ATTRIBUTE. Pre-fix, each redraw
  // measured the inflated attribute and doubled it (220 -> 440 -> 880 ...).
  Object.defineProperty(canvas, 'getBoundingClientRect', {
    value: () => ({ width: 300, height: Number(canvas.getAttribute('height')) || 0 }),
    configurable: true,
  });

  drawLineChart(canvas, candles);
  const h1 = canvas.height;
  drawLineChart(canvas, candles);
  const h2 = canvas.height;
  drawLineChart(canvas, candles);
  const h3 = canvas.height;

  assert.equal(h1, 440, '220 CSS px × dpr 2');
  assert.equal(h2, h1, 'height must not grow on the 2nd redraw');
  assert.equal(h3, h1, 'height must not grow on the 3rd redraw');
});

test('drawLineChart shows the empty state for too-few points (no throw)', () => {
  const dom = setupDom();
  drawLineChart(dom.$('#price-chart'), [], {});
  drawLineChart(dom.$('#price-chart'), [{ t: 1, c: 100 }], {});
  assert.ok(true);
});

test('drawPayoff renders a curve and handles the empty case without throwing', () => {
  const dom = setupDom();
  drawPayoff(dom.$('#payoff-chart'), [], { spot: 100 });
  drawPayoff(
    dom.$('#payoff-chart'),
    [{ s: 90, pnl: -5 }, { s: 100, pnl: 0 }, { s: 110, pnl: 5 }],
    { spot: 100, breakevens: [100] }
  );
  assert.ok(true);
});

test('drawLineChart ignores null-close candles (no spurious spike to 0) (bug #6)', () => {
  const dom = setupDom();
  // A gappy series: the scale and the plotted line both use only finite closes.
  const mixed = [{ t: 1, c: 100 }, { t: 2, c: null }, { t: 3, c: 102 }, { t: 4, c: null }, { t: 5, c: 101 }];
  assert.doesNotThrow(() => drawLineChart(dom.$('#price-chart'), mixed, { title: 'X' }));
  // Only one usable close -> too few points -> empty state, still no throw.
  assert.doesNotThrow(() => drawLineChart(dom.$('#price-chart'), [{ t: 1, c: null }, { t: 2, c: 50 }], {}));
});

test('formatTick renders the x-axis label in IST, by timeframe interval', () => {
  // 2026-06-15T04:30:00Z == 10:00 IST.
  const t = Date.parse('2026-06-15T04:30:00Z');
  assert.equal(formatTick(t, '5m'), '10:00'); // intraday -> HH:MM
  assert.equal(formatTick(t, '30m'), '10:00');
  assert.equal(formatTick(t, '1d'), '15 Jun'); // daily -> DD Mon
  assert.equal(formatTick(t, '1wk'), "Jun '26"); // weekly+ -> Mon 'YY
});

test('drawLineChart with timestamped candles + interval renders the time axis (no throw)', () => {
  const dom = setupDom();
  const day = 86400000;
  const candles = Array.from({ length: 30 }, (_, i) => ({ t: 1_700_000_000_000 + i * day, c: 100 + i }));
  assert.doesNotThrow(() => drawLineChart(dom.$('#price-chart'), candles, { title: 'NIFTY', interval: '1d' }));
});

test('xAxisTicks: TIME mode spreads ticks by time (distinct years) where INDEX mode repeats them', () => {
  const YEAR = 365.25 * 864e5;
  const t2008 = Date.parse('2008-06-15T00:00:00Z');
  // A curve that is SPARSE over years then DENSE near the end — exactly the equity
  // curve shape (a multi-year seeded history + many per-poll live samples at "now")
  // that index-spacing squashes into a repeated-year axis.
  const sparse = [0, 1, 2, 3, 4].map((y) => ({ t: t2008 + y * YEAR, c: 100 + y }));
  const t2026 = t2008 + 18 * YEAR;
  const dense = Array.from({ length: 20 }, (_, i) => ({ t: t2026 + i * 60000, c: 130 + i }));
  const pts = [...sparse, ...dense];

  // INDEX mode: ticks land mostly inside the dense 2026 cluster -> labels REPEAT (the bug).
  const idxLabels = xAxisTicks(pts, { timeAxis: false }).map((t) => t.label);
  assert.ok(new Set(idxLabels).size < idxLabels.length, 'index mode repeats year labels on a clustered curve (the bug)');

  // TIME mode: ticks evenly spaced in time -> even fractions + distinct, increasing years.
  const tm = xAxisTicks(pts, { timeAxis: true });
  assert.equal(tm.length, 6); // maxTicks 5 -> ticks 0..5
  tm.forEach((t, k) => assert.ok(Math.abs(t.frac - k / 5) < 1e-9, 'time ticks are evenly spaced by fraction'));
  const years = tm.map((t) => Number(t.label));
  assert.equal(new Set(years).size, years.length, 'every time-mode year label is distinct');
  assert.deepEqual(years, [...years].sort((a, b) => a - b), 'years increase monotonically');
  assert.equal(years[0], 2008);
  assert.equal(years[years.length - 1], 2026);
});

test('xAxisTicks degrades to index spacing without a positive span / timestamps', () => {
  // All-same-time -> span 0 -> index spacing, never a NaN fraction or a div-by-zero.
  const flat = [{ t: 1000, c: 1 }, { t: 1000, c: 2 }, { t: 1000, c: 3 }];
  assert.ok(xAxisTicks(flat, { timeAxis: true }).every((t) => Number.isFinite(t.frac)));
  // Missing timestamps or < 2 points -> no axis (caller draws nothing).
  assert.deepEqual(xAxisTicks([{ c: 1 }, { c: 2 }], { timeAxis: true }), []);
  assert.deepEqual(xAxisTicks([{ t: 1, c: 1 }], { timeAxis: true }), []);
  // An interior non-finite t (first finite, so it falls to the index branch) must never
  // render the literal "NaN" — a blank label instead.
  const labels = xAxisTicks([{ t: 1000, c: 1 }, { t: NaN, c: 2 }, { t: 3000, c: 3 }], { timeAxis: true }).map((t) => t.label);
  assert.ok(!labels.includes('NaN'), 'a bad interior timestamp produces no literal NaN label');
});

test('drawLineChart with timeAxis renders an unevenly-spaced equity curve without throwing', () => {
  const dom = setupDom();
  const YEAR = 365.25 * 864e5;
  const t0 = Date.parse('2008-06-15T00:00:00Z');
  const curve = [
    ...[0, 1, 2, 3, 4].map((y) => ({ t: t0 + y * YEAR, c: 1e7 * (1 + y) })),
    ...Array.from({ length: 30 }, (_, i) => ({ t: t0 + 18 * YEAR + i * 30000, c: 1.3e8 })),
  ];
  assert.doesNotThrow(() => drawLineChart(dom.$('#equity-chart'), curve, { interval: '1d', timeAxis: true }));
});

test('lineRising follows the change sign when given, else first-vs-last (line colour matches the header)', () => {
  // A series that FALLS (last < first) but a POSITIVE change sign -> still "up": the
  // 1D case where the line dipped intraday but the symbol is up on the DAY, so the
  // green line matches the green "+0.14%" header.
  assert.equal(lineRising([100, 120, 95], 0.14), true);
  // A series that RISES but a NEGATIVE sign -> "down".
  assert.equal(lineRising([100, 90, 130], -1.2), false);
  assert.equal(lineRising([100, 100], 0), true); // 0 counts as not-down (>= 0)
  // No (or non-finite) change sign -> fall back to first-vs-last of the closes.
  assert.equal(lineRising([100, 90], null), false);
  assert.equal(lineRising([100, 110], undefined), true);
  assert.equal(lineRising([100, 90], NaN), false);
});
