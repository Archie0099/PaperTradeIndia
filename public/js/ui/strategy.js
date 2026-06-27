// ---------------------------------------------------------------------------
// ui/strategy.js
// The Strategy Builder. Pick a template (or add custom legs), set the spot and
// days-to-expiry, and see the payoff-at-expiry diagram, breakevens, max
// profit/loss and the net Greeks. This whole tab is PURE MATH and needs NO
// data feed — it works fully offline.
// ---------------------------------------------------------------------------

import { $, el, clear, fmt, signed, moveClass } from './dom.js';
import { TEMPLATES, analyse, netGreeks, bsPrice, legValueAtHorizon } from '../core/strategies.js';
import { impliedVol } from '../core/options.js';
import { drawPayoff } from './chart.js';
import { guessLotSize, parseExpiryMs } from './instruments.js';

// Strategy state lives here (separate from the trading engine).
const strat = {
  legs: [],
  spot: 23500,
  days: 7,
  symbol: 'NIFTY',
};

function initStrategy(app) {
  // Fill the template dropdown.
  const sel = $('#strat-template');
  for (const [key, t] of Object.entries(TEMPLATES)) sel.append(el('option', { value: key }, t.name));

  $('#strat-symbol').value = strat.symbol;
  $('#strat-spot').value = strat.spot;
  $('#strat-days').value = strat.days;

  // The Load button is type="button", so the form has no submit button — but
  // pressing Enter in a field could still submit and RELOAD the page (wiping the
  // in-progress strategy). Suppress it and treat Enter as "Load".
  $('#strat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    loadTemplate(app);
  });

  $('#btn-load-template').addEventListener('click', () => loadTemplate(app));
  $('#btn-add-leg').addEventListener('click', () => {
    strat.legs.push(blankLeg(strat));
    render(app);
  });

  // Save / load / delete named strategies, and pull in your open book.
  $('#btn-save-strat').addEventListener('click', () => {
    const name = $('#strat-name').value.trim();
    if (name) saveStrategy(name);
  });
  $('#btn-load-strat').addEventListener('click', () => {
    const name = $('#strat-saved-list').value;
    if (name) loadStrategy(app, name);
  });
  $('#btn-delete-strat').addEventListener('click', () => {
    const name = $('#strat-saved-list').value;
    if (name) deleteStrategy(name);
  });
  $('#btn-load-positions').addEventListener('click', () => loadPositions(app));
  refreshSavedList();

  // Recompute when spot/days change (keeps existing legs).
  ['strat-spot', 'strat-days', 'strat-symbol'].forEach((id) =>
    document.getElementById(id).addEventListener('input', () => {
      readHeader();
      recompute(app);
    })
  );

  loadTemplate(app); // start with something on screen
}

function readHeader() {
  strat.symbol = $('#strat-symbol').value.trim().toUpperCase() || 'NIFTY';
  strat.spot = Number($('#strat-spot').value) || strat.spot;
  strat.days = Math.max(1, Number($('#strat-days').value) || 7);
}

function rate(app) {
  return (app.engine.state.settings.riskFreeRate || 6.5) / 100;
}
function timeYears() {
  return strat.days / 365;
}

function blankLeg() {
  return {
    type: 'CE',
    side: 'BUY',
    strike: Math.round(strat.spot / 50) * 50,
    premium: 0,
    iv: 20,
    lots: 1,
    lotSize: guessLotSize(strat.symbol),
    days: null, // null = follow the header Days; set a leg's Days to build a calendar/diagonal
  };
}

