// ---------------------------------------------------------------------------
// backtest/dsl.mjs
// A tiny, SAFE strategy DSL. Strategies are JSON SPECS (pure data, never code),
// so hundreds of them can be generated programmatically with ZERO code-execution risk. The
// interpreter turns a spec into a strategy the backtester already understands
// (equity: { name, note, make }; F&O: { name, note, entry }).
//
// EQUITY expression nodes — evaluated at bar i over the close series. A number is
// a literal; an array is [op, ...args]:
//   indicators: ["price"] ["sma",n] ["ema",n] ["rsi",n] ["mom",n] ["high",n]
//               ["low",n] ["vol",n]
//   math:       ["+",a,b] ["-",a,b] ["*",a,b] ["/",a,b] ["min",a,b] ["max",a,b]
//               ["clamp",x,lo,hi]
//   compare:    [">",a,b] ["<",a,b] [">=",a,b] ["<=",a,b]
//   logic:      ["and",...] ["or",...] ["not",a]
// Indicators return null until they have enough history; a null bubbles up so a
// condition reads as false (the strategy stays flat) until the indicator warms up.
//
// EQUITY spec:  { kind:"EQ", name, note, entry?, exit?, weight? }
//   in-position when `entry` is true; out when `exit` (or, if no exit, when entry
//   stops being true). `weight` (0..1, default 1) is the exposure while in.
// F&O spec:     { kind:"FNO", name, note, legs:[{type,side,strikePct,lots?}] }
//   strikePct is relative to spot (1.0 = ATM, 1.04 = 4% OTM call, 0.96 = OTM put).
// ---------------------------------------------------------------------------

import { sma, rsi, highest, lowest, retStdev } from './strategies.mjs';

function ema(closes, end, n) {
  if (end + 1 < n) return null;
  const k = 2 / (n + 1);
  let e = closes[end - n + 1];
  for (let j = end - n + 2; j <= end; j++) e = closes[j] * k + e * (1 - k);
  return e;
}

function mom(closes, end, n) {
  if (end - n < 0 || !(closes[end - n] > 0)) return null;
  return closes[end] / closes[end - n] - 1;
}

// --- richer indicators (added for the multi-company basket strategies) -------
// All read closes[0..end] ONLY (no look-ahead) and return null until they have
// enough history, exactly like the helpers above. They give evolution a bigger,
// more expressive search space (momentum quality, trend slope, vol regime, …).

// MACD histogram = (fast EMA − slow EMA) − a signal EMA of that MACD line.
// A positive, rising histogram = strengthening up-trend. Needs f < s.
function macdHist(closes, end, f, s, sig) {
  if (!(f < s) || end + 1 < s + sig) return null;
  const k = 2 / (sig + 1);
  let signal = null; // EMA(sig) of the MACD line over the last `sig` bars
  for (let j = end - sig + 1; j <= end; j++) {
    const fast = ema(closes, j, f);
    const slow = ema(closes, j, s);
    if (fast == null || slow == null) return null;
    const line = fast - slow;
    signal = signal == null ? line : line * k + signal * (1 - k);
  }
  const fastNow = ema(closes, end, f), slowNow = ema(closes, end, s);
  if (fastNow == null || slowNow == null) return null;
  return fastNow - slowNow - signal;
}

// Average absolute daily move over n bars (a close-only proxy for ATR — we have
// no intraday high/low, so this measures typical day-to-day price travel).
function atrClose(closes, end, n) {
  if (end < n) return null;
  let s = 0;
  for (let k = end - n + 1; k <= end; k++) s += Math.abs(closes[k] - closes[k - 1]);
  return s / n;
}

// Standard deviation of the last n CLOSES (not returns) — used by zscore.
function closeStdev(closes, end, n) {
  if (end + 1 < n) return null;
  let m = 0;
  for (let k = end - n + 1; k <= end; k++) m += closes[k];
  m /= n;
  let v = 0;
  for (let k = end - n + 1; k <= end; k++) v += (closes[k] - m) ** 2;
  return Math.sqrt(v / n);
}

// Evaluate a DSL node at bar i. Returns number | boolean | null.
function evalNode(node, closes, i) {
  if (typeof node === 'number') return node;
  if (typeof node === 'boolean') return node;
  if (!Array.isArray(node) || node.length === 0) return null;
  const [op, ...a] = node;
  switch (op) {
    case 'price': return closes[i];
    case 'sma': return sma(closes, i, a[0]);
    case 'ema': return ema(closes, i, a[0]);
    case 'rsi': return rsi(closes, i, a[0] || 14);
    case 'mom': return mom(closes, i, a[0]);
    case 'high': return i >= 1 ? highest(closes, i - 1, a[0]) : null;
    case 'low': return i >= 1 ? lowest(closes, i - 1, a[0]) : null;
    case 'vol': return retStdev(closes, i, a[0]);
    case 'macd': return macdHist(closes, i, a[0], a[1], a[2]);
    case 'atr': return atrClose(closes, i, a[0]);
    case 'distHigh': { // how far below its own n-day high (≤ 0); needs a full window
      if (i + 1 < a[0]) return null;
      const hh = highest(closes, i, a[0]);
      return hh > 0 ? closes[i] / hh - 1 : null;
    }
    case 'slope': { // normalised slope of the n-day SMA (today's SMA vs yesterday's)
      const s0 = sma(closes, i, a[0]);
      const s1 = i >= 1 ? sma(closes, i - 1, a[0]) : null;
      return s0 != null && s1 != null && s1 !== 0 ? s0 / s1 - 1 : null;
    }
    case 'volratio': { // short-vol / long-vol: > 1 = vol expanding (needs a < b)
      const sa = retStdev(closes, i, a[0]), sb = retStdev(closes, i, a[1]);
      return sa != null && sb != null && sb > 0 ? sa / sb : null;
    }
    case 'zscore': { // how many close-stddevs price is from its n-day mean
      const m = sma(closes, i, a[0]), sd = closeStdev(closes, i, a[0]);
      return m != null && sd != null && sd > 0 ? (closes[i] - m) / sd : null;
    }
    case 'regime': { // 1 when price is above its n-day average, else 0
      const m = sma(closes, i, a[0]);
      return m == null ? null : closes[i] > m ? 1 : 0;
    }
    case '+': case '-': case '*': case '/': case 'min': case 'max': {
      const x = evalNode(a[0], closes, i), y = evalNode(a[1], closes, i);
      if (x == null || y == null) return null;
      if (op === '+') return x + y;
      if (op === '-') return x - y;
      if (op === '*') return x * y;
      if (op === '/') return y === 0 ? null : x / y;
      if (op === 'min') return Math.min(x, y);
      return Math.max(x, y);
    }
    case 'clamp': {
      const x = evalNode(a[0], closes, i), lo = evalNode(a[1], closes, i), hi = evalNode(a[2], closes, i);
      if (x == null || lo == null || hi == null) return null;
      return Math.max(lo, Math.min(hi, x));
    }
    case '>': case '<': case '>=': case '<=': {
      const x = evalNode(a[0], closes, i), y = evalNode(a[1], closes, i);
      if (x == null || y == null) return false; // unknown -> false (stay flat)
      if (op === '>') return x > y;
      if (op === '<') return x < y;
      if (op === '>=') return x >= y;
      return x <= y;
    }
    case 'and': return a.every((nd) => evalNode(nd, closes, i) === true);
    case 'or': return a.some((nd) => evalNode(nd, closes, i) === true);
    case 'not': return evalNode(a[0], closes, i) !== true;
    default: return null; // unknown op -> null (false in a condition)
  }
}

