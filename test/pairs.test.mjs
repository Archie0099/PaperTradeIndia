// ---------------------------------------------------------------------------
// test/pairs.test.mjs
// Locks the PAIRS / statistical-arbitrage strategy kind (Quant Lab part D):
//   * validation accepts good specs and rejects malformed ones,
//   * the backtester is DETERMINISTIC and has NO LOOK-AHEAD,
//   * it runs through the REAL engine so the MASTER money invariant holds,
//   * the book is genuinely MARKET-NEUTRAL (equal rupee long & short per pair),
//   * it actually SHORTS, records trades with reasons + a decision log,
//   * selectPairs picks disjoint, screened pairs,
//   * evolution mutates / crosses PAIRS specs to VALID specs, deterministically,
//   * a PAIRS bot runs end-to-end through the live tournament.
// ---------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';

import { runPairsBacktest, selectPairs, corr, olsSlope, ar1 } from '../backtest/pairs.mjs';
import { validateSpec, validatePairs, safeCompile, explainSpec, strategyRationale } from '../backtest/dsl.mjs';
import { mutatePairs, crossover, mulberry32, scoreSpec, archetypeOf } from '../tournament/evolve.mjs';
import { createTournament } from '../tournament/tournament.mjs';

// --- synthetic data: two co-moving, mean-reverting pairs (A,B) and (C,D) ------
// A common uptrend drives all four; an oscillating term opens/closes the spread, so
// the z-score crosses the entry/exit thresholds repeatedly. Different scale factors
// give non-trivial hedge ratios (β ≠ 1). Pure formula -> deterministic, no RNG.
const DAY = 86400000;
const T0 = 1600000000000; // a fixed start so istDate-based logic is stable
function makeData(n = 260) {
  const A = [], B = [], C = [], D = [], NIFTY = [];
  for (let i = 0; i < n; i++) {
    const t = T0 + i * DAY;
    const common = 1000 * Math.exp(0.0002 * i);
    const osc1 = 0.045 * Math.sin(i / 11);
    const osc2 = 0.035 * Math.cos(i / 13);
    A.push({ t, c: common * (1 + osc1) });
    B.push({ t, c: common * 0.6 * (1 - osc1) });
    C.push({ t, c: common * 1.3 * (1 + osc2) });
    D.push({ t, c: common * 0.9 * (1 - osc2) });
    NIFTY.push({ t, c: common });
  }
  return { A, B, C, D, NIFTY };
}
const UNIV = ['A', 'B', 'C', 'D'];
const goodSpec = (over = {}) => ({
  kind: 'PAIRS', name: 'test pairs', universe: UNIV,
  lookback: 30, entryZ: 2, exitZ: 0.5, stopZ: 4, maxPairs: 2, formationBars: 10, minCorr: 0, gross: 0.9, ...over,
});

// --- validation -------------------------------------------------------------
test('validatePairs accepts a well-formed spec and safeCompile compiles it', () => {
  assert.equal(validateSpec(goodSpec()), null);
  const c = safeCompile(goodSpec());
  assert.equal(c.ok, true);
  assert.equal(c.kind, 'PAIRS');
});

test('validatePairs rejects malformed specs', () => {
  assert.match(validateSpec(goodSpec({ universe: ['A', 'B', 'C'] })), /4\.\./); // < 4 names
  assert.match(validateSpec(goodSpec({ universe: ['A', 'A', 'B', 'C'] })), /duplicate/);
  assert.match(validateSpec(goodSpec({ exitZ: 2, entryZ: 2 })), /exitZ/);     // exitZ must be < entryZ
  assert.match(validateSpec(goodSpec({ entryZ: 0 })), /entryZ/);              // entryZ must be > 0
  assert.match(validateSpec(goodSpec({ stopZ: 1.5 })), /stopZ/);             // stopZ must be > entryZ(2)
  assert.match(validateSpec(goodSpec({ maxPairs: 3 })), /maxPairs/);          // > floor(4/2)=2
  assert.match(validateSpec(goodSpec({ lookback: 10 })), /lookback/);         // < 20
  assert.match(validateSpec(goodSpec({ formationBars: 1 })), /formationBars/);
  assert.match(validateSpec(goodSpec({ minCorr: 1 })), /minCorr/);           // must be < 1
});

