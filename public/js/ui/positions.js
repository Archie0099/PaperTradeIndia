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
        // A position with NO price at all (an imported file with an empty `lastPrices`) is just
        // as unfed as one with a frozen price, and notLivePositions() counts it in the headline —
        // so the row must carry the same marker, or the headline says "the table marks which one"
        // and the table marks nothing.
        el('td', { class: 'num' }, live ? (last == null ? '…' : last.toFixed(2)) : [
          last == null ? '…' : last.toFixed(2),
          // A marker, not a warning: the number is real, it is simply the LAST one seen rather
          // than a current one. The hover carries the why, because the row has no space for it
          // and an unexplained symbol on a trading screen is its own kind of noise.
          staleMark(staleReason(p.instrument), ' ·not live'),
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

// How often the Option Chain tab re-fetches its chain while it is on screen. app.js imports THIS
// for its timer, so the liveness window below is derived from the real cadence rather than
// restating "6s" in a comment that could drift from it. (The server caches the chain for a few
// seconds, so 6s respects NSE's ~1-req/3s limit.)
export const CHAIN_REFRESH_MS = 6000;

// How recently a price must have arrived to count as live: three missed chain refreshes plus a
// small margin. Three misses means the feed really has stopped — which happens the moment you
// navigate away from the Chain tab, since that refresh is gated on the tab being active. Generous
// enough that arriving from the chain does not instantly cry stale.
// ★ HONEST CONSEQUENCE: because the chain refreshes ONLY while its tab is active and the Positions
// table lives on another panel, an F&O contract is "live" here for at most this window after you
// leave the Chain tab. So in ordinary use the Close dialog below DOES ask for a manually traded
// F&O contract — the one-click exemption is real only inside this window. That is the truthful
// state (nothing is feeding the contract by then), not a bug; keeping the chain refreshing in the
// background for held contracts would hammer a free, rate-limited endpoint, so it is disclosed.
export const LIVE_PRICE_MS = 3 * CHAIN_REFRESH_MS + 2000;

// The "·not live" / "·chain only" marker. The reason lives in `title` (a hover), which does not
// exist on touch — so a tap shows the same text. ONE builder for every marker, so a reader can
// always get at the why on a phone, where §8's mobile-QA item already lives.
function staleMark(title, text) {
  const show = () => { if (typeof alert === 'function') alert(title); };
  return el('span', {
    class: 'stale-mark',
    title,
    // Announced as a button and reachable by keyboard, so it must also ACT like one: Enter and
    // Space do what a tap does (a role with no key handler is a dead tab stop).
    role: 'button',
    tabindex: '0',
    onclick: show,
    onkeydown: (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); show(); } },
  }, text);
}

