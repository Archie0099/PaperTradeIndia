// lowvol-grid.mjs — is the low-volatility result ROBUST, or did one lucky cell get picked?
//
// WHY THIS EXISTS, and the mistake it exists to catch
// ---------------------------------------------------
// `rank-zoo.mjs` scored a low-volatility rank at 0.93 — outside its random band, with the
// lowest drawdown of anything tested. That was written up as worth re-examining. Before going
// any further it is worth being honest that THREE DIFFERENT STRATEGIES here share the name
// "low volatility" and none of them is the same experiment:
//
//   the live `basket-lowvol` bot   vol lookback  20, k =  4, per-name trend gate
//   an earlier research study       vol lookback 252, k = 15, no gate
//   the rank-zoo row                vol lookback  60, k = 10, market gate
//
// So the zoo's 0.93 says nothing directly about either of the others, and comparing them as if
// it did would be exactly the error this project keeps catching: a result that sounds like it
// replicates something when it is a different spec entirely.
//
// It also raises the obvious worry. If one cell of an unexplored grid scores well, the honest
// question is not "is it good" but "how many cells did I look at". A single winner out of twelve
// is what noise looks like. So: run the WHOLE grid, every cell through identical machinery, and
// count how many clear the SAME random null. That is the difference between a finding and a
// lucky draw, and it is cheap to settle.
//
// PRE-REGISTERED READING, decided before the run:
//   * If MOST cells clear the null band, the low-volatility axis is real here and the specific
//     lookback/k barely matters — which is the signature of an effect rather than a fit.
//   * If ONE OR TWO cells clear and the rest sit at the median, the zoo row was noise-mining
//     and the flag raised from it should be withdrawn.
//   * Drawdown is expected to improve monotonically as the lookback lengthens (a longer window
//     is a steadier estimate of which names are actually calm). If drawdown is UNRELATED to the
//     lookback, the rank is not measuring what it claims to.
//
// Read-only. In-sample 2010-2019; the later holdout stays unspent.
//
// Usage: node backtest/research/lowvol-grid.mjs

import { pathToFileURL } from 'node:url';
import { makeControlSpec, sampleNames } from './lowvol.mjs';
import { DEFAULTS as XS } from './xsmom.mjs';
import { validateSpec } from '../dsl.mjs';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('lowvol-grid.mjs is a CLI tool; run it directly.');

const { loadCandles } = await import('../data.mjs');
const { evaluateBasket } = await import('./harness.mjs');
const { BASKET_UNIVERSE } = await import('../../tournament/universe.mjs');

const dataBySymbol = {};
let dropped = 0;
for (const s of BASKET_UNIVERSE) {
  const { candles, source } = await loadCandles(s, { interval: '1d', range: '20y' });
  if (/synthetic/.test(source) || candles.length < 300) { dropped++; continue; }
  dataBySymbol[s] = candles;
}
const { candles: market, source: mSrc } = await loadCandles('NIFTY', { interval: '1d', range: '20y' });
const { candles: bench } = await loadCandles('NIFTYBEES', { interval: '1d', range: '20y' });
if (/synthetic/.test(mSrc)) { console.error('refusing: market series is synthetic.'); process.exit(1); }

const universe = Object.keys(dataBySymbol);
const alignCache = new Map();
const WINDOW = { from: '2010-01-01', to: '2019-12-31', warmupFrom: '2008-01-01' };
const GATE = ['>', ['price'], ['*', 0.95, ['sma', XS.gateSma]]];

const LOOKBACKS = [20, 60, 126, 252];
const KS = [4, 10, 15];

console.log(`data: ${universe.length} names (${dropped} dropped)`);
console.log('★ EVERY cell, identical machinery — only the vol lookback and k change.');
console.log('★ IN-SAMPLE 2010-2019, net of real costs. Not a holdout.\n');