// --- validation: reject malformed specs so a bad spec is skipped, not run ---
// Single-period indicators take one integer 1..400. The richer ones added for
// baskets (slope/distHigh/zscore/atr/regime) follow the same one-int shape;
// macd (3 ints) and volratio (2 ints) get explicit arity checks below.
const PERIOD_OPS = new Set(['sma', 'ema', 'rsi', 'mom', 'high', 'low', 'vol', 'slope', 'distHigh', 'zscore', 'atr', 'regime']);
const BINARY_OPS = new Set(['+', '-', '*', '/', 'min', 'max', '>', '<', '>=', '<=']);
const isPeriod = (x) => Number.isInteger(x) && x >= 1 && x <= 400;

function validExpr(node, depth = 0) {
  if (depth > 12) return false; // guard against pathologically deep trees
  if (typeof node === 'number') return Number.isFinite(node); // reject NaN/Infinity literals
  if (typeof node === 'boolean') return true;
  if (!Array.isArray(node) || node.length === 0) return false;
  const [op, ...a] = node;
  if (op === 'price') return a.length === 0;
  if (op === 'macd') return a.length === 3 && a.every(isPeriod) && a[0] < a[1]; // fast < slow
  if (op === 'volratio') return a.length === 2 && a.every(isPeriod) && a[0] < a[1]; // short < long window
  if (PERIOD_OPS.has(op)) return Number.isInteger(a[0]) && a[0] >= 1 && a[0] <= 400;
  if (BINARY_OPS.has(op)) return a.length === 2 && validExpr(a[0], depth + 1) && validExpr(a[1], depth + 1);
  if (op === 'clamp') return a.length === 3 && a.every((x) => validExpr(x, depth + 1));
  if (op === 'and' || op === 'or') return a.length >= 1 && a.every((x) => validExpr(x, depth + 1));
  if (op === 'not') return a.length === 1 && validExpr(a[0], depth + 1);
  return false;
}

// The ML feature names a BASKET's mlConfig may select from. Shared with ml.mjs
// (which maps each name to a DSL expression) so the whitelist has ONE home.
const FEATURE_WHITELIST = ['mom21', 'mom63', 'mom126', 'rsi14', 'distHigh', 'volratio', 'smaSlope', 'zscore50'];
// equal/rankw/volinv use only each name's own vol; meanvar/riskparity are the
// optimiser weightings (backtest/optimizer.mjs) that use the names' covariance.
const WEIGHTINGS = new Set(['equal', 'rankw', 'volinv', 'meanvar', 'riskparity']);
const ML_MODELS = new Set(['ridge', 'logistic', 'gbm', 'forest']);
// Boolean-VALUED ops — valid as a gate (per-name eligibility) but NOT as a factor expr:
// the multi-factor composite needs finite NUMBERS to z-score, and a boolean isn't finite
// (it would silently drop every name -> a basket that holds nothing forever).
const BOOL_VALUED_OPS = new Set(['>', '<', '>=', '<=', 'and', 'or', 'not']);
// The most names a single BASKET may hold/scan. Raised 16 → 30 → 240 so a basket can hunt
// across the WIDE (~200-name) universe each rebalance, for broader stock coverage.
// Set comfortably above the universe size so a basket may scan the whole field;
// a cheap prefilter (see portfolio.mjs) bounds the heavy per-rebalance work if needed.
// Shared with evolve.mjs so the GA's universe add/swap caps stay in lock-step.
const MAX_BASKET_UNIVERSE = 240;

