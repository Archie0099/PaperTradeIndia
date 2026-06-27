// ---------------------------------------------------------------------------
// ui/optionChain.js
// The Option Chain tab. It loads a chain from the backend (live NSE when
// reachable, synthetic otherwise) and renders the full table. NSE gives IV but
// NOT Greeks, so we compute delta/gamma/theta/vega ourselves on the client
// with Black-Scholes (core/options.js). Click an LTP to load that option into
// the order ticket.
// ---------------------------------------------------------------------------

import { $, el, clear, fmt, signed, moveClass } from './dom.js';
import { greeks, yearsToExpiry } from '../core/options.js';
import { guessLotSize, parseExpiryMs } from './instruments.js';
import { instrumentKey } from '../core/engine.js';

// Monotonic token so an out-of-order chain response (e.g. a slow manual load
// landing after a quick background refresh) can't overwrite a newer one.
let chainReqId = 0;

function initOptionChain(app) {
  $('#chain-form').addEventListener('submit', (e) => {
    e.preventDefault();
    app.state.chainSymbol = $('#chain-symbol').value.trim().toUpperCase();
    app.state.chainExpiry = $('#chain-expiry').value || undefined;
    loadChain(app);
  });
  // Reload when a different expiry is picked.
  $('#chain-expiry').addEventListener('change', () => {
    app.state.chainExpiry = $('#chain-expiry').value || undefined;
    loadChain(app);
  });
}

// Load (and render) the option chain. `quiet` is for the background refresh
// loop: it skips the "Loading…" placeholder and keeps the last good chain on the
// screen if the refresh fails, so the table doesn't flicker every few seconds.
async function loadChain(app, { quiet = false } = {}) {
  const symbol = app.state.chainSymbol || $('#chain-symbol').value.trim().toUpperCase() || 'NIFTY';
  const myId = ++chainReqId;
  if (!quiet) {
    clear($('#chain-table')).append(el('div', { class: 'empty-state' }, 'Loading option chain…'));
  }
  try {
    const chain = await app.api.optionChain(symbol, app.state.chainExpiry);
    if (myId !== chainReqId) return; // a newer request superseded this one
    app.state.chain = chain;
    populateExpiries(chain);
    renderChain(app, chain);
  } catch (err) {
    if (myId !== chainReqId) return; // superseded — let the newer request own the UI
    if (quiet) return; // keep the last good chain on a background-refresh failure
    clear($('#chain-table')).append(
      el('div', { class: 'error-state' }, [
        el('div', {}, 'Could not load the option chain: ' + err.message),
        el('div', { class: 'muted' }, 'NSE often blocks automated traffic. Try again in a few seconds, or use the Strategy Builder which needs no data.'),
      ])
    );
  }
}

function populateExpiries(chain) {
  const sel = $('#chain-expiry');
  const current = sel.value;
  clear(sel);
  for (const ex of chain.expiries || []) {
    sel.append(el('option', { value: ex }, ex));
  }
  // Keep the chosen expiry selected if still present, else the chain's expiry.
  sel.value = (chain.expiries || []).includes(current) ? current : chain.expiry || '';
}

function renderChain(app, chain) {
  // Header meta: underlying value, expiry, data source.
  const meta = clear($('#chain-meta'));
  meta.append(
    el('span', {}, [el('span', { class: 'muted' }, 'Underlying: '), el('span', { class: 'num' }, fmt(chain.underlying))]),
    el('span', {}, [el('span', { class: 'muted' }, 'Expiry: '), chain.expiry || '—']),
    el('span', { class: sourceClass(chain.source) }, 'Source: ' + sourceLabel(chain))
  );

  const spot = chain.underlying;
  const lotSize = guessLotSize(chain.symbol);
  const r = (app.engine.state.settings.riskFreeRate || 6.5) / 100;
  const T = yearsToExpiry(parseExpiryMs(chain.expiry));

  const root = clear($('#chain-table'));
  if (!chain.strikes || chain.strikes.length === 0) {
    root.append(el('div', { class: 'empty-state' }, 'No strikes returned.'));
    return;
  }

  // Column layout: CE side | STRIKE | PE side.
  const ceCols = ['LTP', 'Bid', 'Ask', 'IV', 'Vol', 'OI', 'ChgOI', 'Δ', 'Γ', 'Θ', 'Veg'];
  const peCols = ['Δ', 'Γ', 'Θ', 'Veg', 'ChgOI', 'OI', 'Vol', 'IV', 'Bid', 'Ask', 'LTP'];

  const table = el('table');
  const headCe = ceCols.map((c) => el('th', { class: 'ce-side' }, c));
  const headPe = peCols.map((c) => el('th', { class: 'pe-side' }, c));
  table.append(el('thead', {}, el('tr', {}, [...headCe, el('th', { class: 'strike-col center' }, 'STRIKE'), ...headPe])));

  const tbody = el('tbody');
  // Find the ATM strike to highlight — ONLY when the underlying is known. A
  // missing/non-finite spot must not coerce to 0 (abs(strike - null) === strike)
  // and falsely mark the lowest strike as ATM.
  let atmStrike = null;
  if (Number.isFinite(spot)) {
    let atmDiff = Infinity;
    for (const s of chain.strikes) {
      const d = Math.abs(s.strike - spot);
      if (d < atmDiff) {
        atmDiff = d;
        atmStrike = s.strike;
      }
    }
  }

  for (const row of chain.strikes) {
    const ce = row.ce || {};
    const pe = row.pe || {};
    const ceG = legGreeks('CE', spot, row.strike, T, r, ce.iv);
    const peG = legGreeks('PE', spot, row.strike, T, r, pe.iv);

    const tr = el('tr', { class: row.strike === atmStrike ? 'atm-row' : '' }, [
      // CE side
      ltpCell(app, chain, row.strike, 'CE', ce, lotSize),
      cell(ce.bid), cell(ce.ask), cell(ce.iv), cell(ce.volume, 0), cell(ce.oi, 0),
      el('td', { class: 'num ' + moveClass(ce.changeOi) }, ce.changeOi != null ? signed(ce.changeOi, 0) : '–'),
      cell(ceG.delta, 2), cell(ceG.gamma, 4), cell(ceG.theta, 1), cell(ceG.vega, 1),
      // Strike
      el('td', { class: 'num strike-col center' }, String(row.strike)),
      // PE side
      cell(peG.delta, 2), cell(peG.gamma, 4), cell(peG.theta, 1), cell(peG.vega, 1),
      el('td', { class: 'num ' + moveClass(pe.changeOi) }, pe.changeOi != null ? signed(pe.changeOi, 0) : '–'),
      cell(pe.oi, 0), cell(pe.volume, 0), cell(pe.iv), cell(pe.bid), cell(pe.ask),
      ltpCell(app, chain, row.strike, 'PE', pe, lotSize),
    ]);
    tbody.append(tr);
  }
  table.append(tbody);
  root.append(table);

  // Push the chain's live prices into the engine so F&O P&L updates and resting
  // F&O limit orders can fill (this is the ONLY price feed for options/futures —
  // equities come from the watchlist poll).
  feedEngineFromChain(app, chain);
}

