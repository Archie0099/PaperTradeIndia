// ---------------------------------------------------------------------------
// test/ui-optionchain.test.mjs
// Drives the REAL Option Chain tab (public/js/ui/optionChain.js): loading a
// chain from the (stubbed) API, rendering the CE | STRIKE | PE table with
// locally-computed Greeks, highlighting the ATM strike, click-to-trade into the
// order ticket, the expiry dropdown, and the error / empty states.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { initOptionChain, loadChain } from '../public/js/ui/optionChain.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

test('loadChain renders a row per strike and marks the ATM strike', async () => {
  const dom = setupDom();
  const app = dom.makeApp();
  await loadChain(app);

  const rows = dom.$$('#chain-table tbody tr');
  assert.equal(rows.length, 5); // synthetic chain has 5 strikes

  const atm = dom.$('#chain-table .atm-row');
  assert.ok(atm, 'the ATM strike row should be highlighted');
  assert.match(atm.textContent, /23500/); // underlying is 23500
});

test('the data-source label reflects the chain source', async () => {
  const dom = setupDom();
  const app = dom.makeApp();
  await loadChain(app);
  assert.match(dom.$('#chain-meta').textContent, /synthetic \(offline\)/);
});

test('Greeks are computed locally and rendered (not dashes) when IV is present', async () => {
  const dom = setupDom();
  const app = dom.makeApp();
  await loadChain(app);

  // CE columns: LTP,Bid,Ask,IV,Vol,OI,ChgOI,Δ(8),Γ(9),Θ(10),Veg(11)
  const atm = dom.$('#chain-table .atm-row');
  const ceDelta = atm.querySelector('td:nth-child(8)').textContent;
  assert.match(ceDelta, /^-?\d/, 'CE delta should be a number, proving Greeks ran');
  assert.notEqual(ceDelta, '–');
});

test('change-in-OI cells render signed and coloured', async () => {
  const dom = setupDom();
  const app = dom.makeApp();
  await loadChain(app);
  const atm = dom.$('#chain-table .atm-row');
  // CE ChgOI is column 7; synthetic data sets it to +100.
  const ceChgOi = atm.querySelector('td:nth-child(7)');
  assert.equal(ceChgOi.textContent, '+100');
  assert.ok(ceChgOi.classList.contains('up'));
});

test('clicking an LTP cell loads that option into the order ticket and switches tab', async () => {
  const dom = setupDom();
  const app = dom.makeApp();
  await loadChain(app);

  // The first CE LTP cell (column 1) of the ATM row is clickable.
  const ceLtp = dom.$('#chain-table .atm-row td.chain-trade');
  assert.ok(ceLtp, 'an LTP cell should be clickable');
  dom.fire(ceLtp, 'click');

  assert.equal(dom.$('#t-kind').value, 'OPT');
  assert.equal(dom.$('#t-symbol').value, 'NIFTY');
  assert.equal(dom.$('#t-strike').value, '23500');
  assert.ok(dom.$('#tab-orders').classList.contains('active'), 'should jump to the Orders tab');
});

test('the expiry dropdown is populated from the chain', async () => {
  const dom = setupDom();
  const app = dom.makeApp();
  await loadChain(app);
  const opts = dom.$$('#chain-expiry option').map((o) => o.value);
  assert.deepEqual(opts, ['26-Jun-2026', '31-Jul-2026']);
});

test('submitting the chain form with a new symbol reloads the chain for it', async () => {
  const dom = setupDom();
  let requested = null;
  const app = dom.makeApp({
    api: dom.makeApiStub({
      optionChain: async (sym) => {
        requested = sym;
        return dom.syntheticChain(sym);
      },
    }),
  });
  initOptionChain(app);

  dom.$('#chain-symbol').value = 'banknifty'; // lower-case on purpose
  dom.submit('#chain-form');
  await flush();

  assert.equal(app.state.chainSymbol, 'BANKNIFTY'); // upper-cased by the handler
  assert.equal(requested, 'BANKNIFTY');
});

