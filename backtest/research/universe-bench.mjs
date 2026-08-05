// universe-bench.mjs — the FAIR-BENCHMARK measurement for the advisor panel.
//
// WHY THIS EXISTS
// ---------------
// METHODOLOGY.md's rule (from the low-volatility study): a basket built by SELECTING
// from a universe must beat the SAME UNIVERSE selected without information — not the
// index. Every basket-vs-index number in this project carries a measured survivorship
// premium (an equal-weight portfolio of today's surviving names beats the index with
// no signal at all). The cross-sectional momentum study's holdout verdict (excess
// Sharpe 0.59 vs the index's 0.40) was scored against the INDEX, so before its live
// graduate (`xsmom-research`) is used to guide real-money suggestions, the fair
// comparison has to be made: how does it do against the no-information universe
// control over the SAME holdout window?
//
// WHAT THIS IS NOT
// ----------------
// This does NOT spend or re-spend a holdout. The momentum holdout was already spent
// (one shot, recorded); re-running the identical locked spec reproduces that number.
// The universe controls are BENCHMARKS — no-information portfolios with nothing to
// tune — so evaluating them on the holdout window is computing a yardstick, not
// evaluating a new strategy. No strategy parameters are chosen here.
//
// WHAT IT RUNS (all with real delivery costs, holdout window 2020-01-01 → data end)
// ---------------------------------------------------------------------------------
//   1. VALIDATION ANCHORS (in-sample 2010-2019): the whole-universe control and the
//      NIFTYBEES Buy & Hold, which must reproduce the low-vol study's published
//      figures (control ≈ xSharpe 0.85, bench ≈ 0.24) before the harness is trusted
//      to say anything new.
//   2. HOLDOUT: NIFTYBEES Buy & Hold (the index yardstick), the whole-universe
//      control in BOTH weightings (inverse-vol — identical to the study's control —
//      and literal equal weight), and the momentum spec itself (byte-equal to the
//      live seed via makeXsmomSpec).
//   3. The verdict line the advisor panel's banner copy is written from.
//
// Usage: node backtest/research/universe-bench.mjs
// Deterministic, cache-served, zero network beyond the usual Yahoo cache fill.

import { pathToFileURL } from 'node:url';
import { makeControlSpec } from './lowvol.mjs';
import { makeXsmomSpec } from './xsmom.mjs';
import { validateSpec } from '../dsl.mjs';

// The literal equal-weight variant of the study's control: same no-information rank
// (0 × vol keeps the null-while-unwarm exclusion identical), same cadence, but every
// held name gets the same weight instead of inverse-vol. Reported alongside the
// study's own control so the verdict can quote whichever is the HARDER bar.
function makeEqualWeightControl(universe) {
  const spec = { ...makeControlSpec(universe, 0, universe.length), name: 'Control (equal weight)', weighting: 'equal' };
  const err = validateSpec(spec);
  if (err) throw new Error(`equal-weight control invalid: ${err}`);
  return spec;
}

export { makeEqualWeightControl };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { loadCandles } = await import('../data.mjs');
  const { evaluateBasket } = await import('./harness.mjs');
  const { BASKET_UNIVERSE } = await import('../../tournament/universe.mjs');

  // Same load-and-drop rule as every research CLI: no synthetic bars, no stubs.
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
  const universe = Object.keys(dataBySymbol);
  console.log(`data: ${universe.length} universe names loaded (${dropped} dropped), NIFTYBEES bench ${bench.length} bars`);
  console.log('★ SURVIVORSHIP: the universe is today\'s liquid names held fixed across history — every figure below is an UPPER BOUND (METHODOLOGY.md).');
  console.log('★ The universe controls carry the SAME survivorship bias — they are a FAIRER yardstick than the index, not a bias-free one.');

  const fmt = (r) => {
    const m = r.metrics;
    return `${r.name.padEnd(28)} CAGR ${m.cagrPct.toFixed(2).padStart(6)}%  xSharpe ${m.sharpe.toFixed(2).padStart(5)}  Sortino ${m.sortino.toFixed(2).padStart(5)}  MaxDD ${m.maxDrawdownPct.toFixed(1).padStart(5)}%`;
  };

  const alignCache = new Map();

  // ---- 1. Validation anchors (in-sample 2010-2019) — must reproduce the published figures.
  const inSample = { from: '2010-01-01', to: '2019-12-31', warmupFrom: '2008-01-01' };
  const anchor = evaluateBasket({ spec: makeControlSpec(universe, 0, universe.length), dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...inSample });
  console.log('\nVALIDATION ANCHORS (in-sample 2010-2019 — expect control ≈ 0.85, bench ≈ 0.24):');
  console.log('  ' + fmt({ ...anchor, name: 'Universe control (volinv)' }));
  console.log('  ' + fmt({ ...anchor.benchmark, name: 'NIFTYBEES Buy & Hold' }));

  // ---- 2. The holdout-window comparison.
  const window = { from: '2020-01-01', to: null, warmupFrom: '2018-01-01', allowHoldout: true };
  const ctrlVolinv = evaluateBasket({ spec: makeControlSpec(universe, 0, universe.length), dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...window });
  const ctrlEqual = evaluateBasket({ spec: makeEqualWeightControl(universe), dataBySymbol, marketSeries: market, alignCache, ...window });
  const xsmom = evaluateBasket({ spec: makeXsmomSpec(universe).spec, dataBySymbol, marketSeries: market, alignCache, ...window });

  console.log('\nHOLDOUT WINDOW (2020-01-01 → data end, real delivery costs):');
  console.log('  ' + fmt({ ...ctrlVolinv.benchmark, name: 'NIFTYBEES Buy & Hold' }));
  console.log('  ' + fmt({ ...ctrlVolinv, name: 'Universe control (volinv)' }));
  console.log('  ' + fmt({ ...ctrlEqual, name: 'Universe control (equal)' }));
  console.log('  ' + fmt({ ...xsmom, name: 'Momentum 12-1 (the spec)' }));

  // ---- 3. The verdict the advisor banner copy is written from: the edge over the
  // HARDER of the two no-information controls, not over the index.
  const hardBar = Math.max(ctrlVolinv.metrics.sharpe, ctrlEqual.metrics.sharpe);
  const edgeVsIndex = xsmom.metrics.sharpe - ctrlVolinv.benchmark.metrics.sharpe;
  const edgeVsUniverse = xsmom.metrics.sharpe - hardBar;
  console.log('\nVERDICT:');
  console.log(`  edge vs the index:            ${edgeVsIndex >= 0 ? '+' : ''}${edgeVsIndex.toFixed(2)} xSharpe`);
  console.log(`  edge vs the universe control: ${edgeVsUniverse >= 0 ? '+' : ''}${edgeVsUniverse.toFixed(2)} xSharpe  (the fair bar)`);
  if (edgeVsUniverse >= 0.15) {
    console.log('  → the selection carries a real edge over a fair benchmark out-of-sample.');
  } else if (edgeVsUniverse >= 0) {
    console.log('  → the selection roughly MATCHES a no-information universe portfolio — its edge over a fair benchmark is unproven.');
  } else {
    console.log('  → the selection TRAILS a no-information universe portfolio — the index-relative edge was survivorship, not selection.');
  }
}
