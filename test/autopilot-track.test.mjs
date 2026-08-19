// ---------------------------------------------------------------------------
// test/autopilot-track.test.mjs
// Locks the honest "Auto-Pilot vs the market" WALK-FORWARD backtest
// (computeAutopilotTrack): at each rebalance it follows the best-trailing-Sharpe bot
// using ONLY past data (no hindsight), chains its returns into a ₹1cr curve, and is
// benchmarked vs Buy & Hold. The critical property is NO LOOK-AHEAD.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeAutopilotTrack } from '../tournament/tournament.mjs';

const CASH = 10_000_000;
const N = 600;
const TIMES = Array.from({ length: N }, (_, i) => i * 864e5);

// Build three bot curves on a shared daily timeline. `corruptFrom` rewrites the FUTURE of
// the two followable bots (A, B) from that bar on — used to prove look-ahead-freedom.
function curves(corruptFrom = Infinity) {
  const A = { id: 'a', name: 'Smooth strong', kind: 'EQ', symbol: 'X', times: TIMES.slice(), eq: Array.from({ length: N }, (_, i) => CASH * Math.pow(1.0006, i)) }; // smooth -> best Sharpe
  const B = { id: 'b', name: 'Noisy', kind: 'BASKET', symbol: '8 stocks', times: TIMES.slice(), eq: Array.from({ length: N }, (_, i) => CASH * (1 + 0.0001 * i) * (1 + 0.02 * Math.sin(i / 7))) };
  const C = { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, times: TIMES.slice(), eq: Array.from({ length: N }, (_, i) => CASH * Math.pow(1.0002, i)) }; // gentle "market"
  if (Number.isFinite(corruptFrom)) {
    for (const bot of [A, B]) {
      const anchor = bot.eq[corruptFrom - 1];
      for (let i = corruptFrom; i < N; i++) bot.eq[i] = anchor * (1 + 0.05 * Math.sin(i)); // a totally different future path
    }
  }
  return [A, B, C];
}

test('Auto-Pilot walk-forward is LOOK-AHEAD-FREE: corrupting the FUTURE leaves the early curve identical', () => {
  const full = computeAutopilotTrack(curves(), CASH);
  const corrupted = computeAutopilotTrack(curves(450), CASH); // identical to `full` for bars 0..449, different after
  assert.ok(full && corrupted, 'both runs produce a track');
  const cutT = TIMES[449];
  const earlyFull = full.curve.filter((p) => p.t < cutT).map((p) => [p.t, p.c]);
  const earlyCorr = corrupted.curve.filter((p) => p.t < cutT).map((p) => [p.t, p.c]);
  assert.ok(earlyFull.length > 3, 'there are early points to compare');
  // The Auto-Pilot equity at any bar uses ONLY data up to that bar, so changing the future
  // cannot move a single early point.
  assert.deepEqual(earlyCorr, earlyFull, 'the early Auto-Pilot curve is unchanged by future data');
});

test('Auto-Pilot is look-ahead-free even with STAGGERED timelines (the forward-fill alignment path)', () => {
  // The test above shares one timeline; this one gives a bot a SPARSE timeline so the
  // forward-fill alignment is genuinely exercised — then corrupts the future and asserts the
  // early curve is unchanged (a subtle alignment edge case).
  const sparse = () => {
    const A = { id: 'a', name: 'Sparse', kind: 'EQ', symbol: 'X', times: [], eq: [] };
    for (let i = 0; i < N; i += 2) { A.times.push(i * 864e5); A.eq.push(CASH * Math.pow(1.0012, i / 2)); } // every other day
    const C = { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, times: TIMES.slice(), eq: Array.from({ length: N }, (_, i) => CASH * Math.pow(1.0002, i)) };
    return { A, C };
  };
  const build = (corruptFrom) => {
    const { A, C } = sparse();
    if (Number.isFinite(corruptFrom)) { const anchor = A.eq[corruptFrom - 1]; for (let i = corruptFrom; i < A.eq.length; i++) A.eq[i] = anchor * (1 + 0.07 * Math.sin(i)); }
    return [A, C];
  };
  const full = computeAutopilotTrack(build(Infinity), CASH);
  const corrupted = computeAutopilotTrack(build(200), CASH); // corrupt the sparse bot's later half
  assert.ok(full && corrupted, 'both runs produce a track');
  const cutT = TIMES[398]; // well before the sparse bot's corruption (sparse idx 200 -> day 400)
  const ef = full.curve.filter((p) => p.t < cutT).map((p) => [p.t, p.c]);
  const ec = corrupted.curve.filter((p) => p.t < cutT).map((p) => [p.t, p.c]);
  assert.ok(ef.length > 3, 'early points exist');
  assert.deepEqual(ec, ef, 'a staggered/forward-filled bot\'s future cannot move the early curve');
});

