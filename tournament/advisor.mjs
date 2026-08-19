// ---------------------------------------------------------------------------
// tournament/advisor.mjs
// THE ADVISOR — "Today's Suggestions" (real-money guidance, suggestion-only).
//
// Turns the tournament's champion bot into guidance for REAL-money trades placed
// BY HAND, outside the app. This module is the server half of that:
//
//   1. Once per new daily bar it RECORDS the champion's target portfolio into an
//      APPEND-ONLY suggestion log — written BEFORE the outcome of those targets
//      is knowable, so the log is a no-hindsight forward record (the same honesty
//      contract as the Auto-Pilot walk-forward). Old entries are NEVER edited.
//   2. It SCORES the log: the return an account following each day's suggestions
//      would have earned (net of ESTIMATED real delivery costs), against BOTH
//      NIFTY buy-and-hold AND an equal-weight portfolio of the whole universe —
//      the "beat the same universe, not the index" rule (METHODOLOGY.md). The
//      benchmarks are gross; keeping the suggestion track net-of-costs is the
//      conservative direction.
//   3. It carries the FAIR-BENCHMARK FINDING (measured offline, constants below)
//      that decides how much the panel is allowed to claim for the champion.
//
// SUGGESTION-ONLY, ALWAYS: nothing here (or anywhere) places a real order — the
// app has no broker integration by design and never will. The log and the panel
// exist so you can judge the guidance's honest forward record before (and
// while) trusting it with real decisions.
//
// Everything is a PURE function of injected data (seriesFor / getBotDetail /
// the state object), so the whole layer is unit-testable without a network and
// deterministic for a given data state — no Date.now(), no RNG. Zero new deps.
// ---------------------------------------------------------------------------

// How many days of no-hindsight history the suggestion log must accumulate before
// the panel drops its "track record before trust" banner. A config knob: override
// per instance via createTournament({ advisorMinDays }).
const ADVISOR_MIN_DAYS = 90;

