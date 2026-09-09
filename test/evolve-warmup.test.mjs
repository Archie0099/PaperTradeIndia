// ---------------------------------------------------------------------------
// test/evolve-warmup.test.mjs
// Locks the GA's WARM-UP PREFIX — the fix inside runGeneration
// (tournament/tournament.mjs).
//
// WHAT THE FIX DOES, in one paragraph.
// Breeding scores its challengers on a bounded recent window (EVOLVE_WINDOW bars)
// so a generation takes seconds, not half a minute, on the free host. Scoring used
// to start at bar 0 of that window, which meant a strategy whose own indicator
// needs N bars (sma200, mom252, an ML lookback) sat in CASH for its first N SCORED
// bars — and was CHARGED for that flat stretch as if sitting out were a deliberate
// choice. The fix slices EVOLVE_WINDOW + EVOLVE_WARMUP bars and hands scoreSpec a
// `scoreFromT` timestamp: the spec TRADES through the warm-up prefix (so its
// indicators are alive at the first judged bar) but is only JUDGED on the last
// EVOLVE_WINDOW bars. A series too short to spare the prefix scores in full,
// exactly as before.
//
// WHY IT NEEDED A TEST.
// Every other fixture in this repo is a few hundred bars long — shorter than
// EVOLVE_WINDOW — so they all take the "too short, score in full" branch, and the
// fixed branch was never executed by a single test. The bug it fixed was not
// cosmetic: measured on the real universe, `xsmom-research` scored Sharpe -0.55
// cold and +0.76 warm, i.e. the GA's fitness SIGN inverted and breeding would have
// ranked one of the board's best specs WORST.
//
// HOW THESE TESTS AVOID "PROVING THE CODE EQUALS ITSELF".
// The un-fixed behaviour is still reachable, exactly, so we use it as the control:
// scoring the last EVOLVE_WINDOW bars with NO boundary IS the old code path. The two
// arms below judge the SAME EVOLVE_WINDOW bars, one the old way and one the new way,
// and they reach OPPOSITE conclusions about which bot on the board is weakest.
// Nothing here re-types 756 or 300 — the fixture is built FROM the exported
// EVOLVE_WINDOW / EVOLVE_WARMUP constants, so if either constant changes the test
// follows it, and if the warm-up were set back to 0 these tests fail.
//
// Pure + offline: one hand-made deterministic price series, no clock, no network.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTournament, EVOLVE_WINDOW, EVOLVE_WARMUP, CASH } from '../tournament/tournament.mjs';
import { scoreSpec, fitness, generateChallengers, mulberry32 } from '../tournament/evolve.mjs';
import { EQ_SYMBOLS, FNO_SYMBOLS, BASKET_UNIVERSE } from '../tournament/universe.mjs';

// --- the fixture ------------------------------------------------------------
// A deliberately shaped series, long enough that runGeneration takes its LONG branch.
// Every length comes from the exported constants, never from a re-typed number.
//
//   [ 0 .. SCORE_START )        the pre-scored run-up. Only its last EVOLVE_WARMUP bars
//                               are even loaded by runGeneration; they exist so a
//                               200-period average is ALIVE at the first judged bar.
//   [ SCORE_START .. +RALLY )   a strong rally, RALLY bars long.
//   [ ... to the end )          a slow grind down.
//
// RALLY is 200 bars — long enough that a bot needing a 200-bar average has not formed
// one yet when it is scored COLD, so the cold arm sleeps through the whole rally and
// then buys the top. Warm, the same bot is already long and captures it. That is the
// entire bug, reproduced in miniature on synthetic data.
const TAIL = 50; // spare bars, so the fixture is not sitting exactly on the branch edge
const RALLY = 200;
const N_LONG = EVOLVE_WINDOW + EVOLVE_WARMUP + TAIL;
const SCORE_START = N_LONG - EVOLVE_WINDOW; // index of the first bar runGeneration will JUDGE

