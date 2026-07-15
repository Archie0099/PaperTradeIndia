// ---------------------------------------------------------------------------
// test/dsl.test.mjs
// Locks the strategy DSL: the interpreter math, validation (so a bad spec is
// skipped, never run), and that a DSL strategy matches its hand-coded twin.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evalNode, validateSpec, safeCompile, explainSpec, strategyRationale, EXAMPLE_SPECS, MAX_BASKET_UNIVERSE } from '../backtest/dsl.mjs';
import { STRATEGIES } from '../backtest/strategies.mjs';
import { runBacktest } from '../backtest/backtester.mjs';

const candlesFrom = (closes) => closes.map((c, i) => ({ t: i * 864e5, c }));

test('evalNode: indicators, math, comparisons, and null-until-warm', () => {
  const closes = [10, 11, 12, 13, 14, 15];
  assert.equal(evalNode(['price'], closes, 5), 15);
  assert.equal(evalNode(['sma', 3], closes, 5), (13 + 14 + 15) / 3);
  assert.equal(evalNode(['sma', 50], closes, 5), null); // not enough history
  assert.equal(evalNode(['>', ['price'], 14], closes, 5), true);
  assert.equal(evalNode(['>', ['sma', 50], 0], closes, 5), false); // null operand -> false
  assert.equal(evalNode(['clamp', 5, 0, 1], closes, 5), 1);
});

test('validateSpec accepts the examples and rejects malformed specs', () => {
  for (const s of EXAMPLE_SPECS) assert.equal(validateSpec(s), null, `${s.name} should be valid`);
  assert.ok(validateSpec({ kind: 'EQ', name: 'x', entry: ['frobnicate', 3] })); // unknown op -> error string
  assert.ok(validateSpec({ kind: 'EQ', name: 'x', entry: ['sma', 9999] })); // period too large
  assert.ok(validateSpec({ kind: 'XX', name: 'x' })); // bad kind
  assert.ok(validateSpec({ kind: 'FNO', name: 'x', legs: [{ type: 'CE', side: 'SELL', strikePct: 5 }] })); // strikePct out of range
  assert.ok(validateSpec({ kind: 'EQ', name: 'x' })); // EQ with no entry and no weight
  assert.ok(validateSpec({ kind: 'EQ', name: 'x', weight: Infinity })); // non-finite literal rejected
  assert.ok(validateSpec({ kind: 'EQ', name: 'x', entry: ['>', ['rsi', 14], NaN] })); // NaN literal rejected
});

test('all example specs compile', () => {
  for (const s of EXAMPLE_SPECS) assert.equal(safeCompile(s).ok, true, `${s.name} compiles`);
});

test('validateSpec/safeCompile never THROW on a malformed FNO leg — the safety boundary is total (regression)', () => {
  // A null/undefined leg element used to hit `l.type` and throw a TypeError instead of
  // returning an error string, crashing every caller (rebuildBots boot, run-generated batch,
  // evolve scoring). It must be rejected the same way a non-object leg already is.
  for (const legs of [[null], [undefined], [{ type: 'CE', side: 'SELL', strikePct: 1 }, null]]) {
    const spec = { kind: 'FNO', name: 'x', legs };
    let res;
    assert.doesNotThrow(() => { res = validateSpec(spec); }, 'validateSpec must not throw on a null leg');
    assert.match(res, /leg must be an object/, 'a null leg is rejected with an error string');
    assert.doesNotThrow(() => safeCompile(spec), 'safeCompile must not throw either');
    assert.equal(safeCompile(spec).ok, false, 'a malformed FNO spec is safely rejected, not run');
  }
  // A well-formed FNO spec still validates + compiles.
  const good = { kind: 'FNO', name: 'ok', legs: [{ type: 'CE', side: 'SELL', strikePct: 1 }] };
  assert.equal(validateSpec(good), null);
  assert.equal(safeCompile(good).ok, true);
});

