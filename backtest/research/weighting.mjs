// weighting.mjs — HOW you size the names, holding WHICH names you pick completely fixed.
//
// THE QUESTION
// ------------
// Three bots on this board are optimiser-weighted (mean-variance, risk-parity, multi-factor),
// and all three quietly fall back to INVERSE-VOLATILITY weighting whenever the optimiser fails
// (singular covariance, too short a window, an infeasible cap, a negatively-correlated name
// breaking the risk solver). Nobody has ever measured whether the optimisers are worth having
// over that fallback — or over doing nothing clever at all.
//
// The literature says they very probably are not. DeMiguel, Garlappi & Uppal (2009, RFS 22(5))
// compared 14 optimisation models across 7 datasets and none consistently beat naive 1/N out of
// sample; the estimation window needed for sample-based mean-variance to beat 1/N is roughly
// 3,000 months for 25 assets and 6,000 for 50. This project has about 240 months. The one
// credible dissent is Kirby & Ostdiek (2012, JFQA 47(2)), whose volatility-timing rules beat
// 1/N with LOW turnover and survive high transaction costs — and their rule is, in effect, the
// fallback this codebase already runs when the clever machinery breaks.
//
// THE DESIGN — one variable, and it is not the one the board usually varies
// ------------------------------------------------------------------------
// Every arm holds the SAME names, chosen by the SAME ranking signal, on the SAME rebalance
// grid, over the SAME window, paying the SAME costs, under the SAME gate. ONLY `weighting`
// changes. That is the ablation the methodology asks for and the one the board cannot show,
// because its bots differ in selection AND weighting at once (a mistake this lab has made before: an
// arm that moves two variables measures neither).
//
// It is run over TWO different selections — a momentum rank and a no-information rank — for a
// reason. If a weighting scheme only wins on one of them, it is interacting with that signal
// rather than weighting better, and the result should not be generalised.
//
// WHAT WOULD COUNT
// ----------------
// An optimiser earns its complexity only by beating BOTH `equal` and `volinv` on net xSharpe,
// on BOTH selections, by more than the phase noise this board already exhibits (specs swing
// ~0.2 Sharpe across window starts). Anything less and the honest description is "the
// fallback was as good as the thing it falls back from", which is a publishable finding about
// this board, not a failure of the code.
//
// Read-only: writes no file, touches no app state, no cache beyond the usual Yahoo fill.
//
// Usage: node backtest/research/weighting.mjs           # the ablation
//        node backtest/research/weighting.mjs --phase   # + repeat across window starts

import { pathToFileURL } from 'node:url';
import { makeControlSpec } from './lowvol.mjs';
import { rank12_1, DEFAULTS as XS } from './xsmom.mjs';
import { validateSpec } from '../dsl.mjs';

// Every weighting the DSL accepts. `equal` and `rankw` use nothing but the ranking; `volinv`
// uses each name's own volatility; `meanvar` and `riskparity` need the full covariance matrix
// (backtest/optimizer.mjs, Ledoit-Wolf shrunk) and are the ones with an estimation-error bill.
const WEIGHTINGS = ['equal', 'volinv', 'rankw', 'meanvar', 'riskparity'];

function withWeighting(base, weighting) {
  const spec = { ...base, weighting, name: `${base.name} [${weighting}]` };
  const err = validateSpec(spec);
  if (err) throw new Error(`${weighting} spec invalid: ${err}`);
  return spec;
}

