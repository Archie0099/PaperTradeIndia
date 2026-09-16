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

// The symbols that are INDICES, not shares: nothing with one of these names can be bought in the
// cash market. Kept as its own small set (rather than importing the F&O universe table) so this
// module stays dependency-free and unit-testable on its own — the three names are the same ones
// `FNO_INDICES` in universe.mjs and `INDEX_TO_YAHOO` in the provider list.
const INDEX_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY']);
const isIndexSymbol = (symbol) => INDEX_SYMBOLS.has(String(symbol || '').toUpperCase());

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

// ★ IS ANY SERIES THIS ENTRY WOULD REST ON FABRICATED? ONE definition, because the panel has to
// say exactly what the log did — and a client that re-derives a server rule drifts from it, which
// is the bug class this project keeps paying for. `buildAdvisorEntry` refuses on it and
// `buildAdvisorPayload` publishes it, so "the banner is shown" and "the day was refused" cannot
// disagree.
//
// WHY THIS EXISTS AT ALL. When the free feed cannot be reached at boot, loadCandles falls back to
// an OFFLINE SYNTHETIC series — and the index/benchmark keys, plus every single-symbol bot's key,
// are deliberately EXEMPT from the drop-if-synthetic hygiene that protects the basket pool ("a
// synthetic fallback keeps the bot, and the offline app, working"). That exemption predates this
// log. Its consequence: NIFTY's edge bar stamps EVERY entry's date and can be invented, and a
// single-symbol champion keeps its fabricated series and stays followable.
//
// MEASURED, not reasoned: the offline series is a naive calendar-day walk, so 85 of its 260 bars
// (32.7%) fall on a WEEKEND or a listed NSE holiday, and its level is fiction (NIFTY ~33,700
// against a real ~23,200; RELIANCE 4,243.54 against a real ~1,240).
//
// None of the existing guards can catch it, and it is worth knowing why: `dailySessionClosed` asks
// WHEN a bar closed, `isPhantomBar` asks whether volume is zero and the close carried forward. A
// synthetic bar has a plausible timestamp, a moving close and real-looking volume. No rule about
// the SHAPE of a bar can tell invented data from real data — only PROVENANCE can.
//
// ★★ THE CHAMPION IS CHECKED BY IDENTITY (`detail.symbol`) AND NOT ONLY BY WHAT IT HOLDS. A
// positional check — scanning `mirror.positions` alone — misses a champion that is FLAT, and
// `etf-trend-nifty` is exactly that bot: a single-symbol EQ trend follower that sells whenever
// NIFTYBEES drops below its 50-day average. On a fabricated series it can sit in cash, hold
// nothing, and sail past a positions scan to record an ELIGIBLE EMPTY book — which downstream
// reads as "sell everything" and charges the previous book's exit costs, permanently. REPRODUCED
// before fixing. This is the same positional-vs-identity trap already fixed for the index
// exclusion three lines below; whether a bot's DATA is real is a fact about the ROW, never about
// today's book.
//
// Returns null when everything is real, else { scope, symbols } — `scope: 'benchmark'` means NIFTY
// itself, which additionally makes the published track record and coverage fiction (they are
// recomputed from the live series on every payload, so the refusal does NOT clean them up).
function syntheticDataBlock({ detail, isSynthetic = () => false }) {
  if (isSynthetic('NIFTY')) return { scope: 'benchmark', symbols: ['NIFTY'] };
  if (!detail) return null;
  const names = new Set();
  if (detail.symbol && isSynthetic(detail.symbol)) names.add(detail.symbol);
  for (const p of (detail.mirror && detail.mirror.positions) || []) {
    if (p && p.qty !== 0 && p.symbol && isSynthetic(p.symbol)) names.add(p.symbol);
  }
  return names.size ? { scope: 'champion', symbols: [...names] } : null;
}

