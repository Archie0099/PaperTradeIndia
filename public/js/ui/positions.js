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
    // ★ IS THIS ROW'S PRICE ACTUALLY BEING FED? See priceIsLive() — an F&O contract outside the
    // chain currently on screen has no feed at all, so its "LTP" is whatever it was last marked
    // at (usually the fill) and its unrealised P&L is frozen with it. Both are rendered in the
    // same style as a live row, which is the part that misleads.
    const live = priceIsLive(app, p.instrument);
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
        el('td', { class: 'num' }, last == null ? '…' : live ? last.toFixed(2) : [
          last.toFixed(2),
          // A marker, not a warning: the number is real, it is simply the LAST one seen rather
          // than a current one. The hover carries the why, because the row has no space for it
          // and an unexplained symbol on a trading screen is its own kind of noise.
          el('span', { class: 'stale-mark', title: staleReason(p.instrument) }, ' ·not live'),
        ]),
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

// ★ IS THIS INSTRUMENT'S PRICE CURRENTLY BEING FED INTO THE ENGINE?
//
// This is a STRUCTURAL question, not a timing one, which is why it needs no timestamps: it asks
// whether any feed exists for this contract right now, and there are exactly three cases.
//
//   EQ  — always fed. app.js's symbolsToPoll() adds the symbol of EVERY open position, so a held
//         equity is quoted on every poll whether or not it is on screen. (Whether that poll
//         SUCCEEDED is a different question, and the status bar's own banner already answers it.)
//   OPT carrying expiryMs + iv — always fed. These are Auto-Pilot copies living under a modelled
//         expiry no real chain serves, and remarkOptionPositions() re-prices them off the live
//         underlying on every poll. Their price is a model price, which the Auto-Pilot UI labels
//         as indicative; it is not stale.
//   OPT / FUT otherwise — fed ONLY while the option chain on screen is showing that exact symbol
//         AND expiry, because feedEngineFromChain() is their only price source and it walks the
//         displayed chain. Hold two expiries, or switch the chain to another underlying, and the
//         contracts you are no longer looking at stop being marked entirely.
//
// The last case is the reachable one, and it is easy to hit by accident: the position keeps its
// fill price as "LTP" and shows an unrealised P&L frozen at (usually) zero, while the portfolio
// Greeks beside it DO keep moving, because those reprice off the live underlying spot. So the
// screen can simultaneously say the position has not moved and that its delta has.
function priceIsLive(app, inst) {
  if (!inst) return true;
  if (inst.kind === 'EQ') return true;
  if (inst.kind === 'OPT' && inst.expiryMs != null && inst.iv > 0) return true; // re-marked each poll
  const chain = app.state && app.state.chain;
  if (!chain) return false; // the chain tab has never loaded — nothing is feeding F&O at all
  return chain.symbol === inst.symbol && chain.expiry === inst.expiry;
}

// Every OPEN position being marked at a price nobody is feeding. ONE definition, used by the
// headline note and by the square-off guard — they need different things from it (a count, and a
// list of names), and letting each walk the positions itself is exactly how two surfaces end up
// disagreeing about what counts as "not live".
function notLivePositions(app) {
  const out = [];
  for (const key in app.engine.state.positions) {
    const p = app.engine.state.positions[key];
    if (!p || p.qty === 0) continue;
    if (!priceIsLive(app, p.instrument)) out.push(p.instrument);
  }
  return out;
}

const countNotLive = (app) => notLivePositions(app).length;

// The hover text. It names the ONE thing the reader can do about it, because "this is stale" with
// no remedy just makes the screen feel broken.
function staleReason(inst) {
  const what = inst.kind === 'FUT' ? 'future' : 'option';
  return (
    `Not a live price. This ${what} is only marked while the Option Chain tab is showing ` +
    `${inst.symbol} ${inst.expiry}; right now it is not, so this is the last price seen ` +
    `(usually the price it was filled at) and the unrealised P&L beside it is frozen with it. ` +
    `Open that expiry in the Option Chain to mark it again.`
  );
}