// A BASKET strategy: each rebalance, score every name in `universe` by `rank`
// (an expression evaluated on that stock's own closes; higher = more attractive),
// optionally trained/overridden by a local ML model (mlConfig), gate out names
// that fail `gate`, optionally sit in cash when `marketGate` says risk-off, then
// hold the top `k` names by `weighting`, rebalanced every `rebalanceBars` bars.
function validateBasket(spec) {
  const u = spec.universe;
  if (!Array.isArray(u) || u.length < 2 || u.length > MAX_BASKET_UNIVERSE) return `basket.universe must list 2..${MAX_BASKET_UNIVERSE} symbols`;
  if (u.some((s) => typeof s !== 'string' || !s.trim())) return 'basket.universe symbols must be non-empty strings';
  if (new Set(u.map((s) => s.toUpperCase())).size !== u.length) return 'basket.universe has duplicates';
  if (spec.rank === undefined || !validExpr(spec.rank)) return 'basket.rank must be a valid expression';
  // `rank` must evaluate to a NUMBER: portfolio.mjs drops every name whose score is
  // non-finite (Number.isFinite(true) === false), so a boolean/comparison-rooted rank
  // would silently hold the whole basket in cash forever. Same guard the factors below apply.
  if (typeof spec.rank === 'boolean' || (Array.isArray(spec.rank) && BOOL_VALUED_OPS.has(spec.rank[0]))) return 'basket.rank must be numeric-valued (not a boolean/comparison)';
  if (!Number.isInteger(spec.k) || spec.k < 1 || spec.k > u.length) return 'basket.k must be 1..universe.length';
  if (!WEIGHTINGS.has(spec.weighting === undefined ? 'equal' : spec.weighting)) return 'basket.weighting must be equal/rankw/volinv/meanvar/riskparity';
  if (!Number.isInteger(spec.rebalanceBars) || spec.rebalanceBars < 5 || spec.rebalanceBars > 63) return 'basket.rebalanceBars must be 5..63';
  if (spec.gross !== undefined && !(Number.isFinite(spec.gross) && spec.gross > 0 && spec.gross <= 1)) return 'basket.gross must be in (0,1]';
  if (spec.gate !== undefined && !validExpr(spec.gate)) return 'basket.gate must be a valid expression';
  if (spec.marketGate !== undefined && !validExpr(spec.marketGate)) return 'basket.marketGate must be a valid expression';
  // A FACTOR model (optional) replaces the single `rank` score with a weighted
  // composite of cross-sectionally z-scored factors (backtest/factors.mjs). It is
  // MUTUALLY EXCLUSIVE with mlConfig — a basket is rule-driven, OR factor-driven, OR
  // ML-driven, never two scoring engines at once. `rank` stays required either way
  // (it is the tie-break + the plain-English description + the cold/edge fallback).
  if (spec.factors !== undefined) {
    if (spec.mlConfig !== undefined) return 'a basket cannot use both factors and mlConfig';
    const fs = spec.factors;
    if (!Array.isArray(fs) || fs.length < 1 || fs.length > 6) return 'basket.factors must list 1..6 factors';
    for (const f of fs) {
      if (!f || typeof f !== 'object') return 'each factor must be an object';
      if (typeof f.name !== 'string' || !f.name.trim() || f.name.length > 40) return 'each factor needs a short name';
      if (!validExpr(f.expr)) return 'each factor needs a valid expr';
      // A factor must evaluate to a NUMBER, not a boolean — a comparison/logic-rooted expr
      // would z-score to nothing and silently null the whole basket.
      if (typeof f.expr === 'boolean' || (Array.isArray(f.expr) && BOOL_VALUED_OPS.has(f.expr[0]))) return 'each factor expr must be numeric-valued (not a boolean/comparison)';
      if (!Number.isFinite(f.weight)) return 'each factor weight must be a finite number';
    }
  }
  // Optimiser knobs (used by the meanvar/riskparity weightings; harmless otherwise).
  if (spec.covLookback !== undefined && !(Number.isInteger(spec.covLookback) && spec.covLookback >= 20 && spec.covLookback <= 504)) return 'basket.covLookback must be 20..504';
  if (spec.maxWeight !== undefined && !(Number.isFinite(spec.maxWeight) && spec.maxWeight > 0 && spec.maxWeight <= 1)) return 'basket.maxWeight must be in (0,1]';
  // Risk-overlay knobs (research; all optional — absent means the legacy behaviour,
  // byte-identical). `dailyGate` reads the marketGate EVERY bar instead of only at
  // rebalance bars (so a crash building BETWEEN rebalances is exited in days, not weeks);
  // it is meaningless without a marketGate, so the pair is required together.
  // `gateConfirmBars` is the whipsaw buffer: a gate flip only takes effect after that many
  // CONSECUTIVE bars agree. `volTarget`/`volLookback` scale gross exposure at decision bars
  // by min(1, volTarget / realized annualized market vol) — de-risk only, never leverage.
  if (spec.dailyGate !== undefined) {
    if (typeof spec.dailyGate !== 'boolean') return 'basket.dailyGate must be a boolean';
    if (spec.dailyGate && spec.marketGate === undefined) return 'basket.dailyGate requires basket.marketGate';
  }
  if (spec.gateConfirmBars !== undefined && !(Number.isInteger(spec.gateConfirmBars) && spec.gateConfirmBars >= 1 && spec.gateConfirmBars <= 10)) return 'basket.gateConfirmBars must be 1..10';
  if (spec.volTarget !== undefined && !(Number.isFinite(spec.volTarget) && spec.volTarget > 0 && spec.volTarget < 1)) return 'basket.volTarget must be in (0,1)';
  if (spec.volLookback !== undefined && !(Number.isInteger(spec.volLookback) && spec.volLookback >= 20 && spec.volLookback <= 252)) return 'basket.volLookback must be 20..252';
  if (spec.mlConfig !== undefined) {
    const m = spec.mlConfig;
    if (!m || typeof m !== 'object') return 'basket.mlConfig must be an object';
    if (!ML_MODELS.has(m.model)) return 'mlConfig.model must be ridge/logistic/gbm/forest';
    if (!Array.isArray(m.features) || m.features.length < 2) return 'mlConfig.features needs >= 2 features';
    if (m.features.some((f) => !FEATURE_WHITELIST.includes(f))) return 'mlConfig.features has an unknown feature';
    if (new Set(m.features).size !== m.features.length) return 'mlConfig.features has duplicates';
    if (!Number.isInteger(m.horizon) || m.horizon < 5 || m.horizon > 63) return 'mlConfig.horizon must be 5..63';
    // lambda > 0 (a strictly positive ridge penalty) guarantees the normal-matrix
    // is invertible — a 0 penalty on collinear features would blow up to NaN. (Used
    // by ridge/logistic; tree families ignore it, but a valid value is still required.)
    if (!(Number.isFinite(m.lambda) && m.lambda >= 1e-3)) return 'mlConfig.lambda must be >= 1e-3';
    if (!Number.isInteger(m.lookback) || m.lookback < 126) return 'mlConfig.lookback must be >= 126';
    if (!Number.isInteger(m.trainEveryBars) || m.trainEveryBars < 21 || m.trainEveryBars > 252) return 'mlConfig.trainEveryBars must be 21..252';
    if (!Number.isInteger(m.minTrain) || m.minTrain < 40 || m.minTrain > 1000) return 'mlConfig.minTrain must be 40..1000';
    // Optional tree-family knobs (gbm: rounds/learnRate; forest: trees/depth). Defaults
    // live in ml.mjs, so a minimal gbm/forest config needs none of these — but if a
    // spec (or evolution) sets one it must be in range.
    if (m.rounds !== undefined && !(Number.isInteger(m.rounds) && m.rounds >= 5 && m.rounds <= 200)) return 'mlConfig.rounds must be 5..200';
    if (m.learnRate !== undefined && !(Number.isFinite(m.learnRate) && m.learnRate > 0 && m.learnRate <= 1)) return 'mlConfig.learnRate must be in (0,1]';
    if (m.trees !== undefined && !(Number.isInteger(m.trees) && m.trees >= 4 && m.trees <= 200)) return 'mlConfig.trees must be 4..200';
    if (m.depth !== undefined && !(Number.isInteger(m.depth) && m.depth >= 1 && m.depth <= 6)) return 'mlConfig.depth must be 1..6';
  }
  return null;
}

