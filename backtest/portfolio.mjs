// ---------------------------------------------------------------------------
// backtest/portfolio.mjs
// The MULTI-COMPANY backtester: replays a BASKET strategy — which dynamically
// PICKS and REBALANCES a portfolio of the best names from a universe of stocks —
// THROUGH the real simulation engine, sharing one pot of virtual capital.
//
// Like the single-symbol backtester it has NO LOOK-AHEAD and runs on the REAL
// engine (so the MASTER money invariant holds by construction — every rupee moves
// only via engine.placeOrder / updateEquityPrice, never a side ledger):
//
//   * Each rebalance (every `rebalanceBars` bars) it SCORES every name in the
//     universe — by a rule expression, or a local ML model (backtest/ml.mjs) that
//     falls back to the rule when it can't help — using ONLY data up to that bar,
//     keeps the top `k`, and weights them (equal / rank / inverse-volatility).
//   * The chosen target is executed ONE BAR LATER (the same one-bar lag as the
//     single-symbol backtester), then HELD until the next rebalance — so turnover
//     is monthly, not daily.
//   * Different stocks have different listing dates / occasional missing bars, so
//     we first ALIGN them onto a master timeline: a forward-filled price grid for
//     MARKING / EXECUTION, plus a per-symbol real-bar index map for RANKING (so an
//     indicator never sees a fake forward-filled bar).
// ---------------------------------------------------------------------------

import { freshEngine, snapshotPositions, feesCharged } from './harness.mjs';
import { summarize, inferPeriodsPerYear } from './metrics.mjs';
import { flatCosts, eqFillPrice } from './costs.mjs';
import { evalNode, describeExpr } from './dsl.mjs';
import { retStdev } from './strategies.mjs';
import { computeComposite } from './factors.mjs';
import { meanVarWeights, riskParityWeights, riskContributions } from './optimizer.mjs';

// Align many symbols' candle series onto one master timeline.
//   master      : numeric-sorted, de-duped union of every symbol's (and the market
//                 proxy's) timestamps.
//   priceGrid   : per symbol, master-length, FORWARD-FILLED with the last real
//                 close at-or-before each master time, or null BEFORE the symbol's
//                 first real bar. Used ONLY for marking / executing trades.
//   realIdx     : per symbol, master-length, the index into the symbol's OWN real
//                 close array of its latest real bar at-or-before master[gi], or -1
//                 if it has not listed yet. Used for RANKING / features (so they
//                 never read a forward-filled bar -> no fake zero-return bars).
// A symbol is tradeable at gi iff realIdx[sym][gi] >= 0.
function alignSeries(dataBySymbol, marketSeries = null) {
  const symbols = Object.keys(dataBySymbol).filter((s) => Array.isArray(dataBySymbol[s]) && dataBySymbol[s].length).sort();
  const all = [];
  for (const s of symbols) for (const c of dataBySymbol[s]) all.push(c.t);
  if (marketSeries) for (const c of marketSeries) all.push(c.t);
  const master = [...new Set(all)].sort((a, b) => a - b); // NUMERIC sort, not lexicographic

  const priceGrid = {}, realIdx = {}, closesBy = {}, timesBy = {}, volsBy = {}, rawsBy = {};
  const fill = (series) => {
    const times = series.map((c) => c.t), closes = series.map((c) => c.c);
    // Volume + raw (unadjusted) close per REAL bar — read via realIdx by the
    // liquidity participation flag. Optional fields (injected test data / synthetic
    // series carry neither); everything else ignores them, so grids are unchanged.
    const vols = series.map((c) => (c.v != null ? c.v : null));
    const raws = series.map((c) => (c.craw != null ? c.craw : c.c));
    const pg = new Array(master.length), ri = new Array(master.length);
    let p = -1; // pointer into this series (both arrays are ascending -> one pass)
    for (let gi = 0; gi < master.length; gi++) {
      while (p + 1 < times.length && times[p + 1] <= master[gi]) p++;
      // Once p >= 0 it never goes back, so only LEADING (pre-listing) entries are null.
      pg[gi] = p < 0 ? null : closes[p];
      ri[gi] = p;
    }
    return { pg, ri, times, closes, vols, raws };
  };
  for (const s of symbols) {
    const f = fill(dataBySymbol[s]);
    priceGrid[s] = f.pg; realIdx[s] = f.ri; closesBy[s] = f.closes; timesBy[s] = f.times; volsBy[s] = f.vols; rawsBy[s] = f.raws;
  }
  let marketGrid = null, marketRealIdx = null, marketCloses = null;
  if (marketSeries && marketSeries.length) {
    const f = fill(marketSeries);
    marketGrid = f.pg; marketRealIdx = f.ri; marketCloses = f.closes;
  }
  return { master, symbols, priceGrid, realIdx, closesBy, timesBy, volsBy, rawsBy, marketGrid, marketRealIdx, marketCloses };
}

