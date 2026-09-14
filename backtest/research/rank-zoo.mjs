// rank-zoo.mjs — every ranking signal the DSL can express today, through identical machinery,
// against the same controls and the same random null.
//
// WHY ONE STUDY INSTEAD OF EIGHT
// ------------------------------
// A survey of the literature left a tail of cheap candidates — echo momentum, short-term reversal,
// low-volatility, a few others — each of which is a ONE-FIELD change to a spec. Run separately
// they would be eight studies with eight chances to accidentally vary something else. Run
// together, with the universe, k, weighting, rebalance grid, gate, costs and window pinned, the
// only thing that differs between rows is the ranking expression. That is the ablation the
// methodology asks for, done once.
//
// It also makes the comparison that matters cheap: EVERY row is scored against the same
// no-information control at the same k AND the same distribution of random k-name portfolios.
// A signal is only interesting if it clears the random band — beating the index means nothing
// here, because the universe is today's survivors and a no-signal portfolio of the same names
// already beats the index by roughly 0.6 Sharpe.
//
// PRE-REGISTERED EXPECTATIONS (written before running, so the result cannot be rationalised):
//   mom 12-1        the incumbent. Expected near the TOP of the random band, not outside it.
//   echo 12-7       Novy-Marx (2012) says the intermediate horizon carries momentum; Goyal &
//                   Wahal (2015, JFQA) tested 37 non-US countries and found NO echo. EXPECT FAIL.
//   reversal 1m     real gross, but a liquidity-provision premium a retail taker is on the wrong
//                   side of; Chui et al. (2023, PBFJ) find Indian reversal lives in ILLIQUID
//                   names while momentum lives in liquid ones. EXPECT FAIL, possibly badly.
//   52w high        already measured as a failure in its own study; included as a CONSISTENCY
//                   CHECK — if it scores differently here, this harness disagrees with that one
//                   and something is wrong.
//   low vol         an earlier study here published this as a negative (its edge looked like survivorship).
//                   EXPECT FAIL. Included so the zoo reproduces a known result.
//   high vol        the INVERSE of low vol. A pair that both fail tells you the axis is dead;
//                   a pair where one wins and the other loses badly is the shape of a real
//                   effect. This is the ablation, not a candidate.
//   trend slope     a plain trend-strength rank, the simplest thing nobody had tested.
//   rsi reversal    short-horizon mean reversion on a bounded oscillator.
//
// Read-only. In-sample 2010-2019; the later holdout stays unspent.
//
// Usage: node backtest/research/rank-zoo.mjs [--null]

import { pathToFileURL } from 'node:url';
import { makeControlSpec, sampleNames } from './lowvol.mjs';
import { rank12_1, DEFAULTS as XS } from './xsmom.mjs';
import { validateSpec } from '../dsl.mjs';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('rank-zoo.mjs is a CLI tool; run it directly.');

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

// Identical in every respect except `rank`.
const base = {
  kind: 'BASKET', universe, k: XS.k, weighting: 'volinv',
  rebalanceBars: XS.rebalanceBars, marketGate: GATE,
};

const SIGNALS = [
  ['mom 12-1 (incumbent)', rank12_1(XS.lookback, XS.skip), 'near the top of the band, not outside'],
  ['echo 12-7', rank12_1(252, 126), 'FAIL — no echo outside the US'],
  ['reversal 1m', ['*', -1, ['mom', 21]], 'FAIL — reversal lives in illiquid names'],
  ['52w high', ['distHigh', 252], 'FAIL — consistency check vs high52.mjs'],
  ['low vol', ['*', -1, ['vol', 60]], 'FAIL — already published as survivorship'],
  ['high vol (inverse)', ['vol', 60], 'ablation, not a candidate'],
  ['trend slope 100', ['slope', 100], 'untested — no strong prior'],
  ['rsi reversal', ['*', -1, ['rsi', 14]], 'untested — no strong prior'],
];

console.log(`data: ${universe.length} names (${dropped} dropped)`);
console.log('★ ONE VARIABLE: same universe, k, weighting, grid, gate, costs, window — only `rank` moves.');
console.log('★ IN-SAMPLE 2010-2019, net of the real Indian cost model. Not a holdout.\n');

const rows = [];
for (const [label, rank, expectation] of SIGNALS) {
  const spec = { ...base, name: label, rank };
  const err = validateSpec(spec);
  if (err) { console.log(`  ${label.padEnd(22)} SPEC INVALID: ${err}`); continue; }
  const r = evaluateBasket({ spec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW });
  rows.push({ label, expectation, m: r.metrics });
}

