// ---------------------------------------------------------------------------
// S6 — CROSS-SECTIONAL LOW VOLATILITY (the "defensive" / betting-against-beta factor)
//
// HYPOTHESIS (pre-registered before a single number was computed):
//   In the Indian large/mid-cap universe, ranking names by their TRAILING REALIZED
//   VOLATILITY and holding the LOWEST-volatility ones earns a better RISK-ADJUSTED
//   return than the market, net of real costs.
//
// Why this is worth one of our scarce holdouts:
//   * The low-volatility / betting-against-beta anomaly is among the most replicated
//     findings in equity research — low-risk stocks have historically delivered
//     market-like returns at materially less risk, which plain CAPM says is impossible.
//   * It is a genuinely DIFFERENT return stream from S2 (cross-sectional momentum, the
//     one strategy that survived its holdout). Momentum buys what has gone up; this buys
//     what moves least. If it holds, it DIVERSIFIES the flagship instead of duplicating
//     it — and unlike a momentum variant, testing it does not touch S2's spent holdout.
//   * The live board already runs an unvalidated `basket-lowvol` bot. This study is the
//     first time that idea faces the in-sample/holdout discipline.
//
// ★ HOW IT IS GRADED — decided IN ADVANCE, and deliberately NOT on return:
//   A low-volatility portfolio is EXPECTED to earn less than the market in a bull run
//   and to win on risk. Grading it on raw CAGR would rig the test against its own
//   thesis (and grading it on drawdown alone would rig it in favour). So the bar is:
//     PASS in-sample  <=>  excess-Sharpe >= benchmark + 0.15
//                     AND  no cell of the ±50% perturbation grid falls below benchmark.
//   Only if BOTH hold do we request the ONE-SHOT holdout. Drawdown and Sortino are
//   reported alongside as the supporting risk evidence, not as the gate.
//
// ===========================================================================
// ★★ VERDICT: NOT PROMOTED — published as a NEGATIVE. The holdout was NOT spent.
//
// ★ FIRST, THE UNCOMFORTABLE PART, STATED PLAINLY: the pre-registered bar above was
// MET, exactly as written. In-sample (2010-2019, full delivery costs) the strategy
// scored xSharpe 1.00 against the NIFTYBEES benchmark's 0.24 — an edge of +0.76 where
// the bar was +0.15 — with CAGR 18.11% vs 9.33%, Sortino 1.47 vs 0.34, MaxDD 15.8% vs
// 27.3%, and ALL TWELVE perturbation cells holding (xSharpe 0.93-1.14, the base
// mid-pack rather than at a peak — a genuinely stable neighbourhood). By the letter of
// the protocol this study earned its holdout run.
//
// It is not promoted because the CONTROL ITSELF WAS MIS-SPECIFIED, and I only found
// that out by running extra checks after seeing the result. That sequence deserves
// scrutiny, because "change the null until the answer flips" is the mirror image of
// tuning on the holdout. Two reasons it is a correction rather than goalpost-moving:
// the correction makes the test STRICTLY HARDER (no honest correction ever loosens a
// bar), and it follows from a general principle that holds regardless of this
// strategy — the right null for a SELECTION rule is the same universe selected without
// information, never the index. The fair conclusion is not "low-vol failed" but "this
// study could not measure what it claimed to measure", which is why the holdout stays
// unspent rather than being burned on a mis-specified test.
//
// WHAT THE EXTRA CONTROLS SHOWED. Two ablations, each changing ONLY the ranking signal
// while holding k / cadence / weighting / universe / costs / window fixed (`--ablate`):
//     ARM A  low-vol   rank = -vol(252)   xSharpe 1.00  CAGR 18.11%  MaxDD 15.8%
//     ARM B  high-vol  rank = +vol(252)   xSharpe 0.52  CAGR 17.02%  MaxDD 34.0%
//     ARM C  NO SIGNAL rank = 0           xSharpe 1.00  CAGR 23.82%  MaxDD 25.9%
// Arm C — selecting with NO information at all — ties the low-vol arm's risk-adjusted
// return and BEATS it outright on return. And the null distribution of 20 seeded random
// 15-name portfolios (`--null`) puts low-vol's 1.00 at roughly the 85th percentile of
// pure noise (median 0.70, max 1.22, 3 of 20 draws matching or beating it) — nowhere
// near significant.
//
// THE ACTUAL SOURCE OF THE "EDGE" IS SURVIVORSHIP IN THE UNIVERSE. An equal-weight
// portfolio of ALL 104 names — no signal, no selection whatsoever — scores xSharpe 0.85
// / CAGR 18.32% against the index's 0.24 / 9.33%. So ~0.6 of the measured +0.76 "edge"
// is simply the survivor set beating the index it is drawn from. Measured against that
// honest null instead of the index, low-vol's marginal contribution is +0.15 Sharpe —
// exactly AT the bar, and statistically indistinguishable from a lucky random draw.
//
// WHAT IS REAL, and worth keeping as knowledge: volatility genuinely ORDERS the
// cross-section by risk. Low-vol's drawdown (15.8%) is far below high-vol's (34.0%),
// the whole universe's (21.8%) and the index's (27.3%), and that ordering is stable
// across every perturbation cell. But a reliable way to hold less risk is a DE-RISKING
// DIAL, not an alpha source — the identical conclusion S5 reached about volTarget.
//
// ★ THE TRANSFERABLE LESSON (the reason this negative is worth more than the study):
// comparing a basket drawn from a survivor universe against the INDEX overstates its
// edge by roughly 0.6 Sharpe / 9pp CAGR in this window, because the survivor set itself
// carries that premium. Every basket-vs-index number this project has ever published
// inherits that bias. The correct null for "does this selection rule add value" is an
// equal-weight portfolio OF THE SAME UNIVERSE, not the index. See METHODOLOGY.md.
// ===========================================================================
//
// DESIGN NOTES (each choice is a deliberate anti-overfit constraint):
//   * The signal is ONE number from free price data: trailing `volLookback`-day stdev of
//     daily returns, via the DSL's own `vol` primitive. `rank` is its NEGATION, because
//     the basket engine holds the TOP-k by score and we want the lowest vol to win.
//   * `['vol', n]` returns null until it has n bars, and null propagates through the
//     `*` node — so a short-history name scores null and SELF-EXCLUDES rather than
//     ranking as spuriously calm. (Same discipline as S2's rank expression.)
//   * NO market gate. A gate would confound the factor's OWN defensiveness with market
//     timing, and S5 already published the finding that a NIFTY-threshold gate cannot
//     bound a cross-sectional basket's drawdown at any read frequency. If low-vol is
//     really defensive, it must show that unaided.
//   * No kill-switch in the spec: S2's holdout showed a permanent-flatten kill locks in
//     the loss at the bottom of a fast crash. Breaches are REPORTED, never acted on.
//   * Inverse-vol weighting, monthly rebalance — the same conventions as S2, so the two
//     studies are directly comparable.
//
// Nothing in `tournament/` or the UI imports this file; the research lab is separate.
// ---------------------------------------------------------------------------
import { pathToFileURL } from 'node:url';
import { validateSpec } from '../dsl.mjs';

