// ---------------------------------------------------------------------------
// test/ui-tournament.test.mjs
// jsdom test for the Tournament tab UI. The leaderboard renders from a stubbed
// /api/tournament payload (symbols, kind badges, evolution log). CLICKING A BOT
// opens its full portfolio PAGE directly — there is no inline detail card any
// more; the page shows the strategy rationale, why-each-stock, per-stock P&L,
// and the full trade history.
// Drives the REAL renderTournament against the real index.html via the dom harness.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setupDom } from '../test-helpers/dom-harness.mjs';
import { renderTournament, initTournament } from '../public/js/ui/tournament.js';

function standings() {
  const curve = Array.from({ length: 20 }, (_, i) => ({ t: i * 864e5, c: 10000000 + i * 12000 }));
  return {
    deployedAt: Date.parse('2026-06-15T00:00:00Z'),
    generation: 2,
    liveBars: 0,
    startingCash: 10000000,
    asOf: 1000,
    history: [{ gen: 1, promoted: 'Wide strangle v551 (BANKNIFTY)', retired: 'RSI dip (TCS)', at: 1 }],
    bots: [
      { id: 'bh', name: 'Buy & Hold', symbol: 'NIFTY', kind: 'EQ', gen: 0, protected: true, note: 'benchmark', explain: 'Always fully invested (buy & hold).', liveReturnPct: 0, trackReturnPct: 5.1, sharpe: 0.3, maxDrawdownPct: 12, position: '99% long', equity: 10510000, curve },
      { id: 'str', name: 'Wide strangle', symbol: 'BANKNIFTY', kind: 'FNO', gen: 1, protected: false, note: 'evolved', explain: 'Each month: sell 6% OTM call, sell 6% OTM put.', liveReturnPct: 0, trackReturnPct: 8.4, sharpe: 1.1, maxDrawdownPct: 9, position: 'open: S2x 52000CE', equity: 10840000, curve },
      { id: 'bk', name: 'ML ridge basket', symbol: '8 stocks', kind: 'BASKET', gen: 0, protected: false, note: '', explain: 'Every ~21 bars: hold the top 3 of 8 names, ranked by a local ridge model (walk-forward, no external data; falls back to the 63-day return), rank-weighted.', liveReturnPct: 0, trackReturnPct: 3.2, sharpe: 0.8, maxDrawdownPct: 7, position: 'RELIANCE 34% · TCS 33% · INFY 33%', equity: 10320000, curve, holdings: [{ symbol: 'RELIANCE', weightPct: 34 }, { symbol: 'TCS', weightPct: 33 }, { symbol: 'INFY', weightPct: 33 }] },
    ],
  };
}

// A minimal per-bot page payload for any id (clicking a row fetches this).
const baseDetail = (id, over = {}) => ({
  ok: true, id, name: { bh: 'Buy & Hold', str: 'Wide strangle', bk: 'ML ridge basket' }[id] || id,
  kind: 'EQ', symbol: 'NIFTY', interval: '1d', gen: 0,
  metrics: { totalReturnPct: 0, sharpe: 0, maxDrawdownPct: 0, trades: 0 },
  equity: 10000000, tradeCount: 0, liveTradeCount: 0, totalRealised: 0,
  rationale: { headline: 'Strategy', thesis: 'a thesis', params: [], risk: 'risk' },
  decision: null, contributions: [], holdings: null, position: 'flat', trades: [], ...over,
});

const appWith = (dom, botById = {}) => dom.makeApp({
  api: Object.assign(dom.makeApiStub(), {
    tournament: async () => standings(),
    tournamentBot: async (id) => botById[id] || baseDetail(id),
  }),
});
const flush = () => new Promise((r) => setTimeout(r, 0));
const clickBot = (dom, id) => dom.fire(dom.$(`#tourn-table tr[data-id="${id}"]`), 'click');