// Feed the visible chain's option LTPs (and the underlying, as a proxy for any
// matching future) into the engine, but ONLY for contracts we actually hold a
// position or a pending limit on — so we don't bloat lastPrices or fire needless
// re-renders for every strike on screen.
function feedEngineFromChain(app, chain) {
  const e = app.engine;
  const wanted = new Set();
  for (const k in e.state.positions) if (e.state.positions[k].qty !== 0) wanted.add(k);
  for (const o of e.state.orders) if (o.status === 'PENDING') wanted.add(instrumentKey(o.instrument));
  if (wanted.size === 0) return;

  for (const row of chain.strikes || []) {
    for (const optType of ['CE', 'PE']) {
      const leg = optType === 'CE' ? row.ce : row.pe;
      if (!leg || !(leg.ltp > 0)) continue;
      const key = `OPT:${chain.symbol}:${chain.expiry}:${row.strike}:${optType}`;
      if (wanted.has(key)) e.onPriceUpdate(key, leg.ltp);
    }
  }
  // The chain carries no futures LTP; mark a held future on this symbol+expiry at
  // the underlying as a documented approximation (near futures ≈ spot) — far
  // better than its P&L staying frozen at entry forever.
  if (chain.underlying > 0) {
    const futKey = `FUT:${chain.symbol}:${chain.expiry}`;
    if (wanted.has(futKey)) e.onPriceUpdate(futKey, chain.underlying);
  }
}

// Compute Greeks for one option leg; returns zeros if IV is missing/zero.
function legGreeks(type, spot, strike, T, r, ivPct) {
  if (!spot || !ivPct) return { delta: 0, gamma: 0, theta: 0, vega: 0 };
  return greeks(type, spot, strike, T, r, ivPct / 100);
}

// An LTP cell. When the option has a real (positive) LTP it is clickable and
// loads that option into the order ticket. A missing/zero LTP renders as a
// plain, NON-interactive '–' so a click can't seed a 0-price option.
function ltpCell(app, chain, strike, optType, leg, lotSize) {
  const side = optType === 'CE' ? 'ce-side' : 'pe-side';
  if (!(leg.ltp > 0)) {
    return el('td', { class: 'num ' + side }, '–');
  }
  const td = el('td', { class: 'num chain-trade ' + side }, fmt(leg.ltp));
  td.title = `Click to trade ${chain.symbol} ${strike} ${optType}`;
  td.addEventListener('click', () => {
    const inst = {
      kind: 'OPT',
      symbol: chain.symbol,
      expiry: chain.expiry,
      strike,
      optType,
      lotSize,
      underlyingPrice: chain.underlying,
    };
    app.loadTicket(inst, 'BUY', leg.ltp, 1);
  });
  return td;
}

function cell(v, decimals = 2) {
  return el('td', { class: 'num' }, v == null ? '–' : fmt(v, decimals));
}

function sourceLabel(chain) {
  if (chain.source === 'live') return 'NSE live';
  if (chain.source === 'stale') return 'NSE cached (stale)';
  return 'synthetic (offline)';
}
function sourceClass(src) {
  if (src === 'live') return 'up';
  if (src === 'stale') return 'down';
  return 'flat';
}

export { initOptionChain, loadChain, renderChain };