// --- The fair-benchmark finding (measured 2026-08-20; reproduce any time) ----
// `node backtest/research/universe-bench.mjs` — the holdout window (2020-01-01 →
// data end), full delivery costs, validation anchors reproduced first. Result:
// the champion strategy's out-of-sample edge over the INDEX (+0.18 xSharpe) does
// NOT establish stock-picking skill — a no-information portfolio of the same
// universe beat it (0.87 volinv / 0.91 equal-weight vs its 0.59), and a k-matched
// null distribution puts its selection inside the noise band. So the panel must NOT claim
// the champion "beats the market" as evidence of skill: it tracks the champion,
// and the champion's selection edge over a fair benchmark is unproven (it
// TRAILED the fair bar out-of-sample). Recorded as constants because the
// research lab is offline-only (nothing live imports backtest/research/); the
// forward log above is what measures this claim from here on.
const ADVISOR_BENCHMARK_FINDING = {
  measuredAt: '2026-08-20', // the gate ablation + k-matched null distribution
  window: '2020-01-01 → 2026-07-03', // the data end AT measurement — a literal date, so the figure is reproducible
  reproduce: 'node backtest/research/universe-bench.mjs',
  // WHO this was measured for. The walk-forward champion can switch bots over time;
  // the banner must not quote a verdict measured for one strategy as if it described
  // another — the client degrades to generic wording when the ids differ.
  measuredFor: 'xsmom-research',
  measuredForName: 'Cross-sectional momentum (12-1)',
  indexSharpe: 0.41, // NIFTYBEES buy & hold, excess-of-rf
  universeVolinvSharpe: 0.87, // whole-universe, no signal, inverse-vol weights
  universeEqualSharpe: 0.91, // whole-universe, no signal, equal weights
  championStrategySharpe: 0.59, // the live champion's strategy over the same window
  edgeVsUniverse: -0.32, // WHOLE SPEC (gate included) vs the HARDER of the two WHOLE-universe controls
  verdict: 'trails-universe', // 'beats-universe' | 'matches-universe' | 'trails-universe'
  //
  // ...but −0.32 is NOT a measurement of selection, and neither was the first attempt to
  // correct it. The whole-universe controls differ from the spec in THREE ways at once:
  // the ranking signal, the marketGate, and the holdings count (k=104 vs k=10). Fixing only
  // the gate still left the k mismatch, and a k=104 portfolio carries a diversification
  // premium worth ~0.1–0.2 Sharpe that has nothing to do with stock picking — which is what
  // produced the earlier "the sign flips" reading. That reading was an artifact; do not
  // restore it.
  //
  // The comparison METHODOLOGY.md §139-142 actually prescribes — identical machinery (same
  // k, weighting, cadence, costs, window, gate), ranking signal replaced by noise, plus the
  // NULL DISTRIBUTION of seeded random portfolios of the same size — gives:
  //   gate OFF both arms: strategy 0.81 vs null median 0.76  ->  +0.06, and 7 of 20 random
  //                       draws BEAT the strategy (~65th percentile: inside the noise band)
  //   gate ON  both arms: strategy 0.59 vs null median 0.35  ->  +0.24, 1 of 20 draws beat it
  // So selection is NON-NEGATIVE both ways but NOT significant ungated. "Unproven" stands;
  // the reason is that the effect sits inside the noise band, NOT that its sign flips.
  //
  // What remains settled and is safe to state: the WHOLE SPEC trailed a passive portfolio of
  // the same names over this window. Note even that comparison is not bias-free — part of the
  // ~0.5 gap between those controls and the index is equal-weight and breadth premia, which
  // are not survivorship. Never harden any of this into "its stock-picking is bad".
  selectionVsNullGateOff: 0.06,
  selectionVsNullGateOn: 0.24,
  nullDrawsBeatingStrategyUngated: 7, // of 20 seeded k-matched random portfolios
  nullSampleSize: 20,
};

// IST calendar date of an epoch-ms timestamp (same formula as tournament.mjs —
// a pure shift, safe on any host timezone).
const istDate = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);

