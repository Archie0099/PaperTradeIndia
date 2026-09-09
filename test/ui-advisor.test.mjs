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

function standings(advisor, persist) {
  return {
    startingCash: 1e7,
    advisor,
    persist,
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

const appWith = (dom, advisor, persist) => {
  const app = dom.makeApp({
    api: Object.assign(dom.makeApiStub(), {
      tournament: async () => standings(advisor, persist),
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

test('a name dropped MORE THAN ONE log-day ago still prices at the last recorded mark, not the cost basis (regression)', () => {
  // The panel only advances its assumed book while the Auto-Pilot tab is OPEN, and only
  // one suggestion date per render. So a name the champion dropped two suggestion-days
  // before the panel is next opened is in NEITHER today's targets NOR the previous entry's —
  // and it used to fall all the way back to what it was BOUGHT for. That mis-stated the
  // sell price, mis-scaled every other suggestion that day (the book's value sets the
  // capital ratio) and corrupted the persisted ledger for good. `marks` — the freshest
  // price the whole log ever recorded — closes the gap.
  const entry = { botName: 'X', equity: 1000, targets: [{ symbol: 'A', qty: 10, price: 50, weight: 0.5 }] };
  const book = { cash: 10, positions: [{ key: 'EQ:B', symbol: 'B', qty: 2, avg: 20 }] };
  const marks = { A: { price: 50, date: '2026-08-19' }, B: { price: 100, date: '2026-08-14' } };
  const rates = { buyRate: 0.001, sellRate: 0.001 };

  // WITHOUT marks (the old behaviour) B prices at its ₹20 cost basis and the A buy starves.
  const bad = computeSuggestions({ entry, prev: null, book, costRates: rates });
  assert.equal(bad.orders[0].price, 20, 'baseline: the un-marked path still falls back to cost');
  assert.equal(bad.valueBefore, 50);

  // WITH marks the sell is priced honestly and everything else scales off the right value.
  const res = computeSuggestions({ entry, prev: null, marks, book, costRates: rates });
  const sell = res.orders.find((o) => o.symbol === 'B');
  assert.equal(sell.price, 100, 'the sell references the last recorded mark');
  assert.equal(sell.value, 200);
  assert.equal(res.valueBefore, 210, 'the book is valued at the recorded mark, not the cost basis');
  assert.equal(sell.label, 'Exit B: sell 2 @ ~₹100.00 (last recorded price, 2026-08-14 — check the live quote)');
  assert.equal(sell.priceAsOf, '2026-08-14');
  const buy = res.orders.find((o) => o.symbol === 'A');
  assert.ok(buy && !buy.skipped && buy.shares >= 2, 'the A buy is funded by the correctly-priced sale');
  assert.equal(buy.priceAsOf, null, 'a name priced from TODAY carries no stale-price note');

  // A single STAND-ASIDE day empties prev.targets — the same hole, same fix.
  const standAside = computeSuggestions({ entry, prev: { eligible: false, targets: [] }, marks, book, costRates: rates });
  assert.equal(standAside.orders.find((o) => o.symbol === 'B').price, 100);
  assert.equal(standAside.valueBefore, 210);
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
  // The honesty check must carry BOTH statements. The SETTLED one first — a reader placing
  // real money must not have to derive it from two Sharpe numbers — and the UNPROVEN one
  // second, clearly separated. The panel previously stated only the hedge and propped it up
  // with the whole-universe comparison, which differs in signal, gate AND holdings count and
  // therefore cannot support any claim about selection.
  assert.match(txt, /simply holding the whole universe would have done BETTER than the strategy/, 'the SETTLED finding is stated outright, not left as arithmetic');
  assert.match(txt, /index-beating history is NOT proof of stock-picking skill/i, 'and its consequence');
  assert.match(txt, /Whether its stock SELECTION adds anything is a separate question, and it is UNPROVEN/, 'the unproven half is separated from the settled half');
  assert.match(txt, /inside the noise band/, 'and says WHY it is unproven (a noise band), never that the sign flips');
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

test('the trust banner says how fast the clock is ACTUALLY ticking, not just N of 90', async () => {
  // A suggestion is only recorded while the server is awake to see that day's close, and a
  // free host sleeps. "5 of 90 days" then reads as an 85-day wait when the real pace is a
  // fraction of that — and missed days are never back-filled, so it never catches up.
  const dom = setupDom();
  const adv = advisorPayload({ logDays: 5, coverage: { since: '2026-08-05', recordedDays: 5, possibleDays: 24, ratio: 0.208 } });
  const app = appWith(dom, adv);
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /5 of 90 days/, 'the raw count still shows');
  assert.match(txt, /5 of the 24 trading days since 2026-08-05/, 'and the real pace beside it');
  assert.match(txt, /never filled in afterwards/i, 'and that the gap is permanent, not a backlog');
});

test('a fully-recorded log shows no pace caveat (it is only shown when actually behind)', async () => {
  const dom = setupDom();
  const adv = advisorPayload({ logDays: 5, coverage: { since: '2026-08-05', recordedDays: 5, possibleDays: 5, ratio: 1 } });
  const app = appWith(dom, adv);
  initAutoPilot(app);
  await renderAutoPilot(app);
  assert.ok(!/trading days since/i.test(dom.$('#ap-suggestions').textContent), 'no caveat when nothing was missed');
});

test('an unreadable remote store is SAID OUT LOUD on the panel — a silent one hid for three weeks', async () => {
  // The panel's whole claim is a log that ACCUMULATES. When the store cannot be read the
  // server refuses to write, so today's suggestion is never recorded and every restart drops
  // the log — but the only signal was a payload field no screen displayed. The storage
  // credential expires on a schedule, so this recurs; it must be visible where it matters.
  const dom = setupDom();
  const app = appWith(dom, advisorPayload(), { enabled: true, attempted: true, restored: false, readFailed: true });
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /not being saved/i, 'the panel states the record is not being kept');
  assert.match(txt, /resets/i, 'and that a restart loses the run of days');
  assert.match(txt, /nothing already saved is lost/i, 'while making clear the stored copy is safe');
  assert.match(txt, /token/i, 'and points at the usual cause');
});

test('a HEALTHY store shows no such warning (the banner is not permanent furniture)', async () => {
  const dom = setupDom();
  const app = appWith(dom, advisorPayload(), { enabled: true, attempted: true, restored: true, readFailed: false });
  initAutoPilot(app);
  await renderAutoPilot(app);
  assert.ok(!/not being saved/i.test(dom.$('#ap-suggestions').textContent), 'no warning when the store reads fine');
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

// the banner used to be gated on `readFailed` ALONE, so a store that read fine
// but could not be WRITTEN lost today's suggestion just as completely — and said nothing.
test('an UNWRITABLE store warns too, with its own wording (not the fail-closed one)', async () => {
  const dom = setupDom();
  const app = appWith(dom, advisorPayload(), { enabled: true, attempted: true, restored: true, readFailed: false, writeFailed: true });
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /not being saved/i, 'the panel still states the record is not being kept');
  assert.match(txt, /last attempt to SAVE failed/i, 'and says it is the WRITE that failed, not the read');
  assert.match(txt, /not growing/i, 'the stored copy is intact, it just is not accumulating');
  assert.ok(!/refused/i.test(txt), 'it must NOT claim saving was refused on purpose — that is the readFailed case');
});

// ---------------------------------------------------------------------------
// the real-capital panel answers the two risk questions IN RUPEES on
// the assumed book, scaled from the champion’s board-row VaR/ES, and says whose
// risk it is and how the VaR has been back-testing.
// ---------------------------------------------------------------------------
const withChampRisk = (dom, risk) => {
  const adv = advisorPayload();
  const app = dom.makeApp({
    api: Object.assign(dom.makeApiStub(), {
      tournament: async () => { const s = standings(adv, undefined); s.bots[0].risk = risk; return s; },
      tournamentBot: async (id) => ({ ok: true, id, name: "Sharpe King", mirror: { followable: true, equity: 1.08e7, positions: [] } }),
    }),
  });
  app.engine.reset(10_000_000);
  return app;
};
const rupees = (txt, re) => { const m = txt.match(re); return m ? Number(m[1].replace(/,/g, "")) : NaN; };

test("the real-capital panel states tomorrow’s VaR and ES in rupees on the assumed book", async () => {
  const dom = setupDom();
  const risk = { conf: 0.99, window: 500, var1dPct: 2.13, es1dPct: 3.41, var10dPct: 6.74,
    backtest: { exceptions: 7, days: 250, expected: 2.5, kupiec: 5.21, kupiecReject: true, zone: "yellow", mc: 3.65 } };
  const app = withChampRisk(dom, risk);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show("autopilot"); // the click handler re-renders only a VISIBLE tab
  dom.setPrompt("25"); // the drawdown-tolerance question; null would abort the capital step
  dom.$("#adv-capital").value = "1000000";
  dom.fire(dom.$("#adv-capital-set"), "click");
  await new Promise((r) => setTimeout(r, 0));
  const txt = dom.$("#ap-suggestions").textContent;
  assert.match(txt, /Tomorrow’s risk on this ₹[\d,]+: with 99% confidence you should not lose more than ₹[\d,]+ \(one-day VaR, 2\.13%\); if you do, expect to lose about ₹[\d,]+ \(expected shortfall, 3\.41%\)\. Historical simulation on the champion’s last 500 trading days\./, "the two questions, in rupees, with the method and window");
  assert.match(txt, /Its VaR back-test over the last 250 days: 7 exceptions vs 2\.5 expected \(yellow zone\)\./, "and how that VaR has been back-testing");
  // The rupee figures must be the book value scaled by the percentages — check the ARITHMETIC,
  // not a hard-coded value (the book value depends on the applied suggestions).
  const value = rupees(txt, /Tomorrow’s risk on this ₹([\d,]+):/);
  const varRs = rupees(txt, /not lose more than ₹([\d,]+)/);
  const esRs = rupees(txt, /expect to lose about ₹([\d,]+)/);
  assert.ok(value > 0 && Math.abs(varRs - value * 0.0213) <= 1, `VaR ₹ = value × 2.13% (value ${value}, got ${varRs})`);
  assert.ok(Math.abs(esRs - value * 0.0341) <= 1, `ES ₹ = value × 3.41% (got ${esRs})`);
  assert.ok(esRs > varRs, "ES is never below VaR");
});

test("a RED back-test zone tells you to trust that VaR least; no risk block → no risk line", async () => {
  const dom = setupDom();
  const red = { conf: 0.99, window: 500, var1dPct: 1.5, es1dPct: 2.4, var10dPct: 4.7,
    backtest: { exceptions: 12, days: 250, expected: 2.5, kupiec: 19.3, kupiecReject: true, zone: "red", mc: 4 } };
  const app = withChampRisk(dom, red);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show("autopilot"); // the click handler re-renders only a VISIBLE tab
  dom.setPrompt("25"); // the drawdown-tolerance question; null would abort the capital step
  dom.$("#adv-capital").value = "1000000";
  dom.fire(dom.$("#adv-capital-set"), "click");
  await new Promise((r) => setTimeout(r, 0));
  assert.match(dom.$("#ap-suggestions").textContent, /12 exceptions vs 2\.5 expected \(red zone — this VaR is being breached far too often; trust it least\)\./, "the red-zone warning");

  const dom2 = setupDom();
  const app2 = withChampRisk(dom2, null);
  initAutoPilot(app2);
  await renderAutoPilot(app2);
  app2.tabs.show("autopilot");
  dom2.setPrompt("25");
  dom2.$("#adv-capital").value = "1000000";
  dom2.fire(dom2.$("#adv-capital-set"), "click");
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(!/Tomorrow’s risk/.test(dom2.$("#ap-suggestions").textContent), "no champion risk block → the line is simply absent");
});

test("a WIPED champion gets no rupee VaR — the panel refuses to size a total loss and says why (review finding)", async () => {
  const dom = setupDom();
  const wiped = { conf: 0.99, window: 500, wiped: true, var1dPct: 100, es1dPct: 100, var10dPct: 100,
    backtest: { exceptions: 1, days: 250, expected: 2.5, kupiec: 1.32, kupiecReject: false, zone: "green", mc: 3 } };
  const app = withChampRisk(dom, wiped);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show("autopilot");
  dom.setPrompt("25");
  dom.$("#adv-capital").value = "1000000";
  dom.fire(dom.$("#adv-capital-set"), "click");
  await new Promise((r) => setTimeout(r, 0));
  const txt = dom.$("#ap-suggestions").textContent;
  assert.match(txt, /Tomorrow’s risk on this ₹[\d,]+: not quantifiable — the champion’s last 500 trading days include a TOTAL LOSS, so a rupee VaR is not a meaningful figure for it\. Treat the downside of following it as unbounded, and re-read the honesty check above\./, "a warning, not a number");
  assert.ok(!/not lose more than ₹/.test(txt), "and NO rupee VaR/ES figure is printed for a wiped champion");
});
