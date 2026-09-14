// ---------------------------------------------------------------------------
// test/cov-alignment.test.mjs
// Locks the OPTIONAL date-aligned covariance window for the optimiser weightings
// (`covAlign: 'dates'` on runPortfolioBacktest), and the `_covProbe` diagnostic hook
// the research tool reads decisions through.
//
// The default ('own') builds each chosen name's window from its OWN last covLookback
// returns, so row u means "this name's u-th most recent return" — the same DATE for
// every name only while they all traded on the same days. 'dates' instead pairs returns
// over intervals between dates on which every chosen name actually traded.
//
// What must hold:
//   * the default path is UNTOUCHED — omitting the option is identical to 'own',
//   * on GAP-FREE data the two constructions must agree EXACTLY (if they disagree there,
//     'dates' is changing something other than alignment, and the whole comparison the
//     research tool makes would be meaningless),
//   * with a gap they DO differ, and the gappy name is weighted HIGHER under 'own'
//     (its shifted column decorrelates, so it looks like a diversifier),
//   * too few common dates degrades to inverse-vol rather than optimising on a stub,
//   * 'dates' reads no bar after the decision bar (no look-ahead).
// Pure + offline (deterministic synthetic candles, no network).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runPortfolioBacktest } from '../backtest/portfolio.mjs';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const SYMS = ['AAA', 'BBB', 'CCC', 'DDD'];
// Correlated names: a shared market factor plus idiosyncratic noise. The shared factor is
// what makes the off-diagonals large, and therefore what a shifted column destroys — on
// independent series there would be no correlation to lose and nothing to detect.
function universeData(n = 420) {
  const mkt = mulberry32(99);
  const shocks = Array.from({ length: n }, () => (mkt() - 0.5) * 0.02);
  const data = {};
  SYMS.forEach((s, k) => {
    const rng = mulberry32(2000 + k * 13);
    let p = 100 + k * 5;
    const candles = [];
    for (let i = 0; i < n; i++) {
      p *= 1 + 0.0003 + shocks[i] + (rng() - 0.5) * 0.01;
      candles.push({ t: i * 864e5, c: +p.toFixed(4) });
    }
    data[s] = candles;
  });
  return data;
}

const CASH = 10_000_000;
const rpSpec = {
  kind: 'BASKET', name: 'rp', universe: SYMS, rank: ['mom', 40], k: 4,
  weighting: 'riskparity', rebalanceBars: 20, covLookback: 60, maxWeight: 0.9,
};

const run = (data, opts = {}) => runPortfolioBacktest({
  spec: rpSpec, dataBySymbol: data, cash: CASH, recordTrades: false, ...opts,
});
const sameCurve = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// Drop `count` bars from ONE name, deep inside its history, so its trailing window is
// shifted against the others exactly the way a real missed session shifts it.
function withGap(data, sym = 'BBB', at = 150, count = 1) {
  const out = {};
  for (const s of SYMS) out[s] = data[s].map((c) => ({ ...c }));
  out[sym] = out[sym].filter((_, i) => i < at || i >= at + count);
  return out;
}

test("covAlign defaults to 'own' — omitting the option is byte-identical to asking for it", () => {
  // MUST use GAPPED data. On gap-free data the two constructions agree by construction (the
  // test below proves that), so this assertion would pass even if the default had been
  // flipped to 'dates' — a fixture that locks nothing. Verified by mutation: flipping the
  // default leaves this green on clean data and turns it red on this one.
  const data = withGap(universeData());
  const a = run(data);
  const b = run(data, { covAlign: 'own' });
  assert.ok(sameCurve(a.equityCurve, b.equityCurve), 'default must equal explicit own');
  assert.equal(a.metrics.finalEquity, b.metrics.finalEquity);
});

test("an unknown covAlign value falls through to the default construction (no silent third behaviour)", () => {
  const data = withGap(universeData());
  const a = run(data, { covAlign: 'own' });
  const b = run(data, { covAlign: 'nonsense' });
  assert.ok(sameCurve(a.equityCurve, b.equityCurve));
});

test("on GAP-FREE data 'dates' and 'own' agree EXACTLY — the option changes alignment and nothing else", () => {
  // Every name trades every bar, so "u-th most recent return" and "the return on date D"
  // are the same thing. Any difference here would mean the date-aligned window also changed
  // the lookback span or the return horizon, which would confound every comparison the
  // research tool makes with it.
  const data = universeData();
  const own = run(data, { covAlign: 'own' });
  const dates = run(data, { covAlign: 'dates' });
  assert.ok(sameCurve(own.equityCurve, dates.equityCurve),
    'gap-free data must give identical curves under both constructions');
});

test("with a real gap the two constructions DIVERGE (the option is reachable, not inert)", () => {
  const data = withGap(universeData());
  const own = run(data, { covAlign: 'own' });
  const dates = run(data, { covAlign: 'dates' });
  assert.ok(!sameCurve(own.equityCurve, dates.equityCurve),
    'a gapped name must make the two covariance windows differ');
});

