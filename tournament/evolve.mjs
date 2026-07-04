// ---------------------------------------------------------------------------
// tournament/evolve.mjs
// A free, LOCAL genetic algorithm over the strategy DSL — the "autonomous
// evolution" engine. It mutates and crosses existing strategy specs to breed
// challengers, backtests them, and ranks them. All computation is local and
// free — no paid API keys, just data + maths. The tournament promotes winners
// and retires losers.
//
// Everything stays inside the SAFE DSL (specs are data, validated before use),
// so an evolved strategy can never be arbitrary code.
// ---------------------------------------------------------------------------

import { safeCompile, validateSpec, FEATURE_WHITELIST, MAX_BASKET_UNIVERSE } from '../backtest/dsl.mjs';
import { runBacktest } from '../backtest/backtester.mjs';
import { runFnoBacktest } from '../backtest/fno.mjs';
import { runPortfolioBacktest } from '../backtest/portfolio.mjs';
import { runPairsBacktest } from '../backtest/pairs.mjs';
import { makeRankSource } from '../backtest/ml.mjs';
import { equityDeliveryCosts, indexOptionCosts } from '../backtest/costs.mjs';

// Challengers are scored under the SAME real Indian cost schedules the tournament
// deploys with (tournament.mjs) — scoring cost-free would systematically breed
// high-turnover strategies whose paper edge is eaten by costs the moment they run.
// (Evolution breeds only daily bots, so the intraday schedule isn't needed here.)
const EQ_COSTS = equityDeliveryCosts();
const OPT_COSTS = indexOptionCosts();

const INDEX_SPECS = {
  NIFTY: { lotSize: 75, strikeStep: 50 },
  BANKNIFTY: { lotSize: 35, strikeStep: 100 },
  FINNIFTY: { lotSize: 65, strikeStep: 50 },
};
// Single-integer-period indicators the expression mutator may nudge. The new
// basket-era ones (slope/distHigh/zscore/atr/regime) join here; macd & volratio
// take multiple periods and get their own handling in mutateExpr.
const PERIOD_OPS = new Set(['sma', 'ema', 'rsi', 'mom', 'high', 'low', 'vol', 'slope', 'distHigh', 'zscore', 'atr', 'regime']);
const WEIGHTINGS = ['equal', 'rankw', 'volinv', 'meanvar', 'riskparity'];
// Factor templates the GA can assemble into a multi-factor composite. Each is a valid
// DSL expr (the weight sets its contribution; the expr sets its direction — e.g. a
// negative-sign expr makes "lower is better"). Sourced from classic equity factors.
const FACTOR_TEMPLATES = [
  { name: 'momentum', expr: ['mom', 126] },
  { name: 'short-mom', expr: ['mom', 21] },
  { name: 'low-vol', expr: ['*', -1, ['vol', 20]] },
  { name: 'trend', expr: ['slope', 50] },
  { name: 'reversal', expr: ['*', -1, ['rsi', 5]] },
  { name: 'near-high', expr: ['distHigh', 126] },
  { name: 'long-mom', expr: ['mom', 252] },
];
// Boolean-valued ops — only these make sense as a basket gate (per-name eligibility).
const BOOL_OPS = new Set(['>', '<', '>=', '<=', 'and', 'or', 'not']);
// Small pool of sensible gates evolution can graft onto a basket.
const GATE_TEMPLATES = [['>', ['price'], ['sma', 200]], ['>', ['mom', 63], 0], ['<', ['rsi', 14], 70], ['>', ['regime', 100], 0]];

// Deterministic PRNG so a generation is reproducible from its seed (good for
// tests and for not re-running the same mutations differently each restart).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Tolerate null/undefined (JSON.parse(JSON.stringify(undefined)) throws "undefined is
// not valid JSON") so a malformed spec passed in can never crash the GA mid-breed.
const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
const pick = (arr, rng) => arr[Math.floor(rng() * arr.length)];
const clampInt = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.round(x)));