// The close at-or-before time t in a sorted [{t,c}] series (binary search), or
// null when the series is empty / starts after t. Suggestion scoring marks every
// portfolio at recorded bar times, so a missing close must degrade to "treat that
// slice as cash", never to a fabricated price.
function closeAtOrBefore(series, t) {
  if (!Array.isArray(series) || !series.length || series[0].t > t) return null;
  let lo = 0, hi = series.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (series[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  const c = series[lo].c;
  return Number.isFinite(c) && c > 0 ? c : null;
}

// --- Building one day's entry ----------------------------------------------
// The champion is the SAME "one brain" the Auto-Pilot follows (the walk-forward's
// point-in-time best-Sharpe pick), so the suggestions, the paper copy and the
// track record all describe one strategy. Returns null when nothing can honestly
// be issued today (no champion yet, or its market data isn't loaded — the same
// followable guard that stops the Auto-Pilot's cold-boot liquidation).
function buildAdvisorEntry({ autopilot, getBotDetail, seriesFor }) {
  const nifty = seriesFor('NIFTY');
  if (!nifty.length) return null;
  const edge = nifty[nifty.length - 1]; // the data edge = the suggestion's "as of" bar
  const champ = autopilot && autopilot.currentBot;
  if (!champ) return null;
  const detail = getBotDetail(champ.id);
  if (!detail || detail.ok === false || !detail.mirror || detail.mirror.followable === false) return null;

  const positions = (detail.mirror.positions || []).filter((p) => p && p.qty !== 0);
  // GROUND RULE: real-capital guidance covers CASH-MARKET equity/ETF buys only.
  // Anything a hand-placed delivery order can't faithfully mirror is EXCLUDED —
  // with the reason stated, never silently scaled:
  //   * an F&O champion (option prices here are modelled/indicative — there is no
  //     free real chain, so a rupee suggestion would be a made-up number);
  //   * a PAIRS champion or any SHORT leg (cash delivery cannot hold a short);
  //   * any non-equity instrument that sneaks into the book.
  // An ineligible day still logs (targets = [], scored as cash): "stand aside"
  // was the day's guidance, and the trust clock should count it honestly.
  let reason = null;
  if (detail.kind === 'FNO') reason = 'the champion is an options (F&O) bot — its option prices are modelled/indicative, so honest rupee suggestions for hand-placed real orders are not possible';
  else if (detail.kind === 'PAIRS') reason = 'the champion is a market-neutral pairs bot — half its book is short positions, which cash-market delivery orders cannot hold';
  else if (positions.some((p) => (p.kind || 'EQ') !== 'EQ')) reason = 'the champion currently holds derivative (F&O) legs, which cannot be mirrored with cash-market delivery orders';
  else if (positions.some((p) => p.qty < 0)) reason = 'the champion currently holds short positions, which cash-market delivery orders cannot hold';
  const eligible = reason == null;

  const equity = detail.mirror.equity;
  // A bogus mirror equity must never be RECORDED — the log is the never-lose artifact,
  // and local persistence would keep a NaN/0-equity entry forever (only the Gist restore
  // sanitises). Better to skip the day than to write junk (same bar the sanitiser holds).
  if (!Number.isFinite(equity) || equity <= 0) return null;
  const targets = !eligible
    ? []
    : positions
        .filter((p) => Number.isFinite(p.price) && p.price > 0)
        .map((p) => ({
          symbol: p.symbol,
          qty: p.qty, // the bot's own share count (the client scales by capital/equity)
          price: +p.price.toFixed(2), // the recorded reference mark for scaling/display (scoring itself is close-to-close via closeAtOrBefore)
          weight: +((p.qty * p.price) / equity).toFixed(6), // fraction of the bot's equity
        }));

  return {
    date: istDate(edge.t), // one entry per IST data date — the append-once key
    t: edge.t,
    botId: detail.id,
    botName: detail.name,
    kind: detail.kind,
    eligible,
    reason,
    equity: Math.round(equity),
    targets,
  };
}

// Append-only: one entry per data date, later dates only, existing entries never
// touched. Returns true when an entry was actually appended (callers save() then).
function appendAdvisorEntry(state, entry) {
  if (!entry) return false;
  if (!Array.isArray(state.advisorLog)) state.advisorLog = [];
  const last = state.advisorLog[state.advisorLog.length - 1];
  if (last && last.date >= entry.date) return false; // already recorded this date
  state.advisorLog.push(entry);
  return true;
}

// Keep only well-formed entries from a RESTORED remote log (the Gist is externally
// editable, same trust model as sanitizeLiveMap): valid date + finite t, boolean
// eligible, positive equity, targets each with a symbol + finite numbers — and
// strictly ascending dates (the append-only invariant must survive a hand edit).
function sanitizeAdvisorLog(log) {
  if (!Array.isArray(log)) return [];
  const out = [];
  for (const e of log) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
    if (!Number.isFinite(e.t) || typeof e.eligible !== 'boolean') continue;
    if (!Number.isFinite(e.equity) || e.equity <= 0) continue;
    if (!Array.isArray(e.targets)) continue;
    const targets = e.targets.filter((p) => p && typeof p.symbol === 'string' && Number.isFinite(p.qty) && Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.weight));
    if (targets.length !== e.targets.length) continue; // a corrupt leg poisons the whole entry — drop it
    const prev = out[out.length - 1];
    if (prev && prev.date >= e.date) continue; // out-of-order/duplicate — keep the earlier record
    out.push({ ...e, targets });
  }
  return out;
}

// Thin a curve to at most `max` points (endpoints kept) — the log grows one entry
// per trading day forever, and this payload rides every 30s poll.
function thinCurve(points, max = 400) {
  if (!Array.isArray(points) || points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]);
  return out;
}

