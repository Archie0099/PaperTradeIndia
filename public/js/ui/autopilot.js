// ---------------------------------------------------------------------------
// ui/autopilot.js
// THE AUTO-PILOT — "let a bot trade for me."
//
// After the tournament analyses all the bots, this picks the BEST one (by default
// the best risk-adjusted / Sharpe bot, or one you choose) and COPIES its current
// portfolio onto YOUR own ₹1-crore paper account, placing the trades through the
// SAME engine as a manual order — so your positions, P&L and trade log all update,
// and the MASTER money invariant still holds. It is pure copy-trading of VIRTUAL
// money: no real order is ever sent.
//
// HOW THE COPY WORKS (deliberately simple + faithful):
//   * The server exposes each bot's current holdings as a "mirror": the exact
//     instruments (incl. F&O option legs), the SIGNED size the bot holds, a mark
//     price to fill at, and the bot's own equity.
//   * Because both accounts are ₹1 crore, we copy at CAPITAL-RATIO scale:
//         yourQty = round( botQty × yourEquity / botEquity )   (rounded to whole lots)
//     so your portfolio is a scaled replica of the bot's — same % in each name,
//     long or short, stocks or options.
//   * Each tick we DIFF your current positions against that target and place market
//     orders for the difference (closing/reducing FIRST to free funds, then opening),
//     but only when the bot's target actually CHANGED (a signature check) — so a calm
//     day with no bot change places no trades (no churn).
//
// The pure functions (pickChampion / computeRebalanceOrders / mirrorSignature) carry
// the logic and are unit-tested in test/autopilot.test.mjs; the rest is DOM glue.
// ---------------------------------------------------------------------------

import { $, el, clear, rupee, fmt, signed, moveClass } from './dom.js';
import { instrumentKey, DEFAULT_CASH } from '../core/engine.js';
import { bsPrice } from '../core/options.js';
import { drawMultiLine, drawLineChart } from './chart.js';
import { windowed, windowMsOf, spanOf, windowButtons, effectiveWindow } from './chartwindow.js';
import { openBotPage } from './tournament.js'; // reuse the rich per-bot page for the followed strategy

const CFG_KEY = 'paper-trade-india:autopilot';

// Visible time-window for the "vs the market" chart (module-level so the choice survives the
// 30s tick re-render). 'MAX' = the whole walk-forward history (the default). See ui/chartwindow.js.
let apWindow = 'MAX';
let apAcctWindow = 'MAX'; // the window for the ACCOUNT (your own) equity curve in the detail view

// --- Config (persisted to localStorage) ------------------------------------
function defaultCfg() {
  return {
    enabled: false, // is the Auto-Pilot actively copying trades onto your account?
    mode: 'auto', // 'auto' = follow the walk-forward's best-Sharpe pick; 'manual' = follow `followId`
    followId: null, // the bot currently / last followed
    lastSig: null, // signature of the last target we synced to (the no-churn guard)
    lastSyncTs: null, // when we last rebalanced
  };
}
function getCfg() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    if (raw) return { ...defaultCfg(), ...JSON.parse(raw) };
  } catch {
    /* corrupt -> defaults */
  }
  return defaultCfg();
}
function saveCfg(cfg) {
  try {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
  } catch {
    /* best-effort */
  }
}
// Re-read the LATEST config and merge only the given fields. The background tick uses
// this (never a stale whole-object saveCfg) so it can't clobber a Pause / mode / metric /
// "Start fresh" change made during the tick's network awaits.
function patchCfg(patch) {
  saveCfg({ ...getCfg(), ...patch });
}

// --- Module state (UI only — the source of truth is the engine + localStorage) ---
let lastStandings = null; // last /api/tournament payload (for the champion preview + picker)
let lastMirror = null; // the followed bot's last mirror (for the holdings table)
let lastTargetName = null; // its display name
let recentActions = []; // the last batch of copy trades (for the activity log)
let statusMsg = ''; // a human status line
let ticking = false; // re-entrancy guard so two ticks never overlap
let pendingForce = false; // a FORCED tick requested while another was in flight (coalesced)

// ===========================================================================
// PURE LOGIC (unit-tested) — no DOM, no network.
// ===========================================================================

// Pick the "best" bot from a standings list by a metric (Sharpe by default),
// tie-broken by lifetime return. Non-finite metric values sort to the bottom.
function pickChampion(bots, { metric = 'sharpe' } = {}) {
  if (!Array.isArray(bots) || !bots.length) return null;
  const val = (b) => (Number.isFinite(b[metric]) ? b[metric] : -Infinity);
  const track = (b) => (Number.isFinite(b.trackReturnPct) ? b.trackReturnPct : -Infinity);
  let best = bots[0];
  for (let i = 1; i < bots.length; i++) {
    const b = bots[i];
    if (val(b) > val(best) || (val(b) === val(best) && track(b) > track(best))) best = b;
  }
  return best;
}

// Build an engine instrument from a mirror position entry (carries F&O details so
// an option leg can be reproduced exactly).
function instrumentFromMirror(p) {
  const inst = { kind: p.kind, symbol: p.symbol, lotSize: p.lotSize || 1 };
  if (p.kind === 'FUT' || p.kind === 'OPT') inst.expiry = p.expiry;
  if (p.kind === 'OPT') {
    inst.strike = p.strike;
    inst.optType = p.optType;
    // Carry the expiry timestamp + IV so the copied leg can be RE-MARKED live from the
    // underlying (remarkOptionPositions) — a modelled cyc{i} expiry has no real chain feed.
    if (p.expiryMs != null) inst.expiryMs = p.expiryMs;
    if (p.iv != null) inst.iv = p.iv;
  }
  if (p.underlyingPrice != null) inst.underlyingPrice = p.underlyingPrice;
  return inst;
}

// Re-mark held OPTION positions (copied from an F&O bot) using the SAME Black-Scholes model the
// bot uses, priced off the LIVE underlying quote. A copied leg lives under a modelled cyc{i}
// expiry that no real option chain feeds, so without this its mark would FREEZE at the fill
// price — a misleadingly static P&L and a dropped roll P&L. This keeps the copy tracking the
// bot with an INDICATIVE model price (no paid feed — exactly like the bot's own).
// Only touches positions that carry expiryMs + iv (i.e. copied F&O legs); manual options and
// equities are left alone. Silent (the poll loop emits/renders once afterwards).
const OPT_R = 0.065; // risk-free rate, matching backtest/options-model.mjs
function remarkOptionPositions(app, nowMs = Date.now()) {
  const eng = app.engine;
  let changed = false;
  for (const key in eng.state.positions) {
    const pos = eng.state.positions[key];
    if (!pos || pos.qty === 0) continue;
    const inst = pos.instrument;
    if (inst.kind !== 'OPT' || inst.expiryMs == null || !(inst.iv > 0)) continue; // only copied F&O legs
    const q = app.state.quotes[inst.symbol];
    const spot = q && q.ltp > 0 ? q.ltp : eng.state.lastPrices[`EQ:${String(inst.symbol).toUpperCase()}`];
    if (!(spot > 0)) continue; // no live underlying yet — leave the last mark
    const T = Math.max(0, (inst.expiryMs - nowMs) / 864e5) / 365; // years to expiry (wall-clock)
    const price = T <= 0
      ? Math.max(0, inst.optType === 'CE' ? spot - inst.strike : inst.strike - spot)
      : bsPrice(inst.optType, spot, inst.strike, T, OPT_R, inst.iv);
    inst.underlyingPrice = spot; // keep the short-option margin notional current as spot moves
    eng.onPriceUpdate(key, Math.max(price, 0.05), true);
    changed = true;
  }
  return changed;
}

