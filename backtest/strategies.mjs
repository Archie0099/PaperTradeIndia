// ---------------------------------------------------------------------------
// backtest/strategies.mjs
// A "strategy" decides a TARGET EXPOSURE for the next bar: a number in [0, 1]
// where 0 = all cash (flat) and 1 = fully invested (long). The backtester
// rebalances the paper account toward that target each bar. Keeping the contract
// this simple lets wildly different ideas — trend, mean-reversion, breakout,
// volatility-targeting, and deliberately reckless ones — compete on equal footing.
//
// Each strategy exposes make() -> a FRESH decide() closure with its own private
// state, so running the same strategy on many symbols/periods never leaks state
// between runs. decide(ctx) receives:
//   closes : number[]  closing prices up to AND INCLUDING the current bar
//   i      : number    index of the current bar (signal uses closes[0..i] only)
// and returns the target weight for the NEXT bar. The backtester executes that
// target at the next bar's price, so there is NO look-ahead.
// ---------------------------------------------------------------------------

// --- small indicator helpers ------------------------------------------------
function sma(closes, end, n) {
  if (end + 1 < n) return null; // not enough history yet
  let s = 0;
  for (let k = end - n + 1; k <= end; k++) s += closes[k];
  return s / n;
}

function rsi(closes, end, n = 14) {
  if (end < n) return null;
  let gain = 0, loss = 0;
  for (let k = end - n + 1; k <= end; k++) {
    const ch = closes[k] - closes[k - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  const rs = loss === 0 ? Infinity : gain / loss;
  return 100 - 100 / (1 + rs);
}

function highest(closes, end, n) {
  let m = -Infinity;
  for (let k = Math.max(0, end - n + 1); k <= end; k++) m = Math.max(m, closes[k]);
  return m;
}

function lowest(closes, end, n) {
  let m = Infinity;
  for (let k = Math.max(0, end - n + 1); k <= end; k++) m = Math.min(m, closes[k]);
  return m;
}

// Standard deviation of the last n daily returns (a simple volatility proxy).
function retStdev(closes, end, n) {
  if (end < n) return null;
  const rets = [];
  for (let k = end - n + 1; k <= end; k++) rets.push(closes[k] / closes[k - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length;
  return Math.sqrt(v);
}

// A tiny deterministic PRNG so the "coin-flip" control is reproducible run to
// run (no Math.random, which would make backtests non-repeatable).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- the starter pack -------------------------------------------------------
const STRATEGIES = [
  {
    name: 'Buy & Hold',
    note: 'Benchmark: buy once, never sell.',
    make: () => () => 1,
  },
  {
    name: 'SMA 50/200 (trend)',
    note: 'Long when the 50-day average is above the 200-day ("golden cross").',
    make: () => ({ closes, i }) => {
      const fast = sma(closes, i, 50);
      const slow = sma(closes, i, 200);
      if (fast == null || slow == null) return 0;
      return fast > slow ? 1 : 0;
    },
  },
  {
    name: 'RSI(14) reversion',
    note: 'Buy oversold (RSI < 35); go flat when overbought (RSI > 65).',
    make() {
      let inPos = false; // private, per-run state
      return ({ closes, i }) => {
        const v = rsi(closes, i, 14);
        if (v == null) return 0;
        if (v < 35) inPos = true;
        else if (v > 65) inPos = false;
        return inPos ? 1 : 0;
      };
    },
  },
  {
    name: 'Donchian 20 breakout',
    note: 'Go long on a new 20-day high; flat on a new 20-day low.',
    make() {
      let inPos = false;
      return ({ closes, i }) => {
        if (i < 20) return 0;
        const hi = highest(closes, i - 1, 20); // prior 20 days (exclude today)
        const lo = lowest(closes, i - 1, 20);
        if (closes[i] >= hi) inPos = true;
        else if (closes[i] <= lo) inPos = false;
        return inPos ? 1 : 0;
      };
    },
  },
  {
    name: 'Vol-target (smart)',
    note: 'Scale exposure so risk ~ constant: less when choppy, more when calm.',
    make: () => ({ closes, i }) => {
      const sd = retStdev(closes, i, 20);
      if (sd == null || sd === 0) return 0;
      const targetDailyVol = 0.01; // aim for ~1%/day portfolio volatility
      return Math.max(0, Math.min(1, targetDailyVol / sd));
    },
  },
  {
    name: 'YOLO momentum (crazy)',
    note: 'All-in after 3 up days; all-out on a single down day. Reckless.',
    make() {
      let inPos = false;
      return ({ closes, i }) => {
        if (i < 3) return 0;
        const up3 = closes[i] > closes[i - 1] && closes[i - 1] > closes[i - 2] && closes[i - 2] > closes[i - 3];
        if (closes[i] < closes[i - 1]) inPos = false; // any down day -> bail
        else if (up3) inPos = true;
        return inPos ? 1 : 0;
      };
    },
  },
  {
    name: 'Coin flip (control)',
    note: 'Deterministic 50/50 in-or-out. The bar every real edge MUST beat.',
    make() {
      const rng = mulberry32(0x9e3779b9);
      return () => (rng() < 0.5 ? 1 : 0);
    },
  },
];

export { STRATEGIES, sma, rsi, highest, lowest, retStdev };