test('Auto-Pilot follows the best risk-adjusted bot and beats Buy & Hold when one clearly exists', () => {
  const ap = computeAutopilotTrack(curves(), CASH);
  assert.ok(ap && ap.metrics && ap.benchMetrics, 'produces Auto-Pilot + benchmark metrics');
  assert.ok(ap.currentBot && ap.currentBot.id, 'reports the bot it currently follows');
  assert.equal(ap.benchName, 'Buy & Hold', 'benchmarks against Buy & Hold');
  assert.ok(Number.isFinite(ap.vsMarketPct), 'computes a vs-market number');
  assert.ok(ap.metrics.finalEquity > CASH, 'the ₹1cr grew');
  assert.ok(ap.metrics.trackReturnPct > ap.benchMetrics.trackReturnPct, 'AP beats the gentle market when a smooth strong bot exists');
  assert.ok(ap.vsMarketPct > 0, 'vs-market is positive in that case');
  // Bot-style metric set is present (1D/1W/.../MAX like a normal bot).
  for (const k of ['liveReturnPct', 'r1w', 'r1m', 'r1y', 'trackReturnPct', 'sharpe', 'maxDrawdownPct']) {
    assert.ok(k in ap.metrics, `metrics include ${k}`);
  }
});

test('Auto-Pilot walk-forward is deterministic', () => {
  const a = computeAutopilotTrack(curves(), CASH);
  const b = computeAutopilotTrack(curves(), CASH);
  assert.deepEqual(a.curve, b.curve);
  assert.equal(a.metrics.trackReturnPct, b.metrics.trackReturnPct);
  assert.equal(a.vsMarketPct, b.vsMarketPct);
});

test('Auto-Pilot returns null with too little history (< ~1 year to score a Sharpe)', () => {
  const short = [{ id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, times: Array.from({ length: 100 }, (_, i) => i * 864e5), eq: Array.from({ length: 100 }, (_, i) => CASH * Math.pow(1.001, i)) }];
  assert.equal(computeAutopilotTrack(short, CASH), null, 'not enough history -> null (no fabricated track)');
});

test('a followed bot that BLOWS UP takes the track down with it (the loss is booked, not skipped)', () => {
  // Regression: the bar-return guard required `chosen.a[i] > 0`, so the exact bar on which
  // the followed bot's equity crossed to zero/negative was SKIPPED — the walk-forward kept
  // its pre-blow-up equity, the next quarterly re-pick resumed compounding from that frozen
  // figure, and the headline "beating the market / better risk" numbers never saw the
  // disaster (maxDrawdown read 0.00% through a total loss of capital).
  const KILL = 400;
  const seller = { id: 'seller', name: 'Premium seller', kind: 'FNO', symbol: 'NIFTY', times: TIMES.slice(), eq: Array.from({ length: N }, (_, i) => (i < KILL ? CASH * Math.pow(1.0006, i) : -2 * CASH)) };
  const bh = { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, times: TIMES.slice(), eq: Array.from({ length: N }, (_, i) => CASH * Math.pow(1.0002, i)) };
  const healthy = { id: 'safe', name: 'Steady', kind: 'BASKET', symbol: '8 stocks', times: TIMES.slice(), eq: Array.from({ length: N }, (_, i) => CASH * Math.pow(1.0003, i) * (1 + 0.03 * Math.sin(i / 5))) };

  const t = computeAutopilotTrack([seller, bh, healthy], CASH);
  assert.ok(t, 'a track is produced');
  // (the published curve is THINNED, so read the first point at or after the blow-up bar)
  const atKill = t.curve.find((p) => p.t >= TIMES[KILL]);
  assert.ok(atKill, 'the curve reaches the blow-up bar');
  assert.ok(atKill.c <= 0, `the blow-up is booked, not skipped (got ${atKill.c})`);
  // Once wiped there is nothing left to trade with — no later bot can revive the account.
  assert.ok(t.curve[t.curve.length - 1].c <= 0, 'a wiped track stays wiped for the rest of its life');
  assert.ok(t.metrics.maxDrawdownPct >= 100, `a total loss must show as a >=100% drawdown (got ${t.metrics.maxDrawdownPct})`);
  assert.ok(t.metrics.finalEquity <= 0, 'the final equity reflects the blow-up');
});