// A stable signature of the bot's HOLDINGS — each instrument and its SIGNED unit count.
// Used to skip a no-op resync on a calm day: a bot's share counts are FIXED between
// rebalances, so this signature changes ONLY when the bot actually REBALANCES — never
// merely because a price moved (a price move changes the bot's equity, not its held
// quantities). The config stores it per followed bot id, so it's compared like-for-like
// over time. (Keying on qty/equity instead would flip on every market tick — spurious
// churn once the copied book has drifted even slightly from the bot.)
function mirrorSignature(mirror) {
  if (!mirror || !Array.isArray(mirror.positions) || !mirror.positions.length) return 'cash';
  return mirror.positions
    .map((p) => `${p.key}:${p.qty}`)
    .sort()
    .join('|');
}

const labelOf = (inst) => (inst.kind === 'OPT' ? `${inst.symbol} ${inst.strike}${inst.optType}` : inst.kind === 'FUT' ? `${inst.symbol} FUT` : inst.symbol);

function rebalanceReason(inst, fromQty, toQty, botName) {
  const lab = labelOf(inst);
  if (toQty === 0) return `Auto-Pilot: ${botName} no longer holds ${lab} — closed the copied position.`;
  if (fromQty === 0) return `Auto-Pilot: copied ${botName} — opened ${lab} (${toQty > 0 ? 'long' : 'short'}) to match the bot.`;
  if (Math.sign(toQty) !== Math.sign(fromQty)) return `Auto-Pilot: ${botName} flipped ${lab} — reversed the copied position.`;
  return `Auto-Pilot: rebalanced ${lab} toward ${botName}'s current target size.`;
}

// Compute the market orders that bring the account to the bot's mirror, scaled
// to the account's equity. `current` = [{ key, instrument, qty }] (the account's open
// positions). `priceFor(key, spec)` returns a fill price (live quote for stocks, the
// bot's mark for options) or null. Returns orders ordered funds-FREEING first.
function computeRebalanceOrders({ mirror, current, userEquity, priceFor, botName = 'the bot' }) {
  const orders = [];
  if (!mirror || !(mirror.equity > 0) || !(userEquity > 0)) return orders;
  const scale = userEquity / mirror.equity;

  // Target signed unit count per instrument key (rounded to whole lots).
  const targetByKey = new Map();
  for (const p of mirror.positions || []) {
    const lot = p.lotSize || 1;
    const targetUnits = Math.round((p.qty * scale) / lot) * lot;
    targetByKey.set(p.key, { spec: p, targetUnits });
  }
  const curByKey = new Map();
  for (const c of current || []) curByKey.set(c.key, c);

  const keys = new Set([...targetByKey.keys(), ...curByKey.keys()]);
  for (const key of keys) {
    const t = targetByKey.get(key);
    const c = curByKey.get(key);
    const fromQty = c ? c.qty : 0;
    const toQty = t ? t.targetUnits : 0; // a held name NOT in the target is driven to flat
    if (toQty === fromQty) continue;
    const instrument = t ? instrumentFromMirror(t.spec) : c.instrument;
    const lot = instrument.lotSize || 1;
    const price = priceFor(key, t ? t.spec : instrument);
    if (!(price > 0)) continue; // can't place an order without a price
    // Emit one order per from->to. A position that FLIPS sign (long->short or short->long)
    // is SPLIT into TWO: a close-to-flat (funds-FREEING) THEN an open of the new side
    // (funds-consuming). A single combined order would make the engine fund the new side's
    // margin BEFORE the close releases cash, so a fully-invested flip would be REJECTED and
    // leave the account on the OPPOSITE side of the bot. Splitting funds it correctly.
    const push = (frm, to) => {
      if (to === frm) return;
      const lots = Math.round(Math.abs(to - frm) / lot);
      if (lots < 1) return;
      orders.push({ key, instrument, side: to > frm ? 'BUY' : 'SELL', lots, price, fromQty: frm, toQty: to, reason: rebalanceReason(instrument, frm, to, botName) });
    };
    const flips = fromQty !== 0 && toQty !== 0 && Math.sign(toQty) !== Math.sign(fromQty);
    if (flips) { push(fromQty, 0); push(0, toQty); }
    else push(fromQty, toQty);
  }
  // Order the orders so the account always has room: (0) funds-FREEING first (a sell that
  // reduces/closes a long, or a buy that covers a short — releases cash/margin), then
  // funds-CONSUMING opens with (1) SHORT opens BEFORE (2) long opens. A short open is
  // funds-NEUTRAL in this engine (it reserves full notional as margin AND credits the
  // sale proceeds), so opening shorts first keeps cash available for the longs — the same
  // ordering the pairs backtester uses to copy a market-neutral book WITHOUT truncating a
  // leg into a net-directional position.
  const rankOf = (o) => {
    const opensExposure = o.fromQty === 0
      ? true
      : Math.sign(o.toQty) === Math.sign(o.fromQty) && Math.abs(o.toQty) > Math.abs(o.fromQty);
    if (!opensExposure) return 0; // close / reduce / cover -> frees funds
    return o.side === 'SELL' ? 1 : 2; // short opens before long opens
  };
  orders.sort((a, b) => rankOf(a) - rankOf(b));
  return orders;
}

// ===========================================================================
// LIVE GLUE (network + engine + DOM)
// ===========================================================================

// The fill price for an instrument: live quote for a stock we have one for, else the
// bot's mark price, else the engine's last seen price (for closing an existing leg).
function priceFor(app, key, spec) {
  if (spec && spec.kind === 'EQ' && spec.symbol) {
    const q = app.state.quotes[spec.symbol];
    if (q && q.ltp > 0) return q.ltp;
  }
  if (spec && spec.price > 0) return spec.price;
  const last = app.engine.state.lastPrices[key];
  return last > 0 ? last : null;
}

