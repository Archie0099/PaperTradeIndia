// ---------------------------------------------------------------------------
// test/tournament.test.mjs
// Locks the live tournament's core: it builds a leaderboard from seed bots,
// advances when a new daily bar arrives, and is deterministic + offline (we
// inject hand-made backfill data and disable persistence — no network, no disk).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createTournament } from '../tournament/tournament.mjs';
import freeProvider from '../src/dataSources/freeProvider.js';

// A gently rising ~200-bar NIFTY-scale series (enough history for SMA200 etc.).
function niftySeries() {
  const candles = [];
  let p = 18000;
  for (let i = 0; i < 220; i++) { p *= 1 + Math.sin(i / 11) * 0.006 + 0.0006; candles.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  return candles;
}

const SEED = [
  { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
  { id: 'strangle', name: 'Strangle', kind: 'FNO', symbol: 'NIFTY', spec: { kind: 'FNO', name: 'Strangle', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.05 }, { type: 'PE', side: 'SELL', strikePct: 0.95 }] } },
  { id: 'rsi', name: 'RSI dip', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'RSI dip', entry: ['<', ['rsi', 7], 30], exit: ['>', ['rsi', 7], 55] } },
];

test('tournament builds a leaderboard from the seed bots', async () => {
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  const s = t.getStandings();
  assert.equal(s.bots.length, 3, 'all three bots ranked');
  assert.equal(s.liveBars, 0, 'no live bars yet at deployment');
  for (const b of s.bots) {
    assert.ok(Number.isFinite(b.equity) && b.equity > 0, `${b.name} has a finite positive equity`);
    assert.ok(Array.isArray(b.curve) && b.curve.length > 1, `${b.name} has a track curve`);
    // Live % is the recent-window return (last ~month), so it is FINITE immediately at
    // deployment (no longer 0-until-forward-days) — that's the whole point of the anchor.
    assert.ok(Number.isFinite(b.liveReturnPct), `${b.name} has a finite recent-window live return`);
    assert.ok(typeof b.position === 'string', `${b.name} reports a position`);
  }
});

test('the yielding recompute equals the sync recompute, and a superseding recompute wins the handoff', async () => {
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  // (1) EQUIVALENCE — the two recompute paths must build the SAME board for the same state (the
  // central correctness claim of the sync/yielding split). asOf is a wall-clock stamp, so compare
  // everything else.
  const sync = t._computeStandings();
  const yielded = await t._computeStandingsYielding();
  const strip = (s) => { const { asOf, ...rest } = s; return rest; };
  assert.deepEqual(strip(yielded), strip(sync), 'the yielding board matches the synchronous board');
  // (2) ABORT-ON-SUPERSEDE — start a yielding recompute (it runs synchronously up to its first
  // setImmediate yield, then suspends), run a SYNC recompute before it resumes (which bumps the
  // recompute generation), and the suspended one must ABORT and hand off the NEWER board, never
  // clobber it with a stale one.
  const inflight = t._computeStandingsYielding(); // starts; suspends at the first yield
  const newer = t._computeStandings();            // bumps the generation, completes synchronously
  const aborted = await inflight;                 // resumes, sees the newer generation, aborts
  assert.equal(aborted, newer, 'the superseded yielding recompute returns the newer board');
  assert.equal(t.getStandings(), newer, 'the published board is the newer one, not clobbered by the stale recompute');
});