test('renderTournament draws the leaderboard with symbols, kind badges, and history', async () => {
  const dom = setupDom();
  await renderTournament(appWith(dom));
  const table = dom.$('#tourn-table').textContent;
  assert.match(table, /Buy & Hold/);
  assert.match(table, /Wide strangle/);
  assert.match(table, /NIFTY/, 'the Symbol column shows the underlying');
  assert.match(table, /BANKNIFTY/);
  assert.ok(dom.$('#tourn-table .kind-badge.FNO'), 'kind renders as a colour-coded badge');
  assert.match(dom.$('#tourn-meta').textContent, /Gen 2/);
  assert.match(dom.$('#tourn-meta').textContent, /1,00,00,000/, '₹1 crore each in the header');
  assert.match(dom.$('#tourn-history').textContent, /Gen 1: promoted/);
});

test('the equity-race legend shows a colour key for the strategy kinds on the board', async () => {
  const dom = setupDom();
  await renderTournament(appWith(dom)); // payload has EQ + FNO + BASKET bots
  const legend = dom.$('#tourn-legend');
  assert.ok(legend, 'the legend container exists');
  const swatches = legend.querySelectorAll('.legend-swatch');
  assert.equal(swatches.length, 3, 'one swatch per distinct kind present (EQ, FNO, BASKET)');
  assert.match(legend.textContent, /Equity/);
  assert.match(legend.textContent, /F&O/);
  assert.match(legend.textContent, /Basket/);
  // The big-number formatting: the leaderboard shows equity in compact crores, not a 9-digit ₹.
  assert.match(dom.$('#tourn-table').textContent, /₹1\.05 Cr/, 'equity shown compactly in crores');
});

test('breeding-off mode hides the Evolve button and shows a curated-board note', async () => {
  const dom = setupDom();
  const data = standings();
  data.evolutionEnabled = false; // the production server runs with breeding off
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), { tournament: async () => data, tournamentBot: async (id) => baseDetail(id) }) });
  await renderTournament(app);
  assert.equal(dom.$('#btn-evolve').hidden, true, 'the Evolve button is hidden when breeding is off');
  assert.equal(dom.$('#btn-add-bot').hidden, true, 'the "+ Add bot" (generated-pool) button is also hidden — board stays curated');
  assert.match(dom.$('#tourn-history').textContent, /[Bb]reeding is off/, 'the log explains breeding is off');
  assert.match(dom.$('#tourn-meta').textContent, /curated/, 'the meta line notes the curated line-up');
});

test('a missing-history period (null) renders a bare "–" (not "–%") and always sorts to the END', async () => {
  // The server sends literal null for a window the bot lacks history for (e.g. the ~2y
  // intraday bot's 5Y/10Y). Number(null)===0 is finite, so an unguarded check would slip
  // past and render "–%"; and a NaN→-Infinity sort would float nulls to the TOP ascending.
  const dom = setupDom();
  const data = standings();
  data.bots[0].r5y = null; data.bots[1].r5y = 30; data.bots[2].r5y = -5;
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), { tournament: async () => data, tournamentBot: async (id) => baseDetail(id) }) });
  await renderTournament(app);
  // Columns: 0# 1name 2symbol 3kind 4·1D 5·1W 6·1M 7·1Y 8·5Y …
  const td5y = (id) => dom.$(`#tourn-table tr[data-id="${id}"]`).querySelectorAll('td')[8];
  assert.equal(td5y('bh').textContent, '–', 'a null 5Y renders a bare "–", never "–%"');
  const th5y = () => dom.$$('#tourn-table thead th').find((t) => /^5Y/.test(t.textContent));
  const lastRowId = () => { const r = dom.$$('#tourn-table tbody tr'); return r[r.length - 1].getAttribute('data-id'); };
  dom.fire(th5y(), 'click'); // 5Y descending
  assert.equal(lastRowId(), 'bh', 'the null-5Y bot sinks to the bottom (descending)');
  dom.fire(th5y(), 'click'); // toggle to ascending
  assert.equal(lastRowId(), 'bh', 'the null-5Y bot STAYS at the bottom (ascending too)');
});

