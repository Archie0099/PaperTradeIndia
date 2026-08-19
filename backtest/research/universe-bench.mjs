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

  // ---- 3. SINGLE-VARIABLE ABLATION of the market gate.
  //
  // The spec carries a marketGate; the controls do not. So the headline comparison above
  // moves TWO things at once — the ranking signal AND the regime gate — and METHODOLOGY.md's
  // own rule is to "re-run the identical machinery with the ranking signal removed", i.e.
  // change one variable. Holding the gate fixed matters enormously here: the gate costs the
  // no-information control far more than it costs the momentum spec, so the sign of the
  // apparent "selection effect" FLIPS depending on which way you hold it. That is exactly
  // why the verdict below refuses to attribute the shortfall to selection.
  const GATE = xsmom.spec ? xsmom.spec.marketGate : makeXsmomSpec(universe).spec.marketGate;
  const ungate = (sp) => { const c = { ...sp }; delete c.marketGate; return c; };
  const gate = (sp) => ({ ...sp, marketGate: GATE });
  const ev = (spec) => evaluateBasket({ spec, dataBySymbol, marketSeries: market, alignCache, ...window }).metrics.sharpe;
  const xsUngated = ev(ungate(makeXsmomSpec(universe).spec));
  const ctrlVolinvGated = ev(gate(makeControlSpec(universe, 0, universe.length)));
  const ctrlEqualGated = ev(gate(makeEqualWeightControl(universe)));
  const hardBarUngated = Math.max(ctrlVolinv.metrics.sharpe, ctrlEqual.metrics.sharpe);
  const hardBarGated = Math.max(ctrlVolinvGated, ctrlEqualGated);

  console.log('\nGATE ABLATION (one variable at a time — the gate held FIXED across both arms):');
  console.log(`  gate OFF both arms:  momentum ${xsUngated.toFixed(2)}  vs control ${hardBarUngated.toFixed(2)}  ->  selection ${(xsUngated - hardBarUngated >= 0 ? '+' : '')}${(xsUngated - hardBarUngated).toFixed(2)}`);
  console.log(`  gate ON  both arms:  momentum ${xsmom.metrics.sharpe.toFixed(2)}  vs control ${hardBarGated.toFixed(2)}  ->  selection ${(xsmom.metrics.sharpe - hardBarGated >= 0 ? '+' : '')}${(xsmom.metrics.sharpe - hardBarGated).toFixed(2)}`);
  console.log(`  the gate itself costs: ${(xsmom.metrics.sharpe - xsUngated).toFixed(2)} on the strategy, ${(hardBarGated - hardBarUngated).toFixed(2)} on the control`);

  // ---- 4. The verdict the advisor banner copy is written from. TWO separate statements,
  // because they answer two different questions and only one of them is settled.
  const hardBar = hardBarUngated;
  const edgeVsIndex = xsmom.metrics.sharpe - ctrlVolinv.benchmark.metrics.sharpe;
  const edgeVsUniverse = xsmom.metrics.sharpe - hardBar;
  const selLo = Math.min(xsUngated - hardBarUngated, xsmom.metrics.sharpe - hardBarGated);
  const selHi = Math.max(xsUngated - hardBarUngated, xsmom.metrics.sharpe - hardBarGated);
  console.log('\nVERDICT:');
  console.log(`  edge vs the index:            ${edgeVsIndex >= 0 ? '+' : ''}${edgeVsIndex.toFixed(2)} xSharpe`);
  console.log(`  edge vs the universe control: ${edgeVsUniverse >= 0 ? '+' : ''}${edgeVsUniverse.toFixed(2)} xSharpe  (the fair bar — WHOLE SPEC, gate included)`);
  console.log('\n  (1) THE WHOLE SPEC — the thing you would actually follow:');
  if (edgeVsUniverse >= 0.15) console.log('      → beats a no-information portfolio of the same universe out-of-sample.');
  else if (edgeVsUniverse >= 0) console.log('      → roughly MATCHES a no-information portfolio of the same universe.');
  else console.log('      → TRAILS a no-information portfolio of the same universe: simply holding the whole\n        universe would have done better over this window. The index-relative edge is\n        survivorship (a no-signal portfolio of these names beats the index by ~0.5 Sharpe).');
  console.log('\n  (2) THE SELECTION ALONE — gate held fixed, one variable:');
  if (selLo > 0) console.log(`      → adds ${selLo.toFixed(2)}..${selHi.toFixed(2)} xSharpe whichever way the gate is held: a real selection edge.`);
  else if (selHi < 0) console.log(`      → costs ${selLo.toFixed(2)}..${selHi.toFixed(2)} xSharpe whichever way the gate is held: selection actively hurts.`);
  else console.log(`      → UNPROVEN in either direction: ${selLo.toFixed(2)} with the gate off, ${selHi.toFixed(2)} with it on —\n        the sign flips with the gate, so this window cannot settle it. Do NOT claim the\n        shortfall in (1) is a stock-picking failure; most of it is the regime gate.`);
}