// Compute the target WEIGHT for each chosen name (sums to `gross`, <= 1).
// `optimizer` (optional) carries the chosen names' trailing returns matrix for the
// mean-variance / risk-parity weightings; equal/rankw/volinv ignore it (so those
// paths are byte-identical to before — the existing 3-arg callers are unchanged).
function weightsFor(top, weighting, gross, optimizer = null) {
  const m = top.length;
  if (!m) return [];
  // Optimiser weightings need the chosen names' covariance. If `optimizer` is missing
  // or the solve is singular / degenerate, DEGRADE GRACEFULLY to inverse-vol (which
  // itself falls back to equal) — mirroring the ML ranker's graceful fallback.
  if (weighting === 'meanvar' || weighting === 'riskparity') {
    if (optimizer && Array.isArray(optimizer.cols) && optimizer.cols.length === m) {
      const w = weighting === 'meanvar'
        ? meanVarWeights(optimizer.cols, optimizer.mu, gross, optimizer.maxWeight)
        : riskParityWeights(optimizer.cols, gross, optimizer.maxWeight);
      // Accept only a finite, long-only AND ~fully-invested result (sums to gross). A
      // per-name cap too tight to fill the budget (maxWeight·k < 1) would otherwise leave
      // capital idle — degrade to inverse-vol (which always sums to gross) instead, so the
      // documented "fully-invested" contract holds for any spec (hand-authored or evolved).
      if (w && w.length === m && w.every((x) => Number.isFinite(x) && x >= 0) && w.reduce((a, b) => a + b, 0) >= gross - 1e-6) return w;
    }
    return weightsFor(top, 'volinv', gross); // graceful fallback (singular cov / infeasible cap / no window)
  }
  if (weighting === 'rankw') {
    // Linearly more to higher-ranked names: K, K-1, ... 1 normalised to `gross`.
    const denom = (m * (m + 1)) / 2;
    return top.map((_, i) => (gross * (m - i)) / denom);
  }
  if (weighting === 'volinv') {
    // Inverse-volatility: calmer names get more. Guard null / ~0 vol (Infinity)
    // by filling a missing inverse with the SMALLEST finite one (least weight).
    const invs = top.map((t) => (t.vol != null && t.vol > 1e-6 ? 1 / t.vol : null));
    const finite = invs.filter((x) => x != null);
    if (!finite.length) return top.map(() => gross / m); // no usable vol -> equal
    const floorInv = Math.min(...finite);
    const filled = invs.map((x) => (x == null ? floorInv : x));
    const sum = filled.reduce((a, b) => a + b, 0);
    return filled.map((x) => (gross * x) / sum);
  }
  return top.map(() => gross / m); // 'equal'
}

