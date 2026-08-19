// universe-bench.mjs — the FAIR-BENCHMARK measurement for the advisor panel.
//
// WHY THIS EXISTS
// ---------------
// METHODOLOGY.md's rule (from the low-volatility study): a basket built by SELECTING
// from a universe must beat the SAME UNIVERSE selected without information — not the
// index. Every basket-vs-index number in this project carries a measured survivorship
// premium (an equal-weight portfolio of today's surviving names beats the index with
// no signal at all). The cross-sectional momentum study's holdout verdict (excess
// Sharpe 0.59 vs the index's 0.41) was scored against the INDEX, so before its live
// graduate (`xsmom-research`) is used to guide real-money suggestions, this answers
// the fair comparison: how does it do against the no-information universe control
// over the SAME holdout window?
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
import { makeControlSpec, sampleNames } from './lowvol.mjs';
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

  // ---- 3. THE ABLATION METHODOLOGY.md ACTUALLY PRESCRIBES.
  // The whole-universe controls above differ from the spec in THREE ways at once: the ranking
  // signal, the marketGate, and the HOLDINGS COUNT (k=104 vs k=10). A k=104 portfolio carries a
  // diversification premium worth ~0.1-0.2 Sharpe that has nothing to do with stock picking, so
  // subtracting it measures diversification, not selection. (Fixing only the gate is not enough
  // — that produced an earlier, wrong "the sign flips" reading. Don't restore it.)
  //
  // METHODOLOGY.md §139-142 prescribes the real test: re-run the IDENTICAL machinery (same k,
  // weighting, cadence, universe, costs, window) with the ranking signal removed, and report the
  // NULL DISTRIBUTION of seeded random portfolios of the same size. That is what this does.
  const xsSpec = makeXsmomSpec(universe).spec;
  const GATE = xsSpec.marketGate;
  const ungate = (sp) => { const c = { ...sp }; delete c.marketGate; return c; };
  const ev = (spec) => evaluateBasket({ spec, dataBySymbol, marketSeries: market, alignCache, ...window }).metrics.sharpe;
  const xsUngated = ev(ungate(xsSpec));
  // A k-MATCHED no-information portfolio: same machinery, names drawn at random, rank carries
  // no information (0 x vol keeps the null-while-unwarm exclusion identical to the controls).
  const nullSpec = (seed, gated) => {
    const sp = {
      kind: 'BASKET', name: `null-${seed}`, universe: sampleNames(universe, xsSpec.k, seed),
      rank: ['*', 0, ['vol', 20]], k: xsSpec.k, weighting: xsSpec.weighting, rebalanceBars: xsSpec.rebalanceBars,
    };
    return gated ? { ...sp, marketGate: GATE } : sp;
  };
  const N_NULL = 20;
  const pct = (arr, x) => arr.filter((v) => v >= x).length;
  console.log(`\nK-MATCHED NULL (k=${xsSpec.k}, ${xsSpec.weighting}, every ${xsSpec.rebalanceBars} bars — ${N_NULL} seeded random portfolios, the METHODOLOGY.md ablation):`);
  const summary = [];
  for (const gated of [false, true]) {
    const draws = [];
    for (let i = 0; i < N_NULL; i++) draws.push(nullSpec(i * 7919 + 13, gated));
    const scores = draws.map(ev).sort((a, b) => a - b);
    const med = (scores[(N_NULL >> 1) - 1] + scores[N_NULL >> 1]) / 2;
    const strat = gated ? xsmom.metrics.sharpe : xsUngated;
    const beat = pct(scores, strat);
    summary.push({ gated, med, strat, beat });
    console.log(`  gate ${gated ? 'ON ' : 'OFF'} both arms: strategy ${strat.toFixed(2)}  vs null median ${med.toFixed(2)}  ->  selection ${strat - med >= 0 ? '+' : ''}${(strat - med).toFixed(2)}   (${beat}/${N_NULL} random draws BEAT it; range ${scores[0].toFixed(2)}..${scores[N_NULL - 1].toFixed(2)})`);
  }
  const sel = summary.map((s) => s.strat - s.med);
  const worstBeat = Math.max(...summary.map((s) => s.beat));

  // ---- 4. The verdict the advisor banner copy is written from. TWO separate statements,
  // because they answer two different questions and only one of them is settled.
  const hardBar = Math.max(ctrlVolinv.metrics.sharpe, ctrlEqual.metrics.sharpe);
  const edgeVsIndex = xsmom.metrics.sharpe - ctrlVolinv.benchmark.metrics.sharpe;
  const edgeVsUniverse = xsmom.metrics.sharpe - hardBar;
  const selLo = Math.min(...sel);
  const selHi = Math.max(...sel);
  console.log('\nVERDICT:');
  console.log(`  edge vs the index:            ${edgeVsIndex >= 0 ? '+' : ''}${edgeVsIndex.toFixed(2)} xSharpe`);
  console.log(`  edge vs the universe control: ${edgeVsUniverse >= 0 ? '+' : ''}${edgeVsUniverse.toFixed(2)} xSharpe  (the fair bar — WHOLE SPEC, gate included)`);
  console.log('\n  (1) THE WHOLE SPEC — the thing you would actually follow:');
  if (edgeVsUniverse >= 0.15) console.log('      → beats a no-information portfolio of the same universe out-of-sample.');
  else if (edgeVsUniverse >= 0) console.log('      → roughly MATCHES a no-information portfolio of the same universe.');
  else console.log('      → TRAILS a no-information portfolio of the same universe: simply holding the whole\n        universe would have done better over this window. The index-relative edge is\n        survivorship (a no-signal portfolio of these names beats the index by ~0.5 Sharpe).');
  console.log('\n  (2) THE SELECTION ALONE — identical machinery, k-matched null:');
  if (selLo > 0 && worstBeat <= N_NULL * 0.1) console.log(`      → adds ${selLo.toFixed(2)}..${selHi.toFixed(2)} xSharpe over a k-matched null in BOTH arms, and only ${worstBeat}/${N_NULL} random draws beat it: a real selection edge.`);
  else if (selHi < 0) console.log(`      → costs ${selLo.toFixed(2)}..${selHi.toFixed(2)} xSharpe whichever way the gate is held: selection actively hurts.`);
  else console.log(`      → UNPROVEN: ${selLo.toFixed(2)}..${selHi.toFixed(2)} vs a k-matched null, and ${worstBeat} of ${N_NULL} random\n        portfolios of the same size BEAT it — the effect sits INSIDE THE NOISE BAND. Do NOT\n        claim the shortfall in (1) is a stock-picking failure: most of it is the k=104\n        diversification premium and the regime gate, neither of which is selection.`);
}
