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
import { scoreAdvisorLog, sanitizeAdvisorLog, closeAtOrBefore, buildAdvisorEntry, buildAdvisorPayload, ADVISOR_BENCHMARK_FINDING } from '../tournament/advisor.mjs';

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
    // equity 1050 = the book marked at the new price (5 x 110) + the 500 it never invested.
    // A real entry ALWAYS marks to market, and turnover is measured between the previous book
    // drifted to this bar and these weights — an inconsistent fixture would invent a trade.
    { date: '2017-07-15', t: T2, eligible: true, equity: 1050, targets: [{ symbol: 'AAA', qty: 5, price: 110, weight: 0.523810 }] },
  ];
  const data = { AAA: [{ t: T1, c: 100 }, { t: T2, c: 110 }], NIFTY: [{ t: T1, c: 200 }, { t: T2, c: 210 }] };
  const seriesFor = (sym) => data[sym] || [];
  const track = scoreAdvisorLog(log, { seriesFor, universe: ['AAA'], costRates: { buyRate: 0.001, sellRate: 0.001 } });
  // Entry cost 0.5×0.1% = 5bp, then 0.5 × (+10%) = +5%: 0.9995 × 1.05 = 1.049475 → +4.95%.
  // Day 2 holds the SAME 5 shares — its weight rose from 0.50 to 0.55 only because AAA's
  // price rose. That is not a trade and is not charged. (This test previously expected the
  // 0.05 weight drift to pay a top-up; charging price drift as turnover billed a champion
  // that never trades ~0.5%/yr of phantom cost, printed as "net of est. costs"
  // beside two GROSS benchmarks. Turnover is measured in SHARES now.)
  assert.equal(track.retPct, 4.95);
  assert.equal(track.niftyPct, 5); // gross index
  assert.equal(track.universeEqPct, 10); // gross equal-weight universe (only AAA)
  assert.equal(track.estCostPct, 0.05); // the entry only — day 2 traded nothing
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
  // equity 100 keeps the fixture SELF-CONSISTENT: a real entry always records
  // weight === qty*price/equity (buildAdvisorEntry), and cost is now priced off the
  // share count, so an inconsistent fixture would assert a number the app can't produce.
  const log = [
    { date: '2017-07-14', t: T(0), eligible: true, equity: 100, targets: [A(T(0), 1)] },
    { date: '2017-07-15', t: T(1), eligible: false, equity: 100, targets: [] }, // champion flipped to F&O for a day
    { date: '2017-07-16', t: T(2), eligible: true, equity: 100, targets: [A(T(2), 1)] },
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
  const before = t._state().advisorLog.slice();
  t.reset();
  assert.equal(t._state().advisorLog.length, 0);
  assert.equal(t.getStandings().advisor.logDays, 0);
  // ...but the record is ARCHIVED, not destroyed. /api/tournament/reset needs no password
  // (all virtual money), and the suggestion log is the one artifact that cannot be
  // recomputed from data — a stray POST must not erase it from the only durable copy.
  assert.deepEqual(t._state().advisorLogArchive, before, 'the pre-reset log is recoverable');
  t.reset();
  assert.deepEqual(t._state().advisorLogArchive, before, 'a second reset does not overwrite the archive with an empty log');
});

test('coverage reports how many of the POSSIBLE trading days were actually recorded', async () => {
  // The log only grows while the server is awake to see a new bar, and a free host sleeps.
  // Without this the panel's "N of 90 days" reads as a 90-day countdown when the honest
  // reading can be years. Possible days = NIFTY's own bars from the first entry to the edge.
  const t = await mkTournament();
  await t.init();
  const c1 = t.getStandings().advisor.coverage;
  assert.equal(c1.recordedDays, 1);
  assert.equal(c1.possibleDays, 1, 'the first entry sits on the newest bar, so exactly one day was possible');
  assert.equal(c1.ratio, 1);
  assert.equal(c1.since, t.getStandings().advisor.today.date);

  // Three new bars arrive but only the LAST is recorded (the server was asleep for two).
  for (let i = 0; i < 3; i++) t._appendLiveClose('NIFTY', { t: START + (400 + i) * DAY, c: 130 + i });
  assert.equal(t._advisorTick(), true);
  const c2 = t.getStandings().advisor.coverage;
  assert.equal(c2.recordedDays, 2, 'two suggestions recorded');
  assert.equal(c2.possibleDays, 4, 'but four trading days passed since the first one');
  assert.equal(c2.ratio, 0.5);
});

