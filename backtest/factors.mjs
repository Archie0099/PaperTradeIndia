// ---------------------------------------------------------------------------
// backtest/factors.mjs
// A cross-sectional MULTI-FACTOR model — the principled-quant generalisation of a
// basket's single `rank` expression into a weighted COMPOSITE of several factor
// scores, each STANDARDISED ACROSS THE UNIVERSE at the decision bar.
//
// A real equity quant model doesn't rank by one raw number; it blends several
// standardised "factors" (e.g. momentum, low-volatility, trend-quality, short-term
// reversal) into one composite rank. Each factor here is an ordinary DSL expression,
// so the maths is the SAME look-ahead-safe, unit-tested code path the rule rank and
// the ML features already use (one source of truth).
//
// Why this is LOOK-AHEAD-SAFE + DETERMINISTIC:
//   * Each factor is evaluated on a stock's OWN closes up to its real bar index `ri`
//     (the index of its latest real bar at-or-before the decision time — no future
//     data), exactly like spec.rank in portfolio.mjs.
//   * The z-scoring is CROSS-SECTIONAL: for ONE rebalance date we gather every
//     eligible name's raw factor vector, then standardise each factor across THAT
//     set only. Every value in the cross-section is already known at the decision
//     bar, so a future bar can never change a past rebalance's composite (the
//     no-look-ahead test flips the last bar and checks nothing earlier moves).
//   * We standardise with POPULATION mean/std (matching ml.mjs's standardize, /n)
//     and a dead (zero-variance) factor floors std to 1 -> z = 0 for everyone, never
//     0/0 = NaN. Callers iterate the universe in a canonical (sorted) order, so the
//     mean/std sums are float-identical regardless of input order -> deterministic.
//   * A name missing ANY factor value (an indicator not yet warm) is EXCLUDED from
//     the cross-section entirely (mirrors ml.mjs featuresAt's null-until-warm), so a
//     half-warmed name never poisons the standardisation nor sneaks in on a bogus 0.
//
// ZERO new dependencies; no Math.random / Date.now. The composite
// is DATA fit to numbers (a scalar score per stock) — it can only re-order the
// candidates, exactly like a hand-written `rank` expression.
// ---------------------------------------------------------------------------

import { evalNode } from './dsl.mjs';

// Standardise one factor's raw values across the cross-section using POPULATION
// mean/std (/n, matching ml.mjs standardize). A dead (≈zero-variance) factor floors
// std to 1 so every z becomes 0 instead of NaN. Returns z[] parallel to `raw`.
function zscore(raw) {
  const n = raw.length;
  if (!n) return [];
  let mean = 0;
  for (const v of raw) mean += v;
  mean /= n;
  let varSum = 0;
  for (const v of raw) varSum += (v - mean) ** 2;
  let std = Math.sqrt(varSum / n);
  if (!(std > 1e-12)) std = 1; // dead factor -> z = 0 for everyone, never 0/0
  return raw.map((v) => (v - mean) / std);
}

// Compute every candidate's COMPOSITE factor score at one rebalance.
//   candidates : [{ sym, closes, ri }]  (closes = the name's OWN close array,
//                ri = its real bar index at-or-before the decision time)
//   factorDefs : [{ name, expr, weight }]  (expr is a DSL node; weight may be < 0
//                to flip a factor's direction, e.g. a reversal factor)
//
// Returns { scored, dropped } where:
//   scored  : [{ sym, score, factors:[{ name, z, raw }] }] — ONLY the names whose
//             factors are ALL finite, in the SAME order they were passed in. `score`
//             = Σ weight·z; the per-factor z/raw breakdown powers the per-bot page's
//             "why each stock was chosen".
//   dropped : [sym] — names excluded because a factor wasn't warm (for diagnostics).
function computeComposite(candidates, factorDefs) {
  const F = factorDefs.length;
  // 1. Raw factor matrix over the names whose factors are ALL finite.
  const eligible = []; // { sym, raw:[F] }
  for (const c of candidates) {
    const raw = new Array(F);
    let ok = true;
    for (let k = 0; k < F; k++) {
      const v = evalNode(factorDefs[k].expr, c.closes, c.ri);
      if (v == null || !Number.isFinite(v)) { ok = false; break; }
      raw[k] = v;
    }
    if (ok) eligible.push({ sym: c.sym, raw });
  }
  if (!eligible.length) return { scored: [], dropped: candidates.map((c) => c.sym) };

  // 2. Cross-sectional z-score per factor (column-wise across the eligible names).
  const zByFactor = new Array(F);
  for (let k = 0; k < F; k++) zByFactor[k] = zscore(eligible.map((e) => e.raw[k]));

  // 3. Composite = weighted sum of the z-scores; keep the per-factor breakdown.
  const scored = eligible.map((e, i) => {
    let score = 0;
    const factors = new Array(F);
    for (let k = 0; k < F; k++) {
      const z = zByFactor[k][i];
      score += factorDefs[k].weight * z;
      factors[k] = { name: factorDefs[k].name, z: +z.toFixed(4), raw: +e.raw[k].toFixed(6) };
    }
    return { sym: e.sym, score, factors };
  });
  const keep = new Set(eligible.map((e) => e.sym));
  return { scored, dropped: candidates.filter((c) => !keep.has(c.sym)).map((c) => c.sym) };
}

export { computeComposite, zscore };