// The null first, so every cell is read against it rather than against the best cell.
const draws = [];
for (let seed = 1; seed <= 20; seed++) {
  for (const k of [10]) { // the null is k-matched to the middle of the grid
    const names = sampleNames(universe, k, seed);
    const sub = {};
    for (const n of names) sub[n] = dataBySymbol[n];
    const spec = { ...makeControlSpec(names, 0, k, XS.rebalanceBars), marketGate: GATE };
    draws.push(evaluateBasket({ spec, dataBySymbol: sub, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW }).metrics.sharpe);
  }
}
draws.sort((a, b) => a - b);
const nullMedian = draws[10], nullP90 = draws[18], nullMax = draws[19];
console.log(`RANDOM NULL (20 draws, k=10): min ${draws[0].toFixed(2)}  median ${nullMedian.toFixed(2)}  p90 ${nullP90.toFixed(2)}  max ${nullMax.toFixed(2)}\n`);

const cells = [];
console.log('lookback    k   CAGR   xSharpe   MaxDD   beaten-by-null');
console.log('-'.repeat(58));
for (const lb of LOOKBACKS) {
  for (const k of KS) {
    const spec = {
      kind: 'BASKET', name: `lowvol ${lb}/${k}`, universe,
      rank: ['*', -1, ['vol', lb]], k, weighting: 'volinv',
      rebalanceBars: XS.rebalanceBars, marketGate: GATE,
    };
    const err = validateSpec(spec);
    if (err) { console.log(`  ${lb}/${k} INVALID: ${err}`); continue; }
    const m = evaluateBasket({ spec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW }).metrics;
    const beaten = draws.filter((d) => d > m.sharpe).length;
    cells.push({ lb, k, m, beaten });
    console.log(
      String(lb).padStart(8) + String(k).padStart(5)
      + (m.cagrPct.toFixed(2) + '%').padStart(8)
      + m.sharpe.toFixed(2).padStart(10)
      + (m.maxDrawdownPct.toFixed(1) + '%').padStart(8)
      + `${beaten}/20`.padStart(16),
    );
  }
}

const clear = cells.filter((c) => c.beaten <= 2);
const atOrBelowMedian = cells.filter((c) => c.beaten >= 10);
console.log(`\nHOW MANY CELLS CLEAR THE NULL? ${clear.length} of ${cells.length} have <=2 of 20 random draws beating them.`);
console.log(`  ${atOrBelowMedian.length} of ${cells.length} sit at or below the random median.`);

if (clear.length >= cells.length * 0.6) {
  console.log('  -> ROBUST across the grid: the specific lookback and k barely matter, which is the');
  console.log('     signature of an effect rather than a fit. The zoo row was not a lucky cell.');
} else if (clear.length <= 2) {
  console.log('  -> NOISE-MINING. Only a cell or two clears, the rest sit at the median — the zoo row');
  console.log('     was a lucky draw out of many and the flag raised from it should be WITHDRAWN.');
} else {
  console.log('  -> MIXED. Some cells clear and some do not, so the result depends on a choice nobody');
  console.log('     has justified. Report it as parameter-dependent, not as an effect.');
}

// Does drawdown behave the way the thesis says it should?
console.log('\nDOES A LONGER LOOKBACK GIVE A STEADIER, CALMER BOOK (as the thesis requires)?');
for (const lb of LOOKBACKS) {
  const sub = cells.filter((c) => c.lb === lb);
  if (!sub.length) continue;
  const avgDD = sub.reduce((a, c) => a + c.m.maxDrawdownPct, 0) / sub.length;
  const avgS = sub.reduce((a, c) => a + c.m.sharpe, 0) / sub.length;
  console.log(`  lookback ${String(lb).padStart(3)}: avg MaxDD ${avgDD.toFixed(1)}%   avg xSharpe ${avgS.toFixed(2)}`);
}
console.log('  If drawdown does NOT fall as the lookback lengthens, the rank is not measuring the');
console.log('  thing it claims to and the whole low-vol story here needs re-stating.');

console.log('\n★ AND THE POINT THAT MUST NOT BE BLURRED: the LIVE `basket-lowvol` bot is vol-20 / k=4');
console.log('  with a per-name trend gate, the earlier study was vol-252 / k=15 ungated, and the rank-zoo');
console.log('  row was vol-60 / k=10. Three different strategies sharing one name. A number from any');
console.log('  one of them says nothing direct about the others — find your own cell in the grid above.');
