// ---------------------------------------------------------------------------
// tournament/tournament.mjs
// The LIVE paper-trading tournament. Each bot in the ROSTER runs its strategy
// FORWARD on real market data — on a stock or index from the universe (see
// universe.mjs), with ₹1 crore of virtual capital — and competes on a leaderboard
// (the autonomous "bot accounts"). The roster EVOLVES: a local genetic algorithm
// (evolve.mjs) breeds challengers that explore both STRATEGY and SYMBOL.
//
// GROW mode (the current default — RETIRE_WEAKEST = false): a winning challenger is
// ADDED to the board and NOBODY is retired, so every strategy — past and present —
// stays visible for side-by-side comparison. Growth stops at MAX_ROSTER_BOTS so the
// free host's "re-backtest every bot" refresh stays light. Flip RETIRE_WEAKEST back
// to true (or pass retireWeakest:true) to restore the old selection pressure where a
// winner REPLACES the weakest non-protected bot.
//
// Design (deliberately stateless + restart-safe): a bot's performance is just
// DATA — a fixed recent "backfill" window (track record up to deployment) plus
// the daily closes that have arrived since. Each refresh we re-run the (tested)
// backtester over [backfill + live]. Nothing fragile to persist except the
// roster (DSL specs), the appended live closes, and a generation counter.
//
// VIRTUAL money only. No bot ever places a real order — by design.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { loadCandles } from '../backtest/data.mjs';
import { runBacktest } from '../backtest/backtester.mjs';
import { runFnoBacktest } from '../backtest/fno.mjs';
import { runPortfolioBacktest } from '../backtest/portfolio.mjs';
import { runPairsBacktest } from '../backtest/pairs.mjs';
import { sharpe as sharpeOfCurve, maxDrawdownPct } from '../backtest/metrics.mjs';
import { makeRankSource } from '../backtest/ml.mjs';
import { safeCompile, explainSpec, strategyRationale } from '../backtest/dsl.mjs';
import freeProvider from '../src/dataSources/freeProvider.js';
import marketHours from '../src/marketHours.js'; // CommonJS -> default import, then destructure
const { getMarketState } = marketHours;
import { SEED_BOTS } from './seed.mjs';
import { STOCKS, BASKET_UNIVERSE, FNO_INDICES, EQ_SYMBOLS, FNO_SYMBOLS } from './universe.mjs';
import { evolve, scoreSpec, fitness } from './evolve.mjs';
import { readFileSync as readFile, existsSync as fileExists } from 'node:fs';

const INDEX_SPECS = FNO_INDICES; // F&O lot size + strike grid, keyed by index symbol
// The "backfill" is each bot's visible TRACK RECORD before its forward/live clock
// starts. We make it the ENTIRE fetched history (Infinity = no cap) so every bot
// trades from the OLDEST data we can fetch — by design. For daily bots that is
// ~20 years (rangeFor below); for intraday ~2 years (the free 60-min limit). Two big
// wins beyond "more to look at": (1) every slow indicator + regime gate + local ML
// model is FULLY WARM by the live boundary (this finally kills the old cold-start where
// a 200-DMA gate / ML model only engaged during evolution scoring and sat cold on the
// ~1-year live board); (2) the curves now span multiple FULL market cycles (2008 GFC,
// 2020 COVID, 2022…), so a bot's drawdown behaviour is visible, not hidden.
//   COST: computeStandings re-backtests EVERY bot over the whole series on
//   each refresh. 20y is ~4× the old 5y window, so this is the heaviest knob on the
//   free host — it's still amortised (once/day on a new bar + on manual control ops,
//   NOT per request). These are kept as tunable CAPS: if a deployed instance ever feels
//   heavy, set BACKFILL_BARS to e.g. 2500 (~10y) to bound the per-refresh work without
//   touching anything else.
const BACKFILL_BARS = Infinity;          // daily: the entire ~20y series
const INTRADAY_BACKFILL_BARS = Infinity; // intraday: the entire ~2y of 60-min bars
const CASH = 10_000_000; // ₹1 crore of virtual capital per bot

// --- Interval-keyed data ----------------------------------------------------
// The tournament was DAILY-only: fullData / backfill / state.live were keyed by bare
// SYMBOL. To run an INTRADAY track alongside it we key by interval+symbol, but keep
// DAILY keyed by the bare symbol so every existing path (and its tests) is byte-
// identical. A symbol never contains ':', so the prefix is unambiguous.
//   dataKey('RELIANCE')        -> 'RELIANCE'       (daily, unchanged)
//   dataKey('RELIANCE','60m')  -> '60m:RELIANCE'   (intraday, its own namespace)
// Strategy kinds that span MANY symbols (a universe) rather than one — BASKET (pick
// & weight the best names) and PAIRS (long/short co-moving pairs). They share the
// roster plumbing: data sources are every constituent, the symbol is a label, and
// the leaderboard uses the backtester's own master timeline.
const spansUniverse = (kind) => kind === 'BASKET' || kind === 'PAIRS';
const isIntradayInterval = (interval) => !!interval && interval !== '1d';
const dataKey = (symbol, interval = '1d') => (isIntradayInterval(interval) ? `${interval}:${symbol}` : symbol);
const parseKey = (key) => { const i = key.indexOf(':'); return i < 0 ? { interval: '1d', symbol: key } : { interval: key.slice(0, i), symbol: key.slice(i + 1) }; };
const backfillBarsFor = (interval) => (isIntradayInterval(interval) ? INTRADAY_BACKFILL_BARS : BACKFILL_BARS);
// How much history to fetch from Yahoo per bar size.
//   Daily '20y': Yahoo serves DAILY bars for ~20 years (NIFTY from its 2007 inception;
//     stocks from ~2006 or their IPO). We deliberately do NOT use 'max' — for these
//     tickers Yahoo silently coerces 'max' to MONTHLY bars (wrong granularity for daily
//     strategies). 20y is the longest range that stays DAILY. CAVEAT (verified by a
//     full-universe scan): the 20y window is NOT uniformly
//     split-clean — a few names carry unadjusted pre-2011 corporate-action/bad-print
//     artifacts (e.g. NESTLEIND's 2010 −76% split bar, BAJAJFINSV's 2008 demerger,
//     an LT 2006 phantom bar). These are TRIMMED on load by sanitizeCandles() in
//     backtest/data.mjs (it drops each symbol's early artifact era), so what reaches a
//     backtest is clean. Most names keep the full ~20y; the few affected keep a clean
//     ~15-18y suffix.
//   Intraday '2y': free 60-min history only spans ~2 years.
const rangeFor = (interval) => (isIntradayInterval(interval) ? '2y' : '20y');
// One bar's duration in ms — used to drop the still-forming (incomplete) intraday bar,
// the intraday analogue of the daily tick's `istDate(c.t) < today` guard. '60m' -> 1h.
const intervalMs = (interval) => { const m = /^(\d+)(m|h)$/.exec(interval || ''); return m ? +m[1] * (m[2] === 'h' ? 3600000 : 60000) : 3600000; };

// --- Roster growth policy ---------------------------------------------------
// SHOW ALL BOTS (old + new) so they can be visually compared,
// instead of retiring the weakest each generation. So evolution GROWS the board
// rather than replacing a bot.
//   RETIRE_WEAKEST = false  -> grow mode: a winner is appended, nobody is retired.
//   MAX_ROSTER_BOTS         -> hard cap on the board size in grow mode. computeStandings
//                              re-backtests EVERY bot (incl. the heavy ML baskets) on
//                              each refresh, so this bounds the work on the free host.
//                              Lower it if the deployed instance ever feels heavy;
//                              raise it for more bots to compare. (Both are overridable
//                              per-instance via createTournament({ retireWeakest, maxRosterBots }).)
const RETIRE_WEAKEST = false;
const MAX_ROSTER_BOTS = 24;

// Evolution scores its challengers + the weakest-bot bar on a BOUNDED recent window
// of history (the last ~3 years), NOT the whole ~5y series. A basket backtest's cost
// grows superlinearly with series length, so scoring a 36-name universe with weekly-
// rebalancing baskets over the full 5y blocked the event loop ~20-30s per generation
// on the free host. 3 years is plenty for the indicators (SMA200 etc.) and the ML
// models' lookback (≤756), while keeping a generation a few seconds. Slicing a shorter
// (test) series is a no-op, so determinism/promotion tests are unaffected.
const EVOLVE_WINDOW = 756;
// How many symbols to fetch from Yahoo at once during the cold-boot backfill. The
// whole universe (38 symbols) is loaded at boot and, on Render's ephemeral disk, re-
// fetched on every redeploy — so we cap concurrency to avoid a 38-wide burst that
// Yahoo might throttle (which would drop some bots onto synthetic data).
const BOOT_FETCH_CONCURRENCY = 6;
// The board must NOT wait for the whole ~200-symbol cold fetch before it appears. On a free host
// (Render) that fetch is slow + rate-limited (Yahoo throttles datacenter IPs), so after the required
// symbols load we compute the first standings within this deadline and finish the broad basket POOL in
// the BACKGROUND (then recompute). This keeps the full universe + 20y history but makes the board show
// in ~under a minute instead of 503-ing for many minutes on a cold boot.
const BOOT_DEADLINE_MS = 45000;

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');
const STATE_FILE = join(DATA_DIR, 'tournament.json');

