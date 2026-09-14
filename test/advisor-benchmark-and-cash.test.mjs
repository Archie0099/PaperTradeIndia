// Two things the board was not saying out loud.
//
// (1) THE FAIR BAR IS A CONTROL, AND THE ADVISOR MUST NOT TURN IT INTO ADVICE.
//     `bar-universe-equal` holds the whole ~105-name universe at equal weight with no ranking
//     signal, no filter and no market timing. It is on the board as the yardstick every basket
//     must clear before "beats the index" means anything — its own note opens "Not a strategy".
//     It is deliberately STILL allowed to win the Auto-Pilot walk-forward, because a board that
//     cannot conclude "nothing here beats holding the whole universe blind" is flattering
//     itself. But that is a statement about the board, not a real-money instruction: mirroring
//     it by hand is ~105 delivery orders rebalanced monthly, each under 1% of the account.
//     Nothing previously stopped it — the advisor's four exclusions are F&O kind, PAIRS kind,
//     non-EQ legs and short quantities, and a long-only equity basket passes ALL FOUR.
//
// (2) A GATED BOT IS CHARGED THE HURDLE FOR STANDING ASIDE, AND THE BOARD HID IT.
//     Sharpe is excess of ~6.5%, charged on EVERY bar including bars spent flat in cash, on
//     which nothing credits interest. `summarize()` has computed `sharpeCashAdj`/`flatBarsPct`
//     since the fair bar was added, but the board’s own payload dropped both — so the leaderboard ranked
//     bots that sit in cash 22-34% of their life against an UNGATED fair bar (1.4%) with no
//     correction visible anywhere. Publishing them changes no ranked figure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTournament } from '../tournament/tournament.mjs';
import { buildAdvisorEntry } from '../tournament/advisor.mjs';

const DAY = 86_400_000;
const START = 1_500_000_000_000;

// A deterministic daily series — no RNG, no wall clock (a test must never read the clock
// for market-session logic, and a fixture that drifts is worse than no fixture).
function series(n = 400, start = START) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) { p *= 1 + (i % 7 === 0 ? 0.012 : -0.0018); out.push({ t: start + i * DAY, c: +p.toFixed(2) }); }
  return out;
}

// A champion whose book is PERFECTLY mirrorable: long-only, cash-market equity, finite prices.
// Every existing exclusion passes it. Only the `benchmark` flag can stop it.
const mkEntry = (detailOverrides = {}) => buildAdvisorEntry({
  autopilot: { currentBot: { id: 'x' } },
  getBotDetail: () => ({
    ok: true,
    id: 'x',
    name: 'X',
    kind: 'BASKET',
    mirror: {
      followable: true,
      equity: 1_000_000,
      positions: [
        { symbol: 'AAA', qty: 100, price: 500, kind: 'EQ' },
        { symbol: 'BBB', qty: 200, price: 250, kind: 'EQ' },
      ],
    },
    ...detailOverrides,
  }),
  seriesFor: (s) => (s === 'NIFTY' ? [{ t: START, c: 100 }] : []),
});

// --- (1) the advisor's fifth exclusion -----------------------------------------------------

test('the fair-bar CONTROL is excluded from real-money suggestions, with a stated reason', () => {
  const entry = mkEntry({ benchmark: true });
  assert.ok(entry, 'the day must still RECORD — a stand-aside is guidance too, and the trust clock counts it');
  assert.equal(entry.eligible, false, 'a control is not a strategy and must never become advice');
  assert.deepEqual(entry.targets, [], 'an ineligible day suggests nothing at all');
  assert.match(entry.reason, /fair-bar control/, 'the reason must name what was excluded, never scale it silently');
  assert.match(entry.reason, /yardstick/, 'and must say WHY, so the panel can explain itself');
});

test('the exclusion keys on the BENCHMARK FLAG, not on the shape of the book (control)', () => {
  // The identical book, minus the flag. If this came back ineligible the exclusion would be
  // firing on something incidental — the position count, the kind — rather than on identity.
  const entry = mkEntry({ benchmark: false });
  assert.equal(entry.eligible, true, 'an ordinary long-only equity basket is still perfectly mirrorable');
  assert.equal(entry.reason, null);
  assert.equal(entry.targets.length, 2, 'and still suggests its book');
});