// Build legs from the chosen template and price each one with Black-Scholes.
function loadTemplate(app) {
  readHeader();
  const key = $('#strat-template').value;
  const tmpl = TEMPLATES[key];
  if (!tmpl) return;
  const step = stepFor(strat.symbol);
  const lotSize = guessLotSize(strat.symbol);
  strat.legs = tmpl.build(strat.spot, step, strat.days).map((lg) => {
    const iv = 20;
    const legDays = lg.days != null ? lg.days : strat.days;
    const premium =
      lg.type === 'FUT'
        ? strat.spot // a future's "entry price" is the spot
        : +bsPrice(lg.type, strat.spot, lg.strike, legDays / 365, rate(app), iv / 100).toFixed(2);
    // Keep `days` as the template set it: null for single-expiry legs (so they
    // follow the header Days and re-time when it changes), explicit only for
    // calendar/diagonal legs. (`...lg` already carries it.)
    return { ...lg, premium, iv, lots: lg.lots || 1, lotSize };
  });
  render(app);
}

function stepFor(symbol) {
  const s = symbol.toUpperCase();
  if (s === 'BANKNIFTY') return 100;
  if (s === 'NIFTY' || s === 'FINNIFTY') return 50;
  return 20;
}

// Full render: legs table + payoff + stats. Used on structural changes.
function render(app) {
  renderLegs(app);
  recompute(app);
}

function renderLegs(app) {
  const root = clear($('#legs-table'));
  if (strat.legs.length === 0) {
    root.append(el('div', { class: 'empty-state' }, 'No legs. Click "+ Leg" or load a template.'));
    return;
  }
  const table = el('table');
  table.append(
    el('thead', {}, el('tr', {}, ['Side', 'Type', 'Strike', 'Premium', 'IV%', 'Lots', 'Lot size', 'Days', ''].map((h) => el('th', {}, h))))
  );
  const tbody = el('tbody');
  strat.legs.forEach((lg, i) => tbody.append(legRow(app, lg, i)));
  table.append(tbody);
  root.append(table);
}

function legRow(app, lg, i) {
  const onEdit = () => recompute(app);
  const sideSel = select(['BUY', 'SELL'], lg.side, (v) => (lg.side = v), onEdit);
  // On switching a leg to FUT, seed its entry price from spot so it is never 0
  // (a future cannot be priced by Black-Scholes). Rebuild the row afterwards so
  // the disabled states (strike/IV) and the premium field refresh.
  const typeSel = select(
    ['CE', 'PE', 'FUT'],
    lg.type,
    (v) => {
      lg.type = v;
      if (v === 'FUT' && !(lg.premium > 0)) lg.premium = strat.spot;
    },
    () => render(app)
  );
  const strikeIn = numInput(lg.strike, (v) => (lg.strike = v), onEdit, lg.type === 'FUT');
  const premIn = numInput(lg.premium, (v) => (lg.premium = v), onEdit);
  const ivIn = numInput(lg.iv, (v) => (lg.iv = v), onEdit, lg.type === 'FUT');
  const lotsIn = intInput(lg.lots, (v) => (lg.lots = v), onEdit);
  const lotSzIn = intInput(lg.lotSize, (v) => (lg.lotSize = v), onEdit);
  // Per-leg days-to-expiry — edit a leg to a different expiry to build a
  // calendar/diagonal. Disabled for futures (a future has no option expiry here).
  const daysIn = intInput(lg.days != null ? lg.days : strat.days, (v) => (lg.days = v), onEdit);
  if (lg.type === 'FUT') daysIn.disabled = true;
  const del = el('button', { class: 'btn btn-mini' }, '×');
  del.addEventListener('click', () => {
    strat.legs.splice(i, 1);
    render(app);
  });
  return el('tr', { class: 'leg-row' }, [
    el('td', {}, sideSel), el('td', {}, typeSel), el('td', {}, strikeIn),
    el('td', {}, premIn), el('td', {}, ivIn), el('td', {}, lotsIn), el('td', {}, lotSzIn), el('td', {}, daysIn), el('td', {}, del),
  ]);
}

function select(options, value, onChange, after) {
  const s = el('select');
  for (const o of options) s.append(el('option', { value: o, ...(o === value ? { selected: 'selected' } : {}) }, o));
  s.value = value;
  s.addEventListener('change', () => {
    onChange(s.value);
    after();
  });
  return s;
}