const istDate = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);

// Run an async `fn` over `items` with at most `limit` in flight at once — used so the
// cold-boot backfill doesn't fire one fetch per universe symbol all at once (which a
// free data source may throttle). Preserves per-index results; never rejects as a
// whole (each fn is expected to handle its own errors / fallback).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

// A canonical key for a strategy spec, to detect structural duplicates so the
// roster doesn't fill up with near-identical evolved clones. BASKETs use a
// SEPARATE key shape (universe sorted for order-independence); EQ/FNO keep their
// EXACT original array so their dedupe behaviour is byte-identical to before.
const specKey = (spec) => {
  // PAIRS: identity = its (order-independent) universe + the stat-arb knobs.
  if (spec.kind === 'PAIRS') return JSON.stringify(['PAIRS', [...(spec.universe || [])].sort(), spec.lookback ?? null, spec.entryZ ?? null, spec.exitZ ?? null, spec.stopZ ?? null, spec.maxPairs ?? null, spec.formationBars ?? null, spec.minCorr ?? null, spec.gross ?? null]);
  if (spec.kind !== 'BASKET') return JSON.stringify([spec.kind, spec.entry ?? null, spec.exit ?? null, spec.weight ?? null, spec.legs ?? null, spec.side ?? null]);
  // Canonicalise the universe AND mlConfig (sorted features + explicit field order,
  // since neither order changes the model), so two value-identical baskets dedupe
  // to one key regardless of how the spec object happened to be built. Include the
  // factor model + the optimiser knobs + the tree-family knobs so a factor/optimiser/
  // gbm/forest basket is NOT mistaken for a plain one with the same universe/rank.
  const m = spec.mlConfig;
  const mlKey = m ? { model: m.model, features: [...m.features].sort(), horizon: m.horizon, lambda: m.lambda, lookback: m.lookback, trainEveryBars: m.trainEveryBars, minTrain: m.minTrain, rounds: m.rounds ?? null, learnRate: m.learnRate ?? null, trees: m.trees ?? null, depth: m.depth ?? null } : null;
  // Sort the factor tuples so a reordered-but-identical factor set dedupes to ONE key
  // (the composite is an order-independent weighted sum), mirroring the universe/features
  // canonicalisation above.
  const factorsKey = Array.isArray(spec.factors) ? spec.factors.map((f) => [f.name, f.expr, f.weight]).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : null;
  return JSON.stringify(['BASKET', [...(spec.universe || [])].sort(), spec.k ?? null, spec.rebalanceBars ?? null, spec.weighting ?? null, spec.rank ?? null, spec.gate ?? null, spec.marketGate ?? null, mlKey, factorsKey, spec.covLookback ?? null, spec.maxWeight ?? null]);
};

function downsample(points, max = 120) {
  if (points.length <= max) return points.map((p) => ({ t: p.t, c: +(+p.c).toFixed(0) }));
  const step = (points.length - 1) / (max - 1);
  const out = [];
  for (let i = 0; i < max; i++) {
    const p = points[Math.round(i * step)];
    out.push({ t: p.t, c: +(+p.c).toFixed(0) });
  }
  return out;
}

// A LIGHT, multi-resolution curve for the time-window charts (1D/1W/1M/.../MAX zoom).
// A single downsample to ~120 points over ~20 years leaves only ~0.1 of a point inside a
// 1-week window, so zooming to a short window would show almost nothing. Instead we ship a
// few TIERS — each the trailing 1M / 1Y / 5Y / whole-life slice, sliced FIRST and only THEN
// downsampled to ≤max points. The trailing month is ~22 trading bars, which is BELOW the cap,
// so the 1M tier keeps FULL daily resolution — a 1-week zoom drawn from it shows the real last
// five days. The client (ui/chartwindow.js) picks the finest tier that still covers the chosen
// window. Total payload ≈ 4 × max points, so the 30s standings poll stays small. points:[{t,c}].
// MAX_TIER is a finite "whole life" sentinel (Infinity is NOT JSON-safe — it serialises to null,
// which would break the client's tier-pick comparison; a value larger than any real span works).
const MAX_TIER_MS = 1e15;
const CURVE_TIER_MS = [31 * 864e5, 366 * 864e5, 5 * 366 * 864e5, MAX_TIER_MS]; // 1M · 1Y · 5Y · MAX
function multiResCurve(points, max = 120) {
  const pts = (points || []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(+p.c));
  if (pts.length < 2) return [];
  const lastT = pts[pts.length - 1].t;
  return CURVE_TIER_MS.map((ms) => {
    const slice = ms >= MAX_TIER_MS ? pts : pts.filter((p) => p.t >= lastT - ms);
    const use = slice.length >= 2 ? slice : pts.slice(-2); // never an empty/1-point tier
    return { ms, points: downsample(use, max) };
  });
}

