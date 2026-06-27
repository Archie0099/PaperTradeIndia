// ---------------------------------------------------------------------------
// app.js — the bootstrap that wires everything together.
//   * Creates the simulation engine and the API client.
//   * Initialises every UI module and the tab navigation.
//   * Runs the polling loop that fetches quotes/status and updates P&L live.
//
// Reminder: this whole app trades VIRTUAL money only. No real order, ever.
// ---------------------------------------------------------------------------

import api from './api.js';
import { Engine, DEFAULT_CASH } from './core/engine.js';
import { $, rupee, fmt, signed, rangeChange } from './ui/dom.js';
import { initTabs } from './ui/tabs.js';
import { startClock, renderStatusBar } from './ui/statusbar.js';
import { initWatchlist, renderWatchlist } from './ui/watchlist.js';
import { renderPositions } from './ui/positions.js';
import { initOrders, renderOrders, loadTicket } from './ui/orders.js';
import { initOptionChain, loadChain } from './ui/optionChain.js';
import { initStrategy, setStrategyContext } from './ui/strategy.js';
import { drawLineChart } from './ui/chart.js';
import { initTheme } from './ui/theme.js';
import { initShortcuts } from './ui/shortcuts.js';
import { initAlerts, checkAlerts, showToast } from './ui/alerts.js';
import { initTournament, renderTournament } from './ui/tournament.js';
import { initAutoPilot, renderAutoPilot, remarkOptionPositions } from './ui/autopilot.js';

// Chart timeframe presets: which Yahoo candle interval + lookback range each
// button loads. The interval is also handed to the chart so it formats the time
// axis appropriately (intraday HH:MM vs daily DD-Mon vs monthly Mon-'YY).
const TIMEFRAMES = {
  '1D': { interval: '5m', range: '1d' },
  '1W': { interval: '30m', range: '5d' },
  '1M': { interval: '1d', range: '1mo' },
  '1Y': { interval: '1d', range: '1y' },
  '5Y': { interval: '1d', range: '5y' },
  '10Y': { interval: '1wk', range: '10y' },
  Max: { interval: '1wk', range: 'max' },
};

// The change to display for the selected timeframe. 1D = today's move (the live
// quote's change vs the previous close). 1W/1M/1Y/Max = the move OVER THE DISPLAYED
// RANGE (the latest price vs the first plotted close), labelled with the period.
// Returns { change, changePct, period } — changePct null means "nothing to show yet"
// (a non-1D timeframe whose candles haven't loaded), so the header shows the price
// alone instead of briefly flashing the (wrong) daily value. The SAME result drives
// the chart LINE colour, so the line and the number can never disagree.
function headerChange(q, candles, timeframe) {
  if (timeframe && timeframe !== '1D') {
    const rc = rangeChange(q.ltp, candles);
    return rc ? { change: rc.change, changePct: rc.changePct, period: timeframe } : { change: null, changePct: null, period: '' };
  }
  return { change: q.change != null ? q.change : null, changePct: q.changePct, period: '' };
}

// The chart-header price line: the LTP plus the ABSOLUTE ₹ change AND the % together
// (colour-coded green/red), for the SELECTED timeframe (see headerChange).
function ltpHeaderHtml(q, candles, timeframe) {
  const { change, changePct, period } = headerChange(q, candles, timeframe);
  const ltpStr = rupee(q.ltp);
  if (changePct == null || !Number.isFinite(changePct)) return ltpStr; // price only — no change to show yet
  const cls = changePct > 0 ? 'up' : changePct < 0 ? 'down' : 'flat';
  const pct = signed(changePct, 2) + '%';
  let chg = pct;
  if (change != null && Number.isFinite(change)) {
    chg = (change >= 0 ? '+₹' : '−₹') + fmt(Math.abs(change), 2) + ' (' + pct + ')';
  }
  const tag = period ? ` <span class="muted">${period}</span>` : '';
  return `${ltpStr}  <span class="${cls}">${chg}</span>${tag}`;
}