// Place a set of rebalance orders through the engine and return a result per order.
// A funds-CONSUMING equity leg (opening or adding to a long OR a short) is CAPPED to
// what's actually affordable right now — sequential buys deplete cash, and rounding can
// make a fully-invested copy overshoot its last leg by a share or two; capping (exactly
// like the basket backtester) means the copy never rejects on a rounding hair. Closing/
// reducing legs and F&O legs are placed as-is (the engine still funds-checks them).
function placeMirrorOrders(engine, orders) {
  const results = [];
  for (const o of orders) {
    let lots = o.lots;
    const sameSignIncrease =
      o.instrument.kind === 'EQ' &&
      (o.fromQty === 0 || Math.sign(o.toQty) === Math.sign(o.fromQty)) &&
      Math.abs(o.toQty) > Math.abs(o.fromQty);
    if (sameSignIncrease && o.price > 0) {
      const affordable = Math.floor(Math.max(0, engine.availableFunds()) / o.price);
      lots = Math.min(lots, affordable);
    }
    if (lots < 1) {
      results.push({ o, status: 'SKIPPED', reason: 'not enough funds', lots: 0, capped: true });
      continue;
    }
    const res = engine.placeOrder({ instrument: o.instrument, side: o.side, orderType: 'MARKET', lots, price: o.price });
    if (res && res.status === 'FILLED') res.reason = o.reason; // tag so the Orders trade log shows "why"
    // `capped` = this open was CLIPPED below its target (live-price drift on an over-leveraged
    // book). Flag it so the no-churn guard does NOT record "in sync" — the next tick retries the
    // shortfall once funds free up (else a market-neutral copy could sit net-directional).
    results.push({ o, order: res, status: res ? res.status : 'ERROR', reason: res && res.status !== 'FILLED' ? res.reason || 'rejected' : o.reason, lots, capped: lots < o.lots });
  }
  return results;
}

// Build a full engine state that REFLECTS the walk-forward track record into the account:
// "I started with ₹1cr ~N years ago and auto-piloting grew it to E — and I'm now holding the
// current champion's portfolio (scaled to E)." The gain is earned, so initialCash stays ₹1cr
// and the gain shows as the account's return, with the N-year curve as the account history.
// Pure + invariant-safe: realised + unrealised == equity - initialCash (unrealised is 0 at
// seed since each leg is marked at its entry price, so realised = E - initialCash).
function buildSeededState(autopilot, mirror) {
  const E = autopilot.metrics.finalEquity;
  const initial = autopilot.cash || DEFAULT_CASH;
  const scale = mirror && mirror.equity > 0 ? E / mirror.equity : 0; // scale the bot's book to E
  const positions = {}, lastPrices = {};
  let holdingsValue = 0;
  for (const p of (mirror && mirror.positions) || []) {
    const lot = p.lotSize || 1;
    const qty = Math.round((p.qty * scale) / lot) * lot;
    if (!qty || !(p.price > 0)) continue;
    const inst = instrumentFromMirror(p);
    const key = instrumentKey(inst);
    positions[key] = { key, instrument: inst, qty, avgPrice: +p.price, realised: 0, stopLoss: null, target: null };
    lastPrices[key] = +p.price;
    holdingsValue += inst.kind === 'FUT' ? 0 : qty * p.price; // FUT moves no cash at entry (mark==avg)
  }
  return {
    initialCash: initial,
    cash: E - holdingsValue, // equity = cash + holdingsValue = E
    realised: E - initial, // the earned gain (unrealised is 0 at seed)
    positions,
    orders: [],
    lastPrices,
    equityCurve: (autopilot.curve || []).map((c) => ({ t: c.t, c: +c.c })),
    dayStart: null,
  };
}

// Reflect the walk-forward track record into your actual account ("this
// is my bot, I earned it"). Confirms, fetches the current champion's holdings for the live
// positions, then loads the seeded state. The Auto-Pilot continues forward from there.
async function seedAccountFromTrackRecord(app) {
  const ap = lastStandings && lastStandings.autopilot;
  if (!ap || !ap.currentBot || !ap.metrics) {
    window.alert('No track record to apply yet (needs ~1 year of history).');
    return;
  }
  const E = ap.metrics.finalEquity, initial = ap.cash || DEFAULT_CASH;
  const yrs = ap.startedAt ? ((Date.now() - ap.startedAt) / (365.25 * 864e5)).toFixed(0) : '16';
  if (!window.confirm(`Reflect your Auto-Pilot's track record into your account?\n\nThis sets your account to ${rupee(E, 0)} — the result of starting with ${rupee(initial, 0)} about ${yrs} years ago and auto-piloting since (a simulated paper track record). It replaces your current positions, and the Auto-Pilot continues forward from here.`)) return;
  let detail;
  try {
    detail = await app.api.tournamentBot(ap.currentBot.id);
  } catch {
    window.alert('Could not load the current bot to apply.');
    return;
  }
  const mirror = detail && detail.mirror;
  try {
    app.engine.importJson(JSON.stringify(buildSeededState(ap, mirror)));
  } catch (e) {
    window.alert('Could not apply the track record: ' + e.message);
    return;
  }
  const cfg = getCfg();
  // The track record IS the auto best-Sharpe strategy, so adopt it: run forward in AUTO mode, and
  // record the CURRENT champion's signature as already-in-sync (the seed placed us at its exact
  // scaled book), so the next tick does NOT churn the freshly seeded account on price drift.
  cfg.mode = 'auto';
  cfg.lastSig = mirror ? `${ap.currentBot.id}#${mirrorSignature(mirror)}` : null;
  saveCfg(cfg);
  syncControls(cfg);
  statusMsg = `Applied your ~${yrs}-year track record — account set to ${rupee(E, 0)}.`;
  renderIfVisible(app);
}

function resolveTarget(standings, cfg) {
  const bots = (standings && standings.bots) || [];
  if (cfg.mode === 'manual' && cfg.followId) {
    const m = bots.find((b) => b.id === cfg.followId);
    if (m) return m; // else the chosen bot vanished -> fall back to the auto pick
  }
  // AUTO: follow the WALK-FORWARD's current point-in-time best-Sharpe pick
  // (standings.autopilot.currentBot), so the live copy IS exactly the strategy the "vs the
  // market" track record (and the "reflect in my account" seed) describe — no metric mismatch.
  // Fall back to best full-life Sharpe only until the walk-forward has enough history.
  if (standings && standings.autopilot && standings.autopilot.currentBot) {
    const m = bots.find((b) => b.id === standings.autopilot.currentBot.id);
    if (m) return m;
  }
  return pickChampion(bots, { metric: 'sharpe' });
}

// The account's open positions in the shape computeRebalanceOrders expects.
function currentPositions(app) {
  return Object.values(app.engine.state.positions)
    .filter((p) => p.qty !== 0)
    .map((p) => ({ key: p.key || instrumentKey(p.instrument), instrument: p.instrument, qty: p.qty }));
}

