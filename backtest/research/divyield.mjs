// divyield.mjs — does ranking on TRAILING DIVIDEND YIELD earn anything, once the right
// benchmark is used?
//
// WHY THE BENCHMARK IS THE WHOLE QUESTION HERE
// --------------------------------------------
// A yield tilt inside a survivorship-selected large-cap universe will beat the INDEX almost by
// construction — the names that paid dividends steadily for twenty years are, definitionally,
// the ones that survived twenty years. Measuring this against NIFTY would produce a large, real
// and completely meaningless number. So it is measured against the no-information control at the
// same holdings count AND a random-draw band, exactly like every other signal here.
//
// This is the first FUNDAMENTAL signal reachable in a price-only project: `divYield` recovers the
// dividend stream from the gap between the adjusted and raw close series (see dsl.mjs, and
// adjusted-vs-raw.mjs for the universe-wide validation of the mechanism). Verified on real names
// before this ran: COALINDIA 7.03%/yr, ITC 4.88%, HINDUNILVR 1.81%, RELIANCE 0.86%, and exact
// zeros for ABCAPITAL and DMART — every one independently correct.
//
// PRE-REGISTERED, written before the run:
//   * high yield        the actual candidate. International evidence for a PURE yield tilt is
//                       weak (it is usually a value or quality proxy), so a null is likely.
//   * low yield         the INVERSE. If both ends score alike the axis is dead; a wide spread
//                       means yield carries information even if the tradeable end is thin.
//   * yield + momentum  the honest reason to want a fundamental signal here: it should be
//                       DIFFERENT from price momentum, not a slower copy of it.
//   * turnover          expected FAR lower than momentum — dividend status changes once or twice
//                       a year. If turnover is high, the operator is measuring something else.
//
// Read-only. In-sample 2010-2019; the later holdout stays unspent.
//
// Usage: node backtest/research/divyield.mjs

import { pathToFileURL } from 'node:url';
import { makeControlSpec, sampleNames, nullDrawPool } from './lowvol.mjs';
import { rank12_1, DEFAULTS as XS } from './xsmom.mjs';
import { validateSpec } from '../dsl.mjs';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('divyield.mjs is a CLI tool; run it directly.');

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
const base = { kind: 'BASKET', universe, k: XS.k, weighting: 'volinv', rebalanceBars: XS.rebalanceBars, marketGate: GATE };

// NOTE on the combo arm: yields are a few percent and momentum is tens of percent, so the yield
// leg is scaled by 10 to make the two comparable. That multiplier is a CHOICE, not a result —
// it was fixed before running and is not tuned. Read the combo as "does adding yield help at
// all", never as an optimised blend.
const ARMS = [
  ['high yield (the candidate)', ['divYield', 252]],
  ['low yield (INVERSE)', ['*', -1, ['divYield', 252]]],
  ['yield, 2y lookback', ['divYield', 400]],
  ['yield + momentum', ['+', ['*', 10, ['divYield', 252]], rank12_1(XS.lookback, XS.skip)]],
  ['momentum alone (reference)', rank12_1(XS.lookback, XS.skip)],
];

console.log(`data: ${universe.length} names (${dropped} dropped)`);
console.log('★ SAME universe, k, weighting, grid, gate, costs, window — only `rank` moves.');
console.log('★ Measured against the k-matched control and a random band, NOT the index: a yield');
console.log('  tilt in a survivorship universe beats the index almost by construction.\n');

const rows = [];
for (const [label, rank] of ARMS) {
  const spec = { ...base, name: label, rank };
  const err = validateSpec(spec);
  if (err) { console.log(`  ${label}: INVALID ${err}`); continue; }
  const m = evaluateBasket({ spec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW }).metrics;
  rows.push({ label, m });
}

const ctrl = evaluateBasket({
  spec: { ...makeControlSpec(universe, 0, XS.k, XS.rebalanceBars), marketGate: GATE },
  dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW,
}).metrics;