// A PAIRS strategy (stat-arb): pick co-moving, mean-reverting pairs from `universe`
// and trade their spread market-neutrally (long the cheap leg, short the rich one)
// when the spread's z-score stretches past `entryZ`, exiting near `exitZ`. Run by
// backtest/pairs.mjs. See its header for the full algorithm + the look-ahead proof.
function validatePairs(spec) {
  const u = spec.universe;
  // Need ≥ 4 names so pair SELECTION (correlation + cointegration screening) is
  // meaningful, not just a single forced pair. Capped at the same basket limit.
  if (!Array.isArray(u) || u.length < 4 || u.length > MAX_BASKET_UNIVERSE) return `pairs.universe must list 4..${MAX_BASKET_UNIVERSE} symbols`;
  if (u.some((s) => typeof s !== 'string' || !s.trim())) return 'pairs.universe symbols must be non-empty strings';
  if (new Set(u.map((s) => s.toUpperCase())).size !== u.length) return 'pairs.universe has duplicates';
  if (!Number.isInteger(spec.lookback) || spec.lookback < 20 || spec.lookback > 400) return 'pairs.lookback must be 20..400';
  if (!(Number.isFinite(spec.entryZ) && spec.entryZ > 0 && spec.entryZ <= 6)) return 'pairs.entryZ must be in (0,6]';
  if (!(Number.isFinite(spec.exitZ) && spec.exitZ >= 0 && spec.exitZ < spec.entryZ)) return 'pairs.exitZ must be in [0, entryZ)';
  if (spec.stopZ !== undefined && !(Number.isFinite(spec.stopZ) && spec.stopZ > spec.entryZ && spec.stopZ <= 12)) return 'pairs.stopZ must be in (entryZ, 12]';
  if (!Number.isInteger(spec.maxPairs) || spec.maxPairs < 1 || spec.maxPairs > Math.floor(u.length / 2)) return 'pairs.maxPairs must be 1..floor(universe/2)';
  if (!Number.isInteger(spec.formationBars) || spec.formationBars < 5 || spec.formationBars > 252) return 'pairs.formationBars must be 5..252';
  if (spec.minCorr !== undefined && !(Number.isFinite(spec.minCorr) && spec.minCorr >= 0 && spec.minCorr < 1)) return 'pairs.minCorr must be in [0,1)';
  if (spec.gross !== undefined && !(Number.isFinite(spec.gross) && spec.gross > 0 && spec.gross <= 1)) return 'pairs.gross must be in (0,1]';
  return null;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== 'object') return 'not an object';
  if (spec.kind !== 'EQ' && spec.kind !== 'FNO' && spec.kind !== 'BASKET' && spec.kind !== 'PAIRS') return 'kind must be EQ, FNO, BASKET or PAIRS';
  if (typeof spec.name !== 'string' || !spec.name.trim()) return 'missing name';
  if (spec.kind === 'EQ') {
    for (const f of ['entry', 'exit', 'weight']) {
      if (spec[f] !== undefined && !validExpr(spec[f])) return `invalid ${f} expression`;
    }
    // `side` (optional, default 'long') makes a bot bullish or BEARISH: 'short' negates
    // the target so the bot SELLS SHORT (profits when the price falls). Engine supports
    // shorts (signed qty), so a short EQ bot runs through the same path as a long one.
    if (spec.side !== undefined && spec.side !== 'long' && spec.side !== 'short') return 'EQ side must be "long" or "short"';
    if (spec.entry === undefined && spec.weight === undefined) return 'EQ needs at least entry or weight';
    return null;
  }
  if (spec.kind === 'BASKET') return validateBasket(spec);
  if (spec.kind === 'PAIRS') return validatePairs(spec);
  // FNO
  if (!Array.isArray(spec.legs) || spec.legs.length < 1 || spec.legs.length > 8) return 'legs must be 1..8';
  for (const l of spec.legs) {
    if (!l || typeof l !== 'object') return 'leg must be an object';
    if (l.type !== 'CE' && l.type !== 'PE') return 'leg.type must be CE/PE';
    if (l.side !== 'SELL' && l.side !== 'BUY') return 'leg.side must be SELL/BUY';
    if (!(typeof l.strikePct === 'number' && l.strikePct >= 0.5 && l.strikePct <= 2)) return 'leg.strikePct 0.5..2';
    if (l.lots !== undefined && !(Number.isInteger(l.lots) && l.lots >= 1 && l.lots <= 10)) return 'leg.lots 1..10';
  }
  return null;
}

