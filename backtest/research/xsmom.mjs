// ---------------------------------------------------------------------------
// backtest/research/xsmom.mjs
// Research strategy: CROSS-SECTIONAL MOMENTUM (12-1) on the tournament's
// liquid-name universe, monthly, inverse-vol weighted, behind the project's
// proven buffered market-regime gate. Hypothesis in one line: Indian
// relative-strength winners keep winning (analyst underreaction + retail/
// institutional herding), the skip-month sidesteps short-term reversal, and —
// unlike a market-timing overlay — the basket is ~fully invested whenever the
// gate is open, so it needs cross-sectional DISPERSION, not a fat market
// premium. The gate exists because momentum's known catastrophe is the
// post-bear rebound crash.
//
// ★ SURVIVORSHIP CAVEAT (METHODOLOGY.md #1): the universe is ~105 names liquid
// TODAY held fixed across history, so every number this file prints is an
// UPPER BOUND. The CLI prints the caveat with the results — keep it that way.
//
// Runs entirely through the existing BASKET machinery (backtest/portfolio.mjs
// via the research harness) — the spec below is plain data; no new engine code.
// ---------------------------------------------------------------------------

import { pathToFileURL } from 'node:url';
import { validateSpec } from '../dsl.mjs';

const DEFAULTS = {
  lookback: 252,   // ~12 months — the canonical formation window
  skip: 21,        // ~1 month skipped — avoids the short-term reversal effect
  k: 10,           // top-10 holdings: diversified but still conviction-weighted
  rebalanceBars: 21, // monthly — the standard cadence; keeps turnover survivable
  gateSma: 200,    // the regime proxy every project gate already uses
  gateBuffer: 0.05, // buffered gate (NIFTY > 0.95·SMA) — the same buffered gate shape the tournament's quant bots use
  killDD: 0.35,    // kill-switch (anomaly detector; reported, not tuned/perturbed)
};

// 12-1 momentum as a pure DSL expression: close[i-skip] / close[i-lookback] − 1
//   = (1 + mom(lookback)) / (1 + mom(skip)) − 1   (the shared close[i] cancels).
// mom() is null while unwarm, and null propagates through the arithmetic, so a
// name without a full formation window is EXCLUDED from the rebalance rather
// than mis-scored.
function rank12_1(lookback, skip) {
  return ['-', ['/', ['+', 1, ['mom', lookback]], ['+', 1, ['mom', skip]]], 1];
}

// Build the BASKET spec (plain data — validated by the same validateSpec that
// guards every tournament bot). Integer knobs are rounded so perturbation
// factors can be applied blindly.
function makeXsmomSpec(universe, params = {}) {
  const p = { ...DEFAULTS, ...params };
  const lookback = Math.max(22, Math.round(p.lookback));
  const skip = Math.min(Math.max(1, Math.round(p.skip)), lookback - 1);
  const k = Math.max(1, Math.round(p.k));
  const rebalanceBars = Math.min(63, Math.max(5, Math.round(p.rebalanceBars)));
  const gateSma = Math.max(2, Math.round(p.gateSma));
  const spec = {
    kind: 'BASKET',
    name: `XS momentum ${lookback}-${skip}`,
    note: `Top-${k} of the universe by ${lookback}d return skipping the last ${skip}d, inverse-vol weighted, monthly; cash when NIFTY < ${(1 - p.gateBuffer) * 100}% of its ${gateSma}-DMA.`,
    universe,
    rank: rank12_1(lookback, skip),
    k,
    weighting: 'volinv',
    rebalanceBars,
    marketGate: ['>', ['price'], ['*', +(1 - p.gateBuffer).toFixed(4), ['sma', gateSma]]],
  };
  const err = validateSpec(spec);
  if (err) throw new Error(`xsmom spec invalid: ${err}`);
  return { spec, params: { ...p, lookback, skip, k, rebalanceBars, gateSma } };
}

export { makeXsmomSpec, rank12_1, DEFAULTS };

