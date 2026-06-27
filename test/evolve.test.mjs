// ---------------------------------------------------------------------------
// test/evolve.test.mjs
// Locks the genetic-algorithm evolution engine: mutations/crossovers stay inside
// the SAFE DSL (always valid), are deterministic from a seed, and evolve() ranks
// scored challengers. Pure + offline (hand-made price series).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mutateSpec, crossover, generateChallengers, evolve, mulberry32, archetypeOf, freshFactors, mutateFactors } from '../tournament/evolve.mjs';
import { validateSpec } from '../backtest/dsl.mjs';

const ROSTER = [
  { id: 'a', name: 'Golden cross', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'Golden cross', entry: ['>', ['sma', 50], ['sma', 200]], exit: ['<', ['sma', 50], ['sma', 200]] } },
  { id: 'b', name: 'RSI dip', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'RSI dip', entry: ['<', ['rsi', 14], 30], exit: ['>', ['rsi', 14], 60] } },
  { id: 'c', name: 'Strangle', kind: 'FNO', symbol: 'NIFTY', spec: { kind: 'FNO', name: 'Strangle', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.05 }, { type: 'PE', side: 'SELL', strikePct: 0.95 }] } },
];

function series(n = 300) {
  const out = [];
  let p = 18000;
  for (let i = 0; i < n; i++) { p *= 1 + Math.sin(i / 13) * 0.008 + 0.0004; out.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  return out;
}

test('mutateSpec always yields a valid DSL spec', () => {
  const rng = mulberry32(42);
  for (let i = 0; i < 200; i++) {
    for (const parent of ROSTER) {
      const m = mutateSpec(parent.spec, rng);
      assert.equal(validateSpec(m), null, `mutation of ${parent.name} must stay valid`);
    }
  }
});

test('crossover of same-kind parents is valid; different kinds returns null', () => {
  const rng = mulberry32(7);
  const eqChild = crossover(ROSTER[0].spec, ROSTER[1].spec, rng);
  assert.equal(validateSpec(eqChild), null, 'EQ x EQ child is valid');
  assert.equal(crossover(ROSTER[0].spec, ROSTER[2].spec, rng), null, 'EQ x FNO returns null');
});

test('crossover of mismatched EQ parents is always valid (entry-only × weight-only)', () => {
  const entryOnly = { kind: 'EQ', name: 'e', entry: ['>', ['sma', 10], ['sma', 30]], exit: ['<', ['sma', 10], ['sma', 30]] };
  const weightOnly = { kind: 'EQ', name: 'w', weight: ['clamp', ['/', 0.01, ['vol', 20]], 0, 1] };
  for (let s = 1; s <= 400; s++) {
    assert.equal(validateSpec(crossover(entryOnly, weightOnly, mulberry32(s))), null, `seed ${s} child must be valid`);
  }
});

test('crossover carries the bullish/BEARISH side (a short child never silently becomes long)', () => {
  // evolve.mjs crossover added fieldFrom('side') so a bred short keeps its direction. Lock it:
  const shortA = { kind: 'EQ', name: 'sa', side: 'short', entry: ['<', ['sma', 50], ['sma', 200]], exit: ['>', ['sma', 50], ['sma', 200]] };
  const shortB = { kind: 'EQ', name: 'sb', side: 'short', entry: ['<', ['rsi', 14], 40], exit: ['>', ['rsi', 14], 60] };
  for (let s = 0; s < 40; s++) {
    const child = crossover(shortA, shortB, mulberry32(s));
    assert.equal(validateSpec(child), null, `seed ${s}: a short × short child is valid`);
    assert.equal(child.side, 'short', `seed ${s}: a short × short child STAYS short (not silently long)`);
  }
  // Long parents (no side field) never produce a short child.
  const longA = { kind: 'EQ', name: 'la', entry: ['>', ['sma', 50], ['sma', 200]] };
  const longB = { kind: 'EQ', name: 'lb', weight: 1 };
  for (let s = 0; s < 20; s++) {
    const child = crossover(longA, longB, mulberry32(s));
    assert.ok(child.side === undefined || child.side === 'long', `seed ${s}: long parents never leak a short side`);
  }
  // long × short: direction is a 50/50 coin-flip — a LONG parent is NOT silently forced to
  // short (the earlier filter-undefined logic forced every long×short to short, inverting the
  // long parent's bullish rule into a short bot). Both directions must appear over many seeds.
  let shortKids = 0, longKids = 0;
  for (let s = 0; s < 60; s++) {
    const child = crossover(longA, shortB, mulberry32(s));
    assert.equal(validateSpec(child), null, `seed ${s}: long×short child is valid`);
    if (child.side === 'short') shortKids++; else longKids++;
  }
  assert.ok(shortKids > 0 && longKids > 0, `long×short must yield BOTH directions (not a forced short); got ${shortKids} short / ${longKids} long`);
});

test('generateChallengers produces the requested count of valid specs', () => {
  const rng = mulberry32(123);
  const ch = generateChallengers(ROSTER, 10, rng);
  assert.ok(ch.length >= 8, `expected ~10 challengers, got ${ch.length}`);
  for (const c of ch) assert.equal(validateSpec(c.spec), null);
});

test('challengers hunt across the provided symbols (and F&O stays on indices)', () => {
  const rng = mulberry32(5);
  const ch = generateChallengers(ROSTER, 50, rng, { eqSymbols: ['NIFTY', 'RELIANCE', 'TCS'], fnoSymbols: ['NIFTY'] });
  const eqSyms = new Set(ch.filter((c) => c.kind === 'EQ').map((c) => c.symbol));
  assert.ok(eqSyms.size >= 2, `EQ challengers should span >= 2 symbols, got ${[...eqSyms]}`);
  for (const c of ch.filter((c) => c.kind === 'FNO')) assert.equal(c.symbol, 'NIFTY', 'F&O stays on an index');
});

test('evolve scores + ranks challengers and is deterministic by seed', () => {
  const s = series();
  const opts = { roster: ROSTER, dataBySymbol: { NIFTY: s }, eqSymbols: ['NIFTY'], fnoSymbols: ['NIFTY'], n: 10, seed: 99 };
  const a = evolve(opts);
  const b = evolve(opts);
  assert.ok(a.length > 0, 'produced scored challengers');
  // ranked best-first by fitness
  for (let i = 1; i < a.length; i++) {
    const fa = a[i - 1].score.sharpe * 1000 + a[i - 1].score.totalReturnPct;
    const fb = a[i].score.sharpe * 1000 + a[i].score.totalReturnPct;
    assert.ok(fa >= fb - 1e-9, 'sorted by fitness descending');
  }
  assert.deepEqual(a.map((x) => x.spec), b.map((x) => x.spec), 'same seed -> same challengers');
});

// --- BASKET (multi-company) evolution ---------------------------------------
const BASKET_UNIVERSE = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'ITC', 'LT', 'AXISBANK', 'KOTAKBANK', 'BHARTIARTL', 'HINDUNILVR'];
const BASKET = { kind: 'BASKET', name: 'mom', universe: BASKET_UNIVERSE.slice(0, 6), rank: ['mom', 63], k: 3, weighting: 'equal', rebalanceBars: 21 };
const ML_BASKET = { kind: 'BASKET', name: 'ml', universe: BASKET_UNIVERSE.slice(0, 6), rank: ['mom', 63], k: 3, weighting: 'rankw', rebalanceBars: 21, mlConfig: { model: 'ridge', features: ['mom21', 'mom63', 'rsi14', 'smaSlope'], horizon: 21, lambda: 1, lookback: 504, trainEveryBars: 63, minTrain: 80 } };