function fixture() {
  const out = [];
  let p = 1000;
  for (let i = 0; i < N_LONG; i++) {
    // Three regimes, plus a fixed sine ripple so returns carry real (deterministic)
    // variance — a perfectly straight line has zero volatility and Sharpe blows up.
    const drift = i < SCORE_START ? 0.0012 // run-up: gets the slow average pointing up
      : i < SCORE_START + RALLY ? 0.0035 // the rally the cold arm sleeps through
        : -0.0006; // the grind down the cold arm buys into
    p *= 1 + drift + Math.sin(i / 9) * 0.0025;
    out.push({ t: 1_400_000_000_000 + i * 86_400_000, c: +p.toFixed(2) });
  }
  return out;
}

const LONG = fixture();
// The SHORT fixture is not a different market — it is the SAME BARS the long arm judges,
// with the warm-up prefix simply absent. At exactly EVOLVE_WINDOW bars the guard
// `refSeries.length > EVOLVE_WINDOW` is false, so scoreFromT stays null and the whole
// series is scored: the pre-fix behaviour, on identical data.
const SHORT = LONG.slice(-EVOLVE_WINDOW);

// The two bots. Neither is protected, so either one can be judged weakest and retired.
//  SLOW  — needs 200 bars before it can hold an opinion. The bot the old scorer punished.
//  HOLD  — owns the market from its first bar and needs no warm-up at all, so it scores
//          almost the same warm or cold. It is the CONTROL: if the reversal below came
//          from the extra data rather than from the warm-up cut, HOLD would move too.
const SLOW_SPEC = { kind: 'EQ', name: 'Slow trend', entry: ['>', ['sma', 20], ['sma', 200]], exit: ['<', ['sma', 20], ['sma', 200]] };
const HOLD_SPEC = { kind: 'EQ', name: 'Steady holder', weight: 1 };
const SEED = [
  { id: 'slow', name: 'Slow trend', kind: 'EQ', symbol: 'NIFTY', spec: SLOW_SPEC },
  { id: 'hold', name: 'Steady holder', kind: 'EQ', symbol: 'NIFTY', spec: HOLD_SPEC },
];

// The three scorers runGeneration could plausibly be running. Capital is the tournament's
// own exported CASH, so these reproduce the production scorer exactly (a re-typed ₹ figure
// would drift the last decimal and make the exact comparisons below meaningless).
//  cold()   — the PRE-FIX scorer: the last EVOLVE_WINDOW bars, judged from bar 0.
//  uncut()  — a HALF-fix: the longer slice is loaded but the metrics still start at bar 0.
//             This never shipped, but it is the obvious way a later "simplification" would
//             break the fix, and the code's own comment records that the longer slice ALONE
//             is not enough (the idle stretch just moves inside the scored window).
//  warm()   — the SHIPPED scorer: the prefix is traded through and judged from the boundary.
const SCORING_SLICE = LONG.slice(-(EVOLVE_WINDOW + EVOLVE_WARMUP));
const BOUNDARY = LONG[LONG.length - EVOLVE_WINDOW].t; // exactly how runGeneration derives it
const cold = (spec) => scoreSpec(spec, SHORT, 'NIFTY', CASH);
const uncut = (spec) => scoreSpec(spec, SCORING_SLICE, 'NIFTY', CASH);
const warm = (spec) => scoreSpec(spec, SCORING_SLICE, 'NIFTY', CASH, null, BOUNDARY);
// runGeneration reports its winner as `+fitness(score).toFixed(2)`; match that rounding so
// the membership checks below are exact rather than approximate.
const fit2 = (score) => +fitness(score).toFixed(2);

test('the warm-up cut is arithmetically what runGeneration slices (boundary sits EVOLVE_WARMUP bars in)', () => {
  // Cheap but load-bearing. runGeneration slices EVOLVE_WINDOW + EVOLVE_WARMUP bars in one
  // expression and derives the boundary from the FULL series in another
  // (`series[len - EVOLVE_WINDOW].t`). This pins that the two expressions name the same
  // bar — exactly EVOLVE_WARMUP bars traded-but-unjudged, exactly EVOLVE_WINDOW judged —
  // and that the short arm below really does hold the identical judged bars.
  assert.equal(SCORING_SLICE.length, EVOLVE_WINDOW + EVOLVE_WARMUP, 'the slice carries the window plus its prefix');
  assert.equal(SCORING_SLICE[EVOLVE_WARMUP].t, BOUNDARY, 'the boundary bar is the first bar AFTER the warm-up prefix');
  assert.equal(SCORING_SLICE.length - EVOLVE_WARMUP, EVOLVE_WINDOW, 'and exactly EVOLVE_WINDOW bars are judged');
  assert.equal(SHORT.length, EVOLVE_WINDOW, 'the short arm holds exactly the bars the long arm judges');
  assert.equal(SHORT[0].t, BOUNDARY, 'and starts on the same bar — the two arms judge identical data');
});