function numInput(value, onChange, after, disabled = false) {
  const inp = el('input', { type: 'number', step: '0.05', value: String(value) });
  if (disabled) inp.disabled = true;
  inp.addEventListener('input', () => {
    onChange(Number(inp.value));
    after();
  });
  return inp;
}

// Like numInput but for positive WHOLE-number fields (lots, lot size). It always
// feeds a clamped value (>= 1, integer) to the model, so the payoff/stats never
// silently use a zero/negative/fractional quantity that the visible Side wouldn't
// reflect; and on blur it writes the clamped value back so the field and the
// maths agree (no "empty field but computed as 1" desync).
function intInput(value, onChange, after) {
  const inp = el('input', { type: 'number', step: '1', min: '1', value: String(value) });
  const clamp = () => Math.max(1, Math.floor(Number(inp.value) || 1));
  inp.addEventListener('input', () => {
    onChange(clamp());
    after();
  });
  inp.addEventListener('change', () => {
    const c = clamp();
    inp.value = String(c); // normalise the field to what is actually computed
    onChange(c);
    after();
  });
  return inp;
}

// Recompute payoff, stats and Greeks (does NOT rebuild the legs table, so it
// is safe to call on every keystroke without stealing input focus).
function recompute(app) {
  const legs = strat.legs;
  // analyse()/netGreeks() can throw on a malformed leg (e.g. a future with no
  // entry price, or an option with no IV). Degrade gracefully instead of
  // freezing the whole tab.
  let analysis;
  try {
    analysis = analyse(legs, strat.spot, { riskFreeRate: rate(app), days: strat.days });
  } catch (err) {
    clear($('#strat-stats')).append(el('div', { class: 'error-state' }, 'Cannot analyse: ' + err.message));
    clear($('#strat-greeks'));
    return;
  }
  drawPayoff($('#payoff-chart'), analysis.curve, {
    spot: strat.spot,
    breakevens: analysis.breakevens,
  });

  // Net premium: positive = net credit received, negative = net debit paid.
  let netPremium = 0;
  for (const lg of legs) {
    if (lg.type === 'FUT') continue;
    const units = (lg.lots || 1) * (lg.lotSize || 1);
    netPremium += (lg.side === 'SELL' ? 1 : -1) * lg.premium * units;
  }

  const stats = clear($('#strat-stats'));
  stats.append(
    statBlock('Max Profit', analysis.unboundedProfit ? 'UNBOUNDED' : signed(analysis.maxProfit, 0), analysis.unboundedProfit ? 'up' : moveClass(analysis.maxProfit)),
    statBlock('Max Loss', analysis.unboundedLoss ? 'UNBOUNDED' : signed(analysis.maxLoss, 0), analysis.unboundedLoss ? 'down unbounded' : moveClass(analysis.maxLoss)),
    statBlock(netPremium >= 0 ? 'Net Credit' : 'Net Debit', signed(netPremium, 0), moveClass(netPremium)),
    statBlock('Breakeven(s)', analysis.breakevens.length ? analysis.breakevens.map((b) => fmt(b, 0)).join(', ') : '—')
  );

  renderLegBreakdown(app);

  let g;
  try {
    g = netGreeks(legs, strat.spot, timeYears(), rate(app));
  } catch (err) {
    clear($('#strat-greeks')).append(el('div', { class: 'muted' }, 'Greeks unavailable: ' + err.message));
    return;
  }
  const greeksBox = clear($('#strat-greeks'));
  greeksBox.append(
    statBlock('Net Δ Delta', fmt(g.delta, 2), moveClass(g.delta)),
    statBlock('Net Γ Gamma', fmt(g.gamma, 4)),
    statBlock('Net Θ Theta/day', signed(g.theta, 0), moveClass(g.theta)),
    statBlock('Net Vega /1%', signed(g.vega, 0))
  );
}

