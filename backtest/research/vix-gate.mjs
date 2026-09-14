// vix-gate.mjs — should a basket step aside on VOLATILITY instead of on TREND?
//
// THE QUESTION
// ------------
// Every gated basket here uses the same regime filter: hold only while NIFTY trades above 95%
// of a long moving average. That is a TREND gate, and its entire measured benefit was 2008.
// India VIX offers a different question to ask of the same moment — not "is the market falling"
// but "is the market frightened" — and fear leads price. If the vol gate is better, it should
// step aside EARLIER and give back less.
//
// A survey of the literature listed this as a candidate worth building, and it was testable
// the moment India VIX was wired in.
//
// ★ THE PRE-REGISTERED NULL, and it is published, not invented here.
// Londono (2011, Fed IFDP 1035) tested variance premiums across countries and found that only
// the US premium predicts local equity returns — elsewhere it does not. Bollerslev, Tauchen &
// Zhou (2009, RFS 22(11)), the paper the whole idea rests on, is US-only. So the honest prior
// is that this FAILS in India, and a win would be the surprise.
//
// THE DESIGN — one variable, and the gate arms must be comparable
// ---------------------------------------------------------------
// Same selection, same k, same weighting, same grid, same costs, same window. ONLY the gate
// changes:
//   none          no filter at all — the baseline both gates must beat
//   trend         the board's own gate: NIFTY > 0.95 x SMA(200)
//   vixLevel      stand aside while India VIX is above a fixed threshold
//   vixRel        stand aside while India VIX is above its own trailing average (regime-relative,
//                 so it does not bake in a level that only suits one era)
//   INVERTED vix  the same rule backwards — the ablation that catches a gate which is merely
//                 reacting to something incidental. If inverting does about as well, the gate
//                 is not reading fear, it is reading noise.
//
// A gate is only interesting if it beats BOTH no-gate and the trend gate, and if its inverse is
// clearly worse. Anything else is a filter that happens to have been lucky.
//
// IMPLEMENTATION NOTE — why the VIX gate is passed as a market series and not an expression.
// A basket's `marketGate` is evaluated against ONE market proxy's close array. So the VIX arms
// run with India VIX ITSELF as the market series and a gate expression over its closes, while
// the trend arm runs with NIFTY as the market series. The selection, universe and costs are
// untouched in both — only what the gate reads differs, which is exactly the variable.
//
// Read-only. In-sample; the later holdout stays unspent. India VIX history begins 2015-08, so
// the window here is SHORTER than the other studies and cannot see 2008.
//
// Usage: node backtest/research/vix-gate.mjs

import { pathToFileURL } from 'node:url';
import { rank12_1, DEFAULTS as XS } from './xsmom.mjs';
import { validateSpec } from '../dsl.mjs';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('vix-gate.mjs is a CLI tool; run it directly.');

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
const { candles: nifty, source: nSrc } = await loadCandles('NIFTY', { interval: '1d', range: '20y' });
const { candles: vix, source: vSrc } = await loadCandles('INDIAVIX', { interval: '1d', range: '20y' });
const { candles: bench } = await loadCandles('NIFTYBEES', { interval: '1d', range: '20y' });
if (/synthetic/.test(nSrc) || /synthetic/.test(vSrc)) { console.error('refusing: a series is synthetic.'); process.exit(1); }

const universe = Object.keys(dataBySymbol);
const IST = 5.5 * 3600000;
const istDate = (t) => new Date(t + IST).toISOString().slice(0, 10);
// India VIX starts well after NIFTY — every arm must run over the SAME window or the
// comparison is between different eras rather than between different gates.
const WINDOW = { from: istDate(vix[0].t), to: '2019-12-31', warmupFrom: istDate(vix[0].t) };

console.log(`data: ${universe.length} names (${dropped} dropped)`);
console.log(`India VIX begins ${istDate(vix[0].t)} — so this window is SHORTER than the other studies and cannot see 2008.`);
console.log(`window: ${WINDOW.from} -> ${WINDOW.to}  (in-sample; the later holdout stays unspent)\n`);

const base = {
  kind: 'BASKET', name: 'mom 12-1', universe,
  rank: rank12_1(XS.lookback, XS.skip), k: XS.k,
  weighting: 'volinv', rebalanceBars: XS.rebalanceBars,
};

// The arms. `series` says WHICH market proxy the gate reads.
const arms = [
  ['no gate at all', {}, nifty],
  ['trend (the board\'s own)', { marketGate: ['>', ['price'], ['*', 0.95, ['sma', XS.gateSma]]] }, nifty],
  ['VIX < 20 (level)', { marketGate: ['<', ['price'], 20] }, vix],
  ['VIX < 25 (level)', { marketGate: ['<', ['price'], 25] }, vix],
  ['VIX < its own SMA100', { marketGate: ['<', ['price'], ['sma', 100]] }, vix],
  ['INVERTED: VIX > SMA100', { marketGate: ['>', ['price'], ['sma', 100]] }, vix],
  ['INVERTED: VIX > 20', { marketGate: ['>', ['price'], 20] }, vix],
];

const alignCache = new Map();
const out = [];
for (const [label, extra, series] of arms) {
  const spec = { ...base, ...extra, name: `${base.name} [${label}]` };
  const err = validateSpec(spec);
  if (err) { console.error(`${label}: ${err}`); continue; }
  const r = evaluateBasket({ spec, dataBySymbol, marketSeries: series, benchCandles: bench, alignCache, ...WINDOW });
  out.push({ label, m: r.metrics });
}