// The shared application object passed to every UI module.
const app = {
  engine: new Engine(),
  api,
  state: {
    quotes: {}, // symbol -> latest quote
    watch: [],
    status: null, // last /api/status payload
    market: null,
    dataStale: false,
    activeSymbol: 'NIFTY',
    activeCandles: null,
    activeCandlesFor: null, // { symbol, timeframe } the candles were fetched FOR (see currentCandles)
    chainSymbol: 'NIFTY',
    chainExpiry: undefined,
    chain: null,
    strategySeeded: false, // has the Strategy tab been seeded from a live quote yet?
    timeframe: '1D', // default price-chart timeframe: TODAY's intraday (5-min candles) — the chart opens on the live intraday move; 1W/1M/1Y/Max switch to longer ranges.
  },
};

// --- Cross-module helpers exposed on `app` ---------------------------------
app.loadTicket = (inst, side, price, lots) => loadTicket(app, inst, side, price, lots);

// Monotonic token so an out-of-order history response for a PREVIOUS symbol can't
// overwrite the newly-selected symbol's chart/candles (mirrors optionChain's
// chainReqId). Without it, clicking two symbols fast could leave activeCandles
// holding the wrong symbol's data under the new symbol's title.
let chartReqId = 0;

app.setActiveSymbol = async (symbol) => {
  app.state.activeSymbol = symbol;
  $('#chart-symbol').textContent = symbol;
  $('#t-symbol').value = symbol; // convenience: order ticket follows selection
  // Show its latest quote in the chart header if we have it. Pass the timeframe so a
  // non-1D view shows the PRICE ALONE until its candles load (the period change is
  // filled in post-fetch) rather than briefly flashing the daily change.
  const q = app.state.quotes[symbol];
  if (q) $('#chart-ltp').innerHTML = ltpHeaderHtml(q, null, app.state.timeframe);
  // No quote (yet) for this symbol: clear the header so it never shows the
  // PREVIOUS symbol's price under the newly-selected symbol's name.
  else $('#chart-ltp').textContent = '';
  // Load price history for the selected timeframe and draw the chart.
  const myReq = ++chartReqId;
  const tfName = app.state.timeframe; // capture: a switch mid-fetch must not mislabel the stamp
  const tf = TIMEFRAMES[tfName] || TIMEFRAMES['1M'];
  try {
    const hist = await api.history(symbol, tf.interval, tf.range);
    if (myReq !== chartReqId) return; // a newer setActiveSymbol superseded this one
    app.state.activeCandles = hist.candles;
    // Stamp WHOSE candles these are. Consumers (the quote poll's header refresh, the
    // theme/resize redraws) must pair candles only with the selection they were fetched
    // for — while a switch's fetch is in flight, the old symbol's candles would otherwise
    // be read against the NEW symbol's quote, fabricating a wild cross-symbol "change"
    // that the 5s poll re-asserts until the fetch lands.
    app.state.activeCandlesFor = { symbol, timeframe: tfName };
    // Colour the LINE by the SAME change the header shows (changeSign), so a green
    // "+0.14%" can't sit over a red line: on 1D both follow the daily move (vs the
    // previous close); on 1W/1M/… both follow the move over the displayed range.
    const fq = app.state.quotes[symbol];
    const hc = fq ? headerChange(fq, hist.candles, app.state.timeframe) : null;
    drawLineChart($('#price-chart'), hist.candles, { title: symbol, interval: tf.interval, changeSign: hc ? hc.changePct : null });
    // The candles for THIS timeframe are now in — re-render the header so the change
    // reflects the selected period (1W shows the week's move, etc.), not the daily one.
    if (fq) $('#chart-ltp').innerHTML = ltpHeaderHtml(fq, hist.candles, app.state.timeframe);
  } catch (err) {
    if (myReq !== chartReqId) return;
    app.state.activeCandles = null;
    app.state.activeCandlesFor = null;
    drawLineChart($('#price-chart'), [], {});
  }
};