function statBlock(label, value, cls = '') {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat-label' }, label),
    el('span', { class: 'stat-value ' + cls }, value),
  ]);
}

// Per-leg payoff breakdown at the current spot. Rebuilt on every recompute, so
// it is read-only and never steals focus from the editable legs table above.
function renderLegBreakdown(app) {
  const box = clear($('#strat-legs-pnl'));
  if (strat.legs.length === 0) return;
  // Value each leg at the SAME analysis horizon the curve/stats use (the nearest
  // expiry), so a calendar/diagonal's far leg shows its remaining time value and
  // the rows sum to the headline P&L at spot.
  const r = rate(app);
  const defaultDays = strat.days;
  const optDays = strat.legs.filter((l) => l.type !== 'FUT').map((l) => (l.days != null ? l.days : defaultDays));
  const horizon = optDays.length ? Math.min(...optDays) : defaultDays;
  const table = el('table');
  table.append(el('thead', {}, el('tr', {}, ['Leg', 'Units', 'Payoff @ spot'].map((h) => el('th', {}, h)))));
  const tbody = el('tbody');
  for (const lg of strat.legs) {
    const u = (lg.lots || 1) * (lg.lotSize || 1);
    // Mirror analyse()'s FUT normalisation so a 0-entry future doesn't throw.
    const leg = lg.type === 'FUT' && !(lg.premium > 0) ? { ...lg, premium: strat.spot } : lg;
    let pnl;
    try {
      pnl = legValueAtHorizon(leg, strat.spot, horizon, r, defaultDays) * u;
    } catch {
      pnl = NaN;
    }
    const label = `${lg.side} ${lg.lots}× ${lg.type}${lg.type !== 'FUT' ? ' ' + lg.strike : ''}`;
    tbody.append(
      el('tr', {}, [
        el('td', {}, label),
        el('td', { class: 'num' }, String(u)),
        el('td', { class: 'num ' + moveClass(pnl) }, signed(pnl, 0)),
      ])
    );
  }
  table.append(tbody);
  box.append(el('div', { class: 'section-head' }, el('h3', {}, 'Per-leg payoff (at spot)')), table);
}

// --- Save / load named strategies (localStorage) ---------------------------
const SAVED_KEY = 'paper-trade-india:strategies';

function loadSavedMap() {
  // Null-prototype map so a strategy named "constructor"/"__proto__"/etc. saves
  // and lists correctly instead of silently colliding with Object.prototype.
  const out = Object.create(null);
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const k of Object.keys(parsed)) out[k] = parsed[k];
      }
    }
  } catch {}
  return out;
}
function saveSavedMap(map) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(map));
  } catch {}
}
function refreshSavedList() {
  const sel = $('#strat-saved-list');
  if (!sel) return;
  const current = sel.value;
  clear(sel);
  const names = Object.keys(loadSavedMap());
  if (names.length === 0) {
    sel.append(el('option', { value: '' }, '(no saved strategies)'));
    return;
  }
  for (const n of names) sel.append(el('option', { value: n }, n));
  if (names.includes(current)) sel.value = current;
}
function saveStrategy(name) {
  const map = loadSavedMap();
  map[name] = { symbol: strat.symbol, spot: strat.spot, days: strat.days, legs: strat.legs.map((l) => ({ ...l })) };
  saveSavedMap(map);
  refreshSavedList();
  $('#strat-saved-list').value = name;
}
function loadStrategy(app, name) {
  const saved = loadSavedMap()[name];
  if (!saved) return;
  strat.symbol = (saved.symbol || 'NIFTY').toUpperCase();
  strat.spot = Number(saved.spot) || strat.spot;
  strat.days = Math.max(1, Number(saved.days) || 7);
  strat.legs = Array.isArray(saved.legs) ? saved.legs.map((l) => ({ ...l })) : [];
  $('#strat-symbol').value = strat.symbol;
  $('#strat-spot').value = strat.spot;
  $('#strat-days').value = strat.days;
  render(app);
}
function deleteStrategy(name) {
  const map = loadSavedMap();
  delete map[name];
  saveSavedMap(map);
  refreshSavedList();
}