// The two controls: a no-information rank at the SAME k, and the whole universe equal-weighted.
const ctrlSpec = { ...makeControlSpec(universe, 0, XS.k, XS.rebalanceBars), marketGate: GATE };
const ctrl = evaluateBasket({ spec: ctrlSpec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW }).metrics;
const uniSpec = { ...makeControlSpec(universe, 0, universe.length, XS.rebalanceBars), weighting: 'equal', marketGate: GATE };
const uni = evaluateBasket({ spec: uniSpec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW }).metrics;

rows.sort((a, b) => b.m.sharpe - a.m.sharpe);
console.log('signal'.padEnd(24) + 'CAGR'.padStart(8) + 'xSharpe'.padStart(9) + 'cashAdj'.padStart(9) + 'MaxDD'.padStart(8) + 'trades'.padStart(8));
console.log('-'.repeat(66));
for (const r of rows) {
  console.log(
    r.label.padEnd(24)
    + (r.m.cagrPct.toFixed(2) + '%').padStart(8)
    + r.m.sharpe.toFixed(2).padStart(9)
    + r.m.sharpeCashAdj.toFixed(2).padStart(9)
    + (r.m.maxDrawdownPct.toFixed(1) + '%').padStart(8)
    + String(r.m.trades).padStart(8),
  );
}
console.log('-'.repeat(66));
console.log('no-info control k=10'.padEnd(24) + (ctrl.cagrPct.toFixed(2) + '%').padStart(8) + ctrl.sharpe.toFixed(2).padStart(9) + ctrl.sharpeCashAdj.toFixed(2).padStart(9) + (ctrl.maxDrawdownPct.toFixed(1) + '%').padStart(8));
console.log('whole universe, equal'.padEnd(24) + (uni.cagrPct.toFixed(2) + '%').padStart(8) + uni.sharpe.toFixed(2).padStart(9) + uni.sharpeCashAdj.toFixed(2).padStart(9) + (uni.maxDrawdownPct.toFixed(1) + '%').padStart(8));

// ---- the random band: the only benchmark that settles anything here
let band = null;
if (process.argv.includes('--null')) {
  const draws = [];
  for (let seed = 1; seed <= 20; seed++) {
    const names = sampleNames(universe, XS.k, seed);
    const sub = {};
    for (const n of names) sub[n] = dataBySymbol[n];
    const spec = { ...makeControlSpec(names, 0, XS.k, XS.rebalanceBars), marketGate: GATE };
    draws.push(evaluateBasket({ spec, dataBySymbol: sub, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW }).metrics.sharpe);
  }
  draws.sort((a, b) => a - b);
  band = { lo: draws[0], p50: draws[10], p90: draws[18], hi: draws[19], draws };
  console.log(`\nRANDOM NULL — 20 seeded 10-name portfolios, same machinery:`);
  console.log(`  min ${band.lo.toFixed(2)}   median ${band.p50.toFixed(2)}   p90 ${band.p90.toFixed(2)}   max ${band.hi.toFixed(2)}`);
}

console.log('\nVERDICT — each signal against its PRE-REGISTERED expectation');
for (const r of rows) {
  const vsCtrl = r.m.sharpe - ctrl.sharpe;
  let verdict;
  if (band) {
    const beaten = band.draws.filter((d) => d > r.m.sharpe).length;
    verdict = beaten <= 1 ? `OUTSIDE the random band (only ${beaten}/20 beat it)`
      : beaten >= 10 ? `INSIDE the band, at or below its median (${beaten}/20 beat it)`
        : `INSIDE the band (${beaten}/20 beat it)`;
  } else {
    verdict = `${(vsCtrl >= 0 ? '+' : '') + vsCtrl.toFixed(2)} vs the k-matched control`;
  }
  console.log(`  ${r.label.padEnd(24)} ${r.m.sharpe.toFixed(2)}  ${verdict}`);
  console.log(`  ${''.padEnd(24)} expected: ${r.expectation}`);
}

const lowVol = rows.find((r) => r.label === 'low vol');
const highVol = rows.find((r) => r.label === 'high vol (inverse)');
if (lowVol && highVol) {
  console.log(`\n  VOLATILITY AXIS ABLATION: low ${lowVol.m.sharpe.toFixed(2)} vs high ${highVol.m.sharpe.toFixed(2)}`
    + ` (spread ${(lowVol.m.sharpe - highVol.m.sharpe).toFixed(2)}).`);
  console.log('  A large spread means the axis carries information even if neither end is tradeable;');
  console.log('  a small one means sorting on volatility tells you nothing about return here.');
}

console.log('\n★ READ EVERY ROW THROUGH THE BAND, NOT THROUGH THE INDEX. This universe is today\'s');
console.log('  survivors held fixed across history, so beating NIFTY is worth roughly 0.6 Sharpe for');
console.log('  free. A signal that does not clear the random band has not been shown to do anything.');