// The pre-registered base parameters. `volLookback` is one trading year, which is the
// conventional horizon for a "low-risk stock" and is long enough that a single noisy
// month cannot promote a name into the basket.
const DEFAULTS = {
  volLookback: 252, // trailing days of returns used to measure each name's volatility
  k: 15,            // how many of the calmest names to hold
  rebalanceBars: 21, // ~monthly
};

// rank = -(trailing return stdev). Negated because the basket engine keeps the TOP-k by
// score, and the calmest name must therefore score HIGHEST. Null while unwarm.
const rankLowVol = (volLookback) => ['*', -1, ['vol', volLookback]];

function makeLowvolSpec(universe, params = {}) {
  const p = { ...DEFAULTS, ...params };
  // Clamp to sane ranges so a perturbation cell can never produce an invalid spec:
  // vol needs at least a couple of returns; k is held within 1..universe.length (the
  // validator's own bound — a ×1.5 cell on a small universe would otherwise ask for more
  // names than exist and throw instead of degrading); and the rebalance cadence is
  // bounded the same way S2's is (weekly at the fastest, quarterly at the slowest).
  const volLookback = Math.max(5, Math.round(p.volLookback));
  const k = Math.min(Math.max(1, Math.round(p.k)), Math.max(1, universe.length));
  const rebalanceBars = Math.min(63, Math.max(5, Math.round(p.rebalanceBars)));
  const spec = {
    kind: 'BASKET',
    name: `Low volatility ${volLookback}d`,
    note: `Hold the ${k} least volatile names of the universe by trailing ${volLookback}-day return stdev, inverse-vol weighted, rebalanced every ${rebalanceBars} bars. No market gate.`,
    universe,
    rank: rankLowVol(volLookback),
    k,
    weighting: 'volinv',
    rebalanceBars,
  };
  const err = validateSpec(spec);
  if (err) throw new Error(`lowvol spec invalid: ${err}`);
  return { spec, params: { ...p, volLookback, k, rebalanceBars } };
}