// --- Scoring the log ---------------------------------------------------------
// The no-hindsight forward track: chain each day's recorded targets over the NEXT
// day's actual closes. Entry i's book was written at bar t_i using only data ≤ t_i;
// the return over [t_i, t_(i+1)] is then measured with the later closes — so by
// construction nothing in the track could see the future. The book is marked as SHARES
// HELD (never as weights re-applied, which would silently rebalance to target every
// period for free), and turnover is the previous book DRIFTED to this bar versus the new
// target weights — the two halves must model the same thing or the track is incoherent.
// A symbol with no close at either end of a period is held FLAT (contributes nothing to
// the move), never a fabricated return. Returns null until there are 2+ entries to score.
//
// STAND-ASIDE SEMANTICS (must match the panel's advice): an INELIGIBLE entry means
// "no new equity guidance today — keep what you hold". So the score carries the
// PREVIOUS eligible entry's book through ineligible days unchanged (marked, no
// trade, no cost) — never a phantom sell-everything-and-rebuy round trip the panel
// never suggested. Cash only until the FIRST eligible entry. The carried book is marked
// as literal shares across those days, so a stand-aside stretch is a genuine hold, not a
// daily re-levering to a stale target.
function scoreAdvisorLog(log, { seriesFor, universe = [], costRates = { buyRate: 0, sellRate: 0 } }) {
  const entries = Array.isArray(log) ? log : [];
  if (entries.length < 2) return null;
  const nifty = seriesFor('NIFTY');
  // The EFFECTIVE book at each entry: its own targets when eligible, else the last
  // eligible book carried forward (the same object — so switchCost sees no diff).
  // `equity` rides along because turnover is priced against the book it belongs to.
  const effective = [];
  {
    let held = { targets: [], equity: 0 };
    for (const e of entries) {
      if (e.eligible) held = { targets: e.targets || [], equity: e.equity };
      effective.push(held);
    }
  }

  // Per-symbol series lookups are repeated across periods — fetch each once.
  const seriesCache = new Map();
  const closeAt = (symbol, t) => {
    if (!seriesCache.has(symbol)) seriesCache.set(symbol, seriesFor(symbol));
    return closeAtOrBefore(seriesCache.get(symbol), t);
  };

  // Estimated cost (as a fraction of account value) of moving from the previous
  // entry's book to this one's — buys pay buyRate, sells pay sellRate.
  //
  // Turnover is measured between the previous book DRIFTED FORWARD to this bar and the new
  // book's target weights. Both sides are weights (fractions of the follower's account), so
  // the measure is SCALE-FREE — which matters because consecutive entries can belong to
  // DIFFERENT champions whose equities differ by 2x or more (the walk-forward switches bots),
  // and an earlier share-count version divided the previous book's notional by the NEXT bot's
  // equity: on a champion switch that reported "sells 157% of the account", impossible for a
  // long-only book. Drifting also keeps the property that motivated moving off raw weights in
  // the first place: if the champion did not trade a single share, the drifted weights EQUAL
  // the new recorded weights, so turnover is exactly zero and no phantom cost is charged.
  const switchCost = (prev, next, tNext) => {
    if (prev === next) return 0; // a carried-forward (stand-aside) book trades nothing, by construction
    // The previous book, marked at THIS bar: each holding's shares at the new close, plus its
    // untouched cash. That is what the follower actually owns before rebalancing.
    const prevTargets = prev.targets || [];
    let driftedTotal = 0;
    const drifted = new Map();
    let investedAtPrev = 0;
    for (const p of prevTargets) {
      investedAtPrev += p.qty * p.price;
      const c = closeAt(p.symbol, tNext);
      const v = p.qty * (c != null ? c : p.price); // no close at this bar -> hold it flat, never fabricate
      drifted.set(p.symbol, (drifted.get(p.symbol) || 0) + v);
      driftedTotal += v;
    }
    // Cash the previous book was not holding in stock rides along undrifted.
    driftedTotal += Math.max(0, (prev.equity || 0) - investedAtPrev);
    let buys = 0, sells = 0;
    const seen = new Set();
    for (const p of next.targets || []) {
      seen.add(p.symbol);
      const wNext = p.weight;
      const wPrev = driftedTotal > 0 ? (drifted.get(p.symbol) || 0) / driftedTotal : 0;
      if (wNext > wPrev) buys += wNext - wPrev;
      else if (wPrev > wNext) sells += wPrev - wNext;
    }
    // A DROPPED name is sold in full, at its drifted weight.
    if (driftedTotal > 0) for (const [sym, v] of drifted) if (!seen.has(sym)) sells += v / driftedTotal;
    return buys * (costRates.buyRate || 0) + sells * (costRates.sellRate || 0);
  };

  let adv = 1, nif = 1, uni = 1, peak = 1, maxDD = 0;
  const curve = [{ t: entries[0].t, c: 1 }];
  const niftyCurve = [{ t: entries[0].t, c: 1 }];
  const universeCurve = [{ t: entries[0].t, c: 1 }];
  let costPaidPct = switchCost({ targets: [], equity: 0 }, effective[0], entries[0].t); // entering the first day's book
  adv *= 1 - costPaidPct;

  for (let i = 0; i + 1 < entries.length; i++) {
    const a = entries[i], b = entries[i + 1];
    // The suggested portfolio's return over [t_a, t_b] from the EFFECTIVE book at a —
    // marked as SHARES HELD, not as weights re-applied.
    //
    // This used to be `r += p.weight * (c1/c0 - 1)`, which silently rebalanced the book back
    // to its recorded target every single period, for free. That was consistent while costs
    // were also weight-based, but once turnover was moved to share counts the two halves of
    // one calculation modelled opposite things: the cost side said "nothing traded", the
    // return side kept trading. Measured error: ~17bp across one day with ordinary
    // dispersion, and ~100bp across a two-day carry — against a ~0.5%/yr phantom cost the
    // move to share counts existed to remove. The "tiny at daily steps" defence also does
    // not hold: this log records ~4 entries per 14 days, so the steps are 3–5 days, and a
    // stand-aside stretch re-levers a stale target at every bar.
    const bookValueAt = (eff, t) => {
      let invested = 0, held = 0;
      for (const p of eff.targets || []) {
        invested += p.qty * p.price;
        const c = closeAt(p.symbol, t);
        held += p.qty * (c != null ? c : p.price); // no close -> hold it FLAT, never fabricate
      }
      // Whatever the book was not holding in stock rides along as cash, undrifted.
      return held + Math.max(0, (eff.equity || 0) - invested);
    };
    const v0 = bookValueAt(effective[i], a.t);
    const v1 = bookValueAt(effective[i], b.t);
    const r = v0 > 0 ? v1 / v0 - 1 : 0;
    adv *= 1 + r;
    // Rebalancing INTO entry b's effective book pays the switch cost at t_b (zero
    // across a stand-aside day — the held book IS the previous book).
    const cost = switchCost(effective[i], effective[i + 1], b.t);
    adv *= 1 - cost;
    costPaidPct += cost;
    peak = Math.max(peak, adv);
    maxDD = Math.max(maxDD, 1 - adv / peak);
    // NIFTY buy & hold over the same bars.
    const n0 = closeAtOrBefore(nifty, a.t), n1 = closeAtOrBefore(nifty, b.t);
    if (n0 != null && n1 != null) nif *= n1 / n0;
    // Equal-weight universe over the same bars — the fair yardstick, forward.
    let uSum = 0, uCount = 0;
    for (const sym of universe) {
      const c0 = closeAt(sym, a.t);
      const c1 = closeAt(sym, b.t);
      if (c0 != null && c1 != null) { uSum += c1 / c0 - 1; uCount++; }
    }
    if (uCount) uni *= 1 + uSum / uCount;
    curve.push({ t: b.t, c: +adv.toFixed(6) });
    niftyCurve.push({ t: b.t, c: +nif.toFixed(6) });
    universeCurve.push({ t: b.t, c: +uni.toFixed(6) });
  }

  return {
    days: entries.length,
    from: entries[0].date,
    to: entries[entries.length - 1].date,
    retPct: +((adv - 1) * 100).toFixed(2), // net of estimated costs
    niftyPct: +((nif - 1) * 100).toFixed(2), // gross
    universeEqPct: +((uni - 1) * 100).toFixed(2), // gross
    estCostPct: +(costPaidPct * 100).toFixed(3), // cumulative est. costs the track paid
    maxDrawdownPct: +(maxDD * 100).toFixed(2),
    currentDrawdownPct: +((1 - adv / peak) * 100).toFixed(2),
    curve: thinCurve(curve),
    niftyCurve: thinCurve(niftyCurve),
    universeCurve: thinCurve(universeCurve),
  };
}

