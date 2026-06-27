// ---------------------------------------------------------------------------
// ui/chart.js
// Hand-rolled canvas charts — NO chart library, NO CDN. Two charts:
//   1. drawLineChart  : a price-history line/area chart.
//   2. drawPayoff     : a strategy P&L-at-expiry diagram with zero line,
//                       current-spot marker, shaded profit/loss regions and
//                       breakeven markers.
//
// Both handle high-DPI screens by scaling the canvas backing store, and both
// read colours from the page's CSS so they match the theme.
// ---------------------------------------------------------------------------

// Fallback theme colours (used if the CSS variables can't be read, e.g. in the
// jsdom tests). In the browser, getColors() reads the live CSS variables so the
// charts follow the light/dark theme toggle automatically.
const DEFAULT_COLORS = {
  up: '#16C784',
  down: '#F0616D',
  accent: '#E0A82E',
  grid: '#232A3A',
  text: '#8A93A6',
  bright: '#E6E9F0',
  panel: '#131722',
};

function getColors() {
  let cs;
  try {
    cs = getComputedStyle(document.documentElement);
  } catch {
    return DEFAULT_COLORS;
  }
  const v = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
  return {
    up: v('--up', DEFAULT_COLORS.up),
    down: v('--down', DEFAULT_COLORS.down),
    accent: v('--accent', DEFAULT_COLORS.accent),
    violet: v('--violet', DEFAULT_COLORS.accent),
    grid: v('--border', DEFAULT_COLORS.grid),
    text: v('--muted', DEFAULT_COLORS.text),
    bright: v('--text', DEFAULT_COLORS.bright),
    panel: v('--panel-2', DEFAULT_COLORS.panel),
  };
}

// Prepare a canvas for crisp drawing on high-DPI displays. Returns the 2D
// context and the CSS pixel width/height to draw within.
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;

  // The canvas has a CSS width (100%) but NO CSS height, so its LAYOUT height
  // follows its `height` attribute — which we overwrite below with the
  // device-pixel backing-store height. On high-DPI screens (dpr > 1) that forms
  // a feedback loop: each redraw measures the inflated height and inflates it
  // again, doubling the chart on every draw. Break the loop by pinning the
  // display height (in CSS px) with an inline style, captured ONCE from the
  // markup's original height attribute. Width stays responsive: CSS width:100%
  // overrides the width attribute, so it never feeds back.
  if (canvas.dataset.cssHeight == null) {
    const attr = Number(canvas.getAttribute('height'));
    canvas.dataset.cssHeight = String(Number.isFinite(attr) && attr > 0 ? attr : 120);
  }
  const h = Number(canvas.dataset.cssHeight); // stable CSS-pixel height
  canvas.style.height = h + 'px';

  const rect = canvas.getBoundingClientRect();
  const w = Math.max(rect.width, 200);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 1 unit = 1 CSS pixel
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

// Decide whether the price line is "up" (green) or "down" (red). When the caller
// passes a `changeSign` (the SAME change shown in the chart header), the line
// follows it — so the line and the header number can never disagree (e.g. a 1D
// line is green when the symbol is up on the DAY, even if it dipped late). With no
// changeSign it falls back to first-vs-last of the plotted closes.
function lineRising(closes, changeSign) {
  if (Number.isFinite(changeSign)) return changeSign >= 0;
  return closes[closes.length - 1] >= closes[0];
}

// Compute the x-axis ticks for a line chart: an array of { frac, label } where
// `frac` is 0..1 across the plot width. In TIME mode the ticks step evenly through
// TIME — so the labels are distinct and correctly placed even when the points
// cluster in time (e.g. an equity curve that is sparse over years then dense with
// per-poll live samples at "now", which index-spacing squashes into a repeated
// "2026, 2026, 2026" axis). Otherwise they step evenly by point INDEX, matching an
// index-spaced curve (a price chart, which skips weekend/holiday gaps). Exported
// for tests. Must mirror drawLineChart's own `useTime` gate exactly.
function xAxisTicks(pts, { timeAxis = false, intraday = false, interval, maxTicks = 5 } = {}) {
  const n = (pts || []).length;
  if (n < 2 || !Number.isFinite(pts[0].t)) return [];
  const t0 = pts[0].t, tN = pts[n - 1].t, span = tN - t0;
  const useTime = timeAxis && span > 0 && pts.every((p) => Number.isFinite(p.t));
  const ticks = Math.min(maxTicks, n - 1);
  // A non-finite timestamp (only possible on the index branch, if a future caller mixes a
  // bad t into a timeAxis curve) gets a blank label, never the literal text "NaN".
  const labelOf = (t) => (!Number.isFinite(t) ? '' : intraday ? formatTick(t, interval) : dateTickLabel(t, span));
  const out = [];
  for (let k = 0; k <= ticks; k++) {
    if (useTime) {
      out.push({ frac: k / ticks, label: labelOf(t0 + (span * k) / ticks) });
    } else {
      const i = Math.round(((n - 1) * k) / ticks);
      out.push({ frac: i / (n - 1), label: labelOf(pts[i].t) });
    }
  }
  return out;
}