export { makeLowvolSpec, rankLowVol, DEFAULTS };

// A deterministic PRNG for the null-distribution control. Research code must never call
// Math.random — a null distribution you cannot reproduce is not evidence.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A seeded sample of `n` names — the random-portfolio control. Fisher-Yates on a copy,
// so the caller's array is untouched and a given seed always yields the same draw.
function sampleNames(names, n, seed) {
  const rnd = mulberry32(seed);
  const pool = [...names];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(n, pool.length));
}

// A control spec: identical machinery to the study (k, cadence, inverse-vol weighting)
// with the ranking signal replaced. `sign` 0 = no information, -1 = low-vol, +1 = high-vol.
// Multiplying `vol` by 0 keeps the expression numeric and null-while-unwarm, so the
// control excludes exactly the same short-history names the study does — the ONLY
// difference between arms is the information content of the score.
function makeControlSpec(universe, sign, k = DEFAULTS.k, rebalanceBars = DEFAULTS.rebalanceBars, volLookback = DEFAULTS.volLookback) {
  const label = sign === 0 ? 'no signal' : sign < 0 ? 'low-vol' : 'high-vol';
  const spec = {
    kind: 'BASKET', name: `Control (${label})`, universe,
    rank: ['*', sign, ['vol', volLookback]],
    // Same 1..universe.length clamp as the study factory, so a control over a small
    // universe (or the equal-weight-everything arm) is always runnable.
    k: Math.min(Math.max(1, Math.round(k)), Math.max(1, universe.length)),
    weighting: 'volinv', rebalanceBars,
  };
  const err = validateSpec(spec);
  if (err) throw new Error(`control spec invalid: ${err}`);
  return spec;
}

export { makeControlSpec, sampleNames };

