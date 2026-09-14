// high52.mjs — does ranking on NEARNESS TO THE 52-WEEK HIGH beat ranking on 12-1 momentum,
// and does either clear a fair bar?
//
// THE IDEA
// --------
// George & Hwang (2004, JF 59(5)) report that how close a stock sits to its own 52-week high
// predicts returns BETTER than its past return does, and that those returns do not reverse
// long-run. The behavioural story is anchoring: the 52-week high is a salient reference point,
// traders under-react to good news near it, and the drift is the correction. If that is real
// it is a strictly cheaper signal than momentum — a slow-moving anchor rather than a
// fast-moving return — so it should turn over less and survive costs better.
//
// WHY IT IS WORTH RUNNING HERE, AND THE HONEST CAVEAT
// --------------------------------------------------
// This is a ONE-FIELD change: the DSL already has `distHigh n` (close / n-day high − 1, ≤ 0,
// higher = nearer the high), so the candidate spec is the live `xsmom-research` spec with its
// `rank` swapped and NOTHING else touched. That makes it the cleanest possible ablation.
// ★ But it is NOT a holdout. This data has been looked at many times, and the momentum
// holdout for that signal is already spent. Every number below is IN-SAMPLE over the full history. The only
// honest verdict on a signal here is the FORWARD tournament — which is the argument for
// putting a bot on the board rather than for believing a backtest.
//
// THE ARMS — identical machinery, one variable
// -------------------------------------------
// Same universe, k, cadence, weighting, costs, window and gate. ONLY `rank` differs:
//   distHigh   the candidate                   rank = distHigh 252
//   mom 12-1   the incumbent (xsmom-research)  rank = close[i-21]/close[i-252] − 1
//   no-info    the k-matched control           rank = 0 × vol  (numeric, null while unwarm)
//   universe   the diversification bar         no-info rank, k = every name, equal weight
// Each block is run GATED and UNGATED, with the gate held FIXED across all arms inside a
// block — the standing lesson here: a comparison that moves the signal AND the gate measures
// neither. And a NULL DISTRIBUTION of seeded random k-name portfolios, because the methodology requires
// beating a random draw of the same size, not just a control.
//
// WHAT WOULD COUNT AS A RESULT
// ----------------------------
// distHigh > mom on net xSharpe, AND distHigh above the no-info control at the SAME k, AND
// outside the random-draw band. Anything less is "not shown", and the honest move is to say
// so. Liu, Liu & Ma (2011, JIMF 30(1)) is the standing prediction on the other side: the
// effect exists gross in 18 of 20 markets and stops being significant in most of them once
// transaction costs are charged — so a GROSS win with a NET loss is the expected outcome and
// must be reported as a negative, not buried.
//
// Read-only: writes no file, touches no app state, no cache beyond the usual Yahoo fill.
//
// Usage: node backtest/research/high52.mjs            # the main comparison
//        node backtest/research/high52.mjs --null     # + the random-portfolio null
//        node backtest/research/high52.mjs --phase    # + repeat across window starts

import { pathToFileURL } from 'node:url';
import { makeControlSpec, sampleNames, nullDrawPool } from './lowvol.mjs';
import { rank12_1, DEFAULTS as XS } from './xsmom.mjs';
import { validateSpec } from '../dsl.mjs';

// The candidate: the live momentum spec with its ranking signal swapped and nothing else.
// `distHigh 252` is ≤ 0 and rises toward 0 as price approaches its own 52-week high, so
// "higher = more attractive" already matches the basket's ranking convention.
function makeHigh52Spec(universe, { k = XS.k, rebalanceBars = XS.rebalanceBars, gated = true, lookback = 252 } = {}) {
  const spec = {
    kind: 'BASKET',
    name: `52-week-high ${lookback}`,
    universe,
    rank: ['distHigh', lookback],
    k: Math.min(Math.max(1, k), universe.length),
    weighting: 'volinv',
    rebalanceBars,
    ...(gated ? { marketGate: ['>', ['price'], ['*', 0.95, ['sma', XS.gateSma]]] } : {}),
  };
  const err = validateSpec(spec);
  if (err) throw new Error(`high52 spec invalid: ${err}`);
  return spec;
}