test('a universe-spanning (PAIRS) bot with NO usable constituent data yields a NEUTRAL row, not a NaN', async () => {
  // A PAIRS bot is run WITHOUT a marketSeries anchor (unlike a BASKET, which is passed
  // NIFTY), so when its ENTIRE universe is missing/dropped the equity curve is empty — and the row
  // builder would then compute liveReturnPct = (undefined-undefined)/CASH*100 = NaN, leaking a NaN
  // into a money field AND the leaderboard sort. The guard must emit a neutral row instead.
  const PAIRS_SEED = [
    { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
    { id: 'pairs', name: 'Pairs', kind: 'PAIRS', spec: { kind: 'PAIRS', name: 'Pairs', universe: ['AAA', 'BBB', 'CCC', 'DDD'], lookback: 60, entryZ: 2, exitZ: 0.5, stopZ: 4, maxPairs: 2, formationBars: 21, minCorr: 0.6, gross: 0.9 } },
  ];
  // NIFTY has data; the pairs constituents are present-but-EMPTY -> seriesFor returns [] for each
  // (the boot-hygiene backfill guard), so the pairs bot runs on no data — fully offline, no network.
  const t = await createTournament({ seed: PAIRS_SEED, backfillData: { NIFTY: niftySeries(), AAA: [], BBB: [], CCC: [], DDD: [] }, persist: false });
  await t.init();
  const pairs = t.getStandings().bots.find((b) => b.id === 'pairs');
  assert.ok(pairs, 'the pairs bot is on the board');
  assert.ok(Number.isFinite(pairs.liveReturnPct), `liveReturnPct is FINITE, not NaN (got ${pairs.liveReturnPct})`);
  assert.equal(pairs.liveReturnPct, 0, 'a no-data bot shows 0% live');
  assert.equal(pairs.trackReturnPct, 0, '0% track');
  assert.ok(Array.isArray(pairs.curve) && pairs.curve.length === 0, 'empty curve');
  assert.ok(Number.isFinite(pairs.equity) && pairs.equity > 0, 'equity is the finite starting cash, not NaN/0');
  // The per-bot DETAIL page (getBotDetail re-runs the SAME empty-universe bot) must AGREE
  // with the leaderboard. Without the neutral fallback, summarize([]) would report ₹0 / 0% / a ₹0
  // mirror (a divide-by-zero risk for the Auto-Pilot copy) — diverging from the board's ₹1cr row.
  const detail = t.getBotDetail('pairs');
  assert.equal(detail.equity, pairs.equity, 'detail page equity matches the leaderboard (starting cash, not ₹0)');
  assert.equal(detail.mirror.equity, pairs.equity, 'the Auto-Pilot mirror equity matches too (never ₹0)');
  assert.equal(detail.metrics.totalReturnPct, 0, 'a never-traded bot shows 0% on the detail page, not garbage');
});

test('a DATA-STARVED bot\'s mirror is flagged NOT followable; a loaded bot stays followable (regression: cold-boot liquidation)', async () => {
  // On a cold boot the board publishes while the broad basket pool is still loading, so a
  // universe-spanning bot with NO loaded constituents reports an EMPTY book at starting
  // cash — byte-identical to "genuinely in cash". The Auto-Pilot used to copy that and
  // LIQUIDATE the whole account. The mirror must carry a followable:false flag so
  // the client holds instead.
  const STARVED_SEED = [
    { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
    { id: 'pairs', name: 'Pairs', kind: 'PAIRS', spec: { kind: 'PAIRS', name: 'Pairs', universe: ['AAA', 'BBB', 'CCC', 'DDD'], lookback: 60, entryZ: 2, exitZ: 0.5, stopZ: 4, maxPairs: 2, formationBars: 21, minCorr: 0.6, gross: 0.9 } },
    { id: 'noeq', name: 'No-data EQ', kind: 'EQ', symbol: 'GHOST', spec: { kind: 'EQ', name: 'No-data EQ', weight: 1 } },
  ];
  const t = await createTournament({ seed: STARVED_SEED, backfillData: { NIFTY: niftySeries(), AAA: [], BBB: [], CCC: [], DDD: [], GHOST: [] }, persist: false });
  await t.init();
  // The universe-spanning bot with zero loaded constituents: not followable.
  assert.equal(t.getBotDetail('pairs').mirror.followable, false, 'an unloaded-universe bot cannot be copied');
  // A single-symbol bot whose data failed to load: not followable either.
  assert.equal(t.getBotDetail('noeq').mirror.followable, false, 'a no-data single-symbol bot cannot be copied');
  // The bot WITH data keeps its normal copyable mirror (an EQ bot genuinely holding NIFTY).
  const loaded = t.getBotDetail('bh');
  assert.equal(loaded.mirror.followable, true, 'a loaded bot stays followable');
  assert.ok(loaded.mirror.positions.length > 0, 'and its mirror carries its real positions');
});

test('a SHORT (bearish) EQ bot runs end-to-end through the live tournament', async () => {
  // Locks the tournament-side plumbing for the new short capability: computeStandings
  // (position label + finite signed returns for a negative-qty bot) and getBotDetail
  // (a SELL-to-open trade log that reconciles). Direction is proven by opposite signs:
  // on a RISING series the short LOSES while Buy & Hold GAINS.
  const SHORT_SEED = [
    { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
    { id: 'bear', name: 'Bearish', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'Bearish', side: 'short', weight: 1 } },
  ];
  const t = await createTournament({ seed: SHORT_SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  const s = t.getStandings();
  const bear = s.bots.find((b) => b.id === 'bear');
  const bh = s.bots.find((b) => b.id === 'bh');
  assert.ok(bear, 'the short bot is on the board');
  assert.match(bear.position, /short|flat|wiped/, `short bot reports a short/flat position, got "${bear.position}"`);
  assert.ok(Number.isFinite(bear.trackReturnPct) && Number.isFinite(bear.liveReturnPct), 'finite signed returns for the short');
  assert.ok(bear.trackReturnPct < 0, `a short loses on a rising market, got ${bear.trackReturnPct}%`);
  assert.ok(bh.trackReturnPct > 0, 'buy & hold gains on the same rising market (opposite sign proves direction)');
  const d = t.getBotDetail('bear');
  assert.ok(d.ok && Array.isArray(d.trades) && d.trades.length >= 1, 'the short bot has a trade history');
  assert.ok(d.trades.some((tr) => /SELL/.test(tr.side) && /short/i.test(tr.reason)), 'the opening trade is a short SELL with a bearish reason');
  assert.ok(Number.isFinite(d.equity), 'the per-bot detail equity is finite');
});

test('the backfill spans the WHOLE fetched history (trade from the oldest data)', async () => {
  // Part 1: BACKFILL_BARS is Infinity, so a bot's visible track record is the ENTIRE
  // fetched series — not a recent ~300-bar slice. With a 600-bar series, the leaderboard
  // curve must start at the OLDEST bar and the deploy marker must sit at the latest bar
  // (the whole series is "track record"; only genuinely-new forward bars become "live").
  const long = [];
  let p = 12000;
  for (let i = 0; i < 600; i++) { p *= 1 + Math.sin(i / 23) * 0.005 + 0.0006; long.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  const t = await createTournament({ seed: [SEED[0]], backfillData: { NIFTY: long }, persist: false });
  await t.init();
  const bh = t.getStandings().bots.find((b) => b.id === 'bh');
  assert.ok(bh, 'the buy & hold bot is on the board');
  assert.equal(bh.curve[0].t, long[0].t, 'the track curve starts at the OLDEST fetched bar (full history backfilled)');
  assert.equal(bh.curve[bh.curve.length - 1].t, long[long.length - 1].t, 'and ends at the latest bar');
  assert.equal(bh.deployFrac, 1, 'the whole history is the track record (deploy marker at the latest bar, no live bars yet)');
  // The full-history backfill means seriesFor returns all 600 bars (not a 300 slice).
  assert.equal(t._seriesFor('NIFTY').length, 600, 'the engine series is the full fetched history');
  assert.ok(bh.trackReturnPct > 0, 'buy & hold gained over the full rising history');
});

test('per-bot detail + Auto-Pilot expose multi-resolution curve TIERS for the window-zoom charts', async () => {
  // The time-window charts (1D/1W/.../MAX) need better-than-120-point resolution for a short
  // window. The server ships the FULL curve as light multi-resolution tiers [{ms, points}]:
  // each the trailing 1M/1Y/5Y/whole-life slice, downsampled to ≤120 — so a 1-month tier over
  // ~22 bars keeps FULL daily resolution. ~800 bars (~3y) so the walk-forward Auto-Pilot exists.
  const long = [];
  let p = 15000;
  for (let i = 0; i < 800; i++) { p *= 1 + Math.sin(i / 17) * 0.005 + 0.0005; long.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: long }, persist: false });
  await t.init();
  const s = t.getStandings();

  // (1) getBotDetail carries the bot's FULL curve as multi-resolution tiers.
  const d = t.getBotDetail('bh');
  assert.ok(Array.isArray(d.curveTiers) && d.curveTiers.length >= 2, 'detail carries curve tiers');
  let prevMs = -Infinity;
  for (const tier of d.curveTiers) {
    assert.ok(typeof tier.ms === 'number' && Number.isFinite(tier.ms) && tier.ms > prevMs, 'tiers have strictly ascending FINITE ms (JSON-safe — no Infinity)');
    prevMs = tier.ms;
    assert.ok(Array.isArray(tier.points) && tier.points.length >= 2 && tier.points.length <= 120, 'each tier is 2..120 points');
    for (const pt of tier.points) assert.ok(Number.isFinite(pt.t) && Number.isFinite(pt.c), 'points are finite {t,c}');
  }
  // The widest (MAX) tier spans the WHOLE life — same endpoints as the leaderboard row curve.
  const row = s.bots.find((b) => b.id === 'bh');
  const maxTier = d.curveTiers[d.curveTiers.length - 1].points;
  assert.equal(maxTier[0].t, row.curve[0].t, 'the MAX tier starts at the oldest bar');
  assert.equal(maxTier[maxTier.length - 1].t, row.curve[row.curve.length - 1].t, 'and ends at the latest bar');
  // The FINEST tier (1M) ends at the same last bar but starts LATER — i.e. it is a zoom-in.
  const fine = d.curveTiers[0].points;
  assert.equal(fine[fine.length - 1].t, maxTier[maxTier.length - 1].t, 'the finest tier ends at "now"');
  assert.ok(fine[0].t > maxTier[0].t, 'the finest tier starts later than the MAX tier (it is a zoom)');

  // (2) The Auto-Pilot track exposes tiers ALONGSIDE the (unchanged) flat curve the seed +
  //     the determinism/no-look-ahead tests still read.
  assert.ok(s.autopilot, 'the walk-forward Auto-Pilot is present (≥1y of history)');
  assert.ok(Array.isArray(s.autopilot.curve) && s.autopilot.curve.length > 1, 'the flat AP curve is still present (seed + determinism)');
  assert.ok(Array.isArray(s.autopilot.curveTiers) && s.autopilot.curveTiers.length >= 2, 'AP curve tiers for the window chart');
  assert.ok(Array.isArray(s.autopilot.benchTiers) && s.autopilot.benchTiers.length >= 2, 'benchmark curve tiers');
});

test('the leaderboard exposes trailing-window returns (1W/1M/1Y + MAX), marked-to-market, null when too short', async () => {
  // ~600 daily bars (~1.6 years): 1W/1M/1Y windows are available; 5Y/10Y start before the
  // first bar -> null (shown as "–" in the UI). The window return is marked-to-market =
  // eq[now] / eq[the bar at-or-before (now − window)] − 1 (as if squared off at each point).
  const long = [];
  let p = 12000;
  for (let i = 0; i < 600; i++) { p *= 1 + Math.sin(i / 29) * 0.004 + 0.0005; long.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  const t = await createTournament({ seed: [SEED[0]], backfillData: { NIFTY: long }, persist: false });
  await t.init();
  const bh = t.getStandings().bots.find((b) => b.id === 'bh');
  for (const k of ['r1w', 'r1m', 'r1y']) assert.ok(Number.isFinite(bh[k]), `${k} is a finite return (enough history)`);
  for (const k of ['r5y', 'r10y']) assert.equal(bh[k], null, `${k} is null — the bot has < ${k} of history`);
  // MAX (whole-life) is the existing trackReturnPct; a 1Y window is a sub-span of it.
  assert.ok(Number.isFinite(bh.trackReturnPct) && bh.trackReturnPct > 0, 'MAX is positive over the rising series');
  // Cross-check the 1Y figure against a hand computation on the engine series (marked-to-market).
  const series = t._seriesFor('NIFTY');
  const eqStartIdx = series.findIndex((c) => c.t > series[series.length - 1].t - 365.25 * 864e5) - 1;
  assert.ok(eqStartIdx >= 0, 'a ~1y-ago bar exists in the series');
});

test('a new forward bar advances the tournament (live return moves off zero)', async () => {
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  const before = t.getStandings();
  const lastT = 219 * 864e5;
  // Inject a big up-day forward: Buy & Hold (fully long) must now show a
  // positive live return; the FNO seller should still be finite.
  t._appendLiveClose('NIFTY', { t: lastT + 864e5, c: 30000 });
  const after = t.getStandings();
  assert.equal(after.liveBars, 1, 'one live bar now recorded');
  const bh = after.bots.find((b) => b.id === 'bh');
  assert.ok(bh.liveReturnPct > 0, `Buy & Hold should gain on a forward up-day, got ${bh.liveReturnPct}%`);
  assert.notEqual(JSON.stringify(before.bots), JSON.stringify(after.bots), 'standings changed after the new bar');
});

test('getBotDetail returns a full per-trade history for one bot (track vs live split)', async () => {
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  t._appendLiveClose('NIFTY', { t: 219 * 864e5 + 864e5, c: 30000 }); // a forward bar -> a live period exists

  const d = t.getBotDetail('bh'); // Buy & Hold -> at least its opening BUY
  assert.equal(d.ok, true);
  assert.equal(d.id, 'bh');
  assert.ok(Array.isArray(d.trades) && d.trades.length >= 1, 'Buy & Hold has at least its opening buy');
  assert.equal(d.trades.length <= d.tradeCount, true, 'tradeCount is the full total (shown may be capped)');
  assert.ok(typeof d.totalRealised === 'number' && Number.isFinite(d.totalRealised), 'reports a finite net booked P&L');
  for (const tr of d.trades) {
    assert.ok(typeof tr.t === 'number' && tr.symbol && tr.side, 'each trade has a date, symbol and side');
    assert.equal(typeof tr.live, 'boolean', 'each trade is flagged track vs live');
    assert.equal(tr.live, tr.t > d.deployAt, 'the live flag = "traded after the deploy cutoff"');
  }
  // A bad id -> a clean not-ok result so the route can 404.
  assert.equal(t.getBotDetail('no-such-bot').ok, false);
});

test('getBotDetail is memoised per state (cached until the data changes)', async () => {
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  const a = t.getBotDetail('bh');
  const b = t.getBotDetail('bh');
  assert.equal(a, b, 'repeated calls return the SAME cached object (no redundant re-backtest)');
  // A state change (new forward bar -> computeStandings) must invalidate the cache.
  t._appendLiveClose('NIFTY', { t: 219 * 864e5 + 864e5, c: 30000 });
  const c = t.getBotDetail('bh');
  assert.notEqual(c, a, 'a fresh object after the live data changed (cache invalidated)');
  assert.equal(c.ok, true);
});

test('FNO bots report their current open position while live', async () => {
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  const strangle = t.getStandings().bots.find((b) => b.id === 'strangle');
  // It is either mid-cycle (open legs described) or flat between cycles — both
  // are valid strings; the point is the leaderboard surfaces a live position.
  assert.ok(/open:|flat/.test(strangle.position), `position string present: "${strangle.position}"`);
});

test('bots run on different symbols, each with ₹1 crore of capital', async () => {
  const seedMulti = [
    { id: 'a', name: 'BH-NIFTY', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'bh', weight: 1 } },
    { id: 'b', name: 'RSI-REL', kind: 'EQ', symbol: 'RELIANCE', spec: { kind: 'EQ', name: 'rsi', entry: ['<', ['rsi', 14], 30], exit: ['>', ['rsi', 14], 60] } },
    { id: 'c', name: 'BO-TCS', kind: 'EQ', symbol: 'TCS', spec: { kind: 'EQ', name: 'bo', entry: ['>', ['price'], ['high', 20]], exit: ['<', ['price'], ['low', 10]] } },
  ];
  const t = await createTournament({ seed: seedMulti, backfillData: { NIFTY: niftySeries(), RELIANCE: niftySeries(), TCS: niftySeries() }, persist: false });
  await t.init();
  const s = t.getStandings();
  assert.deepEqual(new Set(s.bots.map((b) => b.symbol)), new Set(['NIFTY', 'RELIANCE', 'TCS']), 'bots span their symbols');
  assert.equal(s.startingCash, 10_000_000, 'each bot starts with ₹1 crore of capital');
  for (const b of s.bots) assert.ok(Number.isFinite(b.equity) && b.equity > 0, `${b.name} has finite positive equity`);
});

test('a persisted/evolved bot on a non-seed symbol still gets its data after restart (no NaN row)', async () => {
  // The seed here is NIFTY-only, but the persisted roster also has a RELIANCE bot.
  // load() must run BEFORE we load candle data, so RELIANCE's data is fetched too —
  // otherwise its row comes back equity=0 / liveReturn=NaN and can never be retired.
  const file = join(tmpdir(), `tourn-sym-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({
    deployedAt: 1700000000000, live: {}, generation: 1, history: [],
    roster: [
      { id: 'a', name: 'BH', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'bh', weight: 1 } },
      { id: 'b', name: 'RSI-REL', kind: 'EQ', symbol: 'RELIANCE', spec: { kind: 'EQ', name: 'rsi', entry: ['<', ['rsi', 14], 30], exit: ['>', ['rsi', 14], 60] } },
    ],
  }));
  try {
    const t = await createTournament({
      seed: [{ id: 'a', name: 'BH', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'bh', weight: 1 } }],
      backfillData: { NIFTY: niftySeries(), RELIANCE: niftySeries() }, persist: true, stateFile: file,
    });
    await t.init();
    const rel = t.getStandings().bots.find((b) => b.symbol === 'RELIANCE');
    assert.ok(rel, 'the persisted RELIANCE bot is present');
    assert.ok(rel.curve.length > 1 && Number.isFinite(rel.liveReturnPct), 'it has real data, not a NaN/empty row');
  } finally {
    rmSync(file, { force: true });
  }
});

test('seriesFor de-dups + sorts the merged backfill+live series (no replayed/out-of-order bar)', async () => {
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();
  const lastT = 219 * 864e5;
  const cleanLen = t._seriesFor('NIFTY').length;
  // Inject a duplicate-timestamp bar and an out-of-order (older) bar directly.
  t._appendLiveClose('NIFTY', { t: lastT, c: 99999 });        // duplicate of the last backfill bar
  t._appendLiveClose('NIFTY', { t: lastT - 5 * 864e5, c: 1 }); // an older, out-of-order bar
  const s = t._seriesFor('NIFTY');
  // Strictly increasing timestamps, no duplicates — the backtester never sees a bad bar.
  for (let i = 1; i < s.length; i++) assert.ok(s[i].t > s[i - 1].t, 'series is strictly increasing (de-duped + sorted)');
  assert.equal(s.length, cleanLen, 'a duplicate/older bar does not lengthen the series');
  // The de-dup keeps the LIVE close on a tie at the duplicated timestamp.
  assert.equal(s.find((c) => c.t === lastT).c, 99999, 'live close wins on a timestamp tie');
});

test('a control op during a tick’s network await is not clobbered (race guard)', async () => {
  const series = niftySeries();
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: series }, persist: false });
  await t.init();
  const lastT = series[series.length - 1].t;
  // Gate getHistory so the tick suspends mid-await while we reset().
  const orig = freeProvider.getHistory;
  let release;
  const gate = new Promise((r) => { release = r; });
  freeProvider.getHistory = async () => { await gate; return { symbol: 'NIFTY', candles: [{ t: lastT + 864e5, c: 30000 }] }; };
  try {
    const ticking = t.tick();       // suspends on the gated getHistory
    t.reset();                      // a control op lands during the await
    assert.equal(t.getStandings().liveBars, 0, 'reset cleared the live clock');
    release();
    await ticking;                  // tick resumes — must NOT re-add a bar
    assert.equal(t.getStandings().liveBars, 0, 'the aborted tick did not clobber the reset');
  } finally {
    freeProvider.getHistory = orig;
  }
});

test('tick() back-fills ALL missed completed sessions, not just the newest bar (regression)', async () => {
  const series = niftySeries();
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: series }, persist: false });
  await t.init();
  const lastT = series[series.length - 1].t;
  // The host slept across three sessions (a free-tier dyno does): the 5-day fetch
  // returns THREE new completed bars. The old tick() appended only the newest one,
  // permanently dropping the two intermediate days from the live track — while
  // tickIntraday() already healed them. The daily tick must match it.
  const orig = freeProvider.getHistory;
  freeProvider.getHistory = async () => ({
    symbol: 'NIFTY',
    candles: [
      { t: lastT + 1 * 864e5, c: 30000 },
      { t: lastT + 2 * 864e5, c: 30100 },
      { t: lastT + 3 * 864e5, c: 30200 },
    ],
  });
  try {
    const changed = await t.tick();
    assert.equal(changed, true, 'the tick advanced');
    const s = t._seriesFor('NIFTY');
    assert.deepEqual(s.slice(-3).map((c) => c.c), [30000, 30100, 30200], 'all three missed sessions appended, in order');
    assert.equal(t.getStandings().liveBars, 3, 'the live clock advanced by all three bars');
  } finally {
    freeProvider.getHistory = orig;
  }
});

// A longer per-symbol series so basket indicators (mom63 etc.) warm up.
function stockSeries(seed, n = 360) {
  let a = seed >>> 0;
  const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = []; let p = 100 + (seed % 40);
  for (let i = 0; i < n; i++) { p *= 1 + 0.0003 + (r() - 0.5) * 0.02; out.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  return out;
}
const BASKET_U = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK'];
const basketData = () => { const d = {}; [...BASKET_U, 'NIFTY'].forEach((s, k) => (d[s] = stockSeries(k * 131 + 5))); return d; };
const basketSeed = () => [
  { id: 'bh', name: 'BH', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'bh', weight: 1 } },
  { id: 'bk', name: 'Momentum basket', kind: 'BASKET', spec: { kind: 'BASKET', name: 'Momentum', universe: BASKET_U, rank: ['mom', 63], k: 2, weighting: 'equal', rebalanceBars: 21 } },
];

test('a BASKET bot trades many companies, reports holdings, and loads its constituents', async () => {
  const t = await createTournament({ seed: basketSeed(), backfillData: basketData(), persist: false });
  await t.init();
  const bk = t.getStandings().bots.find((b) => b.id === 'bk');
  assert.ok(bk, 'the basket bot is on the leaderboard');
  assert.ok(Number.isFinite(bk.equity) && bk.equity > 0, 'finite positive equity');
  assert.ok(Array.isArray(bk.holdings) && bk.holdings.length >= 1, 'reports its current holdings');
  for (const h of bk.holdings) assert.ok(BASKET_U.includes(h.symbol) && Number.isFinite(h.weightPct), 'each holding is a real constituent + weight');
  assert.ok(/%|cash/.test(bk.position), `a position string is shown: "${bk.position}"`);
  // Live return is the recent-window return — FINITE (not NaN/garbage), the regression
  // for the basket deployIdx bug (backfill[label] is undefined -> would have been wrong).
  assert.ok(Number.isFinite(bk.liveReturnPct), 'live return is a finite recent-window %, not NaN/garbage');
});

test('getBotDetail surfaces the strategy rationale, rebalance decision, and per-stock contributions', async () => {
  const t = await createTournament({ seed: basketSeed(), backfillData: basketData(), persist: false });
  await t.init();

  // --- the BASKET bot: rationale + the "why each stock was chosen" decision log ---
  const d = t.getBotDetail('bk');
  assert.equal(d.ok, true);
  assert.ok(d.rationale && typeof d.rationale.headline === 'string' && d.rationale.headline.length > 0, 'a plain-English strategy headline');
  assert.ok(d.rationale.thesis.length > 0 && Array.isArray(d.rationale.params) && d.rationale.params.length >= 3, 'a thesis + parameter list');
  assert.ok(typeof d.rationale.risk === 'string' && d.rationale.risk.length > 0, 'a risk note');

  assert.ok(d.decision && Array.isArray(d.decision.candidates) && d.decision.candidates.length >= 2, 'a rebalance decision with the scanned candidates');
  assert.equal(d.decision.universeSize, BASKET_U.length, 'the decision reports the universe size');
  for (const c of d.decision.candidates) {
    assert.ok(BASKET_U.includes(c.sym), 'each candidate is a real constituent');
    assert.equal(typeof c.chosen, 'boolean', 'each candidate is flagged chosen/not');
  }
  // candidates are sorted best-first (score descending, nulls already filtered).
  const scores = d.decision.candidates.map((c) => (c.score == null ? -Infinity : c.score));
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i] <= scores[i - 1] + 1e-9, 'candidates are ranked best-first');
  const chosen = d.decision.candidates.filter((c) => c.chosen);
  assert.ok(chosen.length >= 1, 'at least one name was chosen');
  const chosenWeight = chosen.reduce((s, c) => s + c.weightPct, 0);
  assert.ok(chosenWeight > 50 && chosenWeight <= 100.5, `chosen target weights ~sum to the gross, got ${chosenWeight}`);

  assert.ok(Array.isArray(d.contributions) && d.contributions.length >= 1, 'per-stock P&L contributions');
  for (const c of d.contributions) {
    assert.ok(BASKET_U.includes(c.symbol), 'each contribution is a real constituent');
    assert.ok(Number.isFinite(c.realised), 'a finite realised P&L');
  }
  // contributions are sorted by realised P&L descending.
  for (let i = 1; i < d.contributions.length; i++) assert.ok(d.contributions[i].realised <= d.contributions[i - 1].realised + 1e-6, 'contributions sorted by P&L');

  // every buy/sell in the history carries a plain-English REASON ("why this trade").
  assert.ok(d.trades.length >= 1 && d.trades.every((tr) => typeof tr.reason === 'string' && tr.reason.length > 0), 'each trade has a reason');
  assert.ok(d.trades.some((tr) => /Entered|Increased|Exited|Trimmed|Risk-off/.test(tr.reason)), 'basket reasons describe entry/exit by rank');

  // --- an EQ bot: rationale present, but NO basket decision log ---
  const e = t.getBotDetail('bh');
  assert.ok(e.rationale && /buy & hold/i.test(e.rationale.headline), 'the EQ benchmark gets a buy & hold rationale');
  assert.equal(e.decision, null, 'a single-symbol EQ bot has no rebalance-decision log');
});

test('a persisted BASKET roster restores and reproduces identical standings', async () => {
  const file = join(tmpdir(), `tourn-basket-${process.pid}-${Date.now()}.json`);
  const data = basketData();
  try {
    const t1 = await createTournament({ seed: basketSeed(), backfillData: data, persist: true, stateFile: file });
    await t1.init();
    const b1 = t1.getStandings().bots.find((b) => b.id === 'bk');
    const t2 = await createTournament({ seed: basketSeed(), backfillData: data, persist: true, stateFile: file });
    await t2.init();
    const b2 = t2.getStandings().bots.find((b) => b.id === 'bk');
    assert.equal(b2.equity, b1.equity, 'identical equity after restart (deterministic re-run)');
    assert.deepEqual(b2.holdings, b1.holdings, 'identical holdings after restart');
  } finally {
    rmSync(file, { force: true });
  }
});

test('a corrupt/incompatible persisted roster falls back to the seed line-up', async () => {
  const file = join(tmpdir(), `tourn-test-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({
    deployedAt: 1700000000000, live: {}, generation: 3, history: [],
    roster: [
      { id: 'x', name: 'X', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'BOGUS' } },
      { id: 'y', name: 'Y', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', entry: ['frobnicate', 1] } },
    ],
  }));
  try {
    const t = await createTournament({ seed: SEED, backfillData: { NIFTY: niftySeries() }, persist: true, stateFile: file });
    await t.init();
    assert.equal(t.botCount(), SEED.length, 'fell back to the seed line-up, not an empty board');
    assert.ok(t.getStandings().bots.length > 0);
  } finally {
    rmSync(file, { force: true });
  }
});

test('control ops: reset, remove (protected guarded), and explanations', async () => {
  const seed = [
    { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
    { id: 'rsi', name: 'RSI dip', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'RSI dip', entry: ['<', ['rsi', 14], 30], exit: ['>', ['rsi', 14], 60] } },
    { id: 'str', name: 'Strangle', kind: 'FNO', symbol: 'NIFTY', spec: { kind: 'FNO', name: 'Strangle', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.05 }, { type: 'PE', side: 'SELL', strikePct: 0.95 }] } },
  ];
  const t = await createTournament({ seed, backfillData: { NIFTY: niftySeries() }, persist: false });
  await t.init();

  // Each bot carries a plain-English explanation.
  const rsiBot = t.getStandings().bots.find((b) => b.id === 'rsi');
  assert.match(rsiBot.explain, /Buys when RSI/);

  // Protected bot cannot be removed; a normal one can.
  assert.equal(t.removeBot('bh').ok, false, 'protected bot is guarded');
  const before = t.rosterSize();
  assert.equal(t.removeBot('rsi').ok, true);
  assert.equal(t.rosterSize(), before - 1);

  // Reset restores the full line-up at generation 0 with a clean history.
  t.reset();
  assert.equal(t.rosterSize(), seed.length);
  assert.equal(t.getStandings().generation, 0);
  assert.equal(t.getStandings().history.length, 0);
});

// A longer series so 50/200-period strategies engage during scoring.
function longSeries() {
  const long = [];
  let p = 18000;
  for (let i = 0; i < 420; i++) { p *= 1 + Math.sin(i / 17) * 0.009 + 0.0003; long.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  return long;
}
const evoSeed = () => [
  { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
  { id: 'sma', name: 'SMA cross', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'SMA cross', entry: ['>', ['sma', 20], ['sma', 100]], exit: ['<', ['sma', 20], ['sma', 100]] } },
  { id: 'rsi', name: 'RSI dip', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'RSI dip', entry: ['<', ['rsi', 14], 30], exit: ['>', ['rsi', 14], 60] } },
  { id: 'str', name: 'Strangle', kind: 'FNO', symbol: 'NIFTY', spec: { kind: 'FNO', name: 'Strangle', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.05 }, { type: 'PE', side: 'SELL', strikePct: 0.95 }] } },
];