// ---------------------------------------------------------------------------
// CLI: `node backtest/research/lowvol.mjs` -> in-sample report + ±50% grid.
//      `--ablate`  -> the signal ablation (low-vol vs high-vol vs NO signal)
//      `--null`    -> the null distribution of seeded random 15-name portfolios
//      `--holdout` -> the ONE-SHOT holdout (NOT spent — the study failed in-sample)
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { loadCandles } = await import('../data.mjs');
  const { evaluateBasket } = await import('./harness.mjs');
  const { BASKET_UNIVERSE } = await import('../../tournament/universe.mjs');

  const holdout = process.argv.includes('--holdout');
  const ablate = process.argv.includes('--ablate');
  const nullDist = process.argv.includes('--null');

  // Load the whole universe from the on-disk cache (the tournament keeps it warm).
  // Anything synthetic (no real Yahoo data) is dropped — a research number must never
  // rest on fabricated bars.
  const dataBySymbol = {};
  let dropped = 0;
  for (const s of BASKET_UNIVERSE) {
    const { candles, source } = await loadCandles(s, { interval: '1d', range: '20y' });
    if (/synthetic/.test(source) || candles.length < 300) { dropped++; continue; }
    dataBySymbol[s] = candles;
  }
  // NIFTY is loaded only to keep the aligned master timeline identical to the other
  // basket studies' — this spec has no market gate, so it never reads the series.
  const { candles: market, source: mSrc } = await loadCandles('NIFTY', { interval: '1d', range: '20y' });
  const { candles: bench, source: bSrc } = await loadCandles('NIFTYBEES', { interval: '1d', range: '20y' });
  if (/synthetic/.test(mSrc) || /synthetic/.test(bSrc)) {
    console.error('refusing to evaluate: market/benchmark series is synthetic.');
    process.exit(1);
  }
  console.log(`data: ${Object.keys(dataBySymbol).length} universe names loaded (${dropped} dropped), NIFTYBEES bench ${bench.length} bars`);
  console.log('★ SURVIVORSHIP: the universe is today\'s liquid names held fixed across history — every figure below is an UPPER BOUND (METHODOLOGY.md).');
  console.log('★ Extra caveat for THIS study: survivorship bias flatters a low-volatility screen especially hard, because a name that later blew up or was delisted often got VOLATILE first — the survivor set is pre-filtered toward exactly what this factor tries to pick.');

  const fmt = (r) => {
    const m = r.metrics;
    const pf = r.profitFactor == null ? '–' : r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2);
    const to = r.turnoverPerYear == null ? '–' : r.turnoverPerYear.toFixed(2);
    const ks = r.killSwitch ? `KILL-SWITCH BREACH ${new Date(r.killSwitch.t).toISOString().slice(0, 10)} (dd ${(r.killSwitch.dd * 100).toFixed(1)}%)` : 'kill-switch clear';
    return `${r.name.padEnd(28)} CAGR ${String(m.cagrPct).padStart(6)}%  xSharpe ${String(m.sharpe).padStart(5)}  (rf0 ${String(m.sharpeRf0).padStart(5)})  Sortino ${String(m.sortino).padStart(5)}  MaxDD ${String(m.maxDrawdownPct).padStart(5)}%  PF ${pf}  turnover ${to}x/yr  trades ${m.trades}  liqFlags ${r.liquidity.flagged}/${r.liquidity.checked}  ${r.killSwitch !== undefined ? ks : ''}`;
  };

  // Warmup starts 2008 so the 252-day volatility window is fully warm at the scoring
  // start. Extra warmup cannot tune anything — it only makes the indicator warm sooner.
  const window = holdout
    ? { from: '2020-01-01', to: null, warmupFrom: '2018-01-01', allowHoldout: true }
    : { from: '2010-01-01', to: '2019-12-31', warmupFrom: '2008-01-01' };
  console.log(holdout
    ? '\n=== HOLDOUT (2020-01-01 → present) — ONE-SHOT evaluation ==='
    : '\n=== IN-SAMPLE (2010-01-01 → 2019-12-31) ===');

  const alignCache = new Map(); // same clipped data across the grid -> one aligned grid
  const universe = Object.keys(dataBySymbol);
  const base = makeLowvolSpec(universe);
  const res = evaluateBasket({ spec: base.spec, dataBySymbol, marketSeries: market, benchCandles: bench, alignCache, ...window });
  console.log(fmt(res));
  console.log(fmt({ ...res.benchmark, killSwitch: undefined }));
  console.log(`window: ${res.window.from} → ${res.window.to} (${res.window.bars} bars, ${res.window.warmupBars} warmup) — costs: ${res.costs.model}; holdings now: ${res.position}`);

  // The pre-registered verdict line, computed rather than eyeballed, so the bar cannot
  // drift after seeing the numbers.
  const edge = +(res.metrics.sharpe - res.benchmark.metrics.sharpe).toFixed(3);
  console.log(`\nPRE-REGISTERED BAR (vs the INDEX): excess-Sharpe >= benchmark + 0.15  ->  ${res.metrics.sharpe} vs ${res.benchmark.metrics.sharpe} (edge ${edge >= 0 ? '+' : ''}${edge}) = ${edge >= 0.15 ? 'MET' : 'NOT MET'}`);

  // ★ THE CORRECTED NULL — the finding that decided this study. Comparing a basket drawn
  // from a SURVIVOR universe against the index credits the survivorship premium to the
  // strategy. The honest null for "does this selection rule add value" is an equal-weight
  // portfolio of the SAME universe, selected with no information at all.
  const eqAll = evaluateBasket({ spec: makeControlSpec(universe, 0, universe.length), dataBySymbol, marketSeries: market, alignCache, ...window });
  const edge2 = +(res.metrics.sharpe - eqAll.metrics.sharpe).toFixed(3);
  console.log(`\n★ CORRECTED NULL — equal-weight ALL ${universe.length} names, no signal:`);
  console.log(`${'  equal-weight universe'.padEnd(24)} xSharpe ${String(eqAll.metrics.sharpe).padStart(5)}  CAGR ${String(eqAll.metrics.cagrPct).padStart(6)}%  MaxDD ${String(eqAll.metrics.maxDrawdownPct).padStart(6)}%`);
  console.log(`${'  the index (NIFTYBEES)'.padEnd(24)} xSharpe ${String(res.benchmark.metrics.sharpe).padStart(5)}  CAGR ${String(res.benchmark.metrics.cagrPct).padStart(6)}%  MaxDD ${String(res.benchmark.metrics.maxDrawdownPct).padStart(6)}%`);
  console.log(`  -> the survivor universe alone beats the index by ${(+(eqAll.metrics.sharpe - res.benchmark.metrics.sharpe).toFixed(2))} Sharpe / ${(+(eqAll.metrics.cagrPct - res.benchmark.metrics.cagrPct).toFixed(2))}pp CAGR with NO strategy.`);
  console.log(`BAR vs the HONEST NULL: ${res.metrics.sharpe} vs ${eqAll.metrics.sharpe} (edge ${edge2 >= 0 ? '+' : ''}${edge2}) = ${edge2 >= 0.15 ? 'MET' : 'NOT MET'}`);

  if (!holdout) {
    console.log('\n=== ±50% single-parameter perturbation (in-sample) ===');
    console.log('base:', JSON.stringify(base.params), '| benchmark xSharpe', res.benchmark.metrics.sharpe);
    let worst = Infinity;
    for (const name of ['volLookback', 'k', 'rebalanceBars']) {
      for (const f of [0.5, 0.75, 1.25, 1.5]) {
        const { spec, params } = makeLowvolSpec(universe, { ...DEFAULTS, [name]: DEFAULTS[name] * f });
        const r = evaluateBasket({ spec, dataBySymbol, marketSeries: market, alignCache, ...window });
        const to = r.turnoverPerYear == null ? '–' : r.turnoverPerYear.toFixed(2);
        if (r.metrics.sharpe < worst) worst = r.metrics.sharpe;
        console.log(`${name.padEnd(14)} ×${String(f).padEnd(4)} = ${String(+params[name].toFixed(4)).padStart(8)}  xSharpe ${String(r.metrics.sharpe).padStart(5)}  Sortino ${String(r.metrics.sortino).padStart(5)}  CAGR ${String(r.metrics.cagrPct).padStart(6)}%  MaxDD ${String(r.metrics.maxDrawdownPct).padStart(5)}%  turnover ${to}x  trades ${r.metrics.trades}${r.killSwitch ? '  ⚠ kill-switch breach' : ''}`);
      }
    }
    console.log(`\nGRID FLOOR: worst cell xSharpe ${worst} vs benchmark ${res.benchmark.metrics.sharpe} = ${worst >= res.benchmark.metrics.sharpe ? 'ALL CELLS HOLD' : 'A CELL FAILS THE BENCHMARK'}`);
  }

  // --- ABLATION: change ONLY the signal, hold every other knob fixed. -------------
  if (ablate) {
    console.log('\n=== SIGNAL ABLATION (identical k / cadence / weighting / universe) ===');
    for (const [label, sign] of [['A low-vol   (-vol)', -1], ['B high-vol  (+vol)', 1], ['C NO SIGNAL (   0)', 0]]) {
      const r = evaluateBasket({ spec: makeControlSpec(universe, sign), dataBySymbol, marketSeries: market, alignCache, ...window });
      const m = r.metrics;
      console.log(`${label}  xSharpe ${String(m.sharpe).padStart(5)}  Sortino ${String(m.sortino).padStart(5)}  CAGR ${String(m.cagrPct).padStart(6)}%  MaxDD ${String(m.maxDrawdownPct).padStart(6)}%  turnover ${(r.turnoverPerYear ?? 0).toFixed(2)}x`);
    }
    console.log('Read: arm A must beat arm C decisively, or the "edge" is not the signal.');
  }

  // --- NULL DISTRIBUTION: is the study's number distinguishable from noise? -------
  if (nullDist) {
    // Only names with enough history to be selectable at the scoring start, so a random
    // draw is not handicapped by the short-history names the study self-excludes.
    const startMs = Date.UTC(2010, 0, 1);
    const eligible = universe.filter((s) => dataBySymbol[s][0].t < startMs - 400 * 864e5);
    console.log(`\n=== NULL DISTRIBUTION: 20 seeded random ${DEFAULTS.k}-name portfolios (no signal) ===`);
    console.log(`eligible (pre-2009 history): ${eligible.length} of ${universe.length}`);
    const sharpes = [];
    for (let s = 1; s <= 20; s++) {
      const names = sampleNames(eligible, DEFAULTS.k, s * 7919);
      const r = evaluateBasket({ spec: makeControlSpec(names, 0), dataBySymbol, marketSeries: market, alignCache, ...window });
      sharpes.push(r.metrics.sharpe);
      console.log(`seed ${String(s).padStart(2)}  xSharpe ${String(r.metrics.sharpe).padStart(5)}  CAGR ${String(r.metrics.cagrPct).padStart(6)}%  MaxDD ${String(r.metrics.maxDrawdownPct).padStart(6)}%`);
    }
    const sorted = [...sharpes].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const beat = sorted.filter((x) => x >= res.metrics.sharpe).length;
    console.log(`\nnull: min ${sorted[0]}  median ${median}  max ${sorted[sorted.length - 1]}`);
    console.log(`random draws matching or beating the study's ${res.metrics.sharpe}: ${beat}/20 -> the study sits at ~the ${Math.round((1 - beat / 20) * 100)}th percentile of PURE NOISE.`);
  }
}