// --- The published payload (standings.advisor) -------------------------------
// A pure read of the log + the current walk-forward — cheap enough to rebuild on
// every standings assembly. `today`/`prev` give the client the recorded target
// books to diff and scale; the cost RATES ship so the client never duplicates the
// cost schedule; the benchmark finding fixes what the banner may claim.
function buildAdvisorPayload({ log, seriesFor, universe = [], minDays = ADVISOR_MIN_DAYS, costRates = { buyRate: 0, sellRate: 0 } }) {
  const entries = Array.isArray(log) ? log : [];
  // The FRESHEST recorded price for every symbol the log has ever carried, with the date
  // it was recorded on. The client needs this to price a name the champion has DROPPED.
  // Without it, a name absent from BOTH today's and the previous entry's targets fell all
  // the way back to the assumed book's own COST BASIS: a stock bought at ₹20 and now worth
  // ₹100 was suggested as "sell 2 @ ~₹20", which also mis-scaled every OTHER suggestion
  // that day (the book's value sets the capital ratio) and corrupted the persisted ledger.
  // Two ordinary situations reach it: the panel only advances its assumed book while the
  // tab is OPEN (so any gap longer than a day skips the entry that still listed the name),
  // and a single stand-aside day records no targets at all.
  const marks = {};
  for (const e of entries) for (const p of e.targets || []) marks[p.symbol] = { price: p.price, date: e.date, t: e.t };
  // The last entry BEFORE today that actually ISSUED guidance. Stand-aside entries record
  // targets: [], so diffing today against the raw previous entry announced every name the
  // user already holds as "New". The server's own scoring carries the last ELIGIBLE book
  // forward; the panel must describe the same book.
  let prevEligible = null;
  for (let i = entries.length - 2; i >= 0; i--) {
    if (entries[i].eligible && (entries[i].targets || []).length) { prevEligible = entries[i]; break; }
  }
  return {
    minDays,
    logDays: entries.length,
    ready: entries.length >= minDays,
    today: entries.length ? entries[entries.length - 1] : null,
    prev: entries.length > 1 ? entries[entries.length - 2] : null,
    prevEligible,
    marks,
    track: scoreAdvisorLog(entries, { seriesFor, universe, costRates }),
    costRates: { buyRate: costRates.buyRate || 0, sellRate: costRates.sellRate || 0 },
    benchmarkFinding: ADVISOR_BENCHMARK_FINDING,
  };
}

export {
  ADVISOR_MIN_DAYS,
  ADVISOR_BENCHMARK_FINDING,
  buildAdvisorEntry,
  appendAdvisorEntry,
  sanitizeAdvisorLog,
  scoreAdvisorLog,
  buildAdvisorPayload,
  closeAtOrBefore,
};