test('mutateSpec always yields a valid BASKET spec (rule and ML)', () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 300; i++) for (const p of [BASKET, ML_BASKET]) {
    const m = mutateSpec(p, rng, BASKET_UNIVERSE);
    assert.equal(validateSpec(m), null, 'a mutated basket stays valid');
    assert.equal(m.kind, 'BASKET');
  }
});

test('crossover: BASKET × BASKET is valid; BASKET × EQ returns null', () => {
  const rng = mulberry32(3);
  assert.equal(validateSpec(crossover(BASKET, ML_BASKET, rng)), null, 'basket child valid');
  assert.equal(crossover(BASKET, { kind: 'EQ', name: 'e', weight: 1 }, rng), null, 'different kinds -> null');
});

test('the EQ→BASKET spawn bridge breeds baskets from an all-EQ roster', () => {
  const eqRoster = [{ id: 'a', name: 'rsi', kind: 'EQ', symbol: 'RELIANCE', spec: { kind: 'EQ', name: 'rsi', entry: ['<', ['rsi', 14], 30], exit: ['>', ['rsi', 14], 60] } }];
  const ch = generateChallengers(eqRoster, 80, mulberry32(11), { eqSymbols: BASKET_UNIVERSE, fnoSymbols: ['NIFTY'] });
  assert.ok(ch.some((c) => c.kind === 'BASKET'), 'some challengers are multi-company baskets');
  for (const c of ch) assert.equal(validateSpec(c.spec), null, 'every challenger is valid');
});

