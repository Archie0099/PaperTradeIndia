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

// --- The fair-benchmark finding (measured 2026-08-05; reproduce any time) ----
// `node backtest/research/universe-bench.mjs` — the holdout window (2020-01-01 →
// data end), full delivery costs, validation anchors reproduced first. Result:
// the champion strategy's out-of-sample edge over the INDEX (+0.18 xSharpe) is
// entirely SURVIVORSHIP — a no-information portfolio of the same universe beat
// it (0.87 volinv / 0.91 equal-weight vs its 0.59). So the panel must NOT claim
// the champion "beats the market" as evidence of skill: it tracks the champion,
// and the champion's selection edge over a fair benchmark is unproven (it
// TRAILED the fair bar out-of-sample). Recorded as constants because the
// research lab is offline-only (nothing live imports backtest/research/); the
// forward log above is what measures this claim from here on.
const ADVISOR_BENCHMARK_FINDING = {
  measuredAt: '2026-08-05',
  window: '2020-01-01 → data end',
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
  edgeVsUniverse: -0.32, // vs the HARDER of the two universe controls
  verdict: 'trails-universe', // 'beats-universe' | 'matches-universe' | 'trails-universe'
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
// day's actual closes. Entry i's weights were written at bar t_i using only data
// ≤ t_i; the return over [t_i, t_(i+1)] is then measured with the later closes —
// so by construction nothing in the track could see the future. Costs: every
// weight CHANGE pays the estimated real delivery schedule on the turnover (the
// track is net-of-costs; both benchmarks are gross — the conservative direction).
// A symbol with no close at either end of a period contributes 0 (held as cash),
// never a fabricated return. Returns null until there are 2+ entries to score.
//
// STAND-ASIDE SEMANTICS (must match the panel's advice): an INELIGIBLE entry means
// "no new equity guidance today — keep what you hold". So the score carries the
// PREVIOUS eligible entry's book through ineligible days unchanged (marked, no
// trade, no cost) — never a phantom sell-everything-and-rebuy round trip the panel
// never suggested. Cash only until the FIRST eligible entry. (Weight-based chaining
// re-applies the held weights each period — a small daily re-weighting drift vs
// holding literal shares; costless here and tiny at daily steps.)
function scoreAdvisorLog(log, { seriesFor, universe = [], costRates = { buyRate: 0, sellRate: 0 } }) {
  const entries = Array.isArray(log) ? log : [];
  if (entries.length < 2) return null;
  const nifty = seriesFor('NIFTY');
  // The EFFECTIVE book at each entry: its own targets when eligible, else the last
  // eligible book carried forward (the same array object — so switchCost sees no diff).
  const effective = [];
  {
    let held = [];
    for (const e of entries) {
      if (e.eligible) held = e.targets || [];
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
  // entry's weights to this one's — buys pay buyRate, sells pay sellRate.
  const switchCost = (prevTargets, targets) => {
    const w = new Map();
    for (const p of prevTargets || []) w.set(p.symbol, (w.get(p.symbol) || 0) + p.weight);
    let buys = 0, sells = 0;
    const seen = new Set();
    for (const p of targets || []) {
      seen.add(p.symbol);
      const d = p.weight - (w.get(p.symbol) || 0);
      if (d > 0) buys += d;
      else sells += -d;
    }
    for (const [sym, prevW] of w) if (!seen.has(sym)) sells += prevW; // dropped names are sold
    return buys * (costRates.buyRate || 0) + sells * (costRates.sellRate || 0);
  };

  let adv = 1, nif = 1, uni = 1, peak = 1, maxDD = 0;
  const curve = [{ t: entries[0].t, c: 1 }];
  const niftyCurve = [{ t: entries[0].t, c: 1 }];
  const universeCurve = [{ t: entries[0].t, c: 1 }];
  let costPaidPct = switchCost([], effective[0]); // entering the first day's book
  adv *= 1 - costPaidPct;

  for (let i = 0; i + 1 < entries.length; i++) {
    const a = entries[i], b = entries[i + 1];
    // The suggested portfolio's return over [t_a, t_b] from the EFFECTIVE book at a.
    let r = 0;
    for (const p of effective[i]) {
      const c0 = closeAt(p.symbol, a.t);
      const c1 = closeAt(p.symbol, b.t);
      if (c0 != null && c1 != null) r += p.weight * (c1 / c0 - 1);
    }
    adv *= 1 + r;
    // Rebalancing INTO entry b's effective book pays the switch cost at t_b (zero
    // across a stand-aside day — the held book IS the previous book).
    const cost = switchCost(effective[i], effective[i + 1]);
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
  return {
    minDays,
    logDays: entries.length,
    ready: entries.length >= minDays,
    today: entries.length ? entries[entries.length - 1] : null,
    prev: entries.length > 1 ? entries[entries.length - 2] : null,
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
