// ---------------------------------------------------------------------------
// backtest/pairs.mjs
// A STATISTICAL-ARBITRAGE / PAIRS backtester — the "market-neutral" strategy kind
// (Quant Lab part D). Instead of betting on the market going up, it bets that two
// CO-MOVING stocks that have drifted apart will converge again. It is LONG one and
// SHORT the other in roughly equal rupee size, so the broad market washing up or
// down barely matters: the P&L comes from the SPREAD between the two names closing.
//
// Like every other backtester here it runs THROUGH the real simulation engine
// (engine.placeOrder / updateEquityPrice — the engine fully supports shorts via
// signed quantities), so the MASTER money invariant holds by construction, and it
// has NO LOOK-AHEAD: every decision at bar `gi` uses only data up to `gi`, and is
// executed ONE BAR LATER at that bar's price.
//
// How it works, each cycle:
//   * FORMATION (every `formationBars`): scan every candidate pair in the universe
//     over a trailing `lookback` window, keep the ones that are (a) highly
//     correlated and (b) mean-reverting — a cheap COINTEGRATION proxy: regress one
//     log-price on the other (OLS) to get the hedge ratio β, build the spread
//     s = logA − β·logB, and fit an AR(1) on it (φ < 1 ⇒ the spread pulls back to
//     its mean). Rank by correlation × reversion-speed, then GREEDILY pick disjoint
//     pairs (each name used once) up to `maxPairs`.
//   * EACH BAR: for every active pair compute the spread's z-score over the trailing
//     window. When it stretches past ±`entryZ` we OPEN (short the rich leg, long the
//     cheap one); when it reverts inside ±`exitZ` we CLOSE; a |z| ≥ `stopZ` bail-out
//     caps the damage if the relationship is breaking down.
//   * SIZING is dollar-neutral: each deployed pair gets (gross·equity)/maxPairs per
//     leg, so the long and short legs are equal rupee size (≈ market-neutral). The
//     short leg is self-funding (its proceeds back its own margin in the engine), so
//     the long legs consume the capital — capped at `gross` (< 1) for a safety buffer.
//
// FREE + LOCAL + DETERMINISTIC: zero new deps, no Math.random / Date.now. Universe
// is iterated in sorted order and candidate pairs in canonical (i<j) order, so every
// floating-point sum is identical run-to-run.
// ---------------------------------------------------------------------------

import { freshEngine, snapshotPositions, chargeFee, feesCharged } from './harness.mjs';
import { summarize, inferPeriodsPerYear } from './metrics.mjs';
import { alignSeries } from './portfolio.mjs';
import { flatCosts, eqFillPrice, borrowFee } from './costs.mjs';

// --- small pure stats helpers (population moments; all O(n)) -----------------
function mean(xs) { let s = 0; for (const x of xs) s += x; return s / xs.length; }
function pstd(xs, m = mean(xs)) { let v = 0; for (const x of xs) v += (x - m) ** 2; return Math.sqrt(v / xs.length); }

// Pearson correlation of two equal-length series. Returns 0 if either is flat.
function corr(a, b) {
  const ma = mean(a), mb = mean(b);
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < a.length; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

// OLS slope of y on x: β = cov(x,y)/var(x). Returns null if x is flat (no hedge ratio).
function olsSlope(x, y) {
  const mx = mean(x), my = mean(y);
  let cov = 0, vx = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx; cov += dx * (y[i] - my); vx += dx * dx; }
  return vx > 1e-12 ? cov / vx : null;
}

// AR(1) coefficient φ of a series (regress s_t on s_{t-1}). φ < 1 ⇒ mean-reverting
// (φ near 1 = a slow/near-random-walk spread; φ ≤ -1 or ≥ 1 = non-stationary). Returns
// null if the lagged series is flat.
function ar1(s) {
  const x = s.slice(0, -1), y = s.slice(1);
  return olsSlope(x, y);
}

// The trailing log-price window for one symbol on the master grid, ending at gi
// (length `lookback`). Returns null if any bar is missing/non-positive (so a not-yet
// fully-listed name is simply skipped — no fake forward-filled zeros poison the stats).
function logWindow(priceGrid, sym, gi, lookback) {
  const out = new Array(lookback);
  for (let k = 0; k < lookback; k++) {
    const px = priceGrid[sym][gi - lookback + 1 + k];
    if (!(px > 0)) return null;
    out[k] = Math.log(px);
  }
  return out;
}