// Mutate a DSL expression tree: jitter numeric literals, nudge indicator
// periods, occasionally swap SMA<->EMA. Returns a NEW tree (never mutates input).
function mutateExpr(node, rng, rate = 0.3) {
  if (typeof node === 'number') {
    if (node !== 0 && rng() < rate) return +(node * (1 + (rng() * 0.6 - 0.3))).toFixed(4); // ±30%
    return node;
  }
  if (!Array.isArray(node) || node.length === 0) return node;
  const [op, ...a] = node;
  if (PERIOD_OPS.has(op)) {
    let n = a[0];
    if (rng() < rate) n = clampInt(n * (1 + (rng() * 0.6 - 0.3)), 2, 400);
    let o = op;
    if ((op === 'sma' || op === 'ema') && rng() < rate * 0.3) o = op === 'sma' ? 'ema' : 'sma';
    return [o, n];
  }
  // macd / volratio carry INTEGER periods with an ordering constraint — nudge them
  // as integers (never to a fraction, which would fail validation) and preserve it.
  if (op === 'macd') {
    let [f, s, sig] = a;
    if (rng() < rate) f = clampInt(f * (1 + (rng() * 0.6 - 0.3)), 2, 200);
    if (rng() < rate) s = clampInt(s * (1 + (rng() * 0.6 - 0.3)), 3, 400);
    if (rng() < rate) sig = clampInt(sig * (1 + (rng() * 0.6 - 0.3)), 2, 100);
    if (f >= s) f = Math.max(2, s - 1); // keep fast < slow
    return ['macd', f, s, sig];
  }
  if (op === 'volratio') {
    let [x, y] = a;
    if (rng() < rate) x = clampInt(x * (1 + (rng() * 0.6 - 0.3)), 2, 200);
    if (rng() < rate) y = clampInt(y * (1 + (rng() * 0.6 - 0.3)), 3, 400);
    if (x >= y) x = Math.max(2, y - 1); // keep short < long
    return ['volratio', x, y];
  }
  return [op, ...a.map((x) => mutateExpr(x, rng, rate))];
}

// --- basket / ML mutation helpers -------------------------------------------
// Pick 3..5 distinct ML features from the whitelist (always a valid set). Sorted
// so the feature set is CANONICAL (order never affects the model, and a canonical
// order lets specKey dedupe feature-reordered clones — see tournament.specKey).
function sampleFeatures(rng) {
  const pool = [...FEATURE_WHITELIST];
  const n = 3 + Math.floor(rng() * 3);
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
  return out.sort();
}

// A fresh, always-valid ML config (used when toggling ML on or repairing one). Picks
// any of the four model families; tree families get their optional knobs seeded.
function freshMl(rng) {
  const model = pick(['ridge', 'logistic', 'gbm', 'forest'], rng);
  const ml = { model, features: sampleFeatures(rng), horizon: pick([10, 21, 42], rng), lambda: 1, lookback: pick([252, 504, 756], rng), trainEveryBars: pick([42, 63, 126], rng), minTrain: 80 };
  if (model === 'gbm') { ml.rounds = pick([20, 40, 60], rng); ml.learnRate = pick([0.05, 0.1, 0.2], rng); }
  if (model === 'forest') { ml.trees = pick([16, 24, 40], rng); ml.depth = pick([2, 3, 4], rng); }
  return ml;
}

// A fresh, always-valid factor model: 2..4 distinct factor templates with random
// positive weights. Used when toggling a basket onto the multi-factor engine.
function freshFactors(rng) {
  const pool = FACTOR_TEMPLATES.map((f) => ({ name: f.name, expr: clone(f.expr) }));
  const n = 2 + Math.floor(rng() * 3); // 2..4
  const out = [];
  while (out.length < n && pool.length) {
    const f = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    out.push({ name: f.name, expr: f.expr, weight: +(0.5 + rng() * 1.5).toFixed(2) }); // 0.5..2.0
  }
  return out;
}

// Mutate a factor list: jitter weights, nudge exprs, occasionally add / drop a factor.
// Always returns a valid 1..6-factor list.
function mutateFactors(factors, rng) {
  const fs = factors.map((f) => ({ name: f.name, expr: clone(f.expr), weight: f.weight }));
  for (const f of fs) {
    if (rng() < 0.4) f.weight = +Math.max(0.1, Math.min(3, f.weight * (1 + (rng() * 0.6 - 0.3)))).toFixed(2);
    if (rng() < 0.3) f.expr = mutateExpr(f.expr, rng); // stays a valid expr (periods/literals only)
  }
  if (rng() < 0.2 && fs.length < 6) {
    const avail = FACTOR_TEMPLATES.filter((t) => !fs.some((f) => f.name === t.name));
    if (avail.length) { const t = pick(avail, rng); fs.push({ name: t.name, expr: clone(t.expr), weight: +(0.5 + rng() * 1.5).toFixed(2) }); }
  }
  if (rng() < 0.2 && fs.length > 1) fs.splice(Math.floor(rng() * fs.length), 1);
  return fs;
}