test("the GAPPY name is weighted HIGHER under 'own' — its shifted column looks like a diversifier", () => {
  // The mechanism, at the weights themselves rather than at the curve: shifting one column
  // in time does not touch that name's own variance (the diagonal is invariant to ordering),
  // it only collapses its covariance with everyone else toward zero. A name that appears
  // uncorrelated looks like it adds less portfolio risk, and risk-parity hands it more.
  const data = withGap(universeData());
  const grab = (covAlign) => {
    const seen = [];
    run(data, { covAlign, _covProbe: (p) => seen.push(p) });
    return seen;
  };
  const own = grab('own');
  const dates = grab('dates');
  assert.ok(own.length && own.length === dates.length, 'both arms must probe the same bars');

  let comparedBars = 0, ownHeavier = 0;
  for (let i = 0; i < own.length; i++) {
    const o = own[i], d = dates[i];
    if (!o.optimised || !d.optimised) continue;
    const io = o.syms.indexOf('BBB'), id = d.syms.indexOf('BBB');
    if (io < 0 || id < 0) continue;
    if (o.weights[io] === d.weights[id]) continue; // window did not span the gap
    comparedBars++;
    if (o.weights[io] > d.weights[id]) ownHeavier++;
  }
  assert.ok(comparedBars > 0, 'expected at least one rebalance whose window spans the gap');
  assert.equal(ownHeavier, comparedBars,
    `the gappy name should be heavier under 'own' on every affected bar (was ${ownHeavier}/${comparedBars})`);
});

test("'dates' degrades to inverse-vol when the names share too few trading dates", () => {
  // Interleaved gaps: each name skips a different residue class, so the dates on which ALL
  // of them traded are far fewer than covLookback. The window cannot be built and the
  // optimiser must not be handed a short matrix — weightsFor falls back instead.
  //
  // HONEST NOTE on what this does and does not lock: it locks the BEHAVIOUR (fall back,
  // never optimise on a stub), not the explicit length check that expresses it. Mutation
  // testing showed the fallback survives removing that check, because a short position list
  // then reads past its own end and the window is rejected one step later anyway. The
  // explicit check is kept as the stated contract rather than relying on that accident.
  const base = universeData();
  const data = {};
  SYMS.forEach((s, k) => { data[s] = base[s].filter((_, i) => i % 4 !== k); });
  const probes = [];
  const r = run(data, { covAlign: 'dates', _covProbe: (p) => probes.push(p) });
  assert.ok(Number.isFinite(r.metrics.finalEquity), 'must still produce a finite result');
  assert.ok(probes.length > 0, 'expected rebalances to occur');
  assert.ok(probes.every((p) => p.optimised === false),
    'no rebalance should claim an optimiser solve when the common-date window cannot be built');
});

test("'dates' reads no bar after the decision bar (no look-ahead)", () => {
  // Corrupting only the FINAL bar must leave every earlier equity point untouched.
  const data = withGap(universeData());
  const poisoned = {};
  for (const s of SYMS) {
    poisoned[s] = data[s].map((c) => ({ ...c }));
    const last = poisoned[s].length - 1;
    poisoned[s][last] = { ...poisoned[s][last], c: poisoned[s][last].c * 3 };
  }
  const clean = run(data, { covAlign: 'dates' });
  const dirty = run(poisoned, { covAlign: 'dates' });
  const n = Math.min(clean.equityCurve.length, dirty.equityCurve.length);
  assert.ok(n > 2);
  for (let i = 0; i < n - 1; i++) {
    assert.equal(clean.equityCurve[i], dirty.equityCurve[i],
      `equity at bar ${i} changed when only the LAST bar was altered`);
  }
});

test('_covProbe is diagnostic-only — passing it changes no result', () => {
  const data = withGap(universeData());
  const plain = run(data, { covAlign: 'dates' });
  const probed = run(data, { covAlign: 'dates', _covProbe: () => {} });
  assert.ok(sameCurve(plain.equityCurve, probed.equityCurve));
});

test('_covProbe reports optimised:false when the window WAS built but the solve was rejected', () => {
  // The case that separates the two flags. A per-name cap too tight to fill the budget
  // (maxWeight * k < 1) leaves the optimiser's answer under-invested, so weightsFor discards
  // it and degrades to inverse-vol — while the covariance window itself was built fine.
  // Reading `optimised` off the mere existence of the window would report true here, and the
  // research tool would count these bars as optimiser decisions that they are not.
  const data = universeData();
  const probes = [];
  runPortfolioBacktest({
    spec: { ...rpSpec, weighting: 'meanvar', k: 4, maxWeight: 0.2 },
    dataBySymbol: data, cash: CASH, recordTrades: false, _covProbe: (p) => probes.push(p),
  });
  assert.ok(probes.length > 0, 'expected rebalances');
  const built = probes.filter((p) => p.windowBuilt);
  assert.ok(built.length > 0, 'expected the covariance window to be built at least once');
  assert.ok(built.every((p) => p.optimised === false),
    'an infeasible cap must report windowBuilt:true with optimised:false');
});

test('_covProbe distinguishes "window built" from "optimiser answer used"', () => {
  // A fallback's inverse-vol weights are finite, long-only and fully invested too, so
  // `optimised` cannot be read off the returned weights — it has to come from re-testing
  // the solve. This locks the two flags as genuinely separate facts.
  const data = universeData();
  const probes = [];
  run(data, { _covProbe: (p) => probes.push(p) });
  assert.ok(probes.length > 0);
  for (const p of probes) {
    assert.equal(typeof p.windowBuilt, 'boolean');
    assert.equal(typeof p.optimised, 'boolean');
    if (p.optimised) assert.ok(p.windowBuilt, 'optimised implies a window was built');
    assert.ok(Array.isArray(p.syms) && Array.isArray(p.weights));
    assert.equal(p.syms.length, p.weights.length);
  }
});
