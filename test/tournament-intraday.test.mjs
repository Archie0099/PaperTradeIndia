// ---------------------------------------------------------------------------
// test/tournament-intraday.test.mjs
// Locks the INTRADAY track of the live tournament: a 60-minute EQ bot runs
// alongside the daily bots, its data is keyed by interval+symbol, its Live %
// is "today's session return", its Sharpe is annualised by the bar frequency,
// the market-hours-aware tick only fetches during the NSE session, evolution
// leaves the intraday track alone, and a persisted intraday roster reproduces
// identical standings. All offline + deterministic (injected backfill data).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createTournament } from '../tournament/tournament.mjs';
import freeProvider from '../src/dataSources/freeProvider.js';

// A deterministic, gently-rising DAILY series (for the benchmark + evolution).
function dailySeries(n = 420) {
  const out = [];
  let p = 18000;
  for (let i = 0; i < n; i++) { p *= 1 + Math.sin(i / 17) * 0.008 + 0.0004; out.push({ t: i * 864e5, c: +p.toFixed(2) }); }
  return out;
}

// A deterministic 60-MINUTE series on real NSE session timestamps (IST 09:15..15:15,
// weekdays only). Each trading day gets `barsPerDay` hourly bars that share one IST
// date — exactly the shape the intraday Live%/tick logic groups on.
function intradaySeries(seed, days = 80, barsPerDay = 7) {
  let a = seed >>> 0;
  const r = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [];
  let p = 2800;
  let day = Date.UTC(2026, 0, 5); // a Monday (00:00 UTC; +5:30 IST keeps the same date)
  const SESSION_OPEN_UTC = 3 * 3600000 + 45 * 60000; // IST 09:15 = UTC 03:45
  while (out.length < days * barsPerDay) {
    const wd = new Date(day).getUTCDay(); // 0 Sun .. 6 Sat
    if (wd !== 0 && wd !== 6) {
      for (let b = 0; b < barsPerDay; b++) {
        const t = day + SESSION_OPEN_UTC + b * 3600000; // hourly bars across the session
        p *= 1 + 0.0002 + (r() - 0.5) * 0.012;
        out.push({ t, c: +p.toFixed(2) });
      }
    }
    day += 24 * 3600000;
  }
  return out;
}

// Seed: a DAILY benchmark + two INTRADAY (60m) bots on RELIANCE — a breakout bot and
// an always-long one (the latter makes "today's session return" easy to assert).
const intradaySeed = () => [
  { id: 'bh', name: 'BH', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'bh', weight: 1 } },
  { id: 'intra', name: 'Intraday breakout', kind: 'EQ', symbol: 'RELIANCE', interval: '60m', spec: { kind: 'EQ', name: 'Intraday breakout', entry: ['>=', ['price'], ['high', 12]], exit: ['<=', ['price'], ['low', 12]] } },
  { id: 'intra-bh', name: 'Intraday always-long', kind: 'EQ', symbol: 'RELIANCE', interval: '60m', spec: { kind: 'EQ', name: 'intra bh', weight: 1 } },
];
// Daily key = bare symbol; intraday key = "60m:SYMBOL".
const intradayData = () => ({ NIFTY: dailySeries(), '60m:RELIANCE': intradaySeries(7) });

test('an intraday (60m) EQ bot runs alongside daily bots with finite stats + an interval tag', async () => {
  const t = await createTournament({ seed: intradaySeed(), backfillData: intradayData(), persist: false });
  await t.init();
  const s = t.getStandings();
  assert.equal(s.bots.length, 3, 'all three bots ranked (1 daily + 2 intraday)');

  const bh = s.bots.find((b) => b.id === 'bh');
  assert.equal(bh.interval, '1d', 'the daily benchmark is tagged 1d');

  for (const id of ['intra', 'intra-bh']) {
    const b = s.bots.find((x) => x.id === id);
    assert.ok(b, `${id} is on the leaderboard`);
    assert.equal(b.interval, '60m', 'the intraday bot carries its 60m interval tag');
    assert.ok(Number.isFinite(b.equity) && b.equity > 0, 'finite positive equity');
    assert.ok(Array.isArray(b.curve) && b.curve.length > 1, 'has an equity curve');
    assert.ok(Number.isFinite(b.liveReturnPct) && Number.isFinite(b.trackReturnPct), 'finite live + track returns');
    assert.ok(Number.isFinite(b.sharpe), 'finite (intraday-annualised) Sharpe');
    assert.ok(b.deployFrac >= 0 && b.deployFrac <= 1, 'deploy marker is in range');
  }
});