// One Auto-Pilot tick: resolve the target bot, fetch its mirror, and (if it changed
// since last sync, or `force`) rebalance the account to copy it. Safe to call often.
async function autopilotTick(app, { force = false } = {}) {
  if (!getCfg().enabled) return { skipped: 'disabled' };
  // Re-entrancy: never overlap two ticks. If a FORCED tick (Start / Sync / a setting change)
  // arrives while a background tick is mid-flight, remember it so it runs right after — a
  // forced user action must not be silently dropped.
  if (ticking) {
    if (force) pendingForce = true;
    return { skipped: 'busy' };
  }
  ticking = true;
  try {
    let standings;
    try {
      standings = await app.api.tournament();
    } catch {
      statusMsg = 'Could not reach the tournament — will retry.';
      renderIfVisible(app);
      return { error: 'standings' };
    }
    if (!getCfg().enabled) return { skipped: 'disabled-midflight' }; // paused during the await
    lastStandings = standings;
    const cfg = getCfg(); // the LATEST config, read AFTER the await
    const target = resolveTarget(standings, cfg);
    if (!target) {
      statusMsg = 'No bot available to follow yet.';
      renderIfVisible(app);
      return { error: 'no-target' };
    }
    let detail;
    try {
      detail = await app.api.tournamentBot(target.id);
    } catch {
      statusMsg = `Could not load ${target.name} to copy — will retry.`;
      renderIfVisible(app);
      return { error: 'detail' };
    }
    if (!getCfg().enabled) return { skipped: 'disabled-midflight' };
    const mirror = detail && detail.mirror;
    // A missing mirror OR one flagged not-followable is a HOLD, never a copy. The server
    // flags a bot whose market data hasn't loaded yet (a cold-boot background fetch, or a
    // failed fetch): its "empty book" is indistinguishable from genuinely-in-cash, and
    // copying it would LIQUIDATE the whole account into cash — then churn it all back
    // once the data lands. Skip and retry; the held positions stay untouched.
    if (!mirror || mirror.followable === false) {
      statusMsg = mirror
        ? `${target.name}'s market data is still loading — holding your positions as-is (will retry).`
        : `${target.name} can't be copied yet.`;
      renderIfVisible(app);
      return { error: 'no-mirror' };
    }
    lastMirror = mirror;
    lastTargetName = target.name;

    const sig = `${target.id}#${mirrorSignature(mirror)}`;
    // "In sync" must hold in BOTH directions, keyed on the SET of legs (not sizes):
    //  - a held name the bot does NOT target (a position was manually opened) -> drive it flat;
    //  - a targeted leg no longer held (a manual Close / Square-off-all) -> re-copy it;
    //  - a held leg on the OPPOSITE side of the bot (a manual flip) -> re-copy it.
    // Size drift WITHIN a same-side held leg stays accepted by design: the target size is
    // price-scaled (round(botQty x userEq/botEq)), so re-checking sizes every tick would
    // churn on ordinary price moves — the signature exists precisely to prevent that.
    const targetKeys = new Set((mirror.positions || []).map((p) => p.key));
    const curQtyByKey = new Map(currentPositions(app).map((c) => [c.key, c.qty]));
    const hasForeign = [...curQtyByKey.keys()].some((k) => !targetKeys.has(k));
    const hasMissing = (mirror.positions || []).some((p) => p.qty !== 0 && !curQtyByKey.has(p.key));
    const hasFlipped = (mirror.positions || []).some((p) => {
      const q = curQtyByKey.get(p.key);
      return q != null && p.qty !== 0 && Math.sign(q) !== Math.sign(p.qty);
    });
    if (!force && sig === getCfg().lastSig && !hasForeign && !hasMissing && !hasFlipped) {
      // The bot hasn't changed its portfolio since our last copy — nothing to do.
      // Record who we follow — but never CLOBBER a follow choice made while this
      // tick was mid-flight (a click already wrote the new followId; overwriting it
      // with this tick's now-stale target would make the coalesced forced tick copy the
      // WRONG bot). Only write it if the config still holds what we read at tick start.
      if (getCfg().followId === cfg.followId) patchCfg({ followId: target.id });
      statusMsg = `Active — copying ${target.name}. In sync (no change).`;
      renderIfVisible(app);
      return { noop: true };
    }
    // FINAL gate before placing any trade: if Pause was pressed at any point during the
    // awaits, do not trade (honours "Pause stops further copying").
    if (!getCfg().enabled) return { skipped: 'disabled-midflight' };

    const orders = computeRebalanceOrders({
      mirror,
      current: currentPositions(app),
      userEquity: app.engine.equity(),
      priceFor: (k, s) => priceFor(app, k, s),
      botName: target.name,
    });
    const results = placeMirrorOrders(app.engine, orders);
    app.engine.save(); // persist the reason tags (placeOrder already emitted/saved each fill)
    const actions = results.map((r) => ({
      label: labelOf(r.o.instrument),
      side: r.o.side,
      lots: r.lots != null ? r.lots : r.o.lots,
      status: r.status,
      why: r.status === 'FILLED' ? r.o.reason : r.reason,
    }));
    // Record "in sync" ONLY if every leg fully copied. If any leg couldn't fill, leave
    // lastSig null so the NEXT tick RE-COMPUTES and retries (by then sibling closes have
    // freed funds) — a partial copy must not be treated as done. Use patchCfg so we never
    // clobber a setting changed during this tick's awaits — including a "Follow <bot>"
    // click: if the followId no longer matches what we read at tick start, it was
    // re-targeted mid-flight, so keep THAT choice (the coalesced forced tick that the
    // click queued will copy the new bot next).
    const synced = results.every((r) => r.status === 'FILLED' && !r.capped);
    const followPatch = getCfg().followId === cfg.followId ? { followId: target.id } : {};
    patchCfg({ ...followPatch, lastSig: synced ? sig : null, lastSyncTs: Date.now() });
    if (actions.length) recentActions = actions; // keep the latest non-empty batch
    const filled = actions.filter((a) => a.status === 'FILLED').length;
    const couldntFill = actions.length - filled;
    statusMsg = `Active — copying ${target.name}. Synced ${filled} trade${filled === 1 ? '' : 's'}${couldntFill ? `, ${couldntFill} couldn't fill (will retry; try "Start fresh ₹1 cr")` : ''}.`;
    renderIfVisible(app);
    return { applied: actions.length, filled, rejected: couldntFill };
  } finally {
    ticking = false;
    // Run a forced tick that arrived while we were busy (coalesced to one).
    if (pendingForce) {
      pendingForce = false;
      autopilotTick(app, { force: true });
    }
  }
}

// ===========================================================================
// RENDER
// ===========================================================================
function renderIfVisible(app) {
  const panel = $('#tab-autopilot');
  if (panel && panel.classList.contains('active')) render(app);
}

function champCard(app, target, cfg) {
  if (!target) return el('div', { class: 'empty-state' }, 'No bots available yet — the tournament is warming up.');
  const followedNow = cfg.enabled && cfg.followId === target.id;
  return el('div', { class: 'ap-champion-card card' }, [
    el('div', { class: 'ap-champ-head' }, [
      el('div', {}, [
        el('div', { class: 'ap-champ-name' }, [target.name, ' ', el('span', { class: 'kind-badge' }, `${target.kind} · ${target.symbol}`)]),
        el('div', { class: 'muted', html: target.explain || '' }),
      ]),
      el('div', { class: 'ap-champ-stats' }, [
        statBlock('Sharpe', fmt(target.sharpe, 2), moveClass(target.sharpe)),
        statBlock('1Y', target.r1y == null ? '–' : signed(target.r1y, 1) + '%', moveClass(target.r1y)),
        statBlock('Lifetime', target.trackReturnPct == null ? '–' : signed(target.trackReturnPct, 0) + '%', moveClass(target.trackReturnPct)),
      ]),
    ]),
    el('div', { class: 'muted', style: 'margin-top:6px' }, [`Position: ${target.position || 'flat'}`, followedNow ? '  ·  ✓ you are copying this bot' : '']),
  ]);
}

