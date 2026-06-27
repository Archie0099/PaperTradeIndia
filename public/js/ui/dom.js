// ---------------------------------------------------------------------------
// ui/dom.js
// Small shared helpers used by every UI module: element creation, number
// formatting (Indian style), and colour classes for up/down moves.
// Keeping these in one place avoids repeating fiddly formatting code.
// ---------------------------------------------------------------------------

// Create an element with attributes and children in one call.
//   el('div', { class: 'card' }, ['hello', el('span', {}, ['!')]])
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Shorthand selectors.
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Format a number in Indian grouping with fixed decimals (e.g. 1,00,000.00).
function fmt(n, decimals = 2) {
  if (n == null || !Number.isFinite(Number(n))) return '–';
  let num = Number(n);
  // A magnitude that rounds to zero at this precision (incl. -0) must format as
  // a plain "0.00", never "-0.00".
  if (Math.abs(num) < 0.5 / 10 ** decimals) num = 0;
  return num.toLocaleString('en-IN', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Rupee amount with a ₹ sign.
function rupee(n, decimals = 2) {
  if (n == null || !Number.isFinite(Number(n))) return '–';
  const neg = n < 0;
  return (neg ? '-₹' : '₹') + fmt(Math.abs(n), decimals);
}

// Signed value with a + or - sign (for changes and P&L). Infinities (an
// unbounded max profit/loss) must be checked BEFORE the finite test, otherwise
// they fall through to '–'.
function signed(n, decimals = 2) {
  if (n == null) return '–';
  if (n === Infinity) return '+∞';
  if (n === -Infinity) return '-∞';
  const num = Number(n);
  if (!Number.isFinite(num)) return '–';
  // Decide the sign from the value AFTER rounding to the requested precision: a
  // magnitude that rounds to zero gets no sign, so we never emit "-0.00".
  const threshold = 0.5 / 10 ** decimals;
  const sign = num >= threshold ? '+' : num <= -threshold ? '-' : '';
  return sign + fmt(Math.abs(num), decimals);
}

// "up" / "down" / "flat" class helper for colouring numbers.
function moveClass(n) {
  if (n > 0) return 'up';
  if (n < 0) return 'down';
  return 'flat';
}

// The move from the FIRST plotted close of a candle series to the latest price,
// as an absolute change + percent. Used by the chart header to show the change
// OVER THE DISPLAYED RANGE — so a 1W view shows the week's move, a 1Y view the
// year's — instead of always the quote's (daily) change. Returns null when there
// is no usable baseline (empty/garbage candles, a non-positive first close, or a
// non-finite price) so callers can fall back to the daily change.
function rangeChange(ltp, candles) {
  // The `ltp == null` check MUST come before Number(): Number(null) === 0 is finite, so a
  // literal null price would slip past the guard and fabricate a -100% "move" (0 − firstClose)
  // — a green/red header + coloured line for what is actually "no price". (Same gotcha the
  // tournament's pctReturn guards against.)
  if (ltp == null || !Number.isFinite(Number(ltp)) || !Array.isArray(candles)) return null;
  const first = candles.find((c) => c && Number.isFinite(c.c));
  if (!first || !(first.c > 0)) return null;
  const change = Number(ltp) - first.c;
  return { change, changePct: (change / first.c) * 100 };
}

// Empty the contents of a node.
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export { el, $, $$, fmt, rupee, signed, moveClass, rangeChange, clear };