test('the evolution log shows an ADD event (grow mode, no retirement) with no "retired" text', async () => {
  const dom = setupDom();
  const data = standings();
  data.history = [{ gen: 3, promoted: 'Momentum basket v777 (12 stocks)', retired: null, at: 2 }];
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), { tournament: async () => data }) });
  await renderTournament(app);
  const log = dom.$('#tourn-history').textContent;
  assert.match(log, /Gen 3: added/, 'an add event reads "added"');
  assert.match(log, /Momentum basket v777/, 'the added bot is named');
  assert.doesNotMatch(log, /retired/, 'no retirement is shown for an add event');
});

test('the leaderboard colours Track % and Equity by profit (green/up) vs loss (red/down)', async () => {
  const dom = setupDom();
  const data = standings();
  data.bots[0].trackReturnPct = 5.1; data.bots[0].equity = 10510000;   // a winner
  data.bots[1].trackReturnPct = -8.3; data.bots[1].equity = 9170000;   // a loser (below ₹1cr)
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), { tournament: async () => data }) });
  await renderTournament(app);
  const tds = (id) => dom.$(`#tourn-table tr[data-id="${id}"]`).querySelectorAll('td');
  // Columns: 0# 1name 2symbol 3kind 4·1D 5·1W 6·1M 7·1Y 8·5Y 9·10Y 10·MAX 11Sharpe 12MaxDD 13pos 14Equity 15×
  assert.ok(tds('bh')[10].className.includes('up'), 'a positive MAX is green (up)');
  assert.ok(tds('str')[10].className.includes('down'), 'a negative MAX is red (down)');
  assert.ok(tds('bh')[14].className.includes('up'), 'equity above ₹1cr is green');
  assert.ok(tds('str')[14].className.includes('down'), 'equity below ₹1cr is red');
});

test('clicking a bot opens its full portfolio PAGE directly (no inline detail card)', async () => {
  const dom = setupDom();
  await renderTournament(appWith(dom));
  assert.equal(dom.$('#tourn-detail'), null, 'the inline detail card is gone (replaced by the page)');
  clickBot(dom, 'str');
  await flush();
  assert.equal(dom.$('#tourn-botpage').hidden, false, 'the per-bot page is shown on a row click');
  assert.equal(dom.$('#tourn-board').hidden, true, 'the leaderboard is hidden behind it');
  assert.match(dom.$('#tourn-botpage-body').textContent, /Wide strangle/, 'the clicked bot’s page renders');
});

test('the board meta shows the bot count and flags when grow-mode evolution is paused (board full)', async () => {
  const dom = setupDom();
  const data = standings();
  data.atCap = true; data.maxBots = 24; data.botCount = 24;
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), { tournament: async () => data }) });
  await renderTournament(app);
  const meta = dom.$('#tourn-meta').textContent;
  assert.match(meta, /24\/24 bots/, 'shows how full the growing board is');
  assert.match(meta, /full — evolution paused/i, 'flags that growth is paused at the cap');
});

test('clicking a bot opens its page with the full trade history (dates, stocks, realised P&L)', async () => {
  const dom = setupDom();
  const bk = baseDetail('bk', {
    kind: 'BASKET', symbol: '8 stocks', tradeCount: 2, liveTradeCount: 1, deployAt: Date.parse('2026-01-20'),
    trades: [
      { t: Date.parse('2026-01-05'), symbol: 'RELIANCE', side: 'BUY', qty: 120, price: 2850.5, value: 342060, realised: 0, live: false, reason: 'Entered' },
      { t: Date.parse('2026-02-05'), symbol: 'RELIANCE', side: 'SELL', qty: 120, price: 3010.0, value: 361200, realised: 19140, live: true, reason: 'Exited' },
    ],
  });
  const dom2 = appWith(dom, { bk });
  await renderTournament(dom2);
  clickBot(dom, 'bk');
  await flush();
  const page = dom.$('#tourn-botpage-body').textContent;
  assert.match(page, /full trade history/i, 'the trade-history section renders on the page');
  assert.match(page, /RELIANCE/, 'a traded stock is listed');
  assert.match(page, /19,?140/, 'the realised P&L of the closing trade shows');
});