// Read a CSS custom property (for canvas line colours), with a hex fallback for jsdom.
function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch {
    return fb;
  }
}

// The standard tournament-bot return columns, applied to the Auto-Pilot + the market row.
const AP_COLS = [
  ['1D', 'liveReturnPct'], ['1W', 'r1w'], ['1M', 'r1m'], ['1Y', 'r1y'],
  ['5Y', 'r5y'], ['10Y', 'r10y'], ['MAX', 'trackReturnPct'],
];

// The honest "Auto-Pilot vs the market" walk-forward track record (server-computed): a
// populated, years-long ₹1cr→now history of auto-picking the best bot with NO hindsight,
// shown with the normal bot return columns + a dated curve vs NIFTY Buy & Hold.
function renderTrackRecord(app, ap) {
  const root = $('#ap-track');
  if (!root) return;
  clear(root);
  if (!ap || !ap.metrics) {
    root.append(el('div', { class: 'empty-state' }, 'Building the multi-year track record… (needs ~1 year of history on the host).'));
    return;
  }
  const m = ap.metrics, b = ap.benchMetrics, beat = ap.vsMarketPct;
  const yrs = ap.startedAt ? (Date.now() - ap.startedAt) / (365.25 * 864e5) : null;
  root.append(
    el('div', { class: 'ap-tr-headline' }, [
      el('h3', {}, 'Auto-Pilot vs the market'),
      el('div', { class: 'ap-tr-big ' + moveClass(beat) }, beat >= 0 ? `Beating the market by ${signed(beat, 1)}%` : `Behind the market by ${fmt(Math.abs(beat), 1)}%`),
      el('div', { class: 'muted' }, [
        `Auto-Pilot${yrs ? ` (~${yrs.toFixed(0)}y, no hindsight)` : ''}: `,
        el('strong', { class: moveClass(m.trackReturnPct) }, `${rupee(ap.cash, 0)} → ${rupee(m.finalEquity, 0)} (${signed(m.trackReturnPct, 1)}%)`),
        `   ·   ${ap.benchName}: `,
        el('strong', { class: moveClass(b.trackReturnPct) }, `${rupee(b.finalEquity, 0)} (${signed(b.trackReturnPct, 1)}%)`),
      ]),
    ])
  );
  // Honesty: the primary benchmark is the NIFTY PRICE index (it pays no dividends). The
  // real market does — so when the server could compute the head-to-head against the
  // dividend-adjusted proxy (NIFTYBEES) over their common window, show it plainly.
  if (ap.benchTri) {
    const t = ap.benchTri;
    const since = new Date(t.startedAt).getFullYear();
    root.append(el('div', { class: 'muted', style: 'font-size:11px; margin: 2px 0 4px' },
      `${ap.benchName} above is the PRICE index — dividends excluded. Against ${t.name} over their common window (since ${since}): Auto-Pilot ${signed(t.apReturnPct, 1)}% vs market ${signed(t.triReturnPct, 1)}% → ${t.vsPct >= 0 ? 'ahead' : 'behind'} by ${fmt(Math.abs(t.vsPct), 1)}%.`));
  }
  // Honesty: when the currently-followed bot is an F&O premium-seller, the equity (and so the
  // "beating the market" figure + the seed value) bakes in MODELLED open-option prices — flag it.
  if (ap.currentBot && ap.currentBot.kind === 'FNO') {
    root.append(el('div', { class: 'muted', style: 'font-size:11px; margin: 2px 0 6px' }, 'Note: the currently-followed bot trades F&O, whose option prices are MODELLED (Black-Scholes, indicative) — so these figures include modelled open-position value, not traded option quotes.'));
  }
  root.append(
    el('button', { class: 'btn btn-accent', style: 'margin: 4px 0 8px', onClick: () => seedAccountFromTrackRecord(app) }, `Reflect this in my account → ${rupee(m.finalEquity, 0)}`)
  );
  const tbl = el('table', { class: 'ap-tr-table' });
  tbl.append(el('thead', {}, el('tr', {}, [el('th', {}, ''), ...AP_COLS.map(([h]) => el('th', { class: 'num' }, h)), el('th', { class: 'num' }, 'Sharpe'), el('th', { class: 'num' }, 'MaxDD')])));
  const row = (label, x, strong) =>
    el('tr', {}, [
      el('td', {}, strong ? el('strong', {}, label) : label),
      ...AP_COLS.map(([, k]) => el('td', { class: 'num ' + (x[k] == null ? 'muted' : moveClass(x[k])) }, x[k] == null ? '–' : signed(x[k], 1) + '%')),
      el('td', { class: 'num ' + moveClass(x.sharpe) }, fmt(x.sharpe, 2)),
      el('td', { class: 'num down' }, fmt(x.maxDrawdownPct, 1) + '%'),
    ]);
  tbl.append(el('tbody', {}, [row('Auto-Pilot', m, true), row(ap.benchName, b, false)]));
  root.append(el('div', { class: 'table-wrap' }, tbl));
  // The dated Auto-Pilot-vs-market curve, with a visible legend + a time-window selector.
  const apColor = cssVar('--accent', '#f5b544'); // the Auto-Pilot line
  const benchColor = cssVar('--violet', '#8b7dff'); // the market (NIFTY) line
  // Prefer the light multi-resolution tiers (so a short-window zoom keeps resolution); fall back
  // to the flat 120-point curve for older payloads / test stubs that don't carry tiers.
  const apSrc = ap.curveTiers && ap.curveTiers.length ? ap.curveTiers : ap.curve || [];
  const benchSrc = ap.benchTiers && ap.benchTiers.length ? ap.benchTiers : ap.benchCurve || [];
  // A visible swatch LEGEND: say plainly which colour is which, instead of only
  // naming them in the chart title. DOM (crisp + accessible), using the exact line colours.
  root.append(el('div', { class: 'chart-legend' }, [
    el('span', { class: 'legend-item' }, [el('span', { class: 'legend-swatch', style: `background:${apColor}` }), el('span', {}, 'Auto-Pilot')]),
    el('span', { class: 'legend-item' }, [el('span', { class: 'legend-swatch', style: `background:${benchColor}` }), el('span', {}, `${ap.benchName} — the market`)]),
  ]));
  const span = Math.max(spanOf(apSrc), spanOf(benchSrc));
  const eff = effectiveWindow(apWindow, span);
  const winRow = el('div');
  root.append(winRow);
  // Switching the window just re-slices the curves already in hand and re-renders this panel
  // (no re-fetch); the choice is kept in `apWindow` so the 30s tick re-render preserves it.
  winRow.append(windowButtons({ current: eff, span, onPick: (k) => { apWindow = k; renderTrackRecord(app, ap); } }));
  const cv = el('canvas', { id: 'ap-tr-chart', class: 'canvas', height: '210' });
  root.append(cv);
  root.append(el('div', { class: 'muted', style: 'font-size:11px; margin-top:6px' }, 'Honest walk-forward: at each point it followed whichever bot had the best risk-adjusted return using ONLY the data known THEN — no hindsight in the PICK, all figures net of the full Indian cost model (STT, exchange charges, slippage, SLB borrow on shorts), Sharpe measured in excess of a ~6.5% risk-free rate. Two caveats to keep it honest: the bot line-up is today’s curated set, AND the stock universe is today’s liquid survivors — names that went to zero (DHFL, Jet Airways…) could never be picked, which flatters every long-history figure. It shows “among these strategies, on these surviving stocks, auto-picking beats the market” — not “you could have built this in 2008”. Simulated, paper money. See METHODOLOGY.md in the repo for the full assumptions.'));
  const winMs = windowMsOf(eff);
  const bw = windowed(benchSrc, winMs), aw = windowed(apSrc, winMs);
  drawMultiLine(
    cv,
    [
      { values: bw.map((p) => p.c), times: bw.map((p) => p.t), color: benchColor, highlight: true },
      { values: aw.map((p) => p.c), times: aw.map((p) => p.t), color: apColor, highlight: true },
    ],
    { title: `Auto-Pilot vs ${ap.benchName}` }
  );
}

