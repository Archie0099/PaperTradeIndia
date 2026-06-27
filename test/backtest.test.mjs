// ---------------------------------------------------------------------------
// test/backtest.test.mjs
// Locks the Strategy Arena backtester: the metric math and a few deterministic
// end-to-end backtests. Pure + offline (no network) — we feed hand-made candle
// series, so the numbers are exactly predictable.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { totalReturnPct, cagrPct, maxDrawdownPct, sharpe, inferPeriodsPerYear } from '../backtest/metrics.mjs';
import { runBacktest } from '../backtest/backtester.mjs';
import { safeCompile } from '../backtest/dsl.mjs';

// Helper: build candles from a list of closes, one "day" apart.
const candlesFrom = (closes) => closes.map((c, i) => ({ t: i * 864e5, c }));

test('metrics: total return, drawdown, and Sharpe on known curves', () => {
  assert.equal(totalReturnPct([100, 150, 200]), 100); // doubled = +100%
  assert.equal(+maxDrawdownPct([100, 200, 150, 180]).toFixed(2), 25); // 200 -> 150
  assert.equal(sharpe([100, 100, 100]), 0); // flat curve has zero Sharpe
  assert.ok(sharpe([100, 101, 102, 103, 104]) > 0); // steady rise -> positive
});

test('metrics survive a wiped-out (negative-equity) curve — no NaN, drawdown ≤ 100%, Sharpe never positive', () => {
  // A naked-short F&O blowup can drive equity negative; cagr must not be NaN.
  assert.equal(cagrPct([1000000, -30000], 2.5), -100); // total loss
  assert.ok(Number.isFinite(cagrPct([1000000, -30000], 2.5)));
  assert.ok(maxDrawdownPct([1000000, -30000, 500000]) <= 100, 'drawdown clamped at 100%');
  // dailyReturns SKIPS steps from non-positive equity, so a curve that rises then gets
  // WIPED could otherwise show a POSITIVE Sharpe off its surviving early gains. A wiped account must
  // never advertise a positive risk-adjusted return.
  const wiped = [100, 110, 121, 133, -50]; // steady rise, then blown to negative
  assert.ok(sharpe(wiped) <= 0, `a wiped curve must not have a positive Sharpe, got ${sharpe(wiped)}`);
  // A clean rising curve is unaffected (still positive).
  assert.ok(sharpe([100, 101, 102, 103, 104]) > 0, 'a solvent rising curve keeps its positive Sharpe');
});

test('Sharpe annualises by periodsPerYear (intraday bars are not under-annualised)', () => {
  // A noisy, slightly-up per-bar return series.
  const eq = [100];
  for (let i = 1; i < 200; i++) eq.push(eq[i - 1] * (1 + 0.0004 + (((i * 73) % 7) - 3) * 0.001));
  const daily = sharpe(eq);        // default 252 (one bar = one trading day)
  const hourly = sharpe(eq, 1575); // ~252 * 6.25 hourly NSE bars/day
  assert.ok(daily !== 0 && hourly !== 0, 'both non-zero on a non-flat series');
  assert.ok(Math.abs(Math.abs(hourly / daily) - Math.sqrt(1575 / 252)) < 1e-6, 'Sharpe scales by sqrt(periodsPerYear ratio)');
  // inferPeriodsPerYear: too-short series -> 252 fallback; hourly NSE bars land well above 252.
  assert.equal(inferPeriodsPerYear([1, 2]), 252, 'a too-short series falls back to 252');
  const ht = []; let t = 0;
  for (let d = 0; d < 250; d++) { for (let h = 0; h < 6; h++) { ht.push(t); t += 3600000; } t += 18 * 3600000; }
  const ppy = inferPeriodsPerYear(ht);
  assert.ok(ppy > 1000 && ppy < 2500, `hourly bars/year is well above the daily 252, got ${ppy.toFixed(0)}`);
});

test('recordTrades returns a faithful per-trade log (dates, realised P&L) with no look-ahead', () => {
  const closes = Array.from({ length: 10 }, (_, i) => 100 + i * 10); // steadily rising
  const candles = candlesFrom(closes);
  // Fully long for bars 0..3, flat thereafter -> an opening BUY then a closing SELL.
  const strat = { name: 'inout', note: '', make: () => (({ i }) => (i < 4 ? 1 : 0)) };

  const off = runBacktest({ strategy: strat, candles, symbol: 'ACME', cash: 1_000_000 });
  assert.equal(off.trades, undefined, 'no trade log unless recordTrades is on (back-compat preserved)');

  const on = runBacktest({ strategy: strat, candles, symbol: 'ACME', cash: 1_000_000, recordTrades: true });
  assert.ok(Array.isArray(on.trades) && on.trades.length >= 2, 'a trade log is returned');
  assert.equal(on.trades.length, on.metrics.trades, 'the log length matches the trade-count metric');
  assert.equal(on.trades[0].side, 'BUY', 'the first action is the opening buy');
  const last = on.trades[on.trades.length - 1];
  assert.equal(last.side, 'SELL', 'the position is closed by a sell');
  assert.ok(last.realised > 0, `closing on higher prices books a profit, got ${last.realised}`);
  for (const tr of on.trades) {
    assert.ok(candles.some((c) => c.t === tr.t), 'each trade timestamp is a REAL bar (no synthetic/look-ahead time)');
    assert.equal(tr.symbol, 'ACME');
    assert.ok(tr.qty > 0 && tr.price > 0 && Number.isFinite(tr.realised) && Number.isFinite(tr.value), 'sane fields');
    assert.ok(typeof tr.reason === 'string' && tr.reason.length > 0, 'each trade carries a plain-English reason');
  }
});