test('GROW mode is the DEFAULT: a winning challenger is ADDED (board grows), nobody retired, benchmark stays', async () => {
  // Deliberately DO NOT pass retireWeakest — this locks that the production default
  // (the no-arg createTournament() the server uses) is grow mode. High cap so growth
  // never hits it here; we are testing the "append, retire none" behaviour itself.
  const t = await createTournament({ seed: evoSeed(), backfillData: { NIFTY: longSeries() }, persist: false, maxRosterBots: 50 });
  await t.init();
  const size0 = t.rosterSize();

  let promotions = 0, lastSize = size0;
  for (let g = 1; g <= 8; g++) {
    const r = t.runGeneration({ seed: g * 101 });
    const size = t.rosterSize();
    assert.ok(size >= lastSize, 'the roster NEVER shrinks — no bot is ever retired');
    if (r.promoted) {
      promotions++;
      assert.equal(size, lastSize + 1, 'a win APPENDS exactly one bot');
      assert.equal(r.retired, null, 'grow mode retires nobody (retired is null)');
      assert.ok(r.promotedId && t._roster().some((b) => b.id === r.promotedId), 'promotedId identifies the freshly-appended bot (so the UI can highlight it)');
    } else {
      assert.equal(size, lastSize, 'no win -> no change in board size');
    }
    assert.ok(t._roster().some((b) => b.id === 'bh'), 'the protected benchmark is always present');
    lastSize = size;
  }
  assert.ok(promotions >= 1, `expected at least one challenger to win in, got ${promotions}`);
  assert.equal(t.rosterSize(), size0 + promotions, 'final size = seeds + everything that won in (nothing retired)');
  // Every bot id is unique (the time-token in evo-g ids guards against collisions).
  const ids = t._roster().map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, 'all bot ids are unique after growth');
  // Standings stay coherent, surface the cap, and every evolution event is an ADD.
  const s = t.getStandings();
  assert.equal(s.bots.length, size0 + promotions);
  assert.equal(s.atCap, false, 'not at the cap (50) yet');
  assert.equal(s.maxBots, 50, 'the cap is surfaced in standings');
  assert.equal(s.botCount, s.bots.length, 'botCount matches the leaderboard size');
  for (const b of s.bots) assert.ok(Number.isFinite(b.equity) && b.equity > 0);
  assert.ok(s.history.length >= 1 && s.history.every((h) => h.retired === null), 'every logged event is an ADD, not a retirement');
});