// Mutate (or add / drop) a basket's optional gate expression, staying valid.
function mutateGate(gate, rng) {
  if (gate === undefined) return rng() < 0.15 ? clone(pick(GATE_TEMPLATES, rng)) : undefined;
  if (rng() < 0.2) return undefined; // drop the gate
  if (rng() < 0.5) return mutateExpr(gate, rng); // nudge it
  return gate;
}

// Mutate (or toggle) a basket's ML config, keeping every field inside its
// validated range so validateSpec always passes. Can switch among all four model
// families (ridge/logistic/gbm/forest); knobs that don't apply to the chosen family
// are stripped (so a spec stays tidy and dedupes correctly), the ones that do are nudged.
function mutateMl(ml, rng) {
  if (ml === undefined) return rng() < 0.12 ? freshMl(rng) : undefined;
  if (rng() < 0.2) return undefined; // drop ML -> fall back to the rule rank
  const m = { ...ml, features: [...ml.features] };
  if (rng() < 0.3) m.model = pick(['ridge', 'logistic', 'gbm', 'forest'], rng);
  if (rng() < 0.3) m.lambda = +Math.max(1e-3, m.lambda * (1 + (rng() * 0.6 - 0.3))).toFixed(4);
  if (rng() < 0.3) m.horizon = clampInt(m.horizon + (rng() < 0.5 ? 5 : -5), 5, 63);
  if (rng() < 0.2) m.lookback = clampInt(m.lookback + (rng() < 0.5 ? 126 : -126), 126, 1512);
  if (rng() < 0.2) m.trainEveryBars = clampInt(m.trainEveryBars + (rng() < 0.5 ? 21 : -21), 21, 252);
  if (rng() < 0.3) { const avail = FEATURE_WHITELIST.filter((f) => !m.features.includes(f)); if (avail.length) m.features.push(pick(avail, rng)); }
  if (rng() < 0.3 && m.features.length > 2) m.features.splice(Math.floor(rng() * m.features.length), 1);
  m.features = [...new Set(m.features)].sort(); // dedupe + canonical order
  if (m.features.length < 2) m.features = sampleFeatures(rng);
  // Tree-family knobs: drop the ones that don't apply to the (possibly switched) model,
  // then mutate the relevant ones (seeding a default first if missing after a switch).
  if (m.model !== 'gbm') { delete m.rounds; delete m.learnRate; }
  if (m.model !== 'forest') { delete m.trees; delete m.depth; }
  if (m.model === 'gbm') {
    m.rounds = clampInt((m.rounds || 40) + (rng() < 0.5 ? 10 : -10), 5, 200);
    m.learnRate = +Math.max(0.01, Math.min(1, (m.learnRate || 0.1) * (1 + (rng() * 0.6 - 0.3)))).toFixed(3);
  } else if (m.model === 'forest') {
    m.trees = clampInt((m.trees || 24) + (rng() < 0.5 ? 8 : -8), 4, 200);
    m.depth = clampInt((m.depth || 3) + (rng() < 0.5 ? 1 : -1), 1, 6);
  }
  return m;
}