// --- The "Auto-Pilot" walk-forward backtest ---------------------------------
// Answers the real question — "is auto-picking the best bot actually making more
// money than the market?" — HONESTLY. At each rebalance it follows the bot with the best
// TRAILING Sharpe computed from ONLY the data up to that bar (no hindsight — you genuinely
// could not see the future when picking), chains that bot's returns into a ₹1-crore equity
// curve, and re-picks periodically. This is exactly what the live Auto-Pilot does going
// forward, so it's a fair track record — NOT a cherry-picked "follow today's winner" curve.
// Benchmarked against Buy & Hold (₹1cr in NIFTY). Pure function of the bots' equity curves.
const AP_REBAL_BARS = 63; // re-pick the followed bot ~quarterly
const AP_MIN_HISTORY = 252; // a bot needs ≥ ~1 year of history before it can be followed
function computeAutopilotTrack(curves, cash) {
  const usable = (curves || []).filter((c) => Array.isArray(c.eq) && Array.isArray(c.times) && c.eq.length === c.times.length && c.times.length >= 2);
  if (!usable.length) return null;
  // Benchmark / master timeline = the protected Buy & Hold (₹1cr in NIFTY), else the longest series.
  const bench = usable.find((c) => c.protected) || usable.slice().sort((a, b) => b.times.length - a.times.length)[0];
  const master = bench.times;
  // Align every bot's equity onto the master timeline (forward-fill the last real value;
  // null before its first bar — so a bot that listed later is simply not yet eligible).
  const aligned = usable.map((c) => {
    const a = new Array(master.length).fill(null);
    let ci = 0, last = null;
    for (let i = 0; i < master.length; i++) {
      while (ci < c.times.length && c.times[ci] <= master[i]) { last = c.eq[ci]; ci++; }
      a[i] = last;
    }
    let firstIdx = a.findIndex((v) => v != null && v > 0);
    return { ...c, a, firstIdx: firstIdx < 0 ? Infinity : firstIdx };
  });
  const benchA = aligned.find((c) => c.id === bench.id) || aligned[0]; // the benchmark, aligned (has `.a`)
  // Point-in-time annualised Sharpe over ALL the bot's history UP TO bar `hi` — matching the
  // live Auto-Pilot's "best (full-life) Sharpe" default, so the track record reflects what the
  // live copy actually does (and the walk-forward's CURRENT pick == the live champion). Reads
  // no future data, so the whole thing stays look-ahead-free.
  const sharpeUpTo = (a, hi) => {
    const rets = [];
    for (let j = 1; j <= hi; j++) {
      const p = a[j - 1];
      if (p != null && p > 0 && a[j] != null) rets.push(a[j] / p - 1);
    }
    if (rets.length < 20) return -Infinity;
    const m = rets.reduce((s, x) => s + x, 0) / rets.length;
    const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
    const sd = Math.sqrt(v);
    return sd > 0 ? (m / sd) * Math.sqrt(252) : 0;
  };
  const ap = new Array(master.length).fill(null);
  const followed = [];
  let started = false, apEq = cash, lastRebal = -Infinity, chosen = null, startIdx = -1;
  for (let i = 0; i < master.length; i++) {
    // (1) Earn the CURRENT pick's return for this bar, BEFORE any switch (so a re-pick
    //     applies only from the NEXT bar — no switch-bar return leakage).
    if (started && chosen && i > 0 && chosen.a[i] != null && chosen.a[i] > 0 && chosen.a[i - 1] != null && chosen.a[i - 1] > 0) {
      apEq *= chosen.a[i] / chosen.a[i - 1];
    }
    if (started) ap[i] = apEq;
    // (2) (re)pick at a rebalance bar (or the very first eligible bar), using ONLY data ≤ i.
    if (i - lastRebal >= AP_REBAL_BARS || !started) {
      const eligible = aligned.filter((c) => c.a[i] != null && c.a[i] > 0 && i - c.firstIdx >= AP_MIN_HISTORY);
      if (eligible.length) {
        let best = null, bestS = -Infinity;
        for (const c of eligible) { const s = sharpeUpTo(c.a, i); if (s > bestS) { bestS = s; best = c; } }
        if (best) {
          chosen = best;
          lastRebal = i;
          if (!started) { started = true; apEq = cash; ap[i] = cash; startIdx = i; }
          followed.push({ t: master[i], id: best.id, name: best.name });
        }
      }
    }
  }
  if (!started || startIdx < 0) return null;
  const apTimes = [], apEqArr = [], benchEqArr = [];
  const benchBase = benchA.a[startIdx];
  for (let i = startIdx; i < master.length; i++) {
    apTimes.push(master[i]);
    apEqArr.push(ap[i]);
    // Rebase the benchmark to ₹1cr at startIdx (apples-to-apples with the Auto-Pilot). On a rare
    // gap (a null bar) FORWARD-FILL the previous benchmark value — never fall back to the AP's own
    // equity, which would make the benchmark silently mirror the AP and report a fake 0% edge.
    const prevB = benchEqArr.length ? benchEqArr[benchEqArr.length - 1] : cash;
    benchEqArr.push(benchA.a[i] != null && benchBase > 0 ? cash * (benchA.a[i] / benchBase) : prevB);
  }
  const DAY = 864e5;
  const metricsOf = (times, eq) => {
    const last = eq[eq.length - 1];
    const periodRet = (win) => {
      const startT = times[times.length - 1] - win;
      if (!(times[0] <= startT)) return null;
      let k = 0; for (let j = 0; j < times.length; j++) { if (times[j] <= startT) k = j; else break; }
      const base = eq[k];
      return base > 0 ? +(((last / base) - 1) * 100).toFixed(2) : null;
    };
    const prev = eq.length >= 2 ? eq[eq.length - 2] : eq[0];
    return {
      finalEquity: Math.round(last),
      liveReturnPct: prev > 0 ? +(((last / prev) - 1) * 100).toFixed(2) : 0,
      r1w: periodRet(7 * DAY), r1m: periodRet(30.44 * DAY), r1y: periodRet(365.25 * DAY),
      r3y: periodRet(3 * 365.25 * DAY), r5y: periodRet(5 * 365.25 * DAY), r10y: periodRet(10 * 365.25 * DAY),
      trackReturnPct: eq[0] > 0 ? +(((last / eq[0]) - 1) * 100).toFixed(2) : 0,
      sharpe: +sharpeOfCurve(eq).toFixed(2),
      maxDrawdownPct: +maxDrawdownPct(eq).toFixed(2),
    };
  };
  const apM = metricsOf(apTimes, apEqArr);
  const benchM = metricsOf(apTimes, benchEqArr);
  return {
    startedAt: master[startIdx],
    cash,
    rebalBars: AP_REBAL_BARS,
    metrics: apM,
    benchMetrics: benchM,
    benchName: bench.name,
    vsMarketPct: +((apM.trackReturnPct || 0) - (benchM.trackReturnPct || 0)).toFixed(2),
    currentBot: chosen ? { id: chosen.id, name: chosen.name, kind: chosen.kind, symbol: chosen.symbol, holdings: chosen.holdings || null } : null,
    followedCount: new Set(followed.map((f) => f.id)).size,
    switches: followed.length,
    // A condensed "which bot did the Auto-Pilot follow, and from when" timeline — the SWITCH points
    // only (consecutive same-id pick re-collapsed), so the UI can show what it actually did over the
    // years (the walk-forward re-picks ~quarterly but usually re-picks the same bot).
    followedTimeline: followed.reduce((tl, f) => { if (!tl.length || tl[tl.length - 1].id !== f.id) tl.push({ t: f.t, id: f.id, name: f.name }); return tl; }, []),
    curve: downsample(apTimes.map((t, i) => ({ t, c: apEqArr[i] }))),
    benchCurve: downsample(apTimes.map((t, i) => ({ t, c: benchEqArr[i] }))),
    // Multi-resolution tiers (in ADDITION to the flat curve above, which the "reflect in my
    // account" seed + the determinism tests still read) so the Auto-Pilot "vs the market" chart
    // can zoom to a window (1D/1W/.../MAX) without the 120-point downsample washing it out.
    curveTiers: multiResCurve(apTimes.map((t, i) => ({ t, c: apEqArr[i] }))),
    benchTiers: multiResCurve(apTimes.map((t, i) => ({ t, c: benchEqArr[i] }))),
  };
}

// A cosmetic display label for a universe-spanning bot (its identity lives in
// spec.universe). A PAIRS bot is labelled by how many pairs it holds; a BASKET by
// how many names it scans.
const basketLabel = (spec) => {
  if (!spec || !Array.isArray(spec.universe)) return 'basket';
  if (spec.kind === 'PAIRS') return `${spec.maxPairs} pairs`;
  return `${spec.universe.length} stocks`;
};

// A roster entry is a plain (serialisable) bot definition. Seeds default to gen 0.
// A BASKET's `symbol` is just a label; the source of truth is spec.universe.
const asRosterEntry = (b, gen = 0) => ({
  id: b.id,
  name: b.name,
  note: b.note || '',
  kind: b.kind,
  symbol: b.symbol || (spansUniverse(b.kind) ? basketLabel(b.spec) : 'NIFTY'),
  // The bar interval this bot trades on: '1d' (daily, the default) or an intraday
  // interval like '60m'. Intraday bots load denser history and run a separate live
  // tick; they stay OUT of the daily evolution pools (a separate track).
  interval: b.interval || '1d',
  spec: b.spec,
  gen: b.gen == null ? gen : b.gen,
  protected: !!b.protected,
});

