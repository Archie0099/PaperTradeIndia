// The IDLE-CASH gap that `summarize` now reports: `sharpeCashAdj` and `flatBarsPct`.
//
// Why this is not cosmetic. The headline Sharpe is EXCESS of rf, and `sharpe()` subtracts the
// per-bar hurdle from EVERY bar — including bars the account spends flat in cash. Nothing in
// the engine credits interest on that cash (engine.js's `riskFreeRate` is used by the option
// tools only). So a strategy that deliberately steps aside in bad regimes is charged the
// hurdle twice, and the size of the penalty scales with how long it stands aside: the
// regime-gated baskets sit 21.7-34.0% of their life in cash and read 0.056-0.090 low.
//
// These tests lock the REPORTING of that gap, not a change to the money model. Crediting
// interest inside the engine would break the MASTER invariant (realised + unrealised − fees ==
// equity − initialCash), which interest income satisfies none of — so it is deliberately not
// done there, and these fields must stay estimates that sit BESIDE the headline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, sharpe, RF_ANNUAL, TRADING_DAYS } from '../backtest/metrics.mjs';

// A curve that compounds at a steady rate every bar — never flat, so never "in cash".
const steady = (n, perBar, start = 1e7) => {
  const out = [start];
  for (let i = 0; i < n; i++) out.push(out[out.length - 1] * (1 + perBar));
  return out;
};

test('a never-idle curve is reported unchanged — the adjustment must not invent return', () => {
  const curve = steady(500, 0.0004);
  const m = summarize(curve, { years: 2 });
  assert.equal(m.flatBarsPct, 0, 'a strictly rising curve spends no bar in cash');
  assert.equal(m.sharpeCashAdj, m.sharpe, 'with nothing idle there is no interest to credit, so the two must agree exactly');
});

test('idle bars are counted, and crediting them raises the score', () => {
  // 300 bars of steady compounding, then 200 bars flat in cash, then 300 more.
  const a = steady(300, 0.0004);
  const flat = new Array(200).fill(a[a.length - 1]);
  const b = steady(300, 0.0004, a[a.length - 1]).slice(1);
  const curve = [...a, ...flat, ...b];

  const m = summarize(curve, { years: 3 });
  const bars = curve.length - 1;
  assert.equal(m.flatBarsPct, +((200 / bars) * 100).toFixed(2), 'flatBarsPct must count exactly the unchanged bars');
  assert.ok(m.sharpeCashAdj > m.sharpe, `crediting idle cash must raise the score (got ${m.sharpeCashAdj} vs ${m.sharpe})`);
});

// ★ This test documents a real ASYMMETRY between two functions that answer the same question,
// found while writing it (the first draft asserted a negative score here and failed).
//
//   metrics.mjs  `sharpe()`      -> 0 for a zero-dispersion curve
//   tournament.mjs `sharpeUpTo()` -> the SIGNED limit, so -Infinity for a flat losing curve
//
// Both are deliberate and both are documented in place. `sharpeUpTo` was given its sign in
// given its sign precisely because the walk-forward takes an ARGMAX over it, where scoring an idle
// bot at 0 would rank it above a merely-underwater one. `sharpe()` kept the flat 0 because it
// is a REPORTED figure, and returning -Infinity in a leaderboard cell helps nobody.
//
// The consequence worth knowing: a fully-idle account reports xSharpe 0.00 here, NOT a
// negative number, even though it lost the entire hurdle. That is a reporting convention, and
// changing it would restate published figures — a decision left open deliberately, like the
// rebalance anchor. This test pins the convention so nobody "fixes" one function to match the
// other by accident.
test('a fully idle account reports 0 by convention, and is the one case the estimate cannot rescue', () => {
  // All cash, all run: equity never moves. Charged rf on every bar, earns nothing.
  const curve = new Array(501).fill(1e7);
  const m = summarize(curve, { years: 2 });

  assert.equal(m.flatBarsPct, 100, 'every bar is a cash bar');
  assert.equal(m.sharpe, 0, 'the documented zero-dispersion convention: a degenerate curve reports 0, not a negative');

  // Crediting rf makes the excess return exactly zero on every bar — zero mean AND zero
  // dispersion — so the same guard returns 0 again. Both figures agree at 0, which means this
  // is precisely the case where `sharpeCashAdj` CANNOT display the gap it exists to show.
  // `flatBarsPct` at 100 is the only thing that reveals it, which is why it is published.
  assert.equal(m.sharpeCashAdj, 0, 'crediting rf on a fully idle account cancels the hurdle exactly');
  assert.equal(m.sharpeCashAdj, m.sharpe, 'so the estimate is silent here — flatBarsPct is what tells the story');
});

test('the adjustment uses the NAMED rate, not a re-typed literal, and does not mutate its input', () => {
  const a = steady(200, 0.0004);
  const curve = [...a, ...new Array(100).fill(a[a.length - 1])];
  const before = [...curve];

  const m = summarize(curve, { years: 1 });
  assert.deepEqual(curve, before, 'summarize must not mutate the caller\'s equity curve');

  // Re-derive the expected figure from the EXPORTED constant. A test that re-typed 0.065
  // would only prove the code equals itself (the lesson from the option-exchange-rate bug).
  const perBar = RF_ANNUAL / TRADING_DAYS;
  let credit = 1;
  const repaired = [curve[0]];
  for (let i = 1; i < curve.length; i++) {
    if (curve[i] === curve[i - 1]) credit *= (1 + perBar);
    repaired.push(curve[i] * credit);
  }
  assert.equal(m.sharpeCashAdj, +sharpe(repaired).toFixed(2), 'sharpeCashAdj must equal the curve re-scored with rf credited on idle bars');
});

test('the headline stays the headline — the estimate is additive, never a replacement', () => {
  const a = steady(200, 0.0004);
  const curve = [...a, ...new Array(150).fill(a[a.length - 1])];
  const m = summarize(curve, { years: 1 });

  // The three Sharpe conventions must all be present and distinct in purpose: the headline
  // (rf charged, cash earns nothing), the rf=0 figure, and this estimate.
  for (const k of ['sharpe', 'sharpeRf0', 'sharpeCashAdj', 'flatBarsPct']) {
    assert.ok(Object.prototype.hasOwnProperty.call(m, k), `summarize must publish ${k}`);
    assert.ok(Number.isFinite(m[k]), `${k} must be finite, got ${m[k]}`);
  }
  assert.equal(m.sharpe, +sharpe(curve).toFixed(2), 'the headline Sharpe must be untouched by the new fields');
});