// ★ IS THIS INSTRUMENT'S PRICE STILL BEING FED INTO THE ENGINE?
//
// ★★ THIS IS AN OBSERVATION, NOT A MODEL, AND THAT DISTINCTION IS THE WHOLE POINT. The first
// version answered it structurally — an equity is polled, a copied leg is re-marked, an option is
// fed if `app.state.chain` matches its symbol and expiry — and a review showed the model was wrong
// in both directions:
//
//   * It said LIVE for the contract you had just been looking at, forever. `app.state.chain` is
//     assigned once and never cleared, while the chain's 6s refresh is gated on the Chain TAB
//     being active — and the Positions table lives in a different, mutually exclusive panel. So
//     at the exact moment this marker renders, NOTHING is feeding any F&O contract, and the
//     matching one was the single case the rule exempted. Buy an option, switch to the dashboard,
//     sit for two hours: no marker, and Close filled at the two-hour-old price without asking.
//   * It said LIVE for contracts the chain provably cannot feed: `feedEngineFromChain` only walks
//     the strikes actually in the visible window and skips any leg without a positive LTP. Hold a
//     26000 CE with spot at 23500 and the rule still called it live.
//
// Both faults are the same mistake — re-deriving what the feed does instead of watching what it
// did. `engine.lastPriceAt` is stamped inside `onPriceUpdate`, the one door every live price comes
// through, so this cannot drift from the feed again and needs no knowledge of strike windows,
// LTPs or which tab is open.
//
// ★★ EQUITIES USED TO BE EXEMPTED BY KIND (`if (inst.kind === 'EQ') return true`), AND THAT WAS THE
// SAME MISTAKE THIS FUNCTION EXISTS TO UNDO — one layer up. "Is this price current?" is a question
// about ONE SYMBOL RIGHT NOW; answering it from the instrument's KIND is modelling the feed again,
// exactly what the note above says not to do. The exemption's stated rationale was that app.js
// polls every held symbol anyway and that a real outage is the status bar's job. Both halves fail
// for the case that actually happens — a SINGLE symbol going bad:
//   * `app.pollQuotes` (app.js) wraps each symbol's fetch in its own try/catch and, on failure,
//     leaves the previous quote in place. Nothing is flagged, and the other symbols poll fine.
//   * `ui/statusbar.js` drives its banner from `/api/status`'s GLOBAL feed health, so one 404 or
//     one throttled/delisted symbol among many raises nothing there either.
// Result: a held equity whose quote had stopped rendered a frozen LTP identically to a live one,
// was left out of the "· N not live" count, and Close / Square off all / a MARKET ticket fill all
// proceeded silently against it — the precise harm this guard was built for, waved through by kind.
//
// There is no over-fire risk in removing it, and the arithmetic is the reason rather than a hope:
// app.js polls quotes every 5s while LIVE_PRICE_MS is 20s, so a row is marked only after FOUR
// consecutive failures for that symbol. A blip cannot reach it; a symbol that has genuinely stopped
// will.
function priceIsLive(app, inst) {
  if (!inst) return true;
  // ★ BEFORE THE FIRST POLL HAS FINISHED, NOTHING IS KNOWN — and "unknown" must not render as
  // "stale". `app.js` calls renderEngineViews() before pollQuotes(), and `lastPriceAt` is
  // deliberately not persisted, so on every page load there is a window where nothing has been fed
  // simply because nothing has been ASKED yet. Treating that as not-live put a marker on every
  // held row after a routine reload and made Close / Square off all raise their dialog for
  // ordinary equities — for up to ~30s on a cold free-tier boot. A missing flag reads as "polled",
  // so a caller that never sets it (a test harness, another surface) behaves exactly as before.
  if (app.state && app.state.pricesPolled === false) return true;
  const at = app.engine.lastPriceAt && app.engine.lastPriceAt[instrumentKey(inst)];
  return Number.isFinite(at) && Date.now() - at < LIVE_PRICE_MS;
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
// no remedy just makes the screen feel broken — and the remedy differs by how the contract is
// priced, so the sentence has to branch rather than assert the common case at everything.
// An Auto-Pilot copied leg lives under a modelled expiry no chain serves (`cyc293`, stamped by
// instrumentFromMirror); it is re-priced off the live underlying on every poll. So if one has gone
// quiet the Option Chain is NOT the remedy — no chain can ever show that expiry — the underlying
// quote is what is missing. ONE predicate for that, shared by the hover and all three dialogs: a
// review found the hover branching on this while the dialogs asserted the chain story at every
// contract, sending the reader to open an expiry that does not exist.
function isCopiedLeg(inst) {
  if (inst.kind === 'OPT' && inst.expiryMs != null && inst.iv > 0) return true;
  // A copied FUTURE carries the same modelled `cyc…` expiry but no expiryMs/iv, and
  // remarkOptionPositions() skips non-options — so it is never re-priced at all. It still must
  // not be sent to a chain that cannot show it. Latent today (the F&O bots hold option legs
  // only), closed because the same review that found the option case would have found this one.
  return (inst.kind === 'FUT' || inst.kind === 'OPT') && /^cyc/.test(String(inst.expiry || ''));
}

// A copied FUTURE is never re-priced by anything: no chain serves its expiry and the re-mark is
// options-only. Its cause and remedy differ from a copied option's, so they branch too.
const isCopiedFuture = (inst) => inst.kind === 'FUT' && isCopiedLeg(inst);

// WHY the price is frozen, as a sentence naming `priceText` as the number in question. The
// dialogs and the hover each wrap this in their own framing; the cause is written once.
// `held` says whether the number is the mark of a position already held (then it is usually the
// fill price) or a chain price a ticket is about to OPEN against (then there was no fill).
function staleCause(inst, priceText, held = true) {
  const what = inst.kind === 'FUT' ? 'future' : 'option';
  // ★ AN EQUITY HAS NO CHAIN AND NO EXPIRY, so it must never reach the chain sentence below.
  // `priceIsLive()` used to exempt equities BY KIND, which made this branch unreachable
  // for them; dropping that exemption was right (one throttled symbol used to render a frozen
  // price as live) but it left the WORDING with only its three F&O branches. An unfed equity was
  // then told "This option is only marked while the Option Chain tab is OPEN on RELIANCE
  // undefined" and sent to open an expiry that does not exist — on the hover, on the Close
  // dialog that books a realised P&L, and on the ticket's MARKET confirm. Reproduced in a real
  // browser before this was written. The true cause is the background quote poll: app.js polls
  // every held symbol every 5s and try/catches each one, so a single symbol can stop arriving
  // while the status bar still reads the feed as healthy.
  if (inst.kind === 'EQ') {
    return (
      `The ${inst.symbol} quote is not arriving — every held symbol is polled in the background, ` +
      `and this one has not come back for several cycles — so ${priceText} is the last price ` +
      `seen${held ? ', not a current one' : ''}`
    );
  }
  if (isCopiedFuture(inst)) {
    return (
      `This copied future carries a modelled expiry (${inst.expiry}) that no chain serves and is ` +
      `never re-priced, so ${priceText} is the price it was copied at`
    );
  }
  if (isCopiedLeg(inst)) {
    return (
      `This copied leg is re-priced from the live ${inst.symbol} quote on every poll, and that ` +
      `has not happened recently — most likely the ${inst.symbol} quote is not arriving — so ` +
      `${priceText} is the last modelled price`
    );
  }
  return (
    `This ${what} is only marked while the Option Chain tab is OPEN on ${inst.symbol} ` +
    `${inst.expiry} — the chain stops refreshing the moment you leave that tab — so ${priceText} ` +
    `is the last price seen${held ? ', usually the price it was filled at' : ''}`
  );
}

// The ONE thing the reader can do about it. Branches with the cause, never asserted alone.
function staleRemedy(inst) {
  if (isCopiedFuture(inst)) return `accept that there is no live price for it — nothing can feed a modelled expiry`;
  // An equity is fed by the background quote poll, never by the chain — same remedy as a copied
  // leg (wait for the symbol to come back), never "open that expiry".
  if (inst.kind === 'EQ' || isCopiedLeg(inst)) {
    return `wait for the ${inst.symbol} quote to resume (the status bar shows the feed's state)`;
  }
  return `open that expiry in the Option Chain first`;
}

// A short tag for a list line, so "Square off all" can say per contract why it is unfed.
function staleTag(inst) {
  if (isCopiedFuture(inst)) return `copied future, never re-priced`;
  return isCopiedLeg(inst)
    ? `copied leg, ${inst.symbol} quote not arriving`
    : `chain not open on ${inst.symbol} ${inst.expiry}`;
}

// What the frozen number is, for the square-off summary: built from the SET of unfed contracts,
// so a dialog listing only copied legs never mentions a chain, and vice versa.
function stalePriceKinds(insts) {
  const kinds = [];
  if (insts.some(isCopiedFuture)) kinds.push('the price it was copied at for a copied future');
  if (insts.some((i) => isCopiedLeg(i) && !isCopiedFuture(i))) kinds.push('the last modelled price for a copied leg');
  if (insts.some((i) => !isCopiedLeg(i))) kinds.push('usually the fill price for a contract whose chain is not open');
  return kinds.join(', ');
}

function staleReason(inst) {
  const remedy = isCopiedFuture(inst)
    ? `Nothing can feed a modelled expiry; the P&L stays frozen until the position is closed.`
    : (inst.kind === 'EQ' || isCopiedLeg(inst))
      ? `Wait for the ${inst.symbol} quote to resume (the status bar shows the feed's state); it is re-marked on the next poll.`
      : `Open that expiry in the Option Chain to mark it again.`;
  return (
    `Not a live price. ${staleCause(inst, 'this')}, and the unrealised P&L beside it is frozen ` +
    `with it. ${remedy}`
  );
}

// ★ THE DISPLAY PROBLEM, ESCALATED INTO AN ACTION. Closing fills at `lastPrices[key]`, which for
// an unfed F&O contract is the price it was last marked at — usually the fill. So one click books
// a REALISED P&L against a price that may be hours or days old, and nothing said so. There is no
// better price available (that is the whole point: nothing is feeding this contract), so the
// answer is not to refuse — trapping someone in a position is worse — it is to say what is about
// to happen and let them decide. It asks ONLY when nothing is feeding the row: an equity whose
// quote is arriving, and a contract on the displayed chain, both stay one click — though for a
// contract that exemption lasts only LIVE_PRICE_MS after leaving the Chain tab (see its note), so
// in practice this asks for most manual F&O closes. ★ An equity is NOT exempt by kind (that
// exemption was removed); a symbol the background poll has stopped delivering reaches this dialog too, and
// gets the quote-poll cause and remedy rather than the chain story.
function confirmStalePriceClose(app, pos, last) {
  if (priceIsLive(app, pos.instrument)) return true;
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  return window.confirm(staleFillWarning(pos.instrument, last, `Close ${contractLabel(pos.instrument)}`));
}

// The body of every "fill at a frozen price?" dialog — the per-row Close and the order ticket's
// MARKET order ask the same question with the same consequence, so they share one text and one
// branch. `act` is the first line ("Close NIFTY 23500 CE 30-Oct-2026", "Place this MARKET order").
// `consequence` is the caller's, because it differs: a Close BOOKS a realised P&L against the
// price, while a ticket order OPENING a position books nothing and simply fills at it — the first
// shared version said "the realised P&L this books" on the ticket too, which was false there.
function staleFillWarning(inst, last, act, { consequence = 'the realised P&L this books will be calculated from it', held = true } = {}) {
  const price = last.toFixed(2);
  return (
    `${act} at ${price}?\n\n` +
    `That is NOT a live price. ${staleCause(inst, price, held)}, and ${consequence}.\n\n` +
    `To trade at a current price, cancel and ${staleRemedy(inst)}.`
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
      staleMark(
        `${unfed} open ${unfed === 1 ? 'position is' : 'positions are'} marked at a last-seen ` +
          `price rather than a live one, so ${unfed === 1 ? 'its' : 'their'} share of this total ` +
          `is frozen — usually at zero, because the mark is still the price it was filled at. ` +
          `The Positions table below marks which ${unfed === 1 ? 'one' : 'ones'}.`,
        `· ${unfed} not live`
      )
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
  const unfed = notLivePositions(app);
  if (unfed.length === 0) return true; // everything is being fed — no question to ask
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  // Each line names the contract AND why it is unfed, because the two causes have different
  // remedies and a copied leg listed beside a chain contract would otherwise inherit its story.
  const stale = unfed.map((inst) => `${contractLabel(inst)} — ${staleTag(inst)}`);
  const n = stale.length;
  return window.confirm(
    `Square off everything?\n\n` +
      // "1 of these positionS HAS" — the noun stays plural (it refers to the whole set being
      // squared off) while only the verb agrees with the count.
      `${n} of these positions ${n === 1 ? 'has' : 'have'} no live price right now:\n  ` +
      `${stale.join('\n  ')}\n\n` +
      `${n === 1 ? 'It' : 'They'} will be closed at the last price seen — ` +
      `${stalePriceKinds(unfed)}` +
      ` — so the realised P&L booked for ${n === 1 ? 'it' : 'them'} will be calculated from that, ` +
      `not from a current market price.`
  );
}

export { renderPositions, portfolioGreeks, priceIsLive, confirmStaleSquareOff, staleFillWarning, staleMark };
