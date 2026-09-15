// ---------------------------------------------------------------------------
// test/ui-positions.test.mjs
// Drives the REAL Positions/Dashboard tab (public/js/ui/positions.js): the
// open-positions table, the one-click Close button, the top-line P&L summary,
// and the left-rail account box. Numbers are computed by the (already tested)
// engine; here we assert they are RENDERED correctly.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom, syntheticChain } from '../test-helpers/dom-harness.mjs';
import { renderChain } from '../public/js/ui/optionChain.js';
import { remarkOptionPositions } from '../public/js/ui/autopilot.js';
import { renderPositions, portfolioGreeks, confirmStaleSquareOff } from '../public/js/ui/positions.js';

// Build the dashboard wired to re-render on engine changes (as app.js does).
function mount(dom) {
  const app = dom.makeApp();
  app.engine.subscribe(() => renderPositions(app));
  renderPositions(app);
  return app;
}

// ★ FEED a contract the way the app really does, instead of DECLARING that it is fed.
// renderChain() ends by calling feedEngineFromChain(), which walks the visible strikes and pushes
// each positive LTP through engine.onPriceUpdate — the one door that stamps `lastPriceAt`. Driving
// the real renderer means these fixtures exercise the real feed, including both of its conditions:
// the strike must be IN the visible window, and its LTP must be positive.
//
// The first version of these controls set `app.state.chain = { ..., strikes: [] }` and then
// asserted the option was live. A chain with no strikes feeds NOTHING, so the fixture built the
// opposite of the state its own name claimed — it passed only because the rule under test was
// modelling the feed rather than watching it, and the model agreed with the fixture's shape.
function feedChain(app, expiry, strike) {
  const chain = syntheticChain('NIFTY', expiry);
  if (strike != null && !chain.strikes.some((r) => r.strike === strike)) {
    chain.strikes.push({
      strike,
      ce: { ltp: 120, bid: 1, ask: 2, iv: 12.5, volume: 10, oi: 100, changeOi: 0 },
      pe: { ltp: 90, bid: 1, ask: 2, iv: 13, volume: 10, oi: 100, changeOi: 0 },
    });
  }
  app.state.chain = chain;
  renderChain(app, chain);
  return chain;
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

  // ★ This future has no live price — nothing is feeding it, because no option chain is loaded —
  // so closing it now asks for confirmation first. That guard did not exist when this test was
  // written, and the harness's confirm defaults to CANCEL, so without this line the click does
  // nothing and the test fails for a reason that has nothing to do with what it locks. Answering
  // OK restores the exact flow it was written to check: that Close leaves no 25-unit residual on
  // an odd, non-lot-multiple quantity. The confirmation itself is locked by its own tests below.
  dom.setConfirm(true);
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

// --- an F&O price that is NOT being fed must say so -------------------------
// feedEngineFromChain() in ui/optionChain.js is the ONLY price source for a manually traded
// option or future, and it walks the chain CURRENTLY ON SCREEN. So a contract in any other
// expiry — or in any other underlying — stops being marked the moment you look away: its "LTP"
// stays at the fill price and its unrealised P&L freezes at zero, rendered in exactly the same
// style as a live row. The portfolio Greeks, meanwhile, keep moving, because they reprice off the
// live underlying spot. These lock the disclosure, and three of the five are CONTROLS that must
// NOT fire — a marker that appears on every row would be worse than none.
const OPT = (expiry, strike = 23500) => ({
  kind: 'OPT', symbol: 'NIFTY', expiry, strike, optType: 'CE', lotSize: 75, underlyingPrice: 23500,
});
const buyOpt = (engine, inst, price) =>
  engine.placeOrder({ instrument: inst, side: 'BUY', orderType: 'MARKET', lots: 1, price });

test('an option outside the chain on screen is marked as not live, and the hover says why', () => {
  const dom = setupDom();
  const app = mount(dom);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  // The chain tab is showing a DIFFERENT expiry, so nothing feeds the October contract.
  app.state.chain = { symbol: 'NIFTY', expiry: '24-Sep-2026', strikes: [] };
  renderPositions(app);

  const txt = dom.$('#positions-table') ? dom.$('#positions-table').textContent : dom.document.body.textContent;
  assert.match(txt, /·not live/, 'the LTP carries the marker');
  // Scoped to the TABLE on purpose: the P&L summary above it now carries its own `.stale-mark`
  // for the same underlying fact, so an unscoped query returns that one instead and this test
  // would silently be asserting about the wrong element.
  const mark = dom.$('#positions-table').querySelector('.stale-mark');
  assert.ok(mark, 'the marker element is rendered');
  const title = mark.getAttribute('title');
  assert.match(title, /Not a live price/, 'the hover states the fact');
  assert.match(title, /NIFTY 30-Oct-2026/, 'it names the contract that is not being fed');
  assert.match(title, /last price seen/, 'it says what the number actually is');
  assert.match(title, /Open that expiry in the Option Chain/, 'it names the one remedy');
});

test('CONTROL: the same option IS live while its own expiry is the chain on screen', () => {
  const dom = setupDom();
  const app = mount(dom);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  feedChain(app, '30-Oct-2026', 23500); // really feeds it, through the real chain renderer
  renderPositions(app);
  assert.ok(!dom.document.querySelector('.stale-mark'), 'a contract being fed must NOT be marked');
});

test('CONTROL: an equity is never marked — every held symbol is polled regardless of the screen', () => {
  const dom = setupDom();
  const app = mount(dom);
  buy(app.engine, 'RELIANCE', 10, 1200);
  app.state.chain = { symbol: 'NIFTY', expiry: '24-Sep-2026', strikes: [] };
  renderPositions(app);
  assert.ok(!dom.document.querySelector('.stale-mark'), 'equities are polled by symbolsToPoll(), never stale this way');
});

test('CONTROL: an Auto-Pilot copied leg that IS being re-marked is not called stale', () => {
  const dom = setupDom();
  const app = mount(dom);
  // A copied leg carries expiryMs + iv and lives under a modelled expiry no chain serves;
  // remarkOptionPositions() re-prices it off the live underlying on every poll, so its price is a
  // MODEL price but not a stale one. Drive the REAL re-mark rather than exempting the leg by its
  // shape: an earlier version of this rule trusted `expiryMs && iv` and would have called the leg
  // live even when nothing was re-marking it.
  const leg = { ...OPT('cyc293'), expiryMs: Date.now() + 30 * 864e5, iv: 0.14 };
  buyOpt(app.engine, leg, 400);
  app.state.quotes.NIFTY = { ltp: 23500 }; // the underlying quote the re-mark needs
  remarkOptionPositions(app);
  renderPositions(app);
  assert.ok(!dom.document.querySelector('.stale-mark'), 'a re-marked copied leg must not be called stale');
});

test('a copied leg whose underlying quote never arrives IS marked', () => {
  // The other half, and the reason the rule watches the feed instead of the instrument's shape:
  // remarkOptionPositions() gives up when there is no underlying quote (`if (!(spot > 0)) continue`),
  // so the leg silently stops being re-priced. Its shape still says "copied leg", which is exactly
  // why shape is the wrong thing to trust.
  const dom = setupDom();
  const app = mount(dom);
  const leg = { ...OPT('cyc293'), expiryMs: Date.now() + 30 * 864e5, iv: 0.14 };
  buyOpt(app.engine, leg, 400);
  delete app.state.quotes.NIFTY; // no underlying quote -> the re-mark cannot run
  remarkOptionPositions(app);
  renderPositions(app);
  const mark = dom.$('#positions-table').querySelector('.stale-mark');
  assert.ok(mark, 'an un-re-marked copied leg must be marked');
  assert.match(mark.getAttribute('title'), /re-priced from the live NIFTY quote/,
    'and the hover must give the copied-leg reason, not "open the Option Chain"');
});

test('with no chain ever loaded, a manual option is marked (nothing is feeding F&O at all)', () => {
  const dom = setupDom();
  const app = mount(dom);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  app.state.chain = null; // the Option Chain tab has never been opened this session
  renderPositions(app);
  // Scoped to the table: the summary above carries its own marker for the same fact, so an
  // unscoped presence check would still pass if the ROW marker regressed.
  assert.ok(dom.$('#positions-table').querySelector('.stale-mark'),
    'no chain means no F&O feed, so the price is not live');
});

// --- closing at a price that is not live must SAY so first -------------------
// The display marker above is only half of it: Close (and Square off all) fill at the SAME
// frozen price, booking a realised P&L against a number that may be days old — previously in one
// silent click. There is no better price available, so the answer is not to refuse (trapping
// someone in a position is worse) but to state what is about to happen. These lock that it asks
// in the wrong case, does NOT ask in the ordinary ones, and that cancelling really cancels.
test('closing an option with no live price asks first, and cancelling places no order', () => {
  const dom = setupDom();
  const app = mount(dom);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  app.state.chain = { symbol: 'NIFTY', expiry: '24-Sep-2026', strikes: [] };
  renderPositions(app);
  const before = app.engine.state.positions['OPT:NIFTY:30-Oct-2026:23500:CE'].qty;

  dom.setConfirm(false); // read it, then back out
  dom.fire(dom.$$('#positions-table tbody tr button').find((b) => b.textContent === 'Close'), 'click');

  assert.equal(dom.confirms.length, 1, 'exactly one confirmation was shown');
  const msg = dom.confirms[0];
  assert.match(msg, /NOT a live price/, 'it states the fact plainly');
  assert.match(msg, /120\.00/, 'it names the price it would close at');
  assert.match(msg, /NIFTY 30-Oct-2026/, 'it names the contract that is not being fed');
  assert.match(msg, /realised P&L this books will be calculated from it/, 'it says what the price is used for');
  assert.match(msg, /open that expiry in the Option Chain first/i, 'it names the remedy');
  assert.equal(app.engine.state.positions['OPT:NIFTY:30-Oct-2026:23500:CE'].qty, before,
    'cancelling must leave the position exactly as it was');
});

test('CONTROL: closing an equity never asks — its price is always being polled', () => {
  const dom = setupDom();
  const app = mount(dom);
  buy(app.engine, 'RELIANCE', 10, 1200);
  renderPositions(app);
  dom.setConfirm(false); // would block the close if it were asked
  dom.fire(dom.$$('#positions-table tbody tr button').find((b) => b.textContent === 'Close'), 'click');
  assert.equal(dom.confirms.length, 0, 'no dialog for an equity');
  assert.equal(app.engine.state.positions['EQ:RELIANCE'], undefined, 'and it closed in one click');
});

test('CONTROL: closing an option whose own expiry is on screen never asks', () => {
  const dom = setupDom();
  const app = mount(dom);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  feedChain(app, '30-Oct-2026', 23500);
  renderPositions(app);
  dom.setConfirm(false);
  dom.fire(dom.$$('#positions-table tbody tr button').find((b) => b.textContent === 'Close'), 'click');
  assert.equal(dom.confirms.length, 0, 'a contract being fed closes in one click, as before');
  assert.equal(app.engine.state.positions['OPT:NIFTY:30-Oct-2026:23500:CE'], undefined, 'it closed');
});

test('square off all names the positions that have no live price, and cancelling closes nothing', () => {
  const dom = setupDom();
  const app = mount(dom);
  buy(app.engine, 'RELIANCE', 10, 1200);           // live
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);     // not live
  app.state.chain = { symbol: 'NIFTY', expiry: '24-Sep-2026', strikes: [] };

  dom.setConfirm(false);
  assert.equal(confirmStaleSquareOff(app), false, 'cancelling is reported to the caller');
  const msg = dom.confirms[0];
  assert.match(msg, /1 of these positions has no live price/, 'it counts only the unfed ones');
  assert.match(msg, /NIFTY 23500 CE 30-Oct-2026/, 'and names them');
  assert.ok(!/RELIANCE/.test(msg), 'the live equity is NOT listed as a problem');
  assert.equal(app.engine.state.positions['EQ:RELIANCE'].qty, 10, 'nothing was closed');
});