const draws = [];
for (let seed = 1; seed <= 20; seed++) {
  const names = sampleNames(nullDrawPool(universe, dataBySymbol, WINDOW.from), XS.k, seed);
  const sub = {};
  for (const n of names) sub[n] = dataBySymbol[n];
  draws.push(evaluateBasket({
    spec: { ...makeControlSpec(names, 0, XS.k, XS.rebalanceBars), marketGate: GATE },
    dataBySymbol: sub, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW,
  }).metrics.sharpe);
}
draws.sort((a, b) => a - b);

console.log('arm'.padEnd(28) + 'CAGR'.padStart(8) + 'xSharpe'.padStart(9) + 'MaxDD'.padStart(8) + 'trades'.padStart(8) + '  beaten');
console.log('-'.repeat(72));
for (const r of rows) {
  const beaten = draws.filter((d) => d > r.m.sharpe).length;
  console.log(r.label.padEnd(28) + (r.m.cagrPct.toFixed(2) + '%').padStart(8) + r.m.sharpe.toFixed(2).padStart(9)
    + (r.m.maxDrawdownPct.toFixed(1) + '%').padStart(8) + String(r.m.trades).padStart(8) + `  ${beaten}/20`);
}
console.log('-'.repeat(72));
console.log('no-info control k=10'.padEnd(28) + (ctrl.cagrPct.toFixed(2) + '%').padStart(8) + ctrl.sharpe.toFixed(2).padStart(9)
  + (ctrl.maxDrawdownPct.toFixed(1) + '%').padStart(8) + String(ctrl.trades).padStart(8));
console.log(`random null: min ${draws[0].toFixed(2)}  median ${draws[10].toFixed(2)}  p90 ${draws[18].toFixed(2)}  max ${draws[19].toFixed(2)}`);

const hi = rows.find((r) => r.label.startsWith('high yield'));
const lo = rows.find((r) => r.label.startsWith('low yield'));
const mom = rows.find((r) => r.label.startsWith('momentum alone'));
const combo = rows.find((r) => r.label.startsWith('yield + momentum'));

console.log('\nVERDICT');
if (hi && lo) {
  console.log(`  YIELD AXIS: high ${hi.m.sharpe.toFixed(2)} vs low ${lo.m.sharpe.toFixed(2)} — spread ${(hi.m.sharpe - lo.m.sharpe).toFixed(2)}.`);
  console.log('    A wide spread means the axis carries information even if neither end is tradeable;');
  console.log('    a narrow one means sorting on yield says nothing about return on this universe.');
}
if (hi) {
  const beaten = draws.filter((d) => d > hi.m.sharpe).length;
  console.log(`  THE CANDIDATE: beaten by ${beaten}/20 random draws, and ${(hi.m.sharpe - ctrl.sharpe >= 0 ? '+' : '') + (hi.m.sharpe - ctrl.sharpe).toFixed(2)} vs the k-matched control.`);
  console.log(beaten <= 2 ? '    -> clears the band.' : '    -> INSIDE the band: not shown to do anything.');
}
if (combo && mom) {
  const d = combo.m.sharpe - mom.m.sharpe;
  console.log(`  DOES IT ADD TO MOMENTUM? combo ${combo.m.sharpe.toFixed(2)} vs momentum alone ${mom.m.sharpe.toFixed(2)} (${(d >= 0 ? '+' : '') + d.toFixed(2)}).`);
  console.log(d > 0.05 ? '    -> it adds something momentum did not already have.' : '    -> it adds nothing; momentum already contains whatever this sees.');
}
if (hi && mom) {
  console.log(`  TURNOVER: yield ${hi.m.trades} trades vs momentum ${mom.m.trades}.`);
  console.log('    Dividend status changes once or twice a year, so a yield rank SHOULD be the');
  console.log('    cheapest signal on the board. If it is not, the operator is measuring something else.');
}
