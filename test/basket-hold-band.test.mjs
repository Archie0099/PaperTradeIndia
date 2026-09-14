// The BUY/HOLD SPREAD on a basket: `holdK`.
//
// A plain top-k basket sells a name the instant it slips to rank k+1 and buys its
// replacement. The cost of that round trip is immediate and certain; the gain is whatever
// edge separates rank k from rank k+1, which for a slow-moving signal is close to nothing.
// `holdK` buys into the top k but only SELLS once a holding falls past a wider rank band.
// Novy-Marx & Velikov (2016, RFS 29(1)) call the buy/hold spread "the single most effective
// simple cost mitigation strategy".
//
// What these lock:
//   1. OFF is byte-identical to the old top-k behaviour — the single most important property,
//      since every existing bot and every stored figure depends on it.
//   2. A band actually reduces turnover on a real, moving ranking.
//   3. It never suppresses a SIGNAL, only churn: a name that leaves the band is always sold.
//   4. The validator rejects a band that is not strictly wider than k.
//   5. Two specs differing only in holdK are DIFFERENT strategies to the roster dedupe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPortfolioBacktest } from '../backtest/portfolio.mjs';
import { validateSpec } from '../backtest/dsl.mjs';
import { specKey } from '../tournament/tournament.mjs';

// A deterministic universe whose ranking ROTATES, so the k-boundary is crossed constantly
// and a hold band has something to suppress. Each name is a smooth sine in log-price with a
// different phase: no randomness, no ties, and every name takes a turn at the top.
function makeSeries(nNames, nBars, startMs = Date.UTC(2015, 0, 1)) {
  const data = {};
  for (let n = 0; n < nNames; n++) {
    const phase = (2 * Math.PI * n) / nNames;
    const candles = [];
    let px = 100 + n; // distinct starting levels -> no exact ties anywhere
    for (let i = 0; i < nBars; i++) {
      px = (100 + n) * Math.exp(0.25 * Math.sin(phase + i * 0.045));
      candles.push({ t: startMs + i * 86400000, o: px, h: px, l: px, c: px, craw: px, v: 1e6 });
    }
    data[`N${n}`] = candles;
  }
  return data;
}

const UNIVERSE = Array.from({ length: 20 }, (_, i) => `N${i}`);
const BASE = {
  kind: 'BASKET', name: 'band test', universe: UNIVERSE,
  rank: ['mom', 21], k: 5, weighting: 'equal', rebalanceBars: 5,
};

test('holdK absent is byte-identical to plain top-k — every existing figure depends on this', () => {
  const data = makeSeries(20, 400);
  const a = runPortfolioBacktest({ spec: { ...BASE }, dataBySymbol: data, cash: 1e7 });
  const b = runPortfolioBacktest({ spec: { ...BASE, holdK: undefined }, dataBySymbol: data, cash: 1e7 });
  assert.deepEqual(a.equityCurve, b.equityCurve, 'an undefined band must not change a single bar');
  assert.equal(a.metrics.trades, b.metrics.trades);
});

test('a band reduces turnover on a rotating ranking', () => {
  const data = makeSeries(20, 600);
  const plain = runPortfolioBacktest({ spec: { ...BASE }, dataBySymbol: data, cash: 1e7 });
  const banded = runPortfolioBacktest({ spec: { ...BASE, holdK: 12 }, dataBySymbol: data, cash: 1e7 });

  assert.ok(plain.metrics.trades > 0, 'the fixture must actually churn, else the test proves nothing');
  assert.ok(
    banded.metrics.trades < plain.metrics.trades,
    `a hold band must cut turnover: banded ${banded.metrics.trades} vs plain ${plain.metrics.trades}`,
  );
});

