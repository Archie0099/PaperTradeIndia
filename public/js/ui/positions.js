// ---------------------------------------------------------------------------
// ui/positions.js
// The Positions/Dashboard tab: top-line P&L stats, the open-positions table
// (with a one-click "Close" that places an offsetting market order), and the
// left-rail account summary box.
// ---------------------------------------------------------------------------

import { $, el, clear, fmt, rupee, signed, moveClass } from './dom.js';
import { instrumentKey } from '../core/engine.js';
import { greeks, impliedVol, yearsToExpiry } from '../core/options.js';
import { parseExpiryMs } from './instruments.js';
import { drawLineChart } from './chart.js';

// Build one "stat" block for the dashboard header.
function stat(label, value, cls = '') {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat-label' }, label),
    el('span', { class: 'stat-value ' + cls }, value),
  ]);
}

function renderPositions(app) {
  const engine = app.engine;
  renderPnlSummary(app);
  renderAccountBox(app);
  renderPortfolioGreeks(app);
  drawEquityCurve(app);

  const root = clear($('#positions-table'));
  const positions = Object.values(engine.state.positions).filter((p) => p.qty !== 0);

  if (positions.length === 0) {
    root.append(
      el('div', { class: 'empty-state' }, 'No open positions yet. Place an order from the Orders tab.')
    );
    return;
  }

  const table = el('table');
  table.append(
    el('thead', {}, el('tr', {}, [
      th('Instrument'), th('Qty'), th('Avg'), th('LTP'), th('Unreal. P&L'), th('Realised (pos)'), th('SL / TP'), th(''),
    ]))
  );
  const tbody = el('tbody');
  for (const p of positions) {
    // Derive the key from the instrument (the authoritative source the engine
    // itself keys lastPrices/positions by), NOT the redundant p.key field — a
    // position imported from JSON may lack p.key, which would break its LTP,
    // unrealised P&L and Close button.
    const key = instrumentKey(p.instrument);
    const last = engine.state.lastPrices[key];
    const unreal = engine.unrealisedFor(key);
    tbody.append(
      el('tr', {}, [
        el('td', {}, p.instrument.kind === 'EQ' ? p.instrument.symbol : labelFor(p.instrument)),
        el('td', { class: 'num' }, String(p.qty)),
        el('td', { class: 'num' }, p.avgPrice.toFixed(2)),
        el('td', { class: 'num' }, last != null ? last.toFixed(2) : '…'),
        el('td', { class: 'num ' + moveClass(unreal) }, signed(unreal, 0)),
        el('td', { class: 'num ' + moveClass(p.realised) }, signed(p.realised || 0, 0)),
        el('td', { class: 'num' }, exitsText(p)),
        el('td', {}, el('span', { class: 'row-actions' }, [bracketBtn(app, p), closeButton(app, p)])),
      ])
    );
  }
  table.append(tbody);
  root.append(table);
}

function closeButton(app, pos) {
  const btn = el('button', { class: 'btn btn-mini' }, 'Close');
  btn.addEventListener('click', () => {
    const key = instrumentKey(pos.instrument);
    const last = app.engine.state.lastPrices[key] || pos.avgPrice;
    // Offsetting market order for the EXACT remaining quantity. We pass lotSize 1
    // and lots = |qty| (placeOrder floors lots, so a non-lot-multiple qty — e.g.
    // an imported odd position of 100 at lotSize 75 — would otherwise leave a 25
    // residual). lotSize isn't part of instrumentKey, so this still nets cleanly
    // against the existing position.
    app.engine.placeOrder({
      instrument: { ...pos.instrument, lotSize: 1 },
      side: pos.qty > 0 ? 'SELL' : 'BUY',
      orderType: 'MARKET',
      lots: Math.abs(pos.qty),
      price: last,
    });
  });
  return btn;
}

function labelFor(inst) {
  if (inst.kind === 'FUT') return `${inst.symbol} FUT`;
  return `${inst.symbol} ${inst.strike}${inst.optType}`;
}

// "stop-loss / target" text for the SL/TP column ('–' for an unset side).
function exitsText(p) {
  const sl = Number.isFinite(p.stopLoss) ? fmt(p.stopLoss, 0) : '–';
  const tp = Number.isFinite(p.target) ? fmt(p.target, 0) : '–';
  return sl + ' / ' + tp;
}