async function createTournament({ seed = SEED_BOTS, backfillData = null, persist = true, stateFile = STATE_FILE, retireWeakest = RETIRE_WEAKEST, maxRosterBots = MAX_ROSTER_BOTS, evolutionEnabled = true } = {}) {
  // evolutionEnabled: whether the local genetic algorithm BREEDS + adds challengers. The
  // production server (server.js) passes FALSE — intentionally: the board shows only the
  // CURATED seed line-up, not unproven in-sample GA mutations (a bred bot merely beat the
  // weakest bot on a ~3-year in-sample window — a low, overfit-prone bar). The whole evolution
  // machinery (evolve.mjs, runGeneration, addFromPool, the unit tests) is KEPT intact behind
  // this flag; flip server.js back to true (or pass evolutionEnabled:true) to resume breeding.
  // Default true so the mechanism + its tests still exercise evolution unchanged.
  const fullData = {}; // symbol -> full cached candles (for evolution scoring)
  const backfill = {}; // symbol -> fixed recent window (the live track record)
  let roster = seed.map((b) => asRosterEntry(b)); // mutable bot definitions
  let bots = []; // compiled view of the roster
  let state = { deployedAt: null, live: {}, roster: null, generation: 0, history: [] };
  let standings = null;
  let pool = null; // lazily-loaded generated strategy pool (backtest/generated-specs.json)
  let opSeq = 0; // bumped on every control mutation; an in-flight tick() aborts if it changes mid-await
  let recomputeGen = 0; // bumped at the START of every standings recompute; an in-flight YIELDING recompute
  // aborts (leaving the previous, complete standings in place) if a newer recompute supersedes it, so the
  // latest always wins and two recomputes can never interleave-corrupt the board.
  // Memoised getBotDetail results (a full per-bot backtest is heavy). The detail is
  // DETERMINISTIC for a given roster+live state, so we cache per bot id and clear the
  // cache whenever computeStandings re-runs (i.e. exactly when the underlying data
  // changed). This makes repeated clicks / polls on the same bot free, and defangs a
  // burst of GET /api/tournament/bot from re-backtesting on every request.
  let detailCache = new Map();

  function rebuildBots() {
    bots = roster
      .map((b) => {
        const c = safeCompile(b.spec);
        return c.ok ? { ...b, strategy: c.strategy } : null;
      })
      .filter(Boolean);
  }
  rebuildBots();
  // Every (symbol, interval) data source a list of bots needs loaded + ticking: the
  // single symbol of each EQ/FNO bot, EVERY constituent of every BASKET bot — each at
  // that bot's interval — plus NIFTY DAILY (the benchmark + the basket market-gate
  // proxy). A basket's `symbol` is a LABEL, so it is never treated as a real symbol.
  // Returns [{ key, symbol, interval }] de-duped by key (so the same symbol on two
  // intervals is two sources, but two daily bots on one symbol share one source).
  const sourcesOf = (botList) => {
    const map = new Map();
    const add = (symbol, interval) => map.set(dataKey(symbol, interval), { symbol, interval });
    add('NIFTY', '1d'); // benchmark + basket market-gate proxy (always daily)
    for (const b of botList || []) {
      const interval = b.interval || '1d';
      if (spansUniverse(b.kind) && b.spec && Array.isArray(b.spec.universe)) b.spec.universe.forEach((s) => add(s, interval));
      else add(b.symbol, interval);
    }
    return [...map.entries()].map(([key, v]) => ({ key, ...v }));
  };
  const rosterSources = () => sourcesOf(roster);

  function save() {
    if (!persist) return;
    try {
      mkdirSync(dirname(stateFile), { recursive: true });
      state.roster = roster;
      writeFileSync(stateFile, JSON.stringify(state, null, 2));
    } catch {
      /* persistence is best-effort */
    }
  }

  function load() {
    if (!persist) return;
    try {
      if (existsSync(stateFile)) {
        const s = JSON.parse(readFileSync(stateFile, 'utf8'));
        if (s && typeof s === 'object') {
          state = { deployedAt: s.deployedAt || null, live: s.live || {}, roster: s.roster || null, generation: s.generation || 0, history: Array.isArray(s.history) ? s.history : [] };
          if (Array.isArray(s.roster) && s.roster.length) {
            roster = s.roster.map((b) => asRosterEntry(b, b.gen || 0));
            rebuildBots();
            // If a stale/incompatible save compiles to NO bots, fall back to the
            // seed line-up rather than coming up with an empty leaderboard.
            if (!bots.length) {
              roster = seed.map((b) => asRosterEntry(b));
              rebuildBots();
            }
          }
        }
      }
    } catch {
      /* corrupt -> start fresh */
    }
  }

  // Merge a symbol's fixed backfill window with the appended live closes. Normally
  // disjoint, but we de-dup by timestamp (a later/live bar wins on a tie) and sort
  // ascending so the backtester never replays a duplicate or out-of-order bar even
  // if the on-disk cache and persisted live state ever overlap (e.g. a refreshed
  // local cache). Backtesters assume a clean, monotonic series.
  const seriesFor = (symbol, interval = '1d') => {
    const key = dataKey(symbol, interval);
    // A DROPPED (no-real-data) symbol has no backfill — ignore any STALE persisted live bars it may
    // still carry (state.live can outlive a drop across a reboot), so a dropped name is consistently
    // EMPTY everywhere and baskets simply skip it (never a backfill-less, truncated series). A live
    // symbol always has backfill, so this never changes a real series.
    if (!(backfill[key] && backfill[key].length)) return [];
    const merged = new Map();
    for (const c of backfill[key] || []) merged.set(c.t, c);
    for (const c of state.live[key] || []) merged.set(c.t, c);
    return [...merged.values()].sort((a, b) => a.t - b.t);
  };

  // Run one bot's backtest over [backfill+live]. `recordTrades` (used by
  // getBotDetail) makes the backtester also return a full per-trade log.
  function runBot(bot, candles, recordTrades = false, alignCache = null) {
    const interval = bot.interval || '1d';
    const intraday = isIntradayInterval(interval); // annualise the Sharpe by the bars' own frequency
    if (bot.kind === 'BASKET') {
      // A basket spans many stocks — gather each constituent's [backfill+live]
      // series (at the basket's interval) and run the PORTFOLIO backtester (its own
      // local ML model, if any). (F&O has no intraday data; baskets-intraday is future.)
      // alignCache (when computeStandings provides one) lets baskets over the same wide
      // universe share one aligned price grid — the big saving at ~200 names.
      const spec = bot.spec;
      const dbs = {};
      for (const s of spec.universe) dbs[s] = seriesFor(s, interval);
      const rankSource = spec.mlConfig ? makeRankSource({ spec, dataBySymbol: dbs }) : null;
      return runPortfolioBacktest({ spec, dataBySymbol: dbs, marketSeries: seriesFor('NIFTY'), cash: CASH, costBps: 5, rankSource, recordTrades, intraday, alignCache });
    }
    if (bot.kind === 'PAIRS') {
      // A PAIRS bot also spans many stocks (long/short pairs) — gather each
      // constituent's [backfill+live] series and run the stat-arb backtester. No
      // market-gate proxy (it's market-neutral by construction) and no ML.
      const spec = bot.spec;
      const dbs = {};
      for (const s of spec.universe) dbs[s] = seriesFor(s, interval);
      return runPairsBacktest({ spec, dataBySymbol: dbs, cash: CASH, costBps: 5, recordTrades, intraday });
    }
    if (bot.kind === 'FNO') {
      const spec = INDEX_SPECS[bot.symbol] || INDEX_SPECS.NIFTY;
      return runFnoBacktest({ strategy: bot.strategy, candles, symbol: bot.symbol, cash: CASH, ...spec, keepOpen: true, recordTrades });
    }
    return runBacktest({ strategy: bot.strategy, candles, symbol: bot.symbol, cash: CASH, costBps: 5, recordTrades, intraday, spec: bot.spec });
  }

  // The deploy-boundary TIMESTAMP for a bot (the last backfill bar at-or-before
  // deployment) — trades after it are LIVE/forward, before it are the track record.
  // Mirrors the deployIdx logic in computeStandings but yields a timestamp.
  function deployCutoffFor(bot) {
    const interval = bot.interval || '1d';
    // A basket's market-gate proxy (NIFTY) is always DAILY; its constituents follow the
    // bot's interval. An EQ/FNO bot is its single symbol at its own interval.
    const keys = spansUniverse(bot.kind)
      ? [...bot.spec.universe.map((s) => dataKey(s, interval)), dataKey('NIFTY', '1d')]
      : [dataKey(bot.symbol, interval)];
    const cutoffs = keys
      // The deployment boundary: the last backfill bar. Trades after it are live/forward,
      // before it are the bot's track record.
      .map((k) => (backfill[k] && backfill[k].length ? backfill[k][backfill[k].length - 1].t : null))
      .filter((t) => t != null);
    return cutoffs.length ? Math.max(...cutoffs) : Infinity;
  }

  // Full detail for ONE bot (lazy — re-runs just this bot WITH trade recording).
  // Powers the "click a bot to see its whole history" UI: every buy/sell with its
  // date, price, size and realised P&L, split into track-record vs live-forward,
  // plus the current portfolio. Capped so a very active bot can't bloat the payload.
  const MAX_TRADES_SHOWN = 400;
  function getBotDetail(id) {
    const bot = bots.find((b) => b.id === id);
    if (!bot) return { ok: false, error: 'No such bot' };
    if (detailCache.has(id)) return detailCache.get(id); // deterministic for this state
    const series = spansUniverse(bot.kind) ? null : seriesFor(bot.symbol, bot.interval); // BASKET/PAIRS rebuild dbs themselves; bot.symbol is a label, not a real series
    const res = runBot(bot, series, true);
    // A universe-spanning bot whose ENTIRE universe was dropped/synthetic on a cold boot produces an
    // EMPTY equity curve (a PAIRS bot gets no marketSeries anchor) — summarize([]) would then report
    // ₹0 / 0%. Match the leaderboard's NEUTRAL-row treatment in computeStandings: a bot that never
    // traded is worth its STARTING cash, not ₹0. Mirror the neutral row onto the per-bot page
    // + the Auto-Pilot mirror, so the two surfaces never disagree for the same bot.
    const traded = Array.isArray(res.equityCurve) && res.equityCurve.length >= 2;
    const finalEquity = traded ? Math.round(res.metrics.finalEquity) : CASH;
    const cutoff = deployCutoffFor(bot);
    const all = (res.trades || []).map((tr) => ({ ...tr, live: tr.t > cutoff }));
    // Keep the MOST RECENT trades if a hyperactive bot exceeds the cap.
    const shown = all.length > MAX_TRADES_SHOWN ? all.slice(all.length - MAX_TRADES_SHOWN) : all;
    // Per-stock realised P&L contribution ("who made/lost money") — group the trade log
    // by symbol and sum each one's booked realised P&L; attach its current weight (if
    // still held). Most meaningful for baskets; for an EQ bot it's just its one symbol.
    const contribMap = new Map();
    for (const tr of all) contribMap.set(tr.symbol, (contribMap.get(tr.symbol) || 0) + (tr.realised || 0));
    const holdW = new Map();
    (res.holdings || []).forEach((h) => holdW.set(h.symbol, h.weightPct));
    const contributions = [...contribMap.entries()]
      .map(([symbol, realised]) => ({ symbol, realised: +realised.toFixed(2), weightPct: holdW.get(symbol) != null ? holdW.get(symbol) : 0 }))
      .sort((a, b) => b.realised - a.realised);
    // A uniform COPY TARGET ("mirror") for the Auto-Pilot account (ui/autopilot.js): the
    // bot's CURRENT open positions as plain instruments + signed sizes + a mark price,
    // PLUS the bot's equity so the client can scale the copy to the account's own capital
    // (userQty = round(botQty × userEquity / botEquity)). followable for EVERY kind
    // (EQ long/short, BASKET, PAIRS, FNO); an F&O leg is copied at its indicative model
    // price. An empty positions list means the bot is sitting in cash.
    const mirror = {
      followable: true,
      equity: finalEquity,
      positions: (res.finalPositions || []).map((p) => ({ ...p, side: p.qty >= 0 ? 'BUY' : 'SELL' })),
    };
    // The bot's FULL equity curve, packed as light multi-resolution tiers, so the per-bot
    // PAGE can offer time-window zoom (1D/1W/.../MAX) at full resolution in every window.
    // Built the SAME way as the leaderboard row's curve (eq + interval-aware times), but
    // un-downsampled before tiering. On demand + memoised (one bot), so this stays cheap.
    const eqd = res.equityCurve || [];
    const ctimes = spansUniverse(bot.kind) ? (res.times || eqd.map((_, i) => i)) : (series || []).map((c) => c.t);
    const curveTiers = multiResCurve(eqd.map((c, i) => ({ t: ctimes[i] != null ? ctimes[i] : i, c })));
    const detail = {
      ok: true,
      id: bot.id,
      name: bot.name,
      kind: bot.kind,
      symbol: bot.symbol,
      interval: bot.interval || '1d',
      gen: bot.gen || 0,
      explain: explainSpec(bot.spec),
      // In-depth, plain-English rationale for the per-bot PAGE (thesis/params/risk),
      // plus the latest rebalance decision (basket "why each stock was chosen") and the
      // per-stock P&L contributions.
      rationale: strategyRationale(bot.spec),
      decision: res.decision || null,
      contributions,
      note: bot.note || res.note || '',
      position: res.position || 'flat',
      holdings: res.holdings || null,
      mirror, // the Auto-Pilot copy target (instruments + signed sizes + mark prices + bot equity)
      curveTiers, // full equity curve as multi-resolution tiers, for the per-bot page's window zoom
      equity: finalEquity,
      metrics: traded
        ? { totalReturnPct: res.metrics.totalReturnPct, sharpe: res.metrics.sharpe, maxDrawdownPct: res.metrics.maxDrawdownPct, trades: res.metrics.trades }
        : { totalReturnPct: 0, sharpe: 0, maxDrawdownPct: 0, trades: 0 }, // never-traded: neutral, matching the leaderboard row
      deployAt: Number.isFinite(cutoff) ? cutoff : null,
      tradeCount: all.length,
      liveTradeCount: all.filter((t) => t.live).length,
      // Net realised (booked) P&L over the bot's whole life — sum of every trade's
      // realised delta. (Closed positions only; open positions show up in equity.)
      totalRealised: +all.reduce((s, t) => s + (t.realised || 0), 0).toFixed(2),
      trades: shown,
    };
    detailCache.set(id, detail);
    return detail;
  }

    // Build ONE bot's leaderboard row (the heavy part: a full backtest via runBot). Pushes
    // the bot's full daily curve onto apCurves (for the Auto-Pilot walk-forward) as a side
    // effect; reads module state but never mutates it, so the synchronous and the YIELDING
    // recompute paths can share it and produce byte-identical rows.
    function buildRow(bot, apCurves, alignCache) {
      let res, times, deployIdx;
      if (spansUniverse(bot.kind)) {
        res = runBot(bot, undefined, false, alignCache);
        times = res.times || res.equityCurve.map((_, i) => i);
        // The deploy boundary on the MASTER timeline = the last master bar at-or-before
        // the backfill cutoff. Reuse deployCutoffFor(bot) — the SAME interval-aware
        // computation getBotDetail uses — so the leaderboard's deploy marker and the
        // per-bot page's track/live split can never drift (and an intraday basket reads
        // the right '60m:SYM' keys, not bare-symbol ones).
        const cutoff = deployCutoffFor(bot);
        deployIdx = 0;
        for (let i = 0; i < times.length; i++) { if (times[i] <= cutoff) deployIdx = i; else break; }
      } else {
        const series = seriesFor(bot.symbol, bot.interval);
        res = runBot(bot, series);
        times = series.map((c) => c.t);
        deployIdx = (backfill[dataKey(bot.symbol, bot.interval)] || []).length - 1;
      }
      const eq = res.equityCurve;
      // An EMPTY / too-short equity curve makes last=undefined -> liveReturnPct=NaN, leaking a NaN
      // into a money field + the row sort. This is reachable for a PAIRS bot whose ENTIRE universe
      // was dropped/synthetic on a cold boot: unlike a BASKET (which is passed marketSeries=NIFTY so
      // its master timeline is never empty), runPairsBacktest gets no market anchor, so an all-missing
      // universe yields equityCurve:[]. Emit a NEUTRAL row instead — the bot legitimately has no data
      // this pass (it never traded, so equity = starting cash, every return 0/null).
      if (!Array.isArray(eq) || eq.length < 2) {
        return {
          id: bot.id, name: bot.name, kind: bot.kind, symbol: bot.symbol, interval: bot.interval || '1d',
          gen: bot.gen || 0, note: bot.note || res.note || '', explain: explainSpec(bot.spec), protected: !!bot.protected,
          equity: CASH, liveReturnPct: 0, r1w: null, r1m: null, r1y: null, r3y: null, r5y: null, r10y: null, trackReturnPct: 0,
          sharpe: res.metrics && Number.isFinite(res.metrics.sharpe) ? res.metrics.sharpe : 0,
          maxDrawdownPct: res.metrics && Number.isFinite(res.metrics.maxDrawdownPct) ? res.metrics.maxDrawdownPct : 0,
          position: res.position || 'flat', holdings: res.holdings || null, curve: [], deployFrac: 1,
        };
      }
      deployIdx = Math.max(0, Math.min(deployIdx, eq.length - 1)); // backfill cutoff — for the chart deploy marker + the trade track/live split
      const last = eq[eq.length - 1];
      const intraday = isIntradayInterval(bot.interval);
      // Live % = the LATEST trading day's return (today's move). Track % = the TOTAL
      // return over the bot's whole life (first bar to now). (Live is the daily figure,
      // Track is the lifetime figure.) For an INTRADAY bot "today's
      // move" spans ALL of the current session's bars: from the close just before today's
      // first bar to now — not just the last hour.
      let liveReturnPct;
      if (intraday && times.length >= 2) {
        const lastDay = istDate(times[times.length - 1]);
        let dayStart = times.length - 1;
        while (dayStart > 0 && istDate(times[dayStart - 1]) === lastDay) dayStart--;
        const base = dayStart >= 1 ? eq[dayStart - 1] : eq[0]; // yesterday's close (or the very first bar)
        // When solvent, a normal % return; if the base is already underwater (a blown short),
        // a ratio return is meaningless and would MASK the move as 0% — so express today's move
        // as a fraction of starting capital instead, keeping a wiped bot honestly negative.
        liveReturnPct = base > 0 ? (last / base - 1) * 100 : (last - base) / CASH * 100;
      } else {
        const prevDay = eq.length >= 2 ? eq[eq.length - 2] : eq[0];
        liveReturnPct = prevDay > 0 ? (last / prevDay - 1) * 100 : (last - prevDay) / CASH * 100;
      }
      const trackReturnPct = eq[0] > 0 ? (last / eq[0] - 1) * 100 : 0; // = MAX (whole life)
      // Return over a trailing CALENDAR window ending now, MARKED-TO-MARKET — i.e. exactly "as
      // if the bot squared off everything NOW vs at the window's start". The equity curve already
      // values open positions at each bar's price, so a window return is just eq[now] / eq[the
      // bar at-or-before (now − window)] − 1. Returns null when the bot lacks that much history
      // (e.g. the ~2y intraday bot has no 5Y/10Y; a wiped bot uses a capital-relative move).
      const DAY = 864e5;
      const periodRet = (windowMs) => {
        if (eq.length < 2) return null;
        const startT = times[times.length - 1] - windowMs;
        if (!(times[0] <= startT)) return null; // window starts before the bot's first bar
        let i = 0;
        for (let j = 0; j < times.length; j++) { if (times[j] <= startT) i = j; else break; }
        const base = eq[i];
        return +(base > 0 ? (last / base - 1) * 100 : (last - base) / CASH * 100).toFixed(2);
      };
      // Stash the bot's FULL daily curve for the Auto-Pilot walk-forward (daily bots only —
      // intraday live on a separate ~2y 60-min timeline and aren't part of the long-run race).
      if (!intraday) apCurves.push({ id: bot.id, name: bot.name, kind: bot.kind, symbol: bot.symbol, protected: !!bot.protected, eq, times, holdings: res.holdings || null });
      return {
        id: bot.id,
        name: bot.name,
        kind: bot.kind,
        symbol: bot.symbol,
        interval: bot.interval || '1d',
        gen: bot.gen || 0,
        note: bot.note || res.note || '',
        explain: explainSpec(bot.spec),
        protected: !!bot.protected,
        equity: Math.round(res.metrics.finalEquity),
        liveReturnPct: +liveReturnPct.toFixed(2), // 1D (today's move; intraday = today's session)
        // Trailing-window returns (marked-to-market). null = not enough history for that window.
        r1w: periodRet(7 * DAY),
        r1m: periodRet(30.44 * DAY),
        r1y: periodRet(365.25 * DAY),
        r3y: periodRet(3 * 365.25 * DAY), // for the Auto-Pilot's "if you'd followed it for 3 years" view
        r5y: periodRet(5 * 365.25 * DAY),
        r10y: periodRet(10 * 365.25 * DAY),
        trackReturnPct: +trackReturnPct.toFixed(2), // MAX (whole life)
        sharpe: res.metrics.sharpe,
        maxDrawdownPct: res.metrics.maxDrawdownPct,
        position: res.position || 'flat',
        holdings: res.holdings || null, // basket constituents + weights (null for EQ/FNO)
        curve: downsample(eq.map((c, i) => ({ t: times[i] != null ? times[i] : i, c }))),
        deployFrac: eq.length > 1 ? deployIdx / (eq.length - 1) : 1,
      };
    } // end buildRow

    // Final assembly shared by BOTH recompute paths: sort the rows, derive the board meta,
    // build the Auto-Pilot walk-forward, and publish into `standings`. This single assignment
    // is the ONLY point where the live board is swapped, so a request that lands mid-recompute
    // always reads the last COMPLETE board, never a half-built one.
    function assembleStandings(rows, apCurves) {
      rows.sort((a, b) => b.liveReturnPct - a.liveReturnPct || b.trackReturnPct - a.trackReturnPct);
      const liveBars = Math.max(0, ...rosterSources().map(({ key }) => (state.live[key] || []).length));
      // atCap tells the POLLED board (not just the per-click POST) that grow-mode
      // evolution has paused because the roster is full — so the live UI can say so.
      const atCap = !retireWeakest && roster.length >= maxRosterBots;
      // The honest "Auto-Pilot vs the market" walk-forward (null until there's ≥1y of history).
      const autopilot = computeAutopilotTrack(apCurves, CASH);
      standings = { deployedAt: state.deployedAt, generation: state.generation, liveBars, asOf: Date.now(), startingCash: CASH, atCap, maxBots: maxRosterBots, botCount: rows.length, evolutionEnabled, autopilot, history: state.history.slice(-30), bots: rows };
      return standings;
    }

    // SYNCHRONOUS recompute — used by the control ops (reset/add/remove/evolve/_appendLiveClose)
    // and the unit tests, which read getStandings() immediately after. No yields, so behaviour is
    // IDENTICAL to the original single-function computeStandings — those paths are byte-unchanged.
    function computeStandings() {
      recomputeGen++; // supersede any in-flight yielding recompute
      detailCache.clear(); // the per-bot detail depends on this same state — invalidate it
      const apCurves = []; // full (un-downsampled) daily equity curves, for the Auto-Pilot walk-forward
      // A pass-scoped aligned-grid cache so baskets over the SAME wide universe build the
      // forward-filled price grid only ONCE. Fresh each pass, so it can never serve a stale grid.
      const alignCache = new Map();
      const rows = bots.map((bot) => buildRow(bot, apCurves, alignCache));
      return assembleStandings(rows, apCurves);
    }

    // YIELDING recompute — used by the BACKGROUND paths (init/tick/tickIntraday). It frees the
    // event loop between bots (await setImmediate), so the server keeps answering requests (serving
    // the last COMPLETE standings) instead of FREEZING for the whole multi-bot ~20-year recompute —
    // the fix for the deployed board's cold-boot / new-bar lag. Aborts (leaving the previous board
    // in place) the instant a newer recompute supersedes it — a control op's sync computeStandings,
    // or another tick — so the latest always wins and two recomputes never interleave-corrupt. `bots`
    // is captured once: rebuildBots() REASSIGNS it (never mutates in place), so this snapshot stays
    // consistent even if the roster changes mid-recompute (we abort on the very next yield anyway).
    // ACCEPTED TRANSIENT (cold boot only): the background pool loader (init) keeps writing fullData/
    // backfill as the ~200-name universe arrives, WITHOUT bumping recomputeGen, so a deadline-board
    // recompute can score early baskets over fewer loaded names than late ones — one internally-mixed
    // board, self-corrected by the line-859 poolDone recompute over the complete universe. Harmless: it
    // is a finer-grained flavour of the already-documented "board comes up with what's loaded; baskets
    // fill in over minutes" cold-boot behaviour — every row is an individually valid backtest, the board
    // is never published half-built (assembleStandings is the sole atomic swap), and the SETTLED board is
    // fully consistent. Not guarded on purpose: bumping gen per pool-load would stop the deadline board
    // from ever publishing during the load (defeating the cold-boot fix).
    async function computeStandingsYielding() {
      const myGen = ++recomputeGen;
      detailCache.clear();
      const apCurves = [];
      const alignCache = new Map();
      const botList = bots;
      const rows = [];
      for (const bot of botList) {
        rows.push(buildRow(bot, apCurves, alignCache));
        await new Promise((resolve) => setImmediate(resolve)); // free the event loop between bots
        if (recomputeGen !== myGen) return standings; // superseded — don't clobber the newer board
      }
      return assembleStandings(rows, apCurves);
    }

  async function init() {
    load(); // restore the persisted roster FIRST, so we load data for ITS symbols too
    // Data sources whose history we preload: the full DAILY universe in production (so
    // evolution can hunt across stocks), or the test-provided keys — ALWAYS unioned
    // with the (post-load) roster sources, so a persisted/evolved bot on any symbol
    // (incl. an intraday one) never ends up with no data (a NaN, unretireable row).
    // A source is { key, symbol, interval }; the universe + a test's bare-symbol keys
    // are DAILY, intraday bots contribute '60m:SYMBOL' keys.
    const sourceMap = new Map();
    const baseKeys = backfillData ? Object.keys(backfillData) : STOCKS;
    for (const k of baseKeys) { const { symbol, interval } = parseKey(k); sourceMap.set(dataKey(symbol, interval), { symbol, interval }); }
    // Union the post-load ROSTER's sources AND the SEED's sources. Loading the seed's
    // too means a later reset() (which rebuilds from the seed) always has data — even if
    // the persisted roster lacked a seed bot whose source isn't in the daily universe
    // (e.g. an intraday '60m:SYMBOL' that STOCKS doesn't cover).
    for (const s of [...rosterSources(), ...sourcesOf(seed)]) sourceMap.set(s.key, { symbol: s.symbol, interval: s.interval });
    const sources = [...sourceMap.entries()].map(([key, v]) => ({ key, ...v }));
    // DATA HYGIENE (for the ~200-name universe). Symbols that MUST keep data even if
    // Yahoo fails: the indices/benchmark + any symbol a single-symbol (EQ/FNO/intraday) bot
    // trades — for those a synthetic fallback keeps the bot (and the offline app) working, the
    // long-standing behaviour. A pure basket-POOL name is different: a synthetic price has no
    // real edge, so we DROP a pool name that can't fetch REAL history rather than let a basket
    // trade a fake series. A dropped name simply isn't in fullData, and alignSeries /
    // runPortfolioBacktest already skip a constituent with no data, so the basket just hunts the
    // names that ARE clean. (Tests inject backfillData -> never synthetic -> never dropped.)
    // requiredKeys: the data KEYS that must keep data even if synthetic (the index/benchmark +
    // each single-symbol bot's ACTUAL source key, interval-qualified). Keyed by dataKey (NOT the
    // bare symbol) so a name that is BOTH a single-symbol bot's symbol AND a basket-pool name is
    // exempt only for the KEY its bot needs (e.g. '60m:RELIANCE') — the DAILY pool series of that
    // same name is still dropped-if-synthetic instead of polluting every basket.
    const requiredKeys = new Set([dataKey('NIFTY', '1d'), dataKey('BANKNIFTY', '1d'), dataKey('FINNIFTY', '1d')]);
    for (const b of [...roster, ...seed]) if (b && !spansUniverse(b.kind) && b.symbol) requiredKeys.add(dataKey(b.symbol, b.interval || '1d'));
    let dropped = 0, failed = 0;
    // Load ONE source (with the synthetic-drop hygiene + the never-abort-the-boot guard).
    const loadOne = async ({ key, symbol, interval }) => {
      try {
        let candles, synthetic = false;
        if (backfillData && backfillData[key]) {
          candles = backfillData[key];
        } else {
          const loaded = await loadCandles(symbol, { interval, range: rangeFor(interval) });
          candles = loaded.candles;
          synthetic = /synthetic/.test(loaded.source || '');
        }
        // Drop a pure basket-pool name with no REAL data (synthetic) — don't pollute baskets. Also
        // CLEAR any stale persisted live bars for it, so a name that was real on a prior boot can't
        // resurrect (backfill-less) through state.live after it later goes synthetic.
        if (synthetic && !requiredKeys.has(key)) { dropped++; delete state.live[key]; return; }
        fullData[key] = candles;
        // The backfill is the whole fetched series when the cap is Infinity (the default —
        // "trade from the oldest data"); a finite cap keeps only the last N bars.
        const cap = backfillBarsFor(interval);
        backfill[key] = Number.isFinite(cap) ? candles.slice(-cap) : candles.slice();
      } catch (e) {
        // One symbol's load must NEVER abort the whole boot. Skip it; a non-required name is simply
        // absent (baskets skip it) and the board still comes up.
        failed++;
        if (requiredKeys.has(key)) console.log(`tournament: WARNING — required ${key} failed to load (${e && e.message}).`);
      }
    };
    // REQUIRED sources (indices + each single-symbol bot's data key) load FIRST and block the board — a
    // small set, so the benchmark + the EQ/FNO/ETF-trend/intraday bots always have data. The broad
    // basket POOL then loads WITHOUT blocking the board: after BOOT_DEADLINE_MS we compute the first
    // standings (the board appears) and the rest of the pool keeps loading in the BACKGROUND, with a
    // recompute when it finishes — so a slow/rate-limited ~200-symbol cold fetch on a free host never
    // 503s the board for minutes. (Render cold-boot fix.) With injected backfillData (tests) the pool
    // resolves instantly, so the deadline never fires and behaviour is unchanged.
    const requiredSrc = sources.filter((s) => requiredKeys.has(s.key));
    const poolSrc = sources.filter((s) => !requiredKeys.has(s.key));
    await mapLimit(requiredSrc, BOOT_FETCH_CONCURRENCY, loadOne);
    let poolDone = false;
    const poolLoad = mapLimit(poolSrc, BOOT_FETCH_CONCURRENCY, loadOne).then(() => { poolDone = true; });
    let deadlineTimer;
    await Promise.race([poolLoad, new Promise((r) => { deadlineTimer = setTimeout(r, BOOT_DEADLINE_MS); })]);
    clearTimeout(deadlineTimer); // don't leak the timer when the pool wins the race (e.g. in tests)
    // Did the DEADLINE win the race (pool still loading)? Capture it NOW, before the slow
    // computeStandingsYielding() below. Re-reading poolDone AFTER that recompute is a TOCTOU
    // race: on a cold boot the pool (nearly done at the deadline) often finishes DURING the
    // ~tens-of-seconds recompute, so a post-recompute `if (!poolDone)` check would see true and
    // SKIP the corrective recompute — leaving the deadline board (built over a PARTIAL universe)
    // uncorrected until the next daily bar. Snapshotting here is safe (no await between the race
    // and the snapshot, so poolLoad's .then can't have flipped poolDone yet).
    const deadlineFired = !poolDone;
    if (dropped || failed) console.log(`tournament: ${dropped} synthetic + ${failed} failed symbol(s) so far; board coming up with what's loaded.`);
    if (!state.deployedAt) {
      state.deployedAt = Date.now();
      state.live = {};
      state.generation = 0;
      save();
    }
    await computeStandingsYielding(); // the board is available now (required bots full; baskets with the pool loaded so far)
    // If the deadline fired (pool still loading at that point), recompute once the pool FINISHES
    // so the baskets fill in over the COMPLETE universe. Gated on the pre-recompute `deadlineFired`
    // snapshot, NOT a re-read of poolDone, so the race above can't skip it. Idempotent: if the pool
    // already finished during the recompute above, .then fires immediately and recomputes over the
    // now-full universe (one extra cheap pass over a consistent snapshot).
    if (deadlineFired) poolLoad.then(async () => { try { await computeStandingsYielding(); save(); } catch { /* best-effort */ } }).catch(() => {});
    return standings;
  }

  async function tick() {
    const today = istDate(Date.now());
    const seq0 = opSeq; // snapshot: if a control op mutates state during our await, bail
    let changed = false;
    for (const { symbol, interval, key } of rosterSources()) {
      if (isIntradayInterval(interval)) continue; // intraday sources are handled by tickIntraday()
      // Skip a DROPPED (synthetic, no-real-data) symbol: it has no backfill, so seriesFor ignores it
      // anyway — appending live bars to its state.live would just grow stale, never-used persisted
      // state. Keep tick() consistent with the boot-time data hygiene.
      if (!(backfill[key] && backfill[key].length)) continue;
      try {
        const res = await freeProvider.getHistory(symbol, { interval: '1d', range: '5d' });
        // A reset/add/remove/evolve landed during the network round-trip — abort
        // so we never push stale live data onto (or clobber) the new state.
        if (opSeq !== seq0) return changed;
        const cs = (res.candles || []).filter((c) => Number.isFinite(c.c) && c.c > 0 && istDate(c.t) < today);
        const lastBar = cs[cs.length - 1];
        if (!lastBar) continue;
        const series = seriesFor(symbol, interval);
        const lastT = series.length ? series[series.length - 1].t : 0;
        if (lastBar.t > lastT) {
          if (!state.live[key]) state.live[key] = [];
          state.live[key].push({ t: lastBar.t, c: lastBar.c });
          changed = true;
        }
      } catch {
        /* no new bar this tick */
      }
    }
    if (changed) {
      save();
      await computeStandingsYielding();
    }
    return changed;
  }

  // The INTRADAY tick: fetch fresh 60-min bars for the intraday data sources and append
  // any NEW ones. Gated on the NSE session being OPEN — off-hours/weekends/holidays a
  // 60-min bar can't change, so this is a cheap no-op that doesn't burn the free host's
  // network quota (the next trading session catches any straggler bar via the de-dup/sort in
  // seriesFor). Uses the SAME opSeq race guard as tick(). `now` is injectable for tests.
  async function tickIntraday({ now = Date.now() } = {}) {
    const sources = rosterSources().filter((s) => isIntradayInterval(s.interval));
    if (!sources.length) return false;
    if (!getMarketState(new Date(now)).isOpen) return false; // only during the live session
    const seq0 = opSeq;
    let changed = false;
    for (const { symbol, interval, key } of sources) {
      try {
        const res = await freeProvider.getHistory(symbol, { interval, range: '1mo' });
        if (opSeq !== seq0) return changed; // a control op landed mid-await — abort
        // Drop the CURRENT, still-forming bar (the intraday analogue of daily tick()'s
        // `istDate(c.t) < today` guard): Yahoo emits a candle for the in-progress hour,
        // and our append-only cursor would FREEZE that partial close forever (a later
        // re-fetch of the same timestamp is skipped). So only accept a bar whose whole
        // window has elapsed (`c.t + period <= now`); the still-forming bar is picked up
        // once its hour closes — kept reproducible vs a clean offline backtest.
        const period = intervalMs(interval);
        const cs = (res.candles || []).filter((c) => Number.isFinite(c.c) && c.c > 0 && c.t + period <= now).sort((a, b) => a.t - b.t);
        const series = seriesFor(symbol, interval);
        let cursor = series.length ? series[series.length - 1].t : 0; // advance as we append
        for (const bar of cs) {
          if (bar.t > cursor) {
            if (!state.live[key]) state.live[key] = [];
            state.live[key].push({ t: bar.t, c: bar.c });
            cursor = bar.t;
            changed = true;
          }
        }
      } catch {
        /* no new bars this tick */
      }
    }
    if (changed) {
      save();
      await computeStandingsYielding();
    }
    return changed;
  }

  // One generation of evolution: breed challengers, and if the best beats the
  // weakest (non-protected) bot's risk-adjusted fitness, bring it in. In GROW mode
  // (the default) it is APPENDED and nobody is retired (until the board hits
  // maxRosterBots, after which this is a cheap no-op); with retireWeakest it REPLACES
  // the weakest bot (old behaviour).
  function runGeneration({ seed: gseed } = {}) {
    opSeq++;
    // Breeding is turned OFF for production (evolutionEnabled:false) — the board stays the
    // curated seed line-up. A no-op (not an error): the daily timer + a manual Evolve click
    // both land here harmlessly. The machinery below is intact; re-enable via the flag.
    if (!evolutionEnabled) return { generation: state.generation, promoted: null, retired: null, disabled: true };
    const s = (gseed == null ? (Date.now() & 0x7fffffff) : gseed) >>> 0;
    // GROW mode + the board already at the cap: short-circuit BEFORE the heavy
    // breeding + full-roster backtesting (its result would only be discarded). Report
    // `full` so the UI can show "evolution paused (board full)". retireWeakest keeps a
    // fixed-size board so it never fills this way.
    if (!retireWeakest && roster.length >= maxRosterBots) {
      return { generation: state.generation, promoted: null, retired: null, full: true, max: maxRosterBots };
    }
    // Only symbols whose data is actually loaded are eligible to hunt on.
    const eqSymbols = EQ_SYMBOLS.filter((sym) => fullData[sym] && fullData[sym].length >= 60);
    const fnoSymbols = FNO_SYMBOLS.filter((sym) => fullData[sym] && fullData[sym].length >= 60);
    // Baskets pick from the INDEX-FREE stock pool (a basket holds companies, not
    // the index — else it just overlaps the protected Buy & Hold benchmark).
    const basketSymbols = BASKET_UNIVERSE.filter((sym) => fullData[sym] && fullData[sym].length >= 60);
    if (!eqSymbols.length && !fnoSymbols.length) return { generation: state.generation, promoted: null, retired: null };

    // Breed only from NON-protected bots that actually COMPILE. (The benchmark is a
    // yardstick, not breeding stock; and a corruptly-persisted MALFORMED spec must
    // never become an evolution parent — it can't be scored and would crash crossover.
    // Grow mode keeps every bot on the roster forever, so we guard here rather than
    // rely on the old behaviour of retiring it.) Challengers explore strategy, symbol,
    // AND basket/ML config, each scored on its own symbol/universe. Never promote a
    // structural duplicate.
    // Intraday bots are a SEPARATE track: they're scored on intraday data, so they must
    // never be bred onto daily symbols nor used as the weakest-bar (which is scored on
    // DAILY fullData below). They still count toward the grow-mode cap (board size).
    const compilable = roster.filter((b) => !isIntradayInterval(b.interval) && safeCompile(b.spec).ok);
    const breedable = compilable.filter((b) => !b.protected);
    const parents = breedable.length ? breedable : compilable;
    if (!parents.length) return { generation: state.generation, promoted: null, retired: null };
    // Score evolution on a bounded recent window (see EVOLVE_WINDOW) so a generation
    // stays a few seconds, not ~30, on the free host. Symbol eligibility above still
    // uses the FULL fullData length; only the per-bot backtest series is trimmed.
    const recentData = {};
    for (const sym of Object.keys(fullData)) recentData[sym] = fullData[sym].slice(-EVOLVE_WINDOW);
    const challengers = evolve({ roster: parents, dataBySymbol: recentData, eqSymbols, fnoSymbols, basketSymbols, n: 16, seed: s, cash: CASH });
    const keyOf = (sym, spec) => `${sym}|${specKey(spec)}`;
    const existing = new Set(roster.map((b) => keyOf(b.symbol, b.spec)));
    const best = challengers.find((ch) => !existing.has(keyOf(ch.symbol, ch.spec)));
    if (!best) return { generation: state.generation, promoted: null, retired: null };

    // Weakest current bot — the quality bar a challenger must clear to enter the
    // board (so it grows with credible strategies, not noise). protected bots are
    // never the target. EQ/FNO are scored on their own symbol; a BASKET is scored
    // across its whole universe via the portfolio backtester (using fullData) —
    // otherwise fullData[label] is undefined and a basket could never be scored.
    const scoreBot = (b) => spansUniverse(b.kind)
      ? scoreSpec(b.spec, null, b.symbol, CASH, recentData)
      : (recentData[b.symbol] ? scoreSpec(b.spec, recentData[b.symbol], b.symbol, CASH) : null);
    const scored = roster
      .filter((b) => !b.protected && !isIntradayInterval(b.interval))
      .map((b) => ({ b, fit: fitness(scoreBot(b)) }))
      .sort((a, z) => a.fit - z.fit);
    const weakest = scored[0];

    let promoted = null, retired = null, promotedId = null;
    if (weakest && fitness(best.score) > weakest.fit + 1e-9) {
      // GROW mode: never cut a bot — the board keeps every strategy for comparison.
      // (The board-full case was handled at the top of runGeneration.) retireWeakest
      // restores the old "replace the weakest" path.
      state.generation += 1;
      // The id carries a time token (like addFromPool) ON TOP of the generation, so a
      // grown bot's id stays unique even if a hand-edited/restored state file ever
      // rewinds the generation counter below an already-rostered evo-g{N}.
      const newBot = asRosterEntry(
        { id: `evo-g${state.generation}-${Date.now().toString(36)}`, name: best.spec.name, note: best.spec.note || 'evolved', kind: best.kind, symbol: best.symbol, spec: best.spec },
        state.generation
      );
      if (retireWeakest) {
        const idx = roster.indexOf(weakest.b);
        retired = `${roster[idx].name} (${roster[idx].symbol})`;
        roster[idx] = newBot; // old behaviour: the winner takes the weakest's slot
      } else {
        roster.push(newBot); // GROW: append the winner, retire nobody
      }
      promoted = `${newBot.name} (${best.symbol})`;
      promotedId = newBot.id; // so the UI can highlight the freshly-added bot for comparison
      state.history.push({ gen: state.generation, promoted, retired, at: Date.now() });
      rebuildBots();
      save();
      computeStandings();
    }
    return { generation: state.generation, promoted, promotedId, retired, challengerFit: +fitness(best.score).toFixed(2) };
  }

  // --- Roster control (the browser control panel) -------------------------
  // Reset to the original curated line-up at generation 0, fresh forward clock.
  function reset() {
    opSeq++;
    roster = seed.map((b) => asRosterEntry(b));
    rebuildBots();
    state.live = {};
    state.generation = 0;
    state.history = [];
    state.deployedAt = Date.now();
    save();
    computeStandings();
    return { ok: true, bots: bots.length };
  }

  // Remove a bot by id (protected bots and the last 2 are kept).
  function removeBot(id) {
    opSeq++;
    const idx = roster.findIndex((b) => b.id === id);
    if (idx < 0) return { ok: false, error: 'No such bot' };
    if (roster[idx].protected) return { ok: false, error: 'That bot is protected' };
    if (roster.length <= 2) return { ok: false, error: 'Need at least 2 bots' };
    const removed = roster[idx].name;
    roster.splice(idx, 1);
    rebuildBots();
    save();
    computeStandings();
    return { ok: true, removed };
  }

  // Add one random un-rostered strategy from the generated pool.
  function addFromPool() {
    opSeq++;
    // Respect the grow-mode roster cap (the same one runGeneration enforces) — the
    // cap bounds computeStandings cost on the free host, so the manual "Add" must not
    // grow the board past it either.
    if (!retireWeakest && roster.length >= maxRosterBots) return { ok: false, error: `Board is full (${maxRosterBots} bots).`, full: true, max: maxRosterBots };
    if (pool == null) {
      try {
        const f = join(HERE, '..', 'backtest', 'generated-specs.json');
        pool = fileExists(f) ? JSON.parse(readFile(f, 'utf8')) : [];
      } catch {
        pool = [];
      }
    }
    if (!pool.length) return { ok: false, error: 'No strategy pool available' };
    // Today's pool is EQ/FNO only (those join on NIFTY), but stay correct if a
    // BASKET spec is ever added: a basket's identity is its universe label, not a
    // symbol — so derive the symbol + dedup key by kind (matching asRosterEntry /
    // evolution), else a basket would be mislabelled "NIFTY" and under-dedup.
    const symFor = (s) => (spansUniverse(s.kind) ? basketLabel(s) : 'NIFTY'); // BASKET/PAIRS label by their universe, not a symbol
    const have = new Set(roster.map((b) => `${b.symbol}|${specKey(b.spec)}`));
    const candidates = pool.filter((s) => safeCompile(s).ok && !have.has(`${symFor(s)}|${specKey(s)}`));
    if (!candidates.length) return { ok: false, error: 'Pool exhausted' };
    // Deterministic-ish pick: rotate by current roster size.
    const choice = candidates[roster.length % candidates.length];
    roster.push(asRosterEntry({
      id: `pool-${roster.length}-${Date.now().toString(36)}`,
      name: choice.name || 'Pool strategy',
      note: choice.note || 'added from the generated pool',
      kind: choice.kind,
      symbol: symFor(choice),
      spec: choice,
    }));
    rebuildBots();
    save();
    computeStandings();
    return { ok: true, added: choice.name };
  }

  function _appendLiveClose(symbol, bar, interval = '1d') {
    const key = dataKey(symbol, interval);
    if (!state.live[key]) state.live[key] = [];
    state.live[key].push(bar);
    save();
    computeStandings();
  }

  return {
    init,
    tick,
    tickIntraday,
    runGeneration,
    reset,
    removeBot,
    addFromPool,
    getStandings: () => standings,
    getBotDetail,
    detailIsCached: (id) => detailCache.has(id), // a cache HIT serves getBotDetail for free (no backtest)
    botCount: () => bots.length,
    rosterSize: () => roster.length,
    evolutionEnabled, // so the server can skip the daily auto-evolve timer when off
    _appendLiveClose,
    _state: () => state,
    _roster: () => roster,
    _seriesFor: (sym, interval = '1d') => seriesFor(sym, interval),
    // Test-only: the two recompute paths, so a regression test can lock that the YIELDING
    // board equals the SYNC board, and that a superseding recompute wins the handoff.
    _computeStandings: () => computeStandings(),
    _computeStandingsYielding: () => computeStandingsYielding(),
  };
}

export { createTournament, computeAutopilotTrack };
