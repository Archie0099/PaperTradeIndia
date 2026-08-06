// ---------------------------------------------------------------------------
// test/ui-advisor.test.mjs
// jsdom tests for the "Today's Suggestions" panel (real-money guidance,
// suggestion-only) on the Auto-Pilot tab, plus the pure suggestion-scaling
// maths. Drives the REAL autopilot.js against the real index.html. Locks the
// four panel states (warming-up / trust banner / excluded champion / normal),
// the first-use capital + drawdown-tolerance flow, the affordability cap, and
// that the panel NEVER touches the paper engine account (suggestion-only).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { initAutoPilot, renderAutoPilot, computeSuggestions, weightDiffLines } from '../public/js/ui/autopilot.js';

const curve = Array.from({ length: 10 }, (_, i) => ({ t: i * 864e5, c: 1e7 + i * 1000 }));
const advisorPayload = (over = {}) => ({
  minDays: 90,
  logDays: 3,
  ready: false,
  today: {
    date: '2026-08-04', t: Date.parse('2026-08-04'), botId: 'b', botName: 'Sharpe King', kind: 'BASKET', eligible: true, reason: null, equity: 1.08e7,
    targets: [
      { symbol: 'RELIANCE', qty: 1800, price: 3000, weight: 0.5 },
      { symbol: 'TCS', qty: 1500, price: 3600, weight: 0.5 },
    ],
  },
  prev: {
    date: '2026-08-03', t: Date.parse('2026-08-03'), botId: 'b', botName: 'Sharpe King', kind: 'BASKET', eligible: true, reason: null, equity: 1.07e7,
    targets: [{ symbol: 'RELIANCE', qty: 1800, price: 2900, weight: 1 }],
  },
  track: { days: 3, from: '2026-08-01', to: '2026-08-04', retPct: 1.2, niftyPct: 0.8, universeEqPct: 1.5, estCostPct: 0.05, maxDrawdownPct: 2, currentDrawdownPct: 0.5, curve: [], niftyCurve: [], universeCurve: [] },
  costRates: { buyRate: 0.001686, sellRate: 0.001536 },
  benchmarkFinding: { measuredAt: '2026-08-05', window: '2020-01-01 → data end', reproduce: 'node backtest/research/universe-bench.mjs', measuredFor: 'b', measuredForName: 'Sharpe King', indexSharpe: 0.41, universeVolinvSharpe: 0.87, universeEqualSharpe: 0.91, championStrategySharpe: 0.59, edgeVsUniverse: -0.32, verdict: 'trails-universe' },
  ...over,
});

function standings(advisor) {
  return {
    startingCash: 1e7,
    advisor,
    autopilot: {
      startedAt: Date.parse('2010-01-01'), cash: 1e7,
      metrics: { finalEquity: 2.5e7, liveReturnPct: 0.3, r1w: 1, r1m: 3, r1y: -13.6, r3y: 50, r5y: 90, r10y: 140, trackReturnPct: 150, sharpe: 1.1, maxDrawdownPct: 42.6 },
      benchMetrics: { finalEquity: 1.8e7, liveReturnPct: 0.2, r1w: 0.8, r1m: 2, r1y: -3.4, r3y: 35, r5y: 60, r10y: 90, trackReturnPct: 80, sharpe: 0.6, maxDrawdownPct: 38 },
      benchName: 'Buy & Hold', vsMarketPct: 70,
      currentBot: { id: 'b', name: 'Sharpe King', kind: 'BASKET', symbol: '8 stocks', holdings: [] },
      curve, benchCurve: curve, followedTimeline: [],
    },
    bots: [
      { id: 'b', name: 'Sharpe King', symbol: '8 stocks', kind: 'BASKET', sharpe: 1.5, r1y: 12, trackReturnPct: 80, position: 'RELIANCE 50% · TCS 50%', explain: 'A local-ML basket.', equity: 1.08e7, curve },
    ],
  };
}

const appWith = (dom, advisor) => {
  const app = dom.makeApp({
    api: Object.assign(dom.makeApiStub(), {
      tournament: async () => standings(advisor),
      tournamentBot: async (id) => ({ ok: true, id, name: 'Sharpe King', mirror: { followable: true, equity: 1.08e7, positions: [] } }),
    }),
  });
  app.engine.reset(10_000_000);
  return app;
};

// --- pure maths --------------------------------------------------------------

test('computeSuggestions scales the recorded book to the capital via the REAL diff machinery', () => {
  const entry = { botName: 'X', equity: 1000, targets: [{ symbol: 'A', qty: 10, price: 50, weight: 0.5 }] };
  const book = { cash: 100, positions: [] };
  const res = computeSuggestions({ entry, book, costRates: { buyRate: 0.001, sellRate: 0.001 } });
  assert.equal(res.orders.length, 1);
  const o = res.orders[0];
  // scale = 100/1000 → target 1 whole share of A.
  assert.deepEqual([o.symbol, o.side, o.shares, o.price], ['A', 'BUY', 1, 50]);
  assert.equal(o.estCost, 50 * 0.001);
  assert.equal(res.bookAfter.positions[0].qty, 1);
  assert.ok(Math.abs(res.bookAfter.cash - (100 - 50 - 0.05)) < 0.01, 'cash pays the price plus the estimated cost');
});