// Pull your OPEN F&O positions (on the builder's current symbol) in as
// legs, to analyse the real book's payoff + Greeks. The entry price
// becomes the leg premium (so the payoff is P&L from your entry); IV is
// recovered from the live option price (falls back to 20%, editable).
function loadPositions(app) {
  readHeader();
  const sym = strat.symbol;
  const e = app.engine;
  const r = rate(app);
  const legs = [];
  let underlying = null; // so we can align the builder's spot to the real book
  for (const key in e.state.positions) {
    const p = e.state.positions[key];
    if (!p || p.qty === 0) continue;
    const inst = p.instrument;
    if (!inst || inst.kind === 'EQ' || inst.symbol.toUpperCase() !== sym) continue;
    const lotSize = inst.lotSize || 1;
    const lots = Math.max(1, Math.round(Math.abs(p.qty) / lotSize));
    const side = p.qty > 0 ? 'BUY' : 'SELL';
    if (inst.kind === 'FUT') {
      if (underlying == null) underlying = p.avgPrice; // a future's price ≈ the underlying
      legs.push({ type: 'FUT', side, strike: 0, premium: p.avgPrice, iv: 20, lots, lotSize });
    } else {
      const spot = (app.state.quotes[inst.symbol] && app.state.quotes[inst.symbol].ltp) || inst.underlyingPrice || strat.spot;
      underlying = spot; // an option's underlying is the most reliable spot
      const last = e.state.lastPrices[key] || p.avgPrice;
      // Carry the leg's real days-to-expiry, so a multi-expiry book becomes a
      // correct calendar/diagonal in the builder. Prefer the stamped expiry
      // TIMESTAMP when present: an Auto-Pilot-copied F&O leg lives under a
      // synthetic "cyc{i}" expiry STRING that parseExpiryMs can't parse (its
      // fallback is ~7 days), which distorted the loaded leg's days, the IV
      // recovered below, and every downstream Greek/breakeven. Mirrors the
      // identical seam fix in positions.js portfolioGreeks.
      const expMs = inst.expiryMs != null ? inst.expiryMs : parseExpiryMs(inst.expiry);
      const days = Math.max(1, Math.round((expMs - Date.now()) / 86400000));
      let iv = impliedVol(inst.optType, last, spot, inst.strike, days / 365, r);
      iv = Number.isFinite(iv) ? +(iv * 100).toFixed(2) : 20;
      legs.push({ type: inst.optType, side, strike: inst.strike, premium: p.avgPrice, iv, lots, lotSize, days });
    }
  }
  if (legs.length === 0) {
    clear($('#strat-stats')).append(el('div', { class: 'muted' }, `No open F&O positions on ${sym} to load.`));
    return;
  }
  strat.legs = legs;
  // Align the builder's spot to the positions' underlying so the payoff, spot
  // marker, breakevens and Greeks are computed at the right price (not a stale
  // spot field).
  if (underlying > 0) {
    strat.spot = underlying;
    $('#strat-spot').value = underlying;
  }
  render(app);
}

// Let other parts of the app push a spot/symbol into the builder.
function setStrategyContext(app, symbol, spot) {
  if (symbol) {
    strat.symbol = symbol.toUpperCase();
    $('#strat-symbol').value = strat.symbol;
  }
  if (spot) {
    strat.spot = spot;
    $('#strat-spot').value = spot;
    // Re-strike + re-price the template legs at the seeded spot so the spot
    // marker, strikes and premiums are mutually consistent (otherwise the legs
    // stay struck at the OLD spot while the marker jumps to the new one).
    // app.js only seeds a spot once (first time the tab opens), so this never
    // clobbers a strategy that has since been customised.
    loadTemplate(app); // also recomputes + redraws
    return;
  }
  recompute(app);
}

export { initStrategy, setStrategyContext };