export { WEIGHTINGS, withWeighting };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
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
  // Same in-sample window as every other study here; the later holdout stays unspent.
  const WINDOW = { from: '2010-01-01', to: '2019-12-31', warmupFrom: '2008-01-01' };
  const GATE = ['>', ['price'], ['*', 0.95, ['sma', XS.gateSma]]];

  console.log(`data: ${universe.length} names (${dropped} dropped)`);
  console.log('★ ONE VARIABLE: same names, same signal, same grid, same costs, same gate — only `weighting` moves.');
  console.log('★ IN-SAMPLE 2010-2019. Not a holdout.\n');

  // Two different selections, so a weighting that only helps one is exposed as interacting
  // with that signal rather than weighting better.
  const selections = [
    ['momentum 12-1, top 10', { kind: 'BASKET', name: 'mom', universe, rank: rank12_1(XS.lookback, XS.skip), k: XS.k, rebalanceBars: XS.rebalanceBars, marketGate: GATE }],
    ['no-information, top 10', { ...makeControlSpec(universe, 0, XS.k, XS.rebalanceBars), name: 'noinfo', marketGate: GATE }],
  ];

  const table = {};
  for (const [selLabel, base] of selections) {
    console.log(`=== selection: ${selLabel} ===`);
    table[selLabel] = {};
    for (const w of WEIGHTINGS) {
      const r = evaluateBasket({ spec: withWeighting(base, w), dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW });
      const m = r.metrics;
      table[selLabel][w] = m;
      console.log(`  ${w.padEnd(11)} CAGR ${m.cagrPct.toFixed(2).padStart(6)}%  xSharpe ${m.sharpe.toFixed(2).padStart(5)}  MaxDD ${m.maxDrawdownPct.toFixed(1).padStart(5)}%  trades ${String(m.trades).padStart(6)}  cashBars ${String(m.flatBarsPct).padStart(5)}%`);
    }
    console.log();
  }

  // ---- the verdict, stated as the ablation it is
  console.log('DOES THE OPTIMISER EARN ITS COMPLEXITY?');
  console.log('(it must beat BOTH `equal` and `volinv`, on BOTH selections, with a CONSISTENT sign)');
  // ★ Counting wins is NOT enough, and an earlier version of this verdict did exactly that and
  // misled. A rule that wins on one selection and loses on the other is INTERACTING with that
  // ranking signal, not weighting better — which is the whole reason two selections are run.
  // So the test is sign consistency first, magnitude second.
  const deltas = {};
  for (const w of ['meanvar', 'riskparity', 'volinv', 'rankw']) deltas[w] = [];
  for (const [selLabel] of selections) {
    const t = table[selLabel];
    const simple = Math.max(t.equal.sharpe, t.volinv.sharpe);
    for (const w of ['meanvar', 'riskparity']) {
      const d = t[w].sharpe - simple;
      deltas[w].push(d);
      console.log(`  ${selLabel.padEnd(24)} ${w.padEnd(11)} ${t[w].sharpe.toFixed(2)} vs best-simple ${simple.toFixed(2)}  ->  ${(d >= 0 ? '+' : '') + d.toFixed(2)}`);
    }
    // the simple rules against each other — Kirby & Ostdiek's actual claim is volinv > equal
    deltas.volinv.push(t.volinv.sharpe - t.equal.sharpe);
    deltas.rankw.push(t.rankw.sharpe - t.equal.sharpe);
    console.log(`  ${''.padEnd(24)} (equal ${t.equal.sharpe.toFixed(2)}, volinv ${t.volinv.sharpe.toFixed(2)}, rankw ${t.rankw.sharpe.toFixed(2)})`);
  }

  console.log('\n  VERDICT PER RULE (sign must agree across both selections to mean anything):');
  for (const w of ['meanvar', 'riskparity']) {
    const d = deltas[w];
    const consistent = d.every((x) => x > 0) || d.every((x) => x < 0);
    const worst = Math.min(...d.map(Math.abs));
    let verdict;
    if (!consistent) verdict = 'INTERACTION, not weighting — the sign FLIPS between selections, so it is reacting to the ranking signal rather than sizing better. Do not generalise.';
    else if (d.every((x) => x > 0) && worst >= 0.20) verdict = 'beats the simple rules on both, by a margin bigger than this board\'s phase spread.';
    else if (d.every((x) => x > 0)) verdict = `ahead on both but only by ${d.map((x) => x.toFixed(2)).join(' / ')} — inside the ~0.2 phase spread, so "consistent" is the claim, "better" is not yet.`;
    else verdict = 'behind the simple rules on both selections.';
    console.log(`    ${w.padEnd(11)} ${d.map((x) => (x >= 0 ? '+' : '') + x.toFixed(2)).join(' , ')}  -> ${verdict}`);
  }
  const viDelta = deltas.volinv;
  console.log(`\n  And Kirby & Ostdiek's own claim — inverse-vol over equal weight — measures ${viDelta.map((x) => (x >= 0 ? '+' : '') + x.toFixed(2)).join(' / ')} here.`);
  if (Math.max(...viDelta.map(Math.abs)) < 0.05) {
    console.log('    i.e. indistinguishable. The fallback is neither better nor worse than doing nothing clever,');
    console.log('    which is itself the useful finding: the graceful degradation costs nothing.');
  }

  // ---- turnover, the other half of Kirby & Ostdiek's claim
  console.log('\nTURNOVER (the half of the argument that usually decides it):');
  for (const [selLabel] of selections) {
    const t = table[selLabel];
    const base = t.equal.trades || 1;
    console.log(`  ${selLabel}: ` + WEIGHTINGS.map((w) => `${w} ${(t[w].trades / base).toFixed(2)}x`).join('  '));
  }
  console.log('  (relative to `equal`. Kirby & Ostdiek\'s case for volatility timing rests on it being');
  console.log('   LOW-turnover — if a rule wins on Sharpe but trades far more, costs will take it back.)');

  if (process.argv.includes('--phase')) {
    console.log('\nPHASE CHECK — the same ablation, only the window START moves:');
    for (const from of ['2010-01-01', '2010-07-01', '2011-01-03', '2011-07-01']) {
      const base = selections[0][1];
      const line = WEIGHTINGS.map((w) => {
        const s = evaluateBasket({ spec: withWeighting(base, w), dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW, from }).metrics.sharpe;
        return `${w} ${s.toFixed(2)}`;
      }).join('  ');
      console.log(`  from ${from}   ${line}`);
    }
    console.log('  If the WINNER changes across starts, no weighting is better — the spread is phase.');
  }
}