// ★ `cashAdj` is not decoration here, it is what makes the comparison legitimate. A gate that
// stands aside more is charged the 6.5% hurdle on every idle bar and earns nothing on them, so
// comparing a 51%-cash arm with a 72%-cash arm on plain xSharpe measures the CONVENTION as much
// as the gate. `sharpeCashAdj` re-scores each arm as if idle cash had earned the rate it is
// charged, which is the only way the inverted-gate ablation means anything.
console.log('arm'.padEnd(26) + 'CAGR'.padStart(8) + 'xSharpe'.padStart(9) + 'cashAdj'.padStart(9) + 'MaxDD'.padStart(8) + 'cash%'.padStart(8) + 'trades'.padStart(8));
console.log('-'.repeat(76));
for (const r of out) {
  console.log(
    r.label.padEnd(26)
    + (r.m.cagrPct.toFixed(2) + '%').padStart(8)
    + r.m.sharpe.toFixed(2).padStart(9)
    + r.m.sharpeCashAdj.toFixed(2).padStart(9)
    + (r.m.maxDrawdownPct.toFixed(1) + '%').padStart(8)
    + (r.m.flatBarsPct.toFixed(1) + '%').padStart(8)
    + String(r.m.trades).padStart(8),
  );
}

const byLabel = Object.fromEntries(out.map((r) => [r.label, r.m]));
const none = byLabel['no gate at all'];
const trend = byLabel['trend (the board\'s own)'];
const best = out.filter((r) => r.label.startsWith('VIX')).reduce((a, b) => (b.m.sharpe > a.m.sharpe ? b : a));
const inverses = out.filter((r) => r.label.startsWith('INVERTED'));

console.log('\nVERDICT');
console.log(`  no gate ${none.sharpe.toFixed(2)}   trend gate ${trend.sharpe.toFixed(2)}   best VIX gate ${best.m.sharpe.toFixed(2)} (${best.label})`);
const beatsNone = best.m.sharpe - none.sharpe;
const beatsTrend = best.m.sharpe - trend.sharpe;
console.log(`  best VIX gate vs no gate: ${(beatsNone >= 0 ? '+' : '') + beatsNone.toFixed(2)}   vs the trend gate: ${(beatsTrend >= 0 ? '+' : '') + beatsTrend.toFixed(2)}`);
const bestInv = inverses.reduce((a, b) => (b.m.sharpe > a.m.sharpe ? b : a));
console.log(`  INVERTED arms: ${inverses.map((r) => `${r.label} ${r.m.sharpe.toFixed(2)} (cashAdj ${r.m.sharpeCashAdj.toFixed(2)}, ${r.m.flatBarsPct.toFixed(0)}% cash)`).join('   ')}`);

// The SAME three bars, re-checked on the cash-neutral figure. If a verdict holds on plain
// xSharpe but not here, what was really being measured was time spent in cash.
const cNone = none.sharpeCashAdj, cTrend = trend.sharpeCashAdj, cBest = best.m.sharpeCashAdj, cInv = bestInv.m.sharpeCashAdj;
console.log('\n  CASH-NEUTRAL re-check (the honest version of the same three bars):');
console.log(`    no gate ${cNone.toFixed(2)}   trend ${cTrend.toFixed(2)}   best VIX ${cBest.toFixed(2)}   best inverse ${cInv.toFixed(2)}`);
console.log(`    vs no gate ${(cBest - cNone >= 0 ? '+' : '') + (cBest - cNone).toFixed(2)}   vs trend ${(cBest - cTrend >= 0 ? '+' : '') + (cBest - cTrend).toFixed(2)}   vs its inverse ${(cBest - cInv).toFixed(2)}`);

const passesRaw = beatsNone > 0.05 && beatsTrend > 0.05 && best.m.sharpe - bestInv.m.sharpe > 0.15;
const passesCash = (cBest - cNone) > 0.05 && (cBest - cTrend) > 0.05 && (cBest - cInv) > 0.15;
if (passesRaw && passesCash) {
  console.log('\n  -> CLEARS ALL THREE BARS ON BOTH MEASURES: beats no-gate, beats the trend gate, and its');
  console.log('     inverse is clearly worse — and the verdict survives removing the cash-hurdle confound.');
  console.log('     ★ But see the sample warning below before treating this as a finding.');
} else if (passesRaw && !passesCash) {
  console.log('\n  -> FAILS once the cash confound is removed. The apparent edge was largely the hurdle');
  console.log('     punishing the arms that sat in cash more, not the gate reading fear correctly.');
} else {
  console.log('\n  -> NOT SHOWN, which is the published expectation: Londono (2011, Fed IFDP 1035) found');
  console.log('     non-US variance premiums do not predict local equity returns. Publish the null.');
}

console.log('\n  ★★ THE BINDING LIMITATION, and it is severe. Free India VIX history starts 2015-08 and');
console.log('  the in-sample window ends 2019-12, so this is ~4.3 YEARS, of which the first ~252 bars are');
console.log(`  momentum warm-up — roughly ${Math.round((out[0].m.trades / 2) / 10)} rebalance decisions in total. It contains NO 2008 and NO 2020.`);
console.log('  A regime filter is exactly the kind of rule that looks good until the regime it never saw.');
console.log('  Treat any positive result here as a HYPOTHESIS for the forward board, not as evidence.');