test('computeSuggestions: a dropped name is SOLD first (funds-freeing order), with sell-side costs', () => {
  const entry = { botName: 'X', equity: 1000, targets: [{ symbol: 'A', qty: 10, price: 50, weight: 0.5 }] };
  const book = { cash: 10, positions: [{ key: 'EQ:B', symbol: 'B', qty: 2, avg: 20 }] };
  const res = computeSuggestions({ entry, book, costRates: { buyRate: 0.001, sellRate: 0.001 } });
  assert.equal(res.orders[0].side, 'SELL', 'the exit comes FIRST (frees funds before buys)');
  assert.match(res.orders[0].label, /Exit B/);
  assert.equal(res.orders[0].shares, 2);
  const after = res.bookAfter;
  assert.ok(!after.positions.find((p) => p.symbol === 'B'), 'B is gone from the assumed book');
});

test('computeSuggestions: a buy the cash cannot fund is CLIPPED and flagged capped — never overdrawn', () => {
  const entry = { botName: 'X', equity: 1000, targets: [{ symbol: 'A', qty: 100, price: 50, weight: 1 }] };
  // Value ≈ 120 → target = round(100 × 120/1000) = 12 shares (₹600) but cash is only ₹120.
  const book = { cash: 120, positions: [] };
  const res = computeSuggestions({ entry, book, costRates: { buyRate: 0.001, sellRate: 0.001 } });
  const o = res.orders[0];
  assert.equal(o.capped, true);
  assert.equal(o.shares, 2, 'clipped to what the cash affords (incl. est. costs)');
  assert.ok(res.bookAfter.cash >= 0, 'the assumed book never goes negative');
});

test('a name the champion DROPPED is priced at yesterday’s recorded price, never the stale cost basis (regression)', () => {
  // The book bought B long ago at ₹20; it now trades ~₹100 (yesterday's recorded mark).
  // The champion drops it today. The sell suggestion must reference ₹100 — pricing it
  // at the ₹20 cost basis would mis-state the order AND mis-scale everything else.
  const entry = { botName: 'X', equity: 1000, targets: [] };
  const prev = { targets: [{ symbol: 'B', qty: 2, price: 100, weight: 0.4 }] };
  const book = { cash: 10, positions: [{ key: 'EQ:B', symbol: 'B', qty: 2, avg: 20 }] };
  const res = computeSuggestions({ entry, prev, book, costRates: { buyRate: 0.001, sellRate: 0.001 } });
  assert.equal(res.orders[0].price, 100, 'the sell references yesterday’s recorded price');
  assert.match(res.orders[0].label, /@ ~₹100\.00/);
  assert.ok(Math.abs(res.bookAfter.cash - (10 + 200 - 0.2)) < 0.01, 'proceeds credit the market value, not the cost basis');
  assert.equal(res.valueBefore, 210, 'the book is valued at the recorded mark');
});

test('weightDiffLines describes the change vs yesterday in plain English', () => {
  const prev = { targets: [{ symbol: 'A', weight: 0.6 }, { symbol: 'B', weight: 0.4 }] };
  const today = { targets: [{ symbol: 'A', weight: 0.3 }, { symbol: 'C', weight: 0.7 }] };
  const lines = weightDiffLines(prev, today);
  assert.ok(lines.some((l) => /Trim A/.test(l)));
  assert.ok(lines.some((l) => /New: C/.test(l)));
  assert.ok(lines.some((l) => /Exit B/.test(l)));
});

// --- panel states ------------------------------------------------------------

test('warming-up: no advisor payload → the panel says so and claims nothing', async () => {
  const dom = setupDom();
  const app = appWith(dom, undefined);
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /never places a real order/i, 'the suggestion-only pledge always renders');
  assert.match(txt, /warming up/i);
});

test('the trust banner counts the no-hindsight days and the honesty check states the fair-benchmark verdict', async () => {
  const dom = setupDom();
  const app = appWith(dom, advisorPayload());
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /3 of 90 days/, 'the trust clock');
  assert.match(txt, /selection edge over a fair benchmark is unproven/i, 'the fair-benchmark honesty copy');
  assert.match(txt, /0\.59/, 'quotes the measured champion figure');
  assert.match(txt, /max drawdown 42\.6%/i, 'live risk context read from the payload, not a stored number');
  // The walk-forward metrics arrive ALREADY in percent (r1y: -13.6 means -13.6%) —
  // exactly how the vs-market table shows them. Lock the correct rendering (never
  // percent-of-percent).
  assert.match(txt, /last 1Y -13\.6% vs market -3\.4%/, 'the 1Y figures render in percent, not percent-of-percent');
  assert.match(txt, /RELIANCE/, 'today’s target book renders');
  assert.match(txt, /Trim RELIANCE|Increase|New:/, 'the plain-English change vs yesterday');
  assert.match(txt, /Forward score/, 'the forward score line renders');
  assert.match(txt, /equal-weight universe \+1\.50%/, 'scored against the fair bar, not just NIFTY');
});