// --- Building one day's entry ----------------------------------------------
// The champion is the SAME "one brain" the Auto-Pilot follows (the walk-forward's
// point-in-time best-Sharpe pick), so the suggestions, the paper copy and the
// track record all describe one strategy. Returns null when nothing can honestly
// be issued today (no champion yet, or its market data isn't loaded — the same
// followable guard that stops the Auto-Pilot's cold-boot liquidation).
function buildAdvisorEntry({ autopilot, getBotDetail, seriesFor, isSynthetic = () => false }) {
  const nifty = seriesFor('NIFTY');
  if (!nifty.length) return null;
  const edge = nifty[nifty.length - 1]; // the data edge = the suggestion's "as of" bar
  const champ = autopilot && autopilot.currentBot;
  if (!champ) return null;
  const detail = getBotDetail(champ.id);
  if (!detail || detail.ok === false || !detail.mirror || detail.mirror.followable === false) return null;
  // NO-HINDSIGHT, ENFORCED RATHER THAN ASSUMED. The entry is stamped from NIFTY's edge, but the
  // champion's book is marked on its OWN timeline — for a basket, the UNION of its constituents'
  // timestamps (alignSeries). Those are different clocks. If any universe name's daily close
  // publishes before NIFTY's (the feed's per-symbol publication lag is variable and measured), the book is
  // marked at a bar LATER than the date this entry will carry, and the log silently records a
  // decision made with data it claims not to have had. Nothing enforced the ordering; it held only
  // because NIFTY happens to be a required source that refetches fresh.
  // REFUSE rather than restamp: a restamped entry would sit on a date NIFTY has no close for,
  // and the log is append-only so a wrong entry is permanent. A skipped day costs one tick of an
  // already-slow clock; a look-ahead entry costs the only claim the log makes. Logged loudly so a
  // frequent skip shows up as a message rather than as a mysteriously stalled trust clock.
  const asOf = detail.mirror.asOf;
  if (Number.isFinite(asOf) && asOf > edge.t) {
    console.warn(`advisor: skipping ${istDate(edge.t)} — the champion's book is marked ${istDate(asOf)}, ahead of the NIFTY edge this entry would be stamped with. Recording it would put look-ahead into an append-only record.`);
    return null;
  }

  const positions = (detail.mirror.positions || []).filter((p) => p && p.qty !== 0);
  // Refuse the WHOLE entry rather than dropping the offending name: a partial book reads
  // downstream as "sell the rest", the same trap the all-unpriceable rule already refuses.
  const standIn = syntheticDataBlock({ detail, isSynthetic });
  if (standIn) {
    console.warn(
      `advisor: skipping ${istDate(edge.t)} — ${standIn.symbols.join(', ')} ${standIn.symbols.length > 1 ? 'are' : 'is'} the OFFLINE SYNTHETIC fallback, `
      + 'so the data this entry would rest on is invented. This log is append-only.'
    );
    return null;
  }
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
  //   * the fair-bar CONTROL. `bar-universe-equal` holds the entire ~105-name universe at equal
  //     weight with no ranking signal, no filter and no market timing. It is on the board as the
  //     YARDSTICK every basket must clear before "beats the index" means anything — its own note
  //     opens "Not a strategy". It is deliberately still allowed to win the walk-forward, because
  //     a board that cannot conclude "nothing here beats holding the whole universe blind" is
  //     flattering itself. But that conclusion is a statement about the BOARD, not a real-money
  //     instruction: mirroring it by hand means ~105 delivery orders rebalanced monthly, each
  //     under 1% of the account, which no one placing orders manually can follow and which the
  //     costs would eat. Excluded here and only here, so the board stays honest and the advice
  //     stays usable. Checked FIRST — it is a statement about what the row IS, and it would
  //     otherwise pass every instrument test below (a long-only equity basket passes all four).
  if (detail.benchmark) reason = 'the champion is the fair-bar control (the whole universe at equal weight, no signal) — it is the yardstick this board is measured against, not a strategy, and mirroring it by hand would mean ~105 delivery orders rebalanced monthly';
  //   * an EQ bot whose INSTRUMENT is an index (`buy-hold` and `bearish-trend` are both
  //     `kind: 'EQ', symbol: 'NIFTY'`). This is a fact about the ROW, so it is checked here with
  //     the other identity test and NOT only against today's book: the first version of this
  //     exclusion looked at positions alone, which meant an index bot that is FLAT
  //     (bearish-trend sits in cash through every bull market) then passed every test and
  //     recorded `eligible: true, targets: []` — which the scorer reads as "sell everything" and
  //     charges the previous book's exit costs for, on the strength of a bot that can never be
  //     mirrored. The positional check further down stays as belt-and-braces for a basket that
  //     somehow holds an index name.
  else if (detail.kind === 'EQ' && isIndexSymbol(detail.symbol)) reason = `the champion trades the index itself (${detail.symbol}) as if it were a share — an index cannot be bought in the cash market, and substituting an ETF would be advice the champion never gave`;
  else if (detail.kind === 'FNO') reason = 'the champion is an options (F&O) bot — its option prices are modelled/indicative, so honest rupee suggestions for hand-placed real orders are not possible';
  else if (detail.kind === 'PAIRS') reason = 'the champion is a market-neutral pairs bot — half its book is short positions, which cash-market delivery orders cannot hold';
  else if (positions.some((p) => (p.kind || 'EQ') !== 'EQ')) reason = 'the champion currently holds derivative (F&O) legs, which cannot be mirrored with cash-market delivery orders';
  else if (positions.some((p) => p.qty < 0)) reason = 'the champion currently holds short positions, which cash-market delivery orders cannot hold';
  //   * an INDEX held as if it were a share. `buy-hold` is `kind: 'EQ', symbol: 'NIFTY'` — the
  //     index itself, not an ETF — and nothing stops the walk-forward crowning it. An index cannot
  //     be bought in the cash market, and quietly substituting NIFTYBEES would be advice the
  //     champion never gave (different price, tracking error, its own costs). Never picked in the
  //     board's ~70 re-picks so far; excluded so that if it ever is, the panel says so instead of
  //     printing an order for something that does not trade.
  else if (positions.some((p) => isIndexSymbol(p.symbol))) reason = `the champion holds the index itself (${positions.filter((p) => isIndexSymbol(p.symbol)).map((p) => p.symbol).join(', ')}) as if it were a share — an index cannot be bought in the cash market, and substituting an ETF would be advice the champion never gave`;
  let eligible = reason == null;

  const equity = detail.mirror.equity;
  // A bogus mirror equity must never be RECORDED — the log is the never-lose artifact,
  // and local persistence would keep a NaN/0-equity entry forever (only the Gist restore
  // sanitises). Better to skip the day than to write junk (same bar the sanitiser holds).
  if (!Number.isFinite(equity) || equity <= 0) return null;
  // An ELIGIBLE entry with no targets is a real and meaningful state: the champion is mirrorable
  // and is sitting entirely in CASH (a gated basket whose gate shut). That is guidance — "sell
  // everything" — and downstream readers treat it as such. So it must never be produced by a DATA
  // FAILURE instead. If the bot genuinely holds positions but every one of them is unpriceable,
  // the filter below would silently turn "I hold ten names" into "I hold nothing", which reads as
  // an instruction to liquidate. Refuse the day instead, exactly as the bogus-equity guard above
  // does: skipping a day costs one tick of a slow clock, writing junk into an append-only
  // real-money record costs the record.
  if (eligible && positions.length && !positions.some((p) => Number.isFinite(p.price) && p.price > 0)) return null;
  // ★ And the PARTIAL case is not "record what can be priced". If 9 of 10 names are unpriceable,
  // recording the one priceable name as the whole book lands "sell nine names, stay 10% invested"
  // in an append-only real-money record — the identical harm to the total case, just smaller.
  // The honest guidance when today's prices are unusable is "do nothing": record the day as a
  // stand-aside with the reason, which the scorer already treats as HOLDING the previous book (so
  // the advice and the score agree) and which keeps the trust clock ticking. Names that priced
  // are named too, so a reader can see it was the data, not the strategy.
  if (eligible && positions.length) {
    const unpriced = positions.filter((p) => !(Number.isFinite(p.price) && p.price > 0));
    if (unpriced.length) {
      reason = `${unpriced.length} of the champion's ${positions.length} holdings could not be priced today (${unpriced.map((p) => p.symbol).join(', ')}) — no rebalance is suggested; hold what you have`;
      eligible = false;
    }
  }
  const targets = !eligible
    ? []
    : positions
        .filter((p) => Number.isFinite(p.price) && p.price > 0)
        .map((p) => {
          // ★ RECORD THE CLOSE, NOT THE FILL. `p.price` comes from the engine's `lastPrices`,
          // which `engine.js` sets to the FILL price on every execution (`lastPrices[key] =
          // fillPrice`). The portfolio backtester marks each name at the close and then, on a
          // rebalance bar, executes at `close x (1 +/- rate)` — overwriting the mark. So for any
          // name that TRADED on this bar, `p.price` is the close inflated or deflated by the
          // delivery cost rate, while a name merely HELD keeps its true close.
          // ★★ THIS IS THE MECHANISM behind a long-standing mark discrepancy, now closed. Predicted drift against
          // the served close is 1/(1-sellRate)-1 = +0.15384% for a name sold and 1/(1+buyRate)-1
          // = -0.16832% for one bought, with exactly 0 for one held. MEASURED, across three
          // separate dates and different symbol sets, +0.1536..+0.1541% and -0.1683..-0.1686%,
          // with 5 of 9 entries exact. It uniquely explains every property recorded there — a
          // factor SHARED across unrelated symbols (it is a constant rate, not per-symbol),
          // STABLE across dates, BOTH signs inside one entry (a rebalance trims and tops up), and
          // exactly zero for held names. The two candidates previously documented (a forming-bar
          // mark; a provisional close later revised) were both wrong.
          // The close is what this field claims to be, what a user comparing against their broker
          // screen expects, and what the scoring path already uses. Fall back to the engine's mark
          // only if the series cannot be read, which is better than recording nothing.
          const close = closeAtOrBefore(seriesFor(p.symbol), edge.t);
          const mark = Number.isFinite(close) && close > 0 ? close : p.price;
          return {
            symbol: p.symbol,
            qty: p.qty, // the bot's own share count (the client scales by capital/equity)
            price: +mark.toFixed(2), // the edge bar's CLOSE (scoring itself re-reads closes via closeAtOrBefore)
            weight: +((p.qty * mark) / equity).toFixed(6), // fraction of the bot's equity, on the same mark
          };
        });

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
function buildAdvisorPayload({ log, seriesFor, universe = [], minDays = ADVISOR_MIN_DAYS, costRates = { buyRate: 0, sellRate: 0 }, standIn = null }) {
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
  // ★ KEYED ON `eligible` ALONE, deliberately. This used to also require `targets.length`, which
  // conflated two states that record the same empty array and mean opposite things:
  //   eligible:false, targets:[] -> STAND-ASIDE. No guidance was issued; carry the previous book.
  //   eligible:true,  targets:[] -> IN CASH. Guidance WAS issued, and it was "sell everything"
  //                                 (a gated basket whose gate shut). Skipping it is wrong.
  // With the old guard, a gated champion that went to cash and then re-entered was diffed against
  // the book from BEFORE the cash day. Today's book matched it, so the panel rendered "No change
  // — nothing to do today" at a user who had been told to liquidate and was sitting in cash: they
  // never bought back in. MEASURED on a three-day log (hold / cash / hold): the server's own
  // scoring charged estCostPct 0.3% for the full round trip while the panel showed no action.
  // `eligible` alone still excludes stand-aside entries, which is all the original guard was for
  // — and `buildAdvisorEntry` now refuses to record an eligible-but-empty entry that came from
  // unpriceable positions, so an empty book here always means genuinely in cash.
  let prevEligible = null;
  for (let i = entries.length - 2; i >= 0; i--) {
    if (entries[i].eligible) { prevEligible = entries[i]; break; }
  }
  // COVERAGE — how many of the trading days it COULD have recorded did it actually record?
  // The log only grows while the server is awake to see a new bar, and a free host sleeps.
  // Without this, "5 of 90 days" reads like a 90-day countdown 5 days in, when the honest
  // reading may be "5 of the 24 trading days that have passed", i.e. years away. The count
  // of possible days is NIFTY's own bars from the first recorded suggestion to the data
  // edge — the same trading calendar the board runs on, so no holiday list to drift.
  const nifty = seriesFor('NIFTY') || [];
  let possibleDays = 0;
  if (entries.length && nifty.length) {
    const from = entries[0].t;
    for (const bar of nifty) if (bar.t >= from) possibleDays++;
  }
  const coverage = entries.length
    ? {
        since: entries[0].date,
        recordedDays: entries.length,
        possibleDays,
        // null rather than a fake 0 when we cannot tell (no market series loaded yet).
        ratio: possibleDays > 0 ? +(entries.length / possibleDays).toFixed(3) : null,
      }
    : null;
  return {
    minDays,
    logDays: entries.length,
    ready: entries.length >= minDays,
    coverage,
    today: entries.length ? entries[entries.length - 1] : null,
    prev: entries.length > 1 ? entries[entries.length - 2] : null,
    prevEligible,
    marks,
    track: scoreAdvisorLog(entries, { seriesFor, universe, costRates }),
    costRates: { buyRate: costRates.buyRate || 0, sellRate: costRates.sellRate || 0 },
    benchmarkFinding: ADVISOR_BENCHMARK_FINDING,
    // What the log DID about fabricated data, published so the panel states the server's own
    // decision instead of re-deriving the rule from a key list and drifting from it. null when
    // everything is real. `scope: 'benchmark'` additionally means `track` and `coverage` above
    // are FICTION: both are recomputed from the live series on every payload, so refusing to
    // RECORD does not clean them up — the panel has to say so.
    standIn,
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
  syntheticDataBlock,
  closeAtOrBefore,
};