// --- Price history line / area chart ---------------------------------------
// candles: [{ t, c }] (we use close prices). Draws an area under the line.
function drawLineChart(canvas, candles, opts = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  const COLORS = getColors();
  // Plot only points with a real, finite close, so the min/max SCALE and the
  // plotted LINE come from the SAME data — otherwise a null close would plot at
  // value 0 (a spurious spike to the axis).
  const pts = (candles || []).filter((c) => c && Number.isFinite(c.c));
  if (pts.length < 2) {
    drawEmpty(ctx, w, h, opts.emptyMsg || 'No price history');
    return;
  }
  const pad = { l: 52, r: 12, t: 12, b: 26 }; // bottom room for time labels
  const closes = pts.map((c) => c.c);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const range = max - min || 1;

  // X mapping. By default points are spaced evenly by INDEX (trading-time — a price
  // chart skips weekend/holiday gaps). When `opts.timeAxis` is set (the equity /
  // account curves), points are spaced by their TIMESTAMP so the curve reads as a
  // real timeline and a cluster of recent points can't dominate the width (the cause
  // of the squashed curve + repeated-year axis). Needs every point timestamped and a
  // positive span, else it degrades to index spacing.
  const t0 = pts[0].t, tN = pts[pts.length - 1].t;
  const tSpan = Number.isFinite(t0) && Number.isFinite(tN) ? tN - t0 : 0;
  const useTime = !!opts.timeAxis && tSpan > 0 && pts.every((p) => Number.isFinite(p.t));
  const xFrac = (i) => (useTime ? (pts[i].t - t0) / tSpan : pts.length > 1 ? i / (pts.length - 1) : 0);
  const x = (i) => pad.l + (w - pad.l - pad.r) * xFrac(i);
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - min) / range);

  // Horizontal grid + price labels.
  ctx.font = '11px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const v = min + (range * g) / 4;
    const yy = y(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(w - pad.r, yy);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(shortNum(v), pad.l - 6, yy); // compact (₹1cr+ account values would overflow the gutter)
  }

  // Colour the line by the caller's change sign when given (so it matches the
  // header's change figure — e.g. a 1D line is green when the symbol is UP on the
  // DAY even if it dipped intraday); otherwise fall back to first-vs-last of the
  // plotted points.
  const rising = lineRising(closes, opts.changeSign);
  const lineColor = rising ? COLORS.up : COLORS.down;

  // Area fill under the line.
  ctx.beginPath();
  ctx.moveTo(x(0), y(pts[0].c));
  pts.forEach((c, i) => ctx.lineTo(x(i), y(c.c)));
  ctx.lineTo(x(pts.length - 1), h - pad.b);
  ctx.lineTo(x(0), h - pad.b);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, hexA(lineColor, 0.28));
  grad.addColorStop(1, hexA(lineColor, 0.02));
  ctx.fillStyle = grad;
  ctx.fill();

  // The line itself.
  ctx.beginPath();
  pts.forEach((c, i) => (i ? ctx.lineTo(x(i), y(c.c)) : ctx.moveTo(x(i), y(c.c))));
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.6;
  ctx.stroke();

  // X-axis: a few evenly-spaced time labels (and faint vertical gridlines),
  // derived from the candle timestamps and formatted for the timeframe.
  if (pts[0] && pts[0].t != null) {
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    // Intraday -> HH:MM; otherwise span-aware dates (a multi-year curve shows years).
    // The ticks are placed by the SAME axis mode as the curve (see useTime), so they
    // line up with the line and read as distinct, correctly-spaced dates.
    const intraday = INTRADAY_INTERVALS.includes(opts.interval);
    const axisTicks = xAxisTicks(pts, { timeAxis: useTime, intraday, interval: opts.interval });
    axisTicks.forEach((tick, k) => {
      const px = pad.l + (w - pad.l - pad.r) * tick.frac;
      ctx.strokeStyle = COLORS.grid;
      ctx.globalAlpha = 0.35;
      ctx.beginPath();
      ctx.moveTo(px, pad.t);
      ctx.lineTo(px, h - pad.b);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = k === 0 ? 'left' : k === axisTicks.length - 1 ? 'right' : 'center';
      ctx.fillText(tick.label, px, h - pad.b + 5);
    });
  }

  if (opts.title) {
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(opts.title, pad.l, pad.t - 2);
  }
}