test('coverage is null before anything is logged, and never divides by zero', () => {
  const empty = buildAdvisorPayload({ log: [], seriesFor: () => [], universe: [] });
  assert.equal(empty.coverage, null);
  // A log with no market series loaded must report the gap honestly, not a fake ratio.
  const noMarket = buildAdvisorPayload({ log: [{ date: '2020-01-02', t: 1, eligible: true, equity: 100, targets: [] }], seriesFor: () => [], universe: [] });
  assert.equal(noMarket.coverage.possibleDays, 0);
  assert.equal(noMarket.coverage.ratio, null, 'unknown is null, never 0 or Infinity');
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

test('scoreAdvisorLog charges NO cost when the champion holds the same shares while prices move (regression)', () => {
  // A recorded weight is qty*price/equity, so it drifts every single day purely because
  // prices moved. Charging the weight delta as turnover billed a buy-and-hold champion
  // roughly half a percent a YEAR of costs it never paid — and that phantom figure was
  // both subtracted from the headline return and printed as "net of ~X% est. costs" beside
  // a GROSS NIFTY and a GROSS equal-weight universe. Only a share-count change is a trade.
  const N = 250;
  const px = (i) => +(100 * (1 + 0.35 * Math.sin(i / 11) + 0.0008 * i)).toFixed(2); // it moves a lot
  const QTY = 20;
  const log = [];
  const closes = [];
  for (let i = 0; i < N; i++) {
    const t = START + i * DAY;
    const price = px(i);
    const equity = QTY * price; // fully invested in one name, never traded
    closes.push({ t, c: price });
    log.push({ date: `d${i}`, t, eligible: true, equity, targets: [{ symbol: 'AAA', qty: QTY, price, weight: +((QTY * price) / equity).toFixed(6) }] });
  }
  const data = { AAA: closes, NIFTY: closes.map((p) => ({ t: p.t, c: 100 })) };
  const track = scoreAdvisorLog(log, { seriesFor: (s) => data[s] || [], universe: ['AAA'], costRates: { buyRate: 0.0017, sellRate: 0.0015 } });

  // The only cost that may be charged in 250 days is buying the book on day one.
  assert.ok(track.estCostPct <= 0.17 + 1e-9, `holding must not accrue turnover costs (got ${track.estCostPct}%)`);
  // ...and the net track must match the name's own gross move minus exactly that entry cost.
  const gross = (px(N - 1) / px(0) - 1) * 100;
  const expected = +(((1 - 0.0017) * (1 + gross / 100) - 1) * 100).toFixed(2);
  assert.ok(Math.abs(track.retPct - expected) < 0.02, `net return should be gross minus the entry cost only (got ${track.retPct}, expected ~${expected})`);

  // A REAL rebalance still pays. Rotating the whole book into a DIFFERENT name is a
  // genuine 100% turnover (unlike "hold twice as many shares of the one name you already
  // hold 100% in", which no account can actually do — weights are what the follower trades).
  data.BBB = closes.map((p) => ({ t: p.t, c: p.c }));
  const traded = log.map((e, i) => (i < N / 2 ? e : { ...e, targets: [{ ...e.targets[0], symbol: 'BBB' }] }));
  const tradedTrack = scoreAdvisorLog(traded, { seriesFor: (s) => data[s] || [], universe: ['AAA'], costRates: { buyRate: 0.0017, sellRate: 0.0015 } });
  assert.ok(tradedTrack.estCostPct > track.estCostPct + 0.2, `rotating the whole book into another name is charged (got ${tradedTrack.estCostPct}% vs ${track.estCostPct}%)`);
});

test('buildAdvisorPayload ships the freshest recorded MARK per symbol and the last entry that issued guidance', () => {
  // The client cannot price a name the champion dropped days ago from `today`/`prev`
  // alone, and it must not fall back to the assumed book's cost basis. `marks` carries
  // the freshest price the whole log ever recorded; `prevEligible` is the last entry
  // that actually said something, so a stand-aside day doesn't make held names look new.
  const T = (i) => START + i * DAY;
  const log = [
    { date: '2026-08-10', t: T(0), eligible: true, equity: 1000, targets: [{ symbol: 'A', qty: 5, price: 100, weight: 0.5 }, { symbol: 'B', qty: 2, price: 90, weight: 0.18 }] },
    { date: '2026-08-11', t: T(1), eligible: true, equity: 1000, targets: [{ symbol: 'A', qty: 5, price: 105, weight: 0.52 }, { symbol: 'B', qty: 2, price: 100, weight: 0.2 }] },
    { date: '2026-08-12', t: T(2), eligible: false, equity: 1000, reason: 'the champion is an options (F&O) bot', targets: [] },
    { date: '2026-08-13', t: T(3), eligible: true, equity: 1000, targets: [{ symbol: 'A', qty: 5, price: 110, weight: 0.55 }] }, // B dropped
  ];
  const p = buildAdvisorPayload({ log, seriesFor: () => [], universe: [] });

  assert.deepEqual(p.marks.B, { price: 100, date: '2026-08-11', t: T(1) }, 'B keeps its freshest recorded mark after being dropped');
  assert.deepEqual(p.marks.A, { price: 110, date: '2026-08-13', t: T(3) }, 'a still-held name marks at today');
  assert.equal(p.prev.date, '2026-08-12', 'prev is still the literal previous entry');
  assert.equal(p.prevEligible.date, '2026-08-11', 'prevEligible skips the stand-aside day');
  assert.equal(p.logDays, 4);
});

test('a CHAMPION SWITCH between bots of very different size is not read as a giant trade (regression)', () => {
  // The walk-forward switches champions, so two consecutive entries can belong to different
  // bots whose equities differ by 2x or more (live: quant-riskparity at ~Rs 107cr handing over
  // to xsmom-research at ~Rs 59cr). Measuring turnover in SHARES and dividing the previous
  // book's notional by the NEXT bot's equity reported "sells 157% of the account" for that
  // handover — impossible for a long-only book, and it overcharged the switch. Turnover is
  // measured between weight vectors now, so the size of the bot cancels out entirely.
  const T = (i) => START + i * DAY;
  const closes = (base) => [{ t: T(0), c: base }, { t: T(1), c: base }];
  const data = { AAA: closes(100), BBB: closes(50), NIFTY: closes(1000) };
  const rates = { buyRate: 0.0017, sellRate: 0.0015 };

  // Same 50/50 book, handed from a big bot to a bot a fifth its size. Nothing to trade.
  const sameBook = [
    { date: 'd0', t: T(0), eligible: true, equity: 1_000_000_000, targets: [{ symbol: 'AAA', qty: 5_000_000, price: 100, weight: 0.5 }, { symbol: 'BBB', qty: 10_000_000, price: 50, weight: 0.5 }] },
    { date: 'd1', t: T(1), eligible: true, equity: 200_000_000, targets: [{ symbol: 'AAA', qty: 1_000_000, price: 100, weight: 0.5 }, { symbol: 'BBB', qty: 2_000_000, price: 50, weight: 0.5 }] },
  ];
  const same = scoreAdvisorLog(sameBook, { seriesFor: (s) => data[s] || [], universe: [], costRates: rates });
  const entryCost = 0.17; // buying the first day's fully-invested book
  assert.ok(same.estCostPct <= entryCost + 1e-9, `an identical-weights handover trades nothing (got ${same.estCostPct}%)`);

  // A handover that DOES change the book pays a real, BOUNDED cost — never >2x the account.
  const rotated = [
    sameBook[0],
    { ...sameBook[1], targets: [{ symbol: 'AAA', qty: 2_000_000, price: 100, weight: 1 }] },
  ];
  const rot = scoreAdvisorLog(rotated, { seriesFor: (s) => data[s] || [], universe: [], costRates: rates });
  assert.ok(rot.estCostPct > same.estCostPct, 'a real reallocation across the handover is charged');
  assert.ok(rot.estCostPct < entryCost + 0.2 * 100, 'and the charge stays within a full round trip of the account');
});

test('the scored book is MARKED as shares held, never re-levered to its recorded weights (regression)', () => {
  // The return path used to be `r += p.weight * (c1/c0 - 1)`, which re-applies the recorded
  // weights at EVERY period — i.e. it silently rebalances the book back to target each bar,
  // for free. That was self-consistent while costs were also weight-based, but once turnover
  // moved to share counts the two halves of one calculation modelled opposite things: the cost
  // side said "nothing traded", the return side kept trading. This fixture is the classic
  // case: two names that whipsaw, so a daily-rebalanced book collects a free bonus that a
  // buy-and-hold book does not.
  const T = (i) => START + i * DAY;
  const mk = (t, pa, pb, eq) => ({
    date: `d${t}`, t: T(t), eligible: true, equity: eq,
    targets: [
      { symbol: 'AAA', qty: 50, price: pa, weight: +((50 * pa) / eq).toFixed(6) },
      { symbol: 'BBB', qty: 50, price: pb, weight: +((50 * pb) / eq).toFixed(6) },
    ],
  });
  // Shares NEVER change, so turnover is zero and only the entry cost applies.
  const log = [mk(0, 1.0, 1.0, 100), mk(1, 1.2, 0.8, 100), mk(2, 0.96, 0.96, 96)];
  const data = {
    AAA: [{ t: T(0), c: 1.0 }, { t: T(1), c: 1.2 }, { t: T(2), c: 0.96 }],
    BBB: [{ t: T(0), c: 1.0 }, { t: T(1), c: 0.8 }, { t: T(2), c: 0.96 }],
    NIFTY: [{ t: T(0), c: 100 }, { t: T(2), c: 100 }],
  };
  const track = scoreAdvisorLog(log, { seriesFor: (s) => data[s] || [], universe: [], costRates: { buyRate: 0, sellRate: 0 } });

  // Holding 50 of each: 100 -> (50x1.2 + 50x0.8) = 100 -> (50x0.96 + 50x0.96) = 96, i.e. -4%.
  // Re-applying the recorded weights each period would score 0.5x(+20%) + 0.5x(-20%) = 0 twice
  // over, i.e. 0.00% — a 4-point phantom gain from a rebalance nobody was ever told to make.
  assert.equal(track.retPct, -4, `a held book must score its real -4% (got ${track.retPct}%)`);
  assert.equal(track.estCostPct, 0, 'and unchanged share counts still trade nothing');
});

test('a stand-aside stretch compounds the HELD book, not a daily re-levering (regression)', () => {
  // WHERE THE TWO MODELS ACTUALLY DIVERGE. Within a chain of ELIGIBLE entries they are
  // algebraically identical: each entry re-records w = qty*price/equity at its own bar, so
  // sum(w * (c1/c0 - 1)) == v1/v0 - 1 exactly. The difference appears only when a book is
  // CARRIED across ineligible days — then the OLD entry's weights get re-applied at every
  // later bar, silently re-levering a book the panel explicitly said to leave alone
  // ("keep whatever you already hold"). Two names that diverge make it visible; one name at
  // weight 1 does not (re-levering a single full position is a no-op).
  const T = (i) => START + i * DAY;
  const log = [
    { date: 'd0', t: T(0), eligible: true, equity: 100, targets: [
      { symbol: 'AAA', qty: 50, price: 1.0, weight: 0.5 },
      { symbol: 'BBB', qty: 50, price: 1.0, weight: 0.5 },
    ] },
    { date: 'd1', t: T(1), eligible: false, equity: 100, targets: [] }, // champion went F&O
    { date: 'd2', t: T(2), eligible: false, equity: 100, targets: [] },
  ];
  const data = {
    AAA: [{ t: T(0), c: 1.0 }, { t: T(1), c: 1.2 }, { t: T(2), c: 1.44 }],
    BBB: [{ t: T(0), c: 1.0 }, { t: T(1), c: 0.8 }, { t: T(2), c: 0.64 }],
    NIFTY: [{ t: T(0), c: 1 }, { t: T(2), c: 1 }],
  };
  const track = scoreAdvisorLog(log, { seriesFor: (s) => data[s] || [], universe: [], costRates: { buyRate: 0, sellRate: 0 } });
  // Holding 50 of each: 100 -> (50x1.2 + 50x0.8) = 100 -> (50x1.44 + 50x0.64) = 104, i.e. +4%.
  // Re-applying the STALE 50/50 weights at each bar scores 0% twice over — a 4-point error,
  // and it grows with the length of the stand-aside stretch.
  assert.equal(track.retPct, 4, `a carried book must compound as held shares (got ${track.retPct}%)`);
  assert.equal(track.estCostPct, 0, 'and a carried book trades nothing at any point');
});