function statBlock(label, value, cls) {
  return el('div', { class: 'ap-stat' }, [el('div', { class: 'ap-stat-label' }, label), el('div', { class: 'ap-stat-value num ' + (cls || '') }, value)]);
}

// The "what the bot holds -> your copy" table: bot weight, your target qty (scaled),
// and your actual current qty, so you can see the copy line up.
function holdingsTable(app, mirror) {
  if (!mirror || !Array.isArray(mirror.positions) || !mirror.positions.length) {
    return el('div', { class: 'empty-state' }, mirror ? 'The bot is fully in cash — your copy holds no positions.' : 'Press Start to begin copying a bot.');
  }
  const userEquity = app.engine.equity();
  const scale = mirror.equity > 0 ? userEquity / mirror.equity : 0;
  const table = el('table');
  table.append(
    el('thead', {}, el('tr', {}, [
      el('th', {}, 'Instrument'),
      el('th', { class: 'num' }, 'Bot weight'),
      el('th', { class: 'num' }, 'Your target'),
      el('th', { class: 'num' }, 'You hold'),
    ]))
  );
  const tbody = el('tbody');
  for (const p of mirror.positions) {
    const inst = instrumentFromMirror(p);
    const lot = p.lotSize || 1;
    const targetUnits = Math.round((p.qty * scale) / lot) * lot;
    const weight = mirror.equity > 0 ? (p.qty * p.price) / mirror.equity * 100 : 0;
    const held = app.engine.state.positions[p.key];
    const heldQty = held ? held.qty : 0;
    const fmtLots = (units) => (lot > 1 ? `${units / lot} lot${Math.abs(units / lot) === 1 ? '' : 's'}` : fmt(units, 0));
    tbody.append(
      el('tr', {}, [
        el('td', {}, labelOf(inst)),
        el('td', { class: 'num ' + moveClass(weight) }, signed(weight, 1) + '%'),
        el('td', { class: 'num' }, fmtLots(targetUnits)),
        el('td', { class: 'num ' + (heldQty === targetUnits ? 'up' : heldQty ? 'down' : 'muted') }, fmtLots(heldQty)),
      ])
    );
  }
  table.append(tbody);
  return el('div', {}, table);
}

function actionsList() {
  if (!recentActions.length) return el('div', { class: 'empty-state' }, 'No trades yet. When the bot rebalances, the copies appear here.');
  return el(
    'ul',
    { class: 'ap-actions-list' },
    recentActions.slice(0, 40).map((a) =>
      el('li', { class: a.status === 'FILLED' ? '' : 'ap-rejected' }, [
        el('span', { class: 'ap-act-side ' + (a.side === 'BUY' ? 'up' : 'down') }, a.side),
        ` ${a.lots} × ${a.label} `,
        el('span', { class: 'muted', title: a.why }, a.status === 'FILLED' ? '✓' : `✕ ${a.why}`),
      ])
    )
  );
}

// The manual bot picker (shown in manual mode): a compact list with a Follow button.
function picker(app, cfg) {
  if (cfg.mode !== 'manual' || !lastStandings) return el('div');
  const bots = [...(lastStandings.bots || [])].sort((a, b) => (b.sharpe || -Infinity) - (a.sharpe || -Infinity));
  const wrap = el('div', { class: 'ap-picker' }, [el('h3', {}, 'Choose a bot to copy')]);
  const list = el('div', { class: 'table-wrap' });
  const table = el('table');
  table.append(el('thead', {}, el('tr', {}, [el('th', {}, 'Bot'), el('th', {}, 'Kind'), el('th', { class: 'num' }, 'Sharpe'), el('th', { class: 'num' }, 'Lifetime'), el('th', {}, '')])));
  const tbody = el('tbody');
  for (const b of bots) {
    const following = cfg.followId === b.id;
    tbody.append(
      el('tr', { class: following ? 'ap-followed-row' : '' }, [
        el('td', {}, b.name),
        el('td', { class: 'muted' }, `${b.kind} · ${b.symbol}`),
        el('td', { class: 'num ' + moveClass(b.sharpe) }, fmt(b.sharpe, 2)),
        el('td', { class: 'num ' + moveClass(b.trackReturnPct) }, b.trackReturnPct == null ? '–' : signed(b.trackReturnPct, 0) + '%'),
        el('td', {}, el('button', { class: 'btn btn-mini', onClick: () => followBot(app, b.id) }, following ? '✓ Following' : 'Follow')),
      ])
    );
  }
  table.append(tbody);
  list.append(table);
  wrap.append(list);
  return wrap;
}

function followBot(app, id) {
  const cfg = getCfg();
  cfg.mode = 'manual';
  cfg.followId = id;
  cfg.lastSig = null; // force a resync to the newly chosen bot
  saveCfg(cfg);
  syncControls(cfg);
  if (cfg.enabled) autopilotTick(app, { force: true });
  else render(app);
}

// Keep the static HTML controls in sync with the config (after load / mode change).
function syncControls(cfg) {
  const toggle = $('#ap-toggle');
  if (toggle) {
    toggle.textContent = cfg.enabled ? '⏸ Pause' : '▶ Start';
    toggle.classList.toggle('btn-accent', !cfg.enabled);
    toggle.classList.toggle('btn-danger', cfg.enabled);
  }
  const mode = $('#ap-mode');
  if (mode) mode.value = cfg.mode;
}

