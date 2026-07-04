// ---------------------------------------------------------------------------
// backtest/research/harness.mjs
// The STRATEGY-LAB evaluation protocol. Every research strategy is judged
// through this one runner so the discipline can't drift run to run:
//
//   * Costs are ALWAYS the real Indian delivery schedule (backtest/costs.mjs)
//     unless a caller explicitly passes another cost model — never cost-free.
//   * The data split is FIXED project-wide: in-sample ends 2019-12-31; the
//     holdout (2020-01-01 → present: COVID crash, 2021 bull, 2022 bear) is
//     evaluated ONCE per strategy, and only by explicit opt-in — `evaluate`
//     THROWS on any window that touches the holdout unless `allowHoldout:true`
//     (which only a deliberate CLI `--holdout` run sets). Tuning on the holdout
//     is the cardinal sin this file exists to prevent.
//   * Warmup bars are prepended so indicators are warm at the scoring start,
//     but every metric is computed ONLY on the scored sub-curve — a strategy
//     never gets credit (or blame) for its warmup period.
//   * The benchmark is NIFTYBEES Buy & Hold pushed through the SAME backtester,
//     SAME window and SAME cost model — never a frictionless index number.
//
// Pure evaluation logic only: no strategy code lives here, and nothing here is
// imported by the tournament/UI (research-lab only).
// ---------------------------------------------------------------------------

import { runBacktest } from '../backtester.mjs';
import { runPortfolioBacktest } from '../portfolio.mjs';
import { equityDeliveryCosts } from '../costs.mjs';
import { summarize } from '../metrics.mjs';

// End of the in-sample era (23:59:59.999 UTC on 31 Dec 2019). Fixed for ALL
// research strategies, decided before any strategy was run. Do not move it.
const IN_SAMPLE_END = Date.UTC(2019, 11, 31, 23, 59, 59, 999);

// Parse a window bound: epoch-ms number, or an ISO date string. A `from` date
// means "from the start of that UTC day"; a `to` date means "through the END of
// that UTC day" (inclusive), so from:'2010-01-01', to:'2019-12-31' covers both
// endpoint sessions (Yahoo daily bars are timestamped at the session open).
function boundMs(v, { endOfDay = false } = {}) {
  if (v == null) return null;
  const ms = typeof v === 'number' ? v : Date.parse(v);
  if (!Number.isFinite(ms)) throw new Error(`bad window bound: ${v}`);
  return endOfDay && typeof v !== 'number' ? ms + 864e5 - 1 : ms;
}

// Slice a candle series to [from, to] plus up to `warmupBars` bars BEFORE `from`
// (for indicator warmup). Returns the sliced candles and `scoreStart` — the
// index within the slice where scoring begins (the first bar at/after `from`).
function sliceWindow(candles, { from = null, to = null, warmupBars = 0 } = {}) {
  const fromMs = boundMs(from);
  const toMs = boundMs(to, { endOfDay: true });
  let first = fromMs == null ? 0 : candles.findIndex((c) => c.t >= fromMs);
  if (first === -1) throw new Error('window starts after the data ends');
  let last = candles.length - 1;
  while (last >= 0 && toMs != null && candles[last].t > toMs) last--;
  if (last < first) throw new Error('empty window (to before from?)');
  const start = Math.max(0, first - Math.max(0, warmupBars | 0));
  return { candles: candles.slice(start, last + 1), scoreStart: first - start };
}

// Profit factor over a trade log: gross realised wins / gross realised losses.
// (Buys book ~0 realised; closes carry the round-trip result — same convention
// as the backtester's own trade log.) No losses at all -> Infinity is honest
// but useless; report it as Infinity and let the display layer decide. No
// closed trades -> null (undefined, not "perfect").
function profitFactor(trades) {
  let wins = 0, losses = 0;
  for (const tr of trades || []) {
    const r = Number(tr.realised) || 0;
    if (r > 0) wins += r; else if (r < 0) losses -= r;
  }
  if (wins === 0 && losses === 0) return null;
  if (losses === 0) return Infinity;
  return wins / losses;
}