// The candles in state are only meaningful for the selection they were fetched FOR.
// Return them ONLY when their stamp matches the live symbol + timeframe; during an
// in-flight switch this returns null, and ltpHeaderHtml(q, null, tf) renders the
// price alone (no fabricated change) until the right candles arrive.
function currentCandles() {
  const cf = app.state.activeCandlesFor;
  return cf && cf.symbol === app.state.activeSymbol && cf.timeframe === app.state.timeframe
    ? app.state.activeCandles
    : null;
}

// Wire the timeframe buttons (1D / 1W / 1M / 1Y / Max): switch the active
// preset, highlight it, and reload the active symbol's chart.
function initTimeframes() {
  const btns = [...document.querySelectorAll('#chart-timeframes .tf-btn')];
  for (const btn of btns) {
    btn.addEventListener('click', () => {
      app.state.timeframe = btn.dataset.tf;
      btns.forEach((b) => b.classList.toggle('active', b === btn));
      app.setActiveSymbol(app.state.activeSymbol);
    });
  }
  // Highlight the button matching the DEFAULT timeframe (app.state.timeframe), so the
  // active highlight always tracks the JS default even if the HTML markup differs.
  btns.forEach((b) => b.classList.toggle('active', b.dataset.tf === app.state.timeframe));
}

// Re-render the parts of the UI that depend on engine state.
function renderEngineViews() {
  renderPositions(app);
  renderOrders(app);
  renderWatchlist(app);
  renderStatusBar(app);
}

// --- Polling ---------------------------------------------------------------
// Collect every symbol we need a quote for: watchlist + active + equity
// positions. (Index/equity quotes come from Yahoo; F&O LTP for positions is
// only updated when its option chain is open — a documented simplification.)
function symbolsToPoll() {
  const set = new Set(app.state.watch);
  set.add(app.state.activeSymbol);
  for (const key in app.engine.state.positions) {
    const p = app.engine.state.positions[key];
    if (p.qty === 0) continue;
    // `instrument.symbol` is the tradeable for an equity, and the UNDERLYING
    // (e.g. NIFTY) for an OPT/FUT position. Poll it for ALL kinds: equity quotes
    // feed P&L and limit fills directly, and an OPT/FUT underlying quote keeps
    // the portfolio Greeks (which reprice each option off the live underlying
    // spot — see positions.js portfolioGreeks) and the strategy-builder spot
    // current, instead of frozen at the trade-time snapshot until that symbol
    // happens to be in the watchlist/active or its chain tab is open.
    set.add(p.instrument.symbol);
  }
  // Symbols with a live (untriggered) price alert must be polled too, or the
  // alert could never fire (e.g. an alert on a symbol not in the watchlist).
  for (const a of app.state.alerts || []) {
    if (!a.triggered) set.add(a.symbol);
  }
  // Symbols with a RESTING order must be polled too: a limit order only fills
  // when updateEquityPrice sees a crossing price, so a pending order on a symbol
  // no longer being watched would otherwise sit unfilled FOREVER with its
  // funds still reserved (an equity limit fills off these polled quotes; an F&O
  // pending additionally needs its chain open — documented — but its underlying
  // quote keeps the Greeks/spot fresh meanwhile).
  for (const o of app.engine.state.orders) {
    if (o && o.status === 'PENDING' && o.instrument && o.instrument.symbol) set.add(o.instrument.symbol);
  }
  return [...set].filter(Boolean);
}