test('a failed bot-detail fetch shows a soft error on the page (not a crash)', async () => {
  const dom = setupDom();
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), {
    tournament: async () => standings(),
    tournamentBot: async () => { throw new Error('500'); },
  }) });
  await renderTournament(app);
  clickBot(dom, 'str');
  await flush();
  assert.match(dom.$('#tourn-botpage-body').textContent, /could.?n.?t load/i, 'a soft error is shown on the page');
});

test('a warming-up (failed) tournament endpoint shows a friendly message, no throw', async () => {
  const dom = setupDom();
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), { tournament: async () => { throw new Error('503'); } }) });
  await assert.doesNotReject(renderTournament(app));
  assert.match(dom.$('#tourn-table').textContent, /warming up/i);
});

test('a failed REFRESH after a good render clears the leaderboard + log (no stale content)', async () => {
  const dom = setupDom();
  let fail = false;
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), { tournament: async () => { if (fail) throw new Error('503'); return standings(); } }) });
  await renderTournament(app);
  assert.ok(dom.$('#tourn-history').textContent.trim().length > 0, 'evolution log is populated after a good render');
  fail = true;
  await renderTournament(app);
  assert.match(dom.$('#tourn-table').textContent, /warming up/i, 'table shows warming-up');
  assert.equal(dom.$('#tourn-history').textContent.trim(), '', 'evolution log is cleared, not left stale');
});

test('an intraday bot shows its interval tag (60m) in the table and on its page', async () => {
  const dom = setupDom();
  const data = standings();
  data.bots.push({ id: 'intra', name: 'Intraday breakout', symbol: 'RELIANCE', kind: 'EQ', interval: '60m', gen: 0, protected: false, note: '', explain: 'Hourly breakout on RELIANCE.', liveReturnPct: 1.2, trackReturnPct: 4.0, sharpe: 0.5, maxDrawdownPct: 6, position: '95% long', equity: 10400000, curve: data.bots[0].curve });
  const intra = baseDetail('intra', { kind: 'EQ', symbol: 'RELIANCE', interval: '60m' });
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), { tournament: async () => data, tournamentBot: async () => intra }) });
  await renderTournament(app);
  const row = dom.$('#tourn-table tr[data-id="intra"]');
  assert.match(row.textContent, /60m/, 'the Kind cell tags the intraday interval');
  clickBot(dom, 'intra');
  await flush();
  assert.match(dom.$('#tourn-botpage-body').textContent, /60m intraday/i, 'the page flags the intraday interval');
});