// Annualised ROUND-TRIP turnover: (total traded value / 2) / average equity /
// years. 1.0 means the whole book is replaced about once a year; Buy & Hold is
// ~0 after the initial purchase. The /2 counts a buy+sell pair as ONE turn.
function turnoverPerYear(trades, equity, years) {
  if (!years || years <= 0 || !equity.length) return null;
  const traded = (trades || []).reduce((a, tr) => a + Math.abs(Number(tr.value) || 0), 0);
  const avgEq = equity.reduce((a, b) => a + b, 0) / equity.length;
  if (!(avgEq > 0)) return null;
  return traded / 2 / avgEq / years;
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// The costed benchmark: buy at the first bar, never trade again.
const BUY_HOLD = { name: 'Buy & Hold (benchmark)', note: 'Benchmark through the same costs.', make: () => () => 1 };

// Evaluate ONE strategy over ONE window under the lab protocol. Returns the
// scored metrics, profit factor, turnover, liquidity flags and (by default) the
// same-window costed Buy & Hold benchmark for the head-to-head.
function evaluate({
  strategy, candles, symbol = 'NIFTYBEES',
  from = null, to = null, warmupBars = 0,
  cash = 1_000_000, costModel = null,
  allowHoldout = false, benchmark = true,
  // Execution-level sizing deadband (fraction of equity; see backtester.mjs).
  // Defaults from the strategy's own declared params so one number drives both
  // the signal-level and the fill-level band; 0 = off.
  rebalanceBand = null,
} = {}) {
  const band = rebalanceBand != null ? rebalanceBand : (strategy && strategy.params && strategy.params.rebalanceBand) || 0;
  const win = sliceWindow(candles, { from, to, warmupBars });
  const lastT = win.candles[win.candles.length - 1].t;
  if (!allowHoldout && lastT > IN_SAMPLE_END) {
    throw new Error(`HOLDOUT LOCKED: the window ends ${iso(lastT)}, after the in-sample cutoff ${iso(IN_SAMPLE_END)}. `
      + 'The holdout is evaluated ONCE per strategy, on explicit go-ahead (--holdout).');
  }
  const cm = costModel || equityDeliveryCosts();
  const res = runBacktest({ strategy, candles: win.candles, symbol, cash, costModel: cm, recordTrades: true, rebalanceBand: band });

  // Score ONLY from the first non-warmup bar; ratios re-base the curve implicitly.
  const scoreT0 = win.candles[win.scoreStart].t;
  const equity = res.equityCurve.slice(win.scoreStart);
  const times = win.candles.slice(win.scoreStart).map((c) => c.t);
  const trades = (res.trades || []).filter((tr) => tr.t >= scoreT0);
  const years = (times[times.length - 1] - times[0]) / (365.25 * 864e5);
  const metrics = summarize(equity, { years, trades: trades.length });

  const out = {
    name: res.name,
    window: { from: iso(scoreT0), to: iso(lastT), bars: equity.length, warmupBars: win.scoreStart },
    metrics,
    profitFactor: profitFactor(trades),
    turnoverPerYear: turnoverPerYear(trades, equity, years),
    // Participation flags cover the WHOLE run incl. warmup (the backtester
    // reports an aggregate) — a warmup fill is still a fill worth flagging.
    liquidity: res.liquidity,
    costs: res.costs,
    position: res.position,
    equity, times, trades,
  };
  if (benchmark) {
    out.benchmark = evaluate({ strategy: BUY_HOLD, candles, symbol, from, to, warmupBars, cash, costModel: cm, allowHoldout, benchmark: false });
  }
  return out;
}

// First bar (if any) where the scored curve's peak-to-trough drawdown exceeded
// `dd` — the research kill-switch REPORT. A spec-driven basket has no in-strategy
// state hook to self-flatten (unlike a hand-coded strategy closure, which can
// track its own equity proxy), so the lab treats a breach as a reportable
// event / disqualifier: the date it would have fired is surfaced, and any live
// deployment would enforce the flatten at the copy layer. Returns { t, dd } or null.
function killSwitchBreach(equity, times, dd) {
  let peak = -Infinity;
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) peak = equity[i];
    if (peak > 0 && (peak - equity[i]) / peak > dd) return { t: times[i], dd: +((peak - equity[i]) / peak).toFixed(4) };
  }
  return null;
}

