// The ADVISOR — "Today's Suggestions" (tournament/advisor.mjs + its tournament wiring).
// Locks the layer's honesty contract: the suggestion log is APPEND-ONLY and written
// BEFORE outcomes are knowable (a corrupt-the-future lock proves no hindsight), an
// F&O/short champion is EXCLUDED with a stated reason (never silently scaled), the
// log SURVIVES a redeploy through the remote store (and is sanitised on restore),
// and a reset restarts the trust clock. Scoring maths are hand-computed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTournament } from '../tournament/tournament.mjs';
import { scoreAdvisorLog, sanitizeAdvisorLog, closeAtOrBefore, buildAdvisorEntry, ADVISOR_BENCHMARK_FINDING } from '../tournament/advisor.mjs';

const DAY = 86_400_000;
const START = 1_500_000_000_000;
// A small deterministic daily series (no RNG / no clock — reproducible).
function series(n = 400, start = START) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) { p *= 1 + (i % 7 === 0 ? 0.012 : -0.0018); out.push({ t: start + i * DAY, c: +p.toFixed(2) }); }
  return out;
}
const EQ_SEED = [{ id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } }];
const FNO_SEED = [{ id: 'str', name: 'Strangle', kind: 'FNO', symbol: 'NIFTY', spec: { kind: 'FNO', name: 'Strangle', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.05 }, { type: 'PE', side: 'SELL', strikePct: 0.95 }] } }];
const mkTournament = (opts = {}) => createTournament({ seed: EQ_SEED, backfillData: { NIFTY: series() }, persist: false, evolutionEnabled: false, ...opts });

// --- pure maths --------------------------------------------------------------

test('scoreAdvisorLog: hand-computed net return, benchmarks, and cost accounting', () => {
  const T1 = START, T2 = START + DAY;
  const log = [
    { date: '2017-07-14', t: T1, eligible: true, equity: 1000, targets: [{ symbol: 'AAA', qty: 5, price: 100, weight: 0.5 }] },
    { date: '2017-07-15', t: T2, eligible: true, equity: 1010, targets: [{ symbol: 'AAA', qty: 5, price: 110, weight: 0.55 }] },
  ];
  const data = { AAA: [{ t: T1, c: 100 }, { t: T2, c: 110 }], NIFTY: [{ t: T1, c: 200 }, { t: T2, c: 210 }] };
  const seriesFor = (sym) => data[sym] || [];
  const track = scoreAdvisorLog(log, { seriesFor, universe: ['AAA'], costRates: { buyRate: 0.001, sellRate: 0.001 } });
  // Entry cost 0.5×0.1% = 5bp, then 0.5 × (+10%) = +5%, then the 0.05 weight top-up pays
  // 0.005bp: 0.9995 × 1.05 × 0.99995 = 1.0494225 → +4.94% net.
  assert.equal(track.retPct, 4.94);
  assert.equal(track.niftyPct, 5); // gross index
  assert.equal(track.universeEqPct, 10); // gross equal-weight universe (only AAA)
  assert.equal(track.estCostPct, 0.055); // (0.0005 + 0.00005) as %
  assert.equal(track.maxDrawdownPct, 0);
  assert.equal(track.currentDrawdownPct, 0);
  assert.equal(track.days, 2);
});

test('scoreAdvisorLog: an ineligible (stand-aside) entry scores as cash; a missing close degrades to cash, never a fabricated price', () => {
  const T = (i) => START + i * DAY;
  const log = [
    { date: '2017-07-14', t: T(0), eligible: false, equity: 1000, targets: [] },
    { date: '2017-07-15', t: T(1), eligible: false, equity: 1000, targets: [] },
    { date: '2017-07-16', t: T(2), eligible: true, equity: 1000, targets: [{ symbol: 'GONE', qty: 1, price: 50, weight: 1 }] },
    { date: '2017-07-17', t: T(3), eligible: true, equity: 1000, targets: [{ symbol: 'GONE', qty: 1, price: 50, weight: 1 }] },
  ];
  const seriesFor = (sym) => (sym === 'NIFTY' ? [{ t: T(0), c: 100 }, { t: T(3), c: 120 }] : []); // GONE has no data at all
  const track = scoreAdvisorLog(log, { seriesFor, universe: [], costRates: { buyRate: 0, sellRate: 0 } });
  assert.equal(track.retPct, 0, 'cash days + an unpriceable name contribute exactly 0');
  assert.equal(track.niftyPct, 20);
});