function compileEquity(spec) {
  const hasEntry = spec.entry !== undefined;
  const hasExit = spec.exit !== undefined;
  // A BEARISH bot (`side:'short'`) negates the target: the SAME entry/exit logic decides
  // WHEN to hold a position, but a held position is a SHORT (the bot profits when the
  // price falls). The magnitude is still the clamped 0..1 weight; `sign` flips it.
  const sign = spec.side === 'short' ? -1 : 1;
  return {
    name: spec.name,
    note: spec.note || '',
    make() {
      let inPos = !hasEntry; // no entry rule -> always invested (continuous weight)
      return ({ closes, i }) => {
        if (hasEntry) {
          if (!inPos) {
            if (evalNode(spec.entry, closes, i) === true) inPos = true;
          } else {
            const exitTrue = hasExit
              ? evalNode(spec.exit, closes, i) === true
              : evalNode(spec.entry, closes, i) !== true;
            if (exitTrue) inPos = false;
          }
        }
        if (!inPos) return 0;
        const w = spec.weight === undefined ? 1 : evalNode(spec.weight, closes, i);
        if (w == null || !Number.isFinite(w)) return 0;
        return sign * Math.max(0, Math.min(1, w)); // 0..1 magnitude, signed by side
      };
    },
  };
}

function compileFno(spec) {
  const legs = spec.legs;
  return {
    name: spec.name,
    note: spec.note || '',
    entry: (spot) => legs.map((l) => ({ type: l.type, side: l.side, strike: spot * l.strikePct, lots: l.lots || 1 })),
  };
}

// A BASKET can't fit the single-symbol `make()` contract (it spans many stocks),
// so its compiled form just carries the validated spec; the PORTFOLIO backtester
// (backtest/portfolio.mjs) interprets it across the whole universe.
function compileBasket(spec) {
  return { name: spec.name, note: spec.note || '', spec };
}

// A PAIRS strategy, like a BASKET, spans many stocks — its compiled form just
// carries the validated spec; backtest/pairs.mjs interprets it across the universe.
function compilePairs(spec) {
  return { name: spec.name, note: spec.note || '', spec };
}

// Returns { ok, strategy, kind } or { ok:false, error }.
function safeCompile(spec) {
  const err = validateSpec(spec);
  if (err) return { ok: false, error: err };
  const strategy = spec.kind === 'EQ' ? compileEquity(spec)
    : spec.kind === 'BASKET' ? compileBasket(spec)
    : spec.kind === 'PAIRS' ? compilePairs(spec)
    : compileFno(spec);
  return { ok: true, strategy, kind: spec.kind };
}

// Example specs: the existing hand-coded strategies re-expressed in the DSL.
// They prove the DSL is expressive enough AND double as worked examples for the
// strategy generator.
const EXAMPLE_SPECS = [
  { kind: 'EQ', name: 'SMA 50/200 (golden cross)', note: 'trend', entry: ['>', ['sma', 50], ['sma', 200]], exit: ['<', ['sma', 50], ['sma', 200]], weight: 1 },
  { kind: 'EQ', name: 'RSI(14) reversion', note: 'mean-reversion', entry: ['<', ['rsi', 14], 35], exit: ['>', ['rsi', 14], 65] },
  { kind: 'EQ', name: 'Donchian 20 breakout', note: 'breakout', entry: ['>=', ['price'], ['high', 20]], exit: ['<=', ['price'], ['low', 20]] },
  { kind: 'EQ', name: 'Vol-target', note: 'continuous exposure', weight: ['clamp', ['/', 0.01, ['vol', 20]], 0, 1] },
  { kind: 'EQ', name: '12-month momentum', note: 'long while up over ~1y', entry: ['>', ['mom', 252], 0], exit: ['<', ['mom', 252], 0] },
  { kind: 'FNO', name: 'Short straddle', note: 'sell ATM CE+PE', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.0 }, { type: 'PE', side: 'SELL', strikePct: 1.0 }] },
  { kind: 'FNO', name: 'Short strangle', note: 'sell 4% OTM', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.04 }, { type: 'PE', side: 'SELL', strikePct: 0.96 }] },
  { kind: 'BASKET', name: 'Top-3 momentum basket', note: 'hold the 3 strongest names', universe: ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'ITC', 'LT'], rank: ['mom', 252], k: 3, weighting: 'equal', rebalanceBars: 21 },
  { kind: 'BASKET', name: 'ML ridge basket', note: 'learn which names to hold', universe: ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'ITC', 'LT'], rank: ['mom', 63], k: 3, weighting: 'rankw', rebalanceBars: 21, mlConfig: { model: 'ridge', features: ['mom21', 'mom63', 'mom126', 'rsi14', 'distHigh', 'volratio', 'smaSlope'], horizon: 21, lambda: 1, lookback: 756, trainEveryBars: 63, minTrain: 120 } },
];

// --- Plain-English explanation of a spec (for the UI; helps a learner) ------
const IND_WORDS = {
  price: () => 'price',
  sma: (n) => `the ${n}-day average`,
  ema: (n) => `the ${n}-day EMA`,
  rsi: (n) => `RSI(${n})`,
  mom: (n) => `the ${n}-day return`,
  high: (n) => `the prior ${n}-day high`,
  low: (n) => `the prior ${n}-day low`,
  vol: (n) => `${n}-day volatility`,
  atr: (n) => `the ${n}-day average move`,
  distHigh: (n) => `distance below the ${n}-day high`,
  slope: (n) => `the ${n}-day average's slope`,
  zscore: (n) => `the ${n}-day z-score`,
  regime: (n) => `${n}-day trend (above-average)`,
};
const CMP_WORDS = { '>': 'is above', '<': 'is below', '>=': 'is at/above', '<=': 'is at/below' };
const MATH_WORDS = { '+': '+', '-': '−', '*': '×', '/': '÷' };

