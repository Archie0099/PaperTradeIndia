// ---------------------------------------------------------------------------
// core/engine.js
// THE SIMULATION ENGINE. This is where virtual trading happens. It holds the
// portfolio (cash, positions, orders), fills orders, tracks P&L, estimates
// F&O margin, and persists everything to localStorage.
//
// It is deliberately self-contained and emits a 'change' event whenever the
// state updates, so the UI can re-render. It NEVER talks to a broker and NEVER
// places a real order — every rupee here is pretend.
//
// Money model (kept simple and transparent on purpose — see comments):
//   * Equity buy / long option buy  -> cash goes OUT (you pay the full price).
//   * Equity sell / option sell      -> cash comes IN.
//   * Futures                        -> no premium changes hands at entry;
//                                       only realised P&L moves cash on close.
//   * "Available funds" = cash - margin blocked by open futures / short options
//     / short equity. Margin is an ESTIMATE, clearly labelled, not broker-exact.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'paper-trade-india:v1';
// The personal paper account starts at ₹1,00,00,000 (1 crore), matching the ₹1-crore
// tournament bots — that lets the "Auto-Pilot" feature copy a bot's portfolio onto your own account at ~1:1
// scale (see ui/autopilot.js). NOTE: this is only the DEFAULT for a brand-new / reset
// account; an existing saved portfolio in localStorage keeps its own cash until Reset.
const DEFAULT_CASH = 10000000; // ₹1,00,00,000 (1 crore)

// --- Instrument helpers -----------------------------------------------------
// An instrument describes WHAT you are trading. A unique key identifies a
// position so repeated trades in the same contract net together.
//   kind: 'EQ' | 'FUT' | 'OPT'
function instrumentKey(inst) {
  if (inst.kind === 'EQ') return `EQ:${inst.symbol}`;
  if (inst.kind === 'FUT') return `FUT:${inst.symbol}:${inst.expiry}`;
  return `OPT:${inst.symbol}:${inst.expiry}:${inst.strike}:${inst.optType}`;
}

function instrumentLabel(inst) {
  if (inst.kind === 'EQ') return inst.symbol;
  if (inst.kind === 'FUT') return `${inst.symbol} FUT ${inst.expiry}`;
  return `${inst.symbol} ${inst.strike} ${inst.optType} ${inst.expiry}`;
}

// A simple unique id without external libraries.
let idCounter = 0;
function newId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

// A shared empty array used to skip the limit-fill order scan in onPriceUpdate when
// nothing is resting (avoids allocating a throwaway [] on every silent mark).
const NO_ORDERS = [];

// ---------------------------------------------------------------------------
class Engine {
  constructor() {
    this.listeners = new Set();
    // A derived index of state.orders: the ids of orders RESTING as PENDING (un-filled
    // LIMIT orders). Maintained on every status transition so the hot paths
    // (reservedForPending + onPriceUpdate's limit-fill scan) can skip the whole order
    // history in O(1) when nothing is resting — ALWAYS true in a backtest (every order is
    // a MARKET fill) and usually true live. Rebuilt whenever the order book is replaced
    // wholesale (load / import / reset). Not persisted (it's pure cache of state.orders).
    this._pending = new Set();
    this.state = this.freshState();
    this.load();
    this._rebuildPending();
  }

  // Recompute the resting-orders index from scratch. Cheap (one pass) and only called
  // when the whole order history is swapped in (construction, import, reset).
  _rebuildPending() {
    this._pending = new Set();
    // Guard `o &&` so a stray null/corrupt order entry (e.g. from an older buggy
    // save) can't throw here at construction/import and brick the whole app.
    for (const o of this.state.orders) if (o && o.status === 'PENDING') this._pending.add(o.id);
  }

  freshState() {
    return {
      initialCash: DEFAULT_CASH,
      cash: DEFAULT_CASH,
      realised: 0, // account-level realised P&L (survives closing a position)
      positions: {}, // key -> position
      orders: [], // newest first
      // Transparent, editable margin model parameters (percent of notional).
      settings: {
        futuresMarginPct: 12, // futures margin ≈ 12% of notional
        shortOptionSpanPct: 10, // short option SPAN-ish ≈ 10% of notional
        riskFreeRate: 6.5, // % — used by option tools
      },
      lastPrices: {}, // key -> last seen price (for P&L + limit fills)
      equityCurve: [], // [{ t, c }] intra-session account-value samples (capped)
      dayStart: null, // { date:'YYYY-MM-DD', equity } baseline for Day P&L
    };
  }