test('archetypeOf tags a spec by its dominant idea', () => {
  assert.equal(archetypeOf(BASKET), 'momentum');
  assert.equal(archetypeOf(ML_BASKET), 'ml-ridge');
  assert.equal(archetypeOf({ kind: 'BASKET', rank: ['distHigh', 126] }), 'breakout');
  assert.equal(archetypeOf({ kind: 'BASKET', rank: ['rsi', 14] }), 'meanrev');
  assert.equal(archetypeOf({ kind: 'EQ', weight: 1 }), 'benchmark');
  assert.equal(archetypeOf({ kind: 'FNO', legs: [] }), 'fno');
});

test('basket evolution never pulls an INDEX into a company basket (index-free pool)', () => {
  // eqSymbols contains indices (an EQ bot may "buy the index"), but basketSymbols
  // is the index-free company pool — baskets must only ever hold companies.
  const eqRoster = [{ id: 'a', name: 'rsi', kind: 'EQ', symbol: 'RELIANCE', spec: { kind: 'EQ', name: 'rsi', entry: ['<', ['rsi', 14], 30], exit: ['>', ['rsi', 14], 60] } }];
  const ch = generateChallengers(eqRoster, 120, mulberry32(11), { eqSymbols: ['NIFTY', 'BANKNIFTY', ...BASKET_UNIVERSE], fnoSymbols: ['NIFTY'], basketSymbols: BASKET_UNIVERSE });
  const baskets = ch.filter((c) => c.kind === 'BASKET');
  assert.ok(baskets.length > 0, 'the EQ→BASKET bridge produced baskets');
  for (const b of baskets) for (const sym of b.spec.universe) {
    assert.ok(!['NIFTY', 'BANKNIFTY'].includes(sym), `a basket must not hold an index, found ${sym}`);
  }
});

test('evolved ML baskets keep their features in canonical (sorted) order', () => {
  const rng = mulberry32(13);
  for (let i = 0; i < 300; i++) {
    const m = mutateSpec(ML_BASKET, rng, BASKET_UNIVERSE);
    if (m.mlConfig) assert.deepEqual(m.mlConfig.features, [...m.mlConfig.features].sort(), 'features stay canonically sorted (so clones dedupe)');
  }
});

test('evolve over a BASKET roster is deterministic by seed', () => {
  const syms = BASKET.universe;
  const dataBySymbol = {};
  syms.forEach((s, k) => {
    let p = 100 + k * 5, a = ((k + 1) * 99) >>> 0;
    const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const out = []; for (let i = 0; i < 600; i++) { p *= 1 + 0.0003 + k * 0.0002 + (r() - 0.5) * 0.02; out.push({ t: i * 864e5, c: +p.toFixed(2) }); }
    dataBySymbol[s] = out;
  });
  const roster = [{ id: 'm', name: 'mom', kind: 'BASKET', symbol: '6 stocks', spec: BASKET }, { id: 'l', name: 'ml', kind: 'BASKET', symbol: '6 stocks', spec: ML_BASKET }];
  const opts = { roster, dataBySymbol, eqSymbols: syms, fnoSymbols: ['NIFTY'], n: 12, seed: 42, cash: 10_000_000 };
  const a = evolve(opts), b = evolve(opts);
  assert.deepEqual(a.map((x) => x.spec), b.map((x) => x.spec), 'same seed -> same evolved baskets');
  for (const c of a) assert.equal(validateSpec(c.spec), null, 'scored challengers are valid');
});