test('explainSpec + strategyRationale describe a PAIRS bot in plain English', () => {
  const ex = explainSpec(goodSpec());
  assert.match(ex, /market-neutral/i);
  assert.match(ex, /pairs/i);
  const r = strategyRationale(goodSpec());
  assert.ok(r && r.headline && r.thesis && Array.isArray(r.params) && r.risk);
  assert.match(r.thesis, /converg|spread|neutral/i);
});

// --- backtester core --------------------------------------------------------
test('PAIRS backtest is deterministic (identical run -> identical equity curve)', () => {
  const d = makeData();
  const a = runPairsBacktest({ spec: goodSpec(), dataBySymbol: d });
  const b = runPairsBacktest({ spec: goodSpec(), dataBySymbol: d });
  assert.deepEqual(a.equityCurve, b.equityCurve);
  assert.equal(a.metrics.trades, b.metrics.trades);
});

test('PAIRS backtest has NO LOOK-AHEAD (changing only the last bar leaves earlier equity untouched)', () => {
  const d = makeData();
  const base = runPairsBacktest({ spec: goodSpec(), dataBySymbol: d });
  // Perturb ONLY the final bar of every symbol; the past can't depend on the future.
  const d2 = {};
  for (const s of Object.keys(d)) { d2[s] = d[s].map((c) => ({ ...c })); const L = d2[s][d2[s].length - 1]; L.c *= 1.5; }
  const pert = runPairsBacktest({ spec: goodSpec(), dataBySymbol: d2 });
  assert.equal(base.equityCurve.length, pert.equityCurve.length);
  for (let i = 0; i < base.equityCurve.length - 1; i++) {
    assert.ok(Math.abs(base.equityCurve[i] - pert.equityCurve[i]) < 1e-6, `equity[${i}] changed: ${base.equityCurve[i]} vs ${pert.equityCurve[i]}`);
  }
});

test('PAIRS runs through the real engine so the MASTER invariant holds', () => {
  const d = makeData();
  let inv = null;
  runPairsBacktest({
    spec: goodSpec(), dataBySymbol: d,
    _hook: (engine) => { inv = Math.abs(engine.realisedTotal() + engine.unrealisedTotal() - (engine.equity() - engine.state.initialCash)); },
  });
  assert.ok(inv != null && inv < 0.01, `MASTER invariant residual ${inv}`);
});

test('PAIRS is market-neutral: EVERY opened pair places BOTH legs, equal rupee long & short', () => {
  const d = makeData();
  const res = runPairsBacktest({ spec: goodSpec(), dataBySymbol: d, recordTrades: true });
  // Group "Opened ..." trades by timestamp. STRICT (regression for the shorts-rejected /
  // half-legged bug): every open MUST place exactly 2 legs (one BUY + one SELL) of ~equal
  // value — never a single-legged (half) open that would leave the book net-long. We do
  // NOT `continue` past a non-2-leg group; a half-legged open is a HARD failure.
  // Group opens by (timestamp + the PAIR named in the reason) — several pairs can open on
  // the SAME bar, so grouping by timestamp alone is wrong; each PAIR must have exactly 2 legs.
  const opens = (res.trades || []).filter((t) => /Opened/.test(t.reason));
  assert.ok(opens.length >= 2, 'expected some pair openings');
  const byPair = new Map();
  for (const tr of opens) {
    const m = /Opened (\S+)\/(\S+) /.exec(tr.reason);
    const key = m ? `${tr.t}|${[m[1], m[2]].sort().join('/')}` : `${tr.t}|?`;
    if (!byPair.has(key)) byPair.set(key, []);
    byPair.get(key).push(tr);
  }
  for (const [key, legs] of byPair) {
    assert.equal(legs.length, 2, `pair open ${key} has ${legs.length} leg(s) — half-legged = NOT market-neutral`);
    const [x, y] = legs;
    assert.notEqual(x.side, y.side, 'an opened pair must be one long + one short');
    const hi = Math.max(x.value, y.value), lo = Math.min(x.value, y.value);
    assert.ok((hi - lo) / hi < 0.05, `legs not dollar-neutral: ${x.value} vs ${y.value}`);
  }
  assert.ok(byPair.size >= 1, 'expected at least one pair opening to verify');
});

