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

import { loadCandles, dropFormingBar, dailySessionClosed } from '../backtest/data.mjs';
import { runBacktest } from '../backtest/backtester.mjs';
import { runFnoBacktest } from '../backtest/fno.mjs';
import { runPortfolioBacktest } from '../backtest/portfolio.mjs';
import { runPairsBacktest } from '../backtest/pairs.mjs';
import { sharpe as sharpeOfCurve, maxDrawdownPct, RF_ANNUAL } from '../backtest/metrics.mjs';
// VaR / Expected Shortfall + a no-hindsight VaR back-test per bot (backtest/risk.mjs).
import { riskProfile } from '../backtest/risk.mjs';
import { equityDeliveryCosts, equityIntradayCosts, indexOptionCosts } from '../backtest/costs.mjs';
import { makeRankSource } from '../backtest/ml.mjs';
import { safeCompile, explainSpec, strategyRationale } from '../backtest/dsl.mjs';
import freeProvider from '../src/dataSources/freeProvider.js';
import marketHours from '../src/marketHours.js'; // CommonJS -> default import, then destructure
const { getMarketState } = marketHours;
import { SEED_BOTS } from './seed.mjs';
import { createPersistStore } from './persistStore.mjs';
import { ADVISOR_MIN_DAYS, buildAdvisorEntry, appendAdvisorEntry, sanitizeAdvisorLog, buildAdvisorPayload, syntheticDataBlock } from './advisor.mjs';
import { STOCKS, BASKET_UNIVERSE, FNO_INDICES, EQ_SYMBOLS, FNO_SYMBOLS } from './universe.mjs';
import { evolve, scoreSpec, fitness } from './evolve.mjs';
import { readFileSync as readFile, existsSync as fileExists } from 'node:fs';

const INDEX_SPECS = FNO_INDICES; // F&O lot size + strike grid, keyed by index symbol

// The tournament always runs the REAL Indian cost schedules (backtest/costs.mjs) —
// the leaderboard is the project's honest surface, so no bot trades for a flat 5bps
// or sells option premium for free. Built once; the models are pure + stateless.
const EQ_COSTS = equityDeliveryCosts();      // daily EQ / BASKET / PAIRS legs (incl. SLB borrow on shorts)
const EQ_COSTS_INTRADAY = equityIntradayCosts(); // only reachable via a `squareOffDaily` bot —
// UNREACHABLE on the current roster by design: no shipped bot certifies that it squares off
// daily, and bar interval alone never selects this schedule (see runBot). // the 60m intraday track (lighter STT, no overnight borrow)
const OPT_COSTS = indexOptionCosts();        // F&O premium sellers (spread + charges + brokerage + expiry STT)
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

// Keep only well-formed forward bars from a RESTORED remote `live` map. The remote store
// (a Gist) is externally editable, so a corrupt / hand-edited entry must never inject a bad
// bar into a backtest: drop any non-array key and any bar without a finite t & c.
function sanitizeLiveMap(live) {
  const out = {};
  if (!live || typeof live !== 'object') return out;
  for (const [key, arr] of Object.entries(live)) {
    if (!Array.isArray(arr)) continue;
    const clean = arr.filter((b) => b && Number.isFinite(b.t) && Number.isFinite(b.c));
    if (clean.length) out[key] = clean;
  }
  return out;
}
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

// ★ A PHANTOM BAR IS TWO FACTS TOGETHER, NOT ONE. On a day the exchange was shut the feed still
// emits a daily row for most stocks: the previous close repeated VERBATIM with volume EXACTLY 0
// (measured on four declared 2026 NSE holidays, ~110 names each). Admitting one writes a
// fabricated session into the append-only forward record, so both live admission paths refuse it.
//
// The first version of this guard keyed on volume ALONE — and a later review found that
// it refused REAL SESSIONS: the free feed reports `volume: 0` for the INDICES on ordinary trading
// days (NIFTY: 14 such sessions since 2020 with a moving close, e.g. 1–3 July 2024, re-fetched from
// the raw endpoint to rule out a stale cache; before 2013 every index bar is zero-volume). Because
// NIFTY's series is what stamps an advisor day, a volume-only rule would have dropped that day's
// entry PERMANENTLY — missed days are never back-filled — which is the one artifact here that only
// time can produce. So the rule now requires the carried-forward close as well. `prevClose` is the
// feed's own previous row where the fetch has one, else the last close already in the series;
// with no previous close to compare against the bar is admitted — "cannot tell" must not stall a
// series.
// ★ THIS IS A HEURISTIC ABOUT THE CURRENT FEED, NOT A FACT ABOUT IT. Measured across the cached
// history (132 files, 551k bars): NIFTY carries 1,332 zero-volume bars with a MOVED close and
// zero carried-forward ones, so the old rule really would have dropped 1,332 index sessions and
// this one never false-fires on them; and all four declared 2026 holidays are 100% carry-forward,
// so it holds for 2026-10-02. But two older phantom dates (2009-04-30, 2009-10-13 — nothing traded,
// no index bar) show ~half the names with a zero-volume row whose close MOVED slightly, which this
// rule would ADMIT. There is no rule on these two fields that refuses every phantom and no real
// session; this one is right for the shapes the feed emits today and is preferred because a false
// REFUSAL is as permanent as a missed day. ★ A refused phantom is kept out of the persisted
// forward record (`state.live`) — but the boot backfill has no volume filter, so the same row
// re-enters the board's TIMELINE from the cache at the next redeploy; that half is the open §8
// decision, and this guard does not claim to settle it.
// ★ An ABSENT volume is still NOT treated as zero: "no claim" and "nothing traded" differ.
function isPhantomBar(bar, prevClose) {
  return bar.v === 0 && Number.isFinite(prevClose) && bar.c === prevClose;
}

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
// ...plus a WARM-UP prefix that is traded through but NOT scored. Without it, scoring began at
// bar 0 of the window, so a spec whose rank/gate needs N bars sat in CASH for its first N
// SCORED bars and was charged for the flat stretch — measured on the real universe, that
// inverted `xsmom-research`'s fitness SIGN (Sharpe −0.55 cold vs +0.76 with the cut) and
// systematically punished LONGER lookbacks, which is exactly the axis a GA explores. 300 bars
// covers the longest lookback the DSL allows a challenger to reach (mom 252 / sma 200) with
// room to spare. COST, measured on the real universe rather than assumed from the bar count:
// the ML baskets roughly DOUBLE (ridge 416→858ms, gbm 631→1151ms) because their training cost
// scales with series length, while non-ML specs are flat. Budget ~1.8–2x per generation, not
// the ~40% the extra bars suggest — and note runGeneration is synchronous, so on the free host
// that is a straight event-loop block. Only matters when breeding is on.
// A series too short to spare the prefix (every test fixture) simply scores in full, unchanged.
const EVOLVE_WARMUP = 300;
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
  // `holdK` (the buy/hold spread) belongs here for the same reason the optimiser knobs do:
  // two baskets with the same universe and rank but different hold bands are DIFFERENT
  // strategies — one churns at the k-boundary and one does not — and without this they
  // would dedupe to a single roster entry.
  return JSON.stringify(['BASKET', [...(spec.universe || [])].sort(), spec.k ?? null, spec.rebalanceBars ?? null, spec.weighting ?? null, spec.rank ?? null, spec.gate ?? null, spec.marketGate ?? null, mlKey, factorsKey, spec.covLookback ?? null, spec.maxWeight ?? null, spec.holdK ?? null, spec.rebalanceBand ?? null]);
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
// Score an EXISTING equity curve only from the bar the market proxy starts, and say how many
// bars were skipped. ONE definition, used by both the leaderboard row and the per-bot page, so
// the two can never quote different figures for the same bot.
//
// WHY: `alignSeries` builds a basket's timeline from the UNION of its universe and the market
// series, and most of the universe lists well before NIFTY does. Across that leading stretch a
// GATED basket has no proxy to read, so it reads risk-off, sits flat, and is charged the ~6.5%
// hurdle on every one of those bars. Measured on a real board: every basket carries 301 such
// bars, gated ones read 0.02-0.05 low because of them, and the UNGATED fair bar moves -0.01 —
// so the artifact pushes the two sides of the board's own headline comparison in opposite
// directions.
//
// ★ THIS IS "THE SAME RUN, SCORED LATER" — NOT "the run if the timeline were trimmed". Trimming
// the INPUT moves bar 0, which moves the whole rebalance grid (the rebalance-phase caveat) and changes which names are
// held on which dates; that is a different and much larger effect (a local trimmed re-run of
// quant-riskparity scored ~1.02 against 0.74 as-ranked, while re-scoring gives 0.78). This
// isolates ONLY the dead-bar component, which is why it restates nothing and can be published
// beside the ranked figure rather than instead of it.
function postProxyScore(eq, times, proxyT0) {
  if (!Number.isFinite(proxyT0) || !Array.isArray(times) || !times.length) return { sharpePostProxy: null, preProxyBars: 0 };
  if (!Array.isArray(eq) || eq.length !== times.length) return { sharpePostProxy: null, preProxyBars: 0 };
  if (!(times[0] < proxyT0)) return { sharpePostProxy: null, preProxyBars: 0 }; // no dead stretch: nothing to report
  let n = 0;
  while (n < times.length && times[n] < proxyT0) n++;
  // Below ~30 surviving bars a Sharpe is noise; report the count but no number.
  if (times.length - n < 30) return { sharpePostProxy: null, preProxyBars: n };
  const s = sharpeOfCurve(eq.slice(n));
  return { sharpePostProxy: Number.isFinite(s) ? +s.toFixed(2) : null, preProxyBars: n };
}

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
// `triSeries` (optional): daily candles of a TOTAL-RETURN proxy for the market —
// NIFTYBEES's dividend-adjusted close. The primary benchmark stays the NIFTY price
// index (full ~20y window, and the walk-forward mechanics are untouched), but "the
// market" really pays dividends, so where the TRI proxy's history overlaps the
// walk-forward we ALSO report the head-to-head over that common window (`benchTri`).
// Point-in-time annualised Sharpe over ALL of a bot's history UP TO bar `hi` — matching the
// live Auto-Pilot's "best (full-life) Sharpe" default, so the track record reflects what the
// live copy actually does (and the walk-forward's CURRENT pick == the live champion). Reads
// no future data, so the whole thing stays look-ahead-free. Hoisted to module scope (it is a
// pure function of `a`, `hi` and RF_ANNUAL) so the degenerate-curve rule below can be tested
// directly instead of only through a whole walk-forward.
//
// ★ A DEGENERATE (never-moving) CURVE IS UNPICKABLE BY INTENT, not by floating-point luck.
// Returns here are EXCESS of the risk-free rate, so a curve that never moves is a bot idling
// in cash against a 6.5% hurdle: its mean excess return is exactly -rfBar with zero dispersion,
// which is not a "0 Sharpe" — it is the worst thing on the board and must never be crowned.
// The old guard was `sd > 0`, and it got the right ANSWER for the wrong REASON: summation
// rounding in `mean()` leaves sd at ~1e-18 rather than 0, so the expression returned about
// -1.4e15 — huge and negative, hence never the argmax. But at exactly 20 or 21 returns the
// arithmetic IS exact, sd is truly 0, and the old code returned **0** — which outranks every
// genuinely underwater bot. That case cannot arise today only because AP_MIN_HISTORY (252)
// keeps `rets.length` far above 21; it is an accident of one constant, not a guarantee.
// Returning -Infinity says the intended thing directly and survives AP_MIN_HISTORY changing.
// MEASURED before changing, on a full ~20y board: this alters
// nothing — 16/16 walk-forward fields byte-identical across 70 rebalance bars, 0 winner changes.
function sharpeUpTo(a, hi) {
  // EXCESS-of-risk-free per-bar returns (same convention as metrics.mjs), so the
  // champion is picked on the honest hurdle — a bot merely matching the T-bill
  // rate with volatility no longer looks "risk-adjusted positive".
  const rfBar = RF_ANNUAL / 252;
  const rets = [];
  for (let j = 1; j <= hi; j++) {
    const p = a[j - 1];
    if (p != null && p > 0 && a[j] != null) rets.push(a[j] / p - 1 - rfBar);
  }
  if (rets.length < 20) return -Infinity;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / (rets.length - 1);
  const sd = Math.sqrt(v);
  // Compare sd against the SCALE of the numbers, not against a bare 0 (the same shape as the
  // guard in backtest/metrics.mjs), so a curve that is flat to within rounding is caught too.
  if (sd > Math.max(Math.abs(m), 1e-12) * 1e-9) return (m / sd) * Math.sqrt(252);
  // ZERO DISPERSION — take the limit of m/sd, WHICH HAS A SIGN. Getting this wrong in either
  // direction is a real misranking, so both branches are spelled out:
  //   m < 0  a bot idling in cash while the risk-free rate accrues: the worst thing on the
  //          board, and it must never be crowned.
  //   m > 0  a riskless gain ABOVE the hurdle — the best thing on the board, not the worst.
  //          (A perfectly smooth compounding curve is exactly this, and it is what the
  //          Auto-Pilot fixtures use, so collapsing it to -Infinity silently stops the
  //          walk-forward following an obviously-good bot.)
  //   m = 0  matches the hurdle exactly with no risk taken: genuinely a 0 Sharpe.
  // The old `sd > 0` guard reproduced these signs only by ACCIDENT — rounding left sd at
  // ~1e-18 so `m / sd` blew up with the right sign — and fell through to a flat `0` at the
  // lengths where the arithmetic came out exact (20 and 21 returns), which mis-ranks the
  // idling case as better than any losing-but-trading bot.
  return m > 0 ? Infinity : m < 0 ? -Infinity : 0;
}

