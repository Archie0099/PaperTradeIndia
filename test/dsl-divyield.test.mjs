// `divYield` — a TRAILING DIVIDEND YIELD recovered from price data alone, and the `ctx`
// widening that made it possible.
//
// WHY THIS MATTERS MORE THAN ONE OPERATOR. This project has no fundamentals feed, so every
// accounting-based signal was out of reach. But the loader keeps BOTH closes — adjusted as `c`
// and raw as `craw` — and Yahoo's adjusted series discounts past prices for every LATER
// dividend. Their ratio therefore carries the dividend stream and nothing else: splits and
// bonuses cancel, because the raw close is itself already split-adjusted. That makes this the
// first genuinely FUNDAMENTAL signal reachable here.
//
// The mechanism was measured across all 105 universe names BEFORE the operator was written
// (backtest/research/adjusted-vs-raw.mjs): 4,228 ex-dates, median implied yield 1.11%/yr,
// COALINDIA highest at 7.29% and ABCAPITAL at 0.00% — both independently correct.
//
// What these lock:
//   1. The `ctx` widening is ADDITIVE — three-argument calls behave exactly as before.
//   2. Without the raw series the operator returns null, so it degrades to "no opinion"
//      (the name is skipped) rather than to a wrong number. Only safe direction to fail.
//   3. `ctx` survives nesting — a wrapped expression must not silently lose it.
//   4. The arithmetic is right, checked against a fixture whose yield is known by construction.
//   5. Splits do NOT leak in, since both series carry them.
//   6. The validator accepts it as a period op and rejects malformed periods.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evalNode, validExpr, validateSpec } from '../backtest/dsl.mjs';

// A series whose dividend stream is known exactly: the adjusted/raw ratio is engineered to
// rise from `kStart` to `kEnd`, so the yield over the whole span is kEnd/kStart - 1.
function series(n, kStart, kEnd, drift = 0.0002) {
  const closes = [], raw = [];
  for (let i = 0; i < n; i++) {
    const px = 100 * Math.exp(drift * i);
    raw.push(px);
    closes.push(px * (kStart + (kEnd - kStart) * (i / (n - 1))));
  }
  return { closes, raw };
}

test('the ctx widening is additive — a three-argument call is unchanged', () => {
  const { closes } = series(300, 0.9, 0.99);
  // Every pre-existing operator must give the identical answer with and without a ctx.
  for (const expr of [['price'], ['sma', 50], ['mom', 21], ['vol', 20], ['rsi', 14], ['distHigh', 100]]) {
    const without = evalNode(expr, closes, 299);
    const with_ = evalNode(expr, closes, 299, { raw: closes });
    assert.deepEqual(without, with_, `${expr[0]} must not change when a ctx is present`);
  }
});

test('without the raw series it returns null — degrades to no opinion, never a wrong number', () => {
  const { closes } = series(300, 0.9, 0.99);
  assert.equal(evalNode(['divYield', 252], closes, 299), null, 'no ctx at all');
  assert.equal(evalNode(['divYield', 252], closes, 299, {}), null, 'ctx with no raw series');
  assert.equal(evalNode(['divYield', 252], closes, 299, { raw: null }), null, 'ctx with a null raw series');
});

test('ctx survives nesting — a wrapped expression must not silently lose it', () => {
  const { closes, raw } = series(300, 0.9, 0.99);
  const bare = evalNode(['divYield', 252], closes, 299, { raw });
  assert.ok(bare > 0, 'the bare operator must produce a yield for this fixture');

  // Negation (how a "lowest yield first" rank would be written), arithmetic, and a comparison.
  assert.equal(evalNode(['*', -1, ['divYield', 252]], closes, 299, { raw }), -bare);
  assert.equal(evalNode(['+', ['divYield', 252], 0], closes, 299, { raw }), bare);
  assert.equal(evalNode(['>', ['divYield', 252], 0], closes, 299, { raw }), true);
  // And through a deeper tree, since ctx has to be threaded at every recursion point.
  assert.equal(evalNode(['clamp', ['divYield', 252], 0, 1], closes, 299, { raw }), bare);
});

test('the arithmetic is right — checked against a fixture whose yield is known by construction', () => {
  const n = 300, kStart = 0.90, kEnd = 0.99;
  const { closes, raw } = series(n, kStart, kEnd);
  const lookback = 252;
  // k rises linearly in the bar index, so the ratio between two bars is exact arithmetic.
  const kAt = (i) => kStart + (kEnd - kStart) * (i / (n - 1));
  const expected = kAt(n - 1) / kAt(n - 1 - lookback) - 1;

  const got = evalNode(['divYield', lookback], closes, n - 1, { raw });
  assert.ok(Math.abs(got - expected) < 1e-9, `expected ${expected}, got ${got}`);
  // Sanity: a ~9% ratio rise over the full span must read as a few percent over one year.
  assert.ok(got > 0.05 && got < 0.12, `implausible yield ${got}`);
});

test('a non-payer reads exactly zero, and the floor holds against rounding jitter', () => {
  // k constant => no dividends ever => zero yield, not a tiny positive or negative.
  const { closes, raw } = series(300, 0.95, 0.95);
  assert.equal(evalNode(['divYield', 252], closes, 299, { raw }), 0);

  // A ratio that drifts DOWN cannot be a dividend (adjustment can only raise k going forward),
  // so it must floor at 0 rather than emit a negative "yield" that would outrank a real payer
  // whenever the sign is flipped.
  const down = series(300, 0.99, 0.90);
  const y = evalNode(['divYield', 252], down.closes, 299, { raw: down.raw });
  assert.equal(y, 0, 'a falling ratio must floor at zero, not go negative');
});

test('splits do not leak in — both series carry them, so they cancel', () => {
  const n = 300;
  const { closes, raw } = series(n, 0.95, 0.95);
  // Apply a 1:1 split at bar 150 to BOTH series, exactly as the feed does.
  for (let i = 0; i < 150; i++) { closes[i] /= 2; raw[i] /= 2; }
  assert.equal(evalNode(['divYield', 252], closes, n - 1, { raw }), 0,
    'a split present in both series must not register as a dividend');
});

test('unwarm returns null, and the validator polices the period', () => {
  const { closes, raw } = series(300, 0.9, 0.99);
  assert.equal(evalNode(['divYield', 252], closes, 10, { raw }), null, 'not enough history yet');

  assert.equal(validExpr(['divYield', 252]), true);
  assert.equal(validExpr(['divYield', 0]), false, 'a zero period is malformed');
  assert.equal(validExpr(['divYield', 401]), false, 'beyond the period cap');
  assert.equal(validExpr(['divYield', 12.5]), false, 'a non-integer period is malformed');

  // And a whole spec using it must validate, since that is how it reaches a basket.
  const spec = {
    kind: 'BASKET', name: 'yield', universe: ['A', 'B', 'C'],
    rank: ['divYield', 252], k: 2, weighting: 'equal', rebalanceBars: 21,
  };
  assert.equal(validateSpec(spec), null, 'a basket ranking on divYield must be a valid spec');
});