test('PAIRS labels a rotated-leg UNWIND distinctly (no 3-leg "Opened" group on a wider universe)', () => {
  // Regression for the unwind-mislabel bug. On a universe big enough that a name ROTATES
  // between pairs across re-formations (disjointness only holds WITHIN one formation), the
  // flatten of its stale leg must NOT inherit the new pair's "Opened" reason — else the
  // history shows a 3/4-leg "Opened" group (and a SELL labelled "BOUGHT"), and this very
  // assertion (the market-neutral guard) would falsely fail. The 4-name goodSpec never
  // rotates, so this uses 6 co-moving names + maxPairs 3 where the greedy pick shuffles partners.
  const D2 = 86400000, S0 = 1600000000000, names = ['A', 'B', 'C', 'D', 'E', 'F'];
  const dbs = {}; for (const s of names) dbs[s] = []; dbs.NIFTY = [];
  for (let i = 0; i < 320; i++) {
    const t = S0 + i * D2, common = 1000 * Math.exp(0.0002 * i);
    dbs.A.push({ t, c: common * (1 + 0.040 * Math.sin(i / 11)) });
    dbs.B.push({ t, c: common * 0.7 * (1 + 0.038 * Math.sin(i / 11 + 0.6)) });
    dbs.C.push({ t, c: common * 1.2 * (1 + 0.042 * Math.sin(i / 9 + 1.1)) });
    dbs.D.push({ t, c: common * 0.9 * (1 + 0.039 * Math.cos(i / 13)) });
    dbs.E.push({ t, c: common * 1.1 * (1 + 0.041 * Math.cos(i / 13 + 0.7)) });
    dbs.F.push({ t, c: common * 0.8 * (1 + 0.037 * Math.cos(i / 10 + 1.4)) });
    dbs.NIFTY.push({ t, c: common });
  }
  const spec = { kind: 'PAIRS', name: 'six', universe: names, lookback: 30, entryZ: 1.5, exitZ: 0.4, stopZ: 5, maxPairs: 3, formationBars: 12, minCorr: 0, gross: 1 };
  const res = runPairsBacktest({ spec, dataBySymbol: dbs, recordTrades: true });
  const trades = res.trades || [];
  assert.ok(trades.some((t) => /Unwound/.test(t.reason)), 'a name DID rotate pairs (the unwind path is exercised)');
  const opens = trades.filter((t) => /Opened/.test(t.reason));
  const byPair = new Map();
  for (const tr of opens) {
    const m = /Opened (\S+)\/(\S+) /.exec(tr.reason);
    const k = m ? `${tr.t}|${[m[1], m[2]].sort().join('/')}` : `${tr.t}|?`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push(tr);
  }
  assert.ok(byPair.size >= 1, 'pairs opened on the wider universe');
  for (const [k, legs] of byPair) {
    assert.equal(legs.length, 2, `opened group ${k} has ${legs.length} legs — an unwind leaked into the open group`);
    assert.notEqual(legs[0].side, legs[1].side, 'an opened pair is one long + one short');
  }
});

test('PAIRS never goes half-legged or net-long even under tight funds (gross=1)', () => {
  const d = makeData();
  // gross=1 is the worst case for the shorts-then-longs funds buffer. The book must stay
  // ~dollar-neutral at the end (gross > 0 => |net| small vs gross notional) and no trade
  // may be a rejected phantom (the trade count is finite and every trade has a reason).
  let exposure = null;
  const res = runPairsBacktest({
    spec: goodSpec({ gross: 1 }), dataBySymbol: d, recordTrades: true,
    _hook: (engine) => {
      let net = 0, gross = 0;
      for (const k in engine.state.positions) {
        const p = engine.state.positions[k];
        const last = engine.state.lastPrices[k] || p.avgPrice;
        net += p.qty * last; gross += Math.abs(p.qty * last);
      }
      exposure = { net, gross };
    },
  });
  if (exposure && exposure.gross > 0) {
    assert.ok(Math.abs(exposure.net) < 0.15 * exposure.gross, `book not market-neutral: net ${exposure.net} vs gross ${exposure.gross}`);
  }
  assert.ok((res.trades || []).every((tr) => typeof tr.reason === 'string' && tr.reason.length > 0), 'every recorded trade has a non-empty reason (no phantom/blank rows)');
});

