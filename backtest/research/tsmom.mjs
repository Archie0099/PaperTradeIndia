// ---------------------------------------------------------------------------
// backtest/research/tsmom.mjs
// Research strategy: TIME-SERIES MOMENTUM (trend) on NIFTYBEES with
// volatility-targeted sizing. The hypothesis in one line: Indian index
// drawdowns are serially-correlated multi-month affairs and SIP/retail flows
// chase trends, so a slow trend filter sidesteps the meat of the crashes while
// vol targeting keeps risk ~constant — an edge that should show up mostly in
// RISK-ADJUSTED terms (Sharpe/Sortino/drawdown), not raw return.
//
// Rules (5 tuned parameters, each with a stated reason):
//   * trend ON  when close > SMA(smaLen=200)          (canonical slow trend)
//   * trend OFF when close < (1-exitBuffer)·SMA, 5%   (hysteresis vs whipsaw)
//   * weight = min(1, volTarget / realizedVol), 12%/yr target, 20d lookback
//   * re-size only when the change ≥ deadband (10%)   (turnover control)
//   * long-only, no leverage; kill-switch: >30% proxy drawdown -> flat forever
//     (an anomaly detector, NOT a tuned parameter — excluded from perturbation)
//
// The kill-switch tracks a FRICTIONLESS internal equity proxy (costs would only
// deepen a real drawdown, and 30% is coarse); it exists so a live deployment of
// a broken signal fails safe, and its firing is itself a reportable failure.
// ---------------------------------------------------------------------------

import { pathToFileURL } from 'node:url';

const DEFAULTS = {
  smaLen: 200,      // slow-trend lookback (bars)
  exitBuffer: 0.05, // exit only 5% below the SMA — the anti-whipsaw hysteresis
  volTarget: 0.12,  // annualized vol target (~2/3 of NIFTY's long-run ~17-18%)
  volLookback: 20,  // realized-vol window (~1 trading month)
  deadband: 0.10,   // ignore target-weight drifts smaller than this while in-trend
  killDD: 0.30,     // kill-switch drawdown (anomaly detector; not tuned/perturbed)
};

// Same local indicator helpers as backtest/strategies.mjs (which doesn't export
// them). O(n) per call is fine: ~4,300 bars × 200 adds is sub-millisecond work.
function sma(closes, end, n) {
  if (end + 1 < n) return null;
  let s = 0;
  for (let k = end - n + 1; k <= end; k++) s += closes[k];
  return s / n;
}
function retStdev(closes, end, n) {
  if (end < n) return null;
  const rets = [];
  for (let k = end - n + 1; k <= end; k++) rets.push(closes[k] / closes[k - 1] - 1);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length;
  return Math.sqrt(v);
}

// Build the strategy in the standard {name, note, make()} shape runBacktest
// takes. `make()` returns a fresh decide() closure so runs never share state.
function makeTsmom(params = {}) {
  const p = { ...DEFAULTS, ...params };
  const smaLen = Math.max(2, Math.round(p.smaLen));
  const volLb = Math.max(2, Math.round(p.volLookback));
  return {
    name: `TSMOM(${smaLen}) vol-target ${(p.volTarget * 100).toFixed(0)}%`,
    note: `Long NIFTYBEES above its ${smaLen}-day average (exit ${(p.exitBuffer * 100).toFixed(1)}% below it), sized to ~${(p.volTarget * 100).toFixed(0)}%/yr volatility.`,
    // `rebalanceBand` = the SAME deadband, applied at the FILL level too (the
    // engine re-converges qty to a continuous target every bar as prices move,
    // which would micro-trade daily — the harness passes this to runBacktest so
    // "trade only when the change ≥ deadband" holds all the way to execution).
    params: { ...p, smaLen, volLookback: volLb, rebalanceBand: p.deadband },
    make() {
      let trendOn = false;
      let held = 0;           // the target we last returned (what the book converges to)
      let w1 = 0, w2 = 0;     // targets returned 1 and 2 calls ago (for the proxy)
      let eqProxy = 1, peak = 1, killed = false;
      return ({ closes, i }) => {
        // --- kill-switch bookkeeping (frictionless equity proxy) ------------
        // The backtester executes the target decided at bar j at bar j+1's
        // price, so the return from bar i-1 to i accrued to the target decided
        // at bar i-2 (= w2 here). Track that compounding, watch the drawdown.
        if (i > 0 && closes[i - 1] > 0) {
          eqProxy *= 1 + w2 * (closes[i] / closes[i - 1] - 1);
          if (eqProxy > peak) peak = eqProxy;
          if (!killed && peak > 0 && (peak - eqProxy) / peak > p.killDD) killed = true;
        }

        // --- the signal ------------------------------------------------------
        let next = 0;
        if (!killed) {
          const s = sma(closes, i, smaLen);
          if (s != null) {
            const wasOn = trendOn;
            if (!trendOn && closes[i] > s) trendOn = true;                       // enter above the SMA
            else if (trendOn && closes[i] < (1 - p.exitBuffer) * s) trendOn = false; // exit only past the buffer
            if (trendOn) {
              const sd = retStdev(closes, i, volLb);
              if (sd != null) {
                // Zero measured vol (a constant-price stretch — synthetic data
                // territory) is BELOW any positive target, so the no-leverage
                // cap binds: full size 1, not "no estimate". Only an UNWARM
                // window (sd == null) means "stay out rather than guess".
                const annVol = sd * Math.sqrt(252);
                const raw = annVol > 0 ? Math.min(1, p.volTarget / annVol) : 1; // long-only, no leverage
                // Deadband applies ONLY to sizing drift while ALREADY in the
                // trend — entries and exits always trade (a small first
                // position or a full exit must never be suppressed).
                next = wasOn && Math.abs(raw - held) < p.deadband ? held : raw;
              }
            }
          }
        }

        w2 = w1; w1 = next; held = next;
        return next;
      };
    },
  };
}