// `intraday: true` annualises the Sharpe by the master timeline's own bars-per-year
// (like the single-symbol backtester) instead of the daily 252 — so an intraday basket
// isn't scored as if its bars were days. Everything else is interval-agnostic; daily
// baskets are byte-identical (the default leaves periodsPerYear at 252).
// COSTS: pass a `costModel` (backtest/costs.mjs — the all-in Indian delivery
// schedule) for honest results; without one the legacy flat `costBps` applies,
// byte-identical to the old behaviour (kept for tests/back-compat).
function runPortfolioBacktest({ spec, dataBySymbol, marketSeries = null, cash = 10_000_000, costBps = 5, costModel = null, rankSource = null, recordTrades = false, intraday = false, _hook = null, alignCache = null }) {
  // Operate on the universe in a CANONICAL (sorted) order so floating-point sums
  // (equity, weights) are identical regardless of input key order -> deterministic.
  const universe = [...spec.universe].filter((s) => Array.isArray(dataBySymbol[s]) && dataBySymbol[s].length).sort();
  const dataForUniverse = {};
  for (const s of universe) dataForUniverse[s] = dataBySymbol[s];
  // Reuse a PASS-SCOPED aligned grid across baskets that share a universe (the leaderboard
  // computes many baskets over the same wide field). alignSeries is a pure function
  // of (dataForUniverse, marketSeries) and READ-ONLY downstream (the loop only reads priceGrid/
  // realIdx/closesBy), and within ONE computeStandings pass the data is fixed — so two baskets
  // over the same universe get an IDENTICAL grid; build it once. Byte-identical results, just
  // cheaper. The cache is created fresh per pass by the caller (no cross-pass staleness); absent
  // it (getBotDetail, the CLI, the evolve scorer), behaviour is exactly as before.
  let A;
  if (alignCache) {
    // Key the grid by the ACTUAL DATA it is built from, not just the universe NAMES. A name-only
    // key would let two baskets over the same names but DIFFERENT data (a different bar interval,
    // e.g. a future intraday basket, or a different market series) collide and silently inherit the
    // wrong grid. Each name's (first ts : last ts : length) + the market series' fingerprint is a
    // cheap, exact discriminator: same data -> same key (the intended sharing), different data ->
    // different key. Cheap (O(universe), reads array ends only).
    // first ts + last ts + length distinguishes a different bar INTERVAL (the real concern); first
    // close + last close additionally distinguish same-timeline-but-different-prices (belt-and-suspenders
    // — can't arise for one (symbol, interval) in a pass, but keeps the key exact under any future shape).
    const fp = (arr) => (arr && arr.length ? `${arr[0].t}:${arr[arr.length - 1].t}:${arr.length}:${arr[0].c}:${arr[arr.length - 1].c}` : '0');
    const ckey = universe.map((s) => `${s}@${fp(dataForUniverse[s])}`).join(',') + '|m' + fp(marketSeries);
    A = alignCache.get(ckey);
    if (!A) { A = alignSeries(dataForUniverse, marketSeries); alignCache.set(ckey, A); }
  } else {
    A = alignSeries(dataForUniverse, marketSeries);
  }
  const { master, priceGrid, realIdx, closesBy } = A;

  const engine = freshEngine(cash);
  const cm = costModel || flatCosts(costBps);
  // Liquidity honesty flag (see backtester.mjs): count fills whose rupee value
  // exceeds this share of the bar's real traded value (volume × raw close).
  const PARTICIPATION_CAP = 0.10;
  let liqChecked = 0, liqFlagged = 0;
  const flagLiquidity = (s, gi, qty, fillPrice) => {
    const idx = realIdx[s][gi];
    const vol = idx >= 0 ? A.volsBy[s][idx] : null;
    if (!(Number.isFinite(vol) && vol > 0)) return;
    liqChecked++;
    if (qty * fillPrice > PARTICIPATION_CAP * vol * (A.rawsBy[s][idx] || priceGrid[s][gi])) liqFlagged++;
  };
  const gross = spec.gross == null ? 1 : spec.gross;
  const weighting = spec.weighting || 'equal';
  const k = spec.k;
  const rebalanceBars = spec.rebalanceBars;
  const covLookback = spec.covLookback || 63; // trailing window for the optimiser's covariance
  const maxWeight = spec.maxWeight || 1;       // per-name weight cap (optimiser weightings)
  const inst = {}, key = {};
  for (const s of universe) { inst[s] = { kind: 'EQ', symbol: s, lotSize: 1 }; key[s] = `EQ:${s.toUpperCase()}`; }

  const equityCurve = [];
  let targetW = null;       // weights to apply at the NEXT bar (one-bar lag)
  let pending = false;      // a rebalance was decided last bar; execute it now
  let lastRebalGi = -Infinity;
  let trades = 0;
  // The LATEST rebalance decision (only captured in recording mode) — powers the
  // per-bot page's "why each stock was chosen": every candidate's rank score +
  // indicators, which were chosen, and (for ML baskets) the model's feature weights.
  let lastDecision = null;
  // A human-readable label for the ranking metric, reused in every per-trade reason.
  const rankMetric = spec.mlConfig ? `the ${spec.mlConfig.model} model` : spec.factors ? 'the multi-factor model' : describeExpr(spec.rank);
  // The rank context of the LAST rebalance, used to explain the NEXT bar's trades (why a
  // name was entered/exited). Captured only in recording mode.
  let lastRankCtx = null;
  // Fuller, plain-English "why this trade" text — names the stock, the metric, its rank
  // AND its score, and what that meant for the basket. (Computed only in recording mode.)
  const rankAt = (info) => (info ? `#${info.rank} of ${lastRankCtx.N}${info.score != null ? ` (score ${(+info.score).toFixed(3)})` : ''}` : '');
  const buyReason = (s, curQty) => {
    if (!lastRankCtx) return 'Bought toward the target weight.';
    const info = lastRankCtx.rankBySym.get(s);
    return curQty === 0
      ? `Entered ${s} — ${rankMetric} ranked it ${rankAt(info)} this rebalance, so it made the cut into the basket's top ${lastRankCtx.K} holdings and was bought to its target weight.`
      : `Added to ${s} — it held its place in the top ${lastRankCtx.K} (now ${rankAt(info)}); topping the position back up to its target weight.`;
  };
  const sellReason = (s, desiredQty) => {
    if (!lastRankCtx) return 'Reduced the position.';
    if (!lastRankCtx.riskOn) return `Risk-off — the market filter (NIFTY trend) flipped to "cash", so the basket sold every holding and is sitting fully in cash this cycle to sidestep a falling market.`;
    if (lastRankCtx.chosen.has(s) && desiredQty > 0) return `Trimmed ${s} back to its target weight — still a holding, just rebalanced down so no single name runs over its allocation.`;
    const info = lastRankCtx.rankBySym.get(s);
    return info
      ? `Exited ${s} — ${rankMetric} dropped it to ${rankAt(info)}, out of the top ${lastRankCtx.K}, so a stronger name took its slot and this one was sold.`
      : `Exited ${s} — it no longer passes the basket's eligibility gate, so it was sold and the cash redeployed into eligible names.`;
  };
  // Optional per-trade log (for the bot-history UI): each rebalance fill, with the
  // master-timeline timestamp, the stock, side, qty, price, realised P&L booked, and a
  // plain-English REASON ("why this buy/sell").
  const tradeLog = recordTrades ? [] : null;
  const logTrade = (t, s, side, qty, fillPrice, realisedBefore, reason) => {
    if (!tradeLog) return;
    tradeLog.push({ t, symbol: s, side, qty, price: +fillPrice.toFixed(2), value: Math.round(qty * fillPrice), realised: +(engine.realisedTotal() - realisedBefore).toFixed(2), reason: reason || '' });
  };

  for (let gi = 0; gi < master.length; gi++) {
    // (a) MARK every listed name to its (forward-filled) clean close — silent.
    for (const s of universe) {
      const px = priceGrid[s][gi];
      if (Number.isFinite(px) && px > 0) engine.updateEquityPrice(s, px, true);
    }

    // (b) EXECUTE the target decided on the PREVIOUS rebalance bar (one-bar lag).
    if (pending) {
      const equity = engine.equity(); // captured once, like the single-symbol backtester
      // SELL first (frees cash for the buys), then BUY — names not in the target
      // have weight 0, so they are driven to flat.
      for (const s of universe) {
        const px = priceGrid[s][gi];
        if (!(Number.isFinite(px) && px > 0)) continue;
        const pos = engine.state.positions[key[s]];
        const curQty = pos ? pos.qty : 0;
        const desiredQty = Math.max(0, Math.floor(((targetW[s] || 0) * equity) / px));
        if (desiredQty < curQty) {
          const sellPrice = eqFillPrice(cm, 'SELL', px), r0 = engine.realisedTotal();
          const order = engine.placeOrder({ instrument: inst[s], side: 'SELL', orderType: 'MARKET', lots: curQty - desiredQty, price: sellPrice });
          if (order.status === 'FILLED') { // reducing SELLs open no new exposure so they don't reject — guard for safety/consistency with pairs.mjs/fno.mjs
            trades++;
            flagLiquidity(s, gi, curQty - desiredQty, sellPrice);
            logTrade(master[gi], s, 'SELL', curQty - desiredQty, sellPrice, r0, tradeLog ? sellReason(s, desiredQty) : '');
          }
        }
      }
      for (const s of universe) {
        const px = priceGrid[s][gi];
        if (!(Number.isFinite(px) && px > 0)) continue;
        const pos = engine.state.positions[key[s]];
        const curQty = pos ? pos.qty : 0;
        const desiredQty = Math.max(0, Math.floor(((targetW[s] || 0) * equity) / px));
        if (desiredQty > curQty) {
          const buyPrice = eqFillPrice(cm, 'BUY', px);
          const affordable = Math.floor(engine.availableFunds() / buyPrice); // never overspend
          const qty = Math.min(desiredQty - curQty, affordable);
          // Defensive: the `affordable` cap (availableFunds re-read per name) means this
          // MARKET buy can't be rejected for funds — but only count/log it if it actually
          // FILLED, mirroring pairs.mjs/fno.mjs so a rejection can never log a phantom
          // trade or skew the basket's recorded weights.
          if (qty > 0) { const r0 = engine.realisedTotal(); const order = engine.placeOrder({ instrument: inst[s], side: 'BUY', orderType: 'MARKET', lots: qty, price: buyPrice }); if (order.status === 'FILLED') { trades++; flagLiquidity(s, gi, qty, buyPrice); logTrade(master[gi], s, 'BUY', qty, buyPrice, r0, tradeLog ? buyReason(s, curQty) : ''); } }
        }
      }
      pending = false;
    }

    // (c) Record account value, marked at this bar's clean close (one point/bar).
    equityCurve.push(engine.equity());

    // (d) DECIDE the next target on a rebalance bar, using ONLY data up to gi.
    if (gi - lastRebalGi >= rebalanceBars) {
      lastRebalGi = gi;
      const decisionTime = master[gi];

      // Portfolio-level risk-off: if the market gate is present and not satisfied
      // (or the proxy has no data yet), sit entirely in cash this cycle.
      let riskOn = true;
      if (spec.marketGate !== undefined) {
        const mi = A.marketRealIdx ? A.marketRealIdx[gi] : -1;
        riskOn = mi >= 0 && evalNode(spec.marketGate, A.marketCloses, mi) === true;
      }

      // Gather the listed, gate-passing names (with their OWN closes + real bar index).
      const eligible = [];
      if (riskOn) {
        for (const s of universe) {
          const ri = realIdx[s][gi];
          if (ri < 0) continue; // not listed yet
          const realCloses = closesBy[s];
          if (spec.gate !== undefined && evalNode(spec.gate, realCloses, ri) !== true) continue;
          eligible.push({ sym: s, closes: realCloses, ri });
        }
      }
      // A FACTOR basket scores names by a CROSS-SECTIONAL composite — compute every
      // eligible name's factor z-scores across THIS rebalance's set (look-ahead-safe;
      // a name missing any factor is dropped). Plain-rule / ML baskets skip this.
      let factorBySym = null;
      if (spec.factors && eligible.length) {
        const comp = computeComposite(eligible, spec.factors);
        factorBySym = new Map(comp.scored.map((x) => [x.sym, x]));
      }
      const candidates = [];
      for (const e of eligible) {
        const { sym: s, closes: realCloses, ri } = e;
        const ruleScore = evalNode(spec.rank, realCloses, ri);
        let score = ruleScore;
        let factorBreakdown = null;
        if (spec.factors) {
          const fc = factorBySym && factorBySym.get(s);
          if (!fc) continue; // a factor wasn't warm for this name -> exclude it
          score = fc.score;
          factorBreakdown = fc.factors;
        } else if (rankSource) {
          const ml = rankSource(s, realCloses, ri, decisionTime);
          if (ml != null && Number.isFinite(ml)) score = ml; // else: graceful fallback to the rule
        }
        if (score == null || !Number.isFinite(score)) continue;
        const c = { sym: s, score, ruleScore: Number.isFinite(ruleScore) ? ruleScore : -Infinity, vol: retStdev(realCloses, ri, 20) };
        if (factorBreakdown) c.factors = factorBreakdown;
        candidates.push(c);
      }
      // Sort best-first; tie-break by the rule score, then the NAME (a total order,
      // so selection is fully deterministic regardless of sort stability).
      candidates.sort((a, b) => b.score - a.score || b.ruleScore - a.ruleScore || (a.sym < b.sym ? -1 : 1));
      const top = candidates.slice(0, k);
      // Optimiser weightings (mean-variance / risk-parity) need the chosen names'
      // covariance — build a trailing returns matrix: each name's OWN last covLookback
      // real returns, ending at its decision bar (ri), so it reads no future data. If
      // any chosen name lacks a full window it stays null and weightsFor falls back to
      // inverse-vol.
      let optimizer = null;
      if ((weighting === 'meanvar' || weighting === 'riskparity') && top.length) {
        const cols = [];
        let ok = true;
        for (const t of top) {
          const tri = realIdx[t.sym][gi];
          const tcl = closesBy[t.sym];
          if (tri < covLookback) { ok = false; break; }
          const rets = new Array(covLookback);
          for (let u = 0; u < covLookback; u++) {
            const j = tri - covLookback + 1 + u;
            const prev = tcl[j - 1];
            if (!(prev > 0)) { ok = false; break; }
            rets[u] = tcl[j] / prev - 1;
          }
          if (!ok) break;
          cols.push(rets);
        }
        if (ok) optimizer = { cols, mu: top.map((t) => t.score), maxWeight };
      }
      const w = weightsFor(top, weighting, gross, optimizer);
      targetW = {};
      top.forEach((t, i) => { targetW[t.sym] = w[i]; });
      pending = true; // execute at the NEXT bar

      // Record this rebalance's full decision (recording mode only — the per-bot page).
      // candidates is already sorted best-first; we expose each name's score + the
      // indicators that drove it, which the top-k were, and the ML feature weights.
      if (tradeLog) {
        const chosenW = new Map();
        top.forEach((t, i) => chosenW.set(t.sym, w[i]));
        // Rank context for explaining the NEXT bar's trades (entered/exited/trimmed + rank).
        const rankBySym = new Map();
        candidates.forEach((c, idx) => rankBySym.set(c.sym, { rank: idx + 1, score: c.score }));
        lastRankCtx = { rankBySym, chosen: new Set(top.map((tt) => tt.sym)), N: candidates.length, K: k, riskOn };
        // For an OPTIMISER basket, surface each chosen name's share of portfolio risk
        // (so the per-bot page can show "risk contributions"). Off the hot path — only
        // computed here in recording mode (it rebuilds the covariance).
        let riskContribBySym = null;
        if ((weighting === 'meanvar' || weighting === 'riskparity') && optimizer) {
          // Re-derive the OPTIMISER's own weights (the same call weightsFor makes) and surface "risk
          // contributions" ONLY when the optimiser actually SUCCEEDED. If weightsFor degraded to
          // inverse-vol (singular covariance / infeasible cap), `w` holds the FALLBACK weights — and a
          // Risk % computed on those yet labelled as the optimiser's risk share would mislead.
          const wOpt = weighting === 'meanvar'
            ? meanVarWeights(optimizer.cols, optimizer.mu, gross, optimizer.maxWeight)
            : riskParityWeights(optimizer.cols, gross, optimizer.maxWeight);
          const used = wOpt && wOpt.length === top.length && wOpt.every((x) => Number.isFinite(x) && x >= 0) && wOpt.reduce((a, b) => a + b, 0) >= gross - 1e-6;
          if (used) {
            const rc = riskContributions(optimizer.cols, wOpt);
            if (rc) { riskContribBySym = {}; top.forEach((t, i) => { riskContribBySym[t.sym] = rc[i]; }); }
          }
        }
        lastDecision = {
          t: decisionTime,
          riskOn,
          weighting,
          universeSize: universe.length,
          passedGate: candidates.length, // names that cleared the gate (and risk-on)
          candidates: candidates.map((c) => ({
            sym: c.sym,
            score: Number.isFinite(c.score) ? +c.score.toFixed(4) : null,
            ruleScore: Number.isFinite(c.ruleScore) ? +c.ruleScore.toFixed(4) : null,
            vol: c.vol != null && Number.isFinite(c.vol) ? +c.vol.toFixed(4) : null,
            chosen: chosenW.has(c.sym),
            weightPct: chosenW.has(c.sym) ? +(chosenW.get(c.sym) * 100).toFixed(1) : 0,
            // Per-factor z-score breakdown (factor baskets) + risk share (optimiser baskets).
            ...(c.factors ? { factors: c.factors } : {}),
            ...(riskContribBySym && riskContribBySym[c.sym] != null ? { riskPct: riskContribBySym[c.sym] } : {}),
          })),
          // Only surface the model's weights when it was actually CONSULTED this cycle.
          // On a risk-off cycle the candidates loop (the sole caller of rankSource) is
          // skipped, so getWeights() would return a STALE model from an earlier risk-on
          // rebalance — misdating the "what the model learned" panel. Null instead.
          mlWeights: (riskOn && rankSource && typeof rankSource.getWeights === 'function') ? rankSource.getWeights() : null,
        };
      }
    }
  }

  // --- describe the FINAL portfolio for the leaderboard ----------------------
  const eqNow = engine.equity();
  const holdings = [];
  for (const s of universe) {
    const pos = engine.state.positions[key[s]];
    if (!pos || pos.qty === 0) continue;
    const last = engine.state.lastPrices[key[s]];
    if (last == null) continue;
    const value = pos.qty * last;
    holdings.push({ symbol: s, weightPct: eqNow > 0 ? +((value / eqNow) * 100).toFixed(1) : 0 });
  }
  holdings.sort((a, b) => b.weightPct - a.weightPct);
  const position = holdings.length
    ? holdings.map((h) => `${h.symbol} ${Math.round(h.weightPct)}%`).join(' · ')
    : 'flat (cash)';

  const years = master.length >= 2 ? (master[master.length - 1] - master[0]) / (365.25 * 864e5) : undefined;
  if (typeof _hook === 'function') _hook(engine); // lets the invariant test inspect the engine

  return {
    name: spec.name,
    note: spec.note || '',
    equityCurve,
    times: master, // master-timeline timestamp per equityCurve point (for the leaderboard)
    position,
    holdings,
    finalCash: engine.state.cash,
    finalPositions: snapshotPositions(engine), // current holdings (for the Auto-Pilot copy)
    metrics: summarize(equityCurve, { years, trades, periodsPerYear: intraday ? inferPeriodsPerYear(master) : undefined }),
    costs: { model: cm.kind, feesPaid: +feesCharged(engine).toFixed(2) },
    liquidity: { cap: PARTICIPATION_CAP, checked: liqChecked, flagged: liqFlagged },
    ...(tradeLog ? { trades: tradeLog, decision: lastDecision } : {}),
  };
}

export { runPortfolioBacktest, alignSeries, weightsFor };