test('CONTROL: square off all asks nothing when every position is being fed', () => {
  const dom = setupDom();
  const app = mount(dom);
  buy(app.engine, 'RELIANCE', 10, 1200);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  feedChain(app, '30-Oct-2026', 23500); // the option really IS fed
  dom.setConfirm(false);
  assert.equal(confirmStaleSquareOff(app), true, 'it proceeds without asking');
  assert.equal(dom.confirms.length, 0, 'no dialog when there is nothing to warn about');
});

// --- the HEADLINE inherits the frozen mark ----------------------------------
// Unrealised P&L sums every position, and an unfed contract contributes its frozen mark — usually
// zero, because the mark is still the fill price. So the biggest number on the screen can read
// "no movement" when the truth is simply unknown. The row marker says WHICH position; this says
// the TOTAL is affected, which is what someone reading only the hero cards would otherwise miss.
test('the Unrealised P&L card says when part of the total is not being priced', () => {
  const dom = setupDom();
  const app = mount(dom);
  buy(app.engine, 'RELIANCE', 10, 1200);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  app.state.chain = { symbol: 'NIFTY', expiry: '24-Sep-2026', strikes: [] };
  renderPositions(app);

  const summary = dom.$('#pnl-summary');
  assert.match(summary.textContent, /· 1 not live/, 'the card says how many are unpriced');
  const mark = summary.querySelector('.stale-mark');
  const title = mark.getAttribute('title');
  assert.match(title, /1 open position is marked at a last-seen price/, 'singular reads correctly');
  assert.match(title, /frozen — usually at zero/, 'it says why the contribution is misleading');
  assert.match(title, /Positions table below marks which one/, 'it points at where to look');
});