test('the per-bot PAGE shows strategy rationale, why-each-stock, ML weights, contributions', async () => {
  const dom = setupDom();
  const bk = baseDetail('bk', {
    kind: 'BASKET', symbol: '8 stocks', deployAt: Date.parse('2026-01-20'),
    metrics: { totalReturnPct: 3.2, sharpe: 0.8, maxDrawdownPct: 7, trades: 12 },
    equity: 10320000, tradeCount: 12, liveTradeCount: 3, totalRealised: 42000,
    rationale: { headline: 'Machine learning — a local ridge model picks the names', thesis: 'A small ridge regression trained walk-forward picks the names.', params: [{ label: 'Universe', value: '8 stocks' }, { label: 'Holdings', value: 'the top 3' }], risk: 'Concentrated in just 3 names.' },
    decision: {
      t: Date.parse('2026-06-01'), riskOn: true, universeSize: 8, passedGate: 6,
      candidates: [
        { sym: 'RELIANCE', score: 0.12, ruleScore: 0.08, vol: 0.015, chosen: true, weightPct: 50 },
        { sym: 'TCS', score: 0.09, ruleScore: 0.05, vol: 0.012, chosen: true, weightPct: 50 },
        { sym: 'INFY', score: 0.04, ruleScore: 0.03, vol: 0.02, chosen: false, weightPct: 0 },
      ],
      mlWeights: { model: 'ridge', bias: 0.01, features: [{ feature: 'mom63', weight: 0.05 }, { feature: 'rsi14', weight: -0.02 }] },
    },
    contributions: [{ symbol: 'RELIANCE', realised: 30000, weightPct: 50 }, { symbol: 'TCS', realised: 12000, weightPct: 50 }],
    holdings: [{ symbol: 'RELIANCE', weightPct: 50 }, { symbol: 'TCS', weightPct: 50 }],
    position: 'RELIANCE 50% · TCS 50%',
    trades: [{ t: Date.parse('2026-05-01'), symbol: 'RELIANCE', side: 'BUY', qty: 100, price: 2800, value: 280000, realised: 0, live: true, reason: 'Entered — the 63-day return ranked it #1 of 24 (held the top 3)' }],
  });
  const app = appWith(dom, { bk });
  dom.withoutTimers(() => initTournament(app)); // wires the back button (no leaked poll timer)
  await renderTournament(app);
  clickBot(dom, 'bk');
  await flush();

  assert.equal(dom.$('#tourn-botpage').hidden, false, 'the bot page is shown');
  assert.equal(dom.$('#tourn-board').hidden, true, 'the leaderboard is hidden behind it');
  const page = dom.$('#tourn-botpage-body').textContent;
  assert.match(page, /Strategy — Machine learning/i, 'the in-depth strategy rationale shows');
  assert.match(page, /Holdings & why/i, 'the "why each stock was chosen" section shows');
  assert.match(page, /RELIANCE/, 'a scanned/chosen stock is listed');
  assert.match(page, /✓ 50%/, 'a chosen name shows its target weight');
  assert.match(page, /What the ridge model learned/i, 'the ML feature weights are shown');
  assert.match(page, /mom63/, 'a model feature is named');
  assert.match(page, /booked P&L/i, 'the per-stock P&L contributions show');
  assert.match(page, /Entered — the 63-day return ranked it/, 'the trade history shows a per-trade REASON');

  dom.fire(dom.$('#btn-botpage-back'), 'click');
  assert.equal(dom.$('#tourn-board').hidden, false, 'back to the leaderboard');
  assert.equal(dom.$('#tourn-botpage').hidden, true, 'the page is hidden again');
});

test('the per-bot page guards against a STALE fetch overwriting a newer open (request token)', async () => {
  const dom = setupDom();
  const bkResolvers = [];
  const mk = (name, kind, symbol) => baseDetail(name, { name, kind, symbol, rationale: { headline: name, thesis: 't', params: [], risk: 'r' } });
  const bkDetail = mk('BK BASKET PAGE', 'BASKET', '8 stocks');
  const strDetail = mk('STR FNO PAGE', 'FNO', 'BANKNIFTY');
  const api = Object.assign(dom.makeApiStub(), {
    tournament: async () => standings(),
    tournamentBot: (id) => (id === 'bk'
      ? new Promise((res) => bkResolvers.push(() => res(bkDetail)))
      : Promise.resolve(strDetail)),
  });
  const app = dom.makeApp({ api });
  dom.withoutTimers(() => initTournament(app));
  await renderTournament(app);

  clickBot(dom, 'bk'); // its fetch stays pending
  await flush();
  assert.match(dom.$('#tourn-botpage-body').textContent, /Loading/i, 'bk page is loading (fetch pending)');

  dom.fire(dom.$('#btn-botpage-back'), 'click');
  clickBot(dom, 'str'); // resolves immediately
  await flush();
  assert.match(dom.$('#tourn-botpage-body').textContent, /STR FNO PAGE/, 'the newer (str) page rendered');

  bkResolvers.forEach((r) => r()); // the stale bk fetch resolves LAST
  await flush();
  const body = dom.$('#tourn-botpage-body').textContent;
  assert.match(body, /STR FNO PAGE/, 'still the newer page after the stale fetch resolves');
  assert.doesNotMatch(body, /BK BASKET PAGE/, 'the superseded bk fetch did not clobber the page');
});