// Mutate a BASKET spec in place (clone already taken by mutateSpec). Every field
// is clamped so the result always passes validateBasket.
function mutateBasket(s, rng, eqSymbols) {
  s.rank = mutateExpr(s.rank, rng);
  if (rng() < 0.3) s.rebalanceBars = pick([5, 10, 21, 42, 63], rng);
  if (rng() < 0.3) s.weighting = pick(WEIGHTINGS, rng);
  // Optimiser knobs only matter for the meanvar/riskparity weightings: seed / keep them
  // valid when that weighting is active, and clear them otherwise so specs stay tidy.
  if (s.weighting === 'meanvar' || s.weighting === 'riskparity') {
    if (s.covLookback == null || rng() < 0.3) s.covLookback = pick([42, 63, 126, 252], rng);
    if (s.maxWeight == null || rng() < 0.3) s.maxWeight = pick([0.5, 0.75, 1], rng);
  } else { delete s.covLookback; delete s.maxWeight; }
  if (rng() < 0.2) s.gross = +Math.max(0.2, Math.min(1, (s.gross == null ? 1 : s.gross) + (rng() * 0.4 - 0.2))).toFixed(2);
  if (eqSymbols && eqSymbols.length) {
    const r = rng();
    if (r < 0.15 && s.universe.length > 2) s.universe.splice(Math.floor(rng() * s.universe.length), 1); // drop
    else if (r < 0.30 && s.universe.length < Math.min(MAX_BASKET_UNIVERSE, eqSymbols.length)) {
      const avail = eqSymbols.filter((x) => !s.universe.includes(x));
      if (avail.length) s.universe.push(pick(avail, rng)); // add
    } else if (r < 0.45) {
      const avail = eqSymbols.filter((x) => !s.universe.includes(x));
      if (avail.length) s.universe[Math.floor(rng() * s.universe.length)] = pick(avail, rng); // swap
    }
  }
  if (rng() < 0.4) s.k += rng() < 0.5 ? 1 : -1;
  s.k = clampInt(s.k, 1, s.universe.length); // re-clamp AFTER any universe edit
  const g = mutateGate(s.gate, rng); if (g === undefined) delete s.gate; else s.gate = g;
  const mg = mutateGate(s.marketGate, rng); if (mg === undefined) delete s.marketGate; else s.marketGate = mg;
  // --- scoring engine: rule rank | factor model | ML model, kept MUTUALLY EXCLUSIVE
  // (`s.rank` is always present — the tie-break + cold/edge fallback — and was nudged above).
  if (s.mlConfig) {
    const ml = mutateMl(s.mlConfig, rng);
    if (ml === undefined) delete s.mlConfig; else s.mlConfig = ml; // dropped -> plain rule
  } else if (Array.isArray(s.factors)) {
    if (rng() < 0.15) delete s.factors; // drop the factor model -> plain rule
    else s.factors = mutateFactors(s.factors, rng);
  } else {
    // plain-rule basket: a small chance to ADOPT a factor model OR an ML model.
    const r = rng();
    if (r < 0.10) s.factors = freshFactors(rng);
    else if (r < 0.20) s.mlConfig = freshMl(rng);
  }
  return s;
}

// Mutate a PAIRS spec in place (clone already taken). Every field is clamped so the
// result always passes validatePairs (entryZ in (0,6], exitZ in [0,entryZ), optional
// stopZ in (entryZ,12], maxPairs 1..floor(universe/2), etc.).
function mutatePairs(s, rng, eqSymbols) {
  if (rng() < 0.3) s.lookback = pick([30, 45, 60, 90, 120], rng);
  if (rng() < 0.3) s.entryZ = +Math.max(1, Math.min(4, s.entryZ + (rng() < 0.5 ? 0.25 : -0.25))).toFixed(2);
  if (rng() < 0.3) s.exitZ = +Math.max(0, s.exitZ + (rng() < 0.5 ? 0.1 : -0.1)).toFixed(2);
  if (rng() < 0.2) s.stopZ = +Math.min(10, (s.stopZ == null ? 4 : s.stopZ) + (rng() < 0.5 ? 0.5 : -0.5)).toFixed(2);
  if (rng() < 0.3) s.formationBars = pick([10, 21, 42, 63], rng);
  if (rng() < 0.3) s.minCorr = +Math.max(0, Math.min(0.95, (s.minCorr == null ? 0.6 : s.minCorr) + (rng() < 0.5 ? 0.05 : -0.05))).toFixed(2);
  if (rng() < 0.2) s.gross = +Math.max(0.3, Math.min(1, (s.gross == null ? 0.9 : s.gross) + (rng() * 0.2 - 0.1))).toFixed(2);
  // universe add / swap / drop from the (index-free) stock pool
  if (eqSymbols && eqSymbols.length) {
    const r = rng();
    if (r < 0.15 && s.universe.length > 4) s.universe.splice(Math.floor(rng() * s.universe.length), 1);
    else if (r < 0.30 && s.universe.length < Math.min(MAX_BASKET_UNIVERSE, eqSymbols.length)) {
      const avail = eqSymbols.filter((x) => !s.universe.includes(x));
      if (avail.length) s.universe.push(pick(avail, rng));
    } else if (r < 0.45) {
      const avail = eqSymbols.filter((x) => !s.universe.includes(x));
      if (avail.length) s.universe[Math.floor(rng() * s.universe.length)] = pick(avail, rng);
    }
  }
  if (rng() < 0.3) s.maxPairs += rng() < 0.5 ? 1 : -1;
  // Final normalisation so every constraint holds regardless of edit order.
  s.entryZ = +Math.max(0.5, Math.min(6, s.entryZ)).toFixed(2);
  s.exitZ = +Math.max(0, Math.min(s.entryZ - 0.05, s.exitZ)).toFixed(2);
  if (s.stopZ != null) s.stopZ = +Math.max(s.entryZ + 0.25, Math.min(12, s.stopZ)).toFixed(2);
  s.maxPairs = clampInt(s.maxPairs, 1, Math.floor(s.universe.length / 2));
  return s;
}