test('CONTROL: the card says nothing when every position is being priced', () => {
  const dom = setupDom();
  const app = mount(dom);
  buy(app.engine, 'RELIANCE', 10, 1200);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  feedChain(app, '30-Oct-2026', 23500); // the option really IS fed
  renderPositions(app);
  assert.ok(!dom.$('#pnl-summary').querySelector('.stale-mark'),
    'no note when there is nothing to note — it must never be permanent furniture');
  assert.ok(!/not live/.test(dom.$('#pnl-summary').textContent));
});

test('the headline note and the square-off guard count the same positions', () => {
  // They render in different places and read differently (a count vs a list of names), so they
  // are the pair most likely to drift apart. Both must come from one definition.
  const dom = setupDom();
  const app = mount(dom);
  buy(app.engine, 'RELIANCE', 10, 1200);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  buyOpt(app.engine, OPT('27-Nov-2026', 24000), 90);
  feedChain(app, '30-Oct-2026', 23500); // October really fed; November never was
  renderPositions(app);

  assert.match(dom.$('#pnl-summary').textContent, /· 1 not live/, 'one position is unfed');
  dom.setConfirm(false);
  confirmStaleSquareOff(app);
  const msg = dom.confirms[dom.confirms.length - 1];
  assert.match(msg, /1 of these positions has no live price/, 'the guard agrees on the count');
  assert.match(msg, /NIFTY 24000 CE 27-Nov-2026/, 'and it is the November one');
  assert.ok(!/30-Oct-2026/.test(msg), 'the October contract is fed, so it is not listed');
});