function describeExpr(node) {
  if (typeof node === 'number') return String(node);
  if (typeof node === 'boolean') return String(node); // booleans are valid expr leaves
  if (!Array.isArray(node) || !node.length) return '?';
  const [op, ...a] = node;
  if (op === 'macd') return `MACD(${a[0]},${a[1]},${a[2]})`;
  if (op === 'volratio') return `the ${a[0]}/${a[1]}-day volatility ratio`;
  if (IND_WORDS[op]) return IND_WORDS[op](a[0]);
  if (CMP_WORDS[op]) return `${describeExpr(a[0])} ${CMP_WORDS[op]} ${describeExpr(a[1])}`;
  if (op === 'and') return a.map(describeExpr).join(' AND ');
  if (op === 'or') return a.map(describeExpr).join(' OR ');
  if (op === 'not') return `not (${describeExpr(a[0])})`;
  if (op === 'min' || op === 'max') return `${op}(${describeExpr(a[0])}, ${describeExpr(a[1])})`;
  if (op === 'clamp') return `${describeExpr(a[0])} (kept within ${describeExpr(a[1])}–${describeExpr(a[2])})`;
  if (MATH_WORDS[op]) return `${describeExpr(a[0])} ${MATH_WORDS[op]} ${describeExpr(a[1])}`;
  return op;
}

function describeLeg(l) {
  const verb = l.side === 'SELL' ? 'sell' : 'buy';
  const lots = l.lots && l.lots > 1 ? `${l.lots}× ` : '';
  const off = Math.round((l.type === 'CE' ? l.strikePct - 1 : 1 - l.strikePct) * 100);
  const money = Math.abs(l.strikePct - 1) < 0.005 ? 'ATM' : `${Math.abs(off)}% ${off >= 0 ? 'OTM' : 'ITM'}`;
  return `${verb} ${lots}${money} ${l.type === 'CE' ? 'call' : 'put'}`;
}

// Turn a spec into one readable sentence describing what the strategy does.
function explainSpec(spec) {
  if (!spec) return '';
  if (spec.kind === 'PAIRS') {
    const n = Array.isArray(spec.universe) ? spec.universe.length : 0;
    const mc = spec.minCorr == null ? 0.6 : spec.minCorr;
    return `Market-neutral stat-arb: every ~${spec.formationBars} bars, find up to ${spec.maxPairs} co-moving, mean-reverting pairs among ${n} names (correlation ≥ ${mc}); when a pair's spread stretches past ±${spec.entryZ}σ, short the expensive leg and buy the cheap one (equal rupee size), exiting near ±${spec.exitZ}σ.`;
  }
  if (spec.kind === 'BASKET') {
    const n = Array.isArray(spec.universe) ? spec.universe.length : 0;
    const WW = { volinv: 'low-volatility-weighted', rankw: 'rank-weighted', meanvar: 'mean-variance optimised', riskparity: 'risk-parity weighted', equal: 'equal-weighted' };
    const weightWord = WW[spec.weighting] || 'equal-weighted';
    let s = `Every ~${spec.rebalanceBars} bars: hold the top ${spec.k} of ${n} names`;
    s += spec.mlConfig
      ? `, ranked by a local ${spec.mlConfig.model} model (walk-forward, no external data; falls back to ${describeExpr(spec.rank)})`
      : spec.factors
        ? `, ranked by a ${spec.factors.length}-factor model (${spec.factors.map((f) => f.name).join(', ')})`
        : ` by ${describeExpr(spec.rank)}`;
    s += `, ${weightWord}`;
    if (spec.gate !== undefined) s += `, only names where ${describeExpr(spec.gate)}`;
    if (spec.marketGate !== undefined) s += `, sitting in cash unless ${describeExpr(spec.marketGate)}`;
    return s + '.';
  }
  if (spec.kind === 'EQ') {
    const short = spec.side === 'short';
    if (spec.entry === undefined) {
      if (typeof spec.weight === 'number') {
        // Reflect the exposure the engine ACTUALLY uses (clamped 0..1, NaN->0),
        // so a degenerate weight never prints "NaN%" or a negative percentage.
        const w = Number.isFinite(spec.weight) ? Math.max(0, Math.min(1, spec.weight)) : 0;
        if (short) return w >= 1 ? 'Always fully SHORT (bearish — profits when the price falls).' : `Always ${Math.round(w * 100)}% SHORT (bearish).`;
        return w >= 1 ? 'Always fully invested (buy & hold).' : `Always invested at ${Math.round(w * 100)}% of capital.`;
      }
      return `Always ${short ? 'short' : 'invested'}; position size = ${describeExpr(spec.weight)}.`;
    }
    let s = `${short ? 'Shorts (sells)' : 'Buys'} when ${describeExpr(spec.entry)}`;
    s += spec.exit !== undefined ? `; ${short ? 'covers' : 'sells'} when ${describeExpr(spec.exit)}` : `; ${short ? 'covers' : 'sells'} when that is no longer true`;
    if (spec.weight !== undefined && !(spec.weight === 1)) s += `. Sized by ${describeExpr(spec.weight)}`;
    if (short) s += ' — a bearish bot that profits when the price falls';
    return s + '.';
  }
  return `Each month: ${(spec.legs || []).map(describeLeg).join(', ')}.`;
}

// --- In-depth strategy rationale (for the per-bot detail PAGE) ----------------
// Goes beyond explainSpec's one sentence: WHAT edge the strategy is trying to capture
// (the thesis), its parameters in plain English, and its risk profile. Returns
// { headline, thesis, params:[{label,value}], risk } (+ a friendly null for no spec).
// Authored per-archetype so a learner understands WHY the bot trades the way it does.

// A coarse archetype for a BASKET's ranking rule — local to dsl (no dependency on
// evolve.archetypeOf) so it can drive the rationale text.
function basketArchetype(spec) {
  if (spec.mlConfig) return 'ml';
  if (spec.factors) return 'factor';
  const op = Array.isArray(spec.rank) ? spec.rank[0] : 'rank';
  if (op === 'mom' || op === 'macd' || op === 'slope') return 'momentum';
  if (op === 'vol' || op === 'volratio' || op === '*' || op === '/') return 'lowvol';
  if (op === 'distHigh' || op === 'high') return 'breakout';
  if (op === 'rsi' || op === 'zscore') return 'meanrev';
  return 'other';
}

