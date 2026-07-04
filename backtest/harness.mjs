// ---------------------------------------------------------------------------
// backtest/harness.mjs
// Lets the BROWSER simulation engine run under Node for backtesting. The engine
// persists to localStorage (which Node lacks), so we install an in-memory stub
// BEFORE importing it, then expose a helper that builds a fresh engine per run.
//
// Reusing the real engine means a backtest obeys the EXACT same money math as
// live paper trading (the MASTER invariant) — not a separate, drift-prone ledger.
// ---------------------------------------------------------------------------

// In-memory localStorage stub: no disk, no persistence between runs.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

// Import the engine AFTER the stub exists (defensive — the engine only touches
// localStorage when constructed, but this keeps the ordering unambiguous).
const { Engine } = await import('../public/js/core/engine.js');

// A fresh, empty portfolio with `cash` starting capital.
function freshEngine(cash = 1_000_000) {
  store.clear();
  const e = new Engine(); // loads from the (now empty) stub -> default state
  e.reset(cash); // initialCash = cash, no positions, clean baseline
  // PERF: a backtest never reads its portfolio back from localStorage — it reads the
  // engine's in-memory state directly (equity(), realisedTotal(), positions…). But the
  // engine's save() runs JSON.stringify(this.state) on EVERY fill (emit -> save), which
  // over a long backtest's thousands of orders is O(orders²) — the single biggest cost
  // in a 20-year basket run. Neutralise it here: this is a HARNESS-only change (the live
  // app's save/persist is untouched), so the money math is byte-identical, just faster.
  e.save = () => {};
  return e;
}

// Charge a NON-TRADE fee (F&O brokerage, SLB borrow on a short, expiry STT) to a
// backtest engine. Debits cash directly — so the fee genuinely shows up in equity,
// returns, Sharpe and drawdown — and accrues it on a ledger the backtesters report.
// This deliberately does NOT touch `realised` (fees are not trading P&L) and does
// NOT touch `initialCash` (that would hide the fee from the return calculation).
// The MASTER money invariant therefore EXTENDS for fee-charged runs:
//     realisedTotal + unrealisedTotal − feesCharged == equity − initialCash
// (For a run that never calls chargeFee, feesCharged is 0 and the classic
// invariant holds unchanged.) HARNESS-only: the live browser engine has no fees.
function chargeFee(engine, amount) {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0;
  engine.state.cash -= amount;
  engine._feesCharged = (engine._feesCharged || 0) + amount;
  return amount;
}

// Total fees charged to this engine via chargeFee (0 when none were).
function feesCharged(engine) {
  return engine._feesCharged || 0;
}

// Snapshot the engine's OPEN positions as plain, serialisable data. Used by the live
// tournament so the "Auto-Pilot" can COPY a bot's current portfolio onto the personal
// paper account: each entry carries the FULL instrument spec (so even an F&O option
// leg can be reproduced exactly), the SIGNED unit quantity the bot holds (positive =
// long, negative = short), and the latest mark price to fill at — an indicative
// Black-Scholes model price for options, since there is no free live option feed. Pure
// read of engine state; never mutates. An empty array means the bot is fully in cash.
function snapshotPositions(engine) {
  const out = [];
  for (const k in engine.state.positions) {
    const p = engine.state.positions[k];
    if (!p || p.qty === 0) continue;
    const inst = p.instrument;
    const last = engine.state.lastPrices[k];
    const price = last != null && Number.isFinite(last) ? last : p.avgPrice;
    out.push({
      key: k,
      kind: inst.kind,
      symbol: inst.symbol,
      expiry: inst.expiry || null,
      strike: inst.strike != null ? inst.strike : null,
      optType: inst.optType || null,
      lotSize: inst.lotSize || 1,
      qty: p.qty, // signed units the bot currently holds
      avgPrice: +(+p.avgPrice).toFixed(2),
      price: +(+price).toFixed(2), // latest mark (indicative model price for options)
      underlyingPrice: inst.underlyingPrice != null ? inst.underlyingPrice : null,
      // For OPT legs: the expiry timestamp + the IV used, so a copied leg can be RE-MARKED
      // client-side from the live underlying (a modelled cyc{i} expiry has no real chain feed).
      expiryMs: inst.expiryMs != null ? inst.expiryMs : null,
      iv: inst.iv != null ? inst.iv : null,
    });
  }
  return out;
}

export { freshEngine, snapshotPositions, chargeFee, feesCharged };