test('a missing benchmark flag is treated as "not a control", never as undefined-ish truth', () => {
  // Nothing in the payload guarantees the key exists (an older persisted roster, a hand-built
  // detail in a test). Absent must mean "ordinary strategy", or a redeploy could silently mute
  // the advisor for every bot at once.
  const entry = mkEntry();
  assert.equal(entry.eligible, true);
  assert.equal(entry.targets.length, 2);
});

test('the control check runs BEFORE the instrument checks, so the reason names the real cause', () => {
  // Ordering lock. If a control ever held something unmirrorable too, the honest reason is
  // still "this is the yardstick" — that is a fact about the row, while a short leg is a fact
  // about today. Reporting the transient one would imply the bot becomes followable tomorrow.
  const entry = mkEntry({
    benchmark: true,
    kind: 'PAIRS',
    mirror: { followable: true, equity: 1_000_000, positions: [{ symbol: 'AAA', qty: -100, price: 500, kind: 'EQ' }] },
  });
  assert.equal(entry.eligible, false);
  assert.match(entry.reason, /fair-bar control/, 'identity beats instrument: the row IS a control regardless of today’s book');
});

// --- (2) the idle-cash gap, published ------------------------------------------------------

const CASH_SEED = [{
  id: 'gated',
  name: 'Gated single name',
  kind: 'EQ',
  symbol: 'NIFTY',
  // A marketGate that is shut for long stretches parks the bot in cash, which is exactly the
  // case the published figures exist to expose.
  spec: { kind: 'EQ', name: 'Gated', weight: 1, entry: ['>', ['price'], ['sma', 50]], exit: ['<', ['price'], ['sma', 50]] },
}];

test('a board row publishes sharpeCashAdj and flatBarsPct beside the ranked Sharpe', async () => {
  const t = await createTournament({ seed: CASH_SEED, backfillData: { NIFTY: series() }, persist: false, evolutionEnabled: false });
  await t.init();
  const row = t.getStandings().bots.find((b) => b.id === 'gated');
  assert.ok(row, 'the bot is on the board');
  assert.equal(typeof row.sharpe, 'number', 'the RANKED figure is unchanged and still present');
  assert.equal(typeof row.sharpeCashAdj, 'number', 'the cash-credited figure must reach the client — summarize has always computed it, the row used to drop it');
  assert.equal(typeof row.flatBarsPct, 'number', 'and the size of the assumption behind it');
  assert.ok(row.flatBarsPct >= 0 && row.flatBarsPct <= 100, `flatBarsPct is a percentage (got ${row.flatBarsPct})`);
  // Crediting interest on idle cash can only ever ADD return, so the adjusted figure can never
  // sit below the headline. (Equal is correct for a bot that is never flat.)
  assert.ok(row.sharpeCashAdj >= row.sharpe, `crediting idle cash cannot lower the score (${row.sharpeCashAdj} vs ${row.sharpe})`);
});

test('getBotDetail carries the same two figures, plus the benchmark flag', async () => {
  const t = await createTournament({ seed: CASH_SEED, backfillData: { NIFTY: series() }, persist: false, evolutionEnabled: false });
  await t.init();
  const d = t.getBotDetail('gated');
  assert.equal(d.ok, true);
  assert.equal(typeof d.metrics.sharpeCashAdj, 'number', 'the per-bot page is where there is room to show the gap');
  assert.equal(typeof d.metrics.flatBarsPct, 'number');
  assert.equal(d.benchmark, false, 'an ordinary bot is not a control — and the flag must be a real boolean, not undefined');
});

test('the benchmark flag survives the seed -> roster -> detail path', async () => {
  // The advisor reads this off getBotDetail, so a flag that is set in seed.mjs but lost in the
  // roster normaliser would re-open the hole silently and no other test would notice.
  const t = await createTournament({
    seed: [{ ...CASH_SEED[0], id: 'ctrl', benchmark: true }],
    backfillData: { NIFTY: series() },
    persist: false,
    evolutionEnabled: false,
  });
  await t.init();
  assert.equal(t.getBotDetail('ctrl').benchmark, true, 'the control flag must reach the advisor intact');
});

