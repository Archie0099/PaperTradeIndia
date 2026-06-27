// ---------------------------------------------------------------------------
// ui/chartwindow.js
// Time-window zoom for the equity / track charts — the "1D · 1W · 1M · 1Y · 5Y ·
// 10Y · MAX" buttons above the leaderboard equity-race chart, the per-bot page
// equity curve, and the Auto-Pilot "vs the market" chart.
//
// THE PROBLEM this solves: the server downsamples each equity curve to ~120 points
// over ~20 years, so a 1-week window covers only ~0.1 of a point — zooming to a
// short window would show nothing. The server therefore also ships a LIGHT
// multi-resolution "tiers" form (see multiResCurve in tournament/tournament.mjs):
// an array [{ ms, points:[{t,c}] }] where each tier is the trailing 1M / 1Y / 5Y /
// whole-life slice at ≤120 points. The trailing month is only ~22 trading bars, so
// the 1M tier keeps FULL daily resolution — a 1-week zoom drawn from it shows the
// real last five days.
//
// `windowed()` works on EITHER shape — a plain flat curve [{t,c}] (e.g. the
// leaderboard's 120-point field curve, or a test stub) OR the tiers array — so every
// caller funnels through one code path. The hand-rolled chart functions already take
// a `times` array and label the x-axis span-aware (chart.js dateTickLabel), so a
// sliced window "just works": its labels adapt to the visible span automatically.
// ---------------------------------------------------------------------------

import { el } from './dom.js';

const DAY = 864e5;

// The window buttons, shortest → longest. `ms` is the trailing calendar span shown;
// Infinity = the whole life (MAX). (1D on a daily curve is essentially the last bar —
// kept for parity with the leaderboard's 1D column.)
const WINDOWS = [
  { key: '1D', ms: 1.5 * DAY },
  { key: '1W', ms: 7 * DAY },
  { key: '1M', ms: 31 * DAY },
  { key: '1Y', ms: 366 * DAY },
  { key: '5Y', ms: 5 * 366 * DAY },
  { key: '10Y', ms: 10 * 366 * DAY },
  { key: 'MAX', ms: Infinity },
];

const windowMsOf = (key) => {
  const w = WINDOWS.find((x) => x.key === key);
  return w ? w.ms : Infinity;
};

// Is `src` the multi-resolution tiers shape ([{ ms, points }]) rather than a flat curve?
function isTiers(src) {
  return Array.isArray(src) && src.length > 0 && src[0] && typeof src[0].ms === 'number' && Array.isArray(src[0].points);
}

// The best available points for a window: from tiers, the FINEST tier that still covers the
// window (smallest ms ≥ windowMs; else the widest tier); from a flat curve, the curve itself.
function pointsFor(source, windowMs) {
  if (isTiers(source)) {
    const sorted = source.slice().sort((a, b) => a.ms - b.ms);
    const tier = sorted.find((t) => t.ms >= windowMs) || sorted[sorted.length - 1];
    return tier && Array.isArray(tier.points) ? tier.points : [];
  }
  return Array.isArray(source) ? source : [];
}

// The [{t,c}] points to DRAW for the chosen window: take the finest covering tier (or the flat
// curve), keep only finite points, then slice to the trailing window [lastT − windowMs, lastT].
// Never returns fewer than 2 points (so the chart always has a line to draw, never the empty state
// on a legitimate — if tiny — window like 1D on a daily curve).
function windowed(source, windowMs) {
  const pts = pointsFor(source, windowMs).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.c));
  if (!Number.isFinite(windowMs) || pts.length <= 2) return pts;
  const lastT = pts[pts.length - 1].t;
  const startT = lastT - windowMs;
  const sliced = pts.filter((p) => p.t >= startT);
  return sliced.length >= 2 ? sliced : pts.slice(-2);
}

