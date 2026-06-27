// ---------------------------------------------------------------------------
// test/ui-autopilot.test.mjs
// jsdom test for the Auto-Pilot tab. Drives the REAL autopilot.js against the real
// index.html via the dom harness: the champion preview renders from a stubbed
// /api/tournament, and pressing Start actually COPIES the chosen bot's portfolio
// onto your own engine account (real placeOrder, real positions).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { initAutoPilot, renderAutoPilot } from '../public/js/ui/autopilot.js';

function standings() {
  const curve = Array.from({ length: 10 }, (_, i) => ({ t: i * 864e5, c: 1e7 + i * 1000 }));
  return {
    startingCash: 1e7,
    autopilot: {
      startedAt: Date.parse('2010-01-01'), cash: 1e7,
      metrics: { finalEquity: 2.5e7, liveReturnPct: 0.3, r1w: 1, r1m: 3, r1y: 15, r3y: 50, r5y: 90, r10y: 140, trackReturnPct: 150, sharpe: 1.1, maxDrawdownPct: 22 },
      benchMetrics: { finalEquity: 1.8e7, liveReturnPct: 0.2, r1w: 0.8, r1m: 2, r1y: 10, r3y: 35, r5y: 60, r10y: 90, trackReturnPct: 80, sharpe: 0.6, maxDrawdownPct: 38 },
      benchName: 'Buy & Hold', vsMarketPct: 70,
      currentBot: { id: 'b', name: 'Sharpe King', kind: 'BASKET', symbol: '8 stocks', holdings: [] },
      curve, benchCurve: curve,
      followedTimeline: [
        { t: Date.parse('2010-01-01'), id: 'a', name: 'Steady Eddie' },
        { t: Date.parse('2018-06-01'), id: 'b', name: 'Sharpe King' },
      ],
    },
    bots: [
      { id: 'a', name: 'Steady Eddie', symbol: 'NIFTY', kind: 'EQ', sharpe: 0.4, r1y: 5, r3y: 18, r5y: 30, trackReturnPct: 50, position: '99% long', explain: 'Buy & hold the index.', equity: 1.05e7, curve },
      { id: 'b', name: 'Sharpe King', symbol: '8 stocks', kind: 'BASKET', sharpe: 1.5, r1y: 12, r3y: 40, r5y: 65, trackReturnPct: 80, position: 'RELIANCE 50% · TCS 50%', explain: 'A local-ML basket.', equity: 1.08e7, curve },
    ],
  };
}
const mirrorFor = (id) =>
  id === 'b'
    ? { followable: true, equity: 1.08e7, positions: [
        { key: 'EQ:RELIANCE', kind: 'EQ', symbol: 'RELIANCE', lotSize: 1, qty: 1800, price: 3000, side: 'BUY' },
        { key: 'EQ:TCS', kind: 'EQ', symbol: 'TCS', lotSize: 1, qty: 1500, price: 3600, side: 'BUY' },
      ] }
    : { followable: true, equity: 1.05e7, positions: [{ key: 'EQ:NIFTY', kind: 'EQ', symbol: 'NIFTY', lotSize: 1, qty: 400, price: 25000, side: 'BUY' }] };
const detail = (id) => ({ ok: true, id, name: id, mirror: mirrorFor(id) });

const appWith = (dom) => {
  const app = dom.makeApp({
    api: Object.assign(dom.makeApiStub(), {
      tournament: async () => standings(),
      tournamentBot: async (id) => detail(id),
    }),
  });
  app.engine.reset(10_000_000); // a real ₹1 crore account, to mirror the ₹1cr bots ~1:1
  return app;
};
const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
const masterResidual = (e) => Math.abs(e.realisedTotal() + e.unrealisedTotal() - (e.equity() - e.state.initialCash));

test('renderAutoPilot previews the champion (the best-Sharpe bot)', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  assert.match(dom.$('#ap-champion').textContent, /Sharpe King/, 'the highest-Sharpe bot is the champion');
  assert.match(dom.$('#ap-status').textContent, /Paused/i, 'starts paused (your account is yours until you opt in)');
});