test('the per-bot page surfaces factor z-scores, optimiser risk %, and tree-model importances', async () => {
  const dom = setupDom();
  const bk = baseDetail('bk', {
    kind: 'BASKET', symbol: '12 stocks',
    metrics: { totalReturnPct: 4, sharpe: 0.9, maxDrawdownPct: 8, trades: 10 }, equity: 10400000, tradeCount: 10, liveTradeCount: 2, totalRealised: 1000,
    rationale: { headline: 'Multi-factor model — blend several signals', thesis: 'blend several standardised factors', params: [], risk: 'r' },
    decision: {
      t: Date.parse('2026-06-01'), riskOn: true, weighting: 'meanvar', universeSize: 12, passedGate: 5,
      candidates: [
        { sym: 'RELIANCE', score: 1.2, ruleScore: 0.1, vol: 0.015, chosen: true, weightPct: 45, riskPct: 50, factors: [{ name: 'momentum', z: 1.1 }, { name: 'low-vol', z: 0.4 }] },
        { sym: 'TCS', score: 0.3, ruleScore: 0.05, vol: 0.012, chosen: true, weightPct: 55, riskPct: 50, factors: [{ name: 'momentum', z: 0.2 }, { name: 'low-vol', z: 0.6 }] },
      ],
      mlWeights: { model: 'gbm', importance: true, bias: 0, features: [{ feature: 'mom63', weight: 0.6 }, { feature: 'rsi14', weight: 0.4 }] },
    },
    holdings: [{ symbol: 'RELIANCE', weightPct: 45 }, { symbol: 'TCS', weightPct: 55 }], position: 'RELIANCE 45% · TCS 55%',
  });
  const app = appWith(dom, { bk });
  dom.withoutTimers(() => initTournament(app));
  await renderTournament(app);
  clickBot(dom, 'bk');
  await flush();
  const page = dom.$('#tourn-botpage-body').textContent;
  assert.match(page, /momentum/i, 'a factor-name column shows');
  assert.match(page, /low-vol/i, 'the second factor shows');
  assert.match(page, /Risk %/i, 'the optimiser risk-contribution column shows');
  assert.match(page, /mean-variance/i, 'the weighting note shows');
  assert.match(page, /feature importance/i, 'tree-model importances are relabelled (not "weights")');
  assert.match(page, /mom63/, 'a model feature is named');
});