// Set/clear the bracket exits on an open position (one prompt, "sl,target").
function bracketBtn(app, pos) {
  const b = el('button', { class: 'btn btn-mini' }, 'SL/TP');
  b.title = 'Set stop-loss / target (auto-closes the position when hit)';
  b.addEventListener('click', () => {
    const key = instrumentKey(pos.instrument);
    // Use "/" not "," as the separator — a comma clashes with Indian number
    // grouping (e.g. "1,20,000"), which would corrupt the parsed values.
    const cur = (Number.isFinite(pos.stopLoss) ? pos.stopLoss : '') + ' / ' + (Number.isFinite(pos.target) ? pos.target : '');
    const input = prompt('Stop-loss / Target  (e.g. 95 / 120 — leave a side blank to clear):', cur);
    if (input === null) return;
    const [slStr, tpStr] = input.split('/').map((s) => (s || '').trim());
    app.engine.setExits(key, {
      stopLoss: slStr ? Number(slStr) : null,
      target: tpStr ? Number(tpStr) : null,
    });
  });
  return b;
}

// A "delta chip": the ABSOLUTE ₹ change AND the % together (e.g. "▲ +12,400 (+1.2%)"),
// colour-coded. This is the per-the-user "show value increase/decrease alongside the %".
function deltaChip(amount, pct, decimals = 0) {
  const cls = moveClass(amount);
  const arr = amount > 0 ? '▲' : amount < 0 ? '▼' : '•';
  return el('span', { class: 'delta-chip ' + cls }, [
    el('span', { class: 'arr' }, arr),
    `${signed(amount, decimals)} (${signed(pct, 2)}%)`,
  ]);
}

// One big "hero" stat card. `cls` tints the left accent bar (accent/up/down).
function heroCard(label, value, { cls = '', sub = null, splitPct = null } = {}) {
  const card = el('div', { class: 'hero-card ' + cls });
  card.append(el('div', { class: 'hero-label' }, label));
  card.append(el('div', { class: 'hero-value ' + (cls === 'accent' ? '' : cls) }, value));
  if (splitPct != null) {
    const inv = Math.max(0, Math.min(100, splitPct));
    const bar = el('div', { class: 'split-bar' });
    bar.append(el('i', { class: 'invested', style: `width:${inv}%` }));
    bar.append(el('i', { class: 'cash', style: `width:${100 - inv}%` }));
    card.append(bar);
  }
  if (sub) card.append(el('div', { class: 'hero-sub' }, Array.isArray(sub) ? sub : [sub]));
  return card;
}

// The headline P&L as a row of hero cards: Account Value (+ total return ₹ & %),
// Day P&L (₹ & %), Invested-vs-cash split, and Unrealised/Realised.
function renderPnlSummary(app) {
  const engine = app.engine;
  const root = clear($('#pnl-summary'));
  const unreal = engine.unrealisedTotal();
  const real = engine.realisedTotal();
  const equity = engine.equity();
  const cash = engine.state.cash;
  const initial = engine.state.initialCash;
  const pnlTotal = equity - initial;
  const pnlPct = initial > 0 ? (pnlTotal / initial) * 100 : 0;
  const dayPnl = engine.dayPnl();
  const dayBase = engine.state && engine.state.dayStart && typeof engine.state.dayStart.equity === 'number' ? engine.state.dayStart.equity : 0;
  const dayPct = dayBase > 0 ? (dayPnl / dayBase) * 100 : 0;
  const investedVal = equity - cash;
  const investedPct = equity > 0 ? (investedVal / equity) * 100 : 0;
  const margin = engine.blockedMargin();

  root.append(heroCard('Account Value', rupee(equity, 0), {
    cls: 'accent',
    sub: [el('span', { class: 'muted' }, 'Total return'), deltaChip(pnlTotal, pnlPct)],
  }));
  root.append(heroCard('Day P&L', signed(dayPnl, 0), {
    cls: moveClass(dayPnl),
    sub: [deltaChip(dayPnl, dayPct), el('span', { class: 'muted' }, 'today')],
  }));
  root.append(heroCard('Invested', Math.round(investedPct) + '%', {
    splitPct: investedPct,
    sub: [el('span', { class: 'muted' }, `Invested ${rupee(investedVal, 0)}`), el('span', { class: 'muted' }, `· Cash ${rupee(cash, 0)}`)],
  }));
  root.append(heroCard('Unrealised P&L', signed(unreal, 0), {
    cls: moveClass(unreal),
    sub: [el('span', { class: 'muted' }, 'Realised'), el('span', { class: moveClass(real) }, signed(real, 0)), el('span', { class: 'muted' }, `· Margin ${rupee(margin, 0)}`)],
  }));
}

