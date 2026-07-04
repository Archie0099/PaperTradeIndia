// ---------------------------------------------------------------------------
// backtest/research/s5-overlay.mjs
// Research study: RISK OVERLAYS retrofitted onto the best existing seed
// basket. Hypothesis in one line: a regime gate read DAILY (with a
// whipsaw confirm buffer) plus vol-target sizing at decision bars will cut the
// basket's max drawdown materially (target >= 1/3) at equal-or-better excess
// Sharpe — because the cross-sectional momentum study's holdout showed a 38.6% drawdown accumulating entirely
// BETWEEN monthly rebalance bars (the gate is only read there), and the trend study showed
// vol targeting trims the left tail even where it adds no return.
//
// The two overlays are the opt-in `dailyGate`/`gateConfirmBars` and
// `volTarget`/`volLookback` knobs in backtest/portfolio.mjs (default-off,
// byte-identical — locked by test/research-s5.test.mjs). This file is pure
// study: specs are data, no engine code.
//
// ★ SURVIVORSHIP CAVEAT (METHODOLOGY.md #1): the universe is ~105 names liquid
// TODAY held fixed across history — every number printed is an UPPER BOUND.
//
// ★ CONTAMINATION CAVEAT (study-specific): the daily-gate motif was motivated by
// the xsmom study's HOLDOUT observation (the kill-switch breach at the 2020 COVID bottom).
// The in-sample 2010-2019 verdict is clean; a holdout confirmation of the GATE
// specifically carries this asterisk — the designer had seen the 2020 crash
// shape. Both caveats are printed with every run — keep it that way.
//
// BASE-BOT SELECTION is done IN-SAMPLE (2010-2019), never off the live board:
// the board's lifetime Sharpe includes 2020-2026 — the holdout window — so
// picking by it would leak holdout information into the design. ML baskets are
// excluded on principle (measured previously: every gate variant HURTS them —
// their edge is cross-sectional selection, not market timing). ETF rotation is
// excluded too (different data universe, mostly post-2010 listings).
// ---------------------------------------------------------------------------

import { pathToFileURL } from 'node:url';
import { validateSpec } from '../dsl.mjs';

// Overlay defaults. volTarget 0.15 ≈ NIFTY's long-run realized vol, so the
// scalar sits ~1 in calm regimes and only trims in genuine stress; confirm 3
// means a gate flip must hold three consecutive sessions before it acts.
const DEFAULTS = {
  gateSma: 200,       // regime proxy length (overridden by the base bot's own gate if it has one)
  gateBuffer: 0.05,   // buffered gate (NIFTY > 0.95·SMA) — the same buffered gate shape the tournament's quant bots use
  gateConfirmBars: 3, // whipsaw buffer: N consecutive bars to confirm a flip
  volTarget: 0.15,    // annualized vol target for the gross-exposure scalar
  volLookback: 63,    // trailing window for realized market vol (~a quarter)
};

// The candidate base bots: every non-ML, non-ETF seed basket. (Why not ML/ETF:
// see the header.) Kept as an explicit list so a seed re-order can't silently
// change the study's candidate set.
const CANDIDATE_IDS = [
  'basket-momentum', 'basket-lowvol', 'basket-breakout',
  'quant-multifactor', 'quant-meanvar', 'quant-riskparity',
  'active-momentum', 'active-breakout', 'active-dip',
  'momentum-guarded',
];

// Read (sma length, buffer) out of a base bot's own marketGate so the overlay
// keeps the SAME regime signal and only changes WHEN it is read. Handles the
// two shapes the seeds use — ['>',['price'],['*',b,['sma',n]]] and
// ['>',['price'],['sma',n]] — anything else falls back to the proven default.
function gateParamsFrom(marketGate) {
  if (Array.isArray(marketGate) && marketGate[0] === '>' && Array.isArray(marketGate[2])) {
    const rhs = marketGate[2];
    if (rhs[0] === 'sma' && Number.isInteger(rhs[1])) return { gateSma: rhs[1], gateBuffer: DEFAULTS.gateBuffer }; // unbuffered gate -> ADD the proven buffer
    if (rhs[0] === '*' && Number.isFinite(rhs[1]) && Array.isArray(rhs[2]) && rhs[2][0] === 'sma') {
      return { gateSma: rhs[2][1], gateBuffer: +(1 - rhs[1]).toFixed(4) };
    }
  }
  return { gateSma: DEFAULTS.gateSma, gateBuffer: DEFAULTS.gateBuffer };
}