const WEIGHT_WORDS = {
  equal: 'equal-weighted (the same rupee size in each name)',
  rankw: 'rank-weighted (more capital in the higher-ranked names)',
  volinv: 'inverse-volatility weighted (more capital in the calmer names)',
  meanvar: 'mean-variance optimised (Markowitz — Σ⁻¹μ, more capital to higher-expected-return names, penalised by their covariance)',
  riskparity: 'risk-parity weighted (sized so each name contributes equally to portfolio risk)',
};
// Plain-English model names for the rationale (covers the ridge/logistic linear
// models and the gbm/forest tree ensembles).
const ML_WORDS = { ridge: 'ridge regression', logistic: 'logistic classifier', gbm: 'gradient-boosted tree ensemble', forest: 'random forest' };

function cadenceWord(bars) {
  if (bars <= 5) return 'weekly';
  if (bars <= 10) return 'fortnightly';
  if (bars <= 21) return 'monthly';
  return 'every quarter or so';
}

function basketRationale(spec) {
  const arch = basketArchetype(spec);
  const n = Array.isArray(spec.universe) ? spec.universe.length : 0;
  const THESES = {
    momentum: { headline: 'Momentum — back the strongest names', thesis: 'Stocks that have outperformed recently tend to keep outperforming over the next several weeks (the well-documented momentum effect). This basket ranks the whole field by recent return and holds the leaders, rotating as leadership changes.' },
    breakout: { headline: 'Breakout — buy strength near new highs', thesis: 'A stock pushing toward fresh highs is showing real demand. This basket holds the names closest to their recent high (only while the broader trend is up), aiming to ride the continuation.' },
    lowvol: { headline: 'Low volatility — own the calm compounders', thesis: 'Calmer, steadier stocks have historically delivered better risk-adjusted returns than the most volatile names (the low-volatility anomaly). This basket prefers the least-volatile up-trending names.' },
    meanrev: { headline: 'Mean reversion — buy the oversold dip', thesis: 'Short-term overreactions tend to snap back. This basket buys the most oversold names (low RSI / stretched below their mean) that are still in a longer up-trend, betting on a bounce.' },
    ml: { headline: `Machine learning — a local ${spec.mlConfig ? (ML_WORDS[spec.mlConfig.model] || spec.mlConfig.model) : ''} picks the names`, thesis: `Instead of one fixed rule, a ${spec.mlConfig ? (ML_WORDS[spec.mlConfig.model] || spec.mlConfig.model) : 'model'} is trained walk-forward on the price history to estimate which names will outperform next, then holds its top picks. It is 100% local and free — no external service, no API call. When it can't train confidently it falls back to a "${describeExpr(spec.rank)}" rule.` },
    factor: { headline: 'Multi-factor model — blend several signals', thesis: `Rather than ranking on a single number, this basket scores every name on ${spec.factors ? spec.factors.length : 'several'} standardised FACTORS${spec.factors ? ` (${spec.factors.map((f) => f.name).join(', ')})` : ''}, each z-scored across the universe at the decision bar, then combined into one composite rank. Blending diversified, look-ahead-safe signals is the backbone of modern quant equity — no single factor works in every regime.` },
    other: { headline: 'Multi-company basket', thesis: `Each rebalance it scores every name by ${describeExpr(spec.rank)} and holds the best.` },
  };
  const t = THESES[arch];
  const params = [
    { label: 'Universe', value: `${n} stocks scanned every rebalance` },
    { label: 'Holdings', value: `the top ${spec.k}` },
    { label: 'Rebalance', value: `${cadenceWord(spec.rebalanceBars)} (every ~${spec.rebalanceBars} bars)` },
    { label: 'Weighting', value: WEIGHT_WORDS[spec.weighting || 'equal'] },
  ];
  if (spec.factors) params.push({ label: 'Factors', value: spec.factors.map((f) => `${f.name} (×${f.weight})`).join(', ') });
  if (spec.weighting === 'meanvar' || spec.weighting === 'riskparity') params.push({ label: 'Optimiser', value: `${spec.weighting === 'meanvar' ? 'mean-variance (Markowitz)' : 'risk-parity'} on a ${spec.covLookback || 63}-bar Ledoit-Wolf covariance${spec.maxWeight ? `, capped at ${Math.round(spec.maxWeight * 100)}% per name` : ''}` });
  if (spec.gate !== undefined) params.push({ label: 'Eligibility gate', value: `only names where ${describeExpr(spec.gate)}` });
  if (spec.marketGate !== undefined) params.push({ label: 'Market filter', value: `sit entirely in cash unless ${describeExpr(spec.marketGate)}` });
  if (spec.mlConfig) params.push({ label: 'Model', value: `${ML_WORDS[spec.mlConfig.model] || spec.mlConfig.model}; features: ${spec.mlConfig.features.join(', ')}; trained on ~${spec.mlConfig.lookback} bars, predicting ${spec.mlConfig.horizon} bars ahead` });
  const concentration = spec.k <= 3 ? `Concentrated in just ${spec.k} names, so a single stock moves the needle a lot` : `Spread across ${spec.k} names for some diversification`;
  const turnover = spec.rebalanceBars <= 5 ? 'High turnover (weekly rotation) means more trading costs and whipsaw risk' : 'Moderate turnover keeps trading costs in check';
  return { headline: t.headline, thesis: t.thesis, params, risk: `${concentration}. ${turnover}. Like every backtest this track record is in-sample — the Live column going forward is the only honest test.` };
}