export { makeTsmom, DEFAULTS };

// ---------------------------------------------------------------------------
// CLI: `node backtest/research/tsmom.mjs` -> the in-sample report + the ±50%
// perturbation grid. `--holdout` runs the ONE-SHOT holdout evaluation — only on
// an explicit go-ahead, per the lab protocol in harness.mjs.
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { loadCandles } = await import('../data.mjs');
  const { evaluate, perturbationGrid } = await import('./harness.mjs');

  const holdout = process.argv.includes('--holdout');
  const { candles, source } = await loadCandles('NIFTYBEES', { interval: '1d', range: '20y' });
  console.log(`data: NIFTYBEES ${candles.length} bars (${source})`);
  if (!/yahoo/.test(source)) {
    console.error('refusing to evaluate on non-real (synthetic) data.');
    process.exit(1);
  }

  const fmt = (r) => {
    const m = r.metrics;
    const pf = r.profitFactor == null ? '–' : r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2);
    const to = r.turnoverPerYear == null ? '–' : r.turnoverPerYear.toFixed(2);
    return `${r.name.padEnd(28)} CAGR ${String(m.cagrPct).padStart(6)}%  xSharpe ${String(m.sharpe).padStart(5)}  (rf0 ${String(m.sharpeRf0).padStart(5)})  Sortino ${String(m.sortino).padStart(5)}  MaxDD ${String(m.maxDrawdownPct).padStart(5)}%  PF ${pf}  turnover ${to}x/yr  trades ${m.trades}  liqFlags ${r.liquidity.flagged}/${r.liquidity.checked}`;
  };

  const window = holdout
    ? { from: '2020-01-01', to: null, warmupBars: 260, allowHoldout: true }
    : { from: '2010-01-01', to: '2019-12-31', warmupBars: 260 };
  console.log(holdout
    ? '\n=== HOLDOUT (2020-01-01 → present) — ONE-SHOT evaluation ==='
    : '\n=== IN-SAMPLE (2010-01-01 → 2019-12-31) ===');

  const res = evaluate({ strategy: makeTsmom(), candles, ...window });
  console.log(fmt(res));
  console.log(fmt(res.benchmark));
  console.log(`window: ${res.window.from} → ${res.window.to} (${res.window.bars} bars, ${res.window.warmupBars} warmup) — costs: ${res.costs.model}; final position: ${res.position}`);

  if (!holdout) {
    console.log('\n=== ±50% single-parameter perturbation (in-sample) ===');
    console.log('base:', JSON.stringify(DEFAULTS));
    const rows = perturbationGrid({
      makeStrategy: makeTsmom, baseParams: DEFAULTS,
      paramNames: ['smaLen', 'exitBuffer', 'volTarget', 'volLookback', 'deadband'],
      intParams: ['smaLen', 'volLookback'],
      candles, ...window,
    });
    for (const r of rows) {
      console.log(`${r.param.padEnd(12)} ×${String(r.factor).padEnd(4)} = ${String(typeof r.value === 'number' ? +r.value.toFixed(4) : r.value).padStart(8)}  xSharpe ${String(r.sharpe).padStart(5)}  Sortino ${String(r.sortino).padStart(5)}  CAGR ${String(r.cagrPct).padStart(6)}%  MaxDD ${String(r.maxDrawdownPct).padStart(5)}%  turnover ${r.turnoverPerYear == null ? '–' : r.turnoverPerYear}x  trades ${r.trades}`);
    }
  }
}