// --- Quant Lab: factor / optimiser / tree-model evolution -------------------
const FACTOR_BASKET = { kind: 'BASKET', name: 'f', universe: BASKET_UNIVERSE.slice(0, 6), rank: ['mom', 63], factors: [{ name: 'momentum', expr: ['mom', 126], weight: 1 }, { name: 'low-vol', expr: ['*', -1, ['vol', 20]], weight: 0.5 }], k: 3, weighting: 'meanvar', covLookback: 126, maxWeight: 0.5, rebalanceBars: 21 };
const GBM_BASKET = { kind: 'BASKET', name: 'g', universe: BASKET_UNIVERSE.slice(0, 6), rank: ['mom', 63], k: 3, weighting: 'rankw', rebalanceBars: 21, mlConfig: { model: 'gbm', features: ['mom21', 'mom63', 'rsi14', 'smaSlope'], horizon: 21, lambda: 1, lookback: 504, trainEveryBars: 63, minTrain: 80, rounds: 40, learnRate: 0.1 } };

test('mutateSpec yields valid factor / optimiser / gbm baskets, and keeps factors XOR mlConfig', () => {
  const rng = mulberry32(17);
  for (let i = 0; i < 500; i++) for (const p of [FACTOR_BASKET, GBM_BASKET]) {
    const m = mutateSpec(p, rng, BASKET_UNIVERSE);
    assert.equal(validateSpec(m), null, 'a mutated quant basket stays valid');
    assert.ok(!(m.factors && m.mlConfig), 'a basket is never BOTH factor- and ML-driven (XOR)');
  }
});

test('archetypeOf tags factor + tree-model baskets', () => {
  assert.equal(archetypeOf(FACTOR_BASKET), 'factor');
  assert.equal(archetypeOf(GBM_BASKET), 'ml-gbm');
});

test('freshFactors / mutateFactors always produce valid factor lists', () => {
  const rng = mulberry32(3);
  const base = { kind: 'BASKET', name: 'x', universe: ['A', 'B', 'C', 'D'], rank: ['mom', 63], k: 2, rebalanceBars: 21 };
  for (let i = 0; i < 200; i++) {
    const fs = freshFactors(rng);
    assert.ok(fs.length >= 2 && fs.length <= 6, 'freshFactors makes 2..6 factors');
    assert.equal(validateSpec({ ...base, factors: fs }), null, 'freshFactors -> valid');
    assert.equal(validateSpec({ ...base, factors: mutateFactors(fs, rng) }), null, 'mutateFactors -> valid');
  }
});

test('evolve over factor / optimiser / ML baskets is deterministic by seed', () => {
  const syms = FACTOR_BASKET.universe;
  const dataBySymbol = {};
  syms.forEach((s, k) => {
    let p = 100 + k * 5, a = ((k + 1) * 131) >>> 0;
    const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const out = []; for (let i = 0; i < 650; i++) { p *= 1 + 0.0003 + k * 0.0002 + (r() - 0.5) * 0.02; out.push({ t: i * 864e5, c: +p.toFixed(2) }); }
    dataBySymbol[s] = out;
  });
  const roster = [{ id: 'f', name: 'f', kind: 'BASKET', symbol: '6 stocks', spec: FACTOR_BASKET }, { id: 'g', name: 'g', kind: 'BASKET', symbol: '6 stocks', spec: GBM_BASKET }];
  const opts = { roster, dataBySymbol, eqSymbols: syms, fnoSymbols: ['NIFTY'], n: 10, seed: 7, cash: 10_000_000 };
  const a = evolve(opts), b = evolve(opts);
  assert.deepEqual(a.map((x) => x.spec), b.map((x) => x.spec), 'same seed -> same evolved quant baskets');
  for (const c of a) assert.equal(validateSpec(c.spec), null, 'every scored challenger is valid');
});