// Build an overlay ARM from a base spec. `daily`/`vol` pick which overlay(s)
// this arm carries; params are clamped/rounded so perturbation factors can be
// applied blindly (mirroring makeXsmomSpec). Arm A is the base spec untouched.
function makeS5Spec(baseSpec, params = {}, { daily = true, vol = true } = {}) {
  const p = { ...DEFAULTS, ...gateParamsFrom(baseSpec.marketGate), ...params };
  const gateSma = Math.max(2, Math.round(p.gateSma));
  const gateConfirmBars = Math.min(10, Math.max(1, Math.round(p.gateConfirmBars)));
  const volLookback = Math.min(252, Math.max(20, Math.round(p.volLookback)));
  const volTarget = Math.min(0.99, Math.max(0.01, p.volTarget));
  const gateBuffer = Math.min(0.5, Math.max(0, p.gateBuffer));
  const spec = { ...baseSpec, name: `${baseSpec.name} + S5 overlay${daily && vol ? '' : daily ? ' (gate only)' : ' (vol only)'}` };
  if (daily) {
    spec.marketGate = ['>', ['price'], ['*', +(1 - gateBuffer).toFixed(4), ['sma', gateSma]]];
    spec.dailyGate = true;
    spec.gateConfirmBars = gateConfirmBars;
  }
  if (vol) {
    spec.volTarget = volTarget;
    spec.volLookback = volLookback;
  }
  const err = validateSpec(spec);
  if (err) throw new Error(`s5 spec invalid: ${err}`);
  return { spec, params: { ...p, gateSma, gateBuffer, gateConfirmBars, volTarget, volLookback } };
}

export { makeS5Spec, gateParamsFrom, DEFAULTS, CANDIDATE_IDS };