test('validateBasket rejects a boolean/comparison-valued rank but accepts a numeric rank (regression: a boolean rank silently holds cash forever)', () => {
  const base = { kind: 'BASKET', name: 'b', universe: ['A', 'B', 'C', 'D'], k: 2, weighting: 'equal', rebalanceBars: 21 };
  // A comparison rank evaluates to a boolean; portfolio.mjs then drops every name
  // (Number.isFinite(true) === false), so the basket sits in cash on every rebalance.
  // (The same hazard the `factors` validation already guards against.)
  assert.match(validateSpec({ ...base, rank: ['>', ['mom', 63], 0] }), /numeric-valued/, 'a comparison rank is rejected by the numeric-valued guard');
  assert.ok(validateSpec({ ...base, rank: ['and', ['>', ['price'], ['sma', 50]], ['<', ['rsi', 14], 70]] }), 'a logic-rooted rank is rejected');
  assert.ok(validateSpec({ ...base, rank: true }), 'a bare boolean rank is rejected');
  // A numeric-valued rank is still accepted (the seed baskets all use these).
  assert.equal(validateSpec({ ...base, rank: ['mom', 63] }), null, 'a numeric indicator rank is accepted');
  assert.equal(validateSpec({ ...base, rank: ['*', -1, ['vol', 20]] }), null, 'a numeric expression rank is accepted');
});

test('EQ side: bearish (short) specs validate, compile, and explain; garbage is rejected', () => {
  // The new directional flag — `side:'short'` makes a bot bearish (it shorts the symbol).
  assert.equal(validateSpec({ kind: 'EQ', name: 's', side: 'short', weight: 1 }), null, 'always-short is valid');
  assert.equal(validateSpec({ kind: 'EQ', name: 's', side: 'long', entry: ['>', ['price'], ['sma', 50]] }), null, 'explicit long is valid');
  assert.ok(validateSpec({ kind: 'EQ', name: 's', side: 'sideways', weight: 1 }), 'an unknown side is rejected');
  const c = safeCompile({ kind: 'EQ', name: 's', side: 'short', entry: ['<', ['sma', 50], ['sma', 200]], exit: ['>', ['sma', 50], ['sma', 200]], weight: 1 });
  assert.ok(c.ok, 'a short spec compiles');
  // The compiled short returns a NEGATIVE target while in position (a long the same spec is positive).
  const shortDecide = c.strategy.make();
  const longDecide = safeCompile({ kind: 'EQ', name: 'l', entry: ['<', ['sma', 50], ['sma', 200]], exit: ['>', ['sma', 50], ['sma', 200]], weight: 1 }).strategy.make();
  const closes = Array.from({ length: 260 }, (_, i) => 100 - i * 0.1); // a steady downtrend -> 50-DMA below 200-DMA late
  let sT = 0, lT = 0;
  for (let i = 0; i < closes.length; i++) { sT = shortDecide({ closes, i }); lT = longDecide({ closes, i }); }
  assert.ok(sT <= 0, `short target is non-positive, got ${sT}`);
  assert.ok(lT >= 0 && Math.abs(lT) === Math.abs(sT), 'the long target is the mirror image (same magnitude, opposite sign)');
  assert.match(explainSpec({ kind: 'EQ', name: 's', side: 'short', entry: ['<', ['sma', 50], ['sma', 200]] }), /short|bearish|falls/i);
});

test('explainSpec gives readable plain-English descriptions', () => {
  const eq = explainSpec({ kind: 'EQ', name: 'x', entry: ['<', ['rsi', 14], 30], exit: ['>', ['rsi', 14], 60] });
  assert.match(eq, /Buys when RSI\(14\) is below 30/);
  assert.match(eq, /sells when RSI\(14\) is above 60/);
  assert.match(explainSpec({ kind: 'EQ', name: 'bh', weight: 1 }), /buy & hold/i);
  const fno = explainSpec({ kind: 'FNO', name: 's', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.05 }, { type: 'PE', side: 'SELL', strikePct: 0.95 }] });
  assert.match(fno, /sell 5% OTM call/);
  assert.match(fno, /sell 5% OTM put/);
  // Booleans are valid expr leaves — they must render, never as "?".
  assert.doesNotMatch(explainSpec({ kind: 'EQ', name: 'x', entry: ['or', false, ['>', ['price'], ['sma', 50]]] }), /\?/);
  // Out-of-range numeric weights are reported as the clamped exposure (no NaN%/negative).
  assert.match(explainSpec({ kind: 'EQ', name: 'x', weight: NaN }), /0% of capital/);
  assert.doesNotMatch(explainSpec({ kind: 'EQ', name: 'x', weight: -0.5 }), /-/);
});