test('the Auto-Pilot tab shows the honest "vs the market" walk-forward track record (bot-style metrics)', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  const tr = dom.$('#ap-track').textContent;
  assert.match(tr, /Auto-Pilot vs the market/, 'the vs-market panel renders');
  assert.match(tr, /Beating the market by \+70/, 'the headline shows the vs-market edge');
  assert.match(tr, /Buy & Hold/, 'names the benchmark');
  assert.match(tr, /1,00,00,000 → ₹2,50,00,000/, 'shows the ₹1cr → current value');
  assert.match(tr, /\+150/, "the Auto-Pilot's MAX return");
  assert.ok(dom.$('#ap-track .ap-tr-table'), 'the bot-style metrics table (1D/1W/.../MAX) renders');
  assert.match(tr, /no hindsight/i, 'discloses it is a walk-forward (no-hindsight) test');
  assert.ok(dom.$('#ap-tr-chart'), 'the dated vs-market chart canvas renders');
});

test('"Reflect this in my account" seeds the track record and does NOT churn on the next tick', async () => {
  const dom = setupDom();
  window.confirm = () => true; // accept the reflect confirmation (the code calls window.confirm)
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');
  dom.fire(dom.$('#ap-toggle'), 'click'); // Start (enable + copy the champion at ₹1cr)
  await flush();

  const seedBtn = dom.$$('#ap-track button').find((b) => /Reflect this in my account/.test(b.textContent));
  assert.ok(seedBtn, 'the "Reflect this in my account" button renders');
  dom.fire(seedBtn, 'click');
  await flush();

  // Account now reflects the walk-forward end-state: ₹2.5cr (the stub's metrics.finalEquity),
  // holding the champion (Sharpe King: RELIANCE + TCS), invariant intact.
  assert.ok(Math.abs(app.engine.equity() - 2.5e7) < 5, 'seeded to the ₹2.5cr earned value');
  assert.ok(app.engine.state.positions['EQ:RELIANCE'], 'holds the champion scaled to the account');
  assert.ok(masterResidual(app.engine) < 0.01, 'MASTER invariant holds on the seeded account');

  // The seed records the champion signature as in-sync, so the next background tick must NOT churn.
  app.engine.state.orders = []; // ignore the seed/import bookkeeping
  await app.autopilotTick();
  assert.equal(app.engine.state.orders.length, 0, 'a freshly seeded account is in sync -> no churn trades on the next tick');
});

test('pressing Start copies the champion portfolio onto the account (real trades)', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot'); // a real user is ON the tab when they press Start

  dom.fire(dom.$('#ap-toggle'), 'click'); // enable + force a first copy
  await flush();

  assert.ok(app.engine.state.positions['EQ:RELIANCE'], 'copied RELIANCE onto the account');
  assert.ok(app.engine.state.positions['EQ:TCS'], 'copied TCS onto the account');
  assert.ok(app.engine.state.positions['EQ:RELIANCE'].qty > 0, 'a real long position');
  assert.match(dom.$('#ap-status').textContent, /Active/i, 'status shows Active — copying Sharpe King');
  assert.ok(masterResidual(app.engine) < 0.01, 'MASTER invariant holds after the copy');
});

test('Pause stops further copying and leaves positions in place', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  dom.fire(dom.$('#ap-toggle'), 'click'); // start
  await flush();
  const heldBefore = Object.keys(app.engine.state.positions).length;
  assert.ok(heldBefore > 0, 'positions were opened');

  dom.fire(dom.$('#ap-toggle'), 'click'); // pause
  await flush();
  assert.equal(Object.keys(app.engine.state.positions).length, heldBefore, 'pausing does not liquidate — positions remain');
  // A disabled tick is a no-op (does not place anything new).
  const res = await app.autopilotTick();
  assert.equal(res.skipped, 'disabled', 'a tick while paused is a no-op');
});