test('MEASURED: cold scoring and warm scoring disagree about which bot is weakest', () => {
  // The control experiment the two decision tests rest on. Identical judged bars in both
  // arms (asserted above); the ONLY difference is whether the warm-up bars were traded
  // through first.
  const slowCold = cold(SLOW_SPEC), slowWarm = warm(SLOW_SPEC);
  const holdCold = cold(HOLD_SPEC), holdWarm = warm(HOLD_SPEC);
  assert.ok(slowCold && slowWarm && holdCold && holdWarm, 'all four arms score');

  // (1) The warm-up cut flips the SIGN of the slow bot's fitness — the same inversion
  //     measured on the real universe with `xsmom-research`.
  assert.ok(fitness(slowCold) < 0, `cold, the slow bot looks like a loser (fit ${fitness(slowCold).toFixed(0)})`);
  assert.ok(fitness(slowWarm) > 0, `warm, the same bot over the same bars is a winner (fit ${fitness(slowWarm).toFixed(0)})`);

  // (2) The CONTROL barely moves. A bot that needs no warm-up scores the same either way,
  //     which is what rules out "the long arm simply had more/better data".
  assert.ok(Math.abs(fitness(holdWarm) - fitness(holdCold)) < 0.1 * Math.abs(fitness(holdCold)),
    `the no-warm-up control is materially unchanged (${fitness(holdCold).toFixed(0)} cold vs ${fitness(holdWarm).toFixed(0)} warm)`);

  // (3) Therefore the ORDER of the two bots reverses. That reversal is the observable the
  //     two runGeneration tests below read straight out of the production code path.
  assert.ok(fitness(slowCold) < fitness(holdCold), 'COLD (the un-fixed scorer): the slow bot is the weakest on the board');
  assert.ok(fitness(slowWarm) > fitness(holdWarm), 'WARM (the fixed scorer): the slow bot is the strongest and the holder is weakest');
});

// Run generations until the first retirement, and report what happened. retireWeakest:true
// is the legacy fixed-size path, and it is the only mode that NAMES the weakest bot in its
// result — which is exactly the signal we need to read the scorer's verdict from outside.
async function firstRetirement(backfill) {
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: backfill }, persist: false, retireWeakest: true });
  await t.init();
  for (let g = 1; g <= 12; g++) {
    const r = t.runGeneration({ seed: g * 101 });
    if (r.retired) return { ...r, gen: g };
  }
  return null;
}

test('LONG series: runGeneration judges only the post-warm-up bars (the fixed branch)', async () => {
  // The weakest bot on the board is both the quality bar a challenger must clear and the
  // bot the legacy path retires. With the warm-up cut in place the slow bot is the
  // STRONGEST, so the holder has to be the one retired. Against the pre-fix code the slow
  // bot's cold fitness is deeply negative and IT would be retired instead.
  //
  // VERIFIED, not assumed: patching runGeneration back to `slice(-EVOLVE_WINDOW)` with no
  // boundary makes this test report `actual: 'Slow trend (NIFTY)'`. Setting EVOLVE_WARMUP
  // to 0 fails it too. (It does NOT catch the half-fix — a longer slice with the cut
  // dropped still leaves the slow bot ahead here; that variant is caught by the exact
  // set-membership test at the bottom of this file.)
  const r = await firstRetirement(LONG);
  assert.ok(r, 'a challenger beat the weakest bot within 12 generations');
  assert.match(r.retired, /Steady holder/, 'the WARM verdict: the holder is weakest, the slow bot is not charged for warming up');
  assert.doesNotMatch(r.retired, /Slow trend/, 'the slow bot must NOT be retired — that is the un-fixed answer');
});