// The incumbent, rebuilt here rather than imported whole so the two specs are provably
// identical except for `rank` (importing makeXsmomSpec would also bring its name/note).
function makeMomSpec(universe, { k = XS.k, rebalanceBars = XS.rebalanceBars, gated = true } = {}) {
  const spec = {
    kind: 'BASKET', name: 'XS momentum 252-21', universe,
    rank: rank12_1(XS.lookback, XS.skip),
    k: Math.min(Math.max(1, k), universe.length),
    weighting: 'volinv', rebalanceBars,
    ...(gated ? { marketGate: ['>', ['price'], ['*', 0.95, ['sma', XS.gateSma]]] } : {}),
  };
  const err = validateSpec(spec);
  if (err) throw new Error(`mom spec invalid: ${err}`);
  return spec;
}

export { makeHigh52Spec, makeMomSpec };

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
  const { candles: bench, source: bSrc } = await loadCandles('NIFTYBEES', { interval: '1d', range: '20y' });
  if (/synthetic/.test(mSrc) || /synthetic/.test(bSrc)) { console.error('refusing to evaluate: market/bench is synthetic.'); process.exit(1); }

  const universe = Object.keys(dataBySymbol);
  const alignCache = new Map();
  console.log(`data: ${universe.length} names loaded (${dropped} dropped)`);
  console.log('★ SURVIVORSHIP: today\'s liquid names held fixed across history — every figure is an UPPER BOUND.');
  console.log('★ IN-SAMPLE: this is not a holdout. The forward board is the only overfit-proof judge.\n');

  // ★ IN-SAMPLE WINDOW, deliberately. The research harness LOCKS any window ending after
  // 2019-12-31 (it threw when this tool first tried the full history — the lock working as
  // designed). The 2020+ holdout is a one-shot resource spent only on an explicit go-ahead,
  // and it is NOT spent here: a signal that cannot separate itself in-sample has not earned
  // it, and one that can should be judged FORWARD on the live board instead. Same window as
  // universe-bench.mjs so the control figures are directly comparable.
  const WINDOW = { from: '2010-01-01', to: '2019-12-31', warmupFrom: '2008-01-01' };
  const run = (spec, opts = {}) => evaluateBasket({ spec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW, ...opts });
  const fmt = (name, r) => {
    const m = r.metrics;
    return `${name.padEnd(30)} CAGR ${m.cagrPct.toFixed(2).padStart(6)}%  xSharpe ${m.sharpe.toFixed(2).padStart(5)}  Sortino ${m.sortino.toFixed(2).padStart(5)}  MaxDD ${m.maxDrawdownPct.toFixed(1).padStart(5)}%`;
  };

  const results = {};
  for (const gated of [true, false]) {
    const tag = gated ? 'GATED' : 'UNGATED';
    console.log(`=== ${tag} — gate held FIXED across every arm in this block ===`);
    const arms = [
      ['52-week-high (distHigh 252)', makeHigh52Spec(universe, { gated })],
      ['12-1 momentum (incumbent)', makeMomSpec(universe, { gated })],
      ['no-information control k=10', { ...makeControlSpec(universe, 0, XS.k, XS.rebalanceBars), ...(gated ? { marketGate: ['>', ['price'], ['*', 0.95, ['sma', XS.gateSma]]] } : {}) }],
      ['whole universe, equal weight', { ...makeControlSpec(universe, 0, universe.length, XS.rebalanceBars), weighting: 'equal', ...(gated ? { marketGate: ['>', ['price'], ['*', 0.95, ['sma', XS.gateSma]]] } : {}) }],
    ];
    for (const [label, spec] of arms) {
      const r = run(spec);
      results[`${tag}|${label}`] = r.metrics;
      console.log('  ' + fmt(label, r));
    }
    if (gated) console.log('  ' + fmt('NIFTYBEES buy & hold', run(arms[0][1]).benchmark));
    console.log();
  }

  // ---- the head-to-head, stated as the ablation it is
  console.log('THE ABLATION (same machinery, only `rank` differs):');
  for (const tag of ['GATED', 'UNGATED']) {
    const h = results[`${tag}|52-week-high (distHigh 252)`].sharpe;
    const m = results[`${tag}|12-1 momentum (incumbent)`].sharpe;
    const c = results[`${tag}|no-information control k=10`].sharpe;
    const u = results[`${tag}|whole universe, equal weight`].sharpe;
    console.log(`  ${tag.padEnd(8)} distHigh ${h.toFixed(2)}  vs mom ${m.toFixed(2)}  (diff ${(h - m >= 0 ? '+' : '') + (h - m).toFixed(2)})`);
    console.log(`  ${''.padEnd(8)} distHigh vs its k-matched no-info control: ${(h - c >= 0 ? '+' : '') + (h - c).toFixed(2)}   vs whole-universe equal weight: ${(h - u >= 0 ? '+' : '') + (h - u).toFixed(2)}`);
  }

  // ---- the methodology's other half: a random-draw null at the SAME k
  if (process.argv.includes('--null')) {
    console.log('\nNULL DISTRIBUTION — 20 seeded random 10-name portfolios, same machinery, gated:');
    const draws = [];
    for (let seed = 1; seed <= 20; seed++) {
      const names = sampleNames(nullDrawPool(universe, dataBySymbol, WINDOW.from), XS.k, seed);
      const spec = { ...makeControlSpec(names, 0, XS.k, XS.rebalanceBars), marketGate: ['>', ['price'], ['*', 0.95, ['sma', XS.gateSma]]] };
      const sub = {};
      for (const n of names) sub[n] = dataBySymbol[n];
      draws.push(evaluateBasket({ spec, dataBySymbol: sub, marketSeries: market, benchCandles: bench, alignCache, ...WINDOW }).metrics.sharpe);
    }
    draws.sort((a, b) => a - b);
    const h = results['GATED|52-week-high (distHigh 252)'].sharpe;
    const beat = draws.filter((d) => d > h).length;
    console.log(`  random draws xSharpe: min ${draws[0].toFixed(2)}  median ${draws[10].toFixed(2)}  max ${draws[19].toFixed(2)}`);
    console.log(`  ★ ${beat} of 20 random 10-name portfolios BEAT the 52-week-high basket (${h.toFixed(2)}).`);
    console.log(`  ${beat >= 3 ? 'That puts it INSIDE the noise band — "not shown", exactly as the methodology requires you to report.' : 'That is outside the noise band — a real, if in-sample, separation.'}`);
  }

  // ---- REBALANCE PHASE: the same comparison across window starts nobody chose
  if (process.argv.includes('--phase')) {
    console.log('\nPHASE CHECK — same arms, only the window START moves:');
    for (const from of ['2010-01-01', '2010-07-01', '2011-01-03', '2011-07-01']) {
      const h = run(makeHigh52Spec(universe, { gated: true }), { from, warmupFrom: '2008-01-01' }).metrics.sharpe;
      const m = run(makeMomSpec(universe, { gated: true }), { from, warmupFrom: '2008-01-01' }).metrics.sharpe;
      console.log(`  from ${from}   distHigh ${h.toFixed(2)}   mom ${m.toFixed(2)}   diff ${(h - m >= 0 ? '+' : '') + (h - m).toFixed(2)}`);
    }
    console.log('  If the SIGN of the difference flips across starts, the head-to-head is one draw, not a finding.');
  }

  console.log('\nStanding prediction to check against (Liu, Liu & Ma 2011, JIMF 30(1)): the 52-week-high');
  console.log('effect is present GROSS in 18 of 20 markets and stops being significant in most of them');
  console.log('once transaction costs are charged. Every figure above is already NET of the real Indian');
  console.log('cost model, so a loss here is the literature\'s own expected outcome, not a surprise.');
}