test('Pause clicked DURING an in-flight tick stops the trade and is not reverted', async () => {
  const dom = setupDom();
  // A tournament fetch that hangs until released, so a Pause can land mid-tick.
  let release;
  const gate = new Promise((r) => { release = r; });
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), {
    tournament: async () => { await gate; return standings(); },
    tournamentBot: async (id) => detail(id),
  }) });
  app.engine.reset(10_000_000);
  initAutoPilot(app);
  app.tabs.show('autopilot');

  dom.fire(dom.$('#ap-toggle'), 'click'); // Start -> a forced tick that now awaits the hanging fetch
  dom.fire(dom.$('#ap-toggle'), 'click'); // Pause WHILE that tick is mid-await (sets enabled=false)
  release(); // let the in-flight tick proceed past the await
  await flush();

  const held = Object.values(app.engine.state.positions).filter((p) => p.qty !== 0).length;
  assert.equal(held, 0, 'a paused tick placed NO trades (aborted at the post-await enabled check)');
  const cfg = JSON.parse(globalThis.localStorage.getItem('paper-trade-india:autopilot'));
  assert.equal(cfg.enabled, false, 'Pause was NOT clobbered back to enabled by the in-flight tick');
});

test('switching the followed bot re-copies onto the new bot (manual follow)', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot'); // be on the tab so the picker + status render
  dom.fire(dom.$('#ap-toggle'), 'click'); // start -> copies Sharpe King (basket: RELIANCE + TCS)
  await flush();
  assert.ok(app.engine.state.positions['EQ:RELIANCE'], 'copied the basket first');

  // Switch to manual and follow bot 'a' (Steady Eddie -> NIFTY).
  dom.$('#ap-mode').value = 'manual';
  dom.fire(dom.$('#ap-mode'), 'change');
  await flush();
  // The picker should be visible; follow Steady Eddie via its row button.
  const followBtns = dom.$$('#ap-picker button');
  const eddieRow = dom.$$('#ap-picker tbody tr').find((r) => /Steady Eddie/.test(r.textContent));
  assert.ok(eddieRow, 'the manual picker lists the bots');
  dom.fire(eddieRow.querySelector('button'), 'click');
  await flush();

  assert.ok(app.engine.state.positions['EQ:NIFTY'], 'now holding NIFTY (the new bot)');
  assert.ok(!app.engine.state.positions['EQ:RELIANCE'] || app.engine.state.positions['EQ:RELIANCE'].qty === 0, 'the old basket was sold out of when switching');
});

test('the Auto-Pilot detail view shows what it DID (account history) + the strategy it follows', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  const detail = () => dom.$('#ap-detail').textContent;
  assert.ok(dom.$('#ap-detail'), 'the detail section renders');
  assert.match(detail(), /What your Auto-Pilot did/, 'the account-activity heading shows');
  assert.match(detail(), /The strategy it follows/, 'the followed-strategy heading shows');
  // A fresh (un-traded) account shows the empty trade-history state.
  assert.match(detail(), /No trades yet/, 'an un-traded account shows the empty trade history');
  // The "open full strategy" button targets the followed champion's bot page.
  const btn = dom.$$('#ap-detail button').find((b) => /full strategy/i.test(b.textContent));
  assert.ok(btn && /Sharpe King/.test(btn.textContent), 'the "open full strategy" button names the champion');
  // The walk-forward follow timeline (which bot it followed over the years) shows.
  assert.match(detail(), /Steady Eddie/, 'the follow-timeline lists an earlier followed bot');

  // After Start (copies the champion onto the account), the trade history + per-name P&L populate.
  app.tabs.show('autopilot');
  dom.fire(dom.$('#ap-toggle'), 'click');
  await flush();
  const after = dom.$('#ap-detail').textContent;
  assert.match(after, /[12] copy trade/i, 'the trade-history count updates after copying');
  assert.match(after, /RELIANCE|TCS/, 'a copied instrument appears in the history / per-name P&L');
});