// Mutate a whole spec (equity expressions, F&O legs, or a BASKET's selection
// rule / universe / ML config). `eqSymbols` (optional) is the symbol pool a
// basket may add/swap names from.
function mutateSpec(spec, rng, eqSymbols = []) {
  const s = clone(spec);
  if (s.kind === 'EQ') {
    if (s.entry !== undefined) s.entry = mutateExpr(s.entry, rng);
    if (s.exit !== undefined) s.exit = mutateExpr(s.exit, rng);
    if (s.weight !== undefined) s.weight = mutateExpr(s.weight, rng);
  } else if (s.kind === 'BASKET') {
    return mutateBasket(s, rng, eqSymbols);
  } else if (s.kind === 'PAIRS') {
    return mutatePairs(s, rng, eqSymbols);
  } else if (s.kind === 'FNO' && Array.isArray(s.legs)) {
    s.legs = s.legs.map((l) => {
      const leg = { ...l };
      if (rng() < 0.5) leg.strikePct = +Math.max(0.5, Math.min(2, leg.strikePct + (rng() * 0.06 - 0.03))).toFixed(3);
      if (rng() < 0.3) leg.lots = clampInt((leg.lots || 1) + (rng() < 0.5 ? 1 : -1), 1, 10);
      if (rng() < 0.08) leg.side = leg.side === 'SELL' ? 'BUY' : 'SELL';
      return leg;
    });
    if (rng() < 0.15 && s.legs.length > 1) s.legs.splice(Math.floor(rng() * s.legs.length), 1); // drop a leg
  }
  return s;
}