// --- (3) a CONTROL must survive evolution, and must not breed --------------------------------
// Both paths below are DORMANT in production (breeding is off, and grow mode never retires), so
// these lock intent rather than today's behaviour. That is exactly why they are worth having:
// re-enabling breeding is an open decision, and it is the moment nobody would think to re-check
// what happens to the row every other comparison on the board is measured against.

import { EVOLVE_WINDOW, EVOLVE_WARMUP } from '../tournament/tournament.mjs';

// Long enough that runGeneration takes its real branch and can actually score bots.
function longSeries() {
  const n = EVOLVE_WINDOW + EVOLVE_WARMUP + 200;
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) { p *= 1 + Math.sin(i / 23) * 0.004 + 0.0002; out.push({ t: START + i * DAY, c: +p.toFixed(2) }); }
  return out;
}

// A roster with a protected benchmark, a CONTROL, and two ordinary strategies. The control is
// given a deliberately feeble spec so it sorts to the BOTTOM on fitness — i.e. it is exactly the
// bot the legacy replace-the-weakest path would reach for first.
const evoSeedWithControl = () => [
  { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
  { id: 'ctrl', name: 'The fair bar', kind: 'EQ', symbol: 'NIFTY', benchmark: true, spec: { kind: 'EQ', name: 'Control', entry: ['<', ['rsi', 2], 1], exit: ['>', ['rsi', 2], 99] } },
  { id: 'sma', name: 'SMA cross', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'SMA cross', entry: ['>', ['sma', 20], ['sma', 100]], exit: ['<', ['sma', 20], ['sma', 100]] } },
  { id: 'rsi', name: 'RSI dip', kind: 'EQ', symbol: 'NIFTY', spec: { kind: 'EQ', name: 'RSI dip', entry: ['<', ['rsi', 14], 30], exit: ['>', ['rsi', 14], 60] } },
];

test('the CONTROL is never retired, even in legacy replace-the-weakest mode', async () => {
  const t = await createTournament({ seed: evoSeedWithControl(), backfillData: { NIFTY: longSeries() }, persist: false, retireWeakest: true });
  await t.init();
  for (let g = 1; g <= 8; g++) {
    t.runGeneration({ seed: g * 101 });
    assert.ok(t._roster().some((b) => b.id === 'ctrl'), `generation ${g} retired the board’s own yardstick`);
    assert.ok(t._roster().some((b) => b.id === 'bh'), `generation ${g} retired the protected benchmark`);
  }
});

test('the CONTROL is never used as breeding stock', async () => {
  // A mutated no-information control is not a control, and "hold everything, but tweaked" is not
  // a hypothesis anyone meant to test. Checked structurally: whatever the GA promotes, it must
  // never be descended from the control's spec.
  const t = await createTournament({ seed: evoSeedWithControl(), backfillData: { NIFTY: longSeries() }, persist: false, maxRosterBots: 50 });
  await t.init();
  const ctrlSpec = JSON.stringify(t._roster().find((b) => b.id === 'ctrl').spec.entry);
  for (let g = 1; g <= 8; g++) {
    t.runGeneration({ seed: g * 101 });
    for (const b of t._roster()) {
      if (b.id === 'ctrl' || b.gen === 0) continue;
      assert.notEqual(JSON.stringify(b.spec.entry), ctrlSpec, `generation ${g} bred a child straight off the control`);
    }
  }
});

// --- (4) the two edge cases a fresh-context review found in (3) -------------------------------
// Excluding benchmarks from breeding and culling created a roster state that was previously
// UNREACHABLE: one where every eligible row is protected or a benchmark. Both of these were
// reproduced before being fixed — 4 of 8 challengers descended from the control, and the stall
// was permanent and reported the wrong cause.