test('a SEEDED account shows an honest "seeded track record" note, not "No trades yet"', async () => {
  const dom = setupDom();
  window.confirm = () => true; // accept the reflect confirmation
  // A multi-YEAR walk-forward curve (200 monthly points ≈ 16y) — so the seeded account is clearly a
  // long track record (buildSeededState carries the curve but NO orders), not a fresh live account.
  const longCurve = Array.from({ length: 200 }, (_, i) => ({ t: Date.parse('2010-01-01') + i * 30 * 864e5, c: 1e7 * (1 + i * 0.02) }));
  const st = standings();
  st.autopilot.curve = longCurve;
  st.autopilot.benchCurve = longCurve;
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), {
    tournament: async () => st,
    tournamentBot: async (id) => detail(id),
  }) });
  app.engine.reset(10_000_000);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');

  const seedBtn = dom.$$('#ap-track button').find((b) => /Reflect this in my account/.test(b.textContent));
  assert.ok(seedBtn, 'the reflect button renders');
  dom.fire(seedBtn, 'click');
  await flush();

  const d = dom.$('#ap-detail').textContent;
  assert.match(d, /seeded from your Auto-Pilot/i, 'the seeded-track note explains the (intentionally) empty per-trade history');
  assert.doesNotMatch(d, /No trades yet/i, 'the misleading "No trades yet" is NOT shown beside a multi-year seeded ₹X track record');
});

test('in MANUAL mode the follow-timeline is labelled as the AUTO alternative, not "what it followed"', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');
  // Switch to manual and follow Steady Eddie (NOT the AUTO walk-forward champion, Sharpe King).
  dom.$('#ap-mode').value = 'manual';
  dom.fire(dom.$('#ap-mode'), 'change');
  await flush();
  const eddieRow = dom.$$('#ap-picker tbody tr').find((r) => /Steady Eddie/.test(r.textContent));
  assert.ok(eddieRow, 'the manual picker lists the bots');
  dom.fire(eddieRow.querySelector('button'), 'click');
  await flush();

  const d = dom.$('#ap-detail').textContent;
  // The AUTO walk-forward timeline must NOT be presented as "what it followed" — the account is
  // manually following Steady Eddie, so the timeline is labelled as the AUTO reference alternative.
  assert.match(d, /manually following Steady Eddie/i, 'the timeline intro names the manually-followed bot');
  assert.match(d, /AUTO mode would instead follow/i, 'labels the walk-forward timeline as the AUTO alternative');
  assert.doesNotMatch(d, /Which bot it would have followed over the years/i, 'does not present the AUTO timeline as the account\'s own history in manual mode');
});

test('the "vs the market" chart shows a colour legend + a time-window selector', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  const track = dom.$('#ap-track');
  // The legend labels which colour is which — instead of only naming them in the chart
  // title. Two swatches: Auto-Pilot + the market (the benchmark name).
  const legend = track.querySelector('.chart-legend');
  assert.ok(legend, 'the colour legend renders');
  assert.equal(legend.querySelectorAll('.legend-swatch').length, 2, 'two swatches — Auto-Pilot + the market');
  assert.match(legend.textContent, /Auto-Pilot/, 'labels the Auto-Pilot line');
  assert.match(legend.textContent, /Buy & Hold.*market|market/i, 'labels the market (benchmark) line');
  // And a window selector above the dated curve (the stub flat curve falls back gracefully —
  // no tiers — and still renders all seven buttons).
  assert.equal(track.querySelectorAll('.chart-window-btn').length, 7, 'the 1D..MAX window selector renders');
  assert.ok(dom.$('#ap-tr-chart'), 'the dated vs-market chart still renders');
});