// The full Auto-Pilot DETAIL view (history and all details, like a normal bot).
// Two parts: (A) what the Auto-Pilot DID on YOUR account — your equity curve, per-name booked P&L,
// and the full copy-trade history with the reason behind each trade; (B) the STRATEGY it follows —
// which bot it followed over the years (the walk-forward timeline) and a link to that bot's full
// page (rationale + why-each-stock). Pure client-side (the engine holds the account history).
function renderApDetail(app) {
  const root = $('#ap-detail');
  if (!root) return;
  clear(root);
  const eng = app.engine;
  const cfg = getCfg();

  // ---- (A) What it did on YOUR account ----
  root.append(el('h3', { style: 'margin: 0 0 6px' }, 'What your Auto-Pilot did — your account'));

  // Account equity curve (the engine's own samples / the seeded multi-year curve), with window zoom.
  const curve = (eng.state.equityCurve || []).filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.c));
  if (curve.length > 1) {
    root.append(el('div', { class: 'muted', style: 'margin: 4px 0 2px' }, 'Account value over time'));
    const span = spanOf(curve);
    // A SEEDED account holds the multi-year walk-forward curve (date axis); an un-seeded LIVE account
    // holds the engine's intra-session samples (a few points seconds/minutes apart) — for that short
    // span use an intraday axis (HH:MM) so the labels read sensibly instead of all-same-date.
    const acctInterval = span < 2 * 864e5 ? '60m' : '1d';
    const winRow = el('div');
    const cv = el('canvas', { class: 'canvas', height: '180' });
    root.append(winRow);
    root.append(cv);
    const redraw = () => {
      const eff = effectiveWindow(apAcctWindow, span);
      clear(winRow).append(windowButtons({ current: eff, span, onPick: (k) => { apAcctWindow = k; redraw(); } }));
      drawLineChart(cv, windowed(curve, windowMsOf(eff)), { interval: acctInterval, timeAxis: true });
    };
    redraw();
  } else {
    root.append(el('div', { class: 'muted', style: 'font-size: 12px; margin: 4px 0' }, 'Your account history builds up as the Auto-Pilot trades — or use “Reflect this in my account” above to seed the multi-year track record.'));
  }

  // This section is titled "what your AUTO-PILOT did" — so it must only count orders the
  // Auto-Pilot itself placed. Every copy trade is tagged with an "Auto-Pilot: ..." reason
  // by placeMirrorOrders; a manual ticket order carries none. Without this filter, a user
  // who paper-traded by hand (before enabling the Auto-Pilot, or alongside it) had ALL
  // their manual trades counted as "copy trades" and their P&L attributed to the
  // Auto-Pilot — an honesty issue, not a money bug (the fills themselves are real).
  const isApOrder = (o) => typeof o.reason === 'string' && o.reason.startsWith('Auto-Pilot');

  // Per-name booked P&L (who made / lost money) — realised per symbol from the trade log, with the
  // names you currently HOLD flagged.
  // Keyed by the engine's INSTRUMENT KEY (not the bare symbol), so multiple F&O legs that share one
  // underlying (e.g. a NIFTY call + put) are NOT merged into one mis-attributed row.
  const realisedBy = new Map(); // instrumentKey -> { label, realised }
  for (const o of eng.state.orders) {
    if (o.status === 'FILLED' && isApOrder(o) && o.closing && Number.isFinite(o.realised) && o.instrument) {
      const k = instrumentKey(o.instrument);
      const e = realisedBy.get(k) || { label: o.label || labelOf(o.instrument), realised: 0 };
      e.realised += o.realised;
      realisedBy.set(k, e);
    }
  }
  const pnlRows = [];
  for (const key in eng.state.positions) {
    const p = eng.state.positions[key];
    if (!p || p.qty === 0) continue;
    const e = realisedBy.get(key); // the position map is keyed by the same instrument key
    pnlRows.push({ label: labelOf(p.instrument), qty: p.qty, realised: e ? e.realised : 0, held: true });
    realisedBy.delete(key);
  }
  for (const [, e] of realisedBy) pnlRows.push({ label: e.label, qty: 0, realised: e.realised, held: false });
  if (pnlRows.length) {
    pnlRows.sort((a, b) => b.realised - a.realised);
    const tbl = el('table');
    tbl.append(el('thead', {}, el('tr', {}, [el('th', {}, 'Name'), el('th', { class: 'num' }, 'You hold'), el('th', { class: 'num' }, 'Booked P&L')])));
    const tb = el('tbody');
    for (const r of pnlRows.slice(0, 30)) tb.append(el('tr', {}, [
      el('td', {}, r.held ? el('strong', {}, r.label) : r.label),
      el('td', { class: 'num' }, r.qty ? String(r.qty) : '–'),
      el('td', { class: 'num ' + (r.realised ? moveClass(r.realised) : 'muted') }, r.realised ? signed(r.realised, 0) : '–'),
    ]));
    tbl.append(tb);
    root.append(el('div', { class: 'muted', style: 'margin: 12px 0 2px' }, 'Per-name booked P&L (bold = currently held)'));
    root.append(el('div', { class: 'table-wrap' }, tbl));
  }

  // Full trade history — every copy trade, with the REASON the Auto-Pilot placed it.
  // Only Auto-Pilot-tagged fills belong here; manual fills live in the Orders tab.
  const fills = eng.state.orders.filter((o) => o.status === 'FILLED' && isApOrder(o));
  const anyFills = eng.state.orders.some((o) => o.status === 'FILLED'); // incl. manual
  // A SEEDED account ("Reflect this in my account") carries the multi-year walk-forward equity curve
  // but NO orders AT ALL (buildSeededState sets orders:[]) — so a bare "No trades yet" would misread a
  // ₹13cr seeded track record sitting right beneath its own 16-year curve. Detect it (a curve spanning
  // > a month with zero fills of ANY kind = a seeded simulated track record) and explain honestly.
  // (Keyed on anyFills so a manually-traded account is never mislabelled "seeded".)
  const seededTrack = curve.length > 1 && spanOf(curve) > 31 * 864e5 && !anyFills;
  root.append(el('div', { class: 'muted', style: 'margin: 12px 0 2px' }, `Trade history (${fills.length} copy trade${fills.length === 1 ? '' : 's'})`));
  if (!fills.length) {
    root.append(el('div', { class: 'empty-state' }, seededTrack
      ? 'This account was seeded from your Auto-Pilot’s simulated multi-year track record, so there is no per-trade history to replay — only the resulting equity curve and current holdings above. New copy trades will appear here as the Auto-Pilot trades forward.'
      : anyFills
        ? 'No copy trades yet — the trades on this account so far were placed manually (see the Orders tab). When the followed bot rebalances, every copied buy/sell shows here with its reason.'
        : 'No trades yet — when the followed bot rebalances, every copied buy/sell shows here with its reason.'));
  } else {
    const tbl = el('table');
    tbl.append(el('thead', {}, el('tr', {}, [el('th', {}, 'Date'), el('th', {}, 'Side'), el('th', { class: 'num' }, 'Qty'), el('th', {}, 'Instrument'), el('th', { class: 'num' }, 'Price'), el('th', {}, 'Why')])));
    const tb = el('tbody');
    for (const o of fills.slice(0, 100)) {
      tb.append(el('tr', {}, [
        // Rendered in IST like every other market date (en-IN sets only the format).
        el('td', {}, new Date(o.fillTs || o.ts).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })),
        el('td', { class: o.side === 'BUY' ? 'up' : 'down' }, o.side),
        el('td', { class: 'num' }, String(o.qty)),
        el('td', {}, o.label),
        el('td', { class: 'num' }, Number.isFinite(o.fillPrice) ? o.fillPrice.toFixed(2) : '–'),
        el('td', { class: 'muted', style: 'font-size: 11px' }, o.reason || ''),
      ]));
    }
    tbl.append(tb);
    root.append(el('div', { class: 'table-wrap', style: 'max-height: 320px; overflow: auto' }, tbl));
  }

  // ---- (B) The strategy it follows ----
  const ap = lastStandings && lastStandings.autopilot;
  root.append(el('h3', { style: 'margin: 16px 0 6px' }, 'The strategy it follows'));
  const target = resolveTarget(lastStandings, cfg);
  if (target) {
    root.append(el('button', { class: 'btn btn-mini', onClick: () => { app.tabs.show('tournament'); openBotPage(app, target.id); } }, `📄 Open ${target.name}'s full strategy & why-each-stock →`));
  } else {
    root.append(el('div', { class: 'muted', style: 'font-size: 12px' }, 'No bot to follow yet — the tournament is warming up.'));
  }
  // Which bot it followed over the walk-forward — the "what it did at the strategy level" history.
  // The timeline is ALWAYS the AUTO walk-forward's best-Sharpe picks (server-computed, mode-agnostic).
  // In MANUAL mode the account actually follows the manually-chosen pick, so label the timeline as the
  // AUTO alternative (for reference) rather than "what it followed" — else it contradicts the button
  // just above, which opens the manually-followed bot.
  const effectivelyManual = cfg.mode === 'manual' && cfg.followId && target && target.id === cfg.followId;
  if (ap && Array.isArray(ap.followedTimeline) && ap.followedTimeline.length) {
    root.append(el('div', { class: 'muted', style: 'margin: 10px 0 2px' }, effectivelyManual
      ? `You’re manually following ${target.name}. For reference, AUTO mode would instead follow the best-Sharpe bot, re-picked over time (no hindsight):`
      : 'Which bot it would have followed over the years (walk-forward, no hindsight):'));
    const ul = el('ul', { class: 'ap-follow-timeline', style: 'margin: 4px 0; padding-left: 18px; font-size: 12px; line-height: 1.6' });
    for (const f of ap.followedTimeline) ul.append(el('li', {}, [el('span', { class: 'muted' }, `${new Date(f.t).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })} → `), f.name]));
    root.append(ul);
  }
}

