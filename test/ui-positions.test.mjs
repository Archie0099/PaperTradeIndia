// ---------------------------------------------------------------------------
// test/ui-positions.test.mjs
// Drives the REAL Positions/Dashboard tab (public/js/ui/positions.js): the
// open-positions table, the one-click Close button, the top-line P&L summary,
// and the left-rail account box. Numbers are computed by the (already tested)
// engine; here we assert they are RENDERED correctly.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { renderPositions, portfolioGreeks } from '../public/js/ui/positions.js';

// Build the dashboard wired to re-render on engine changes (as app.js does).
function mount(dom) {
  const app = dom.makeApp();
  app.engine.subscribe(() => renderPositions(app));
  renderPositions(app);
  return app;
}

const buy = (engine, symbol, lots, price) =>
  engine.placeOrder({ instrument: { kind: 'EQ', symbol, lotSize: 1 }, side: 'BUY', orderType: 'MARKET', lots, price });
const sell = (engine, symbol, lots, price) =>
  engine.placeOrder({ instrument: { kind: 'EQ', symbol, lotSize: 1 }, side: 'SELL', orderType: 'MARKET', lots, price });

test('empty portfolio shows the no-positions empty state', () => {
  const dom = setupDom();
  mount(dom);
  assert.match(dom.$('#positions-table').textContent, /No open positions/);
});

test('a long equity position renders qty / avg / LTP / unrealised correctly', () => {
  const dom = setupDom();
  const app = mount(dom);

  buy(app.engine, 'RELIANCE', 10, 2500);
  app.engine.updateEquityPrice('RELIANCE', 2600); // price moves up +100

  const text = dom.$('#positions-table').textContent;
  assert.match(text, /RELIANCE/);
  assert.match(text, /2500\.00/); // avg
  assert.match(text, /2600\.00/); // LTP
  // Unrealised = (2600-2500)*10 = +1,000, rendered with a + and Indian grouping.
  const unrealCell = dom.$('#positions-table tbody tr td:nth-child(5)');
  assert.equal(unrealCell.textContent, '+1,000');
  assert.ok(unrealCell.classList.contains('up'), 'a profit should be coloured up');
});

test('a short equity position shows negative qty and profits when price falls', () => {
  const dom = setupDom();
  const app = mount(dom);

  sell(app.engine, 'RELIANCE', 10, 2500); // open short
  app.engine.updateEquityPrice('RELIANCE', 2400); // price falls -> short profits

  const qtyCell = dom.$('#positions-table tbody tr td:nth-child(2)');
  assert.equal(qtyCell.textContent, '-10');
  const unrealCell = dom.$('#positions-table tbody tr td:nth-child(5)');
  assert.equal(unrealCell.textContent, '+1,000'); // (2500-2400)*10
  assert.ok(unrealCell.classList.contains('up'));
});

test('LTP shows the waiting glyph when no live price is known yet', () => {
  const dom = setupDom();
  const app = mount(dom);

  buy(app.engine, 'RELIANCE', 10, 2500);
  delete app.engine.state.lastPrices['EQ:RELIANCE']; // simulate "no quote yet"
  renderPositions(app);

  const ltpCell = dom.$('#positions-table tbody tr td:nth-child(4)');
  assert.equal(ltpCell.textContent, '…');
});

test('the Close button flattens the position with an offsetting market order', () => {
  const dom = setupDom();
  const app = mount(dom);

  buy(app.engine, 'RELIANCE', 10, 2500);
  app.engine.updateEquityPrice('RELIANCE', 2600);
  assert.equal(app.engine.state.positions['EQ:RELIANCE'].qty, 10);

  // Click the row's Close button (the action cell also has an SL/TP button).
  const closeBtn = dom.$$('#positions-table tbody tr button').find((b) => b.textContent === 'Close');
  assert.ok(closeBtn, 'a Close button should render');
  dom.fire(closeBtn, 'click');

  // Position is gone and the realised gain (+1,000) is banked.
  assert.equal(app.engine.state.positions['EQ:RELIANCE'], undefined);
  assert.ok(Math.abs(app.engine.realisedTotal() - 1000) < 0.01);
  assert.match(dom.$('#positions-table').textContent, /No open positions/);
});