// The current spread z-score for a pair at bar gi, using the fixed hedge ratio β and
// the trailing `lookback` window of the spread s = logA − β·logB. z = (s_now − mean)/std
// over the window (the latest point standardised within its own trailing window).
// Returns null if either leg lacks a clean window or the spread is flat.
function spreadZ(priceGrid, a, b, beta, gi, lookback) {
  const la = logWindow(priceGrid, a, gi, lookback);
  const lb = logWindow(priceGrid, b, gi, lookback);
  if (!la || !lb) return null;
  const s = new Array(lookback);
  for (let k = 0; k < lookback; k++) s[k] = la[k] - beta * lb[k];
  const m = mean(s), sd = pstd(s, m);
  if (!(sd > 0)) return null;
  return { z: (s[lookback - 1] - m) / sd, mean: m, std: sd };
}

// FORMATION: pick up to maxPairs disjoint, tradeable pairs from the listed universe.
// `tradeable` = correlation ≥ minCorr AND a stationary, mean-reverting spread (0<φ<φMax).
// Ranked by corr × reversion-speed (1−φ), greedily chosen so no name is in two pairs.
// Pure function of priceGrid[..gi] → no look-ahead, deterministic.
function selectPairs(priceGrid, listed, gi, { lookback, minCorr, maxPairs }) {
  const PHI_MAX = 0.97; // φ ≥ this ⇒ effectively a random walk (no usable reversion)
  const syms = [...listed].sort(); // canonical order -> deterministic candidate enumeration
  // Pre-compute each listed name's trailing log window + returns once.
  const logs = {}, rets = {};
  for (const s of syms) {
    const lw = logWindow(priceGrid, s, gi, lookback);
    if (!lw) continue;
    logs[s] = lw;
    const r = new Array(lookback - 1);
    for (let k = 1; k < lookback; k++) r[k - 1] = lw[k] - lw[k - 1];
    rets[s] = r;
  }
  const usable = syms.filter((s) => logs[s]);
  const cands = [];
  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < usable.length; j++) {
      const a = usable[i], b = usable[j];
      const rho = corr(rets[a], rets[b]);
      if (!(rho >= minCorr)) continue;
      // Hedge ratio: regress the HIGHER-priced leg's log on the other's (β is scale-only
      // for logs, so either ordering works; fix a = the canonical first for determinism).
      const beta = olsSlope(logs[b], logs[a]); // slope of logA on logB
      if (beta == null || !(beta > 0)) continue; // require a positive co-movement hedge
      const sp = new Array(lookback);
      for (let k = 0; k < lookback; k++) sp[k] = logs[a][k] - beta * logs[b][k];
      const sd = pstd(sp);
      if (!(sd > 0)) continue;
      const phi = ar1(sp);
      if (phi == null || !(phi > -1 && phi < PHI_MAX)) continue; // require stationary mean-reversion
      const speed = 1 - Math.max(0, phi); // faster pull-back = higher (φ<0 treated as fast)
      cands.push({ a, b, beta, rho, phi, score: rho * speed });
    }
  }
  // Best first; tie-break by names for a total, deterministic order.
  cands.sort((x, y) => y.score - x.score || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
  const chosen = [];
  const used = new Set();
  for (const c of cands) {
    if (chosen.length >= maxPairs) break;
    if (used.has(c.a) || used.has(c.b)) continue;
    used.add(c.a); used.add(c.b);
    chosen.push({ a: c.a, b: c.b, beta: c.beta, rho: c.rho, phi: c.phi, dir: 0 });
  }
  return chosen;
}