test('a failed chain load shows a helpful error state, not a crash', async () => {
  const dom = setupDom();
  const app = dom.makeApp({
    api: dom.makeApiStub({
      optionChain: async () => {
        throw new Error('NSE blocked the request');
      },
    }),
  });
  await loadChain(app);
  const text = dom.$('#chain-table').textContent;
  assert.match(text, /Could not load the option chain/);
  assert.match(text, /NSE blocked the request/);
});

test('a chain with no strikes shows the empty state', async () => {
  const dom = setupDom();
  const app = dom.makeApp({
    api: dom.makeApiStub({
      optionChain: async (sym) => ({ symbol: sym, underlying: 100, expiry: '26-Jun-2026', expiries: ['26-Jun-2026'], source: 'synthetic', strikes: [] }),
    }),
  });
  await loadChain(app);
  assert.match(dom.$('#chain-table').textContent, /No strikes returned/);
});

// --- regression tests for confirmed UI bugs --------------------------------

test('a chain with no underlying renders rows but no FALSE ATM highlight', async () => {
  const dom = setupDom();
  const app = dom.makeApp({
    api: dom.makeApiStub({
      optionChain: async (sym) => {
        const c = dom.syntheticChain(sym);
        c.underlying = null; // missing spot
        return c;
      },
    }),
  });
  await loadChain(app);
  assert.equal(dom.$$('#chain-table tbody tr').length, 5, 'rows still render');
  assert.equal(dom.$('#chain-table .atm-row'), null, 'no strike falsely marked ATM');
});

test('an option with no LTP renders a NON-clickable dash', async () => {
  const dom = setupDom();
  const app = dom.makeApp({
    api: dom.makeApiStub({
      optionChain: async (sym) => {
        const c = dom.syntheticChain(sym);
        c.strikes[0].ce.ltp = null; // missing
        return c;
      },
    }),
  });
  await loadChain(app);
  const ceLtp = dom.$$('#chain-table tbody tr')[0].querySelector('td:nth-child(1)');
  assert.equal(ceLtp.textContent, '–');
  assert.ok(!ceLtp.classList.contains('chain-trade'), 'a no-LTP cell must not be tradable');
});

test('loading the chain feeds option LTPs into a held position so P&L is not frozen (bug #1)', async () => {
  const dom = setupDom();
  const app = dom.makeApp();
  const inst = { kind: 'OPT', symbol: 'NIFTY', expiry: '26-Jun-2026', strike: 23500, optType: 'CE', lotSize: 75, underlyingPrice: 23500 };
  app.engine.placeOrder({ instrument: inst, side: 'BUY', orderType: 'MARKET', lots: 1, price: 100 });
  const key = 'OPT:NIFTY:26-Jun-2026:23500:CE';
  assert.equal(app.engine.state.lastPrices[key], 100); // frozen at fill price until a feed arrives

  await loadChain(app);

  const chainLtp = app.state.chain.strikes.find((s) => s.strike === 23500).ce.ltp;
  assert.ok(chainLtp > 0);
  assert.equal(app.engine.state.lastPrices[key], chainLtp, 'chain LTP fed into the engine');
  assert.ok(Math.abs(app.engine.unrealisedFor(key) - (chainLtp - 100) * 75) < 1e-6);
});

test('a resting F&O limit order fills when the chain shows a crossing price (bug #1)', async () => {
  const dom = setupDom();
  const app = dom.makeApp();
  // BUY LIMIT @200 on the 23400 CE; the synthetic chain prices it at 150 (<=200).
  const inst = { kind: 'OPT', symbol: 'NIFTY', expiry: '26-Jun-2026', strike: 23400, optType: 'CE', lotSize: 75, underlyingPrice: 23500 };
  const o = app.engine.placeOrder({ instrument: inst, side: 'BUY', orderType: 'LIMIT', lots: 1, limitPrice: 200 });
  assert.equal(o.status, 'PENDING');

  await loadChain(app); // the only place F&O limits can be checked

  assert.equal(app.engine.state.orders[0].status, 'FILLED', 'pending F&O limit filled from the chain feed');
});