app.pollQuotes = async function pollQuotes() {
  const symbols = symbolsToPoll();
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const q = await api.quote(sym);
        app.state.quotes[sym] = q;
        // Feed equity price into the engine: updates P&L + fills limit orders.
        // `silent` avoids a re-render per symbol; we render once below.
        app.engine.updateEquityPrice(sym, q.ltp, true);
      } catch {
        /* leave the previous quote in place; status bar shows staleness */
      }
    })
  );
  // Re-mark any Auto-Pilot-copied F&O option legs off the freshly-polled underlying (their
  // modelled cyc{i} expiry has no real chain feed, so they'd otherwise freeze at fill price).
  // Silent — the recordEquitySample/render below emits once for the whole poll cycle.
  remarkOptionPositions(app);

  // Update the active chart header LTP. Pass the displayed candles + timeframe so a
  // 1W/1M/… view keeps showing that PERIOD's change (refreshed as the live price moves),
  // not the daily change.
  const q = app.state.quotes[app.state.activeSymbol];
  // currentCandles(): only candles STAMPED for this exact symbol+timeframe — during an
  // in-flight switch it returns null and the header shows the price alone, instead of a
  // fabricated change computed from the PREVIOUS symbol's/timeframe's candles.
  if (q) $('#chart-ltp').innerHTML = ltpHeaderHtml(q, currentCandles(), app.state.timeframe);
  else $('#chart-ltp').textContent = '';
  // Sample the account value for the equity curve + Day-P&L baseline. This always
  // emits a 'change' event, and renderEngineViews (subscribed in main()) redraws
  // the positions/orders/watchlist/status-bar in one pass — so the watchlist and
  // status bar pick up the fresh quotes here WITHOUT a separate explicit render
  // (a previous explicit renderWatchlist/renderStatusBar here just double-rendered).
  app.engine.recordEquitySample();
  // Fire any price alerts the latest quotes now satisfy.
  for (const a of checkAlerts(app)) {
    showToast(`Alert: ${a.symbol} ${a.op === 'above' ? '≥' : '≤'} ${a.price}  (now ${app.state.quotes[a.symbol].ltp})`);
  }
};

async function pollStatus() {
  try {
    app.state.status = await api.status();
  } catch {
    /* status endpoint failed; the clock still runs from the client */
  }
  renderStatusBar(app);
}

// --- Account actions (export / import / reset / edit cash) ------------------
function initAccountActions() {
  // Square off every open position with one click.
  $('#btn-square-off').addEventListener('click', () => app.engine.closeAll());

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([app.engine.exportJson()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'paper-trade-portfolio.json';
    a.click();
    URL.revokeObjectURL(url);
  });

  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      app.engine.importJson(text);
      alert('Portfolio imported successfully.');
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
    e.target.value = '';
  });

  $('#btn-reset').addEventListener('click', () => {
    const input = prompt('Reset the portfolio. Starting virtual capital (₹)?', String(DEFAULT_CASH));
    if (input === null) return; // cancelled
    const cash = Number(input);
    if (!Number.isFinite(cash) || cash < 0) {
      alert('Please enter a valid amount.');
      return;
    }
    app.engine.reset(cash);
  });

  // Click the balance to edit virtual cash without resetting positions.
  $('#balance').style.cursor = 'pointer';
  $('#balance').title = 'Click to edit virtual cash';
  $('#balance').addEventListener('click', () => {
    const input = prompt('Set virtual cash balance (₹):', String(Math.round(app.engine.state.cash)));
    if (input === null) return;
    const cash = Number(input);
    if (Number.isFinite(cash) && cash >= 0) app.engine.setCash(cash);
  });
}