// evaluate(), for a multi-name BASKET spec (backtest/portfolio.mjs). Same
// protocol: real delivery costs, fixed split, holdout gate, warmup excluded
// from scoring, costed single-symbol Buy & Hold benchmark. Windowing differs
// mechanically: symbols have staggered timelines, so the warmup is a DATE
// (`warmupFrom`) rather than a bar count — every series is clipped to
// [warmupFrom, to], the basket trades through the warmup, and scoring starts at
// the first master-timeline bar at/after `from`. Data beyond `to` is physically
// clipped away, so the split cannot leak by construction.
function evaluateBasket({
  spec, dataBySymbol, marketSeries = null,
  benchCandles = null, benchSymbol = 'NIFTYBEES',
  from = null, to = null, warmupFrom = null,
  cash = 1_000_000, costModel = null, rankSource = null,
  allowHoldout = false, killDD = 0.35, alignCache = null,
} = {}) {
  const fromMs = boundMs(from);
  const toMs = boundMs(to, { endOfDay: true });
  const loMs = boundMs(warmupFrom) != null ? boundMs(warmupFrom) : fromMs;
  const clip = (series) => (series || []).filter((c) => (loMs == null || c.t >= loMs) && (toMs == null || c.t <= toMs));

  const data = {};
  for (const s of Object.keys(dataBySymbol)) {
    const cc = clip(dataBySymbol[s]);
    if (cc.length) data[s] = cc;
  }
  const market = marketSeries ? clip(marketSeries) : null;
  if (!Object.keys(data).length) throw new Error('empty basket window');

  // Gate BEFORE computing anything: the holdout must not even be simulated
  // without the explicit opt-in. The clipped data's last bar tells us where the
  // window really ends (a `to` beyond the data clamps naturally).
  const lastT = Math.max(...Object.values(data).map((cc) => cc[cc.length - 1].t));
  if (!allowHoldout && lastT > IN_SAMPLE_END) {
    throw new Error(`HOLDOUT LOCKED: the window ends ${iso(lastT)}, after the in-sample cutoff ${iso(IN_SAMPLE_END)}. `
      + 'The holdout is evaluated ONCE per strategy, on explicit go-ahead (--holdout).');
  }

  const cm = costModel || equityDeliveryCosts();
  const res = runPortfolioBacktest({ spec, dataBySymbol: data, marketSeries: market, cash, costModel: cm, rankSource, recordTrades: true, alignCache });

  let scoreStart = fromMs == null ? 0 : res.times.findIndex((t) => t >= fromMs);
  if (scoreStart === -1) throw new Error('scoring window starts after the data ends');
  const scoreT0 = res.times[scoreStart];
  const equity = res.equityCurve.slice(scoreStart);
  const times = res.times.slice(scoreStart);
  const trades = (res.trades || []).filter((tr) => tr.t >= scoreT0);
  const years = (times[times.length - 1] - times[0]) / (365.25 * 864e5);
  const metrics = summarize(equity, { years, trades: trades.length });

  const out = {
    name: res.name,
    window: { from: iso(scoreT0), to: iso(lastT), bars: equity.length, warmupBars: scoreStart },
    metrics,
    profitFactor: profitFactor(trades),
    turnoverPerYear: turnoverPerYear(trades, equity, years),
    killSwitch: killSwitchBreach(equity, times, killDD),
    liquidity: res.liquidity,   // whole run incl. warmup (aggregate, see evaluate())
    costs: res.costs,
    position: res.position,
    holdings: res.holdings,
    decision: res.decision,
    equity, times, trades,
  };
  if (benchCandles) {
    out.benchmark = evaluate({
      strategy: BUY_HOLD, candles: benchCandles, symbol: benchSymbol,
      from, to, warmupBars: 0, cash, costModel: cm, allowHoldout, benchmark: false,
    });
  }
  return out;
}

// The ±50% single-parameter perturbation sweep the protocol requires BEFORE any
// holdout request: for each named parameter, scale it by each factor (default
// 0.5/0.75/1.25/1.5), rebuild the strategy, re-run the SAME in-sample window,
// and report the headline numbers. An edge that flips sign under a 50% nudge of
// any one parameter is curve-fit, not alpha. `intParams` are rounded after
// scaling (e.g. lookback lengths).
function perturbationGrid({
  makeStrategy, baseParams, paramNames, candles,
  factors = [0.5, 0.75, 1.25, 1.5], intParams = [],
  ...evalOpts
}) {
  const rows = [];
  for (const name of paramNames) {
    for (const f of factors) {
      const raw = baseParams[name] * f;
      const value = intParams.includes(name) ? Math.max(2, Math.round(raw)) : raw;
      const r = evaluate({ ...evalOpts, candles, benchmark: false, strategy: makeStrategy({ ...baseParams, [name]: value }) });
      rows.push({
        param: name, factor: f, value,
        sharpe: r.metrics.sharpe, sortino: r.metrics.sortino, cagrPct: r.metrics.cagrPct,
        maxDrawdownPct: r.metrics.maxDrawdownPct, turnoverPerYear: r.turnoverPerYear == null ? null : +r.turnoverPerYear.toFixed(2),
        trades: r.metrics.trades,
      });
    }
  }
  return rows;
}

export { IN_SAMPLE_END, sliceWindow, evaluate, evaluateBasket, perturbationGrid, profitFactor, turnoverPerYear, killSwitchBreach, BUY_HOLD };