test('scoreAdvisorLog HOLDS the previous book through a stand-aside day — no phantom liquidation, no cost (regression)', () => {
  const T = (i) => START + i * DAY;
  const A = (t, w) => ({ symbol: 'A', qty: 1, price: 100, weight: w });
  const log = [
    { date: '2017-07-14', t: T(0), eligible: true, equity: 1000, targets: [A(T(0), 1)] },
    { date: '2017-07-15', t: T(1), eligible: false, equity: 1000, targets: [] }, // champion flipped to F&O for a day
    { date: '2017-07-16', t: T(2), eligible: true, equity: 1000, targets: [A(T(2), 1)] },
  ];
  const data = { A: [{ t: T(0), c: 100 }, { t: T(1), c: 110 }, { t: T(2), c: 121 }], NIFTY: [{ t: T(0), c: 1 }, { t: T(2), c: 1 }] };
  const track = scoreAdvisorLog(log, { seriesFor: (s) => data[s] || [], universe: [], costRates: { buyRate: 0.001, sellRate: 0.001 } });
  // One entry cost (10bp on weight 1), then the FULL +10% and +10% ride through the
  // stand-aside day: 0.999 × 1.1 × 1.1 = 1.20879 → +20.88%. A sell-everything reading
  // would have paid two extra full-book round trips and missed nothing — assert the
  // costs stayed at exactly the single entry.
  assert.equal(track.retPct, 20.88);
  assert.equal(track.estCostPct, 0.1, 'only the initial entry cost — a stand-aside day trades nothing');
});

test('buildAdvisorEntry refuses to record a bogus (non-finite/zero) mirror equity (regression)', () => {
  const mk = (equity) => buildAdvisorEntry({
    autopilot: { currentBot: { id: 'x' } },
    getBotDetail: () => ({ ok: true, id: 'x', name: 'X', kind: 'EQ', mirror: { followable: true, equity, positions: [] } }),
    seriesFor: (s) => (s === 'NIFTY' ? [{ t: START, c: 100 }] : []),
  });
  assert.equal(mk(NaN), null);
  assert.equal(mk(0), null);
  assert.ok(mk(1000), 'a sane equity still records');
});

test('a corrupt advisorLog in the LOCAL state file is sanitised — the board must not 503 (regression)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pti-advisor-'));
  const stateFile = join(dir, 'tournament.json');
  const good = { date: '2020-01-02', t: START, eligible: true, equity: 100, targets: [{ symbol: 'NIFTY', qty: 1, price: 10, weight: 0.5 }] };
  writeFileSync(stateFile, JSON.stringify({ deployedAt: 123, live: {}, roster: null, generation: 0, history: [], advisorLog: [null, 'junk', good] }));
  const t = await createTournament({ seed: EQ_SEED, backfillData: { NIFTY: series() }, persist: true, stateFile, evolutionEnabled: false });
  await t.init(); // would throw inside assembleStandings on the null entry without the sanitise
  assert.ok(t.getStandings(), 'the board still assembles');
  assert.deepEqual(t._state().advisorLog.filter((e) => e.date === '2020-01-02').length, 1, 'the valid entry survives');
  assert.ok(t._state().advisorLog.every((e) => e && typeof e === 'object'), 'the junk is gone');
});

test('closeAtOrBefore: binary search picks the bar at-or-before t, null outside', () => {
  const s = [{ t: 10, c: 1 }, { t: 20, c: 2 }, { t: 30, c: 3 }];
  assert.equal(closeAtOrBefore(s, 5), null);
  assert.equal(closeAtOrBefore(s, 10), 1);
  assert.equal(closeAtOrBefore(s, 25), 2);
  assert.equal(closeAtOrBefore(s, 99), 3);
  assert.equal(closeAtOrBefore([], 10), null);
});

// --- the tournament wiring ---------------------------------------------------

test('init records today\'s suggestion: the champion\'s book, weights, and the data-edge date', async () => {
  const t = await mkTournament();
  await t.init();
  const adv = t.getStandings().advisor;
  assert.ok(adv, 'standings carries the advisor payload');
  assert.equal(adv.logDays, 1, 'one entry recorded at boot');
  const e = adv.today;
  assert.equal(e.botId, 'bh');
  assert.equal(e.eligible, true);
  assert.equal(e.date, new Date(series()[399].t + 5.5 * 3600000).toISOString().slice(0, 10), 'stamped with the IST data-edge date');
  assert.ok(e.targets.length === 1 && e.targets[0].symbol === 'NIFTY');
  assert.ok(e.targets[0].weight > 0.9 && e.targets[0].weight <= 1.001, 'a weight-1 buy & hold is ~fully invested');
  assert.ok(adv.costRates.buyRate > 0 && adv.costRates.sellRate > 0, 'the real delivery cost rates ship to the client');
  assert.equal(adv.benchmarkFinding.verdict, ADVISOR_BENCHMARK_FINDING.verdict, 'the fair-benchmark finding rides along');
});

test('the log is append-once per date and append-only across new bars', async () => {
  const t = await mkTournament();
  await t.init();
  assert.equal(t._advisorTick(), false, 'the same data date never appends twice');
  const first = JSON.parse(JSON.stringify(t._state().advisorLog[0]));
  // A new daily bar arrives → a second entry; the first is untouched byte-for-byte.
  t._appendLiveClose('NIFTY', { t: START + 400 * DAY, c: 130 });
  assert.equal(t._advisorTick(), true);
  const log = t._state().advisorLog;
  assert.equal(log.length, 2);
  assert.deepEqual(log[0], first, 'an existing entry is NEVER modified');
  assert.ok(log[1].date > log[0].date);
});