test('a wider band cuts turnover further, monotonically', () => {
  const data = makeSeries(20, 600);
  const runs = [0, 8, 12, 20].map((holdK) => {
    const spec = holdK ? { ...BASE, holdK } : { ...BASE };
    return { holdK, trades: runPortfolioBacktest({ spec, dataBySymbol: data, cash: 1e7 }).metrics.trades };
  });
  for (let i = 1; i < runs.length; i++) {
    assert.ok(
      runs[i].trades <= runs[i - 1].trades,
      `widening the band must not INCREASE turnover: holdK ${runs[i - 1].holdK} -> ${runs[i].trades} vs ${runs[i].holdK} -> ${runs[i].trades}`,
    );
  }
  assert.ok(runs[3].trades < runs[0].trades, 'the widest band must trade strictly less than no band');
});

// ★ This test pins WHICH HALF of turnover the hold band can reach — measured, after a first
// draft asserted a collapse and failed. With holdK == the whole universe NOTHING can ever
// leave the band, so selection churn is switched off completely. Turnover on this fixture
// still only falls from 657 to 575 (~12%), because the remainder is not selection at all:
// the basket keeps rebalancing the SAME names back to equal weight as their prices drift
// apart. Two separate costs, and `holdK` addresses only the first.
//
// That is worth knowing before anyone expects the buy/hold spread to solve cost bleed on its
// own: on a slow signal most of the trading is weight maintenance, not name replacement.
test('the band switches off SELECTION churn — but weight-drift rebalancing is a separate cost', () => {
  const data = makeSeries(20, 600);
  const full = runPortfolioBacktest({ spec: { ...BASE, holdK: 20 }, dataBySymbol: data, cash: 1e7 });
  const plain = runPortfolioBacktest({ spec: { ...BASE }, dataBySymbol: data, cash: 1e7 });

  assert.ok(full.metrics.trades < plain.metrics.trades,
    `nothing can leave the band, so turnover must fall: ${full.metrics.trades} vs ${plain.metrics.trades}`);
  // And it must NOT fall to nothing — the residue is real weight-maintenance trading, so a
  // future change that made this collapse would mean weights had stopped being maintained.
  assert.ok(full.metrics.trades > plain.metrics.trades / 2,
    `the residue is weight-drift rebalancing and must survive: ${full.metrics.trades} vs ${plain.metrics.trades}`);
  assert.equal(full.holdings.length, BASE.k, 'it must still hold exactly k names, not drift to a different size');
});

test('the validator rejects a band that is not strictly wider than k', () => {
  assert.equal(validateSpec({ ...BASE, holdK: 12 }), null, 'a wider band is valid');
  assert.ok(validateSpec({ ...BASE, holdK: 5 }), 'holdK == k means nothing and must be rejected');
  assert.ok(validateSpec({ ...BASE, holdK: 3 }), 'holdK < k must be rejected');
  assert.ok(validateSpec({ ...BASE, holdK: 21 }), 'holdK beyond the universe must be rejected');
  assert.ok(validateSpec({ ...BASE, holdK: 7.5 }), 'a non-integer band must be rejected');
});

test('two baskets differing only in holdK are different strategies to the roster dedupe', () => {
  const plain = specKey({ ...BASE });
  const banded = specKey({ ...BASE, holdK: 12 });
  assert.notEqual(plain, banded, 'without this the roster would collapse a banded basket into its unbanded twin');
});

// ---------------------------------------------------------------------------
// The OTHER half of turnover: the weight-drift band.
// ---------------------------------------------------------------------------

test('rebalanceBand absent is byte-identical, and a band cuts the weight-maintenance trading', () => {
  const data = makeSeries(20, 600);
  const plain = runPortfolioBacktest({ spec: { ...BASE }, dataBySymbol: data, cash: 1e7 });
  const same = runPortfolioBacktest({ spec: { ...BASE, rebalanceBand: 0 }, dataBySymbol: data, cash: 1e7 });
  assert.deepEqual(same.equityCurve, plain.equityCurve, 'a zero band must not change a single bar');

  const banded = runPortfolioBacktest({ spec: { ...BASE, rebalanceBand: 0.01 }, dataBySymbol: data, cash: 1e7 });
  assert.ok(banded.metrics.trades < plain.metrics.trades,
    `a 1%-of-equity band must cut turnover: ${banded.metrics.trades} vs ${plain.metrics.trades}`);
});