test('a PAIRS bot per-bot page renders the spread/pairs "why" table (z, β, corr, state)', async () => {
  const dom = setupDom();
  const bk = baseDetail('bk', {
    kind: 'PAIRS', symbol: '6 pairs',
    metrics: { totalReturnPct: 2.7, sharpe: 0.62, maxDrawdownPct: 7, trades: 40 }, equity: 10270000, tradeCount: 40, liveTradeCount: 6, totalRealised: 5000,
    rationale: { headline: 'Statistical arbitrage — bet on convergence, not direction', thesis: 'long the cheap leg, short the rich one of a co-moving pair', params: [{ label: 'Pairs held', value: 'up to 6' }], risk: 'market-neutral' },
    decision: {
      t: Date.parse('2026-06-01'), maxPairs: 6, entryZ: 2, exitZ: 0.5, lookback: 60, formationBars: 21,
      pairs: [
        { a: 'HDFCBANK', b: 'ICICIBANK', beta: 1.22, corr: 0.81, phi: 0.86, z: 2.3, state: 'short spread' },
        { a: 'TCS', b: 'INFY', beta: 0.73, corr: 0.9, phi: 0.81, z: -0.2, state: 'flat' },
      ],
    },
    holdings: [{ symbol: 'HDFCBANK', weightPct: -15 }, { symbol: 'ICICIBANK', weightPct: 15 }], position: 'S HDFCBANK/ICICIBANK',
    trades: [{ t: Date.parse('2026-05-01'), symbol: 'HDFCBANK', side: 'SELL', qty: 100, price: 1600, value: 160000, realised: 0, live: true, reason: 'Opened HDFCBANK/ICICIBANK: shorted HDFCBANK (spread rich, z=+2.30)' }],
  });
  const app = appWith(dom, { bk });
  dom.withoutTimers(() => initTournament(app));
  await renderTournament(app);
  clickBot(dom, 'bk');
  await flush();
  const page = dom.$('#tourn-botpage-body').textContent;
  assert.match(page, /Statistical arbitrage/i, 'the stat-arb rationale shows');
  assert.match(page, /Pairs & spreads/i, 'the pairs "why" section renders (not the basket candidates table)');
  assert.match(page, /HDFCBANK \/ ICICIBANK/, 'a pair is listed');
  assert.match(page, /short spread/i, 'the pair state shows');
  assert.match(page, /shorted HDFCBANK/i, 'the trade history shows the short-leg reason');
});

test('the equity-race chart has a time-window selector (1D/.../MAX) that re-renders on click', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  await renderTournament(app);
  const win = dom.$('#tourn-chart-windows');
  assert.ok(win, 'the window-selector container renders above the race chart');
  const btns = () => [...dom.$('#tourn-chart-windows').querySelectorAll('.chart-window-btn')];
  assert.equal(btns().length, 7, 'a button per window (1D..MAX)');
  assert.equal(btns().filter((b) => b.classList.contains('active'))[0].textContent, 'MAX', 'defaults to MAX (whole life)');
  // The stub curves span ~19 days, so 1W is enabled but 1M+ are greyed out.
  assert.ok(btns().find((b) => b.textContent === '1W' && !b.disabled), '1W is enabled for ~19 days of data');
  assert.ok(btns().find((b) => b.textContent === '1M').disabled, '1M is disabled (longer than the data)');
  dom.fire(btns().find((b) => b.textContent === '1W'), 'click');
  assert.equal(btns().filter((b) => b.classList.contains('active'))[0].textContent, '1W', 'clicking a window activates it (and re-renders the chart)');
  dom.fire(btns().find((b) => b.textContent === 'MAX'), 'click'); // restore the default for later tests
});

test('the per-bot PAGE equity curve has its own time-window selector', async () => {
  const dom = setupDom();
  const app = appWith(dom);
  dom.withoutTimers(() => initTournament(app));
  await renderTournament(app);
  clickBot(dom, 'bh');
  await flush();
  const page = dom.$('#tourn-botpage-body');
  assert.match(page.textContent, /Equity curve/, 'the equity curve section renders');
  const btns = [...page.querySelectorAll('.chart-window-btn')];
  assert.equal(btns.length, 7, 'the per-bot page curve has a window selector too');
  // Switching the window is a pure client-side redraw (no re-fetch) — clicking an enabled
  // window just flips the active button.
  const wk = btns.find((b) => b.textContent === '1W');
  assert.ok(wk && !wk.disabled, '1W is available');
  dom.fire(wk, 'click');
  const active = [...page.querySelectorAll('.chart-window-btn')].filter((b) => b.classList.contains('active'))[0];
  assert.equal(active.textContent, '1W', 'the per-bot page window switches on click');
});