test('PAIRS stays market-neutral when MANY pairs open at once + funds get tight (half-legging regression)', () => {
  // The bug the re-hunt caught: opening a short does NOT free cash for the longs (the engine
  // reserves the short's full notional as margin), so when several pairs open on one bar the
  // longs were CLIPPED to leftover cash while the shorts filled full -> a half-legged, net-
  // directional book. Build 4 co-moving pairs whose spreads all stretch TOGETHER so all 4 try
  // to open on the same bar (the funds-exhaustion case the 4-name test never hit), then assert
  // the book never goes materially net-directional at ANY bar.
  const n = 240;
  const mk = (scale, sign) => {
    const arr = [];
    for (let i = 0; i < n; i++) {
      // A LARGE shared swing dominates the returns -> the two legs are strongly POSITIVELY
      // correlated; a SMALLER opposed oscillation (same phase across all pairs) is the mean-
      // reverting SPREAD that stretches them all together (forcing simultaneous opens).
      const common = 1000 * Math.exp(0.0003 * i + 0.2 * Math.sin(i / 23));
      const osc = 0.03 * Math.sin(i / 8);
      arr.push({ t: T0 + i * DAY, c: common * scale * (1 + sign * osc) });
    }
    return arr;
  };
  const dbs = {
    AA: mk(1.0, 1), AB: mk(0.6, -1), BA: mk(1.3, 1), BB: mk(0.9, -1),
    CA: mk(0.8, 1), CB: mk(1.1, -1), DA: mk(1.2, 1), DB: mk(0.7, -1),
  };
  const spec = { kind: 'PAIRS', name: 'wide', universe: Object.keys(dbs), lookback: 30, entryZ: 1.5, exitZ: 0.4, stopZ: 5, maxPairs: 4, formationBars: 15, minCorr: 0, gross: 0.95 };
  let maxNet = 0, opened = false;
  runPairsBacktest({
    spec, dataBySymbol: dbs, cash: 10_000_000, costBps: 5,
    _barHook: (engine) => {
      let net = 0, gross = 0;
      for (const k in engine.state.positions) { const p = engine.state.positions[k]; if (!p.qty) continue; const last = engine.state.lastPrices[k] || p.avgPrice; net += p.qty * last; gross += Math.abs(p.qty * last); }
      if (gross > 0) { opened = true; maxNet = Math.max(maxNet, Math.abs(net) / gross); }
    },
  });
  assert.ok(opened, 'the regression data should open some pairs');
  assert.ok(maxNet < 0.2, `book must stay ~market-neutral at every bar; worst |net|/gross was ${(maxNet * 100).toFixed(1)}% (a half-legged book would be near 100%)`);
});

test('PAIRS actually SHORTS (a sell-to-open appears in the trade log)', () => {
  const d = makeData();
  const res = runPairsBacktest({ spec: goodSpec(), dataBySymbol: d, recordTrades: true });
  assert.ok((res.trades || []).some((t) => /shorted/i.test(t.reason)), 'expected a short leg');
});

test('recordTrades yields a per-trade log with reasons and a decision with pairs', () => {
  const d = makeData();
  const res = runPairsBacktest({ spec: goodSpec(), dataBySymbol: d, recordTrades: true });
  assert.ok(Array.isArray(res.trades) && res.trades.length > 0);
  assert.ok(res.trades.every((t) => typeof t.reason === 'string'));
  assert.ok(res.decision && Array.isArray(res.decision.pairs));
  for (const p of res.decision.pairs) {
    assert.ok(typeof p.a === 'string' && typeof p.b === 'string' && p.a !== p.b);
    assert.ok(['flat', 'long spread', 'short spread'].includes(p.state));
  }
});