// Cross two specs of the same kind: mix equity conditions, pool F&O legs, or
// blend two baskets (union the universes, average the knobs, inherit a rank/ML).
function crossover(a, b, rng) {
  if (a.kind !== b.kind) return null;
  if (a.kind === 'BASKET') {
    const universe = [...new Set([...a.universe, ...b.universe])].slice(0, MAX_BASKET_UNIVERSE);
    const child = {
      kind: 'BASKET', name: 'crossover', universe,
      rank: clone(rng() < 0.5 ? a.rank : b.rank),
      k: clampInt(Math.round((a.k + b.k) / 2), 1, universe.length),
      weighting: rng() < 0.5 ? (a.weighting || 'equal') : (b.weighting || 'equal'),
      rebalanceBars: clampInt(Math.round((a.rebalanceBars + b.rebalanceBars) / 2), 5, 63),
    };
    const gross = rng() < 0.5 ? a.gross : b.gross; if (gross != null) child.gross = gross;
    const gate = rng() < 0.5 ? a.gate : b.gate; if (gate !== undefined) child.gate = clone(gate);
    const mg = rng() < 0.5 ? a.marketGate : b.marketGate; if (mg !== undefined) child.marketGate = clone(mg);
    // Optimiser knobs (only meaningful for the meanvar/riskparity weightings).
    const cl = rng() < 0.5 ? a.covLookback : b.covLookback; if (cl != null) child.covLookback = cl;
    const mw = rng() < 0.5 ? a.maxWeight : b.maxWeight; if (mw != null) child.maxWeight = mw;
    // Scoring engine (XOR): inherit AT MOST ONE of the parents' factor / ML models, so
    // the child is never both factor- and ML-driven.
    const engines = [];
    if (a.mlConfig) engines.push({ ml: a.mlConfig });
    if (b.mlConfig) engines.push({ ml: b.mlConfig });
    if (Array.isArray(a.factors) && a.factors.length) engines.push({ factors: a.factors });
    if (Array.isArray(b.factors) && b.factors.length) engines.push({ factors: b.factors });
    if (engines.length) {
      const e = engines[Math.floor(rng() * engines.length)];
      if (e.ml) {
        const features = [...new Set(e.ml.features)].sort().slice(0, FEATURE_WHITELIST.length); // canonical order
        if (features.length >= 2) child.mlConfig = { ...e.ml, features };
      } else {
        child.factors = clone(e.factors);
      }
    }
    return child;
  }
  if (a.kind === 'PAIRS') {
    const universe = [...new Set([...a.universe, ...b.universe])].slice(0, MAX_BASKET_UNIVERSE);
    const entryZ = +(((a.entryZ + b.entryZ) / 2)).toFixed(2);
    const child = {
      kind: 'PAIRS', name: 'crossover', universe,
      lookback: clampInt(Math.round((a.lookback + b.lookback) / 2), 20, 400),
      entryZ,
      exitZ: +Math.max(0, Math.min(entryZ - 0.05, (a.exitZ + b.exitZ) / 2)).toFixed(2),
      maxPairs: clampInt(Math.round((a.maxPairs + b.maxPairs) / 2), 1, Math.floor(universe.length / 2)),
      formationBars: clampInt(Math.round((a.formationBars + b.formationBars) / 2), 5, 252),
    };
    const stopZ = rng() < 0.5 ? a.stopZ : b.stopZ; if (stopZ != null) child.stopZ = +Math.max(entryZ + 0.25, Math.min(12, stopZ)).toFixed(2);
    const minCorr = rng() < 0.5 ? a.minCorr : b.minCorr; if (minCorr != null) child.minCorr = minCorr;
    const gross = rng() < 0.5 ? a.gross : b.gross; if (gross != null) child.gross = gross;
    return child;
  }
  if (a.kind === 'EQ') {
    const child = { kind: 'EQ', name: 'crossover' };
    // For each field, inherit from whichever parent HAS it (random when both do),
    // so a child of e.g. an entry-only × a weight-only parent always keeps the
    // union's entry/weight and stays valid (instead of an empty, rejected child).
    const fieldFrom = (field) => {
      const opts = [a[field], b[field]].filter((v) => v !== undefined);
      return opts.length ? opts[Math.floor(rng() * opts.length)] : undefined;
    };
    const e = fieldFrom('entry');
    const x = fieldFrom('exit');
    const w = fieldFrom('weight');
    if (e !== undefined) child.entry = clone(e);
    if (x !== undefined) child.exit = clone(x);
    if (w !== undefined) child.weight = clone(w);
    // Direction (bullish/BEARISH). Only decide when a parent actually expresses a side — so an
    // all-long crossover draws NO rng (byte-identical to before, keeps the determinism tests).
    // When a side IS present, coin-flip treating an ABSENT side as the default 'long', so a
    // long×short cross is a 50/50 long-or-short child. (The earlier fieldFrom('side') filtered
    // out the undefined long side, which forced EVERY long×short to a short and carried the long
    // parent's bullish rule into a short bot — a semantic inversion + a short-biased population.)
    if (a.side !== undefined || b.side !== undefined) {
      const sd = rng() < 0.5 ? (a.side || 'long') : (b.side || 'long');
      if (sd === 'short') child.side = 'short';
    }
    return child;
  }
  // Guard missing legs (a malformed FNO spec) — an empty-legs child is then rejected
  // by validateSpec downstream, never run.
  const legs = [...clone(a.legs || []), ...clone(b.legs || [])].slice(0, 6);
  return { kind: 'FNO', name: 'crossover', legs };
}

// A cosmetic label for a universe-spanning bot (its identity is its universe, not a
// symbol). PAIRS is labelled by pair count; BASKET by how many names it scans.
const basketLabel = (spec) => (spec.kind === 'PAIRS' ? `${spec.maxPairs} pairs` : `${spec.universe.length} stocks`);

// Wrap an EQ idea as a multi-company BASKET, so baskets/ML stay reachable even
// from an all-equity roster (the "let the bots explore" bridge). The EQ entry
// becomes a per-name eligibility gate when it is boolean-valued.
function spawnBasketFromEq(eqSpec, rng, eqSymbols) {
  const pool = [...new Set(eqSymbols)];
  const universe = pool.slice(0, Math.min(12, pool.length));
  if (universe.length < 2) return null;
  const child = {
    kind: 'BASKET', name: 'basket', universe,
    rank: ['mom', pick([63, 126, 252], rng)],
    k: clampInt(2 + Math.floor(rng() * 3), 1, universe.length),
    weighting: pick(WEIGHTINGS, rng),
    rebalanceBars: pick([21, 42, 63], rng),
  };
  if (Array.isArray(eqSpec.entry) && BOOL_OPS.has(eqSpec.entry[0])) child.gate = clone(eqSpec.entry);
  // A chance to adopt a scoring engine (XOR): a factor model OR an ML model. Most
  // spawned baskets stay plain-rule.
  const r = rng();
  if (r < 0.25) child.mlConfig = freshMl(rng);
  else if (r < 0.45) child.factors = freshFactors(rng);
  return child;
}