test('a DSL strategy matches its hand-coded twin (SMA 50/200) on real-ish data', () => {
  // Build a wandering series long enough for the 200-day SMA to engage.
  const closes = [];
  let p = 100;
  for (let i = 0; i < 400; i++) { p *= 1 + Math.sin(i / 23) * 0.012 + 0.0003; closes.push(+p.toFixed(2)); }
  const candles = candlesFrom(closes);

  const dslSma = safeCompile(EXAMPLE_SPECS[0]).strategy; // SMA 50/200
  const handSma = STRATEGIES.find((s) => s.name.startsWith('SMA 50/200'));

  const a = runBacktest({ strategy: dslSma, candles, symbol: 'TEST', cash: 1_000_000 });
  const b = runBacktest({ strategy: handSma, candles, symbol: 'TEST', cash: 1_000_000 });
  assert.ok(Math.abs(a.metrics.totalReturnPct - b.metrics.totalReturnPct) < 0.01,
    `DSL SMA (${a.metrics.totalReturnPct}%) should match hand-coded (${b.metrics.totalReturnPct}%)`);
});

test('the new basket-era indicators are null-until-warm then finite', () => {
  const closes = Array.from({ length: 320 }, (_, i) => 100 * (1 + Math.sin(i / 15) * 0.1 + i * 0.002));
  for (const expr of [['macd', 12, 26, 9], ['atr', 14], ['distHigh', 252], ['slope', 50], ['volratio', 20, 63], ['zscore', 50], ['regime', 200]]) {
    assert.equal(evalNode(expr, closes, 2), null, `${JSON.stringify(expr)} is null before warm`);
    assert.ok(Number.isFinite(evalNode(expr, closes, 319)), `${JSON.stringify(expr)} is finite once warm`);
  }
});

test('validateSpec accepts well-formed BASKETs and rejects malformed ones', () => {
  const good = { kind: 'BASKET', name: 'b', universe: ['A', 'B', 'C', 'D'], rank: ['mom', 63], k: 2, weighting: 'equal', rebalanceBars: 21 };
  const ml = { model: 'ridge', features: ['mom21', 'mom63'], horizon: 21, lambda: 1, lookback: 504, trainEveryBars: 63, minTrain: 80 };
  assert.equal(validateSpec(good), null, 'a plain rule basket is valid');
  assert.equal(validateSpec({ ...good, mlConfig: ml }), null, 'an ML basket is valid');
  assert.ok(validateSpec({ ...good, k: 9 }));                                       // k > universe.length
  assert.ok(validateSpec({ ...good, universe: ['A'] }));                            // universe too small
  assert.ok(validateSpec({ ...good, rebalanceBars: 2 }));                           // cadence too short
  assert.ok(validateSpec({ ...good, weighting: 'nope' }));                          // bad weighting
  assert.ok(validateSpec({ ...good, mlConfig: { ...ml, features: ['nope'] } }));    // unknown / too few features
  assert.ok(validateSpec({ ...good, mlConfig: { ...ml, lambda: 0 } }));             // lambda must be > 0 (no singular matrix)
});

test('a BASKET universe may hold up to MAX_BASKET_UNIVERSE names (cap raised past the old 16)', () => {
  const names = Array.from({ length: MAX_BASKET_UNIVERSE }, (_, i) => 'S' + i);
  const ok = { kind: 'BASKET', name: 'big', universe: names, rank: ['mom', 21], k: 5, weighting: 'equal', rebalanceBars: 5 };
  assert.equal(validateSpec(ok), null, `a ${MAX_BASKET_UNIVERSE}-name basket is valid`);
  assert.ok(validateSpec({ ...ok, universe: [...names, 'SX'], k: 5 }), 'one name over the cap is rejected');
  assert.ok(MAX_BASKET_UNIVERSE >= 24, 'the cap is meaningfully larger than the old 16');
});

test('every shipped tournament seed bot is a valid, broad line-up', async () => {
  const { SEED_BOTS } = await import('../tournament/seed.mjs');
  for (const b of SEED_BOTS) assert.equal(validateSpec(b.spec), null, `seed "${b.id}" (${b.name}) must be a valid spec`);
  assert.ok(SEED_BOTS.length >= 12, 'the expanded line-up (benchmark + F&O + 8 baskets) is present');
  assert.ok(SEED_BOTS.some((b) => /active|hunter|breakout|dip/i.test(b.name)), 'includes the active opportunity-hunters');
});