// --- selection --------------------------------------------------------------
test('selectPairs returns disjoint pairs, respects maxPairs and minCorr', () => {
  const d = makeData();
  // Build the priceGrid the same way runPairsBacktest does (via alignSeries indirectly):
  // easiest is to reuse the backtester's decision log, but selectPairs is pure on a grid.
  // Construct a simple grid from the raw closes (all symbols share the timeline here).
  const syms = UNIV;
  const grid = {};
  for (const s of syms) grid[s] = d[s].map((c) => c.c);
  const gi = grid.A.length - 1;
  const chosen = selectPairs(grid, syms, gi, { lookback: 30, minCorr: 0, maxPairs: 2 });
  assert.ok(chosen.length <= 2);
  const used = new Set();
  for (const p of chosen) {
    assert.ok(!used.has(p.a) && !used.has(p.b), 'pairs must be disjoint');
    used.add(p.a); used.add(p.b);
    assert.ok(p.beta > 0 && Number.isFinite(p.beta));
  }
  // An impossibly high correlation filter yields no pairs.
  const none = selectPairs(grid, syms, gi, { lookback: 30, minCorr: 0.999999, maxPairs: 2 });
  assert.equal(none.length, 0);
});

test('stat helpers: corr/olsSlope/ar1 are sane', () => {
  const x = [1, 2, 3, 4, 5], y = [2, 4, 6, 8, 10];
  assert.ok(Math.abs(corr(x, y) - 1) < 1e-9);     // perfectly correlated
  assert.ok(Math.abs(olsSlope(x, y) - 2) < 1e-9); // y = 2x
  // A mean-reverting series has AR(1) φ < 1.
  const s = []; for (let i = 0; i < 50; i++) s.push(Math.sin(i / 3));
  const phi = ar1(s);
  assert.ok(phi != null && phi < 1);
});

// --- evolution --------------------------------------------------------------
test('mutatePairs always yields a VALID PAIRS spec, deterministically', () => {
  const seed = goodSpec({ universe: ['A', 'B', 'C', 'D'] });
  for (let s = 1; s <= 50; s++) {
    const rng = mulberry32(s);
    const m1 = mutatePairs(JSON.parse(JSON.stringify(seed)), rng, UNIV);
    assert.equal(validateSpec(m1), null, `mutation seed ${s} invalid: ${validateSpec(m1)}`);
    // Same seed -> same mutation (determinism).
    const m2 = mutatePairs(JSON.parse(JSON.stringify(seed)), mulberry32(s), UNIV);
    assert.deepEqual(m1, m2);
  }
});

test('crossover of two PAIRS specs yields a valid PAIRS spec', () => {
  const a = goodSpec({ universe: ['A', 'B', 'C', 'D'], entryZ: 2, exitZ: 0.5 });
  const b = goodSpec({ universe: ['C', 'D', 'A', 'B'], entryZ: 2.5, exitZ: 0.3, lookback: 60 });
  for (let s = 1; s <= 20; s++) {
    const child = crossover(a, b, mulberry32(s));
    assert.ok(child && child.kind === 'PAIRS');
    assert.equal(validateSpec(child), null, `crossover seed ${s} invalid: ${validateSpec(child)}`);
  }
});

test('archetypeOf tags a PAIRS spec as "pairs"; scoreSpec scores it across the universe', () => {
  assert.equal(archetypeOf(goodSpec()), 'pairs');
  const d = makeData();
  const sc = scoreSpec(goodSpec(), null, '2 pairs', 10_000_000, d);
  assert.ok(sc && Number.isFinite(sc.sharpe) && Number.isFinite(sc.totalReturnPct));
});

// --- tournament integration -------------------------------------------------
test('a PAIRS bot runs end-to-end through the live tournament', async () => {
  const d = makeData(280);
  const seed = [
    { id: 'bh', name: 'Buy & Hold', kind: 'EQ', symbol: 'NIFTY', protected: true, spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 } },
    { id: 'pairs', name: 'Pairs', kind: 'PAIRS', spec: goodSpec() },
  ];
  // Offline: provide candles for every source the roster needs (NIFTY + the 4 names).
  const backfillData = { NIFTY: d.NIFTY, A: d.A, B: d.B, C: d.C, D: d.D };
  const t = await createTournament({ seed, backfillData, persist: false });
  await t.init();
  const s = t.getStandings();
  const row = s.bots.find((b) => b.id === 'pairs');
  assert.ok(row, 'pairs bot should be on the leaderboard');
  assert.ok(Number.isFinite(row.sharpe) && Number.isFinite(row.trackReturnPct) && Number.isFinite(row.liveReturnPct));
  assert.equal(row.kind, 'PAIRS');
  assert.match(row.symbol, /pairs/); // labelled "N pairs"
  // The per-bot detail page works: rationale + decision + a trade history.
  const det = t.getBotDetail('pairs');
  assert.equal(det.ok, true);
  assert.ok(det.rationale && det.rationale.headline);
  assert.ok(Array.isArray(det.trades));
  assert.ok(det.decision && Array.isArray(det.decision.pairs));
});