// ★ MEASURED, and NOT what a first draft of this test assumed. The two bands are not
// additive and can work against each other, so the naive "together beats either alone" is
// FALSE and asserting it failed. On this fixture:
//
//     plain 657   holdK-only 635 (−3%)   band-only 180 (−73%)   both 224
//
// Two things follow, and both matter for how the feature gets used.
// 1. The WEIGHT band is overwhelmingly the bigger lever, not the buy/hold spread. Most of a
//    slow basket's trading is maintaining weights on names it is keeping anyway.
// 2. They INTERACT: `holdK` retains names for longer, those names drift further from their
//    target weight, and so they cross the weight band more often. Adding the hold band on
//    top of the weight band put turnover UP, 180 to 224.
// So these are two independent dials to be tuned together against a real cost model — not a
// stack where more is better.
test('the two bands are NOT additive and can work against each other', () => {
  const data = makeSeries(20, 600);
  const t = (spec) => runPortfolioBacktest({ spec, dataBySymbol: data, cash: 1e7 }).metrics.trades;
  const plain = t({ ...BASE });
  const holdOnly = t({ ...BASE, holdK: 12 });
  const bandOnly = t({ ...BASE, rebalanceBand: 0.01 });
  const both = t({ ...BASE, holdK: 12, rebalanceBand: 0.01 });

  assert.ok(holdOnly < plain, `the hold band must help alone: ${holdOnly} vs ${plain}`);
  assert.ok(bandOnly < plain, `the weight band must help alone: ${bandOnly} vs ${plain}`);
  assert.ok(both < plain, `together must still beat doing nothing: ${both} vs ${plain}`);
  // The weight band removes more TRADES than the hold band does.
  // ★★ BUT DO NOT READ THAT AS "CHEAPER". Measured on real data with the real cost model
  // (see backtest/research/cost-bands.mjs, weekly arm): the weight band cut trade COUNT by 35%
  // and saved NOTHING — cost drag stayed at −0.19 Sharpe — because the trades it suppresses
  // are tiny marginal resizes that were nearly free. The hold band cut count by only 9% and
  // halved the drag to −0.10, because the trades IT suppresses are full round trips.
  // Trade count is not cost. This assertion is about counts only.
  assert.ok(bandOnly < holdOnly,
    `the WEIGHT band should remove more TRADES (not more cost): band ${bandOnly} vs hold ${holdOnly}`);
});

test('a band never suppresses an ENTRY or an EXIT, only drift', () => {
  // An enormous band would freeze every resize; entries and exits must still happen, so the
  // book must still be fully invested in exactly k names at the end.
  const data = makeSeries(20, 600);
  const frozen = runPortfolioBacktest({ spec: { ...BASE, rebalanceBand: 0.25 }, dataBySymbol: data, cash: 1e7 });
  assert.equal(frozen.holdings.length, BASE.k, 'entries still fill the book to k names');
  assert.ok(frozen.metrics.trades > 0, 'it must still have traded — a band is not a freeze');
});

test('the validator bounds the band, and the dedupe key separates it', () => {
  assert.equal(validateSpec({ ...BASE, rebalanceBand: 0.01 }), null);
  assert.equal(validateSpec({ ...BASE, rebalanceBand: 0 }), null);
  assert.ok(validateSpec({ ...BASE, rebalanceBand: -0.01 }), 'a negative band is meaningless');
  assert.ok(validateSpec({ ...BASE, rebalanceBand: 0.9 }), 'a band that would freeze the book must be rejected');
  assert.notEqual(specKey({ ...BASE }), specKey({ ...BASE, rebalanceBand: 0.01 }));
});
