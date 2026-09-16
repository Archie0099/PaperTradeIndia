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

// asOf PINS THE PAYLOAD CLOCK. The suggestions panel measures how many trading sessions have
// closed since the recorded entry, and it reads that "now" from the payload rather than the
// browser — so a fixture must state it, or every advisor test would drift day by day and start
// failing on its own schedule. 2026-08-05 is the day after the fixture's entry (2026-08-04),
// i.e. nothing missed, which is what the pre-existing tests assume.
function standings(advisor, persist, asOf = Date.parse('2026-08-05T06:00:00Z'), now = asOf, syntheticKeys = []) {
  return {
    asOf,
    now,
    syntheticKeys,
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

const appWith = (dom, advisor, persist, asOf, now, syntheticKeys) => {
  const app = dom.makeApp({
    api: Object.assign(dom.makeApiStub(), {
      tournament: async () => standings(advisor, persist, asOf, now, syntheticKeys),
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
  // Reworded deliberately: the entry it describes can be days old, so calling it "today" was
  // wrong. It now names the recorded date.
  assert.match(txt, /Stand aside on 2026-08-04./);
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

// ---------------------------------------------------------------------------
// STALENESS. The server records a suggestion only when it is awake AND the feed has published
// that session's close, and the measured capture rate is well under half — so the entry on
// screen is often not the latest session. The panel used to call it "today" regardless.
// ---------------------------------------------------------------------------

test('a suggestion with finished sessions behind it is labelled STALE, with the count', async () => {
  const dom = setupDom();
  // Entry 2026-08-04 (Tue), payload clock 2026-08-12 (Wed). Sessions strictly between:
  // Wed 5th, Thu 6th, Fri 7th, Mon 10th, Tue 11th = 5. The 8th/9th are a weekend, and the
  // 12th itself is excluded because its session may still be running.
  const app = appWith(dom, advisorPayload(), undefined, Date.parse('2026-08-12T06:00:00Z'));
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /These suggestions are from 2026-08-04\. 5 trading sessions have closed since then with no new suggestion recorded, so they do not reflect those sessions\. Prices and weights below are as at 2026-08-04 — check live quotes before acting on them\./,
    'it names the date, counts the finished sessions, and says the prices are as at that date');
});

test('the staleness banner does NOT fire across a weekend, when nothing was actually missed', async () => {
  // The control, and the reason the count is sessions rather than calendar days: a Friday
  // suggestion read on Monday is three days old with nothing missed at all. Counting days
  // would cry wolf every weekend and train the reader to ignore the warning.
  const dom = setupDom();
  const friday = advisorPayload({ today: { ...advisorPayload().today, date: '2026-08-07' } });
  const app = appWith(dom, friday, undefined, Date.parse('2026-08-10T06:00:00Z')); // Monday
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.ok(!/trading session/.test(txt), 'no staleness banner over a plain weekend');
  assert.match(txt, /recorded 2026-08-07/, 'but the recorded date is still stated plainly');
});

test('a market HOLIDAY between the entry and now does not count as a missed session', async () => {
  // 2026-08-15 (Independence Day) is a Saturday in 2026, so use a listed weekday holiday:
  // the panel reads the SAME holiday list the rest of the app does, rather than re-deriving one.
  const dom = setupDom();
  const before = advisorPayload({ today: { ...advisorPayload().today, date: '2026-09-11' } });
  // 12th/13th weekend, 14th Ganesh Chaturthi (a listed holiday), 15th excluded as "today".
  const app = appWith(dom, before, undefined, Date.parse('2026-09-15T06:00:00Z'));
  initAutoPilot(app);
  await renderAutoPilot(app);
  assert.ok(!/trading session/.test(dom.$('#ap-suggestions').textContent),
    'a weekend plus a holiday is not a missed session');
});

test('staleness is measured from `now`, not `asOf` — a stalled recompute must not hide a missed session', async () => {
  // A review caught the original rationale being backwards. `asOf` is the last RECOMPUTE time, and
  // a recompute needs a NEW bar — so across a weekend, or whenever the feed withholds a close,
  // `asOf` stalls in lockstep with the very log whose staleness this measures. Here the board last
  // recomputed on 08-05 (entry day + 1, nothing missed by that clock) while the real time is
  // 08-12. Reading `asOf` renders no banner at all; reading `now` correctly reports 5 sessions.
  const dom = setupDom();
  const app = appWith(dom, advisorPayload(), undefined,
    Date.parse('2026-08-05T06:00:00Z'),   // asOf: the stalled recompute
    Date.parse('2026-08-12T06:00:00Z'));  // now: stamped per response
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /5 trading sessions have closed since then/,
    'the banner counts from the per-response clock, not the stalled recompute stamp');
});

test('a year OUTSIDE the maintained holiday list gives an upper bound, never a session count', async () => {
  // The holiday list is hand-updated one year at a time. Beyond its coverage every holiday looks
  // like a trading day, and on THIS panel asserting in words that a session closed with no
  // guidance — when the exchange was simply shut — would be an invented warning.
  //
  // ★ THIS TEST USED TO REQUIRE COMPLETE SILENCE, and that was changed deliberately after a review
  // measured the blast radius of the silence. The skip applied to every weekday in an uncovered
  // year, not just to holidays: ~250 trading days suppressed to avoid ~15 false claims, so from
  // the day the list lapsed this banner could never fire again until somebody hand-updated it —
  // on the panel used to size real orders, where a reader told nothing concludes nothing was
  // missed. The honest answer is neither the count nor silence. It is the upper bound, plus the
  // reason it is only a bound.
  const dom = setupDom();
  const entry = advisorPayload({ today: { ...advisorPayload().today, date: '2029-01-01' } });
  const app = appWith(dom, entry, undefined,
    Date.parse('2029-01-10T06:00:00Z'), Date.parse('2029-01-10T06:00:00Z'));
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  // Six weekdays fall strictly between 01-01 and 01-10 (today is never counted); none can be
  // judged, because the list stops at 2026.
  assert.match(txt, /These suggestions are from 2029-01-01\. 6 weekdays have passed since then with no new suggestion recorded — at most that many trading sessions, because the exchange-holiday list ends at 2026 and cannot say which of 6 of them the market was shut for\./,
    'the banner states the bound, the count it cannot make, and why');
  assert.ok(!/\d+ trading sessions have closed since then/.test(txt),
    'it must NOT assert a definite number of missed sessions outside the list’s coverage');
});

test('a window STRADDLING the end of the holiday list counts both halves honestly', async () => {
  // The case that will actually occur, on the first working day of the year the list runs out: a
  // late-December entry read in January. Three weekdays fall inside the list's coverage and three
  // outside it, and the banner must fold them into one bound rather than reporting only the half
  // it happens to be sure about (which would understate) or all six as sessions (which would
  // overstate on the panel someone sizes real orders from).
  const dom = setupDom();
  const entry = advisorPayload({ today: { ...advisorPayload().today, date: '2026-12-28' } });
  const app = appWith(dom, entry, undefined,
    Date.parse('2027-01-06T06:00:00Z'), Date.parse('2027-01-06T06:00:00Z'));
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /6 weekdays have passed since then/, 'both halves are in the bound');
  assert.match(txt, /cannot say which of 3 of them the market was shut for/,
    'only the three January weekdays are unjudged — the December ones the list still covers');
});

test('the action list names the suggestion date instead of calling it "today"', async () => {
  const dom = setupDom();
  const app = appWith(dom, advisorPayload());
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');
  dom.setPrompt('25');
  dom.$('#adv-capital').value = '1000000';
  dom.fire(dom.$('#adv-capital-set'), 'click');
  await new Promise((r) => setTimeout(r, 0));
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /From the 2026-08-04 suggestion, scaled to your ₹10,00,000/,
    'the scaled action list says which day it came from');
  assert.ok(!/No actions today/.test(txt), 'and never says "today" about a recorded date');
});

test('the EMPTY action list also names the date rather than saying "today"', async () => {
  // Reaching the empty branch needs a state that genuinely produces no orders: an ELIGIBLE
  // champion sitting in cash (targets: []) against a fresh book with nothing to sell. The
  // previous test covers the populated list; this one covers the sentence shown when there is
  // nothing to do, which is the one that actually said "today".
  const dom = setupDom();
  const inCash = advisorPayload({ today: { ...advisorPayload().today, targets: [] } });
  const app = appWith(dom, inCash);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');
  dom.setPrompt('25');
  dom.$('#adv-capital').value = '1000000';
  dom.fire(dom.$('#adv-capital-set'), 'click');
  await new Promise((r) => setTimeout(r, 0));
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /No actions from the 2026-08-04 suggestion — the assumed book already matches the champion’s targets\./,
    'the empty-list sentence names the recorded date');
  assert.ok(!/No actions today/.test(txt), 'and never calls a recorded date "today"');
});

test("an all-cash champion gets no rupee VaR either — the panel refuses to call the downside ₹0", async () => {
  // The mirror image of the wiped case, and the one that was actually shipping. A champion
  // sitting in cash produced var1dPct 0.00, which this panel scaled to a real capital figure and
  // rendered as "you should not lose more than ₹0" — a real-money sizing statement asserting
  // zero downside from a window that simply holds no information. It must refuse instead.
  const dom = setupDom();
  const noLoss = { conf: 0.99, window: 500, wiped: false, noLoss: true, lossDays: 3, tailDays: 5,
    var1dPct: null, es1dPct: null, var10dPct: null, backtest: null };
  const app = withChampRisk(dom, noLoss);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show("autopilot");
  dom.setPrompt("25");
  dom.$("#adv-capital").value = "1000000";
  dom.fire(dom.$("#adv-capital-set"), "click");
  await new Promise((r) => setTimeout(r, 0));
  const txt = dom.$("#ap-suggestions").textContent;
  // ★ This fixture deliberately has THREE losing days, not zero. The guard trips whenever the
  // window holds fewer losing days than the tail needs (5, at 99% on 500 bars), so copy saying
  // the equity "never fell" would be a lie in exactly this case. The panel must quote counts.
  assert.match(txt, /Tomorrow’s risk on this ₹[\d,]+: not quantifiable right now — only 3 of the champion’s last 500 trading days were losses, too few for a 99% tail \(which is measured from the worst 5\), so there is no loss distribution to size a VaR from\./, "it states the ACTUAL counts");
  assert.ok(!/never fell|did not fall/.test(txt), "and never asserts the equity did not fall, which this fixture would falsify");
  assert.ok(!/not lose more than ₹/.test(txt), "and NO rupee VaR is printed");
  assert.ok(!/₹0 \(one-day VaR/.test(txt), "specifically never the ₹0 this used to render");
});

test('a name too small to buy at this capital is NAMED on screen, not silently dropped', async () => {
  // Scaling can put a slice under one whole share. It then produced no order and no line, while
  // the target table below still listed the name at full weight — the screen contradicting itself
  // and under-deploying in silence. The panel must say which name, and why.
  const dom = setupDom();
  const payload = advisorPayload({
    today: {
      date: '2026-08-04', t: Date.parse('2026-08-04'), botId: 'b', botName: 'Sharpe King', kind: 'BASKET',
      eligible: true, reason: null, equity: 1.08e7,
      targets: [
        { symbol: 'RELIANCE', qty: 1800, price: 3000, weight: 0.5 },
        { symbol: 'BOSCHLTD', qty: 163, price: 33000, weight: 0.5 }, // ~Rs 33k a share
      ],
    },
  });
  const app = appWith(dom, payload);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');

  dom.setPrompt('25');
  dom.$('#adv-capital').value = '20000'; // Rs 20k: half of it is well under one BOSCHLTD share
  dom.fire(dom.$('#adv-capital-set'), 'click');
  await new Promise((r) => setTimeout(r, 0));

  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /Too small to act on/i, 'the panel must say that something was not actionable');
  assert.match(txt, /BOSCHLTD/, 'and name it');
  assert.match(txt, /stays in cash rather than being placed/i, 'and say where that share of the book went');
});

// --- the panel says WHY it went quiet when the data is a stand-in ------------
// The server refuses to record a suggestion built on the offline fallback series, because a
// made-up price must never enter a record that is never edited. Refusing SILENTLY would have been
// the same mistake the refusal exists to prevent: a reader who is told nothing concludes nothing
// happened today, and this panel is the one used to size real orders.
//
// ★ The banner is driven by the SERVER'S verdict (`advisor.standIn`), never re-derived from the
// raw key list. The first version fired on `syntheticKeys.length` alone and OVER-FIRED: BANKNIFTY,
// FINNIFTY and every single-symbol bot's key are stand-in-eligible too, so a partial feed failure
// on any of them would have printed "today's suggestion was not recorded" directly above a dated
// entry that WAS recorded. The control for exactly that is below.
// The banner is the div that OPENS with the headline — unambiguous, and it does not depend on
// whether the benchmark sub-note (a nested div) happens to be present.
const standInBanner = (dom) => [...dom.document.querySelectorAll('#ap-suggestions div')]
  .find((d) => d.textContent.trimStart().startsWith('Today’s suggestion was not recorded'));

test('a stand-in market series is named on the panel, with what it means for the record', async () => {
  const dom = setupDom();
  const app = appWith(dom, advisorPayload({ standIn: { scope: 'champion', symbols: ['60m:NIFTYBEES'] } }));
  initAutoPilot(app);
  await renderAutoPilot(app);
  // ★ SCOPED TO THE BANNER, not the whole panel. Asserting a symbol name against the panel text is
  // VACUOUS — the payload names symbols in several other places, so such an assertion passed even
  // with the naming REMOVED from the banner. A removal matrix caught it; it is the only reason it
  // did not ship.
  const banner = standInBanner(dom);
  assert.ok(banner, 'the stand-in banner renders');
  const txt = banner.textContent;
  assert.match(txt, /not recorded/i, 'it states that today is not in the record');
  assert.match(txt, /NIFTYBEES/, 'and NAMES the affected series — which one it is decides what can be trusted');
  // ★ The fixture deliberately supplies an INTRADAY key ('60m:NIFTYBEES'). A symbol with no prefix
  // cannot tell a key from a name, so a test using one would pass even if the raw internal key were
  // printed — which is what happened, and a removal matrix caught it. This panel is the one place
  // that must read as English.
  assert.ok(!/60m:/.test(txt), 'it prints the plain symbol, never the internal data key');
  assert.match(txt, /not real trading sessions/i, 'including that the dates are fabricated too');
  assert.match(txt, /nothing already saved is affected/i, 'while making clear the stored record is safe');
});

test('a stand-in INDEX also says the track record and day count below are fiction', async () => {
  // `track` and `coverage` are recomputed from the LIVE series on every payload, so refusing to
  // RECORD does not clean them up. When the benchmark itself is invented, the numbers on screen are
  // invented with it — and the banner's own "nothing already saved is affected" would otherwise
  // read as "everything here is fine".
  const dom = setupDom();
  const app = appWith(dom, advisorPayload({ standIn: { scope: 'benchmark', symbols: ['NIFTY'] } }));
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /index itself is the stand-in/i, 'it distinguishes the benchmark case');
  assert.match(txt, /track record and the day count below are calculated from generated prices/i,
    'and says the displayed score and coverage are fiction, not just the record');
});

test('CONTROL: the CHAMPION case must NOT claim the track record is fiction', async () => {
  // Only the benchmark case corrupts the displayed numbers. Saying so for a champion-only stand-in
  // would tell the reader to ignore a score that is perfectly good.
  const dom = setupDom();
  const app = appWith(dom, advisorPayload({ standIn: { scope: 'champion', symbols: ['NIFTYBEES'] } }));
  initAutoPilot(app);
  await renderAutoPilot(app);
  assert.ok(!/index itself is the stand-in/i.test(dom.$('#ap-suggestions').textContent),
    'the benchmark sentence must not appear for a champion-only stand-in');
});

test('CONTROL: a stand-in series that does NOT block recording shows no banner', async () => {
  // The exact over-fire this banner had in its first version. BANKNIFTY is a required key, so it
  // can be a stand-in — but the advisor does not read it, so the day IS recorded. Claiming
  // otherwise would contradict the dated entry rendered a few lines below.
  const dom = setupDom();
  const app = appWith(dom, advisorPayload({ standIn: null }), undefined, undefined, undefined, ['BANKNIFTY']);
  initAutoPilot(app);
  await renderAutoPilot(app);
  assert.ok(!/stand-in/i.test(dom.$('#ap-suggestions').textContent),
    'a stand-in key the advisor never reads must not claim the day was refused');
});

test('CONTROL: real data everywhere shows no stand-in warning (not permanent furniture)', async () => {
  const dom = setupDom();
  const app = appWith(dom, advisorPayload(), undefined, undefined, undefined, []);
  initAutoPilot(app);
  await renderAutoPilot(app);
  assert.ok(!/stand-in/i.test(dom.$('#ap-suggestions').textContent), 'nothing invented, no banner');
});

test('CONTROL: an older server that does not publish the field cannot fire the warning', async () => {
  // `standIn` is undefined on any deploy predating it. Treating "absent" as "invented" would put a
  // false alarm on the real-money panel for the whole rollout window.
  const dom = setupDom();
  const app = appWith(dom, advisorPayload());
  initAutoPilot(app);
  await renderAutoPilot(app);
  assert.ok(!/stand-in/i.test(dom.$('#ap-suggestions').textContent), 'absent is not the same as invented');
});

test('the two record warnings are INDEPENDENT — a storage failure and a stand-in feed can coexist', async () => {
  // They have the same visible symptom (the log stops growing) and different causes, so a reader
  // seeing only one would fix the wrong thing.
  const dom = setupDom();
  const app = appWith(dom, advisorPayload({ standIn: { scope: 'benchmark', symbols: ['NIFTY'] } }), { enabled: true, attempted: true, restored: false, readFailed: true });
  initAutoPilot(app);
  await renderAutoPilot(app);
  const txt = dom.$('#ap-suggestions').textContent;
  assert.match(txt, /not being saved/i, 'the storage banner still shows');
  assert.match(txt, /stand-in/i, 'and so does the stand-in banner');
});

// --- the panel must not invent trades out of price drift ---------------------
// ★ THE DISTINGUISHING CASE, and it was unreachable from the old fixtures because they carried only
// `weight` — no `qty`. A recorded weight is qty*price/equity, so it moves every day purely because
// prices moved. W16 records the SERVER being fixed for exactly this (charging that drift as
// turnover billed a champion that never traded ~0.5%/yr of costs it never paid); the client copy of
// the same comparison was never converted, and it is worse — it printed the drift as an instruction
// to go and place a real order by hand.
const tgt = (symbol, qty, price, equity) => ({ symbol, qty, price, weight: (qty * price) / equity });

test('weightDiffLines says NOTHING when only prices moved — the champion placed no trades', () => {
  const prevEq = 1_000_000;
  const prev = {
    date: '2026-08-03', botId: 'b', eligible: true, equity: prevEq,
    targets: ['A', 'B', 'C', 'D'].map((s) => tgt(s, 100, 2500, prevEq)),
  };
  // A +12%, D -4%, B and C flat. IDENTICAL share counts on both days.
  const px = { A: 2800, B: 2500, C: 2500, D: 2400 };
  const eq = Object.values(px).reduce((s, p) => s + p * 100, 0);
  const today = {
    date: '2026-08-04', botId: 'b', eligible: true, equity: eq,
    targets: Object.keys(px).map((s) => tgt(s, 100, px[s], eq)),
  };
  assert.deepEqual(weightDiffLines(prev, today), [],
    'no share count changed, so there is nothing for the reader to go and do');
});

test('CONTROL: a real trade IS still described, with its weight', () => {
  // The fix must not silence genuine rebalances — the drift rule decides WHETHER to speak, the
  // weights are still WHAT is said.
  const eq = 1_000_000;
  const prev = { date: '2026-08-03', botId: 'b', eligible: true, equity: eq, targets: [tgt('A', 100, 2500, eq), tgt('B', 100, 2500, eq)] };
  const today = { date: '2026-08-04', botId: 'b', eligible: true, equity: eq, targets: [tgt('A', 160, 2500, eq), tgt('B', 40, 2500, eq)] };
  const lines = weightDiffLines(prev, today);
  assert.equal(lines.length, 2, 'both names really traded');
  assert.ok(lines.some((l) => /Increase A to 40\.0%/.test(l)), `expected an Increase line, got ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => /Trim B to 10\.0%/.test(l)), `expected a Trim line, got ${JSON.stringify(lines)}`);
});

test('CONTROL: New and Exit still fire — they are not qty comparisons at all', () => {
  const eq = 1_000_000;
  const prev = { date: '2026-08-03', botId: 'b', eligible: true, equity: eq, targets: [tgt('OLD', 100, 2500, eq)] };
  const today = { date: '2026-08-04', botId: 'b', eligible: true, equity: eq, targets: [tgt('NEW', 100, 2500, eq)] };
  const lines = weightDiffLines(prev, today);
  assert.ok(lines.some((l) => /^New: NEW/.test(l)), `expected a New line, got ${JSON.stringify(lines)}`);
  assert.ok(lines.some((l) => /^Exit OLD/.test(l)), `expected an Exit line, got ${JSON.stringify(lines)}`);
});

test('CONTROL: across a CHAMPION SWITCH every name is described, drift or not', () => {
  // Two different bots' share counts are not comparable (their equities can differ several-fold),
  // and a switch genuinely replaces the whole book — so the qty shortcut must NOT apply here.
  const eq = 1_000_000;
  const prev = { date: '2026-08-03', botId: 'b1', eligible: true, equity: eq, targets: [tgt('A', 100, 2500, eq), tgt('B', 100, 2500, eq)] };
  const px = { A: 2800, B: 2400 };
  const eq2 = 100 * px.A + 100 * px.B;
  const today = { date: '2026-08-04', botId: 'b2', eligible: true, equity: eq2, targets: Object.keys(px).map((s) => tgt(s, 100, px[s], eq2)) };
  assert.ok(weightDiffLines(prev, today).length > 0, 'a different champion is a real change, however the shares line up');
});