// --- regressions: the stop rail + honest close reasons ---------------------

// A pair whose spread BREAKS one way and never mean-reverts: from bar 150, A ramps
// +4%/bar up to a permanent +32% level shift vs its co-mover B. The rolling z rockets
// far past the ±4σ stop and stays there for many bars, decaying only as the window
// absorbs the new level. formationBars=100 pins the pair selection BEFORE the break
// (formed at bar 100, not re-screened until 200), so the z-machinery alone — not a
// re-formation drop — decides every trade through the broken stretch.
function breakData(n = 240) {
  const A = [], B = [], C = [], D = [], NIFTY = [];
  for (let i = 0; i < n; i++) {
    const t = T0 + i * DAY;
    const common = 1000 * Math.exp(0.0002 * i);
    const osc = 0.02 * Math.sin(i / 9); // too gentle to reach entryZ on its own
    const brk = i >= 150 ? Math.min(0.32, 0.04 * (i - 150)) : 0; // the one-way break
    const osc2 = 0.02 * Math.cos(i / 13);
    A.push({ t, c: common * (1 + osc + brk) });
    B.push({ t, c: common * 0.6 * (1 - osc) });
    C.push({ t, c: common * 1.3 * (1 + osc2) });
    D.push({ t, c: common * 0.9 * (1 - osc2) });
    NIFTY.push({ t, c: common });
  }
  return { A, B, C, D, NIFTY };
}

test('a stopped-out spread is NOT an entry: no pair ever opens at |z| >= stopZ (stop flip-flop regression)', () => {
  const res = runPairsBacktest({ spec: goodSpec({ formationBars: 100 }), dataBySymbol: breakData(), recordTrades: true });
  const trades = res.trades || [];
  // Every "Opened" reason cites the entry z ("z=+X.XXσ"). The entry gate must never
  // fire beyond the stop rail: before the fix, the bar after a ±4σ stop-out re-opened
  // the same pair at z far past 4 (|z| >= entryZ still held), flip-flopping open/close
  // every two bars and re-realising the loss while the spread stayed broken.
  const opens = trades.filter((tr) => /Opened/.test(tr.reason || ''));
  assert.ok(opens.length > 0, 'the scenario produces at least one entry');
  // The PRECISE lock: every "Opened" reason cites its entry z; none may be at/past the
  // stop rail. Measured on this exact dataset: the unfixed gate opened at |z| >= 4
  // twice (the re-entry into the still-broken spread); the fixed gate, zero times.
  for (const tr of opens) {
    const m = (tr.reason || '').match(/z=\+?(-?\d+(?:\.\d+)?)/);
    if (m) assert.ok(Math.abs(parseFloat(m[1])) < 4, `an entry must never trigger at |z| >= stopZ (opened at z=${m[1]}: "${tr.reason}")`);
  }
  assert.ok(Number.isFinite(res.metrics.finalEquity), 'metrics stay finite through the break');
});

test('a z-reversion close keeps its honest "convergence paid off" reason (close-reason regression)', () => {
  // Plain oscillating data: spreads open and REVERT, so closes here are genuine
  // z-reversion exits. The close pass used to stamp EVERY close with the generic
  // rotation text ("its pair is no longer selected"), leaving the honest reasons
  // ("convergence bet paid off" / "blew past the stop") as unreachable dead code.
  const res = runPairsBacktest({ spec: goodSpec(), dataBySymbol: makeData(), recordTrades: true });
  const trades = res.trades || [];
  const closes = trades.filter((tr) => /Closed/.test(tr.reason || ''));
  assert.ok(closes.length > 0, 'the oscillating data produces closes');
  assert.ok(
    closes.some((tr) => /convergence bet paid off|reverted to its mean/.test(tr.reason)),
    'at least one close carries the honest z-reversion reason'
  );
});