// `intraday: true` annualises the Sharpe by the master timeline's bars-per-year (like
// the other backtesters). Daily is the default (252) and byte-identical.
// COSTS: pass a `costModel` (backtest/costs.mjs — the all-in Indian delivery schedule,
// incl. the SLB borrow fee its SHORT legs must really pay) for honest results; without
// one the legacy flat `costBps` applies, byte-identical (kept for tests/back-compat).
function runPairsBacktest({ spec, dataBySymbol, cash = 10_000_000, costBps = 5, costModel = null, recordTrades = false, intraday = false, _hook = null, _barHook = null }) {
  const universe = [...spec.universe].filter((s) => Array.isArray(dataBySymbol[s]) && dataBySymbol[s].length).sort();
  const dataForUniverse = {};
  for (const s of universe) dataForUniverse[s] = dataBySymbol[s];
  const A = alignSeries(dataForUniverse);
  const { master, priceGrid, realIdx } = A;

  const engine = freshEngine(cash);
  const cm = costModel || flatCosts(costBps);
  // Liquidity honesty flag (see backtester.mjs): fills bigger than this share of
  // the bar's real traded value are counted, never silently absorbed.
  const PARTICIPATION_CAP = 0.10;
  let liqChecked = 0, liqFlagged = 0;
  const lookback = spec.lookback;
  const entryZ = spec.entryZ;
  const exitZ = spec.exitZ;
  const stopZ = spec.stopZ == null ? Infinity : spec.stopZ;
  const maxPairs = spec.maxPairs;
  const formationBars = spec.formationBars;
  const minCorr = spec.minCorr == null ? 0.6 : spec.minCorr;
  const gross = spec.gross == null ? 0.9 : spec.gross;

  const inst = {}, key = {};
  for (const s of universe) { inst[s] = { kind: 'EQ', symbol: s, lotSize: 1 }; key[s] = `EQ:${s.toUpperCase()}`; }

  const equityCurve = [];
  let activePairs = [];      // [{ a, b, beta, rho, phi, dir }] dir ∈ {-1: short A/long B, 0: flat, +1: long A/short B}
  let pendingPairs = null;   // snapshot of {a,b,dir} decided last bar, executed at the NEXT bar (one-bar lag)
  let pending = false;
  // Which PAIR each open position belongs to (sym -> "a|b"). Re-selection can move a name
  // from one pair to another between formations (disjointness only holds WITHIN a formation),
  // so we use this to flatten a leg whose pair has changed before re-opening it — never
  // leaving a stranded/naked leg.
  const posPair = {};
  const pairKey = (a, b) => [a, b].sort().join('|');
  let lastFormGi = -Infinity;
  let trades = 0;
  let lastDecision = null;
  const tradeLog = recordTrades ? [] : null;
  // What changed for a pair this bar, so each fill can carry a plain-English reason.
  let reasonBySym = new Map();
  const logTrade = (t, s, side, qty, fillPrice, realisedBefore, reasonOverride) => {
    if (!tradeLog) return;
    // Open/close trades carry a reason (set in the decide step the bar before). A
    // `reasonOverride` wins (used for an UNWIND of a leg that rotated to a different pair —
    // that flatten must NOT inherit the new pair's "Opened" reason, or the history would show
    // a 3-leg "Opened" group and a SELL labelled "BOUGHT"). Otherwise fall back to the
    // per-symbol reason, then a default so the history never shows a blank "Reason".
    tradeLog.push({ t, symbol: s, side, qty, price: +fillPrice.toFixed(2), value: Math.round(qty * fillPrice), realised: +(engine.realisedTotal() - realisedBefore).toFixed(2), reason: reasonOverride || reasonBySym.get(s) || 'Rebalanced the pair to its target size' });
  };

  // Move symbol `s` from `fromQty` to `toQty` (signed) and RETURN the resulting position
  // qty (so the caller can size a matching leg off the ACTUAL fill). A BUY that opens/
  // extends a long is capped by available funds (never overspend); a rejected order is
  // never counted/logged (no phantom trades).
  const posQty = (s) => { const p = engine.state.positions[key[s]]; return p ? p.qty : 0; };
  const moveTo = (s, fromQty, toQty, px, reasonOverride) => {
    if (toQty === fromQty) return fromQty;
    const buying = toQty > fromQty;
    let qty = Math.abs(toQty - fromQty);
    const fillPrice = eqFillPrice(cm, buying ? 'BUY' : 'SELL', px);
    if (buying && toQty > 0) {
      const affordable = Math.floor(engine.availableFunds() / fillPrice);
      qty = Math.min(qty, Math.max(0, affordable) + Math.max(0, -fromQty)); // allow covering even if cash-poor
    }
    if (qty <= 0) return fromQty;
    const side = buying ? 'BUY' : 'SELL';
    const r0 = engine.realisedTotal();
    const order = engine.placeOrder({ instrument: inst[s], side, orderType: 'MARKET', lots: qty, price: fillPrice });
    if (!order || order.status !== 'FILLED') return posQty(s);
    trades++;
    // Liquidity flag: fill value vs the bar's real traded value (raw volume × raw close).
    const idx = realIdx[s][gi];
    const vol = idx >= 0 ? A.volsBy[s][idx] : null;
    if (Number.isFinite(vol) && vol > 0) {
      liqChecked++;
      if (qty * fillPrice > PARTICIPATION_CAP * vol * (A.rawsBy[s][idx] || px)) liqFlagged++;
    }
    logTrade(master[gi], s, side, qty, fillPrice, r0, reasonOverride);
    return posQty(s);
  };

  let gi = 0;
  for (; gi < master.length; gi++) {
    // (a) MARK every listed name to its clean (forward-filled) close — silent.
    for (const s of universe) {
      const px = priceGrid[s][gi];
      if (Number.isFinite(px) && px > 0) engine.updateEquityPrice(s, px, true);
    }

    // (a2) Accrue the SLB borrow fee on every SHORT leg held since the last bar.
    // A short in the Indian cash market is only holdable via Securities Lending &
    // Borrowing — the fee runs on the borrowed notional for the CALENDAR time held
    // (weekends included), which is exactly the master-timeline gap.
    if (cm.borrowRatePA > 0 && gi > 0) {
      const dt = master[gi] - master[gi - 1];
      for (const s of universe) {
        const q = posQty(s);
        const px = priceGrid[s][gi];
        if (q < 0 && Number.isFinite(px) && px > 0) chargeFee(engine, borrowFee(Math.abs(q) * px, cm.borrowRatePA, dt));
      }
    }

    // (b) EXECUTE the pairs decided on the PREVIOUS bar (one-bar lag). Sizing happens HERE,
    // per pair, against the funds ACTUALLY available — NOT from a fixed budget snapshotted a
    // bar earlier. Why: in this engine a short reserves its FULL notional as margin AND its
    // sale proceeds enter cash, so opening a short is funds-NEUTRAL (it does NOT free cash for
    // the longs). So we (1) CLOSE anything whose desired side changed, then (2) OPEN each new
    // pair LONG-LEG-FIRST capped to ~half the available funds, then size the SHORT to MATCH the
    // long's ACTUAL filled rupee value — making every pair dollar-neutral by construction (no
    // half-legging) no matter how tight funds are.
    if (pending && pendingPairs) {
      // Which symbols a currently-active pair wants, and the pair each belongs to.
      const wantedPair = {}; // sym -> pairKey of the active (dir≠0) pair containing it
      for (const p of pendingPairs) {
        if (p.dir === 0) continue;
        const pk = pairKey(p.a, p.b);
        wantedPair[p.a] = pk; wantedPair[p.b] = pk;
      }
      // CLOSE pass: drive to 0 every held name that NO active pair wants any more (a closed /
      // dropped pair). Frees cash + releases margin before we deploy. (Names that moved to a
      // DIFFERENT pair are handled in the OPEN pass, which flattens a mismatched leg first.)
      for (const s of universe) {
        const px = priceGrid[s][gi];
        if (!(px > 0)) continue;
        const cur = posQty(s);
        if (cur !== 0 && !wantedPair[s]) {
          // Prefer the HONEST dir-change reason recorded when this pair actually closed
          // last bar — "reverted to its mean / convergence paid off" or "blew past the
          // stop" — over the generic rotation text. The old unconditional override made
          // those two reasons unreachable dead code: EVERY close (even a profitable
          // z-reversion) was labelled "its pair is no longer selected".
          const why = (reasonBySym && reasonBySym.get(s)) || `Closed the ${s} leg — its pair is no longer selected, so the position was exited.`;
          moveTo(s, cur, 0, px, why);
          posPair[s] = null;
        }
      }
      // OPEN pass: for each active pair, HOLD it if it's cleanly open (both legs right-signed
      // AND still tagged to THIS pair); otherwise flatten any stranded/mismatched leg, then
      // open fresh — LONG leg first (capped to ~half the available funds), SHORT sized to MATCH
      // the long's ACTUAL filled rupee value, so the pair is dollar-neutral by construction.
      for (const p of pendingPairs) {
        if (p.dir === 0) continue;
        const L = p.dir === 1 ? p.a : p.b, S = p.dir === 1 ? p.b : p.a;
        const pxL = priceGrid[L][gi], pxS = priceGrid[S][gi];
        if (!(pxL > 0 && pxS > 0)) continue;
        const pk = pairKey(p.a, p.b);
        const haveL = posQty(L), haveS = posQty(S);
        if (haveL > 0 && haveS < 0 && posPair[L] === pk && posPair[S] === pk) continue; // cleanly open -> HOLD
        // Not cleanly held -> flatten any lingering legs of this pair (a name that moved pairs,
        // or a partial), so we always re-open from a clean, fully-hedged state.
        if (haveL !== 0) { moveTo(L, haveL, 0, pxL, `Unwound a stale ${L} leg (it rotated to a different pair) before re-opening it cleanly.`); posPair[L] = null; }
        if (haveS !== 0) { moveTo(S, haveS, 0, pxS, `Unwound a stale ${S} leg (it rotated to a different pair) before re-opening it cleanly.`); posPair[S] = null; }
        // Budget: the per-pair share, capped at ~half the CURRENT available funds — the long
        // consumes its value from funds AND the short reserves the same again as margin, so
        // both must fit out of availableFunds (a short is funds-neutral in this engine).
        const budget = Math.min((gross * engine.equity()) / maxPairs, Math.max(0, engine.availableFunds()) * 0.49);
        const qtyL0 = Math.floor(budget / pxL);
        if (qtyL0 <= 0) continue; // can't fund even a token long this bar -> leave the pair flat
        const filledL = Math.max(0, moveTo(L, 0, qtyL0, pxL)); // LONG leg first
        if (filledL <= 0) continue;
        const qtyS = Math.floor((filledL * pxL) / pxS);        // SHORT matches the long's ACTUAL value
        if (qtyS > 0) {
          // Tag the pair as cleanly-open ONLY if the short ACTUALLY filled (a filled short -> negative
          // posQty). The ~0.49-of-available-funds budget cap guarantees the short always fits today, so
          // this is byte-identical for every reachable input; the unwind branch is defensive hardening
          // so the never-naked guarantee survives any future funds/budget change.
          const filledS = moveTo(S, 0, -qtyS, pxS);
          if (filledS < 0) { posPair[L] = pk; posPair[S] = pk; }
          else moveTo(L, filledL, 0, pxL, `Unwound the ${L} long — the matching short could not fill, so the pair stayed flat (never naked).`);
        }
        else moveTo(L, filledL, 0, pxL, `Unwound the ${L} long — could not size a matching short, so the pair stayed flat (never naked).`); // never naked
      }
      pending = false;
    }

    // (c) Record account value at this bar's clean close (one point per bar).
    equityCurve.push(engine.equity());
    if (typeof _barHook === 'function') _barHook(engine, gi); // tests: inspect per-bar exposure

    // (d) (re)FORM the pair set on a formation bar, using ONLY data up to gi.
    if (gi - lastFormGi >= formationBars && gi >= lookback) {
      lastFormGi = gi;
      const listed = universe.filter((s) => realIdx[s][gi] >= 0 && priceGrid[s][gi] > 0);
      const fresh = selectPairs(priceGrid, listed, gi, { lookback, minCorr, maxPairs });
      // Carry the open DIRECTION of any pair that survives re-formation (don't churn out
      // of a good trade just because we re-ran selection); β/stats are re-estimated fresh.
      const prevDir = new Map(activePairs.map((p) => [p.a + '|' + p.b, p.dir]));
      for (const p of fresh) { const d = prevDir.get(p.a + '|' + p.b); if (d != null) p.dir = d; }
      activePairs = fresh;
    }

    // (e) EACH bar: update every active pair's direction from its current z-score, then
    // build the next bar's signed target. (Look-ahead-safe: z uses data ≤ gi; we apply
    // it at gi+1.) Disjoint pairs -> each symbol gets a single unambiguous target.
    reasonBySym = new Map();
    const decisionPairs = [];
    for (const p of activePairs) {
      const zr = (gi >= lookback) ? spreadZ(priceGrid, p.a, p.b, p.beta, gi, lookback) : null;
      const z = zr ? zr.z : null;
      const prevDir = p.dir;
      if (z != null) {
        if (p.dir === 0) {
          // Enter ONLY while the divergence is still INSIDE the stop rail
          // (entryZ <= |z| < stopZ). A spread already past ±stopZ is the exact
          // condition the stop exists to flee — "the historical relationship
          // looks broken" — so it must not be treated as an attractive entry.
          // Without this bound a stopped-out pair re-entered on the VERY NEXT
          // bar (|z| >= entryZ still holds beyond the stop) and flip-flopped
          // open/close every two bars, realising the same loss over and over
          // while the spread stayed broken.
          if (z >= entryZ && z < stopZ) p.dir = -1;        // spread rich -> short A, long B
          else if (z <= -entryZ && z > -stopZ) p.dir = 1;  // spread cheap -> long A, short B
        } else {
          if (Math.abs(z) <= exitZ) p.dir = 0;       // reverted -> close
          else if (Math.abs(z) >= stopZ) p.dir = 0;  // diverged past the stop -> bail
        }
      }
      // Per-trade reasons (set on a dir CHANGE; consumed by the NEXT bar's execution) — the
      // user's "bigger reasons": name the pair, its correlation, the leg, the z-score, and
      // the market-neutral bet being made.
      if (tradeLog && z != null && p.dir !== prevDir) {
        const tag = `${p.a}/${p.b} (corr ${p.rho.toFixed(2)})`;
        if (p.dir === 0) {
          const why = Math.abs(z) >= stopZ
            ? `blew past the ±${stopZ}σ stop (z=${z.toFixed(2)}σ) — the historical relationship looks broken, so the position was cut to limit the loss`
            : `reverted to its mean (z=${z.toFixed(2)}σ) — the convergence bet paid off, so the pair was closed and the profit booked`;
          reasonBySym.set(p.a, `Closed the ${p.a}/${p.b} pair — the spread ${why}.`);
          reasonBySym.set(p.b, `Closed the ${p.a}/${p.b} pair — the spread ${why}.`);
        } else if (p.dir === -1) {
          reasonBySym.set(p.a, `Opened ${tag} — SHORTED ${p.a}, the expensive leg (the spread stretched RICH at z=+${z.toFixed(2)}σ); betting it falls back toward ${p.b}. Market-neutral (hedged by the long below).`);
          reasonBySym.set(p.b, `Opened ${tag} — BOUGHT ${p.b}, the cheap leg; the long side of a market-neutral bet that the ${p.a}/${p.b} spread reverts to its mean.`);
        } else {
          reasonBySym.set(p.a, `Opened ${tag} — BOUGHT ${p.a}, the lagging/cheap leg (the spread stretched CHEAP at z=${z.toFixed(2)}σ); betting it catches back up to ${p.b}. Market-neutral (hedged by the short below).`);
          reasonBySym.set(p.b, `Opened ${tag} — SHORTED ${p.b}, the expensive leg; the short side of a market-neutral bet that the ${p.a}/${p.b} spread reverts to its mean.`);
        }
      }
      if (tradeLog) decisionPairs.push({ a: p.a, b: p.b, beta: +p.beta.toFixed(4), corr: +p.rho.toFixed(3), phi: +p.phi.toFixed(3), z: z != null ? +z.toFixed(2) : null, state: p.dir === 0 ? 'flat' : p.dir === 1 ? 'long spread' : 'short spread' });
    }
    // Snapshot the pairs for next-bar execution (sizing is done THERE against live funds).
    pendingPairs = activePairs.map((p) => ({ a: p.a, b: p.b, dir: p.dir }));
    pending = true;
    if (tradeLog) lastDecision = { t: master[gi], maxPairs, entryZ, exitZ, lookback, formationBars, pairs: decisionPairs };
  }

  // --- describe the FINAL book for the leaderboard ---------------------------
  const eqNow = engine.equity();
  const holdings = [];
  for (const s of universe) {
    const pos = engine.state.positions[key[s]];
    if (!pos || pos.qty === 0) continue;
    const last = engine.state.lastPrices[key[s]];
    if (last == null) continue;
    holdings.push({ symbol: s, weightPct: eqNow > 0 ? +((pos.qty * last / eqNow) * 100).toFixed(1) : 0 });
  }
  holdings.sort((a, b) => Math.abs(b.weightPct) - Math.abs(a.weightPct));
  const openPairs = activePairs.filter((p) => p.dir !== 0);
  const position = openPairs.length
    ? openPairs.map((p) => `${p.dir === 1 ? 'L' : 'S'} ${p.a}/${p.b}`).join(' · ')
    : 'flat (no stretched pairs)';

  const years = master.length >= 2 ? (master[master.length - 1] - master[0]) / (365.25 * 864e5) : undefined;
  if (typeof _hook === 'function') _hook(engine);

  return {
    name: spec.name,
    note: spec.note || '',
    equityCurve,
    times: master,
    position,
    holdings,
    finalCash: engine.state.cash,
    finalPositions: snapshotPositions(engine), // current long/short legs (for the Auto-Pilot copy)
    metrics: summarize(equityCurve, { years, trades, periodsPerYear: intraday ? inferPeriodsPerYear(master) : undefined }),
    costs: { model: cm.kind, feesPaid: +feesCharged(engine).toFixed(2) },
    liquidity: { cap: PARTICIPATION_CAP, checked: liqChecked, flagged: liqFlagged },
    ...(tradeLog ? { trades: tradeLog, decision: lastDecision } : {}),
  };
}

export { runPairsBacktest, selectPairs, corr, olsSlope, ar1 };