test('the P&L summary and account box reflect cash, equity and return', () => {
  const dom = setupDom();
  const app = mount(dom);

  buy(app.engine, 'RELIANCE', 10, 2500); // cash 1,000,000 -> 975,000
  app.engine.updateEquityPrice('RELIANCE', 2600); // holdings 26,000 -> equity 1,001,000

  const summary = dom.$('#pnl-summary').textContent;
  assert.match(summary, /Account Value/);
  assert.match(summary, /10,01,000/); // equity in Indian grouping
  assert.match(summary, /\+1,000/); // unrealised AND total return

  const acct = dom.$('#account-summary').textContent;
  assert.match(acct, /Open positions/);
  assert.match(acct, /1/); // one open position
});

// --- regression tests for confirmed UI bugs --------------------------------

test('an imported position lacking a stored `key` still shows LTP and P&L', () => {
  const dom = setupDom();
  const app = mount(dom);

  // Import a portfolio whose position object has NO redundant `key` field — the
  // table must derive the key from the instrument, not from p.key.
  const portfolio = {
    cash: 975000,
    initialCash: 1000000,
    realised: 0,
    positions: {
      'EQ:RELIANCE': { instrument: { kind: 'EQ', symbol: 'RELIANCE', lotSize: 1 }, qty: 10, avgPrice: 2500 },
    },
    orders: [],
    lastPrices: { 'EQ:RELIANCE': 2600 },
  };
  app.engine.importJson(JSON.stringify(portfolio)); // emit -> renderPositions

  const ltp = dom.$('#positions-table tbody tr td:nth-child(4)');
  assert.equal(ltp.textContent, '2600.00', 'LTP would be "…" if it relied on p.key');
  const unreal = dom.$('#positions-table tbody tr td:nth-child(5)');
  assert.equal(unreal.textContent, '+1,000');
});

test('the per-position realised column is labelled to distinguish it from the account total', () => {
  const dom = setupDom();
  const app = mount(dom);
  buy(app.engine, 'RELIANCE', 10, 2500);
  app.engine.updateEquityPrice('RELIANCE', 2600);
  assert.match(dom.$('#positions-table thead').textContent, /Realised \(pos\)/);
});

test('Close fully flattens an odd (non-lot-multiple) imported position (bug #4)', () => {
  const dom = setupDom();
  const app = mount(dom);
  // 100 units of a 75-lot future is NOT a whole number of lots.
  const portfolio = {
    cash: 1000000,
    initialCash: 1000000,
    realised: 0,
    positions: {
      'FUT:NIFTY:26-Jun-2026': { instrument: { kind: 'FUT', symbol: 'NIFTY', expiry: '26-Jun-2026', lotSize: 75 }, qty: 100, avgPrice: 23500 },
    },
    orders: [],
    lastPrices: { 'FUT:NIFTY:26-Jun-2026': 23500 },
  };
  app.engine.importJson(JSON.stringify(portfolio));
  assert.equal(app.engine.state.positions['FUT:NIFTY:26-Jun-2026'].qty, 100);

  dom.fire(dom.$$('#positions-table tbody tr button').find((b) => b.textContent === 'Close'), 'click');

  assert.equal(app.engine.state.positions['FUT:NIFTY:26-Jun-2026'], undefined, 'no 25-unit residual left');
});

test('the SL/TP button sets bracket exits on a position (order types)', () => {
  const dom = setupDom();
  const app = mount(dom);
  buy(app.engine, 'RELIANCE', 10, 2500);
  app.engine.updateEquityPrice('RELIANCE', 2500);

  dom.setPrompt('2400/2700'); // "stop-loss / target"
  const sltpBtn = dom.$$('#positions-table tbody tr button').find((b) => b.textContent === 'SL/TP');
  assert.ok(sltpBtn, 'an SL/TP button should render on the position row');
  dom.fire(sltpBtn, 'click');

  assert.equal(app.engine.state.positions['EQ:RELIANCE'].stopLoss, 2400);
  assert.equal(app.engine.state.positions['EQ:RELIANCE'].target, 2700);
});