// --- Multi-line "race" chart -----------------------------------------------
// lines: [{ values:number[], highlight?, color? }]. Each line is normalised to
// its % return from its first value, so strategies on different equity scales
// race on the same axis. The highlighted line is drawn bright on top; the rest
// are faint "the field". Used by the tournament leaderboard.
function drawMultiLine(canvas, lines, opts = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  const COLORS = getColors();
  // Each bot is normalised to its LOG GROWTH — ln(equity / first-bar equity). Over a
  // ~20-year race, returns span roughly −70% .. +10,000%+, so a linear "% return" axis
  // crushes every bot except the single biggest winner into a flat line at the bottom. A
  // log axis gives equal vertical distance to equal MULTIPLICATIVE growth — the honest way
  // to compare long-horizon equity curves (a 10× and a 100× bot are both clearly visible).
  const FLOOR = 1e-4; // a blown short can fall to ~0 equity; floor the ratio so ln() stays finite (≈ −99.99%)
  const norm = (lines || [])
    .filter((L) => Array.isArray(L.values) && L.values.length >= 2 && L.values[0] > 0)
    .map((L) => {
      const v0 = L.values[0];
      // Time-aligned X when the curve carries finite timestamps (so a 2y bot only spans the
      // right slice of a 20y axis instead of stretching across it); else fall back to index.
      const times = Array.isArray(L.times) && L.times.length === L.values.length && L.times.every((t) => Number.isFinite(t)) ? L.times : null;
      // Per-point log growth. A non-finite or non-positive interior value (a blown short at
      // ~0/negative equity, or any stray NaN/Infinity) floors to ≈ −99.99% instead of
      // poisoning the whole chart with NaN coordinates / a "NaN%" gridline.
      const g = L.values.map((v) => {
        const r = v / v0;
        return Number.isFinite(r) && r > 0 ? Math.log(Math.max(r, FLOOR)) : Math.log(FLOOR);
      });
      return { ...L, g, times };
    });
  if (!norm.length) {
    drawEmpty(ctx, w, h, opts.emptyMsg || 'No data yet');
    return;
  }
  const pad = { l: 52, r: 12, t: 14, b: 26 }; // bottom room for the date axis
  let lo = Infinity, hi = -Infinity;
  for (const L of norm) for (const p of L.g) { if (p < lo) lo = p; if (p > hi) hi = p; }
  lo = Math.min(lo, 0); hi = Math.max(hi, 0);
  const range = hi - lo || 1;
  const useTime = norm.every((L) => L.times);
  let tMin = Infinity, tMax = -Infinity;
  if (useTime) for (const L of norm) { tMin = Math.min(tMin, L.times[0]); tMax = Math.max(tMax, L.times[L.times.length - 1]); }
  const tSpan = tMax - tMin || 1;
  const Xidx = (i, len) => pad.l + ((w - pad.l - pad.r) * i) / Math.max(1, len - 1);
  const Xt = (t) => pad.l + ((w - pad.l - pad.r) * (t - tMin)) / tSpan;
  const Y = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - lo) / range);
  // Gridlines are evenly spaced in LOG space but labelled as the % return at that level, so
  // the (deliberately uneven) labels themselves convey the log scale. Compact "+10.4k%" form.
  const pctLabel = (g) => {
    const p = (Math.exp(g) - 1) * 100, a = Math.abs(p);
    const s = a >= 1000 ? (p / 1000).toFixed(a >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k' : Math.round(p).toString();
    return (p >= 0 ? '+' : '') + s + '%';
  };

  ctx.font = '11px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (let gi = 0; gi <= 4; gi++) {
    const v = lo + (range * gi) / 4;
    const yy = Y(v);
    ctx.strokeStyle = COLORS.grid;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(w - pad.r, yy);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'right';
    ctx.fillText(pctLabel(v), pad.l - 4, yy);
  }

  // Draw the faint field first, then the highlighted line on top.
  const order = norm.slice().sort((a, b) => Number(!!a.highlight) - Number(!!b.highlight));
  for (const L of order) {
    ctx.beginPath();
    L.g.forEach((p, i) => {
      // Gate the X-mode on the GLOBAL useTime (true only when EVERY line has finite times),
      // not the per-line L.times — otherwise a single line with times mixed among lines
      // without them would call Xt() with an unset tMin/tMax and produce NaN coordinates.
      const x = useTime ? Xt(L.times[i]) : Xidx(i, L.g.length);
      return i ? ctx.lineTo(x, Y(p)) : ctx.moveTo(x, Y(p));
    });
    if (L.highlight) {
      ctx.strokeStyle = L.color || COLORS.accent;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.2;
    } else {
      ctx.strokeStyle = L.color || COLORS.text;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 1.1;
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // X-axis: a few date labels along the bottom, derived from the time-aligned axis (so the
  // race chart reads as a real timeline). Span-aware,
  // so a ~20-year race shows years. Only when every line carries finite timestamps.
  if (useTime) {
    ctx.font = '11px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    ctx.fillStyle = COLORS.text;
    const ticks = 4;
    for (let k = 0; k <= ticks; k++) {
      const t = tMin + (tSpan * k) / ticks;
      const px = Xt(t);
      ctx.textAlign = k === 0 ? 'left' : k === ticks ? 'right' : 'center';
      ctx.fillText(dateTickLabel(t, tSpan), px, h - pad.b + 5);
    }
  }

  if (opts.title) {
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(opts.title + '  ·  log scale', pad.l, pad.t - 3);
  }
}

// --- Payoff diagram --------------------------------------------------------
// curve: [{ s, pnl }] across underlying prices. Extras drawn: zero line,
// spot marker, breakevens, profit (green) / loss (red) shaded areas.
function drawPayoff(canvas, curve, info = {}) {
  const { ctx, w, h } = setupCanvas(canvas);
  const COLORS = getColors();
  if (!curve || curve.length < 2) {
    drawEmpty(ctx, w, h, 'Add legs to see the payoff');
    return;
  }
  const pad = { l: 60, r: 14, t: 16, b: 28 };
  const xs = curve.map((p) => p.s);
  const ys = curve.map((p) => p.pnl);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  // Always include zero and add a little headroom.
  yMin = Math.min(yMin, 0);
  yMax = Math.max(yMax, 0);
  const yPad = (yMax - yMin) * 0.1 || 1;
  yMin -= yPad;
  yMax += yPad;
  const yRange = yMax - yMin || 1;

  const X = (s) => pad.l + ((w - pad.l - pad.r) * (s - xMin)) / (xMax - xMin || 1);
  const Y = (v) => pad.t + (h - pad.t - pad.b) * (1 - (v - yMin) / yRange);

  // Shaded profit / loss split at the zero line via clipping.
  const zeroY = Y(0);
  // Build the full payoff polygon once.
  function payoffPath(toY) {
    ctx.beginPath();
    ctx.moveTo(X(curve[0].s), Y(curve[0].pnl));
    curve.forEach((p) => ctx.lineTo(X(p.s), Y(p.pnl)));
    ctx.lineTo(X(curve[curve.length - 1].s), toY);
    ctx.lineTo(X(curve[0].s), toY);
    ctx.closePath();
  }
  // Green where pnl > 0 (clip to area above zero line).
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, pad.t, w - pad.l - pad.r, zeroY - pad.t);
  ctx.clip();
  payoffPath(zeroY);
  ctx.fillStyle = hexA(COLORS.up, 0.18);
  ctx.fill();
  ctx.restore();
  // Red where pnl < 0 (clip below zero line).
  ctx.save();
  ctx.beginPath();
  ctx.rect(pad.l, zeroY, w - pad.l - pad.r, h - pad.b - zeroY);
  ctx.clip();
  payoffPath(zeroY);
  ctx.fillStyle = hexA(COLORS.down, 0.18);
  ctx.fill();
  ctx.restore();

  // Y grid + rupee labels.
  ctx.font = '11px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = COLORS.grid;
  ctx.fillStyle = COLORS.text;
  for (let g = 0; g <= 4; g++) {
    const v = yMin + (yRange * g) / 4;
    const yy = Y(v);
    ctx.beginPath();
    ctx.moveTo(pad.l, yy);
    ctx.lineTo(w - pad.r, yy);
    ctx.globalAlpha = 0.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.textAlign = 'right';
    ctx.fillText(shortNum(v), pad.l - 6, yy);
  }

  // Zero line (brighter).
  ctx.beginPath();
  ctx.moveTo(pad.l, zeroY);
  ctx.lineTo(w - pad.r, zeroY);
  ctx.strokeStyle = COLORS.text;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // The payoff line.
  ctx.beginPath();
  curve.forEach((p, i) => (i ? ctx.lineTo(X(p.s), Y(p.pnl)) : ctx.moveTo(X(p.s), Y(p.pnl))));
  ctx.strokeStyle = COLORS.accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Breakeven markers.
  ctx.fillStyle = COLORS.bright;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (const be of info.breakevens || []) {
    if (be < xMin || be > xMax) continue;
    const bx = X(be);
    ctx.strokeStyle = COLORS.text;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(bx, pad.t);
    ctx.lineTo(bx, h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillText(be.toFixed(0), bx, pad.t + 10);
  }

  // Current-spot marker (amber dashed vertical + dot on the curve).
  if (info.spot != null && info.spot >= xMin && info.spot <= xMax) {
    const sx = X(info.spot);
    ctx.strokeStyle = COLORS.accent;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(sx, pad.t);
    ctx.lineTo(sx, h - pad.b);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = COLORS.accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('spot ' + info.spot.toFixed(0), sx, h - pad.b + 4);
  }
}

// --- Small helpers ---------------------------------------------------------

// Format a candle timestamp (ms) for the x-axis, in IST, by timeframe interval:
//   intraday (minute/hour) -> "HH:MM"
//   daily    (1d)          -> "DD Mon"
//   weekly+  (1wk/1mo/3mo) -> "Mon 'YY"
// IST = a fixed +5:30 epoch shift read with UTC getters (DST-safe, host-agnostic).
const CHART_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const INTRADAY_INTERVALS = ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h'];

// Span-aware date label for a long equity / race curve, where the meaningful unit depends
// on how much time the curve covers: a ~20-year curve should show YEARS (not an ambiguous
// "14 Apr" with no year), a multi-month one "Apr '23", a short one "14 Apr". IST, DST-safe.
function dateTickLabel(tMs, spanMs) {
  const ist = new Date(tMs + 5.5 * 3600000);
  const yr = String(ist.getUTCFullYear());
  if (spanMs > 2.5 * 365.25 * 864e5) return yr; // multi-year span -> "2008"
  if (spanMs > 150 * 864e5) return CHART_MONTHS[ist.getUTCMonth()] + " '" + yr.slice(2); // months -> "Apr '23"
  return ist.getUTCDate() + ' ' + CHART_MONTHS[ist.getUTCMonth()]; // short -> "14 Apr"
}

function formatTick(tMs, interval = '1d') {
  const ist = new Date(tMs + 5.5 * 3600000);
  if (['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h'].includes(interval)) {
    return String(ist.getUTCHours()).padStart(2, '0') + ':' + String(ist.getUTCMinutes()).padStart(2, '0');
  }
  if (['1wk', '1mo', '3mo'].includes(interval)) {
    return CHART_MONTHS[ist.getUTCMonth()] + " '" + String(ist.getUTCFullYear()).slice(2);
  }
  return ist.getUTCDate() + ' ' + CHART_MONTHS[ist.getUTCMonth()];
}

function drawEmpty(ctx, w, h, msg) {
  const COLORS = getColors();
  ctx.fillStyle = COLORS.text;
  ctx.font = '12px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, w / 2, h / 2);
}

// Convert "#RRGGBB" + alpha to an rgba() string.
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}

// Compact rupee number for axis labels (e.g. 12,000 -> 12k; 1.3cr account -> 1.3Cr).
function shortNum(v) {
  const abs = Math.abs(v);
  if (abs >= 1e7) return (v / 1e7).toFixed(1) + 'Cr';
  if (abs >= 100000) return (v / 100000).toFixed(1) + 'L';
  if (abs >= 1000) return (v / 1000).toFixed(1) + 'k';
  return v.toFixed(0);
}

export { drawLineChart, drawMultiLine, drawPayoff, formatTick, lineRising, xAxisTicks };