// ---------------------------------------------------------------------------
// CLI: `node backtest/research/xsmom.mjs` -> in-sample report + ±50% grid.
// `--holdout` runs the ONE-SHOT holdout — only on an explicit go-ahead.
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { loadCandles } = await import('../data.mjs');
  const { evaluateBasket } = await import('./harness.mjs');
  const { BASKET_UNIVERSE } = await import('../../tournament/universe.mjs');

  const holdout = process.argv.includes('--holdout');

  // Load the whole universe from the on-disk cache (the tournament keeps it
  // warm). Anything synthetic (no real Yahoo data) is dropped — a research
  // number must never rest on fabricated bars.
  const dataBySymbol = {};
  let dropped = 0;
  for (const s of BASKET_UNIVERSE) {
    const { candles, source } = await loadCandles(s, { interval: '1d', range: '20y' });
    if (/synthetic/.test(source) || candles.length < 300) { dropped++; continue; }
    dataBySymbol[s] = candles;
  }
  const { candles: market, source: mSrc } = await loadCandles('NIFTY', { interval: '1d', range: '20y' });
  const { candles: bench, source: bSrc } = await loadCandles('NIFTYBEES', { interval: '1d', range: '20y' });
  if (/synthetic/.test(mSrc) || /synthetic/.test(bSrc)) {
    console.error('refusing to evaluate: market/benchmark series is synthetic.');
    process.exit(1);
  }
  console.log(`data: ${Object.keys(dataBySymbol).length} universe names loaded (${dropped} dropped), NIFTY gate ${market.length} bars, NIFTYBEES bench ${bench.length} bars`);
  console.log('★ SURVIVORSHIP: the universe is today\'s liquid names held fixed across history — every figure below is an UPPER BOUND (METHODOLOGY.md).');

  const fmt = (r) => {
    const m = r.metrics;
    const pf = r.profitFactor == null ? '–' : r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2);
    const to = r.turnoverPerYear == null ? '–' : r.turnoverPerYear.toFixed(2);
    const ks = r.killSwitch ? `KILL-SWITCH BREACH ${new Date(r.killSwitch.t).toISOString().slice(0, 10)} (dd ${(r.killSwitch.dd * 100).toFixed(1)}%)` : 'kill-switch clear';
    return `${r.name.padEnd(28)} CAGR ${String(m.cagrPct).padStart(6)}%  xSharpe ${String(m.sharpe).padStart(5)}  (rf0 ${String(m.sharpeRf0).padStart(5)})  Sortino ${String(m.sortino).padStart(5)}  MaxDD ${String(m.maxDrawdownPct).padStart(5)}%  PF ${pf}  turnover ${to}x/yr  trades ${m.trades}  liqFlags ${r.liquidity.flagged}/${r.liquidity.checked}  ${r.killSwitch !== undefined ? ks : ''}`;
  };

  // Warmup runs from 2008 so the 12-1 formation window and the 200-DMA gate are
  // fully warm by the scoring start (extra warmup can't tune anything — it only
  // makes indicators warm sooner).
  const window = holdout
    ? { from: '2020-01-01', to: null, warmupFrom: '2018-01-01', allowHoldout: true }
    : { from: '2010-01-01', to: '2019-12-31', warmupFrom: '2008-01-01' };
  console.log(holdout
    ? '\n=== HOLDOUT (2020-01-01 → present) — ONE-SHOT evaluation ==='
    : '\n=== IN-SAMPLE (2010-01-01 → 2019-12-31) ===');

  const alignCache = new Map(); // same clipped data across the grid -> one aligned grid
  const universe = Object.keys(dataBySymbol);
  const base = makeXsmomSpec(universe);
  const res = evaluateBasket({ spec: base.spec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...window });
  console.log(fmt(res));
  console.log(fmt({ ...res.benchmark, killSwitch: undefined }));
  console.log(`window: ${res.window.from} → ${res.window.to} (${res.window.bars} bars, ${res.window.warmupBars} warmup) — costs: ${res.costs.model}; holdings now: ${res.position}`);

  if (!holdout) {
    console.log('\n=== ±50% single-parameter perturbation (in-sample) ===');
    console.log('base:', JSON.stringify(base.params));
    const paramNames = ['lookback', 'skip', 'k', 'rebalanceBars', 'gateSma', 'gateBuffer'];
    for (const name of paramNames) {
      for (const f of [0.5, 0.75, 1.25, 1.5]) {
        const { spec, params } = makeXsmomSpec(universe, { ...DEFAULTS, [name]: DEFAULTS[name] * f });
        const r = evaluateBasket({ spec, dataBySymbol, marketSeries: market, alignCache, ...window });
        const to = r.turnoverPerYear == null ? '–' : r.turnoverPerYear.toFixed(2);
        console.log(`${name.padEnd(12)} ×${String(f).padEnd(4)} = ${String(+params[name].toFixed(4)).padStart(8)}  xSharpe ${String(r.metrics.sharpe).padStart(5)}  Sortino ${String(r.metrics.sortino).padStart(5)}  CAGR ${String(r.metrics.cagrPct).padStart(6)}%  MaxDD ${String(r.metrics.maxDrawdownPct).padStart(5)}%  turnover ${to}x  trades ${r.metrics.trades}${r.killSwitch ? '  ⚠ kill-switch breach' : ''}`);
      }
    }
  }
}