test('NO HINDSIGHT: corrupting the FUTURE leaves already-recorded entries byte-identical', async () => {
  const run = async (futureCloses) => {
    const t = await mkTournament();
    await t.init();
    let i = 0;
    for (const c of futureCloses) {
      t._appendLiveClose('NIFTY', { t: START + (400 + i) * DAY, c });
      t._advisorTick();
      i++;
    }
    return t._state().advisorLog;
  };
  const a = await run([110, 111, 112, 113, 114]);
  const b = await run([110, 111, 55, 180, 40]); // divergent future after the 2nd forward bar
  assert.equal(a.length, 6);
  // Entries recorded at boot + the first two forward bars pre-date the divergence.
  assert.deepEqual(b.slice(0, 3), a.slice(0, 3), 'pre-divergence entries are unchanged by a different future');
  assert.notDeepEqual(b[3], a[3], 'post-divergence entries do differ (the data really diverged)');
});

test('an F&O champion is EXCLUDED with a stated reason and scored as cash — never silently scaled', async () => {
  const t = await createTournament({ seed: FNO_SEED, backfillData: { NIFTY: series() }, persist: false, evolutionEnabled: false });
  await t.init();
  const e = t.getStandings().advisor.today;
  assert.ok(e, 'the exclusion day still logs (the trust clock counts it)');
  assert.equal(e.eligible, false);
  assert.match(e.reason, /F&O|options/i);
  assert.deepEqual(e.targets, []);
  // Two entries → a scoreable track that sat in cash.
  t._appendLiveClose('NIFTY', { t: START + 400 * DAY, c: 130 });
  t._advisorTick();
  const track = t.getStandings().advisor.track;
  assert.equal(track.retPct, 0, 'stand-aside days earn exactly 0 (cash)');
  assert.equal(track.estCostPct, 0);
});

test('a redeploy restores the suggestion log from the remote store (the must-never-lose artifact)', async () => {
  let blob = null;
  const store = { enabled: true, load: async () => blob, save: (b) => { blob = JSON.parse(JSON.stringify(b)); }, flush: async () => {}, };
  const data = { NIFTY: series() };
  const a = await createTournament({ seed: EQ_SEED, backfillData: data, persist: false, persistStore: store, evolutionEnabled: false });
  await a.init();
  a._appendLiveClose('NIFTY', { t: START + 400 * DAY, c: 130 });
  a._advisorTick();
  const before = JSON.parse(JSON.stringify(a._state().advisorLog));
  assert.equal(before.length, 2);

  // "Redeploy": fresh instance, no local disk, the SAME store.
  const b = await createTournament({ seed: EQ_SEED, backfillData: data, persist: false, persistStore: store, evolutionEnabled: false });
  await b.init();
  assert.deepEqual(b._state().advisorLog, before, 'the whole log survives the redeploy');
  assert.equal(b.getStandings().advisor.logDays, 2);

  // Control: with NO store the log starts over (documents the gap the store closes).
  const c = await createTournament({ seed: EQ_SEED, backfillData: data, persist: false, evolutionEnabled: false });
  await c.init();
  assert.equal(c.getStandings().advisor.logDays, 1, 'a storeless redeploy loses the forward log');
});

test('a corrupt restored log is sanitised: malformed / out-of-order entries dropped, valid ones kept', () => {
  const good = { date: '2020-01-02', t: 1, eligible: true, equity: 100, targets: [{ symbol: 'A', qty: 1, price: 10, weight: 0.5 }] };
  const dirty = [
    'junk',
    { date: 'not-a-date', t: 1, eligible: true, equity: 100, targets: [] },
    good,
    { date: '2020-01-01', t: 2, eligible: true, equity: 100, targets: [] }, // out of order
    { date: '2020-01-03', t: 3, eligible: true, equity: 100, targets: [{ symbol: 'A', qty: NaN, price: 10, weight: 0.5 }] }, // corrupt leg poisons the entry
    { date: '2020-01-04', t: 4, eligible: false, equity: 100, targets: [] },
  ];
  const clean = sanitizeAdvisorLog(dirty);
  assert.deepEqual(clean.map((e) => e.date), ['2020-01-02', '2020-01-04']);
});

test('reset() restarts the trust clock: the suggestion log is cleared with the forward record', async () => {
  const t = await mkTournament();
  await t.init();
  assert.equal(t.getStandings().advisor.logDays, 1);
  t.reset();
  assert.equal(t._state().advisorLog.length, 0);
  assert.equal(t.getStandings().advisor.logDays, 0);
});

test('advisorMinDays is a config knob: ready flips when the log reaches it', async () => {
  const t = await mkTournament({ advisorMinDays: 2 });
  await t.init();
  assert.equal(t.getStandings().advisor.minDays, 2);
  assert.equal(t.getStandings().advisor.ready, false, '1 of 2 days — not yet trusted');
  t._appendLiveClose('NIFTY', { t: START + 400 * DAY, c: 130 });
  t._advisorTick();
  assert.equal(t.getStandings().advisor.ready, true, '2 of 2 days — the banner may drop');
});