// ★ THE DISPLAY PROBLEM, ESCALATED INTO AN ACTION. Closing fills at `lastPrices[key]`, which for
// an unfed F&O contract is the price it was last marked at — usually the fill. So one click books
// a REALISED P&L against a price that may be hours or days old, and nothing said so. There is no
// better price available (that is the whole point: nothing is feeding this contract), so the
// answer is not to refuse — trapping someone in a position is worse — it is to say what is about
// to happen and let them decide. Equities and contracts on the displayed chain are untouched and
// stay one click, so this asks ONLY in the case that is actually wrong.
function confirmStalePriceClose(app, pos, last) {
  if (priceIsLive(app, pos.instrument)) return true;
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(
    `Close ${contractLabel(pos.instrument)} at ${last.toFixed(2)}?\n\n` +
      `That is NOT a live price. This contract is only marked while the Option Chain tab is ` +
      `showing ${pos.instrument.symbol} ${pos.instrument.expiry}, so ${last.toFixed(2)} is the ` +
      `last price seen — usually the price you filled at — and the realised P&L this books will ` +
      `be calculated from it.\n\n` +
      `To close at a current price, cancel and open that expiry in the Option Chain first.`
  );
}

function closeButton(app, pos) {
  const btn = el('button', { class: 'btn btn-mini' }, 'Close');
  btn.addEventListener('click', () => {
    const key = instrumentKey(pos.instrument);
    const last = app.engine.state.lastPrices[key] || pos.avgPrice;
    if (!confirmStalePriceClose(app, pos, last)) return;
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

// The same instrument, named in FULL for a dialog. labelFor() drops the expiry on purpose — the
// table column is narrow and the expiry is usually obvious from context — but in a "this price is
// not live" message the expiry is the entire point: it is the one thing the reader needs in order
// to find the contract and do something about it. A dialog that said "NIFTY 23500CE has no live
// price" would name every expiry of that strike at once and help with none of them.
function contractLabel(inst) {
  if (inst.kind === 'EQ') return inst.symbol;
  if (inst.kind === 'FUT') return `${inst.symbol} FUT ${inst.expiry}`;
  return `${inst.symbol} ${inst.strike} ${inst.optType} ${inst.expiry}`;
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
  // ★ THE HEADLINE INHERITS THE ROW-LEVEL PROBLEM. Unrealised P&L sums every position, and a
  // contract with no live feed contributes its FROZEN mark — usually zero, because the mark is
  // still the fill price. So the biggest number on the screen can read "no movement" while the
  // real answer is simply unknown. The per-row marker says which position; this says that the
  // total is affected at all, which is what someone reading only the hero cards would miss.
  // Shown ONLY when something really is unfed, so it is never permanent furniture.
  const unfed = countNotLive(app);
  const unrealSub = [
    el('span', { class: 'muted' }, 'Realised'),
    el('span', { class: moveClass(real) }, signed(real, 0)),
    el('span', { class: 'muted' }, `· Margin ${rupee(margin, 0)}`),
  ];
  if (unfed > 0) {
    unrealSub.push(
      el('span', {
        class: 'stale-mark',
        title:
          `${unfed} open ${unfed === 1 ? 'position is' : 'positions are'} marked at a last-seen ` +
          `price rather than a live one, so ${unfed === 1 ? 'its' : 'their'} share of this total ` +
          `is frozen — usually at zero, because the mark is still the price it was filled at. ` +
          `The Positions table below marks which ${unfed === 1 ? 'one' : 'ones'}.`,
      }, `· ${unfed} not live`)
    );
  }
  root.append(heroCard('Unrealised P&L', signed(unreal, 0), {
    cls: moveClass(unreal),
    sub: unrealSub,
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

// ★ THE SAME QUESTION FOR "SQUARE OFF ALL", which closes everything in one click through the
// engine's closeAll() — and closeAll() marks each leg at `lastPrices` exactly as the per-row
// Close does, so an unfed contract is squared off at a stale price along with everything else.
// The guard lives HERE, in the UI, and not in closeAll(): the engine is also the backtester's
// engine, and a money-model method must never reach for a browser dialog.
// Returns true to proceed. Silent unless something really is unfed.
function confirmStaleSquareOff(app) {
  const stale = notLivePositions(app).map(contractLabel);
  if (stale.length === 0) return true; // everything is being fed — no question to ask
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(
    `Square off everything?\n\n` +
      // "1 of these positionS HAS" — the noun stays plural (it refers to the whole set being
      // squared off) while only the verb agrees with the count.
      `${stale.length} of these positions ${stale.length === 1 ? 'has' : 'have'} no live ` +
      `price right now:\n  ${stale.join('\n  ')}\n\n` +
      `${stale.length === 1 ? 'It' : 'They'} will be closed at the last price seen — usually the ` +
      `price you filled at — so the realised P&L booked for ${stale.length === 1 ? 'it' : 'them'} ` +
      `will be calculated from that, not from a current market price.`
  );
}

export { renderPositions, portfolioGreeks, priceIsLive, confirmStaleSquareOff };