  // --- Pub/sub ------------------------------------------------------------
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    this.save();
    for (const fn of this.listeners) fn(this.state);
  }

  // --- Persistence --------------------------------------------------------
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        // Merge so new settings keys get defaults if loading an old save.
        this.state = {
          ...this.freshState(),
          ...saved,
          settings: { ...this.freshState().settings, ...(saved.settings || {}) },
        };
      }
    } catch (err) {
      console.warn('Could not load saved portfolio:', err);
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch (err) {
      console.warn('Could not save portfolio:', err);
    }
  }

  exportJson() {
    return JSON.stringify(this.state, null, 2);
  }

  importJson(text) {
    const parsed = JSON.parse(text); // throws SyntaxError on malformed JSON

    // JSON.parse happily returns null, numbers, strings or arrays. A portfolio
    // must be a plain object, or we'd crash spreading it / reading its fields.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Invalid portfolio file: expected a JSON object.');
    }

    // Merge over defaults so older exports missing a field still load, then
    // validate the RESULT so corrupted values can't propagate NaN into P&L.
    const merged = {
      ...this.freshState(),
      ...parsed,
      settings: { ...this.freshState().settings, ...(parsed.settings || {}) },
    };

    for (const field of ['cash', 'initialCash', 'realised']) {
      if (typeof merged[field] !== 'number' || !Number.isFinite(merged[field])) {
        throw new Error(`Invalid portfolio file: "${field}" must be a finite number.`);
      }
    }
    if (typeof merged.positions !== 'object' || merged.positions === null || Array.isArray(merged.positions)) {
      throw new Error('Invalid portfolio file: "positions" must be an object.');
    }
    if (!Array.isArray(merged.orders)) {
      throw new Error('Invalid portfolio file: "orders" must be an array.');
    }
    if (typeof merged.lastPrices !== 'object' || merged.lastPrices === null || Array.isArray(merged.lastPrices)) {
      throw new Error('Invalid portfolio file: "lastPrices" must be an object.');
    }
    // Each last price must be a finite POSITIVE number — a non-numeric value
    // would flow through unrealisedFor()/equity() as NaN and brick every render,
    // and a zero/negative one books a phantom unrealised loss until the next
    // live quote overwrites it. The engine itself only ever records prices > 0
    // (placeOrder/onPriceUpdate reject price <= 0), so mirror that gate here.
    for (const key of Object.keys(merged.lastPrices)) {
      const v = merged.lastPrices[key];
      if (typeof v !== 'number' || !Number.isFinite(v) || !(v > 0)) {
        throw new Error(`Invalid portfolio file: lastPrices["${key}"] must be a positive finite number.`);
      }
    }
    // The equity curve is render/bookkeeping state, but recordEquitySample writes
    // to its LAST entry (`last.c = ...`) — a non-object entry (e.g. a stray string)
    // would make that throw on EVERY poll cycle after the import committed:
    // frozen renders, alerts never firing. Validate entries BEFORE committing.
    if (!Array.isArray(merged.equityCurve)) {
      throw new Error('Invalid portfolio file: "equityCurve" must be an array.');
    }
    for (const pt of merged.equityCurve) {
      if (!pt || typeof pt !== 'object' || typeof pt.t !== 'number' || !Number.isFinite(pt.t) || typeof pt.c !== 'number' || !Number.isFinite(pt.c)) {
        throw new Error('Invalid portfolio file: an equity-curve entry is corrupted (needs finite t and c).');
      }
    }
    // The margin settings are used directly in arithmetic (estimateMargin); a
    // non-numeric one makes every derivative margin NaN, so the funds check would
    // pass and over-leverage could fill. Validate them too.
    for (const field of ['futuresMarginPct', 'shortOptionSpanPct', 'riskFreeRate']) {
      if (typeof merged.settings[field] !== 'number' || !Number.isFinite(merged.settings[field])) {
        throw new Error(`Invalid portfolio file: settings.${field} must be a finite number.`);
      }
    }
    // Each position needs finite numeric qty/avgPrice or P&L maths breaks.
    for (const key of Object.keys(merged.positions)) {
      const p = merged.positions[key];
      if (
        !p ||
        typeof p !== 'object' ||
        typeof p.qty !== 'number' ||
        !Number.isFinite(p.qty) ||
        typeof p.avgPrice !== 'number' ||
        !Number.isFinite(p.avgPrice)
      ) {
        throw new Error(`Invalid portfolio file: position "${key}" is corrupted.`);
      }
      // The instrument MUST be present and well-formed: equity()/holdingsValue()
      // and every render read p.instrument.kind (and instrumentKey reads its
      // fields). A position missing/with a bad instrument would commit here and
      // then throw on the next render, bricking the app until localStorage is
      // cleared — so reject it now, BEFORE committing.
      const inst = p.instrument;
      if (!inst || typeof inst !== 'object' || !['EQ', 'FUT', 'OPT'].includes(inst.kind) || typeof inst.symbol !== 'string' || !inst.symbol) {
        throw new Error(`Invalid portfolio file: position "${key}" has a missing/invalid instrument.`);
      }
      if ((inst.kind === 'FUT' || inst.kind === 'OPT') && (typeof inst.expiry !== 'string' || !inst.expiry)) {
        throw new Error(`Invalid portfolio file: position "${key}" is missing an expiry.`);
      }
      if (inst.kind === 'OPT' && (!(inst.strike > 0) || !['CE', 'PE'].includes(inst.optType))) {
        throw new Error(`Invalid portfolio file: position "${key}" has a bad option strike/type.`);
      }
    }
    // Each ORDER entry must be a plain object (a stray null would throw in
    // _rebuildPending below — AFTER the commit — silently replacing the live
    // portfolio while the caller sees "import failed"). And a resting PENDING
    // order is read by reservedForPending()/onPriceUpdate(): they call
    // instrumentKey(order.instrument) and estimateMargin(..., order.limitPrice),
    // so a PENDING order with a missing/bad instrument or a non-finite
    // limitPrice/qty would brick availableFunds() and every render — and PERSIST,
    // since the bad state is committed + saved — exactly like a bad position.
    // Validate here, BEFORE committing, mirroring the positions checks above.
    for (const o of merged.orders) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) {
        throw new Error('Invalid portfolio file: an order entry is not an object.');
      }
      if (o.status === 'PENDING') {
        const inst = o.instrument;
        if (!inst || typeof inst !== 'object' || !['EQ', 'FUT', 'OPT'].includes(inst.kind) || typeof inst.symbol !== 'string' || !inst.symbol) {
          throw new Error('Invalid portfolio file: a pending order has a missing/invalid instrument.');
        }
        if ((inst.kind === 'FUT' || inst.kind === 'OPT') && (typeof inst.expiry !== 'string' || !inst.expiry)) {
          throw new Error('Invalid portfolio file: a pending order is missing an expiry.');
        }
        if (inst.kind === 'OPT' && (!(inst.strike > 0) || !['CE', 'PE'].includes(inst.optType))) {
          throw new Error('Invalid portfolio file: a pending order has a bad option strike/type.');
        }
        if (typeof o.qty !== 'number' || !Number.isFinite(o.qty) || !(o.qty > 0)) {
          throw new Error('Invalid portfolio file: a pending order has a non-finite/non-positive qty.');
        }
        // Mirror placeOrder's own gate (it rejects refPrice <= 0): a NEGATIVE
        // limit price passes a bare finiteness check but makes reservedForPending
        // compute a NEGATIVE reservation — availableFunds() then EXCEEDS cash and
        // every later market order over-spends the account. It can also never
        // fill or self-correct (onPriceUpdate rejects price <= 0), so the
        // inflated figure would persist across reloads.
        if (typeof o.limitPrice !== 'number' || !Number.isFinite(o.limitPrice) || !(o.limitPrice > 0)) {
          throw new Error('Invalid portfolio file: a pending order has a non-positive/non-finite limit price.');
        }
        if (o.side !== 'BUY' && o.side !== 'SELL') {
          throw new Error('Invalid portfolio file: a pending order has an invalid side.');
        }
        // `lots` is recomputed into qty by modifyOrder (qty = lots * lotSize) —
        // a missing/bad lots would turn a simple price-only Modify into a NaN
        // qty that poisons cash the moment the order fills. placeOrder always
        // writes lots >= 1, so a well-formed export always passes this.
        if (typeof o.lots !== 'number' || !Number.isFinite(o.lots) || !(o.lots >= 1)) {
          throw new Error('Invalid portfolio file: a pending order has a missing/invalid lots count.');
        }
      }
    }

    // Only commit once everything checks out, so a bad import leaves the
    // current portfolio untouched.
    this.state = merged;
    this._rebuildPending(); // the imported order book may carry resting PENDING limits
    this.emit();
  }

  reset(cash = DEFAULT_CASH) {
    this.state = this.freshState();
    this.state.initialCash = cash;
    this.state.cash = cash;
    this._rebuildPending(); // fresh state -> no resting orders
    this.emit();
  }

  setCash(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) return;
    // Treat a cash edit as a deposit/withdrawal: shift the return BASELINE by the
    // same delta, so adding or removing virtual cash is never counted as
    // profit/loss. Total Return = equity - initialCash; setting initialCash = n
    // outright (the old behaviour) reset the baseline mid-stream while a position
    // was open, reporting the holdings' market value as "return". To start over
    // with a fresh baseline instead, use reset().
    const delta = n - this.state.cash;
    this.state.cash = n;
    this.state.initialCash += delta;
    // Keep Day P&L deposit/withdrawal-neutral too: shift today's baseline by the
    // same delta so injected/removed cash isn't counted as the day's profit.
    if (this.state.dayStart && typeof this.state.dayStart.equity === 'number') {
      this.state.dayStart.equity += delta;
    }
    this.emit();
  }

  updateSettings(patch) {
    this.state.settings = { ...this.state.settings, ...patch };
    this.emit();
  }

  // --- Money / margin -----------------------------------------------------
  // Notional value of a position = quantity (units) * a reference price.
  notional(inst, qty, price) {
    // For options we size notional off the underlying when known, else strike.
    if (inst.kind === 'OPT') {
      const ref = inst.underlyingPrice || inst.strike || price;
      return qty * ref;
    }
    return qty * price;
  }

  // ESTIMATED margin to OPEN a position. Returns { margin, breakdown }.
  estimateMargin(inst, side, qty, price) {
    const s = this.state.settings;
    if (inst.kind === 'EQ') {
      if (side === 'BUY') {
        return { margin: qty * price, breakdown: `Full cash: ${qty} x ${price}` };
      }
      // Short equity: block the full notional as a simple proxy.
      return { margin: qty * price, breakdown: `Short proxy: notional ${qty} x ${price}` };
    }
    if (inst.kind === 'FUT') {
      const m = (this.notional(inst, qty, price) * s.futuresMarginPct) / 100;
      return { margin: m, breakdown: `Futures: notional x ${s.futuresMarginPct}% (ESTIMATE)` };
    }
    // Options
    if (side === 'BUY') {
      return { margin: qty * price, breakdown: `Long option: premium ${qty} x ${price}` };
    }
    const span = (this.notional(inst, qty, price) * s.shortOptionSpanPct) / 100;
    const premium = qty * price;
    return {
      margin: premium + span,
      breakdown: `Short option: premium ${Math.round(premium)} + notional x ${s.shortOptionSpanPct}% (ESTIMATE)`,
    };
  }

  // Sum of margin currently blocked by open derivative / short positions.
  blockedMargin() {
    let total = 0;
    for (const key in this.state.positions) {
      const p = this.state.positions[key];
      if (p.qty === 0) continue;
      const isShort = p.qty < 0;
      const price = this.state.lastPrices[key] || p.avgPrice;
      const qty = Math.abs(p.qty);
      if (p.instrument.kind === 'FUT') {
        total += this.estimateMargin(p.instrument, 'BUY', qty, price).margin;
      } else if (p.instrument.kind === 'OPT' && isShort) {
        total += this.estimateMargin(p.instrument, 'SELL', qty, price).margin;
      } else if (p.instrument.kind === 'EQ' && isShort) {
        total += qty * price;
      }
    }
    return total;
  }

  // Funds set aside for PENDING limit orders, so a resting limit cannot be
  // spent twice and a market order can't eat into money already promised to a
  // pending one. We reserve only the NEW-exposure portion of each pending order,
  // priced at its limit price (the price it will fill at).
  //
  // The orders are THREADED through a simulated copy of each position (seeded
  // from the live position), so the closing capacity of an existing position is
  // credited only ONCE across all resting orders on the same contract. Judging
  // each order independently against the live position (the old behaviour) let
  // two opposing limits on one instrument each think they merely close it, so
  // the new exposure the later fill actually opens went unreserved.
  //
  // `excludeId` lets the fill path measure funds while ignoring the order filling
  // right now (its reservation is about to be released). `extra` lets placeOrder
  // test a hypothetical new LIMIT order before committing it.
  reservedForPending(excludeId = null, extra = null) {
    // Fast path: nothing is resting, so the loop below would sum to exactly 0. Scanning
    // the (in a backtest, thousands-long) order history to discover that is pure waste —
    // and availableFunds() calls this per name in the basket buy loop. (When `extra` is
    // passed we must still run, since the hypothetical order is the only "pending" one.)
    if (this._pending.size === 0 && !extra) return 0;
    const running = {}; // instrument key -> simulated signed qty
    for (const k in this.state.positions) running[k] = this.state.positions[k].qty;

    // Oldest-first (orders are stored newest-first) for a stable ordering.
    const pending = this.state.orders.filter((o) => o.status === 'PENDING' && o.id !== excludeId).reverse();
    if (extra) pending.push(extra);

    let total = 0;
    for (const order of pending) {
      const key = instrumentKey(order.instrument);
      const existing = running[key] || 0;
      const signed = order.side === 'BUY' ? order.qty : -order.qty;
      // New exposure = the part of this order beyond closing the (simulated)
      // opposite position.
      let newQty;
      if (existing === 0 || Math.sign(signed) === Math.sign(existing)) {
        newQty = order.qty;
      } else {
        newQty = order.qty - Math.min(order.qty, Math.abs(existing));
      }
      if (newQty > 0) {
        total += this.estimateMargin(order.instrument, order.side, newQty, order.limitPrice).margin;
      }
      running[key] = existing + signed;
    }
    return total;
  }

  availableFunds() {
    return this.state.cash - this.blockedMargin() - this.reservedForPending();
  }

  // --- P&L ----------------------------------------------------------------
  unrealisedFor(key) {
    const p = this.state.positions[key];
    if (!p || p.qty === 0) return 0;
    const last = this.state.lastPrices[key];
    if (last == null) return 0;
    // Signed qty makes this work for both long and short automatically:
    // a short position has negative qty, so a falling price yields a profit.
    return (last - p.avgPrice) * p.qty;
  }

  realisedTotal() {
    // Account-level accumulator (includes P&L from positions already closed).
    return this.state.realised || 0;
  }

  unrealisedTotal() {
    let u = 0;
    for (const key in this.state.positions) u += this.unrealisedFor(key);
    return u;
  }

  // Total account value = cash + the market value of what you are holding.
  //
  // The key subtlety: for EQUITY and OPTIONS the cash balance ALREADY moved by
  // the full price when you bought/sold, so the position is worth its current
  // market value, last * qty (signed). Adding only unrealised P&L would
  // double-count the principal — a stock buy would instantly drop your account
  // value by the purchase price, and a short would inflate it.
  //
  // For FUTURES no premium changes hands at entry, so the cash is untouched and
  // the position contributes only its mark-to-market P&L, (last - avg) * qty.
  holdingsValue() {
    let total = 0;
    for (const key in this.state.positions) {
      const p = this.state.positions[key];
      if (p.qty === 0) continue;
      // Fall back to the average price when we have no live price yet, so a
      // freshly opened position is valued neutrally (no spurious P&L).
      const last = this.state.lastPrices[key] != null ? this.state.lastPrices[key] : p.avgPrice;
      if (p.instrument.kind === 'FUT') {
        total += (last - p.avgPrice) * p.qty; // mark-to-market only
      } else {
        total += last * p.qty; // EQ / OPT signed market value
      }
    }
    return total;
  }

  equity() {
    return this.state.cash + this.holdingsValue();
  }

  // P&L since the start of the current IST trading day (equity now minus the
  // first equity recorded today). Returns 0 until a baseline exists.
  dayPnl() {
    const d = this.state.dayStart;
    return d && typeof d.equity === 'number' ? this.equity() - d.equity : 0;
  }

  // Record one point on the intra-session equity curve and keep the start-of-day
  // baseline fresh. Pure bookkeeping (no cash changes). Throttled to one point
  // per ~30s (the latest point is updated in between) and capped, so the curve
  // spans a useful window without growing localStorage without bound. Emits so
  // the dashboard redraws. Called by the polling loop.
  recordEquitySample(nowMs = Date.now()) {
    const eq = this.equity();
    // Start-of-day baseline, by IST calendar day (UTC date of the +5:30 shift).
    const istDate = new Date(nowMs + 5.5 * 3600000).toISOString().slice(0, 10);
    if (!this.state.dayStart || this.state.dayStart.date !== istDate) {
      this.state.dayStart = { date: istDate, equity: eq };
    }
    if (!Array.isArray(this.state.equityCurve)) this.state.equityCurve = [];
    const curve = this.state.equityCurve;
    const last = curve[curve.length - 1];
    if (!last || nowMs - last.t >= 30000) {
      curve.push({ t: nowMs, c: +eq.toFixed(2) });
      if (curve.length > 500) {
        // COMPACT the curve, never FIFO-shift it. shift() drops the OLDEST point
        // on every new sample once the cap is hit, so a seeded multi-year track
        // record ("Reflect this in my account" writes ~120 points spanning ~16
        // years) would be entirely erased within a few hours of ordinary 30s
        // sampling. Instead thin the OLDER HALF to every 2nd point: the full
        // time SPAN survives at progressively coarser resolution (the same idea
        // as the tournament's downsampled curves), memory stays bounded, and the
        // compaction runs rarely (the length drops well below the cap each time).
        const half = Math.floor(curve.length / 2);
        const thinned = [];
        for (let i = 0; i < half; i += 2) thinned.push(curve[i]);
        this.state.equityCurve = thinned.concat(curve.slice(half));
      }
    } else {
      last.c = +eq.toFixed(2); // refresh the latest point between throttle windows
    }
    this.emit();
  }

  // --- Orders -------------------------------------------------------------
  // order request: { instrument, side, orderType:'MARKET'|'LIMIT',
  //                  lots, price (current LTP for MARKET), limitPrice }
  placeOrder(req) {
    const inst = req.instrument;
    const lotSize = inst.lotSize || 1;
    const lots = Math.max(1, Math.floor(req.lots || 1));
    const qty = lots * lotSize; // convert lots -> units internally

    const order = {
      id: newId('ord'),
      ts: Date.now(),
      instrument: inst,
      label: instrumentLabel(inst),
      side: req.side,
      orderType: req.orderType,
      lots,
      qty,
      limitPrice: req.orderType === 'LIMIT' ? Number(req.limitPrice) : null,
      status: 'PENDING',
      reason: null,
      fillPrice: null,
      fillTs: null,
      // Optional bracket exits: when this order fills, the resulting position is
      // closed automatically if price later hits the stop-loss or the target.
      stopLoss: req.stopLoss != null && Number(req.stopLoss) > 0 ? Number(req.stopLoss) : null,
      target: req.target != null && Number(req.target) > 0 ? Number(req.target) : null,
    };

    // Validate inputs.
    const refPrice = req.orderType === 'MARKET' ? Number(req.price) : Number(req.limitPrice);
    if (!Number.isFinite(refPrice) || refPrice <= 0) {
      order.status = 'REJECTED';
      order.reason = 'No valid price available for this instrument.';
      this.state.orders.unshift(order);
      this.emit();
      return order;
    }

    // Funds / margin check. Closing/reducing an opposite position frees funds,
    // so we only fund the portion of the order that opens NEW exposure.
    if (req.orderType === 'LIMIT') {
      // A resting LIMIT fills LATER, after/with the other pending orders on this
      // instrument, so reserve against the position as it would be once they all
      // apply. The TOTAL reserved (existing pendings + this new one) must fit
      // within cash minus the margin already blocked by OPEN positions.
      const reservedWithNew = this.reservedForPending(null, order);
      const ceiling = this.state.cash - this.blockedMargin();
      if (reservedWithNew > ceiling + 1e-6) {
        const { breakdown } = this.estimateMargin(inst, req.side, qty, refPrice);
        order.status = 'REJECTED';
        order.reason =
          `Insufficient funds. Pending orders would reserve ~₹${Math.round(reservedWithNew).toLocaleString('en-IN')} ` +
          `(${breakdown}); available ₹${Math.round(ceiling).toLocaleString('en-IN')}.`;
        this.state.orders.unshift(order);
        this.emit();
        return order;
      }
    } else {
      // MARKET: fills immediately against the live position.
      const newExposureQty = this.exposureIncreaseQty(inst, req.side, qty);
      if (newExposureQty > 0) {
        const { margin, breakdown } = this.estimateMargin(inst, req.side, newExposureQty, refPrice);
        const available = this.availableFunds();
        if (margin > available + 1e-6) {
          order.status = 'REJECTED';
          order.reason =
            `Insufficient funds. Needs ~₹${Math.round(margin).toLocaleString('en-IN')} ` +
            `(${breakdown}); available ₹${Math.round(available).toLocaleString('en-IN')}.`;
          this.state.orders.unshift(order);
          this.emit();
          return order;
        }
      }
    }

    if (req.orderType === 'MARKET') {
      this.fillOrder(order, refPrice);
    }
    // LIMIT orders stay PENDING and fill later via onPriceUpdate(). Their funds
    // are reserved meanwhile (see reservedForPending) and re-checked at fill.

    this.state.orders.unshift(order);
    if (order.status === 'PENDING') this._pending.add(order.id); // a resting LIMIT order — index it
    this.emit();
    return order;
  }

  // How many units of an order OPEN NEW exposure (as opposed to closing an
  // existing opposite position)? This matters when an order flips a position
  // through zero, e.g. long 100 then SELL 150: the first 100 just close the
  // long (free), and only the remaining 50 open a brand-new short that must be
  // funded/margined. Returns a non-negative unit count.
  exposureIncreaseQty(inst, side, qty) {
    const key = instrumentKey(inst);
    const pos = this.state.positions[key];
    const existing = pos ? pos.qty : 0;
    const signed = side === 'BUY' ? qty : -qty;
    // Same sign as existing (or starting flat) => the whole order is new.
    if (existing === 0 || Math.sign(signed) === Math.sign(existing)) return qty;
    // Opposite sign => we first close min(qty, |existing|); anything beyond
    // that flips into a new position and is new exposure.
    const closing = Math.min(qty, Math.abs(existing));
    return qty - closing;
  }

  cancelOrder(id) {
    const order = this.state.orders.find((o) => o.id === id);
    if (order && order.status === 'PENDING') {
      order.status = 'CANCELLED';
      this._pending.delete(order.id);
      order.reason = 'Cancelled by user.';
      this.emit();
    }
  }

  // Modify a resting LIMIT order's price and/or lots, re-checking funds. If the
  // change can't be funded it is rejected (the original order is left intact).
  modifyOrder(id, changes = {}) {
    const order = this.state.orders.find((o) => o.id === id);
    if (!order || order.status !== 'PENDING') return null;
    const lotSize = order.instrument.lotSize || 1;
    const newLimit = changes.limitPrice != null ? Number(changes.limitPrice) : order.limitPrice;
    const newLots = changes.lots != null ? Math.max(1, Math.floor(changes.lots)) : order.lots;
    if (!Number.isFinite(newLimit) || newLimit <= 0) return order; // ignore an invalid price
    // Guard the lots side the same way: qty is recomputed as newLots * lotSize
    // below, so a non-finite lots (a NaN from bad input, or an imported order
    // that carried none) would write qty = NaN onto the order — and a NaN qty
    // poisons cash/equity the moment the order fills. Keep the original intact.
    if (!Number.isFinite(newLots) || newLots < 1) return order;
    // Funds re-check: every OTHER pending order + this modified candidate must
    // still fit within cash minus margin blocked by open positions.
    const candidate = { ...order, limitPrice: newLimit, lots: newLots, qty: newLots * lotSize };
    const reserved = this.reservedForPending(order.id, candidate);
    if (reserved > this.state.cash - this.blockedMargin() + 1e-6) return order; // reject; keep original
    order.limitPrice = newLimit;
    order.lots = newLots;
    order.qty = newLots * lotSize;
    this.emit();
    return order;
  }

  // Set or clear the bracket exits (stop-loss / target) on an OPEN position.
  // Pass null/0 to clear a side.
  setExits(key, { stopLoss = null, target = null } = {}) {
    const pos = this.state.positions[key];
    if (!pos || pos.qty === 0) return;
    pos.stopLoss = stopLoss != null && Number(stopLoss) > 0 ? Number(stopLoss) : null;
    pos.target = target != null && Number(target) > 0 ? Number(target) : null;
    this.emit();
  }

  // Close the whole position at `key` with an offsetting MARKET fill at `price`,
  // tagged with a human reason (used by bracket exits and square-off). Records a
  // FILLED order in the history. Does not emit (callers emit).
  closePositionAtMarket(key, price, reason) {
    const pos = this.state.positions[key];
    if (!pos || pos.qty === 0) return null;
    const inst = pos.instrument;
    const order = {
      id: newId('ord'),
      ts: Date.now(),
      instrument: inst,
      label: instrumentLabel(inst),
      side: pos.qty > 0 ? 'SELL' : 'BUY',
      orderType: 'MARKET',
      lots: Math.abs(pos.qty),
      qty: Math.abs(pos.qty), // exact remaining quantity (lotSize-agnostic close)
      limitPrice: null,
      status: 'PENDING',
      reason: null,
      fillPrice: null,
      fillTs: null,
      stopLoss: null,
      target: null,
    };
    this.fillOrder(order, price); // closes the position (removing it + its exits)
    order.reason = reason;
    this.state.orders.unshift(order);
    return order;
  }

  // Square off every open position with offsetting market orders (one emit).
  closeAll() {
    for (const key of Object.keys(this.state.positions)) {
      const pos = this.state.positions[key];
      if (!pos || pos.qty === 0) continue;
      const last = this.state.lastPrices[key] || pos.avgPrice;
      this.closePositionAtMarket(key, last, 'Squared off');
    }
    this.emit();
  }

  // Execute a fill at a given price: update cash, position, realised P&L.
  fillOrder(order, fillPrice) {
    const inst = order.instrument;
    const key = instrumentKey(inst);
    const pos =
      this.state.positions[key] ||
      (this.state.positions[key] = {
        key,
        instrument: inst,
        qty: 0,
        avgPrice: 0,
        realised: 0,
      });

    const signed = order.side === 'BUY' ? order.qty : -order.qty;
    const prevQty = pos.qty; // to mark whether this fill CLOSED/reduced a position
    const realisedInc = this.applyFill(pos, signed, fillPrice);

    // Track realised P&L at the account level so it survives even after the
    // position is fully closed and removed below.
    this.state.realised = (this.state.realised || 0) + realisedInc;

    // Cash movement.
    if (inst.kind === 'FUT') {
      // Futures: no premium at entry; realised P&L moves cash on close.
      this.state.cash += realisedInc;
    } else {
      // Equity / options: pay on buy, receive on sell.
      this.state.cash += (order.side === 'SELL' ? 1 : -1) * order.qty * fillPrice;
    }

    this.state.lastPrices[key] = fillPrice;
    order.status = 'FILLED';
    this._pending.delete(order.id); // no-op for a MARKET fill (never indexed); clears a resting LIMIT
    order.fillPrice = fillPrice;
    order.fillTs = Date.now();
    order.realised = realisedInc; // P&L this fill locked in (0 when opening/adding) — shown in the trade log
    // Did this fill close/reduce a position? (Lets the trade log show a realised
    // value even for a break-even close, where realisedInc is exactly 0.)
    order.closing = prevQty !== 0 && Math.sign(signed) !== Math.sign(prevQty);
    // Attach any bracket exits carried by the order to the (still-open) position.
    if (pos.qty !== 0) {
      if (order.stopLoss != null) pos.stopLoss = order.stopLoss;
      if (order.target != null) pos.target = order.target;
    }
    if (pos.qty === 0) delete this.state.positions[key]; // fully closed -> tidy up
  }

  // Update a position with a signed quantity at a price. Returns realised P&L
  // locked in by this fill (used for futures cash handling).
  applyFill(pos, signedQty, price) {
    let realisedInc = 0;
    if (pos.qty === 0) {
      pos.qty = signedQty;
      pos.avgPrice = price;
      return 0;
    }
    const sameDirection = Math.sign(signedQty) === Math.sign(pos.qty);
    if (sameDirection) {
      // Adding to the position: recompute the weighted average price.
      const totalQty = Math.abs(pos.qty) + Math.abs(signedQty);
      pos.avgPrice = (pos.avgPrice * Math.abs(pos.qty) + price * Math.abs(signedQty)) / totalQty;
      pos.qty += signedQty;
      return 0;
    }
    // Opposite direction: close some/all, realising P&L on the closed part.
    const closeQty = Math.min(Math.abs(signedQty), Math.abs(pos.qty));
    const wasLong = pos.qty > 0;
    realisedInc = wasLong ? closeQty * (price - pos.avgPrice) : closeQty * (pos.avgPrice - price);
    pos.realised = (pos.realised || 0) + realisedInc;

    const remaining = pos.qty + signedQty; // net after this fill
    if (remaining === 0) {
      pos.qty = 0;
      // avgPrice stays for record but position will be removed by caller.
    } else if (Math.sign(remaining) === Math.sign(pos.qty)) {
      // Reduced but not closed: avg price unchanged.
      pos.qty = remaining;
    } else {
      // Flipped through zero: the leftover opens a NEW position at this price.
      // Clear any bracket exits — they were oriented for the OLD direction and
      // would otherwise fire immediately (wrongly) against the new opposite
      // position (a long's stop-below/target-above reads as already breached for
      // the new short).
      pos.qty = remaining;
      pos.avgPrice = price;
      pos.stopLoss = null;
      pos.target = null;
    }
    return realisedInc;
  }

  // --- Live price updates -------------------------------------------------
  // Called by the UI on every poll with the latest price for an instrument
  // key. Updates P&L and fills any PENDING limit orders that the price crosses.
  // `silent` lets a batch of updates (one polling cycle) skip per-call emits; the
  // caller emits once at the end, avoiding a render storm of one full re-render
  // per polled symbol.
  onPriceUpdate(key, price, silent = false) {
    if (!Number.isFinite(price) || price <= 0) return;
    this.state.lastPrices[key] = price;

    let changed = false;
    // Only scan the order book for limit fills when something is actually resting (see
    // _pending). In a backtest nothing ever rests (all MARKET fills), so this skips a
    // per-mark walk of a thousands-long order history; live, it skips the scan on the
    // common tick with no open orders. Bracket exits below still run regardless.
    for (const order of (this._pending.size ? this.state.orders : NO_ORDERS)) {
      if (order.status !== 'PENDING') continue;
      if (instrumentKey(order.instrument) !== key) continue;
      const crosses =
        order.side === 'BUY' ? price <= order.limitPrice : price >= order.limitPrice;
      if (crosses) {
        // Re-check funds at fill time: cash may have dropped since the order
        // was placed. Measure availability excluding THIS order's own
        // reservation (it is about to be released as the order fills).
        const newQty = this.exposureIncreaseQty(order.instrument, order.side, order.qty);
        if (newQty > 0) {
          const { margin, breakdown } = this.estimateMargin(
            order.instrument,
            order.side,
            newQty,
            order.limitPrice
          );
          const available = this.state.cash - this.blockedMargin() - this.reservedForPending(order.id);
          if (margin > available + 1e-6) {
            order.status = 'REJECTED';
            this._pending.delete(order.id);
            order.reason =
              `Insufficient funds at fill. Needs ~₹${Math.round(margin).toLocaleString('en-IN')} ` +
              `(${breakdown}); available ₹${Math.round(available).toLocaleString('en-IN')}.`;
            changed = true;
            continue;
          }
        }
        // Fill at the limit price OR BETTER, never worse: if the market has
        // moved past the limit (a gap), the trader gets the better price.
        // BUY never pays above its limit; SELL never sells below it.
        const fillPrice =
          order.side === 'BUY' ? Math.min(order.limitPrice, price) : Math.max(order.limitPrice, price);
        this.fillOrder(order, fillPrice);
        changed = true;
      }
    }

    // Bracket exits attached to the position at this key: close it at market when
    // price hits the stop-loss or the target. Stop is checked first so a wide
    // gap that crosses both resolves to the (worse) stop.
    const bracketPos = this.state.positions[key];
    if (bracketPos && bracketPos.qty !== 0) {
      const long = bracketPos.qty > 0;
      const hitStop =
        Number.isFinite(bracketPos.stopLoss) && (long ? price <= bracketPos.stopLoss : price >= bracketPos.stopLoss);
      const hitTarget =
        Number.isFinite(bracketPos.target) && (long ? price >= bracketPos.target : price <= bracketPos.target);
      if (hitStop || hitTarget) {
        this.closePositionAtMarket(key, price, hitStop ? 'Stop-loss hit' : 'Target hit');
        changed = true;
      }
    }

    if (!silent) this.emit(); // P&L numbers move even if no fill happened
    return changed;
  }

  // Convenience used by the UI to feed a symbol's equity price to its EQ key.
  updateEquityPrice(symbol, price, silent = false) {
    this.onPriceUpdate(`EQ:${symbol.toUpperCase()}`, price, silent);
  }
}

export { Engine, instrumentKey, instrumentLabel, DEFAULT_CASH };