test('a data-starved mirror (followable:false) is a HOLD, never a liquidation (regression: cold-boot wipe)', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');
  dom.fire(dom.$('#ap-toggle'), 'click'); // Start -> copies the champion (RELIANCE + TCS)
  await flush();
  assert.ok(app.engine.state.positions['EQ:RELIANCE'].qty > 0, 'the champion was copied');
  const heldBefore = Object.keys(app.engine.state.positions).filter((k) => app.engine.state.positions[k].qty !== 0).sort();
  const ordersBefore = app.engine.state.orders.length;
  // The server cold-boots: the bot's market data hasn't loaded yet, so its mirror comes
  // back EMPTY at starting cash, flagged followable:false. The old client read the empty
  // book as "the bot went to cash" and SOLD every held position into cash.
  app.api.tournamentBot = async (id) => ({ ok: true, id, name: id, mirror: { followable: false, equity: 1e7, positions: [] } });
  await app.autopilotTick({ force: true });
  assert.equal(app.engine.state.orders.length, ordersBefore, 'no orders were placed against a data-starved mirror');
  const heldAfter = Object.keys(app.engine.state.positions).filter((k) => app.engine.state.positions[k].qty !== 0).sort();
  assert.deepEqual(heldAfter, heldBefore, 'every position is held as-is');
  assert.match(dom.$('#ap-status').textContent, /still loading/i, 'the status explains the hold (and that it will retry)');
});

test('a manual Close of a copied leg breaks "in sync" — the next background tick re-copies it (regression)', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  // A half-invested mirror so the copy fully fills and records "synced" (the shared stub's
  // fully-invested champion always clips its last leg by a rounding hair, leaving lastSig
  // null — which would mask the in-sync bug this test locks).
  app.api.tournamentBot = async (id) => ({ ok: true, id, name: id, mirror: { followable: true, equity: 1e7, positions: [
    { key: 'EQ:RELIANCE', kind: 'EQ', symbol: 'RELIANCE', lotSize: 1, qty: 1000, price: 3000, side: 'BUY' },
  ] } });
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');
  dom.fire(dom.$('#ap-toggle'), 'click'); // Start -> copies 1000 RELIANCE (affordable, fully synced)
  await flush();
  assert.equal(app.engine.state.positions['EQ:RELIANCE'].qty, 1000, 'copied and fully filled');

  // A manual Close of the whole copied leg (a plain ticket order, no Auto-Pilot tag).
  app.engine.placeOrder({ instrument: { kind: 'EQ', symbol: 'RELIANCE', lotSize: 1 }, side: 'SELL', orderType: 'MARKET', lots: 1000, price: 3000 });
  assert.ok(!app.engine.state.positions['EQ:RELIANCE'] || app.engine.state.positions['EQ:RELIANCE'].qty === 0, 'manually closed');

  // An ordinary UNFORCED background tick: the bot hasn't rebalanced (same signature), but the
  // account's book no longer matches the target — the old one-way check reported "In sync (no
  // change)" and left the account drifted until the bot's next rebalance.
  await app.autopilotTick();
  const p = app.engine.state.positions['EQ:RELIANCE'];
  assert.ok(p && p.qty > 900, 'the missing leg was re-copied (got ' + (p ? p.qty : 0) + ')');
  const recopied = app.engine.state.orders.find((o) => o.status === 'FILLED' && o.side === 'BUY' && /Auto-Pilot/.test(o.reason || '') && o.instrument.symbol === 'RELIANCE');
  assert.ok(recopied, 'the re-copy is a tagged Auto-Pilot order');
});

test('the detail view counts ONLY Auto-Pilot fills as copy trades (regression: manual trades mis-attributed)', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  // A manual round-trip placed BEFORE the Auto-Pilot ever runs: +1,000 booked BY HAND.
  const inst = { kind: 'EQ', symbol: 'WIPRO', lotSize: 1 };
  app.engine.placeOrder({ instrument: inst, side: 'BUY', orderType: 'MARKET', lots: 10, price: 100 });
  app.engine.placeOrder({ instrument: inst, side: 'SELL', orderType: 'MARKET', lots: 10, price: 200 });
  await renderAutoPilot(app);
  let d = dom.$('#ap-detail').textContent;
  assert.match(d, /Trade history \(0 copy trades\)/, 'manual fills are NOT counted as copy trades');
  assert.match(d, /placed manually/i, 'the empty state says the existing trades were manual');
  assert.ok(!/WIPRO/.test(d.split('Per-name booked')[1] || ''), 'manual P&L is not attributed to the Auto-Pilot');

  // Now the Auto-Pilot actually copies — its tagged fills DO count.
  app.tabs.show('autopilot');
  dom.fire(dom.$('#ap-toggle'), 'click');
  await flush();
  await renderAutoPilot(app);
  d = dom.$('#ap-detail').textContent;
  assert.match(d, /Trade history \(2 copy trades\)/, 'exactly the two Auto-Pilot fills are counted (WIPRO still excluded)');
});