test('intraday Live % = TODAY\'S session return (not just the last bar)', async () => {
  const t = await createTournament({ seed: intradaySeed(), backfillData: intradayData(), persist: false });
  await t.init();
  // Append a single fresh 60m bar on a new trading-session day with a big up-move. The
  // always-long intraday bot must show a positive Live % (today's move).
  const series = t._seriesFor('RELIANCE', '60m');
  const lastT = series[series.length - 1].t;
  const lastC = series[series.length - 1].c;
  t._appendLiveClose('RELIANCE', { t: lastT + 3 * 864e5, c: +(lastC * 1.05).toFixed(2) }, '60m'); // +5% on a new day

  const after = t.getStandings();
  assert.equal(after.liveBars, 1, 'one forward intraday bar recorded (interval-keyed live state)');
  const bh = after.bots.find((b) => b.id === 'intra-bh');
  assert.ok(bh.liveReturnPct > 0, `an always-long intraday bot gains on a +5% session, got ${bh.liveReturnPct}%`);
  // Track % is the lifetime figure and stays finite.
  assert.ok(Number.isFinite(bh.trackReturnPct), 'track % stays finite');
});

test('tickIntraday only fetches during the NSE session (market-hours gated)', async () => {
  // Backfill ends 2026-01-05; the fresh bar + clock are on 2026-01-06 (a non-holiday Tue),
  // so the timeline is consistent with the completeness guard (bar's hour must have elapsed).
  const t = await createTournament({ seed: intradaySeed(), backfillData: { NIFTY: dailySeries(), '60m:RELIANCE': intradaySeries(7, 1) }, persist: false });
  await t.init();
  const T = Date.UTC(2026, 0, 6, 4, 45);       // a fresh 60m bar at IST 10:15 Tue
  const orig = freeProvider.getHistory;
  let calls = 0;
  freeProvider.getHistory = async (sym, opts) => { calls++; assert.equal(opts.interval, '60m', 'fetches 60m bars for the intraday source'); return { symbol: sym, candles: [{ t: T, c: 9999 }] }; };
  try {
    const CLOSED = Date.UTC(2026, 0, 6, 14, 30); // IST 20:00 Tue — after hours
    const OPEN = Date.UTC(2026, 0, 6, 6, 0);     // IST 11:30 Tue — mid-session, the 10:15 hour has closed

    const off = await t.tickIntraday({ now: CLOSED });
    assert.equal(off, false, 'off-hours tickIntraday is a no-op');
    assert.equal(calls, 0, 'off-hours it never even hits the network');
    assert.equal(t.getStandings().liveBars, 0, 'no bar appended off-hours');

    const on = await t.tickIntraday({ now: OPEN });
    assert.equal(on, true, 'during the session it appends the fresh (completed) bar');
    assert.ok(calls >= 1, 'during the session it fetches');
    assert.equal(t.getStandings().liveBars, 1, 'one fresh 60m bar now recorded');
  } finally {
    freeProvider.getHistory = orig;
  }
});

test('tickIntraday drops the still-forming 60m bar and never freezes a partial close', async () => {
  // Regression for the review's MEDIUM finding: Yahoo emits the CURRENT in-progress hour
  // bar, and the append-only cursor would freeze that partial close forever. tickIntraday
  // must only accept a bar whose 60m window has fully elapsed (c.t + 1h <= now).
  const t = await createTournament({ seed: intradaySeed(), backfillData: { NIFTY: dailySeries(), '60m:RELIANCE': intradaySeries(7, 12) }, persist: false });
  await t.init();
  const T = Date.UTC(2026, 0, 21, 4, 45);  // a fresh 60m bar at IST 10:15 Wed (after the backfill)
  const now1 = Date.UTC(2026, 0, 21, 5, 15); // IST 10:45 — the 10:15 hour is STILL forming
  const now2 = Date.UTC(2026, 0, 21, 6, 0);  // IST 11:30 — the 10:15 hour has now closed
  const orig = freeProvider.getHistory;
  let forming = 9000; // the partial close at first sighting...
  freeProvider.getHistory = async (sym) => ({ symbol: sym, candles: [{ t: T, c: forming }] });
  try {
    const r1 = await t.tickIntraday({ now: now1 });
    assert.equal(r1, false, 'a still-forming bar is NOT appended');
    assert.equal(t.getStandings().liveBars, 0, 'nothing recorded while the hour is forming');

    forming = 9500; // ...the TRUE close once the hour completes
    const r2 = await t.tickIntraday({ now: now2 });
    assert.equal(r2, true, 'the completed bar IS appended');
    const s = t._seriesFor('RELIANCE', '60m');
    assert.equal(s[s.length - 1].t, T, 'the completed bar is the new last bar');
    assert.equal(s[s.length - 1].c, 9500, 'the stored close is the COMPLETED value, never the frozen partial 9000');
  } finally {
    freeProvider.getHistory = orig;
  }
});