test('portfolioGreeks aggregates open F&O Greeks and is null when there are none (analytics)', () => {
  // No F&O (empty, or equity-only) -> null so the UI hides the block.
  assert.equal(portfolioGreeks({ positions: {}, lastPrices: {}, quotes: {} }), null);
  assert.equal(
    portfolioGreeks({ positions: { 'EQ:X': { qty: 10, instrument: { kind: 'EQ', symbol: 'X' } } }, lastPrices: {}, quotes: {} }),
    null
  );

  // A long ATM NIFTY call: positive delta + gamma, negative theta (decay). IV is
  // recovered from the option's market price; spot from the underlying quote.
  const key = 'OPT:NIFTY:26-Jun-2026:23500:CE';
  const g = portfolioGreeks({
    positions: { [key]: { qty: 75, avgPrice: 100, instrument: { kind: 'OPT', symbol: 'NIFTY', expiry: '26-Jun-2026', strike: 23500, optType: 'CE', lotSize: 75, underlyingPrice: 23500 } } },
    lastPrices: { [key]: 120 },
    quotes: { NIFTY: { ltp: 23500 } },
    riskFreeRate: 6.5,
  });
  assert.ok(g && g.delta > 0, `long call -> positive net delta, got ${g && g.delta}`);
  assert.ok(g.gamma > 0);
  assert.ok(g.theta < 0, 'a long option decays -> negative theta');

  // A long future contributes delta = qty exactly, nothing else.
  const fut = portfolioGreeks({
    positions: { 'FUT:NIFTY:26-Jun-2026': { qty: 50, instrument: { kind: 'FUT', symbol: 'NIFTY', expiry: '26-Jun-2026' } } },
    lastPrices: {},
    quotes: {},
  });
  assert.equal(fut.delta, 50);
  assert.equal(fut.gamma, 0);
});

test('portfolioGreeks uses the stamped expiryMs for a COPIED F&O leg (synthetic cyc expiry)', () => {
  // An Auto-Pilot-COPIED option leg lives under a synthetic "cyc{i}" expiry STRING that parseExpiryMs
  // can't parse — without the fix that gives a wrong/NaN T and the leg's net Greeks are wrong/skipped.
  // The stamped expiryMs (a real timestamp ~30 days out here) gives the correct T: an ATM 30-day call
  // on 75 units -> a sensible net delta ~0.5*75 (not 0/skipped, not a deep-ITM ~75 from a wrong T).
  const expiryMs = Date.now() + 30 * 864e5;
  const key = 'OPT:NIFTY:cyc293:23500:CE';
  const g = portfolioGreeks({
    // option price 400 = well above the ~30-day ATM no-arbitrage minimum, so impliedVol has a real solution.
    positions: { [key]: { qty: 75, avgPrice: 350, instrument: { kind: 'OPT', symbol: 'NIFTY', expiry: 'cyc293', expiryMs, iv: 0.14, strike: 23500, optType: 'CE', lotSize: 75, underlyingPrice: 23500 } } },
    lastPrices: { [key]: 400 },
    quotes: { NIFTY: { ltp: 23500 } },
    riskFreeRate: 6.5,
  });
  assert.ok(g && Number.isFinite(g.delta), 'the copied leg is counted (finite Greeks) via the stamped expiryMs');
  assert.ok(g.delta > 20 && g.delta < 60, `net delta ~ATM-30-day (0.5*75), not 0/skipped nor deep-ITM, got ${g.delta}`);
  assert.ok(g.gamma > 0 && g.theta < 0, 'positive gamma, negative theta (a long option) from the correct T');
});