// --- Start up --------------------------------------------------------------
function main() {
  // Apply the saved light/dark theme first (before anything renders), and wire
  // the toggle to redraw the canvas charts (they read the theme's CSS colours).
  initTheme(() => {
    const themeCandles = currentCandles(); // never redraw another selection's candles
    if (themeCandles) {
      const tf = TIMEFRAMES[app.state.timeframe] || TIMEFRAMES['1M'];
      const aq = app.state.quotes[app.state.activeSymbol];
      const ahc = aq ? headerChange(aq, themeCandles, app.state.timeframe) : null;
      drawLineChart($('#price-chart'), themeCandles, { title: app.state.activeSymbol, interval: tf.interval, changeSign: ahc ? ahc.changePct : null });
    }
    renderPositions(app); // equity curve
    if ($('#tab-strategy').classList.contains('active')) setStrategyContext(app, null, null);
  });

  // Tabs, with a hook to refresh a tab when it becomes visible.
  app.tabs = initTabs((name) => {
    if (name === 'dashboard') {
      app.setActiveSymbol(app.state.activeSymbol);
      renderPositions(app); // redraw the equity curve at its real (visible) size
    }
    if (name === 'chain' && !app.state.chain) loadChain(app);
    if (name === 'tournament') renderTournament(app);
    if (name === 'autopilot') renderAutoPilot(app);
    if (name === 'strategy') {
      // Recompute on show so the payoff canvas draws at its real size (a canvas
      // drawn while hidden has zero dimensions). Seed the spot from the live
      // quote ONLY the first time the tab is opened — re-showing it must not
      // overwrite a spot that has since been typed, nor re-strike those legs.
      const q = app.state.quotes[app.state.activeSymbol];
      if (!app.state.strategySeeded && q) {
        setStrategyContext(app, app.state.activeSymbol, Math.round(q.ltp));
        app.state.strategySeeded = true;
      } else {
        setStrategyContext(app, null, null); // just recompute + redraw at real size
      }
    }
  });

  initWatchlist(app);
  initOrders(app);
  initOptionChain(app);
  initStrategy(app);
  initAccountActions();
  initTimeframes();
  initAlerts(app);
  initShortcuts(app);
  initTournament(app);
  initAutoPilot(app);

  // Re-render engine-dependent views whenever the portfolio changes.
  app.engine.subscribe(renderEngineViews);

  // Live clock + initial renders.
  startClock(app);
  renderEngineViews();
  app.setActiveSymbol(app.state.activeSymbol);

  // Kick off polling immediately, then on intervals.
  pollStatus();
  app.pollQuotes();
  setInterval(() => app.pollQuotes(), 5000); // quotes every 5s
  setInterval(pollStatus, 15000); // status every 15s

  // Auto-Pilot: if you've turned it on, copy the followed bot's portfolio onto your
  // account in the background — even when the Auto-Pilot tab isn't open (that's the
  // point: a bot trading FOR you). The tick is a cheap no-op when disabled or when the
  // bot hasn't rebalanced, so a 30s cadence is plenty. Kick one shortly after boot too.
  if (app.autopilotTick) {
    app.autopilotTick();
    setInterval(() => app.autopilotTick(), 30000);
  }

  // Keep the visible option chain fresh while the Chain tab is open — this is
  // what feeds live prices into F&O position P&L and fills resting F&O limit
  // orders. The server caches the chain for a few seconds, so 6s respects NSE's
  // ~1-req/3s limit. Quiet mode avoids flicker / wiping the table on a blip.
  setInterval(() => {
    if (app.state.chain && $('#tab-chain').classList.contains('active')) {
      loadChain(app, { quiet: true });
    }
  }, 6000); // option chain (only when its tab is visible)

  // Redraw canvas charts on resize (canvas needs explicit re-render).
  window.addEventListener('resize', () => {
    const sizedCandles = currentCandles(); // never redraw another selection's candles
    if (sizedCandles) {
      const tf = TIMEFRAMES[app.state.timeframe] || TIMEFRAMES['1M'];
      const aq = app.state.quotes[app.state.activeSymbol];
      const ahc = aq ? headerChange(aq, sizedCandles, app.state.timeframe) : null;
      drawLineChart($('#price-chart'), sizedCandles, { title: app.state.activeSymbol, interval: tf.interval, changeSign: ahc ? ahc.changePct : null });
    }
    // The payoff canvas also stretches with the window; redraw it at the new
    // size when the Strategy tab is visible (otherwise it stays a stale,
    // stretched bitmap until the next leg/spot edit).
    if ($('#tab-strategy').classList.contains('active')) setStrategyContext(app, null, null);
  });
}

main();