test('a persisted intraday roster restores and reproduces identical standings (deterministic)', async () => {
  const file = join(tmpdir(), `tourn-intraday-${process.pid}-${Date.now()}.json`);
  const data = intradayData();
  try {
    const t1 = await createTournament({ seed: intradaySeed(), backfillData: data, persist: true, stateFile: file });
    await t1.init();
    const a = t1.getStandings().bots.find((b) => b.id === 'intra');
    const t2 = await createTournament({ seed: intradaySeed(), backfillData: data, persist: true, stateFile: file });
    await t2.init();
    const b = t2.getStandings().bots.find((b) => b.id === 'intra');
    assert.equal(b.equity, a.equity, 'identical equity after restart (deterministic intraday re-run)');
    assert.equal(b.interval, '60m', 'the interval survives persistence');
    assert.deepEqual(b.curve, a.curve, 'identical equity curve after restart');
  } finally {
    rmSync(file, { force: true });
  }
});

test('getBotDetail works for an intraday bot (trade log + interval, no look-ahead timestamps)', async () => {
  const t = await createTournament({ seed: intradaySeed(), backfillData: intradayData(), persist: false });
  await t.init();
  const d = t.getBotDetail('intra-bh'); // always-long -> at least its opening buy
  assert.equal(d.ok, true);
  assert.equal(d.interval, '60m', 'detail carries the interval');
  assert.ok(Array.isArray(d.trades) && d.trades.length >= 1, 'intraday bot has a trade log');
  const realBars = new Set(intradaySeries(7).map((c) => c.t));
  for (const tr of d.trades) assert.ok(realBars.has(tr.t), 'every trade lands on a REAL 60m bar (no synthetic/look-ahead time)');
});

test('evolution leaves the intraday track alone (never bred from, never an evolved intraday bot)', async () => {
  // Daily bots to breed from + an intraday bot that must be excluded from the GA.
  const seed = [
    { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
    { id: 'sma', name: 'SMA cross', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'SMA cross', entry: ['>', ['sma', 20], ['sma', 100]], exit: ['<', ['sma', 20], ['sma', 100]] } },
    { id: 'rsi', name: 'RSI dip', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'RSI dip', entry: ['<', ['rsi', 14], 30], exit: ['>', ['rsi', 14], 60] } },
    { id: 'intra', name: 'Intraday breakout', kind: 'EQ', symbol: 'RELIANCE', interval: '60m', spec: { kind: 'EQ', name: 'Intraday breakout', entry: ['>=', ['price'], ['high', 12]], exit: ['<=', ['price'], ['low', 12]] } },
  ];
  const t = await createTournament({ seed, backfillData: { NIFTY: dailySeries(), '60m:RELIANCE': intradaySeries(7) }, persist: false, maxRosterBots: 50 });
  await t.init();
  for (let g = 1; g <= 8; g++) assert.doesNotThrow(() => t.runGeneration({ seed: g * 131 }), `gen ${g} runs with an intraday bot present`);

  const roster = t._roster();
  assert.ok(roster.some((b) => b.id === 'intra'), 'the intraday bot stays on the board (grow mode)');
  // No evolved bot is itself intraday (the GA only produces daily specs)...
  assert.equal(roster.filter((b) => b.interval === '60m').length, 1, 'still exactly the one (seed) intraday bot — none evolved');
  // ...and none was bred FROM the intraday bot (its name would appear in a challenger's note).
  assert.ok(!roster.some((b) => b.id !== 'intra' && /Intraday breakout/.test(b.note || '')), 'no challenger was bred from the intraday bot');
});