// Breed up to `n` valid challenger specs from a roster of parents. EQ/FNO
// challengers HUNT across `eqSymbols`/`fnoSymbols` (indices allowed — an EQ bot
// can "buy the index"); BASKET challengers pick their companies from
// `basketSymbols` — an INDEX-FREE pool, since a basket holds individual stocks,
// not the index it would otherwise overlap the benchmark with. (Defaults to
// eqSymbols for back-compat with callers that don't pass a basket pool.)
function generateChallengers(roster, n, rng, { eqSymbols = ['NIFTY'], fnoSymbols = ['NIFTY'], basketSymbols = eqSymbols } = {}) {
  const out = [];
  let attempts = 0;
  while (out.length < n && attempts < n * 12) {
    attempts++;
    const parent = pick(roster, rng);
    let child;
    if (parent.kind === 'EQ' && basketSymbols.length >= 2 && rng() < 0.18) {
      child = spawnBasketFromEq(parent.spec, rng, basketSymbols); // EQ -> BASKET bridge
    } else if (rng() < 0.3) {
      const mates = roster.filter((r) => r.kind === parent.kind);
      child = crossover(parent.spec, pick(mates, rng).spec, rng);
      if (child) child = mutateSpec(child, rng, basketSymbols);
    } else {
      child = mutateSpec(parent.spec, rng, basketSymbols);
    }
    if (!child) continue;

    let symbol;
    if (child.kind === 'BASKET' || child.kind === 'PAIRS') {
      symbol = basketLabel(child);
    } else {
      // 40% of the time, run the strategy on a DIFFERENT symbol from the kind-
      // appropriate pool (F&O only on index symbols); else keep the parent's.
      const symPool = child.kind === 'FNO' ? fnoSymbols : eqSymbols;
      symbol = parent.symbol || symPool[0];
      if (symPool.length && rng() < 0.4) symbol = symPool[Math.floor(rng() * symPool.length)];
      if (child.kind === 'FNO' && !fnoSymbols.includes(symbol)) symbol = fnoSymbols[0] || 'NIFTY';
    }
    const base = String(parent.name || 'bot').replace(/ v\d+$/, '');
    child.name = `${base} v${clampInt(rng() * 899 + 100, 100, 999)}`;
    child.note = `evolved from ${parent.name}`;
    if (validateSpec(child) === null) {
      out.push({ kind: child.kind, symbol, spec: child, parent: parent.id || parent.name });
    }
  }
  return out;
}

// Backtest one spec over a series; returns its fitness numbers (or null).
// `cash` MUST match the capital the tournament actually deploys with, because F&O
// lot counts (and thus risk/margin) scale with capital — scoring at a different
// size than you deploy would optimize a different book than it runs.
// Backtest one spec and return its fitness numbers (or null). A BASKET is scored
// by the PORTFOLIO backtester across its whole universe — pass `dataBySymbol`
// (the optional 5th arg) so it can see every constituent; the legacy 4-arg
// EQ/FNO callers are unchanged.
function scoreSpec(spec, series, symbol = 'NIFTY', cash = 1_000_000, dataBySymbol = null) {
  const c = safeCompile(spec);
  if (!c.ok) return null;
  if (c.kind === 'BASKET') {
    const dbs = dataBySymbol || (series ? { [symbol]: series } : null);
    if (!dbs) return null;
    const present = spec.universe.filter((s) => Array.isArray(dbs[s]) && dbs[s].length);
    if (present.length < 2) return null; // not enough constituents have data
    const rankSource = spec.mlConfig ? makeRankSource({ spec, dataBySymbol: dbs }) : null;
    const res = runPortfolioBacktest({ spec, dataBySymbol: dbs, marketSeries: dbs.NIFTY || null, cash, costModel: EQ_COSTS, rankSource });
    return { totalReturnPct: res.metrics.totalReturnPct, sharpe: res.metrics.sharpe, maxDrawdownPct: res.metrics.maxDrawdownPct };
  }
  if (c.kind === 'PAIRS') {
    const dbs = dataBySymbol || (series ? { [symbol]: series } : null);
    if (!dbs) return null;
    const present = spec.universe.filter((s) => Array.isArray(dbs[s]) && dbs[s].length);
    if (present.length < 4) return null; // not enough constituents to form pairs
    const res = runPairsBacktest({ spec, dataBySymbol: dbs, cash, costModel: EQ_COSTS });
    return { totalReturnPct: res.metrics.totalReturnPct, sharpe: res.metrics.sharpe, maxDrawdownPct: res.metrics.maxDrawdownPct };
  }
  const res =
    c.kind === 'FNO'
      ? runFnoBacktest({ strategy: c.strategy, candles: series, symbol, cash, costModel: OPT_COSTS, ...(INDEX_SPECS[symbol] || INDEX_SPECS.NIFTY) })
      : runBacktest({ strategy: c.strategy, candles: series, symbol, cash, costModel: EQ_COSTS });
  return { totalReturnPct: res.metrics.totalReturnPct, sharpe: res.metrics.sharpe, maxDrawdownPct: res.metrics.maxDrawdownPct };
}

