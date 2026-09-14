// ---------------------------------------------------------------------------
// test/post-proxy-sharpe.test.mjs
// Locks `postProxyScore` — the board's measurement of its own gate-proxy artifact.
//
// A basket's timeline is the UNION of its universe's timestamps and the market series', and most
// of the universe lists well before NIFTY does. Over that opening stretch a GATED basket has no
// proxy to evaluate its gate against, so it reads risk-off, holds nothing, and is still charged
// the ~6.5% hurdle on every bar. The board publishes what that costs — it does not correct it.
//
// What must hold:
//   * a bot with NO dead stretch reports nothing (null), never a duplicate of its own Sharpe,
//   * a bot WITH one reports the count and a Sharpe scored only from the proxy's first bar,
//   * the boundary is inclusive of the proxy's own first bar (off-by-one here would silently
//     drop or keep one bar of a ~300-bar stretch),
//   * a stretch that leaves too little curve behind reports the COUNT but no Sharpe, rather than
//     a number computed from a handful of bars,
//   * malformed input degrades to nulls instead of throwing into a standings pass.
// Pure + offline.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { postProxyScore } from '../tournament/tournament.mjs';
import { sharpe as sharpeOfCurve } from '../backtest/metrics.mjs';

const DAY = 864e5;
// A deterministic curve: flat for `dead` bars (what a gated basket does with no proxy), then a
// noisy drift. The flat head is the artifact; the tail is the only part with information in it.
function curve(dead, live, seed = 7919) {
  const eq = [], times = [];
  let v = 1e7;
  for (let i = 0; i < dead; i++) { eq.push(v); times.push(i * DAY); }
  for (let i = 0; i < live; i++) {
    v *= 1 + (((i * seed) % 13) - 6) * 0.002;
    eq.push(v); times.push((dead + i) * DAY);
  }
  return { eq, times, proxyT0: dead * DAY };
}

test('a bot with no dead stretch reports nothing at all', () => {
  const { eq, times } = curve(0, 400);
  const r = postProxyScore(eq, times, times[0]); // proxy starts on the bot's own first bar
  assert.equal(r.sharpePostProxy, null, 'null, not a copy of the headline Sharpe');
  assert.equal(r.preProxyBars, 0);
});

test('a dead stretch is counted, and the Sharpe is scored only from the proxy bar', () => {
  const { eq, times, proxyT0 } = curve(301, 600); // 301 = what the real board carries
  const r = postProxyScore(eq, times, proxyT0);
  assert.equal(r.preProxyBars, 301, 'every bar before the proxy is counted');
  // Derived independently of the implementation: score the tail directly.
  const expected = +sharpeOfCurve(eq.slice(301)).toFixed(2);
  assert.equal(r.sharpePostProxy, expected);
  assert.notEqual(r.sharpePostProxy, +sharpeOfCurve(eq).toFixed(2),
    'and it genuinely differs from the whole-curve figure, or this measures nothing');
});

test('the flat head really does depress the ranked figure — the artifact has the claimed sign', () => {
  // The reason the board publishes this at all: those bars carry no return while the hurdle is
  // charged on every one of them, so including them drags the excess-return Sharpe down.
  const { eq, times, proxyT0 } = curve(301, 600);
  const r = postProxyScore(eq, times, proxyT0);
  const asRanked = +sharpeOfCurve(eq).toFixed(2);
  assert.ok(r.sharpePostProxy > asRanked,
    `scoring from the proxy should read HIGHER than the full curve (got ${r.sharpePostProxy} vs ${asRanked})`);
});

test('the boundary includes the proxy’s own first bar', () => {
  // An off-by-one here would quietly keep one dead bar, or drop the proxy's first live one.
  const { eq, times, proxyT0 } = curve(50, 400);
  assert.equal(postProxyScore(eq, times, proxyT0).preProxyBars, 50);
  assert.equal(postProxyScore(eq, times, proxyT0 + 1).preProxyBars, 51, 'a proxy starting one bar later skips one more');
  assert.equal(postProxyScore(eq, times, proxyT0 - DAY).preProxyBars, 49, 'and one bar earlier skips one fewer');
});

test('too little curve left after the dead stretch reports the count but NO Sharpe', () => {
  const { eq, times, proxyT0 } = curve(300, 10); // only 10 live bars
  const r = postProxyScore(eq, times, proxyT0);
  assert.equal(r.preProxyBars, 300, 'the count is still useful and still reported');
  assert.equal(r.sharpePostProxy, null, 'but a Sharpe off 10 bars is noise, so none is published');
});

test('malformed input degrades to nulls rather than throwing mid-standings', () => {
  const { eq, times, proxyT0 } = curve(100, 300);
  for (const [label, call] of [
    ['null proxy (NIFTY not loaded on a cold boot)', () => postProxyScore(eq, times, null)],
    ['no times', () => postProxyScore(eq, [], proxyT0)],
    ['length mismatch', () => postProxyScore(eq.slice(0, 5), times, proxyT0)],
    ['undefined curve', () => postProxyScore(undefined, times, proxyT0)],
  ]) {
    const r = call();
    assert.equal(r.sharpePostProxy, null, `${label}: no number`);
    assert.equal(typeof r.preProxyBars, 'number', `${label}: still a usable shape`);
  }
});