// Nothing left to breed from or score against: only a protected row and a control.
const barrenSeed = () => [
  { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
  { id: 'ctrl', name: 'The fair bar', kind: 'EQ', symbol: 'NIFTY', benchmark: true, spec: { kind: 'EQ', name: 'The fair bar', entry: ['<', ['rsi', 2], 1], exit: ['>', ['rsi', 2], 99] } },
];

test('with no ordinary strategy left, evolution declines with a STATED reason (never a silent stall)', async () => {
  // Before the guard, `weakest` was simply undefined and the promote branch never fired: no
  // promotion, generation frozen, and the UI toast said "no challenger beat the field" — the
  // wrong cause, because there was no field. Silence that names the wrong reason is worse than
  // an error.
  const t = await createTournament({ seed: barrenSeed(), backfillData: { NIFTY: longSeries() }, persist: false, maxRosterBots: 50 });
  await t.init();
  const r = t.runGeneration({ seed: 101 });
  assert.equal(r.promoted, null, 'nothing may be admitted when there is no quality bar to clear');
  assert.ok(r.reason, 'the refusal must be diagnosable — a bare null is indistinguishable from "nobody won"');
  assert.match(r.reason, /quality bar|breedable/, `the reason must name the structural cause (got: ${r.reason})`);
});

test('the control is not breeding stock even when it is the ONLY thing left to breed from', async () => {
  // The exclusion was defeated by a pre-existing fallback: with no breedable bot, `parents` fell
  // back to EVERY compilable bot, controls included. Measured at the time: 4 of 8 challengers
  // came back named after the control.
  //
  // ★ THE FIXTURE MATTERS, and the obvious one is VACUOUS. On a roster of just {protected,
  // control} the stall guard fires first — nothing is ever promoted — so this passes with or
  // without the fallback fix and locks nothing. To isolate the fallback we need `breedable`
  // EMPTY while `scored` is NOT, and those two arrays differ in exactly one way: `breedable`
  // additionally requires `safeCompile`. So add a bot with a MALFORMED spec (an FNO with no
  // legs — a shape only external corruption of the state file produces). It is invisible to
  // `compilable`, so nothing is breedable; it IS in `scored`, where it scores -Infinity and
  // becomes the quality bar. Promotion therefore proceeds, and the only question left is WHO
  // the parent was.
  //
  // ★ AND THE CONTROL'S SPEC MUST BE GOOD. The cull test above gives it a deliberately feeble
  // spec so it sorts weakest; reusing that here made this test VACUOUS for a second reason —
  // a flat bot's descendants score badly, never win `challengers.find(...)`, and so never reach
  // the board even with the guard removed. That is a property of the fixture, not of the code.
  // The real `bar-universe-equal` is a TOP-5 performer, so a competent spec is also the honest
  // one: give it a strategy whose mutations can actually out-score the protected row's.
  const seed = [
    { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
    { id: 'ctrl', name: 'The fair bar', kind: 'EQ', symbol: 'NIFTY', benchmark: true, spec: { kind: 'EQ', name: 'The fair bar', entry: ['>', ['sma', 20], ['sma', 100]], exit: ['<', ['sma', 20], ['sma', 100]] } },
    { id: 'broken', name: 'Broken', kind: 'FNO', symbol: 'NIFTY', spec: { kind: 'FNO', name: 'broken' } }, // malformed: no legs
  ];
  const t = await createTournament({ seed, backfillData: { NIFTY: longSeries() }, persist: false, maxRosterBots: 50 });
  await t.init();
  let promotions = 0;
  for (let g = 1; g <= 6; g++) if (t.runGeneration({ seed: g * 101 }).promoted) promotions++;
  assert.ok(promotions > 0, 'the fixture must actually REACH the promote branch, or it proves nothing');
  for (const b of t._roster()) {
    if (b.id === 'ctrl') continue;
    assert.doesNotMatch(b.name, /fair bar/i, `a challenger bred off the control reached the board: ${b.name}`);
  }
});

// --- (5) the leaderboard ROW must carry the flag too -----------------------------------------
// getBotDetail already carried it (the advisor reads it there), but the board row did not, so
// the leaderboard had no way to mark the control and it read as an ordinary competitor.

test('the leaderboard row carries the benchmark flag, and ordinary rows carry false', async () => {
  const t = await createTournament({
    seed: [
      { ...CASH_SEED[0] },
      { id: 'ctrl', name: 'The fair bar', kind: 'EQ', symbol: 'NIFTY', benchmark: true, spec: { kind: 'EQ', name: 'The fair bar', weight: 1 } },
    ],
    backfillData: { NIFTY: series() },
    persist: false,
    evolutionEnabled: false,
  });
  await t.init();
  const bots = t.getStandings().bots;
  const ctrl = bots.find((b) => b.id === 'ctrl');
  const ordinary = bots.find((b) => b.id === 'gated');
  assert.equal(ctrl.benchmark, true, 'the control must be identifiable from the board payload alone');
  assert.equal(ordinary.benchmark, false, 'and an ordinary strategy must be a real false, not undefined');
});

// --- (6) the destructive route is no longer a drive-by ---------------------------------------
// `/api/tournament/reset` restarts `deployedAt` AND clears the live advisor log. The log is
// archived, but the 90-day "track record before trust" CLOCK restarts, and that cannot be
// recomputed from data — only waited out, at roughly one trading day per trading day, with
// missed days never back-filled. So an anonymous POST to a public URL could throw away the one
// artifact in this project that only time can produce. The guard asks the caller to echo the
// current `deployedAt`, which it can only know by reading the board first.

import { createServer } from 'node:http';

// Minimal stand-in for the Express route's guard, exercised against a REAL tournament so the
// value being echoed is the real `getStandings().deployedAt` rather than a hand-made number.
const resetGuard = (t, confirm) => {
  const standings = t.getStandings();
  const expected = standings && standings.deployedAt;
  if (!expected || String(expected) !== String(confirm ?? '')) return { ok: false, status: 400 };
  return { ok: true, ...t.reset() };
};

test('a reset without the current deployedAt is refused', async () => {
  const t = await createTournament({ seed: CASH_SEED, backfillData: { NIFTY: series() }, persist: false, evolutionEnabled: false });
  await t.init();
  const before = t.getStandings().deployedAt;
  assert.equal(resetGuard(t, undefined).ok, false, 'a blind POST must not reset');
  assert.equal(resetGuard(t, '').ok, false, 'nor an empty confirm');
  assert.equal(resetGuard(t, 'true').ok, false, 'nor a guessed value');
  assert.equal(resetGuard(t, before + 1).ok, false, 'nor a near-miss');
  assert.equal(t.getStandings().deployedAt, before, 'the forward clock is untouched by every refused attempt');
});

test('a reset WITH the current deployedAt succeeds, and the echoed value then changes', async () => {
  const t = await createTournament({ seed: CASH_SEED, backfillData: { NIFTY: series() }, persist: false, evolutionEnabled: false });
  await t.init();
  const before = t.getStandings().deployedAt;
  assert.equal(resetGuard(t, before).ok, true, 'the control panel, which has read the board, can still reset');
  // Replay protection falls out of the design: the value the caller just used is now stale.
  assert.equal(resetGuard(t, before).ok, false, 'the same confirm cannot be replayed against the new run');
});

// --- (7) a spec must not be able to name a market proxy that is silently ignored --------------

test('a basket naming its own marketSymbol is REJECTED, not quietly evaluated against NIFTY', async () => {
  const { validateSpec } = await import('../backtest/dsl.mjs');
  const base = {
    kind: 'BASKET', name: 'gated', universe: ['AAA', 'BBB', 'CCC'], rank: ['mom', 252, 21], k: 2,
    marketGate: ['>', ['price'], ['sma', 100]], rebalanceBars: 21,
  };
  assert.equal(validateSpec(base), null, 'the same spec without marketSymbol is valid');
  const err = validateSpec({ ...base, marketSymbol: 'INDIAVIX' });
  assert.ok(err, 'naming a proxy that does not exist must be an ERROR, never a silent no-op');
  assert.match(err, /marketSymbol/, 'and the error must name the offending field');
  assert.match(err, /NIFTY/, 'and say what would actually have happened');
});