test('the research-lab graduate (xsmom) ships as validated: gated, top-10 volinv monthly, NO kill-switch', async () => {
  // Locks the promotion decision: the one out-of-sample survivor graduates to the
  // board built from the EXACT research factory (makeXsmomSpec), gated exactly as
  // validated, and — critically — WITHOUT a kill-switch (the permanent-flatten kill
  // design was REJECTED on the holdout because it would lock in the loss at the crash
  // low). A future refactor must not silently re-tune the spec or re-add a kill-switch.
  const { SEED_BOTS } = await import('../tournament/seed.mjs');
  const { makeXsmomSpec } = await import('../backtest/research/xsmom.mjs');
  const { BASKET_UNIVERSE } = await import('../tournament/universe.mjs');
  const b = SEED_BOTS.find((x) => x.id === 'xsmom-research');
  assert.ok(b, 'the xsmom research graduate is on the board');
  assert.equal(validateSpec(b.spec), null, 'its spec is valid');
  assert.equal(b.spec.kind, 'BASKET');
  assert.equal(b.spec.k, 10, 'top-10 holdings, as validated');
  assert.equal(b.spec.weighting, 'volinv', 'inverse-vol weighted');
  assert.equal(b.spec.rebalanceBars, 21, 'monthly cadence');
  assert.ok(b.spec.marketGate !== undefined, 'carries the buffered regime gate');
  // NO kill-switch of any shape (the holdout rejected the permanent-flatten design).
  assert.ok(!('killDD' in b.spec) && !('killSwitch' in b.spec), 'ships WITHOUT a kill-switch');
  // Built from the exact research spec (fidelity to what was validated out-of-sample).
  const { spec: fromFactory } = makeXsmomSpec(BASKET_UNIVERSE.slice(0, 120));
  assert.deepEqual(b.spec, fromFactory, 'the live spec IS makeXsmomSpec(WIDE) — no drift from the studied strategy');
});

test('the quant OPTIMISERS carry a regime gate; the ML baskets deliberately do NOT', async () => {
  // Part 2 tuning: a buffered market-regime gate (step to cash in a confirmed downturn)
  // empirically ~halves the optimisers' drawdown at no Sharpe cost, but HURTS the ML
  // baskets (whose edge is selection). This locks that decision so it can't silently
  // regress (a future "consistency" pass must not gate the ML, nor ungate the optimisers).
  const { SEED_BOTS } = await import('../tournament/seed.mjs');
  const byId = (id) => SEED_BOTS.find((b) => b.id === id);
  for (const id of ['quant-multifactor', 'quant-meanvar', 'quant-riskparity']) {
    const b = byId(id);
    assert.ok(b && b.spec.marketGate !== undefined, `${id} must carry a market-regime gate (down-regime protection)`);
    // The buffered gate (a confirmation buffer below the MA) — NOT the naive bare-MA gate.
    assert.equal(validateSpec(b.spec), null, `${id} stays a valid spec with the gate`);
    assert.match(explainSpec(b.spec), /cash/, `${id}'s explanation mentions sitting in cash on the gate`);
  }
  for (const id of ['basket-ml-ridge', 'basket-ml-logistic', 'quant-ml-gbm']) {
    const b = byId(id);
    assert.ok(b && b.spec.marketGate === undefined, `${id} (an ML basket) must stay UN-gated by design`);
  }
});

test('explainSpec describes a BASKET in plain English (no question marks)', () => {
  const s = explainSpec({ kind: 'BASKET', name: 'b', universe: ['A', 'B', 'C', 'D'], rank: ['mom', 126], k: 3, weighting: 'equal', rebalanceBars: 21, gate: ['>', ['price'], ['sma', 200]] });
  assert.match(s, /hold the top 3 of 4 names/);
  assert.doesNotMatch(s, /\?/);
});