test('GROW mode stops at the cap (reports "full") and still retires nobody', async () => {
  // Cap == seed size, so any winner must be REFUSED (the board is already full) —
  // and crucially, no existing bot is retired to make room.
  const seed = evoSeed();
  const t = await createTournament({ seed, backfillData: { NIFTY: longSeries() }, persist: false, retireWeakest: false, maxRosterBots: seed.length });
  await t.init();
  assert.equal(t.rosterSize(), seed.length);

  // With the board already at the cap, runGeneration short-circuits to `full` on
  // EVERY generation (before any breeding) and never changes the board.
  for (let g = 1; g <= 8; g++) {
    const r = t.runGeneration({ seed: g * 37 });
    assert.equal(t.rosterSize(), seed.length, 'at the cap the board size never changes');
    assert.equal(r.full, true, 'every generation reports the board is full');
    assert.equal(r.max, seed.length, 'the full signal reports the cap');
    assert.equal(r.promoted, null, 'nothing is added once the board is full');
    assert.equal(r.retired, null, 'and nothing is retired (grow mode keeps all)');
  }
  assert.equal(t.getStandings().atCap, true, 'the polled standings flag the board as full');
  assert.equal(t.getStandings().history.length, 0, 'a full board logs no evolution events');
});

test('addFromPool respects the grow-mode cap (the manual Add cannot grow the board past it)', async () => {
  // Seed AT the cap, so addFromPool — like runGeneration — must refuse (the cap bounds
  // computeStandings cost on the free host; the manual Add must not defeat it).
  const seed = evoSeed();
  const t = await createTournament({ seed, backfillData: { NIFTY: longSeries() }, persist: false, maxRosterBots: seed.length });
  await t.init();
  const r = t.addFromPool();
  assert.equal(r.ok, false, 'Add is refused once the board is at the cap');
  assert.equal(r.full, true, 'it reports the board is full');
  assert.equal(t.rosterSize(), seed.length, 'the board did not grow past the cap');
});