test('recordTrades reasons reflect the DSL entry/exit rules ("why each buy/sell")', () => {
  // A breakout EQ spec: enter on a 5-bar high break, exit on a 3-bar low break.
  const spec = { kind: 'EQ', name: 'bo', entry: ['>=', ['price'], ['high', 5]], exit: ['<=', ['price'], ['low', 3]] };
  const c = safeCompile(spec);
  const closes = [10, 10, 10, 10, 10, 12, 13, 14, 9, 8, 7, 12, 13, 14];
  const candles = closes.map((x, i) => ({ t: i * 864e5, c: x }));
  const res = runBacktest({ strategy: c.strategy, candles, symbol: 'X', cash: 1_000_000, recordTrades: true, spec });
  assert.ok(res.trades.length >= 2, 'the breakout entered and exited at least once');
  for (const tr of res.trades) assert.ok(typeof tr.reason === 'string' && tr.reason.length > 0, 'every trade has a reason');
  const buy = res.trades.find((t) => t.side === 'BUY');
  assert.match(buy.reason, /Buy signal.*high/i, 'a fresh buy names the entry rule (a high break)');
  const sell = res.trades.find((t) => t.side === 'SELL' && /Sell signal/.test(t.reason));
  assert.ok(sell, 'a full exit names the sell rule');
});

test('metrics: doubling in ~1 year is ~100% CAGR', () => {
  assert.ok(Math.abs(cagrPct([100, 200], 1) - 100) < 1e-6);
});

test('end-to-end: Buy & Hold captures a steady uptrend (minus costs)', () => {
  // 200 bars rising 0.2%/day -> ~ +48.8% frictionless.
  let p = 100;
  const closes = [];
  for (let i = 0; i < 200; i++) { closes.push(+p.toFixed(4)); p *= 1.002; }
  const buyHold = { name: 'BH', note: '', make: () => () => 1 };
  const res = runBacktest({ strategy: buyHold, candles: candlesFrom(closes), symbol: 'TEST', cash: 1_000_000, costBps: 5 });
  assert.ok(res.metrics.totalReturnPct > 40, `expected >40%, got ${res.metrics.totalReturnPct}`);
  assert.ok(res.metrics.totalReturnPct < 49, 'costs + integer-share rounding shave a little off the ~48.8% ideal');
  assert.ok(res.metrics.trades >= 1 && res.metrics.trades <= 3, 'buy-hold trades rarely');
});

test('end-to-end: a flat-target strategy never trades and stays at break-even', () => {
  const closes = new Array(50).fill(100);
  const flat = { name: 'flat', note: '', make: () => () => 0 };
  const res = runBacktest({ strategy: flat, candles: candlesFrom(closes), symbol: 'TEST', cash: 500000 });
  assert.equal(res.metrics.trades, 0);
  assert.equal(res.metrics.finalEquity, 500000);
});

test('SHORT (bearish) bot: profits when the market FALLS, loses when it RISES', () => {
  // An always-short bot (side:'short', no entry rule -> constantly short at 1x).
  const shortSpec = { kind: 'EQ', name: 'always short', side: 'short', weight: 1 };
  const c = safeCompile(shortSpec);
  assert.ok(c.ok, 'short spec compiles');
  const down = []; let p = 100; for (let i = 0; i < 120; i++) { down.push(+p.toFixed(2)); p *= 0.995; } // ~ -45%
  const up = []; p = 100; for (let i = 0; i < 120; i++) { up.push(+p.toFixed(2)); p *= 1.005; }          // ~ +82%
  const rd = runBacktest({ strategy: c.strategy, candles: candlesFrom(down), symbol: 'X', cash: 1_000_000, spec: shortSpec });
  const ru = runBacktest({ strategy: safeCompile(shortSpec).strategy, candles: candlesFrom(up), symbol: 'X', cash: 1_000_000, spec: shortSpec });
  assert.ok(rd.metrics.finalEquity > 1_000_000, `a short should PROFIT in a falling market, got ₹${rd.metrics.finalEquity}`);
  assert.ok(ru.metrics.finalEquity < 1_000_000, `a short should LOSE in a rising market, got ₹${ru.metrics.finalEquity}`);
  assert.match(rd.position, /short/, 'the bot ends in a short position');
  assert.ok(Number.isFinite(ru.metrics.finalEquity), 'a losing short still produces finite metrics');
});