// Fitness = Sharpe first (risk-adjusted), then total return as a tiebreak.
const fitness = (s) => (s ? s.sharpe * 1000 + s.totalReturnPct : -Infinity);

// A coarse "archetype" tag for a spec, used by fitness sharing to keep the roster
// diverse (so it doesn't collapse onto one winning idea).
function archetypeOf(spec) {
  if (!spec) return 'other';
  if (spec.kind === 'FNO') return 'fno';
  if (spec.kind === 'PAIRS') return 'pairs';
  if (spec.kind === 'EQ') return spec.entry === undefined && spec.weight !== undefined ? 'benchmark' : 'eq';
  if (spec.mlConfig) return 'ml-' + spec.mlConfig.model; // ml-ridge / ml-logistic / ml-gbm / ml-forest
  if (spec.factors) return 'factor';
  const op = Array.isArray(spec.rank) ? spec.rank[0] : 'rank';
  if (op === 'mom' || op === 'macd' || op === 'slope') return 'momentum';
  if (op === 'vol' || op === 'volratio' || op === '*' || op === '/') return 'lowvol';
  if (op === 'distHigh' || op === 'high') return 'breakout';
  if (op === 'rsi' || op === 'zscore') return 'meanrev';
  return 'basket';
}

// Diversity pressure: divide each challenger's raw fitness by how crowded its
// archetype is above it, then re-rank. This is a PURE function of the already-
// scored set, and a STRICT NO-OP when no baskets are present — so an EQ/FNO-only
// evolve keeps its exact sorted-by-raw-fitness order (no test is weakened).
function shareFitness(scored) {
  // Diversity pressure applies to the universe-spanning kinds (BASKET + PAIRS), which
  // have many archetypes that can crowd. A strict NO-OP for an EQ/FNO-only set (so those
  // determinism tests keep their exact raw-fitness order), and now also fires for an
  // all-PAIRS challenger set (so a pairs-heavy board still gets crowding penalties).
  if (!scored.some((c) => c.kind === 'BASKET' || c.kind === 'PAIRS')) return scored;
  const tagged = scored.map((c) => ({ c, arch: archetypeOf(c.spec), raw: fitness(c.score) }));
  return tagged
    .map((t) => ({ c: t.c, sh: t.raw / (1 + 0.5 * tagged.filter((o) => o.arch === t.arch && o.raw > t.raw).length) }))
    .sort((a, b) => b.sh - a.sh)
    .map((x) => x.c);
}

// Breed + score a generation of challengers, ranked best-first. `dataBySymbol`
// maps each symbol to its candle series; EQ/FNO challengers are scored on their
// own symbol, BASKETs across their whole universe — so the GA hunts the best
// (strategy × stock) AND (basket × ML) combinations.
function evolve({ roster, dataBySymbol, eqSymbols, fnoSymbols, basketSymbols, n = 14, seed = 1, cash = 1_000_000 }) {
  const rng = mulberry32(seed >>> 0);
  const challengers = generateChallengers(roster, n, rng, { eqSymbols, fnoSymbols, basketSymbols })
    .map((ch) => {
      const score = (ch.kind === 'BASKET' || ch.kind === 'PAIRS')
        ? scoreSpec(ch.spec, null, ch.symbol, cash, dataBySymbol)
        : (dataBySymbol && dataBySymbol[ch.symbol] ? scoreSpec(ch.spec, dataBySymbol[ch.symbol], ch.symbol, cash) : null);
      return { ...ch, score };
    })
    .filter((ch) => ch.score)
    .sort((a, b) => fitness(b.score) - fitness(a.score));
  return shareFitness(challengers);
}

export { mutateSpec, mutateExpr, mutatePairs, crossover, generateChallengers, scoreSpec, evolve, fitness, archetypeOf, shareFitness, mulberry32, freshFactors, mutateFactors, freshMl };
