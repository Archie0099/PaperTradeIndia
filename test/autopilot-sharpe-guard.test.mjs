// The Auto-Pilot walk-forward's point-in-time Sharpe (`sharpeUpTo`) and its DEGENERATE-CURVE
// rule.
//
// What this locks, and why it is not cosmetic: returns there are EXCESS of the risk-free rate,
// so a curve that never moves is a bot idling in cash against a 6.5% hurdle. That is the worst
// thing that can be on the board, not a "0 Sharpe", and it must never be crowned.
//
// The old guard was `sd > 0`. It reached the right answer for the wrong reason — summation
// rounding leaves sd at ~1e-18 instead of 0, so it returned about -1.4e15, which loses the
// argmax. But at EXACTLY 20 or 21 returns the arithmetic is exact, sd is truly 0, and the old
// code returned **0**, which outranks every genuinely underwater bot. Test 2 pins that case.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharpeUpTo, computeAutopilotTrack, CASH } from '../tournament/tournament.mjs';
import { RF_ANNUAL } from '../backtest/metrics.mjs';

// A curve that never moves: `n+1` bars all at the same equity, so there are `n` returns.
const flatCurve = (n, value = 1e7) => new Array(n + 1).fill(value);

test('a never-moving curve is unpickable, not zero — at the exact-arithmetic lengths too', () => {
  // 20 and 21 returns are the two lengths where the variance sums EXACTLY to 0, so the old
  // `sd > 0` guard fell through to its `: 0` branch. 0 would beat any losing-but-trading bot.
  for (const n of [20, 21]) {
    const s = sharpeUpTo(flatCurve(n), n);
    assert.equal(s, -Infinity, `a flat curve with exactly ${n} returns must be unpickable, got ${s}`);
    assert.ok(s < -1, `${n} returns: must not score 0 or better (got ${s})`);
  }
});

test('a never-moving curve is unpickable at ordinary lengths as well', () => {
  // Here the old guard returned a huge NEGATIVE number (~-1.4e15) rather than 0. That also
  // lost the argmax, so the fix changes no pick — but the value was an artifact of rounding,
  // and this asserts the intended value instead.
  for (const n of [100, 252, 800]) {
    assert.equal(sharpeUpTo(flatCurve(n), n), -Infinity, `flat curve with ${n} returns`);
  }
});

test('a smooth RISING curve is the best thing on the board, not the worst', () => {
  // The other half of the zero-dispersion case, and the one that is easy to get backwards.
  // A perfectly smooth compounding curve also has sd == 0, but its mean excess return is
  // POSITIVE — a riskless gain above the hurdle. It must rank at the top. Collapsing every
  // zero-dispersion curve to -Infinity would stop the walk-forward following an obviously
  // good bot (it broke two existing autopilot-track tests before this branch was split out).
  const n = 400;
  const smoothUp = Array.from({ length: n + 1 }, (_, i) => 1e7 * Math.pow(1.0006, i));
  assert.equal(sharpeUpTo(smoothUp, n), Infinity, 'a riskless gain above the hurdle ranks best');

  // And a smooth curve that grows SLOWER than the risk-free rate is still a loser.
  const smoothBelowHurdle = Array.from({ length: n + 1 }, (_, i) => 1e7 * Math.pow(1 + RF_ANNUAL / 252 / 2, i));
  assert.equal(sharpeUpTo(smoothBelowHurdle, n), -Infinity, 'riskless but below the hurdle ranks worst');
});

test('a genuinely varying curve is scored normally — the guard must not over-clamp', () => {
  // A real curve drifting up ~0.05%/bar: finite, positive, and nowhere near the guard.
  const a = [1e7];
  for (let i = 0; i < 300; i++) a.push(a[a.length - 1] * (1 + (i % 7 === 0 ? -0.002 : 0.0008)));
  const s = sharpeUpTo(a, a.length - 1);
  assert.ok(Number.isFinite(s), `a varying curve must score finitely, got ${s}`);
  assert.ok(s > 0, `this curve beats the ${RF_ANNUAL} hurdle, so it should score > 0 (got ${s})`);
});

test('a low-but-real variance curve is still scored, not treated as degenerate', () => {
  // Guards against the relative epsilon being too aggressive: a curve with tiny but GENUINE
  // dispersion must keep its (negative) score rather than collapse to -Infinity.
  const a = [1e7];
  for (let i = 0; i < 300; i++) a.push(a[a.length - 1] * (1 + (i % 2 ? 1e-6 : -1e-6)));
  const s = sharpeUpTo(a, a.length - 1);
  assert.ok(Number.isFinite(s), `low-variance curve must still be scored, got ${s}`);
});

test('an idle bot never takes the walk-forward pick, even when every rival is underwater', () => {
  // End-to-end: one bot sits in cash forever, the others genuinely lose money. The idle bot
  // must not be crowned. (This passes against the old code too — -1.4e15 also loses — so it
  // is a guard-rail on the BEHAVIOUR, while the unit tests above pin the VALUE.)
  const n = 1400;
  const times = Array.from({ length: n }, (_, i) => Date.UTC(2020, 0, 1) + i * 86400000);
  // Genuinely losing bots need genuine DISPERSION — a curve declining at a perfectly constant
  // rate is itself degenerate (zero variance) and is now unpickable too, which would leave the
  // walk-forward with nothing to follow. That is the honest outcome for a board where nothing
  // ever moves, but it is not the case under test here.
  const losing = (rate, seed) => {
    const eq = [1e7];
    let r = seed;
    for (let i = 1; i < n; i++) {
      r = (r * 1103515245 + 12345) % 2147483648; // deterministic LCG — no test may be flaky
      const noise = (r / 2147483648 - 0.5) * 0.02;
      eq.push(eq[i - 1] * (1 - rate + noise));
    }
    return eq;
  };
  const curves = [
    { id: 'bench', name: 'Buy & Hold', kind: 'EQ', protected: true, eq: losing(0.0004, 7), times },
    { id: 'loser', name: 'Loser', kind: 'EQ', eq: losing(0.0006, 99), times },
    { id: 'idle', name: 'Idle', kind: 'EQ', eq: new Array(n).fill(1e7), times },
  ];
  const ap = computeAutopilotTrack(curves, CASH, null);
  assert.ok(ap, 'the walk-forward should produce a track');
  const followed = (ap.followedTimeline || []).map((f) => f.id);
  assert.ok(followed.length > 0, 'something must be followed');
  assert.ok(!followed.includes('idle'), `an idle bot must never be crowned, timeline was ${followed.join(' -> ')}`);
});