function eqRationale(spec) {
  const short = spec.side === 'short';
  let headline, thesis;
  const j = JSON.stringify(spec.entry || []);
  if (short) {
    // A bearish bot: reframe everything around SHORTING / profiting from a fall. (It is
    // the portfolio's hedge sleeve — it tends to make money exactly when the long-only
    // bots struggle, i.e. a falling market.)
    headline = 'Bearish — profit when it falls (short)';
    thesis = `A SHORT strategy: it borrows-and-sells the symbol when ${spec.entry === undefined ? 'always (a constant short)' : describeExpr(spec.entry)}, aiming to profit as the price DECLINES, and covers (buys it back) when ${spec.exit !== undefined ? describeExpr(spec.exit) : 'that signal reverses'}. This is the board's bearish sleeve — most other bots are long-only, so this one is built to make money exactly when the market FALLS (and to hedge the rest).`;
  } else if (spec.entry === undefined) {
    headline = 'Always invested (buy & hold)';
    thesis = 'Stays fully invested in the symbol at all times — the simplest possible strategy, and the benchmark every active strategy is trying to beat.';
  } else if (j.includes('high') || (Array.isArray(spec.entry) && spec.entry[0] === '>=')) {
    headline = 'Breakout — buy strength';
    thesis = 'Goes long when price breaks above a recent high (momentum / continuation) and exits when it breaks back down through a recent low.';
  } else if (j.includes('rsi') || j.includes('zscore')) {
    headline = 'Mean reversion — buy the dip';
    thesis = 'Buys when the symbol is oversold and sells once it has recovered, betting on a short-term snap-back.';
  } else if (j.includes('sma') || j.includes('ema')) {
    headline = 'Trend following — ride the trend';
    thesis = 'Goes long while a faster average is above a slower one (an up-trend) and steps aside when the trend turns down.';
  } else {
    headline = 'Rules-based equity strategy';
    thesis = `Buys when ${describeExpr(spec.entry)} and exits on the opposite condition.`;
  }
  const params = [{ label: 'Direction', value: short ? 'SHORT (bearish — profits when the price falls)' : 'long (bullish)' }];
  params.push({ label: short ? 'Short when' : 'Entry', value: spec.entry === undefined ? (short ? 'always short' : 'always in the market') : describeExpr(spec.entry) });
  if (spec.exit !== undefined) params.push({ label: short ? 'Cover when' : 'Exit', value: describeExpr(spec.exit) });
  if (spec.weight !== undefined && spec.weight !== 1) params.push({ label: 'Position size', value: describeExpr(spec.weight) });
  const risk = short
    ? 'Shorting carries theoretically UNLIMITED loss if the price keeps RISING (the opposite of a long), so a disciplined cover rule matters. Being market-neutral-ish to the rest of the board, it is most valuable as a hedge. Backtests are in-sample; the Live column is the real test.'
    : 'A single-symbol strategy — its fortunes ride entirely on that one instrument, so it can be streaky. Backtests are in-sample; the Live column is the real test.';
  return { headline, thesis, params, risk };
}

function fnoRationale(spec) {
  const legs = spec.legs || [];
  const allSell = legs.length > 0 && legs.every((l) => l.side === 'SELL');
  return {
    headline: allSell ? 'Option premium selling — collect time decay' : 'Defined-risk option structure',
    thesis: 'Sells index option premium each month and profits from time-decay (theta) as long as the index stays inside a range. Option prices here are MODELLED with Black-Scholes (no free historical option data exists), so treat the numbers as indicative, not real fills.',
    params: legs.map((l) => ({ label: `${l.type} leg`, value: describeLeg(l) })),
    risk: allSell
      ? 'Naked option selling offers LIMITED reward but potentially LARGE loss on a big move ("picking up pennies in front of a steamroller"). Margin scales with capital.'
      : 'The long wings cap the worst-case loss to a defined amount. Still indicative (modelled prices).',
  };
}

function pairsRationale(spec) {
  const n = Array.isArray(spec.universe) ? spec.universe.length : 0;
  const mc = spec.minCorr == null ? 0.6 : spec.minCorr;
  const params = [
    { label: 'Universe', value: `${n} names screened for co-moving pairs each formation` },
    { label: 'Pairs held', value: `up to ${spec.maxPairs} disjoint pairs (each name used once)` },
    { label: 'Formation', value: `${cadenceWord(spec.formationBars)} re-selection (every ~${spec.formationBars} bars)` },
    { label: 'Screen', value: `return-correlation ≥ ${mc}, plus a mean-reverting spread (AR(1) cointegration proxy)` },
    { label: 'Signal', value: `enter at |z| ≥ ${spec.entryZ}σ, exit near ±${spec.exitZ}σ${spec.stopZ != null ? `, stop at |z| ≥ ${spec.stopZ}σ` : ''}` },
    { label: 'Hedge', value: `spread = logA − β·logB (β = OLS hedge ratio), lookback ${spec.lookback} bars` },
    { label: 'Sizing', value: `dollar-neutral — equal rupee long & short per pair (≈ market-neutral)` },
  ];
  return {
    headline: 'Statistical arbitrage — bet on convergence, not direction',
    thesis: 'Two stocks that historically move together (e.g. two banks, two IT names) occasionally drift apart for no fundamental reason. This bot SHORTS the one that has run ahead and BUYS the one that has lagged, in equal rupee size, then waits for the gap to close. Because every position is hedged long-vs-short, the overall market going up or down barely matters — the profit comes purely from the spread reverting. That makes its returns largely UNCORRELATED with the index, which is what makes it valuable in a portfolio (it can make money when the market falls).',
    params,
    risk: 'Market-neutral, so its drawdowns are usually small — but a pair can BREAK its historical relationship (one company’s story changes), and then the spread keeps widening instead of reverting; the z-stop caps that. It also shorts, and trades more than a buy-and-hold bot. Like every backtest here this is in-sample; the Live column is the honest test.',
  };
}

function strategyRationale(spec) {
  if (!spec) return null;
  if (spec.kind === 'BASKET') return basketRationale(spec);
  if (spec.kind === 'PAIRS') return pairsRationale(spec);
  if (spec.kind === 'FNO') return fnoRationale(spec);
  return eqRationale(spec);
}

export { evalNode, validExpr, validateSpec, validateBasket, validatePairs, safeCompile, compileEquity, compileFno, compileBasket, compilePairs, explainSpec, strategyRationale, describeExpr, EXAMPLE_SPECS, ema, mom, FEATURE_WHITELIST, MAX_BASKET_UNIVERSE };