function render(app) {
  const cfg = getCfg();
  syncControls(cfg);
  const target = resolveTarget(lastStandings, cfg);

  const statusEl = $('#ap-status');
  if (statusEl) {
    const base = cfg.enabled
      ? statusMsg || `Active — copying ${target ? target.name : '…'}.`
      : 'Paused — your account is yours; press Start to let a bot trade it.';
    statusEl.textContent = base;
    statusEl.className = 'muted ' + (cfg.enabled ? 'ap-on' : '');
  }

  const champ = clear($('#ap-champion'));
  if (champ) champ.append(champCard(app, target, cfg));

  // The honest "Auto-Pilot vs the market" multi-year walk-forward track record.
  renderTrackRecord(app, lastStandings && lastStandings.autopilot);

  const holds = $('#ap-holdings');
  if (holds) {
    clear(holds);
    holds.append(holdingsTable(app, cfg.enabled ? lastMirror : null));
  }
  const acts = clear($('#ap-actions'));
  if (acts) acts.append(actionsList());

  const pick = clear($('#ap-picker'));
  if (pick) pick.append(picker(app, cfg));

  // The full "what it did + the strategy it follows" detail (history/details view).
  renderApDetail(app);
}

// Fetch fresh standings (for the champion preview + picker) then render. Called when
// the tab is shown. Trading itself is the tick (interval + Start/Sync), not this.
async function renderAutoPilot(app) {
  try {
    lastStandings = await app.api.tournament();
  } catch {
    /* keep the previous standings (if any); render shows the warming-up state otherwise */
  }
  render(app);
  // If we're active, also refresh the copy right away so the holdings table is current.
  if (getCfg().enabled) autopilotTick(app);
}

// Wire the static controls + expose the background tick. Idempotent: app.autopilotTick is
// (re)set every call, and the DOM buttons are wired once per document (guarded by a data
// flag) — so it's safe whether called once in the app or once per fresh DOM in tests.
function initAutoPilot(app) {
  // Expose the tick so the global poll loop can drive it.
  app.autopilotTick = (opts) => autopilotTick(app, opts);

  const toggle = $('#ap-toggle');
  if (!toggle || toggle.dataset.apWired) {
    syncControls(getCfg());
    return;
  }
  toggle.dataset.apWired = '1';

  if (toggle)
    toggle.addEventListener('click', () => {
      const cfg = getCfg();
      cfg.enabled = !cfg.enabled;
      if (cfg.enabled) cfg.lastSig = null; // force a fresh copy on Start
      saveCfg(cfg);
      syncControls(cfg);
      if (cfg.enabled) autopilotTick(app, { force: true });
      else {
        statusMsg = '';
        render(app);
      }
    });

  const sync = $('#ap-sync');
  if (sync) sync.addEventListener('click', () => autopilotTick(app, { force: true }));

  const mode = $('#ap-mode');
  if (mode)
    mode.addEventListener('change', () => {
      const cfg = getCfg();
      cfg.mode = mode.value;
      cfg.lastSig = null;
      saveCfg(cfg);
      syncControls(cfg);
      if (cfg.enabled) autopilotTick(app, { force: true });
      else render(app);
    });

  const fresh = $('#ap-fresh');
  if (fresh)
    fresh.addEventListener('click', () => {
      const ok = window.confirm('Reset your account to a clean ₹1 crore? This clears all your current positions and cash so the bot starts from a fresh slate. (Virtual money only.)');
      if (!ok) return;
      app.engine.reset(DEFAULT_CASH); // ₹1 crore — kept in sync with the personal-account default
      const cfg = getCfg();
      cfg.lastSig = null; // re-copy onto the clean account
      saveCfg(cfg);
      // The activity log describes the PREVIOUS account's copy trades — stale against the
      // freshly-wiped book (while paused there is no tick to refresh it, so it would sit
      // showing trades that no longer exist). Clear it with the account.
      recentActions = [];
      statusMsg = 'Account reset to a clean ₹1 crore.';
      if (cfg.enabled) autopilotTick(app, { force: true });
      else render(app);
    });

  syncControls(getCfg());
}

export { initAutoPilot, renderAutoPilot, autopilotTick, remarkOptionPositions, buildSeededState, pickChampion, computeRebalanceOrders, placeMirrorOrders, mirrorSignature, instrumentFromMirror };