test('the race-chart window buttons are cleared (not stranded) when the board goes empty / warming-up', async () => {
  // Regression: #tourn-chart-windows is a STATIC element only populated on the happy path,
  // so the failed-poll (503) catch and the empty-board return must clear it too — else the
  // 7 buttons strand over the "warming up" / "No bots running" state and a click repaints
  // the whole stale leaderboard.
  const dom = setupDom();
  let mode = 'ok';
  const app = dom.makeApp({ api: Object.assign(dom.makeApiStub(), {
    tournament: async () => {
      if (mode === 'fail') throw new Error('503');
      if (mode === 'empty') { const s = standings(); s.bots = []; return s; }
      return standings();
    },
  }) });
  const btnCount = () => dom.$('#tourn-chart-windows').querySelectorAll('.chart-window-btn').length;
  // The colour legend is ANOTHER sibling pane that must drop down with the buttons — leaving it
  // stale beside "warming up" / "No bots running" was a gap (the 503-catch used to omit it).
  // (.chart-legend is rendered into #tourn-legend by renderLegend on the happy path.)
  const legendCount = () => dom.$('#tourn-legend').querySelectorAll('.legend-swatch').length;
  await renderTournament(app);
  assert.equal(btnCount(), 7, 'buttons render on a good board');
  assert.ok(legendCount() > 0, 'the colour legend renders on a good board');
  // (1) a failed (503) poll must not strand the buttons OR the legend over the warming-up state.
  mode = 'fail';
  await renderTournament(app);
  assert.match(dom.$('#tourn-table').textContent, /warming up/i, 'warming-up message shows');
  assert.equal(btnCount(), 0, 'window buttons are cleared on a failed poll (no stale controls)');
  assert.equal(legendCount(), 0, 'the colour legend is cleared on a failed poll');
  // (2) recover, then an empty board (e.g. a Reset) must also clear both.
  mode = 'ok';
  await renderTournament(app);
  assert.equal(btnCount(), 7, 'buttons return on recovery');
  assert.ok(legendCount() > 0, 'the legend returns on recovery');
  mode = 'empty';
  await renderTournament(app);
  assert.match(dom.$('#tourn-table').textContent, /No bots running/i, 'empty-board message shows');
  assert.equal(btnCount(), 0, 'window buttons are cleared on an empty board');
  assert.equal(legendCount(), 0, 'the colour legend is cleared on an empty board');
});

// NOTE: this test mutates the module-level sort state (which deliberately persists
// across the 30s poll), so it is LAST in the file — it must not perturb earlier tests.
test('clicking a column header sorts the leaderboard and toggles direction', async () => {
  const dom = setupDom();
  await renderTournament(appWith(dom)); // bots payload order: bh(5.1) str(8.4) bk(3.2) — MAX column
  const thByText = (re) => dom.$$('#tourn-table thead th').find((t) => re.test(t.textContent));
  const firstRowId = () => dom.$('#tourn-table tbody tr').getAttribute('data-id');

  dom.fire(thByText(/Sharpe/), 'click');
  dom.fire(thByText(/MAX/), 'click');   // -> MAX (whole-life return) descending
  assert.equal(firstRowId(), 'str', 'highest MAX (str, 8.4%) sorts to the top descending');
  assert.match(thByText(/MAX/).textContent, /▼/, 'the active column shows a descending arrow');
  assert.ok(thByText(/MAX/).className.includes('sort-active'), 'the active column is flagged');

  dom.fire(thByText(/MAX/), 'click');   // toggle to ascending
  assert.equal(firstRowId(), 'bk', 'lowest MAX (bk, 3.2%) sorts to the top ascending');
  assert.match(thByText(/MAX/).textContent, /▲/, 'the arrow flips to ascending');

  dom.fire(thByText(/^Bot/), 'click');
  dom.fire(thByText(/Symbol/), 'click');   // -> Symbol ascending
  assert.equal(firstRowId(), 'bk', '"8 stocks" sorts first alphabetically ascending');
});