// --- Quant Lab: factor model + optimiser weightings + tree-model configs ----
test('validateSpec accepts FACTOR baskets + new weightings/models; rejects malformed', () => {
  const base = { kind: 'BASKET', name: 'b', universe: ['A', 'B', 'C', 'D'], rank: ['mom', 63], k: 2, rebalanceBars: 21 };
  const factor = { ...base, factors: [{ name: 'mom', expr: ['mom', 126], weight: 1 }, { name: 'vol', expr: ['vol', 20], weight: -0.5 }] };
  assert.equal(validateSpec(factor), null, 'a factor basket is valid');
  assert.ok(validateSpec({ ...factor, factors: [] }), 'empty factors rejected');
  assert.ok(validateSpec({ ...factor, factors: [{ name: 'x', expr: ['frobnicate', 1], weight: 1 }] }), 'a bad factor expr is rejected');
  assert.ok(validateSpec({ ...factor, factors: [{ name: 'x', expr: ['mom', 1], weight: NaN }] }), 'a non-finite factor weight is rejected');
  assert.ok(validateSpec({ ...base, factors: [{ name: 'cmp', expr: ['>', ['price'], ['sma', 50]], weight: 1 }] }), 'a boolean/comparison factor expr is rejected (the composite needs numbers)');
  assert.equal(validateSpec({ ...base, factors: [{ name: 'reg', expr: ['regime', 100], weight: 1 }] }), null, 'a numeric 0/1 op (regime) is still a valid factor');
  const ml = { model: 'ridge', features: ['mom21', 'mom63'], horizon: 21, lambda: 1, lookback: 504, trainEveryBars: 63, minTrain: 80 };
  assert.ok(validateSpec({ ...factor, mlConfig: ml }), 'factors + mlConfig together is rejected (XOR)');
  // optimiser weightings + knobs
  assert.equal(validateSpec({ ...base, weighting: 'meanvar', covLookback: 126, maxWeight: 0.4 }), null, 'meanvar is valid');
  assert.equal(validateSpec({ ...base, weighting: 'riskparity' }), null, 'riskparity is valid (knobs optional)');
  assert.ok(validateSpec({ ...base, weighting: 'meanvar', maxWeight: 1.5 }), 'maxWeight > 1 rejected');
  assert.ok(validateSpec({ ...base, weighting: 'meanvar', covLookback: 10 }), 'covLookback too small rejected');
  // gbm / forest model families + their knobs
  assert.equal(validateSpec({ ...base, mlConfig: { ...ml, model: 'gbm', rounds: 40, learnRate: 0.1 } }), null, 'gbm config is valid');
  assert.equal(validateSpec({ ...base, mlConfig: { ...ml, model: 'forest', trees: 24, depth: 3 } }), null, 'forest config is valid');
  assert.ok(validateSpec({ ...base, mlConfig: { ...ml, model: 'gbm', rounds: 1 } }), 'rounds out of range rejected');
  assert.ok(validateSpec({ ...base, mlConfig: { ...ml, model: 'forest', depth: 99 } }), 'depth out of range rejected');
  assert.ok(validateSpec({ ...base, mlConfig: { ...ml, model: 'svm' } }), 'an unknown model is rejected');
});

test('explainSpec + strategyRationale describe factor & optimiser baskets (no question marks)', () => {
  const factor = { kind: 'BASKET', name: 'f', universe: ['A', 'B', 'C', 'D'], rank: ['mom', 126], factors: [{ name: 'momentum', expr: ['mom', 126], weight: 1 }, { name: 'low-vol', expr: ['*', -1, ['vol', 20]], weight: 0.5 }], k: 3, weighting: 'meanvar', covLookback: 126, maxWeight: 0.4, rebalanceBars: 21 };
  const e = explainSpec(factor);
  assert.match(e, /factor model/i, 'explained as a factor model');
  assert.match(e, /mean-variance/i, 'names the optimiser weighting');
  assert.doesNotMatch(e, /\?/);
  const r = strategyRationale(factor);
  assert.match(r.headline, /factor/i, 'rationale headline mentions factors');
  assert.ok(r.params.some((p) => /Factors/.test(p.label)), 'a Factors param is listed');
  assert.ok(r.params.some((p) => /Optimiser/.test(p.label)), 'an Optimiser param is listed');
  const gbm = strategyRationale({ kind: 'BASKET', name: 'g', universe: ['A', 'B', 'C', 'D'], rank: ['mom', 63], k: 3, weighting: 'rankw', rebalanceBars: 21, mlConfig: { model: 'gbm', features: ['mom21', 'mom63'], horizon: 21, lambda: 1, lookback: 504, trainEveryBars: 63, minTrain: 80 } });
  assert.match(gbm.thesis, /gradient-boosted/i, 'the gbm thesis names the model family');
});