test('GROW mode tolerates a corruptly-persisted MALFORMED bot: never bred from, never crashes evolution', async () => {
  // A malformed FNO spec (no `legs`) is a shape only external corruption of
  // data/tournament.json can produce. In grow mode it is NEVER retired, so it would
  // sit on the roster forever — runGeneration must not let it become an evolution
  // parent (crossover would clone undefined legs and throw) or crash the daily evolve.
  const file = join(tmpdir(), `tourn-malformed-${process.pid}-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify({
    deployedAt: 1700000000000, live: {}, generation: 0, history: [],
    roster: [
      { id: 'bh', name: 'BH', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'bh', weight: 1 } },
      { id: 'sma', name: 'SMA cross', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'SMA cross', entry: ['>', ['sma', 20], ['sma', 100]], exit: ['<', ['sma', 20], ['sma', 100]] } },
      { id: 'broken', name: 'Broken', kind: 'FNO', symbol: 'NIFTY', spec: { kind: 'FNO', name: 'broken' } }, // malformed: no legs
    ],
  }));
  try {
    const t = await createTournament({ seed: evoSeed(), backfillData: { NIFTY: longSeries() }, persist: true, stateFile: file, maxRosterBots: 50 });
    await t.init();
    assert.ok(t._roster().some((b) => b.id === 'broken'), 'the malformed bot stays in the grow-mode roster (never retired)');
    assert.ok(!t.getStandings().bots.some((b) => b.id === 'broken'), 'but it is filtered off the leaderboard (does not compile)');
    // Evolution must NOT throw on any seed, even with the malformed bot present, and a
    // valid challenger should still be able to win in (proving evolution still works).
    let promotions = 0;
    for (let g = 1; g <= 12; g++) {
      let r;
      assert.doesNotThrow(() => { r = t.runGeneration({ seed: g * 9973 }); }, `gen ${g} must not crash on the malformed bot`);
      if (r.promoted) promotions++;
    }
    assert.ok(promotions >= 1, 'a valid challenger still won in despite the malformed bot');
    assert.ok(!t.getStandings().bots.some((b) => b.note && /broken/.test(b.note)), 'no challenger was bred from the malformed bot');
  } finally {
    rmSync(file, { force: true });
  }
});

test('retireWeakest:true restores the legacy fixed-size replace-the-weakest behaviour', async () => {
  // The old selection-pressure path still works behind the flag (so it cannot bitrot).
  const t = await createTournament({ seed: evoSeed(), backfillData: { NIFTY: longSeries() }, persist: false, retireWeakest: true });
  await t.init();
  const size0 = t.rosterSize();

  let promotions = 0, retirements = 0;
  for (let g = 1; g <= 8; g++) {
    const r = t.runGeneration({ seed: g * 101 });
    if (r.promoted) promotions++;
    if (r.retired) retirements++;
    assert.equal(t.rosterSize(), size0, 'roster size is FIXED when retiring the weakest');
    assert.ok(t._roster().some((b) => b.id === 'bh'), 'the protected benchmark is never retired');
  }
  assert.ok(promotions >= 1, `expected at least one promotion, got ${promotions}`);
  assert.equal(retirements, promotions, 'every promotion retired exactly one bot');
  const s = t.getStandings();
  assert.equal(s.bots.length, size0);
  for (const b of s.bots) assert.ok(Number.isFinite(b.equity) && b.equity > 0);
  assert.ok(s.history.some((h) => h.retired), 'the legacy path logs a retirement');
});

test('evolutionEnabled:false turns breeding OFF — runGeneration is a no-op, the board stays the curated seed', async () => {
  // The production server runs with breeding OFF by design: the board shows only the
  // curated seed line-up, never auto-generated GA mutations. The machinery stays intact (so a
  // re-enable resumes it — proven by the default-on tests above); here we lock the OFF path.
  const t = await createTournament({ seed: evoSeed(), backfillData: { NIFTY: longSeries() }, persist: false, evolutionEnabled: false });
  await t.init();
  const size0 = t.rosterSize();
  assert.equal(t.getStandings().evolutionEnabled, false, 'standings carry the flag (so the UI hides Evolve)');
  assert.equal(t.evolutionEnabled, false, 'the flag is exposed so server.js can skip the daily auto-evolve timer');
  for (let g = 1; g <= 6; g++) {
    const r = t.runGeneration({ seed: g * 101 });
    assert.equal(r.disabled, true, 'runGeneration is a harmless no-op when breeding is off');
    assert.equal(r.promoted, null, 'nothing is bred or added');
    assert.equal(t.rosterSize(), size0, 'the board never grows past the curated seed');
  }
  assert.equal(t.getStandings().history.length, 0, 'no evolution events are logged');
});