test('an excluded (F&O) champion shows the stand-aside state with its reason — no scaling offered', async () => {
  const dom = setupDom();
  const adv = advisorPayload({ today: { date: '2026-08-04', t: Date.parse('2026-08-04'), botId: 'f', botName: 'Strangle', kind: 'FNO', eligible: false, reason: 'the champion is an options (F&O) bot — its option prices are modelled/indicative, so honest rupee suggestions for hand-placed real orders are not possible', equity: 1e7, targets: [] }, prev: null });
  const app = appWith(dom, adv);
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /Stand aside today/i);
  assert.match(txt, /modelled\/indicative/, 'the exclusion reason is stated, not hidden');
  assert.ok(!dom.$('#adv-capital'), 'no capital input in the stand-aside state');
});

test('the capital flow: first use asks for a drawdown tolerance, scales to whole shares, and never touches the engine', async () => {
  const dom = setupDom();
  const app = appWith(dom, advisorPayload());
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');

  dom.setPrompt('25'); // the max-drawdown tolerance answer
  dom.$('#adv-capital').value = '500000';
  dom.fire(dom.$('#adv-capital-set'), 'click');
  await new Promise((r) => setTimeout(r, 0));

  const stored = JSON.parse(localStorage.getItem('paper-trade-india:advisor'));
  assert.equal(stored.capital, 500000);
  assert.equal(stored.ddTolerancePct, 25, 'the tolerance is asked once and stored');
  assert.equal(stored.book.lastAppliedDate, '2026-08-04', 'today’s suggestions were applied to the assumed book');

  const txt = dom.$('#ap-suggestions').textContent;
  // scale = 500000/1.08e7 → RELIANCE round(1800×scale) = 83, TCS round(1500×scale) = 69.
  assert.match(txt, /buy 83/i, 'whole-share sizing for RELIANCE');
  assert.match(txt, /buy 69/i, 'whole-share sizing for TCS');
  assert.match(txt, /Est\. cost/i, 'each action carries an estimated real cost');
  assert.match(txt, /your 25% tolerance/i, 'the drawdown is shown against the stored tolerance');
  assert.equal(Object.keys(app.engine.state.positions).length, 0, 'SUGGESTION-ONLY: the paper engine account is untouched');
});

test('a too-small capital produces a skipped, capped suggestion — never an unfundable order', async () => {
  const dom = setupDom();
  const app = appWith(dom, advisorPayload());
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');

  dom.setPrompt('25');
  dom.$('#adv-capital').value = '5000'; // one RELIANCE share fits; the TCS share then can't be funded
  dom.fire(dom.$('#adv-capital-set'), 'click');
  await new Promise((r) => setTimeout(r, 0));

  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /can't be funded|clipped/i, 'the shortfall is stated, not silently dropped');
});

test('when the champion is NOT the measured strategy, the honesty check degrades — no mis-attribution (regression)', async () => {
  const dom = setupDom();
  const adv = advisorPayload();
  adv.benchmarkFinding = { ...adv.benchmarkFinding, measuredFor: 'xsmom-research', measuredForName: 'Cross-sectional momentum (12-1)' };
  const app = appWith(dom, adv);
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /measured .* for Cross-sectional momentum/i, 'names WHO the numbers were measured for');
  assert.match(txt, /has NOT been measured/i, 'says the current champion was not measured');
  assert.match(txt, /unproven/i, 'still refuses to claim skill');
});

test('a corrupt stored book is rebuilt fresh — the tab render never throws (regression)', async () => {
  const dom = setupDom();
  localStorage.setItem('paper-trade-india:advisor', JSON.stringify({ capital: 500000, ddTolerancePct: 25, book: 'garbage' }));
  const app = appWith(dom, advisorPayload());
  initAutoPilot(app);
  await renderAutoPilot(app); // would TypeError on cash.toFixed without the shape guard
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /buy 83/i, 'the panel recovered with a fresh book and scaled today’s suggestions');
  const stored = JSON.parse(localStorage.getItem('paper-trade-india:advisor'));
  assert.ok(Number.isFinite(stored.book.cash), 'the rebuilt book is well-formed');
});

test('"Change / clear capital" resets the panel back to the weight-level view', async () => {
  const dom = setupDom();
  const app = appWith(dom, advisorPayload());
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');
  dom.setPrompt('25');
  dom.$('#adv-capital').value = '500000';
  dom.fire(dom.$('#adv-capital-set'), 'click');
  await new Promise((r) => setTimeout(r, 0));
  window.confirm = () => true;
  dom.fire(dom.$('#adv-capital-clear'), 'click');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(JSON.parse(localStorage.getItem('paper-trade-india:advisor')).capital, null);
  assert.ok(dom.$('#adv-capital'), 'the capital input is back');
});