// The total time span (ms) the source covers — used to disable window buttons longer than the
// available history (e.g. a ~2-year intraday bot has no 5Y/10Y to show).
function spanOf(source) {
  const pts = pointsFor(source, Infinity);
  if (!pts || pts.length < 2) return 0;
  const ts = pts.map((p) => p.t).filter(Number.isFinite);
  return ts.length >= 2 ? ts[ts.length - 1] - ts[0] : 0;
}

// Clamp a window key to what the data actually covers AND resolves: a finite window LONGER than the
// available span falls back to MAX (so a ~2-year intraday bot's "10Y" choice shows its full life and
// the active highlight lands on an enabled button); and, when the caller passes a positive `minMs`
// (a LOW-RESOLUTION source — the leaderboard race chart, which ships only a ~120-point flat curve),
// a window FINER than that resolution clamps UP to the first resolvable window, so it can't sit
// highlighted while the chart collapses to a misleading near-flat 2-point line. `minMs` defaults to 0
// (no clamp) — the tiers-backed per-bot / Auto-Pilot charts resolve every window exactly, unchanged.
function effectiveWindow(key, span, minMs = 0) {
  if (key === 'MAX') return key;
  const ms = windowMsOf(key);
  if (!Number.isFinite(ms)) return key;
  if (span > 0 && ms > span * 1.05) return 'MAX'; // too long for the available history
  if (minMs > 0 && ms < minMs) {
    // too fine for this source's resolution -> the first window that IS resolvable (and not too long).
    const up = WINDOWS.find((w) => !Number.isFinite(w.ms) || (w.ms >= minMs && !(span > 0 && w.ms > span * 1.05)));
    return up ? up.key : 'MAX';
  }
  return key;
}

// Build a DOM row of window buttons. `current` = the active window key (highlighted);
// `onPick(key)` fires on click; `span` (ms, optional) greys out windows longer than the data;
// `minMs` (ms, optional) greys out windows FINER than the source resolves (a low-res flat curve —
// the leaderboard race chart; default 0 = no fine-clamp). Pure DOM (crisp + accessible).
function windowButtons({ current, span = 0, onPick, minMs = 0 }) {
  const row = el('div', { class: 'chart-windows' });
  for (const w of WINDOWS) {
    const btn = el('button', { type: 'button', class: 'chart-window-btn' + (w.key === current ? ' active' : '') }, w.key);
    // Disable a finite window when the data is SHORTER than it (nothing to show) — 1D/MAX always
    // pass here, 5% slack avoids greying a window the data just reaches — OR (for a low-res source,
    // minMs>0) when it is FINER than the data resolves (it would draw a misleading 2-point line).
    const tooLong = Number.isFinite(w.ms) && w.key !== '1D' && span > 0 && w.ms > span * 1.05;
    const tooFine = Number.isFinite(w.ms) && minMs > 0 && w.ms < minMs;
    if (tooLong || tooFine) btn.disabled = true;
    else btn.addEventListener('click', () => onPick(w.key));
    row.append(btn);
  }
  return row;
}

// Pick the x-axis granularity for a TIME-axis equity curve from the VISIBLE window's span —
// NOT the source's raw bar size. An intraday (60m) bot's long window spans years, where
// clock-time (HH:MM) labels are nonsensical (they'd read interpolated times across months,
// many outside market hours). So use a daily (date) axis for any window longer than ~2 days,
// and the curve's own short-bar interval only for genuinely short windows. (Mirrors the inline
// span checks in positions.js / autopilot.js; centralised here so the per-bot caller — the one
// that previously trusted the raw bot interval — can't drift again.) Pure function.
function axisIntervalForSpan(spanMs, shortInterval = '1d') {
  return Number.isFinite(spanMs) && spanMs > 0 && spanMs < 2 * DAY ? shortInterval : '1d';
}

export { WINDOWS, windowMsOf, windowed, spanOf, windowButtons, effectiveWindow, pointsFor, isTiers, axisIntervalForSpan };