// ---------------------------------------------------------------------------
// CLI: `node backtest/research/s5-overlay.mjs` -> base-bot selection table +
// arms A-D in-sample + the ±50% grid on the best arm.
// `--holdout` runs the ONE-SHOT holdout — only on an explicit go-ahead.
// (Selection + arm choice are re-derived from the IN-SAMPLE window either way,
// so a holdout run can never pick its own strategy on holdout data.)
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { loadCandles } = await import('../data.mjs');
  const { evaluateBasket } = await import('./harness.mjs');
  const { BASKET_UNIVERSE } = await import('../../tournament/universe.mjs');
  const { SEED_BOTS } = await import('../../tournament/seed.mjs');

  const holdout = process.argv.includes('--holdout');

  // Load the whole universe from the on-disk cache; drop synthetic / short names
  // (a research number must never rest on fabricated bars).
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
  console.log(`data: ${Object.keys(dataBySymbol).length} universe names loaded (${dropped} dropped), NIFTY gate ${market.length} bars, NIFTYBEES bench ${bench.length} bars`);
  console.log('★ SURVIVORSHIP: the universe is today\'s liquid names held fixed across history — every figure below is an UPPER BOUND (METHODOLOGY.md).');
  console.log('★ CONTAMINATION: the daily-gate motif was motivated by the xsmom study\'s HOLDOUT (the 2020 kill-switch breach) — in-sample results are clean; a holdout gate benefit carries that asterisk.');

  const fmt = (name, r) => {
    const m = r.metrics;
    const pf = r.profitFactor == null ? '–' : r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2);
    const to = r.turnoverPerYear == null ? '–' : r.turnoverPerYear.toFixed(2);
    const ks = r.killSwitch ? `⚠ KILL-SWITCH BREACH ${new Date(r.killSwitch.t).toISOString().slice(0, 10)} (dd ${(r.killSwitch.dd * 100).toFixed(1)}%)` : r.killSwitch === null ? 'kill-switch clear' : '';
    return `${name.padEnd(34)} CAGR ${String(m.cagrPct).padStart(6)}%  xSharpe ${String(m.sharpe).padStart(5)}  Sortino ${String(m.sortino).padStart(5)}  MaxDD ${String(m.maxDrawdownPct).padStart(5)}%  PF ${pf}  turnover ${to}x/yr  trades ${m.trades}  ${ks}`;
  };

  // The fixed windows (identical to the xsmom study): warmup from 2008 so slow
  // gates/indicators are fully warm by the scoring start.
  const IN_WIN = { from: '2010-01-01', to: '2019-12-31', warmupFrom: '2008-01-01' };
  const HOLD_WIN = { from: '2020-01-01', to: null, warmupFrom: '2018-01-01', allowHoldout: true };
  const alignCache = new Map();
  const run = (spec, win, withBench = false) =>
    evaluateBasket({ spec, dataBySymbol, marketSeries: market, ...(withBench ? { benchCandles: bench } : {}), alignCache, ...win });

  // --- Step 1: base-bot selection, strictly IN-SAMPLE ------------------------
  console.log('\n=== STEP 1 — base-bot selection (in-sample 2010-2019, full delivery costs) ===');
  const candidates = SEED_BOTS.filter((b) => CANDIDATE_IDS.includes(b.id));
  const scored = [];
  for (const bot of candidates) {
    const r = run(bot.spec, IN_WIN);
    scored.push({ id: bot.id, spec: bot.spec, r });
    console.log(fmt(bot.id, r));
  }
  // Best excess Sharpe; ties (to 2dp) break toward the shallower drawdown.
  scored.sort((a, b) => (b.r.metrics.sharpe - a.r.metrics.sharpe) || (a.r.metrics.maxDrawdownPct - b.r.metrics.maxDrawdownPct) || (a.id < b.id ? -1 : 1));
  const base = scored[0];
  console.log(`\n→ base bot: ${base.id} (in-sample xSharpe ${base.r.metrics.sharpe}, MaxDD ${base.r.metrics.maxDrawdownPct}%)`);

  // --- Step 2: arms A-D on the chosen base -----------------------------------
  const armSpecs = {
    A: { spec: base.spec, params: null },
    B: makeS5Spec(base.spec, {}, { daily: true, vol: false }),
    C: makeS5Spec(base.spec, {}, { daily: false, vol: true }),
    D: makeS5Spec(base.spec, {}, { daily: true, vol: true }),
  };
  const win = holdout ? HOLD_WIN : IN_WIN;
  console.log(holdout
    ? '\n=== HOLDOUT (2020-01-01 → present) — ONE-SHOT evaluation ==='
    : '\n=== STEP 2 — overlay arms (in-sample 2010-2019) ===');

  // In-sample: all four arms. Holdout: ONLY the base reference (A), the best
  // in-sample overlay arm, and the costed benchmark — B/C stay unspent, the
  // holdout never gets to pick between arms.
  const inArms = {};
  for (const armName of ['A', 'B', 'C', 'D']) {
    inArms[armName] = run(armSpecs[armName].spec, IN_WIN, armName === 'A');
  }
  const bestArm = ['B', 'C', 'D'].sort((x, y) =>
    (inArms[y].metrics.sharpe - inArms[x].metrics.sharpe) || (inArms[x].metrics.maxDrawdownPct - inArms[y].metrics.maxDrawdownPct) || (x < y ? -1 : 1))[0];

  if (!holdout) {
    for (const armName of ['A', 'B', 'C', 'D']) {
      const label = { A: 'A base as-is', B: 'B +daily gate', C: 'C +vol target', D: 'D both overlays' }[armName];
      console.log(fmt(label, inArms[armName]));
    }
    console.log(fmt('NIFTYBEES B&H (costed)', { ...inArms.A.benchmark, killSwitch: undefined }));
    console.log(`window: ${inArms.A.window.from} → ${inArms.A.window.to} (${inArms.A.window.bars} bars, ${inArms.A.window.warmupBars} warmup) — costs: ${inArms.A.costs.model}`);
    console.log(`→ best overlay arm in-sample: ${bestArm}`);
  } else {
    console.log(`(base + best arm fixed by the in-sample re-derivation: base ${base.id}, arm ${bestArm})`);
    const hA = run(armSpecs.A.spec, HOLD_WIN, true);
    const hBest = run(armSpecs[bestArm].spec, HOLD_WIN);
    console.log(fmt('A base as-is (reference)', hA));
    console.log(fmt(`${bestArm} (the overlay strategy)`, hBest));
    console.log(fmt('NIFTYBEES B&H (costed)', { ...hA.benchmark, killSwitch: undefined }));
    console.log(`window: ${hA.window.from} → ${hA.window.to} (${hA.window.bars} bars, ${hA.window.warmupBars} warmup) — costs: ${hA.costs.model}`);
  }

  // --- Step 3: ±50% single-parameter perturbation on the best arm (in-sample) -
  // `--grid=B|C|D` overrides which arm gets the grid — used to complete the
  // sensitivity evidence for a NEGATIVE verdict (show no ±50% neighborhood of a
  // failing arm rescues it). In-sample only; never the holdout.
  if (!holdout) {
    const gridFlag = (process.argv.find((a) => /^--grid=/.test(a)) || '').slice(7).toUpperCase();
    const gridArm = ['B', 'C', 'D'].includes(gridFlag) ? gridFlag : bestArm;
    console.log(`\n=== STEP 3 — ±50% single-parameter perturbation on arm ${gridArm} (in-sample)${gridArm !== bestArm ? ' [--grid override]' : ''} ===`);
    const armOpts = { B: { daily: true, vol: false }, C: { daily: false, vol: true }, D: { daily: true, vol: true } }[gridArm];
    const baseParams = armSpecs[gridArm].params;
    console.log('base:', JSON.stringify(baseParams));
    const paramNames = [
      ...(armOpts.daily ? ['gateSma', 'gateBuffer', 'gateConfirmBars'] : []),
      ...(armOpts.vol ? ['volTarget', 'volLookback'] : []),
    ];
    for (const name of paramNames) {
      for (const f of [0.5, 0.75, 1.25, 1.5]) {
        const { spec, params } = makeS5Spec(base.spec, { ...baseParams, [name]: baseParams[name] * f }, armOpts);
        const r = run(spec, IN_WIN);
        const to = r.turnoverPerYear == null ? '–' : r.turnoverPerYear.toFixed(2);
        console.log(`${name.padEnd(16)} ×${String(f).padEnd(4)} = ${String(+params[name].toFixed(4)).padStart(8)}  xSharpe ${String(r.metrics.sharpe).padStart(5)}  Sortino ${String(r.metrics.sortino).padStart(5)}  CAGR ${String(r.metrics.cagrPct).padStart(6)}%  MaxDD ${String(r.metrics.maxDrawdownPct).padStart(5)}%  turnover ${to}x  trades ${r.metrics.trades}${r.killSwitch ? '  ⚠ kill-switch breach' : ''}`);
      }
    }
  }
}