// --- Portfolio Greeks ------------------------------------------------------
// Net Greeks across all open OPTION/FUTURE positions. Each option's IV is
// recovered from its current market price (the chain feeds those LTPs in).
// Returns null when there are no F&O positions, so the UI hides the block.
// Pure — exported for tests.
function portfolioGreeks({ positions, lastPrices, quotes = {}, riskFreeRate = 6.5 }) {
  const r = riskFreeRate / 100;
  const totals = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  let hasFno = false;
  for (const key in positions) {
    const p = positions[key];
    if (!p || p.qty === 0 || !p.instrument) continue;
    const inst = p.instrument;
    if (inst.kind === 'EQ') continue;
    hasFno = true;
    if (inst.kind === 'FUT') {
      totals.delta += p.qty; // a future is delta = +/-1 per unit
      continue;
    }
    // Option: need a live spot (the underlying's quote, else the trade-time
    // snapshot) and an IV recovered from the option's current price.
    const spot = (quotes[inst.symbol] && quotes[inst.symbol].ltp) || inst.underlyingPrice;
    const last = lastPrices[key];
    if (!(spot > 0) || !(last > 0)) continue;
    // Prefer the stamped expiry TIMESTAMP when present: a COPIED F&O leg (Auto-Pilot) lives under a
    // synthetic "cyc{i}" expiry STRING that parseExpiryMs can't parse, which would give a wrong T and
    // wrong net Greeks. inst.expiryMs is stamped on such legs (and yearsToExpiry takes a ms timestamp).
    const T = yearsToExpiry(inst.expiryMs != null ? inst.expiryMs : parseExpiryMs(inst.expiry));
    const iv = impliedVol(inst.optType, last, spot, inst.strike, T, r);
    if (!Number.isFinite(iv)) continue;
    const g = greeks(inst.optType, spot, inst.strike, T, r, iv);
    totals.delta += g.delta * p.qty;
    totals.gamma += g.gamma * p.qty;
    totals.theta += g.theta * p.qty;
    totals.vega += g.vega * p.qty;
  }
  return hasFno ? totals : null;
}

function renderPortfolioGreeks(app) {
  const box = clear($('#portfolio-greeks'));
  const g = portfolioGreeks({
    positions: app.engine.state.positions,
    lastPrices: app.engine.state.lastPrices,
    quotes: app.state.quotes,
    riskFreeRate: app.engine.state.settings.riskFreeRate,
  });
  if (!g) return; // no F&O positions -> nothing to show
  box.append(
    stat('Net Δ', fmt(g.delta, 1), moveClass(g.delta)),
    stat('Net Γ', fmt(g.gamma, 4)),
    stat('Net Θ/day', signed(g.theta, 0), moveClass(g.theta)),
    stat('Net Vega', signed(g.vega, 0))
  );
}

// Draw the intra-session account-value (equity) curve on the dashboard.
function drawEquityCurve(app) {
  const canvas = $('#equity-chart');
  if (!canvas) return;
  const curve = Array.isArray(app.engine.state.equityCurve) ? app.engine.state.equityCurve : [];
  // Pick the time-axis granularity from the curve's actual SPAN: a normal intra-session curve is
  // minutes ('5m' -> HH:MM labels), but after "Reflect this in my account" the curve spans many
  // YEARS, so use a daily interval there (-> year/month date labels) instead of clock times.
  const span = curve.length > 1 ? curve[curve.length - 1].t - curve[0].t : 0;
  const interval = span > 3 * 864e5 ? '1d' : '5m';
  drawLineChart(canvas, curve, { interval, timeAxis: true, emptyMsg: 'Account value plots as you trade' });
  const nowEl = $('#equity-now');
  if (nowEl) nowEl.textContent = rupee(app.engine.equity(), 0);
}

function renderAccountBox(app) {
  const engine = app.engine;
  const root = clear($('#account-summary'));
  const rows = [
    ['Cash', rupee(engine.state.cash, 0)],
    ['Available', rupee(engine.availableFunds(), 0)],
    ['Margin used', rupee(engine.blockedMargin(), 0)],
    ['Open positions', String(Object.values(engine.state.positions).filter((p) => p.qty !== 0).length)],
  ];
  for (const [label, value] of rows) {
    root.append(el('div', { class: 'row' }, [el('span', { class: 'muted' }, label), el('span', { class: 'num' }, value)]));
  }
}

function th(t) {
  return el('th', {}, t);
}

export { renderPositions, portfolioGreeks };