test('SHORT bot: logs SELL-to-open / BUY-to-cover with bearish reasons; deterministic', () => {
  // Short when below the 5-day SMA, cover when back above it.
  const spec = { kind: 'EQ', name: 'sh', side: 'short', entry: ['<', ['price'], ['sma', 5]], exit: ['>', ['price'], ['sma', 5]] };
  const c = safeCompile(spec);
  const closes = [10, 10, 10, 10, 10, 9, 8, 7, 6, 5, 6, 7, 9, 11, 13, 15]; // falls (short profits), then clearly rises (covers -> flat)
  const cdl = closes.map((x, i) => ({ t: i * 864e5, c: x }));
  const res = runBacktest({ strategy: c.strategy, candles: cdl, symbol: 'X', cash: 1_000_000, recordTrades: true, spec });
  const open = res.trades.find((t) => t.side === 'SELL');
  assert.ok(open && /short/i.test(open.reason), `the opening trade is a SELL described as a short, got "${open && open.reason}"`);
  const cover = res.trades.find((t) => t.side === 'BUY');
  assert.ok(cover && /cover/i.test(cover.reason), `the closing trade is a BUY described as a cover, got "${cover && cover.reason}"`);
  // If the short fully covered by the end (price well above SMA5), the book is flat and
  // Σrealised must reconcile EXACTLY with equity−cash — i.e. no phantom / naked leg.
  if (/flat/.test(res.position)) {
    const sumReal = res.trades.reduce((s, t) => s + (t.realised || 0), 0);
    assert.ok(Math.abs((res.metrics.finalEquity - 1_000_000) - sumReal) < 0.01, 'flat-end short reconciles: Σrealised == equity−cash');
  }
  const res2 = runBacktest({ strategy: safeCompile(spec).strategy, candles: cdl, symbol: 'X', cash: 1_000_000, recordTrades: true, spec });
  assert.deepEqual(res.equityCurve.map((x) => +x.toFixed(4)), res2.equityCurve.map((x) => +x.toFixed(4)), 'a short backtest is deterministic');
});

test('SHORT bot survives a >2x gap-up: never flips to long, metrics finite, deterministic', () => {
  // A short's loss is UNBOUNDED (unlike a long, floored at its principal), so a single-bar
  // gap can drive equity negative — a faithful, by-design simulation (the naked option
  // sellers can do the same). Verify the no-flip guard holds (a short spec only ever covers
  // toward flat, never accidentally going LONG when equity flips sign) and the accounting
  // stays sane (finite metrics, deterministic) even through the blow-up.
  const shortSpec = { kind: 'EQ', name: 'always short', side: 'short', weight: 1 };
  const closes = [100, 100, 100, 100, 500, 100, 100]; // a 5x gap up on bar 4
  const cdl = closes.map((x, i) => ({ t: i * 864e5, c: x }));
  const res = runBacktest({ strategy: safeCompile(shortSpec).strategy, candles: cdl, symbol: 'X', cash: 1_000_000, recordTrades: true, spec: shortSpec });
  // Reconstruct the running net position from the trade log — a short spec must NEVER be net long.
  let net = 0;
  for (const t of res.trades) { net += (t.side === 'BUY' ? 1 : -1) * t.qty; assert.ok(net <= 0, `a short spec must never hold a long; net reached ${net}`); }
  assert.ok(Number.isFinite(res.metrics.finalEquity), 'metrics stay finite even on a blow-up');
  assert.ok(Number.isFinite(res.metrics.maxDrawdownPct) && res.metrics.maxDrawdownPct <= 100, 'drawdown clamped + finite');
  const res2 = runBacktest({ strategy: safeCompile(shortSpec).strategy, candles: cdl, symbol: 'X', cash: 1_000_000, recordTrades: true, spec: shortSpec });
  assert.deepEqual(res.equityCurve.map((x) => +x.toFixed(2)), res2.equityCurve.map((x) => +x.toFixed(2)), 'deterministic through a gap');
});

test('end-to-end: the engine never lets a long-only backtest spend below zero cash', () => {
  // Even an always-all-in strategy on a volatile series must keep cash >= 0
  // (the engine rejects unaffordable orders) — a quick MASTER-invariant-style
  // sanity check that backtests obey the real money rules.
  const closes = [];
  let p = 100;
  for (let i = 0; i < 120; i++) { p *= i % 2 ? 1.03 : 0.98; closes.push(+p.toFixed(2)); }
  const allIn = { name: 'allin', note: '', make: () => () => 1 };
  const res = runBacktest({ strategy: allIn, candles: candlesFrom(closes), symbol: 'TEST', cash: 250000 });
  assert.ok(Number.isFinite(res.metrics.finalEquity));
  assert.ok(res.metrics.finalEquity > 0, 'a long-only book cannot go bankrupt to <= 0');
});
