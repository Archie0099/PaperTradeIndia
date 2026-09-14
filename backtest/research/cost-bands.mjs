// cost-bands.mjs — does trading LESS actually earn MORE, once real Indian costs are charged?
//
// THE CLAIM BEING TESTED
// ----------------------
// Novy-Marx & Velikov (2016, RFS 29(1):104-147) call a buy/hold spread "the single most
// effective simple cost mitigation strategy", and report that strategies below roughly 50%
// one-sided monthly turnover generally keep a significant net spread while few above it do.
// A survey of the literature ranked this candidate first of everything considered — ahead of every
// new signal — on the grounds that it is arithmetic about the cost term rather than a mined
// premium, and that it applies to bots that already exist.
//
// The arithmetic: a ranking is continuous, so the name at rank k and the name at rank k+1
// have nearly identical expected returns, while swapping between them costs a certain,
// immediate round trip. The same applies to trimming a holding whose weight drifted 0.4%.
//
// TWO DIALS, and they are NOT the same thing
// ------------------------------------------
//   holdK          buy into the top k, sell only once a holding falls past rank holdK.
//                  Attacks SELECTION churn (swapping names at the boundary).
//   rebalanceBand  skip a same-side resize worth less than band x equity.
//                  Attacks WEIGHT-MAINTENANCE churn (trimming names you are keeping).
//
// Measured on a synthetic rotating fixture, the weight band is by far the bigger lever and
// the two INTERACT — holding names longer lets them drift further, so they cross the weight
// band more often. This runs both on real data, net of the real cost model, to find out
// whether the turnover saved is worth the selection sharpness given up.
//
// WHAT WOULD COUNT AS A RESULT
// ----------------------------
// Pre-registered prediction, straight from the candidate's own write-up: turnover falls
// 40-60%, GROSS Sharpe falls slightly, and NET Sharpe RISES. If net Sharpe does not rise,
// that is a publishable negative — it would mean the signal decays faster than the cost
// saved, which is a real fact about this signal and not a failure of the mechanism.
//
// Read-only. In-sample 2010-2019; the later holdout stays unspent.
//
// Usage: node backtest/research/cost-bands.mjs [--phase]

import { pathToFileURL } from 'node:url';
import { rank12_1, DEFAULTS as XS } from './xsmom.mjs';
import { validateSpec } from '../dsl.mjs';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('cost-bands.mjs is a CLI tool; run it directly.');

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
if (/synthetic/.test(mSrc)) { console.error('refusing to evaluate: market series is synthetic.'); process.exit(1); }

const universe = Object.keys(dataBySymbol);
const alignCache = new Map();
const WINDOW = { from: '2010-01-01', to: '2019-12-31', warmupFrom: '2008-01-01' };
const GATE = ['>', ['price'], ['*', 0.95, ['sma', XS.gateSma]]];

const base = {
  kind: 'BASKET', name: 'mom 12-1', universe,
  rank: rank12_1(XS.lookback, XS.skip), k: XS.k,
  weighting: 'volinv', rebalanceBars: XS.rebalanceBars, marketGate: GATE,
};

console.log(`data: ${universe.length} names (${dropped} dropped)`);
console.log('★ SAME signal, SAME k, SAME grid, SAME gate — only the COST DIALS move.');
console.log('★ IN-SAMPLE 2010-2019, net of the full Indian delivery cost model.\n');

// GROSS is measured with a zero-cost model so the two halves of the trade-off are visible:
// a band gives up a little signal (gross falls) to save a lot of cost (net should rise).
const ZERO = { kind: 'none', buyRate: 0, sellRate: 0, borrowRatePA: 0 };

function run(label, extra) {
  const spec = { ...base, ...extra, name: `${base.name} ${label}` };
  const err = validateSpec(spec);
  if (err) throw new Error(`${label}: ${err}`);
  const net = evaluateBasket({ spec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW });
  const gross = evaluateBasket({ spec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, costModel: ZERO, ...WINDOW });
  return { label, net: net.metrics, gross: gross.metrics };
}

const arms = [
  ['plain (no bands)', {}],
  ['holdK 15', { holdK: 15 }],
  ['holdK 25', { holdK: 25 }],
  ['band 0.5%', { rebalanceBand: 0.005 }],
  ['band 1%', { rebalanceBand: 0.01 }],
  ['band 2%', { rebalanceBand: 0.02 }],
  ['holdK 25 + band 1%', { holdK: 25, rebalanceBand: 0.01 }],
];

const results = arms.map(([l, e]) => run(l, e));
const plain = results[0];

console.log('arm'.padEnd(22) + 'trades'.padStart(8) + 'vs plain'.padStart(10) + 'GROSS xS'.padStart(10) + 'NET xS'.padStart(9) + 'net-gross'.padStart(11) + 'NET CAGR'.padStart(10));
console.log('-'.repeat(80));
for (const r of results) {
  const turn = r.net.trades / Math.max(1, plain.net.trades);
  console.log(
    r.label.padEnd(22)
    + String(r.net.trades).padStart(8)
    + (turn * 100).toFixed(0).padStart(9) + '%'
    + r.gross.sharpe.toFixed(2).padStart(10)
    + r.net.sharpe.toFixed(2).padStart(9)
    + (r.net.sharpe - r.gross.sharpe).toFixed(2).padStart(11)
    + (r.net.cagrPct.toFixed(2) + '%').padStart(10),
  );
}