function computeAutopilotTrack(curves, cash, triSeries = null) {
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
  // `sharpeUpTo` is the module-scope pure function above (hoisted so its degenerate-curve
  // rule is directly testable); the picking loop below is unchanged.
  const ap = new Array(master.length).fill(null);
  const followed = [];
  let started = false, apEq = cash, lastRebal = -Infinity, chosen = null, startIdx = -1;
  for (let i = 0; i < master.length; i++) {
    // (1) Earn the CURRENT pick's return for this bar, BEFORE any switch (so a re-pick
    //     applies only from the NEXT bar — no switch-bar return leakage).
    // The followed bot's bar is taken as it comes — INCLUDING the bar it blows up on.
    // (Skipping a non-positive `chosen.a[i]` used to let the Auto-Pilot walk away from a
    // blow-up at its PRE-blow-up equity: the loss was never booked, the next quarterly
    // re-pick resumed compounding from the frozen figure, and maxDrawdown read 0 through
    // a >100% loss of capital. The track record must wear its champion's disasters.)
    if (started && chosen && i > 0 && apEq > 0 && chosen.a[i] != null && chosen.a[i - 1] != null && chosen.a[i - 1] > 0) {
      apEq *= chosen.a[i] / chosen.a[i - 1];
    }
    if (started) ap[i] = apEq;
    // (2) (re)pick at a rebalance bar (or the very first eligible bar), using ONLY data ≤ i.
    // A WIPED account (apEq ≤ 0) has nothing left to trade with, so no re-pick can revive
    // it — the track holds the wiped value for the rest of its life, honestly.
    if (started && apEq <= 0) {
      // dead account: no re-pick
    } else if (i - lastRebal >= AP_REBAL_BARS || !started) {
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
  // TRI-proxy head-to-head (see the triSeries doc above): forward-fill the proxy onto
  // the master timeline, then compare the Auto-Pilot and the proxy over the COMMON
  // window (both rebased at the proxy's first bar inside the walk-forward). Reported
  // only when the overlap is ≥ ~1 year — a shorter head-to-head says nothing.
  let benchTri = null;
  if (Array.isArray(triSeries) && triSeries.length >= 2) {
    const tri = new Array(master.length).fill(null);
    let ti = 0, lastT = null;
    for (let i = 0; i < master.length; i++) {
      while (ti < triSeries.length && triSeries[ti].t <= master[i]) { lastT = triSeries[ti].c; ti++; }
      tri[i] = lastT;
    }
    let base = -1;
    for (let i = startIdx; i < master.length; i++) { if (tri[i] != null && tri[i] > 0) { base = i; break; } }
    const end = master.length - 1;
    if (base >= 0 && master[end] - master[base] >= 365 * 864e5
      && tri[end] != null && tri[end] > 0 && ap[base] != null && ap[base] > 0 && ap[end] != null) {
      const apReturnPct = +(((ap[end] / ap[base]) - 1) * 100).toFixed(2);
      const triReturnPct = +(((tri[end] / tri[base]) - 1) * 100).toFixed(2);
      benchTri = {
        name: 'NIFTYBEES (dividend-adjusted market proxy)',
        startedAt: master[base],
        apReturnPct,
        triReturnPct,
        vsPct: +(apReturnPct - triReturnPct).toFixed(2),
      };
    }
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
    benchTri, // dividend-adjusted market head-to-head over the common window (null if no proxy data)
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
  // Does this strategy guarantee it is FLAT by the close? Only then is the intraday (MIS)
  // cost schedule honest — see runBot. Defaults to false, so an intraday-INTERVAL bot that
  // can carry a position overnight pays real DELIVERY costs (the conservative direction).
  squareOffDaily: !!b.squareOffDaily,
  gen: b.gen == null ? gen : b.gen,
  protected: !!b.protected,
  // Is this row a CONTROL rather than a strategy? `bar-universe-equal` holds the whole universe
  // at equal weight with no ranking signal, no filter and no market timing — it sits on the
  // board as the yardstick every basket must beat before "beats the index" means anything.
  // Deliberately NOT folded into `protected`, which already means something else entirely (the
  // Buy & Hold row, used as the walk-forward's benchmark series and shielded from culling).
  // Nothing about the board or the walk-forward changes: a benchmark row still competes, still
  // ranks, and can still be crowned Auto-Pilot champion — which is the honest behaviour, since
  // "nothing here beats holding the whole universe blind" is a verdict this board should be
  // able to reach. The ONE thing it gates is the ADVISOR (see advisor.mjs): real-money guidance
  // for hand-placed orders cannot sensibly be "buy all ~105 names", and a control is not advice.
  benchmark: !!b.benchmark,
});

async function createTournament({ seed = SEED_BOTS, backfillData = null, persist = true, stateFile = STATE_FILE, retireWeakest = RETIRE_WEAKEST, maxRosterBots = MAX_ROSTER_BOTS, evolutionEnabled = true, persistStore = createPersistStore(), advisorMinDays = ADVISOR_MIN_DAYS } = {}) {
  // persistStore: an OPTIONAL remote store (a secret GitHub Gist via fetch — see
  // persistStore.mjs) that persists the live-forward state ACROSS an ephemeral-disk
  // redeploy (Render free tier). The default reads the host env (PERSIST_GIST_ID /
  // PERSIST_GIST_TOKEN); when those are unset it is a strict NO-OP, so the tournament
  // behaves byte-identically to before and server.js needs no change to opt in — just
  // set the two env vars. Tests inject an in-memory stub.
  // evolutionEnabled: whether the local genetic algorithm BREEDS + adds challengers. The
  // production server (server.js) passes FALSE — intentionally: the board shows only the
  // CURATED seed line-up, not unproven in-sample GA mutations (a bred bot merely beat the
  // weakest bot on a ~3-year in-sample window — a low, overfit-prone bar). The whole evolution
  // machinery (evolve.mjs, runGeneration, addFromPool, the unit tests) is KEPT intact behind
  // this flag; flip server.js back to true (or pass evolutionEnabled:true) to resume breeding.
  // Default true so the mechanism + its tests still exercise evolution unchanged.
  const fullData = {}; // symbol -> full cached candles (for evolution scoring)
  const backfill = {}; // symbol -> fixed recent window (the live track record)
  // Data KEYS whose series is the OFFLINE SYNTHETIC fallback rather than real market data. A pool
  // name that loads synthetic is DROPPED, so this only ever holds REQUIRED keys (the indices and
  // each single-symbol bot's key), which are deliberately exempt from that drop so the board — and
  // the offline app — still come up. The board may show invented data and say so; the APPEND-ONLY
  // advisor log may not record from it (see buildAdvisorEntry). Re-derived on every boot, never
  // persisted: it is a fact about THIS process's data, and a restart re-answers it from scratch.
  //
  // ★★ IT CAN NOW CHANGE MID-PROCESS, AND THIS NOTE USED TO SAY THE OPPOSITE. It read "it cannot go
  // stale within a process… `loadOne` runs ONLY inside init(), so a key is classified once and the
  // backfill behind it is never re-fetched", and "a restart is what clears it". All of that was
  // true until `retryRequiredSynthetic` (declared below) began calling `loadOne` from `tick()` to
  // re-fetch a required source that booted on stand-in data. A key can therefore be RE-CLASSIFIED
  // and its backfill REPLACED while the process runs.
  // ★ That is not a footnote: a serious defect came from reasoning on the old wording — code that
  // assumed a heal could never happen mid-tick let it record an advisor entry over a half-loaded
  // universe. If you are about to rely on "this cannot change", it can.
  // ★ BUT A LATER tick() DOES APPEND REAL BARS ON TOP OF A SYNTHETIC BACKFILL — so once the network
  // recovers, the series becomes fabricated history with a REAL edge, and the flag deliberately
  // keeps refusing. That is not staleness, it is the point: the advisor scores every recorded day
  // against NIFTY closes read back through `closeAtOrBefore`, and `possibleDays` counts NIFTY bars,
  // so invented HISTORY corrupts the comparison and the coverage metric even when today's bar is
  // real. A restart is what clears it, and on an ephemeral host that happens often.
  //
  // ★ IT CANNOT GO STALE WITHIN A PROCESS, and it is worth saying why rather than leaving it to be
  // rediscovered. `loadOne` is the only caller of loadCandles and runs ONLY inside init(), so a key
  // is classified once and the backfill behind it is never re-fetched.
  // ★ BUT A LATER tick() DOES APPEND REAL BARS ON TOP OF A SYNTHETIC BACKFILL — so once the network
  // recovers, the series becomes fabricated history with a REAL edge, and the flag deliberately
  // keeps refusing. That is not staleness, it is the point: the champion was SELECTED, and its
  // target book PRODUCED, by a backtest over invented history, so a real newest bar does not make
  // the resulting suggestion real. A restart is what clears it, and on an ephemeral host that
  // happens often.
  // ★ Note what the refusal does NOT fix: the published `track` and `coverage` are recomputed from
  // the live series on every payload, so a synthetic NIFTY makes those numbers fiction whether or
  // not anything is recorded. That is handled by DISCLOSURE on the panel, not by this flag.
  const syntheticKeys = new Set();
  // The advisor knows SYMBOLS, not keys, and "is this name's price invented" is answered by ANY
  // interval being a stand-in. ★ Asked by parsing the keys rather than by enumerating intervals:
  // an enumeration of '1d' and '60m' silently stops covering a roster entry on any other interval
  // (`isIntradayInterval` is simply `interval !== '1d'`, so '30m' is legal), and it would drift
  // without failing. This cannot.
  const isSyntheticSymbol = (symbol) => {
    if (!symbol) return false;
    for (const key of syntheticKeys) if (parseKey(key).symbol === symbol) return true;
    return false;
  };
  // ★ THE RECOVERY FOR A REQUIRED KEY THAT CAME UP SYNTHETIC. Refusing to record from invented data
  // is right, but on its own it never heals: `syntheticKeys` is written only by `loadOne`, which
  // runs only inside `init()`, and `tick()` never re-fetches a backfill. So ONE transient feed
  // failure at boot — on a host deliberately kept awake for weeks, with an ephemeral disk that
  // forces a live fetch on every redeploy — silenced the advisor for the life of the process, and
  // every missed day is lost permanently because none is ever back-filled.
  //
  // `init()` fills this in (it is the only scope where `loadOne` and the source list exist) and
  // `tick()` calls it. Null before the first init, so a caller must tolerate that.
  // ★ It is a NO-OP, with no network call at all, unless a REQUIRED key is currently synthetic —
  // which is the state this exists for and is otherwise never true. That property is what keeps
  // this off the boot data path in normal operation.
  let retryRequiredSynthetic = null;
  // When that retry last ran, so a broken feed is re-probed on a sane cadence rather than on every
  // 10-minute tick. Hourly: the failure state records NOTHING while it lasts, so a day of latency
  // would itself cost the artifact this is protecting, while the probe is at most three fetches and
  // only happens while genuinely broken.
  let lastSyntheticRetryMs = 0;
  const SYNTHETIC_RETRY_MS = 3600000;
  // ★★ TRUE WHILE THE BASKET POOL IS STILL LOADING IN THE BACKGROUND, and the probe MUST NOT run
  // then. This is not caution, it is a bug that was caught in review: `server.js` ticks immediately
  // after `init()` returns, and on a cold boot `init()` returns at the 45s deadline with ~105 pool
  // names still in flight. A probe that HEALED there would set `changed`, which drives
  // `advisorTick()` — recording the champion's target book computed over a PARTIALLY LOADED
  // universe. `init()` refuses to record in exactly that state for exactly that reason, deferring
  // to the pool-completion continuation; and because `appendAdvisorEntry` rejects any entry dated
  // at-or-before the last one, the thin entry would WIN and the corrected one would be refused —
  // permanently, in the append-only real-money log.
  // ★ Waiting also puts the probe somewhere it can plausibly succeed: at boot it would fire seconds
  // after the fetch that failed (usually rate-limiting), burning the attempt and adding a
  // full-range re-fetch on top of the still-running pool load, which is the cold-boot data path that
  // has taken this host down before. Once the pool has finished, the feed is demonstrably answering again.
  let poolLoading = false;
  let roster = seed.map((b) => asRosterEntry(b)); // mutable bot definitions
  let bots = []; // compiled view of the roster
  // advisorLog: the ADVISOR's append-only "Today's Suggestions" record (advisor.mjs) —
  // one entry per data date, written BEFORE outcomes are knowable. Part of the FORWARD
  // record, so it persists (and restores) alongside the live closes.
  let state = { deployedAt: null, live: {}, roster: null, generation: 0, history: [], advisorLog: [] };
  // What the REMOTE store did on this boot, so a non-restore is DIAGNOSABLE from outside.
  // Without this, a reset forward clock looks identical whether (a) the read failed and the
  // fail-closed guard correctly refused to overwrite (nothing lost — it comes back next
  // boot), or (b) the store is unconfigured, or (c) the store really is empty and this process
  // has just stamped a fresh clock over it. Those need completely different responses, and
  // there was no way to tell them apart from the deployed site.
  let persistState = { enabled: !!persistStore.enabled, attempted: false, restored: false, readFailed: false, writeFailed: false };
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
    // Persist to LOCAL disk (persist) AND/OR a REMOTE store (persistStore). The remote
    // store is what survives an ephemeral-disk redeploy — see persistStore.mjs. Both are
    // best-effort; a failed save just means that bar isn't durably stored yet. When
    // NEITHER is configured this is the same early-return no-op as before (so every
    // existing persist:false path stays byte-identical).
    if (!persist && !persistStore.enabled) return;
    state.roster = roster;
    if (persist) {
      try {
        mkdirSync(dirname(stateFile), { recursive: true });
        writeFileSync(stateFile, JSON.stringify(state, null, 2));
      } catch {
        /* local persistence is best-effort */
      }
    }
    persistStore.save(state); // fire-and-forget remote mirror (no-op if not configured)
  }

  function load() {
    if (!persist) return;
    try {
      if (existsSync(stateFile)) {
        const s = JSON.parse(readFileSync(stateFile, 'utf8'));
        if (s && typeof s === 'object') {
          // The advisor log is sanitised on the LOCAL path too (not just the remote restore):
          // scoreAdvisorLog runs inside every standings assembly, so one corrupt entry in a
          // hand-edited/damaged state file would otherwise throw there and 503 the whole
          // board until the file is deleted.
          state = { deployedAt: s.deployedAt || null, live: s.live || {}, roster: s.roster || null, generation: s.generation || 0, history: Array.isArray(s.history) ? s.history : [], advisorLog: sanitizeAdvisorLog(s.advisorLog), advisorLogArchive: sanitizeAdvisorLog(s.advisorLogArchive) };
          if (Array.isArray(s.roster) && s.roster.length) {
            // IDENTITY FLAGS COME FROM THE SEED, NOT FROM THE SAVED FILE. A restored entry carries
            // only the keys that existed when it was written, so any field added to seed.mjs later
            // silently reads as false — and `protected` and `benchmark` are not state, they are
            // statements about what a row IS. `benchmark` shipped the same day the advisor learned
            // to refuse the fair-bar control; without this, a state file written the morning before
            // would restore that control WITHOUT the flag and hand the advisor ~105 names to
            // suggest as real-money orders, which is the exact hole that change closed.
            // Latent in production (the host's disk is ephemeral, and the remote restore sets
            // `roster: null` by design), reachable on any box with a persistent data/ dir.
            // Only these two are re-applied: everything else about a restored bot — its spec, its
            // generation, whether a user removed it — is legitimately the saved file's business.
            const seedIdentity = new Map(seed.map((b) => [b.id, { prot: !!b.protected, bench: !!b.benchmark }]));
            roster = s.roster.map((b) => {
              const id = seedIdentity.get(b.id);
              return asRosterEntry(id ? { ...b, protected: id.prot, benchmark: id.bench } : b, b.gen || 0);
            });
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

  // First bar of the market proxy every basket gates on. Null when NIFTY has not loaded (a cold
  // boot), in which case the post-proxy score is simply not reported — never guessed at.
  const proxyStartT = () => {
    const s = seriesFor('NIFTY');
    return Array.isArray(s) && s.length ? s[0].t : null;
  };


  // Run one bot's backtest over [backfill+live]. `recordTrades` (used by
  // getBotDetail) makes the backtester also return a full per-trade log.
  function runBot(bot, candles, recordTrades = false, alignCache = null) {
    const interval = bot.interval || '1d';
    const intraday = isIntradayInterval(interval); // annualise the Sharpe by the bars' own frequency
    // The COST schedule follows the HOLDING PERIOD, not the bar interval. The intraday (MIS)
    // schedule — no delivery STT, lighter stamp, no borrow — is only honest for a strategy that
    // is flat by the close. A 60m BAR says nothing about that: the shipped hourly breakout holds
    // 88 of its 94 round trips OVERNIGHT (longest 19 days), which in the real market is a CNC
    // delivery trade. Charging it MIS understated its lifetime loss by ~15pp on the live board.
    // So DELIVERY is the default for every EQ/basket bot, and a strategy must opt IN by
    // declaring `squareOffDaily` — the conservative direction, and this board's whole premise
    // is that no bot ever trades for a made-up cost.
    // DISCLOSURE: this swaps the whole model, so it also changes an ASSUMPTION, not just the
    // statutory taxes — equityDeliveryCosts defaults to 5bps slippage where equityIntradayCosts
    // defaults to 3bps. Of the ~15pp lifetime move this produced on the 60m bot, ~12.8pp is the
    // statutory correction (delivery STT both sides, heavier stamp) and ~2.4pp is that slippage
    // assumption. Slippage is not a function of holding period, so if that ever needs separating,
    // pass equityDeliveryCosts({ slippageBps: 3 }) here and say so.
    const eqCostModel = intraday && bot.squareOffDaily ? EQ_COSTS_INTRADAY : EQ_COSTS;
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
      return runPortfolioBacktest({ spec, dataBySymbol: dbs, marketSeries: seriesFor('NIFTY'), cash: CASH, costModel: eqCostModel, rankSource, recordTrades, intraday, alignCache });
    }
    if (bot.kind === 'PAIRS') {
      // A PAIRS bot also spans many stocks (long/short pairs) — gather each
      // constituent's [backfill+live] series and run the stat-arb backtester. No
      // market-gate proxy (it's market-neutral by construction) and no ML.
      const spec = bot.spec;
      const dbs = {};
      for (const s of spec.universe) dbs[s] = seriesFor(s, interval);
      return runPairsBacktest({ spec, dataBySymbol: dbs, cash: CASH, costModel: EQ_COSTS, recordTrades, intraday });
    }
    if (bot.kind === 'FNO') {
      const spec = INDEX_SPECS[bot.symbol] || INDEX_SPECS.NIFTY;
      return runFnoBacktest({ strategy: bot.strategy, candles, symbol: bot.symbol, cash: CASH, ...spec, keepOpen: true, recordTrades, costModel: OPT_COSTS });
    }
    return runBacktest({ strategy: bot.strategy, candles, symbol: bot.symbol, cash: CASH, costModel: eqCostModel, recordTrades, intraday, spec: bot.spec });
  }

  // The deploy-boundary TIMESTAMP for a bot (the last backfill bar at-or-before
  // deployment) — trades after it are LIVE/forward, before it are the track record.
  // Mirrors the deployIdx logic in computeStandings but yields a timestamp.
  // EVERY data key a bot's run reads. ONE definition, because two consumers need the same
  // answer: the deploy-boundary calculation below, and the check for whether any series this bot
  // depends on is a fabricated stand-in. A basket's market-gate proxy (NIFTY) is always DAILY;
  // its constituents follow the bot's interval. An EQ/FNO bot is its single symbol.
  // ★ For a BASKET this is the RANKING POOL, not today's holdings — which is the whole point: a
  // basket ranks its entire universe at every rebalance, so a fabricated series in that pool
  // steers the selection whether or not the bot ends up holding that name.
  function botDataKeys(bot) {
    const interval = bot.interval || '1d';
    return spansUniverse(bot.kind)
      ? [...(bot.spec && bot.spec.universe ? bot.spec.universe : []).map((s) => dataKey(s, interval)), dataKey('NIFTY', '1d')]
      : [dataKey(bot.symbol, interval)];
  }

  // The SYMBOLS among those whose series is the offline synthetic fallback (empty in normal
  // operation). Published on the bot detail so the advisor can refuse to record from a run whose
  // inputs were invented — it has no access to `syntheticKeys` itself.
  const syntheticInputsFor = (bot) => [...new Set(botDataKeys(bot).filter((k) => syntheticKeys.has(k)).map((k) => parseKey(k).symbol))];

  function deployCutoffFor(bot) {
    const keys = botDataKeys(bot);
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
    //
    // ★ DATA-STARVED bots are NOT followable (the cold-boot liquidation guard):
    // on a Render cold boot the board publishes while the broad basket pool is still
    // loading in the background, and a bot whose market data hasn't arrived (or whose
    // fetch failed) backtests over NOTHING — an empty book at starting cash that is
    // byte-identical to "genuinely sitting in cash". Copying that would LIQUIDATE the
    // entire account into cash (and churn it all back once the data lands, or strand
    // it flat if the tab is closed first). Flag it so the client SKIPS the tick and
    // holds the account's positions until the data is actually loaded.
    const hasData = spansUniverse(bot.kind)
      ? (bot.spec.universe || []).some((s) => seriesFor(s, bot.interval || '1d').length > 0)
      : Array.isArray(series) && series.length > 0;
    const mirror = {
      followable: hasData,
      equity: finalEquity,
      positions: (res.finalPositions || []).map((p) => ({ ...p, side: p.qty >= 0 ? 'BUY' : 'SELL' })),
      // WHEN this book was marked. A basket runs on the UNION of its constituents' timestamps
      // (alignSeries), which is NOT the same clock as NIFTY — and the advisor stamps its
      // append-only entries from NIFTY's edge. If any universe name publishes a daily close
      // before NIFTY does (the feed's per-symbol publication lag is variable and measured),
      // this runs AHEAD of that stamp, and an entry dated D would carry marks — and a rebalance
      // decision — from D+1. That is look-ahead in the one record whose entire purpose is to have
      // none. Publishing the timestamp lets the advisor refuse such a day instead of recording it.
      asOf: (spansUniverse(bot.kind) ? (res.times || []) : (series || []).map((c) => c.t)).slice(-1)[0] ?? null,
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
      // Is this row the fair-bar CONTROL rather than a strategy? The advisor reads this to stand
      // aside rather than turn a yardstick into real-money guidance (see advisor.mjs).
      benchmark: !!bot.benchmark,
      // ★ A ROW FACT, published for the same reason `benchmark` is: the advisor must
      // be able to ask what a bot IS, not only what it happens to hold today. An EQ bot carrying
      // `side: 'short'` can ONLY ever go short — that is the one direction it trades — and
      // cash-market delivery cannot hold a short, so it is never followable. Checking today's
      // positions alone misses it whenever the bot sits FLAT, which for a trend bot is most of
      // the time. `detail` carries no `spec`, so the fact has to travel separately.
      // ★ Deliberately NOT inside `metrics`: that object is about how the bot PERFORMED, and a
      // never-traded bot is given a neutral one that would carry no such field at all.
      shortOnly: !!(bot.spec && bot.spec.side === 'short'),
      // ★ Which of this bot's INPUT series are fabricated stand-ins (see W28). Normally empty.
      // For a BASKET this covers the whole RANKING POOL, which `detail.symbol` cannot: that field
      // is a label like '10 ETFs', so the identity check has nothing to test, and a scan of
      // today's holdings misses a pool name the bot ranked against and then did not buy.
      syntheticInputs: syntheticInputsFor(bot),
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
        // sharpeCashAdj/flatBarsPct ride along for the same reason the leaderboard row carries
        // them (see buildRow): a gated bot is charged the hurdle on every bar it stands aside,
        // and the per-bot page is where there is actually room to show the gap honestly.
        ? { totalReturnPct: res.metrics.totalReturnPct, sharpe: res.metrics.sharpe, sharpeCashAdj: res.metrics.sharpeCashAdj, flatBarsPct: res.metrics.flatBarsPct,
            // Same helper the leaderboard row uses, so the two surfaces cannot quote different
            // post-proxy figures for one bot.
            ...postProxyScore(eqd, ctimes, isIntradayInterval(bot.interval) ? null : proxyStartT()),
            gated: !!(bot.spec && bot.spec.marketGate !== undefined),
            maxDrawdownPct: res.metrics.maxDrawdownPct, trades: res.metrics.trades, risk: isIntradayInterval(bot.interval) ? null : riskProfile(res.equityCurve) }
        : { totalReturnPct: 0, sharpe: 0, sharpeCashAdj: 0, flatBarsPct: 0, maxDrawdownPct: 0, trades: 0, risk: null }, // never-traded: neutral, matching the leaderboard row
      // Cost/liquidity honesty for the per-bot page: which cost schedule the run paid
      // (+ non-trade fees like SLB borrow / F&O brokerage), and how many fills exceeded
      // the volume-participation cap (a too-big-to-execute warning, not an impact model).
      costs: res.costs || null,
      liquidity: res.liquidity || null,
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
          risk: null, // no curve, no tail — never a made-up VaR
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
      const { sharpePostProxy, preProxyBars } = postProxyScore(eq, times, intraday ? null : proxyStartT());
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
        // Is this row the fair-bar CONTROL? The leaderboard needs it to say so out loud: the row
        // otherwise looks exactly like a strategy, sits in a ranked position like a strategy, and
        // a reader sorting by Sharpe has no way to know it is the yardstick the others are being
        // measured AGAINST. Its name does some of that work; a marker does it reliably.
        // NOTE the protected Buy & Hold is deliberately NOT flagged, even though it is also a
        // reference line: `benchmark` means "the no-information control over ~105 names", and
        // Buy & Hold is a different thing — one instrument, held. ★ It is NOT "one ETF": its
        // symbol is NIFTY, the INDEX, which cannot be bought in the cash market. The advisor
        // handles that on its own terms (an index held as a share is a stand-aside reason there),
        // so folding it under this flag would conflate two different facts about two rows.
        benchmark: !!bot.benchmark,
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
        // The SAME Sharpe re-scored as if idle cash had earned the very rate the headline
        // already charges it (`summarize` computes both; the board used to drop this one).
        // It exists because the board's central comparison is now UNFAIR IN A MEASURABLE WAY:
        // `bar-universe-equal` — the fair bar every basket is read against — is UNGATED and sits
        // in cash ~1.4% of its life, while a gated basket sits in cash 22-34% and is charged the
        // 6.5% hurdle for every one of those bars without earning anything on them. So the gated
        // bots read 0.056-0.090 LOW against a control that reads 0.005 low. (An earlier version of
        // this comment claimed that gap decides whether the best strategy clears the bar at 3 of 6
        // window starts. It does not — that came from a sweep that sliced by index and so gave
        // every symbol a different start date; windowed by date the answer is 0 of 6. The per-bot
        // gap below is a within-run difference and stands.) Publishing the number
        // is deliberately NOT the same as adopting it: `sharpe` remains the headline and no
        // published figure moves. Whether to switch convention outright stays an open decision.
        // ESTIMATE, not a measurement — a cash bar is inferred from equity being EXACTLY
        // unchanged, which a single-name bot can hit on a genuinely quiet day (a basket of ten
        // essentially cannot). `flatBarsPct` is published beside it so the size of that
        // assumption is visible rather than buried.
        sharpeCashAdj: res.metrics.sharpeCashAdj,
        flatBarsPct: res.metrics.flatBarsPct,
        // The same run scored only from the bar the gate proxy starts (see above). null when the
        // bot has no pre-proxy stretch at all.
        sharpePostProxy,
        preProxyBars,
        // Does this bot READ the market proxy? It decides what the pre-proxy stretch MEANS, and
        // the two meanings are opposites. A GATED basket cannot evaluate its gate there, so it
        // holds nothing and is charged the hurdle for every bar — a systematic penalty, and
        // removing it is a fairer read of that bot. An UNGATED one trades through the stretch
        // normally (the fair bar takes 774 trades in it), so removing those bars is not a
        // correction at all, just a shorter window. MEASURED on the deployed board: the five
        // gated bots move +0.03..+0.04, tightly; the ungated ones scatter -0.05..+0.04 with no
        // sign. Without this flag the per-bot page would tell an ungated bot's reader it "holds
        // nothing" through a stretch it actually traded.
        gated: !!(bot.spec && bot.spec.marketGate !== undefined),
        maxDrawdownPct: res.metrics.maxDrawdownPct,
        // Risk block: one-day 99% VaR / ES by historical simulation on the trailing 500
        // daily returns (Hull's window), the √10 ten-day figure, and a ROLLING BACK-TEST of that
        // same VaR over the last 250 days where each day's VaR is built only from returns BEFORE
        // it — so it is a forward test of the bot's own risk claim, never a fit. Null on a curve
        // too short to hold a 1% tail (a made-up zone would be worse than none). See risk.mjs.
        // NULL for an INTRADAY bot: its curve is hourly, so "one-day VaR", "last 500 trading
        // days" and a "250-day back-test" would all be mislabelled by ~√7 —
        // the same exclusion apCurves already applies to the Auto-Pilot.
        risk: isIntradayInterval(bot.interval) ? null : riskProfile(eq),
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
      // Forward DAYS, not bars. This is a MAX over every source's appended-bar count, and the
      // UI renders it verbatim as "N forward day(s)" — the headline that says how
      // much genuine no-hindsight evidence exists. An intraday ('60m:SYMBOL') source appends up
      // to 7 bars per session, and being a MAX it dominates the moment tickIntraday starts, so
      // the figure was inflated ~7x. Count DISTINCT IST dates instead, which is the same number
      // as before for daily sources and the honest one for intraday.
      const liveBars = Math.max(0, ...rosterSources().map(({ key }) => new Set((state.live[key] || []).map((b) => istDate(b.t))).size));
      // atCap tells the POLLED board (not just the per-click POST) that grow-mode
      // evolution has paused because the roster is full — so the live UI can say so.
      const atCap = !retireWeakest && roster.length >= maxRosterBots;
      // The honest "Auto-Pilot vs the market" walk-forward (null until there's ≥1y of history).
      // NIFTYBEES (loaded via the ETF bots' sources) is the dividend-adjusted market proxy for
      // the benchTri head-to-head; seriesFor returns [] when it isn't loaded — gracefully null.
      const autopilot = computeAutopilotTrack(apCurves, CASH, seriesFor('NIFTYBEES'));
      // The ADVISOR payload ("Today's Suggestions") — a pure, cheap read of the append-only
      // suggestion log + the cost rates + the fair-benchmark finding. Appending to the log
      // itself happens ONLY in advisorTick() (once per new data date), never here: assembly
      // must stay read-only so the sync/yielding recomputes and control ops can share it.
      const advisor = buildAdvisorPayload({ log: state.advisorLog, seriesFor, universe: BASKET_UNIVERSE, minDays: advisorMinDays, costRates: EQ_COSTS, standIn: standInFor(autopilot) });
      if (typeof persistStore.readFailed === 'function') persistState.readFailed = persistStore.readFailed();
      // a store that reads fine but cannot be WRITTEN was previously invisible from
      // outside — the board looked healthy while the forward record silently stopped growing.
      if (typeof persistStore.writeFailed === 'function') persistState.writeFailed = persistStore.writeFailed();
      standings = { deployedAt: state.deployedAt, generation: state.generation, liveBars, persist: { ...persistState }, syntheticKeys: [...syntheticKeys].sort(), asOf: Date.now(), startingCash: CASH, atCap, maxBots: maxRosterBots, botCount: rows.length, evolutionEnabled, autopilot, advisor, history: state.history.slice(-30), bots: rows };
      return standings;
    }

    // Record TODAY's suggestion into the append-only advisor log — called once per new
    // data date (after a standings recompute, so the walk-forward champion + the champion's
    // mirror reflect the fresh bar). The entry is written BEFORE its outcome is knowable —
    // that ordering is the whole point of the log (a no-hindsight forward record). Returns
    // true when an entry was appended (the caller save()s so the entry is durable, incl.
    // through the remote store). Skipped while nothing can honestly be issued (no champion
    // yet / champion's data still loading) — a missing day means "no suggestion was made",
    // never a back-filled one.
    // The stand-in verdict for the CURRENT champion, from the SAME function that refuses to
    // record — so the panel can never claim a day was refused when it was not, or stay silent
    // when it was.
    //
    // ★★ BUILT FROM THE ROSTER, NEVER FROM getBotDetail. The first version called
    // `getBotDetail(champ.id)` and its comment claimed that was cheap because the detail was
    // already built. It is not: `detailCache.clear()` runs at the head of BOTH recompute paths,
    // so this call was always a MISS and always ran a full trade-recording backtest of the
    // champion — MEASURED at 0.4-2.0s for a basket bot, synchronously, inside `assembleStandings`,
    // which is the ONE step `computeStandingsYielding` never yields in. That yielding path exists
    // precisely so a recompute cannot freeze the event loop (that once took the deployed site down
    // that way), and this quietly put a multi-second block back into it on every daily tick, every
    // intraday tick and every control op.
    //
    // Everything the verdict needs is already to hand without re-running anything: the roster bot
    // gives its declared inputs and its symbol, and the walk-forward already publishes the
    // champion's HOLDINGS on `currentBot`. So this is genuinely a Set read now.
    const standInFor = (autopilot) => {
      const champ = autopilot && autopilot.currentBot;
      if (!champ) return null;
      const bot = bots.find((b) => b.id === champ.id);
      if (!bot) return null;
      return syntheticDataBlock({
        detail: {
          symbol: bot.symbol,
          syntheticInputs: syntheticInputsFor(bot),
          // `holdings` carries the names the champion actually holds. qty is not published there
          // and is not needed — a listed holding is held by definition — so a nominal 1 satisfies
          // the `qty !== 0` filter without pretending to a size this does not know.
          mirror: { positions: (champ.holdings || []).map((h) => ({ symbol: h.symbol, qty: 1 })) },
        },
        isSynthetic: isSyntheticSymbol,
      });
    };
    function advisorTick() {
      if (!standings || !standings.autopilot) return false;
      const entry = buildAdvisorEntry({ autopilot: standings.autopilot, getBotDetail, seriesFor, isSynthetic: isSyntheticSymbol });
      if (!appendAdvisorEntry(state, entry)) return false;
      // Refresh the already-published payload so the new entry is visible without waiting
      // for the next full recompute (standings itself is otherwise untouched).
      standings.advisor = buildAdvisorPayload({ log: state.advisorLog, seriesFor, universe: BASKET_UNIVERSE, minDays: advisorMinDays, costRates: EQ_COSTS, standIn: standInFor(standings.autopilot) });
      return true;
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
    // If LOCAL disk had no state (a fresh dyno after an ephemeral-disk redeploy) and a
    // REMOTE store is configured, restore the forward record from it: the live closes,
    // the generation/history, and — crucially — the ORIGINAL deploy date, so the forward
    // clock stays CONTINUOUS across deploys instead of resetting to 0 every ship. Guarded
    // on !state.deployedAt, so a warm restart that still HAS its local file keeps that
    // local state and never round-trips the network. No-op (and no await) when unconfigured.
    if (persistStore.enabled && !state.deployedAt) {
      persistState.attempted = true;
      try {
        const remote = await persistStore.load();
        if (remote && typeof remote === 'object' && remote.deployedAt) {
          // Restore ONLY the forward record: the live closes (sanitised), generation/history,
          // and the ORIGINAL deploy date so the forward clock stays continuous. Deliberately
          // do NOT restore the ROSTER. The roster is the CURRENT curated seed (or, with breeding
          // on, the local-disk-persisted line-up), and adopting a roster written by a PRIOR
          // deploy would silently revert every seed.mjs edit — a culled bot would resurrect, a
          // relabel would be ignored — defeating the project's SOLE board-change mechanism.
          // (Evolved bots already don't persist across an ephemeral-disk redeploy — a separate
          // deferred concern — so keeping the current seed here is strictly correct.)
          state = {
            deployedAt: remote.deployedAt,
            live: sanitizeLiveMap(remote.live),
            roster: null, // save() below stamps the CURRENT roster; never the remote one
            generation: remote.generation || 0,
            history: Array.isArray(remote.history) ? remote.history : [],
            // The advisor's suggestion log is FORWARD RECORD too — the one artifact that
            // must never be lost — so it restores with the live closes. Same trust model
            // as the live map: the Gist is hand-editable, so sanitise it (well-formed
            // entries, strictly ascending dates) before believing it.
            advisorLog: sanitizeAdvisorLog(remote.advisorLog),
            // The pre-reset archive (see reset()) rides along so a suggestion log wiped by
            // a stray reset stays recoverable across a redeploy, not just in this process.
            advisorLogArchive: sanitizeAdvisorLog(remote.advisorLogArchive),
          };
          persistState.restored = true;
          save(); // mirror the restored forward state (with the CURRENT roster) to local disk
        }
      } catch {
        /* best-effort — fall through to a fresh forward clock */
      }
    }
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
          // Injected data (tests) is a plain candle ARRAY and is never synthetic — unchanged.
          // It may ALSO be `{ candles, synthetic }`, which exists so a test can drive the real
          // loadOne -> syntheticKeys -> advisorTick path without a network failure to trigger it.
          const inj = backfillData[key];
          if (Array.isArray(inj)) {
            candles = inj;
          } else {
            candles = inj.candles;
            synthetic = inj.synthetic === true;
          }
        } else {
          const loaded = await loadCandles(symbol, { interval, range: rangeFor(interval) });
          // DROP a still-forming trailing bar. Yahoo emits a candle for the in-progress
          // hour/session whose "close" is just the current price, and BOTH tick paths are
          // cursor-based (`bar.t > cursor`) — so the completed bar, carrying the SAME
          // timestamp, could never replace it: a boot during market hours froze a partial
          // mid-session price as that day's close for the whole life of the process, feeding
          // every bot's signals and (worse) the append-only advisor entry recorded right after
          // boot. Both ticks already guard this (`istDate(c.t) < today` / `c.t + period <= now`);
          // the boot path did not. Dropping it here is self-healing — the completed bar simply
          // arrives through the next tick.
          candles = dropFormingBar(loaded.candles, interval);
          synthetic = /synthetic/.test(loaded.source || '');
        }
        // Drop a pure basket-pool name with no REAL data (synthetic) — don't pollute baskets. Also
        // CLEAR any stale persisted live bars for it, so a name that was real on a prior boot can't
        // resurrect (backfill-less) through state.live after it later goes synthetic.
        if (synthetic && !requiredKeys.has(key)) { dropped++; delete state.live[key]; return; }
        // A required key KEEPS its synthetic series (the board still comes up) — but record that it
        // is invented, so the append-only advisor log can refuse to stamp a real-money suggestion
        // from a fabricated bar. Tracking it here, at the one place provenance is known, is the
        // whole point: no downstream rule about a bar's SHAPE can tell invented data from real.
        if (synthetic) syntheticKeys.add(key); else syntheticKeys.delete(key);
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
    // Expose the recovery declared at the top of the closure. It reuses `loadOne` rather than
    // re-implementing it, so a retry gets the SAME hygiene as the boot — the forming-bar drop, the
    // synthetic classification, the never-abort-the-boot catch — and the two can never drift.
    // ★ Only REQUIRED keys are retried. A pool name that came back synthetic was DROPPED (not
    // tracked), which is the correct outcome for it and nothing here should resurrect it.
    // ★ HONEST NOTE ON THAT LINE: filtering `requiredSrc` rather than all `sources` is stated
    // intent, not a working guard — `loadOne` drops a non-required synthetic key BEFORE it can
    // reach `syntheticKeys`, so the set can only ever hold required keys and the two expressions
    // are equivalent today. A mutation swapping them is therefore NOT caught by any test, and that
    // is recorded rather than papered over: it is unobservable, not untested-by-oversight. It stays
    // as written because it says what this may touch, and it stays correct if that drop ever moves.
    retryRequiredSynthetic = async () => {
      const stale = requiredSrc.filter((s) => syntheticKeys.has(s.key));
      if (!stale.length) return false; // the normal case: no network, no work
      console.log(`tournament: re-attempting ${stale.length} required source(s) that loaded as stand-in data.`);
      for (const src of stale) await loadOne(src);
      const healed = stale.filter((s) => !syntheticKeys.has(s.key));
      // A successful retry REPLACES a fabricated backfill with the real history. Any live bars
      // appended on top are genuine closes and survive: `seriesFor` merges by timestamp.
      if (healed.length) console.log(`tournament: recovered real data for ${healed.map((s) => s.key).join(', ')}.`);
      return healed.length > 0;
    };
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
    // Record today's advisor suggestion — but ONLY off a COMPLETE universe. When the boot
    // deadline fired the pool is still loading, so the champion's mirror could reflect a
    // thin, partially-loaded universe; recording THAT would put a wrong target book in the
    // append-only log forever. So: full-pool boots (local, tests) record here; deadline
    // boots record in the pool-completion continuation below, after the corrective
    // recompute over the complete universe.
    if (!deadlineFired && advisorTick()) save();
    // If the deadline fired (pool still loading at that point), recompute once the pool FINISHES
    // so the baskets fill in over the COMPLETE universe. Gated on the pre-recompute `deadlineFired`
    // snapshot, NOT a re-read of poolDone, so the race above can't skip it. Idempotent: if the pool
    // already finished during the recompute above, .then fires immediately and recomputes over the
    // now-full universe (one extra cheap pass over a consistent snapshot).
    // The probe in tick() is gated on this: while it is true the universe is incomplete, so a heal
    // must not be allowed to drive advisorTick(). Cleared in the continuation below (in a finally,
    // so a failed recompute cannot strand the probe off forever).
    poolLoading = deadlineFired;
    if (deadlineFired) {
      poolLoad
        .then(async () => {
          try { await computeStandingsYielding(); advisorTick(); save(); } catch { /* best-effort */ }
          finally { poolLoading = false; }
        })
        .catch(() => { poolLoading = false; });
    }
    return standings;
  }

  // `now` is injectable so tests never read the wall clock for SESSION logic: a daily bar
  // is done at 15:30 IST, not at midnight, so a fixture built around "today" means opposite
  // things before and after the close. Defaults to the real clock in production.
  async function tick({ now = Date.now() } = {}) {
    // A daily bar is COMPLETE once its own session has closed (15:30 IST) — the same rule
    // dropFormingBar already applies on the BOOT path. This used to be `istDate(c.t) < today`,
    // a wall-clock DATE compare, which threw away today's bar even hours after the close and
    // only admitted it once the IST date rolled over. That meant a long-running server could
    // advance the suggestion log ONLY in the window after MIDNIGHT IST — historically the
    // least likely time for a free dyno to be awake — so the advisor's capture rate was hurt
    // by this filter as well as by the sleeping host. Boot recorded same-day, tick did not:
    // two rules for one question. This is the boot rule, so both paths now agree.
    // ★ It must still NEVER admit a forming bar — that would write a PARTIAL close into the
    // append-only log, which is never edited afterwards — and it waits a SETTLE MARGIN past
    // the bell (16:00 IST), because the first close a free feed serves can be revised and the
    // log would make it permanent. ONE predicate, owned by data.mjs and shared with the boot
    // path, so the two rules cannot drift apart again (this was a third copy).
    const sessionClosed = (t) => dailySessionClosed(t, now);
    const seq0 = opSeq; // snapshot: if a control op mutates state during our await, bail
    let changed = false;
    // ★ HEAL A REQUIRED SOURCE THAT BOOTED ON STAND-IN DATA, before anything reads the series.
    // Without this the process stays poisoned for its whole life (see `retryRequiredSynthetic`),
    // and the advisor — which correctly refuses to record from invented data — records nothing at
    // all, permanently, because missed days are never back-filled.
    // A recovery is treated as `changed`: no NEW bar arrived, but the data underneath every bot
    // just went from fabricated to real, so the board must be recomputed and the day can be
    // recorded. Failures are swallowed on purpose — a probe must never stop the ordinary tick.
    if (retryRequiredSynthetic && !poolLoading && now - lastSyntheticRetryMs >= SYNTHETIC_RETRY_MS) {
      lastSyntheticRetryMs = now;
      try { if (await retryRequiredSynthetic()) changed = true; } catch { /* probe failed; try again next hour */ }
      if (opSeq !== seq0) return changed; // a control op landed during the probe
    }
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
        // ★ A ZERO-VOLUME BAR IS NOT A SESSION, AND THE FORWARD RECORD IS APPEND-ONLY.
        // On a day the exchange was shut the feed still emits a daily row. MEASURED across the
        // cached history: 2,774 such rows, and on four declared 2026 NSE holidays ~110 stocks each
        // carry one — previous close repeated verbatim, volume EXACTLY 0, while NIFTY correctly has
        // no bar at all. The row starts life with a null close (which freeProvider rightly skips)
        // and is later backfilled with the carry-forward, which is finite and positive and so
        // sails through every other condition here.
        //
        // Admitting one writes a FABRICATED trading day into a live series that is never edited
        // afterwards, and only for the stocks that carry it — so the board's own timeline gains a
        // day the index does not have, which is the grid defect this project already has a warning
        // about, arriving live instead of in history.
        //
        // Nothing has been contaminated yet: every measured phantom date precedes `deployedAt`.
        // The next live NSE holiday is 2026-10-02, which is why this is here now.
        //
        // ★ Scope is deliberately LIVE ADMISSION ONLY. It changes which bars enter the record from
        // here on and restates no published figure — unlike refusing to TRADE the historical ones,
        // which would move every number on the board and stays an open decision.
        // ★ The refusal is `isPhantomBar` (zero volume AND the previous close carried forward),
        // NOT zero volume alone — see its comment for the real index sessions that a volume-only
        // rule dropped. Sorted first so each bar is compared with the feed's own previous row.
        const series = seriesFor(symbol, interval);
        const fetched = (res.candles || [])
          .filter((c) => Number.isFinite(c.c) && c.c > 0)
          .sort((a, b) => a.t - b.t);
        const lastClose = series.length ? series[series.length - 1].c : NaN;
        const cs = fetched.filter((c, i) => !isPhantomBar(c, i > 0 ? fetched[i - 1].c : lastClose) && sessionClosed(c.t));
        // Append EVERY completed bar newer than our cursor, not just the single
        // newest one: if the host slept/froze across 2+ sessions (a free-tier dyno
        // does), taking only the last bar permanently DROPPED the intermediate
        // days from the live track — tickIntraday() already heals this way, the
        // daily tick now matches it. The '5d' fetch window bounds the catch-up.
        let cursor = series.length ? series[series.length - 1].t : 0;
        for (const bar of cs) {
          if (bar.t > cursor) {
            if (!state.live[key]) state.live[key] = [];
            state.live[key].push({ t: bar.t, c: bar.c });
            cursor = bar.t;
            changed = true;
          }
        }
      } catch {
        /* no new bar this tick */
      }
    }
    if (changed) {
      save();
      await computeStandingsYielding();
      // A new daily bar arrived — record today's suggestion off the fresh standings.
      // save() again only if an entry was actually appended (the log must be durable
      // the moment it exists — it is the artifact that must never be lost).
      //
      // ★★ BUT NOT WHILE THE BASKET POOL IS STILL LOADING, for the same reason `init()` will not:
      // the champion's target book would be computed over a PARTIAL universe, and because
      // `appendAdvisorEntry` refuses an entry dated at-or-before the last one, that thin book would
      // be permanent. This guard was ORIGINALLY MISSING HERE — it was added to the recovery probe
      // above, and asking "what else reaches advisorTick without it?" found this ordinary path had
      // the same hole. Reachable whenever the pool load outlasts a tick: the required keys (NIFTY
      // and each single-symbol bot) already have backfill, so the loop above still admits their
      // bars and sets `changed`, while the basket pool behind the champion is half-loaded.
      // ★ Only the RECORDING is deferred — the live bars above are still admitted and saved, which
      // is what keeps the forward record complete. The day is then recorded by the pool-completion
      // continuation, or by any later tick.
      if (!poolLoading && advisorTick()) save();
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
        // Same phantom-bar refusal as the daily path above (`isPhantomBar`: zero volume AND the
        // previous close carried forward — never volume alone, and never an absent volume). This
        // path is ALSO gated on getMarketState().isOpen, which does consult the holiday list — but
        // that list is hand-maintained one year at a time and fails OPEN when it lapses, so the
        // outer guard has a known expiry and this one does not. One rule, both admission paths.
        const series = seriesFor(symbol, interval);
        const fetched = (res.candles || [])
          .filter((c) => Number.isFinite(c.c) && c.c > 0)
          .sort((a, b) => a.t - b.t);
        const lastClose = series.length ? series[series.length - 1].c : NaN;
        const cs = fetched.filter((c, i) => !isPhantomBar(c, i > 0 ? fetched[i - 1].c : lastClose) && c.t + period <= now);
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
    if (!eqSymbols.length && !fnoSymbols.length) return { generation: state.generation, promoted: null, retired: null, reason: 'no symbols have enough loaded history to hunt on' };

    // THE QUALITY BAR MUST EXIST BEFORE IT IS WORTH BREEDING ANYTHING. This is the same roster
    // filter used further down to pick `weakest`, hoisted ABOVE the expensive work on purpose:
    // it is a pure predicate over the roster and needs no scoring at all, whereas leaving the
    // check where the bar is computed meant a barren roster paid for a full generation — 16 bred
    // challengers plus an incumbent re-backtest, ~8.7s locally and more on the free tier — and
    // then discarded every bit of it, once a day, forever. Sits next to the maxRosterBots
    // short-circuit above, which exists for exactly this reason.
    // This state only became reachable when benchmarks were excluded from the bar (before that
    // the fair bar itself always supplied one), so there is no behaviour here to preserve.
    if (!roster.some((b) => !b.protected && !b.benchmark && !isIntradayInterval(b.interval))) {
      return { generation: state.generation, promoted: null, retired: null, reason: 'no quality bar: every eligible bot is protected or a benchmark, so there is nothing for a challenger to beat' };
    }

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
    // `!b.benchmark` alongside `!b.protected`: the comment above says "the benchmark is a
    // yardstick, not breeding stock", but until now `protected` was the only thing enforcing it
    // and `protected` means exactly ONE row — the Buy & Hold the walk-forward uses as its bench
    // series. The fair bar (`bar-universe-equal`) is a yardstick too and is NOT protected, so it
    // was silently breeding stock: a mutated no-information control is not a control, and
    // "hold the whole universe, but tweaked" is not a hypothesis anyone meant to test.
    // Dormant today (breeding is OFF), which is precisely why it is fixed NOW — re-enabling
    // evolution is an open decision, and that is the moment nobody would think to check this.
    const breedable = compilable.filter((b) => !b.protected && !b.benchmark);
    // The fallback has to drop benchmarks TOO, or the exclusion above is decorative: with no
    // ordinary strategy left to breed from, `parents` used to fall back to every compilable bot
    // — controls included — and evolve() duly returned challengers descended from the control
    // (measured: 4 of 8, all named after it). Falling back to the PROTECTED row is the original
    // intent and is kept; falling back to a yardstick never was. If that leaves nothing, the
    // guard below returns cleanly with a reason.
    const parents = breedable.length ? breedable : compilable.filter((b) => !b.benchmark);
    if (!parents.length) return { generation: state.generation, promoted: null, retired: null, reason: 'no breedable parents: every eligible bot is a benchmark or fails to compile' };
    // Score evolution on a bounded recent window (see EVOLVE_WINDOW) so a generation
    // stays a few seconds, not ~30, on the free host. Symbol eligibility above still
    // uses the FULL fullData length; only the per-bot backtest series is trimmed.
    const recentData = {};
    // NOTE this slices by INDEX, the same class of bug that once corrupted a research sweep here
    // (different bar counts -> different start dates per symbol). Measured and left alone: it yields
    // 8 distinct start dates across 2022-02-24…2023-05-09 with 90 of 115 names on one date, NIFTY
    // starts earlier than all but one so no dead-proxy stretch opens, and the spread sits inside the
    // 300-bar warm-up that `scoreFromT` excludes from scoring. Breeding is OFF regardless. If
    // evolution is ever re-enabled, prefer windowing by timestamp here too.
    for (const sym of Object.keys(fullData)) recentData[sym] = fullData[sym].slice(-(EVOLVE_WINDOW + EVOLVE_WARMUP));
    // Where SCORING starts: the first bar of the last EVOLVE_WINDOW bars. Everything before it
    // is warm-up — traded through so indicators/gates/ML are live, but not judged. Anchored on
    // ONE reference series (NIFTY, else the longest loaded) so every challenger and the
    // incumbent share an identical boundary; scoring two arms over different spans would not
    // be a comparison. null when there is no history to spare, which is the old behaviour and
    // is what every short test fixture gets.
    const refSeries = fullData.NIFTY || Object.values(fullData).reduce((a, b) => ((b && b.length > (a ? a.length : 0)) ? b : a), null) || [];
    const scoreFromT = refSeries.length > EVOLVE_WINDOW ? refSeries[refSeries.length - EVOLVE_WINDOW].t : null;
    const challengers = evolve({ roster: parents, dataBySymbol: recentData, eqSymbols, fnoSymbols, basketSymbols, n: 16, seed: s, cash: CASH, scoreFromT });
    const keyOf = (sym, spec) => `${sym}|${specKey(spec)}`;
    const existing = new Set(roster.map((b) => keyOf(b.symbol, b.spec)));
    const best = challengers.find((ch) => !existing.has(keyOf(ch.symbol, ch.spec)));
    // TWO DIFFERENT STRUCTURAL CAUSES, and conflating them would repeat the very bug this was
    // meant to fix. `evolve()` ends with `.filter((ch) => ch.score)`, and `scoreSpec` returns null
    // whenever a mutated spec cannot be scored on the loaded data — a failed `safeCompile`, a
    // BASKET with fewer than 2 present names, a PAIRS with fewer than 4. So an empty
    // `challengers` means NOTHING WAS SCORABLE, which is a data/pool problem, while a non-empty
    // list with no `best` means every candidate was a structural DUPLICATE of a bot already on
    // the board, which is what a mature grow-mode roster genuinely runs into. Reporting the
    // second when the first happened would send someone hunting for duplicates that do not exist.
    if (!challengers.length) return { generation: state.generation, promoted: null, retired: null, reason: 'no bred challenger could be scored on the loaded data (too few present names for its kind, or a spec that failed to compile)' };
    if (!best) return { generation: state.generation, promoted: null, retired: null, reason: 'every bred challenger duplicates a bot already on the board' };

    // Weakest current bot — the quality bar a challenger must clear to enter the
    // board (so it grows with credible strategies, not noise). protected bots are
    // never the target. EQ/FNO are scored on their own symbol; a BASKET is scored
    // across its whole universe via the portfolio backtester (using fullData) —
    // otherwise fullData[label] is undefined and a basket could never be scored.
    // The incumbent is scored through the SAME warm-up boundary as the challengers — scoring
    // the bar a challenger must clear differently from the challenger itself is how a biased
    // scorer corrupts the retire/replace decision even when both arms use one code path.
    const scoreBot = (b) => spansUniverse(b.kind)
      ? scoreSpec(b.spec, null, b.symbol, CASH, recentData, scoreFromT)
      : (recentData[b.symbol] ? scoreSpec(b.spec, recentData[b.symbol], b.symbol, CASH, null, scoreFromT) : null);
    // Benchmarks are excluded here for TWO distinct reasons, both worth stating because this one
    // array feeds two different decisions:
    //   * as a CULL TARGET (retireWeakest mode, `roster[idx] = newBot` below) — the fair bar is
    //     not protected, so a bad ~3-year scoring window could have retired the board's own
    //     yardstick and nothing would have said so. Losing the row that makes every other
    //     comparison honest is the single worst thing this function could do.
    //   * as the QUALITY BAR a challenger must clear — the bar is meant to be "beat the weakest
    //     STRATEGY we keep", and a no-information control is not a strategy. Note the direction
    //     this moves things: `weakest` is a MINIMUM, so removing a candidate can only RAISE the
    //     bar, never lower it. The conservative side, which is the right side for admission.
    const scored = roster
      .filter((b) => !b.protected && !b.benchmark && !isIntradayInterval(b.interval))
      .map((b) => ({ b, fit: fitness(scoreBot(b)) }))
      .sort((a, z) => a.fit - z.fit);
    const weakest = scored[0];
    // `scored` can now be EMPTY — a state that was UNREACHABLE before benchmarks were excluded,
    // because the benchmark itself always supplied the bar. Without this guard the code below
    // simply never fires: nothing is promoted, `state.generation` never advances, and the UI
    // reports "no challenger beat the field", which is the WRONG CAUSE — there was no field.
    // Refuse EXPLICITLY and say why.
    //
    // Refusing, rather than admitting on some absolute threshold, is deliberate. A challenger
    // admitted with no quality bar at all is unvetted by construction, and in GROW mode (the
    // production default) nothing is ever retired, so that noise would sit on the board forever.
    // It also interacts with the fallback above: relaxing this into an "admit anyway" path is
    // exactly what would make breeding-off-the-control reachable again.
    if (!weakest) return { generation: state.generation, promoted: null, retired: null, reason: 'no quality bar: every eligible bot is protected or a benchmark, so there is nothing for a challenger to beat' };

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
    // A full reset deliberately restarts the whole forward experiment, so the advisor's
    // suggestion log restarts with it (its no-hindsight day count begins again — the
    // "track record before trust" clock must not survive a reset it didn't earn).
    //
    // But it is ARCHIVED, not destroyed. This route needs no password — the tournament
    // POSTs are open because it is all virtual money, a rationale written before the
    // advisor existed. The suggestion log is the one artifact that cannot be
    // recomputed from data: it is a no-hindsight FORWARD record, and a single stray POST
    // used to erase it from the only durable copy (save() mirrors straight to the Gist).
    // Archiving keeps the reset honest — the clock really does restart, the panel really
    // does show 0 days — while leaving the record recoverable. Only the most recent
    // non-empty log is kept, so this cannot grow without bound.
    if (Array.isArray(state.advisorLog) && state.advisorLog.length) state.advisorLogArchive = state.advisorLog;
    state.advisorLog = [];
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
    // NOTE a deliberate asymmetry: a `benchmark` row (the fair bar) is guarded against the
    // AUTOMATIC paths — evolution can neither cull it nor breed from it — but is left REMOVABLE
    // here. The line is silent-and-automatic versus explicit-and-recoverable: losing the board's
    // yardstick to a GA scoring window is a bug nobody would notice, while clicking Remove is a
    // stated intent, is visible, and `reset()` restores the full seed line-up. Guarding it here
    // too would also be inconsistent while these routes carry no auth at all (an open decision,
    // see the plan) — the fix for a stranger removing bots is auth, not one special-cased row.
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
    // The persist flags are read LIVE from the store, never frozen at recompute time. tick() runs
    // save() → recompute → advisorTick() → save(); the recompute's finalizer stamped `writeFailed`
    // BEFORE the first save's PATCH had settled (and before the advisor-log save existed at all),
    // so a failed write of the one artifact that cannot be recomputed reported "healthy" until the
    // next recompute — up to a trading day `attempted`/`restored` are boot facts
    // and stay as stamped. The `persist` field is refreshed IN PLACE on the published object rather
    // than on a copy: the board's IDENTITY is part of its contract (a superseded recompute must hand
    // off the newer object, never a stale one — locked in tournament.test.mjs), and a field
    // assignment between awaits is atomic, so no reader can see a torn value.
    getStandings: () => {
      if (standings) {
        // WALL-CLOCK NOW, stamped per RESPONSE. `asOf` is the last RECOMPUTE, which is a
        // different fact: a recompute happens only on init, a control op, or a tick that admitted
        // a NEW bar. So across a weekend — or whenever the feed withholds a close — `asOf`
        // stalls in lockstep with the very log whose staleness the advisor panel is trying to
        // measure, and the panel under-reports exactly when it matters. Readers that need "how
        // long since that entry" must use this; readers that need "when was this computed" keep
        // using `asOf`.
        standings.now = Date.now();
        standings.persist = {
          ...persistState,
          readFailed: typeof persistStore.readFailed === 'function' ? persistStore.readFailed() : persistState.readFailed,
          writeFailed: typeof persistStore.writeFailed === 'function' ? persistStore.writeFailed() : persistState.writeFailed,
        };
      }
      return standings;
    },
    getBotDetail,
    detailIsCached: (id) => detailCache.has(id), // a cache HIT serves getBotDetail for free (no backtest)
    // Test-only: drive the pool-loading gate that holds off the stand-in recovery probe. On a real
    // cold boot `init()` sets this and the pool-completion continuation clears it, but an injected
    // backfill resolves instantly so a test can never observe that window — and the window is
    // exactly where the HIGH lived (a heal there records over a partial universe, permanently).
    _setPoolLoading: (v) => { poolLoading = !!v; },
    botCount: () => bots.length,
    rosterSize: () => roster.length,
    evolutionEnabled, // so the server can skip the daily auto-evolve timer when off
    _appendLiveClose,
    _advisorTick: () => advisorTick(), // test-only: record today's suggestion on demand
    _state: () => state,
    _roster: () => roster,
    _seriesFor: (sym, interval = '1d') => seriesFor(sym, interval),
    // Test-only: the two recompute paths, so a regression test can lock that the YIELDING
    // board equals the SYNC board, and that a superseding recompute wins the handoff.
    _computeStandings: () => computeStandings(),
    _computeStandingsYielding: () => computeStandingsYielding(),
  };
}

// EVOLVE_WINDOW / EVOLVE_WARMUP / CASH are exported so the TESTS can assert against the
// NAMED constants instead of re-typing 756 / 300 / 1e7. A test that copies a magic number
// proves only that the code equals itself — that is exactly how the 10x option-exchange-
// charge error survived for months. Nothing at runtime imports these three; the
// export is a test handle, and changes no behaviour.
// `sharpeUpTo` is exported for its own test only — nothing at runtime imports it; the
// walk-forward calls it directly. Exporting it means the degenerate-curve rule can be
// asserted on its own, instead of only inferred from a whole walk-forward's output.
export { createTournament, computeAutopilotTrack, sharpeUpTo, specKey, dropFormingBar, postProxyScore, EVOLVE_WINDOW, EVOLVE_WARMUP, CASH };