test('SHORT series: runGeneration scores in FULL, unchanged, when there is no prefix to spare', async () => {
  // The same bars the long arm judges, but the series is exactly EVOLVE_WINDOW long, so
  // `refSeries.length > EVOLVE_WINDOW` is false and scoreFromT stays null. Every existing
  // fixture in this repo lands on this branch, and it must keep giving the OLD answer —
  // which on this data is the opposite one. Two branches, two verdicts, one data set.
  const r = await firstRetirement(SHORT);
  assert.ok(r, 'a challenger beat the weakest bot within 12 generations');
  assert.match(r.retired, /Slow trend/, 'the COLD verdict: with no prefix to spare the slow bot is judged from a standing start');
  assert.doesNotMatch(r.retired, /Steady holder/, 'the holder is not the weakest when scoring runs in full');
});

test('the CHALLENGER side is scored through the very same cut window (one boundary, both arms)', async () => {
  // Scoring a challenger warm while scoring the bar it must clear cold (or the reverse) is
  // not a comparison — it is two different measurements pretending to be one. The INCUMBENT
  // side is pinned by the two tests above (the retired bot is the WARM verdict). This pins
  // the CHALLENGER side, inside the same generation, and pins it exactly.
  //
  // Breeding is a pure function of (roster, count, seed, symbol pools) — it never sees a
  // price — so we can rebuild the very challengers this generation bred, score each one
  // under all three candidate scorers, and then ask which set runGeneration's reported
  // `challengerFit` actually belongs to. It must be in the WARM set and in neither other.
  //
  // This is the assertion that survives the half-fix: forcing scoreFromT to null/0 while
  // keeping the longer slice still produces plausible, positive-looking numbers, and only
  // an exact set-membership check tells them apart from the real thing.
  const t = await createTournament({ seed: SEED, backfillData: { NIFTY: LONG }, persist: false, retireWeakest: true });
  await t.init();
  // Capture the parents BEFORE the generation runs: with retireWeakest the roster is
  // rewritten by a promotion, and breeding from the post-generation roster would rebuild a
  // different challenger list (this bit the author while writing the test).
  const parents = t._roster().map((b) => ({ id: b.id, name: b.name, kind: b.kind, symbol: b.symbol, spec: b.spec }));
  const gseed = 101;
  const r = t.runGeneration({ seed: gseed });
  assert.ok(r && Number.isFinite(r.challengerFit), 'the generation reports its winning challenger fitness');

  // Rebuild runGeneration's own inputs: the same PRNG seed, the same challenger count, and
  // the same symbol pools — taken from the real universe exports and filtered to the symbols
  // this fixture actually loaded, exactly as runGeneration filters them by fullData.
  const loaded = (syms) => syms.filter((s) => s === 'NIFTY');
  const N_CHALLENGERS = 16; // runGeneration's n
  const bred = generateChallengers(parents, N_CHALLENGERS, mulberry32(gseed >>> 0), {
    eqSymbols: loaded(EQ_SYMBOLS), fnoSymbols: loaded(FNO_SYMBOLS), basketSymbols: loaded(BASKET_UNIVERSE),
  });
  assert.ok(bred.length > 0, 'the challenger list rebuilt (an empty list would make the checks below vacuous)');
  const fitsUnder = (scorer) => new Set(bred.map((ch) => fit2(scorer(ch.spec))).filter(Number.isFinite));
  const warmFits = fitsUnder(warm), uncutFits = fitsUnder(uncut), coldFits = fitsUnder(cold);

  assert.ok(warmFits.has(r.challengerFit),
    `the reported challenger fitness ${r.challengerFit} is one the WARM scorer produces (warm set: ${[...warmFits].join(', ')})`);
  assert.ok(!coldFits.has(r.challengerFit),
    `and NOT one the pre-fix cold scorer could produce (cold set: ${[...coldFits].join(', ')})`);
  assert.ok(!uncutFits.has(r.challengerFit),
    `and NOT one the longer-slice-but-uncut half-fix could produce (uncut set: ${[...uncutFits].join(', ')})`);
});