console.log('\nTHE TRADE-OFF, arm by arm (vs plain):');
for (const r of results.slice(1)) {
  const dTurn = (r.net.trades / plain.net.trades - 1) * 100;
  const dGross = r.gross.sharpe - plain.gross.sharpe;
  const dNet = r.net.sharpe - plain.net.sharpe;
  console.log(`  ${r.label.padEnd(22)} turnover ${dTurn.toFixed(0).padStart(4)}%   gross ${(dGross >= 0 ? '+' : '') + dGross.toFixed(2)}   NET ${(dNet >= 0 ? '+' : '') + dNet.toFixed(2)}`);
}

const best = results.slice(1).reduce((a, b) => (b.net.sharpe > a.net.sharpe ? b : a));
console.log(`\nBest net arm: ${best.label} at ${best.net.sharpe.toFixed(2)} vs plain ${plain.net.sharpe.toFixed(2)} (${(best.net.sharpe - plain.net.sharpe >= 0 ? '+' : '') + (best.net.sharpe - plain.net.sharpe).toFixed(2)}).`);
if (best.net.sharpe - plain.net.sharpe <= 0.02) {
  console.log('→ NEGATIVE, and it is a real one: cutting turnover did NOT pay here. The cost saved is');
  console.log('  smaller than the selection sharpness given up, which says this signal decays FAST');
  console.log('  relative to its own trading cost. Publish it; do not tune the band until it wins.');
} else {
  console.log('→ The band pays. Note it is IN-SAMPLE and the dials were chosen from a small grid, so');
  console.log('  treat the magnitude as an upper bound and let the live board be the judge.');
}

// ---------------------------------------------------------------------------
// THE CONTROL THAT MAKES THE NEGATIVE INTERPRETABLE.
//
// A null result above has two very different explanations, and reporting it without
// separating them would be careless:
//   (a) the mechanism does not work, or
//   (b) THIS strategy had nothing to save — a monthly top-10 basket is already cheap, so
//       there is no cost to mitigate no matter how good the mitigation is.
// The whole cost drag above (net minus gross) bounds the prize: you cannot win more than
// that by eliminating every rupee of trading cost.
//
// So re-run the identical arms on a deliberately EXPENSIVE version of the same strategy —
// same signal, same names, rebalanced WEEKLY instead of monthly. If the bands help there,
// the answer is (b): this is a turnover-dependent tool and the board's baskets already sit
// below the threshold where it bites.
// ---------------------------------------------------------------------------
if (process.argv.includes('--highturn')) {
  console.log('\n' + '='.repeat(80));
  console.log('CONTROL: the SAME arms on a WEEKLY rebalance — a deliberately expensive strategy.');
  console.log('If the bands pay here but not above, the monthly basket simply had nothing to save.\n');
  const fast = { ...base, rebalanceBars: 5 };
  const runFast = (label, extra) => {
    const spec = { ...fast, ...extra };
    const net = evaluateBasket({ spec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW });
    const gross = evaluateBasket({ spec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, costModel: ZERO, ...WINDOW });
    return { label, net: net.metrics, gross: gross.metrics };
  };
  const fastRes = arms.map(([l, e]) => runFast(l, e));
  const fastPlain = fastRes[0];
  console.log('arm'.padEnd(22) + 'trades'.padStart(8) + 'vs plain'.padStart(10) + 'GROSS xS'.padStart(10) + 'NET xS'.padStart(9) + 'net-gross'.padStart(11));
  console.log('-'.repeat(70));
  for (const r of fastRes) {
    console.log(
      r.label.padEnd(22)
      + String(r.net.trades).padStart(8)
      + ((r.net.trades / Math.max(1, fastPlain.net.trades)) * 100).toFixed(0).padStart(9) + '%'
      + r.gross.sharpe.toFixed(2).padStart(10)
      + r.net.sharpe.toFixed(2).padStart(9)
      + (r.net.sharpe - r.gross.sharpe).toFixed(2).padStart(11),
    );
  }
  const fastBest = fastRes.slice(1).reduce((a, b) => (b.net.sharpe > a.net.sharpe ? b : a));
  const fastGain = fastBest.net.sharpe - fastPlain.net.sharpe;
  console.log(`\n  weekly cost drag (net-gross) at plain: ${(fastPlain.net.sharpe - fastPlain.gross.sharpe).toFixed(2)} — the size of the prize here.`);
  console.log(`  best arm: ${fastBest.label} ${(fastGain >= 0 ? '+' : '') + fastGain.toFixed(2)} vs plain.`);
  console.log(fastGain > 0.02
    ? '  → The bands DO pay when turnover is high. So the monthly result is explanation (b):\n    the board\'s baskets are already below the turnover where cost mitigation bites.'
    : '  → The bands do NOT pay even at weekly turnover, which points at explanation (a) and is\n    a stronger negative than the monthly result alone.');
}

if (process.argv.includes('--phase')) {
  console.log('\nPHASE CHECK — best arm vs plain, only the window START moves:');
  for (const from of ['2010-01-01', '2010-07-01', '2011-01-03', '2011-07-01']) {
    const p = evaluateBasket({ spec: base, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW, from }).metrics.sharpe;
    const bestExtra = arms.find(([l]) => l === best.label)[1];
    const b = evaluateBasket({ spec: { ...base, ...bestExtra }, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW, from }).metrics.sharpe;
    console.log(`  from ${from}   plain ${p.toFixed(2)}   ${best.label} ${b.toFixed(2)}   diff ${(b - p >= 0 ? '+' : '') + (b - p).toFixed(2)}`);
  }
  console.log('  If the sign flips across starts, the band result is one draw, not a finding.');
}