test('"Start fresh" while PAUSED clears the stale activity log (regression)', async () => {
  const dom = setupDom();
  window.confirm = () => true;
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');
  dom.fire(dom.$('#ap-toggle'), 'click'); // Start -> copy (populates the activity log)
  await flush();
  assert.match(dom.$('#ap-actions').textContent, /RELIANCE/, 'the copy trades show in the activity log');
  dom.fire(dom.$('#ap-toggle'), 'click'); // Pause
  await flush();
  dom.fire(dom.$('#ap-fresh'), 'click'); // Start fresh (while paused -> no tick to refresh)
  await flush();
  assert.ok(!/RELIANCE/.test(dom.$('#ap-actions').textContent), 'the wiped account no longer shows the earlier trades');
  assert.equal(app.engine.equity(), 10_000_000, 'the account really was reset');
});

test('a "Follow" click during an in-flight tick is not clobbered by the finishing tick (regression)', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  initAutoPilot(app);
  await renderAutoPilot(app);
  app.tabs.show('autopilot');
  // Use a half-invested champion so the Start copy records "synced" (see the re-copy test).
  const halfMirror = (id) => id === 'b'
    ? { followable: true, equity: 1e7, positions: [{ key: 'EQ:RELIANCE', kind: 'EQ', symbol: 'RELIANCE', lotSize: 1, qty: 1000, price: 3000, side: 'BUY' }] }
    : { followable: true, equity: 1e7, positions: [{ key: 'EQ:NIFTY', kind: 'EQ', symbol: 'NIFTY', lotSize: 1, qty: 100, price: 25000, side: 'BUY' }] };
  const origBot = async (id) => ({ ok: true, id, name: id, mirror: halfMirror(id) });
  app.api.tournamentBot = origBot;
  dom.fire(dom.$('#ap-toggle'), 'click'); // Start -> copies champion 'b', records synced
  await flush();

  // Gate the NEXT background tick so it suspends mid-flight on the detail fetch.
  let release;
  const gate = new Promise((r) => { release = r; });
  app.api.tournamentBot = async (id) => { await gate; return { ok: true, id, name: id, mirror: halfMirror(id) }; };
  const inFlight = app.autopilotTick(); // unforced 30s-style background tick

  // A "Follow Steady Eddie" click arrives while it is in flight: followBot writes
  // mode=manual + followId='a' and queues a forced tick (coalesced because we're busy).
  const CFG_KEY = 'paper-trade-india:autopilot';
  const cfg = JSON.parse(localStorage.getItem(CFG_KEY));
  Object.assign(cfg, { mode: 'manual', followId: 'a', lastSig: null });
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  const queued = app.autopilotTick({ force: true }); // coalesces (pendingForce)

  app.api.tournamentBot = origBot; // un-gate the api for the coalesced tick
  release();
  await inFlight;
  await queued;
  await flush();

  // The finishing background tick used to patch followId back to its own stale target
  // ('b'), so the coalesced forced tick copied the WRONG bot. That choice must win.
  const after = JSON.parse(localStorage.getItem(CFG_KEY));
  assert.equal(after.followId, 'a', 'the Follow choice survives the finishing tick');
  assert.ok(app.engine.state.positions['EQ:NIFTY'] && app.engine.state.positions['EQ:NIFTY'].qty > 0, 'the coalesced tick copied the bot that was chosen');
});