// --- the case the whole rewrite exists for: fed, then LEFT ALONE -------------
// This is the scenario a review found the first rule got backwards. `app.state.chain` is assigned
// once and never cleared, while the chain's 6-second refresh is gated on the Chain TAB being
// active — and the Positions table lives in a different, mutually exclusive panel. So the contract
// you were last looking at stops being fed the instant you navigate away, and the original rule
// called precisely that contract "live" forever.
//
// A fixture that only ever tests "fed" vs "never fed" cannot see this: both rules agree there.
// The distinguishing case is a contract that WAS fed and then went quiet, which is why the stamp
// is aged here rather than the chain being taken away.
test('a contract that WAS fed goes stale once the feed stops', () => {
  const dom = setupDom();
  const app = mount(dom);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  feedChain(app, '30-Oct-2026', 23500);
  renderPositions(app);
  assert.ok(!dom.$('#positions-table').querySelector('.stale-mark'), 'fed right now: not marked');

  // Leave the Chain tab: nothing refreshes it any more. The chain object itself stays put — that
  // is the whole trap — so only the age of the last feed can tell the difference.
  app.engine.lastPriceAt['OPT:NIFTY:30-Oct-2026:23500:CE'] -= 60000; // one minute of sitting on the dashboard
  renderPositions(app);
  assert.ok(dom.$('#positions-table').querySelector('.stale-mark'),
    'a minute later, with app.state.chain STILL matching, it must be marked');
  assert.match(dom.$('#pnl-summary').textContent, /· 1 not live/, 'and the headline agrees');
});

test('Close asks about a contract that was fed and then went quiet', () => {
  // The same drift, at the point where it costs money rather than just reading wrong.
  const dom = setupDom();
  const app = mount(dom);
  buyOpt(app.engine, OPT('30-Oct-2026'), 120);
  feedChain(app, '30-Oct-2026', 23500);
  app.engine.lastPriceAt['OPT:NIFTY:30-Oct-2026:23500:CE'] -= 2 * 60 * 60 * 1000; // two hours later
  renderPositions(app);

  dom.setConfirm(false);
  dom.fire(dom.$$('#positions-table tbody tr button').find((b) => b.textContent === 'Close'), 'click');
  assert.equal(dom.confirms.length, 1, 'it asks, even though the chain still matches');
  assert.ok(app.engine.state.positions['OPT:NIFTY:30-Oct-2026:23500:CE'], 'and cancelling holds');
});
