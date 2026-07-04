// ---------------------------------------------------------------------------
// backtest/fno.mjs
// Backtests periodic INDEX-OPTION strategies (the classic "crazy" F&O: selling
// premium — straddles, strangles, iron condors). It runs MONTHLY cycles:
//   * On entry, the strategy returns option legs (relative to spot); we open them
//     in the REAL engine at Black-Scholes-MODELLED prices (see options-model.mjs).
//   * Each bar we mark every leg to model price (spot moves + time decays + vol).
//   * At expiry we settle at intrinsic, realise the P&L (which frees margin), and
//     roll into the next cycle.
//
// Because it runs through the real engine, the account obeys the same money +
// margin rules as live paper trading: an over-leveraged cycle that can't be
// funded simply doesn't open (the book sits flat that month).
// ---------------------------------------------------------------------------

import { freshEngine, snapshotPositions, chargeFee, feesCharged } from './harness.mjs';
import { instrumentKey } from '../public/js/core/engine.js';
import { summarize } from './metrics.mjs';
import { modelIV, priceOptionAt } from './options-model.mjs';
import { optFillPrice } from './costs.mjs';

const HOLD_BARS = 21; // ~1 trading month per cycle (monthly options)

const roundStrike = (x, step) => Math.round(x / step) * step;

// COSTS: pass `costModel` (backtest/costs.mjs indexOptionCosts()) for honest results —
// each traded leg then crosses half a bid-ask spread off the Black-Scholes MID, pays the
// proportional charges (STT on sell premium, exchange txn charge, stamp) baked into its
// fill price, plus flat brokerage per order and STT on an exercised ITM long at expiry
// (both charged via harness.chargeFee). Without it legs fill AT the model mid for free —
// the legacy behaviour, kept for the hand-computed engine tests (which pass null
// explicitly). The honest surfaces (tournament, CLIs) always pass the real model.
//
// `volPremium` is THE modelling assumption the seller edge rests on (options priced at
// realized vol × this). Exposed so a sensitivity run can show results at 1.0/1.1/1.2
// instead of asserting one number — see backtest/fno-sensitivity.mjs.
function runFnoBacktest({ strategy, candles, symbol = 'NIFTY', cash = 1_000_000, lotSize = 75, strikeStep = 50, keepOpen = false, recordTrades = false, costModel = null, volPremium = 1.2 }) {
  const closes = candles.map((c) => c.c);
  const times = candles.map((c) => c.t);
  const n = closes.length;
  // Average bar spacing (ms) — used to extrapolate the NATURAL expiry timestamp of the final,
  // still-running cycle, which can fall BEYOND the fetched data. With it we mark that open
  // cycle to its real remaining time value instead of force-settling it at the boundary.
  // NOTE: this is GLOBAL by design (it reads the last bar's timestamp) and is used ONLY to
  // scope the FINAL open cycle's extrapolated expiry — so that one cycle's intermediate marks
  // are cadence-dependent on the latest bar. Completed (within-data) cycles are unaffected, and
  // no PRICE is ever read ahead (only the bar cadence), so it stays look-ahead-safe.
  const avgBarMs = n >= 2 ? Math.max(1, (times[n - 1] - times[0]) / (n - 1)) : 864e5;
  const engine = freshEngine(cash);
  // Scale lot counts to capital so option-selling stays a meaningful fraction of
  // a big account (₹1cr -> ~10x a ₹10L book). At the ₹10L base, scale = 1, so
  // existing backtests are unchanged. The engine's funds check still caps it.
  const lotScale = Math.max(1, Math.round(cash / 1_000_000));
  const equityCurve = [];
  let cycle = null; // { legs: [{ inst, key }], entryIndex, naturalExpiryIndex, expiryTime }
  let trades = 0;
  // Optional per-trade log (for the bot-history UI): each leg open/close, with the
  // bar timestamp, a readable leg label, side, lots, modelled price and realised P&L.
  const tradeLog = recordTrades ? [] : null;
  const legLabel = (inst) => `${symbol} ${inst.strike}${inst.optType}`;
  const logTrade = (t, inst, side, lots, price, realisedBefore, reason) => {
    if (!tradeLog) return;
    tradeLog.push({ t, symbol: legLabel(inst), side, qty: lots, price: +price.toFixed(2), value: Math.round(lots * inst.lotSize * price), realised: +(engine.realisedTotal() - realisedBefore).toFixed(2), reason: reason || '' });
  };

  // Mark every open leg to its current model price (keeps equity live).
  const markCycle = (i, iv) => {
    if (!cycle) return;
    const spot = closes[i];
    // Days to the cycle's NATURAL expiry (entry + HOLD_BARS), by timestamp. For the final,
    // still-running cycle that expiry can lie BEYOND the data, so it's extrapolated (see
    // cycle.expiryTime) — keeping the open legs marked at their full model price (intrinsic +
    // remaining time value) right up to the last bar, instead of collapsing to intrinsic.
    // daysLeft is 0 only when the cycle has TRULY reached expiry.
    const daysLeft = Math.max(0, (cycle.expiryTime - times[i]) / 864e5);
    for (const leg of cycle.legs) {
      const price = priceOptionAt(leg.inst.optType, spot, leg.inst.strike, daysLeft, iv);
      leg.inst.iv = iv; // keep the leg's IV current so a copied leg re-marks at the latest vol
      engine.onPriceUpdate(leg.key, Math.max(price, 0.05), true); // engine rejects <= 0
    }
  };

  // Close every leg of the cycle (realises P&L, frees margin) at its CURRENT marked price.
  const closeCycle = (i, iv) => {
    if (!cycle) return;
    const spot = closes[i];
    // Is this a TRUE expiry (daysLeft 0, settles at intrinsic) or an EARLY mark-to-market settle
    // (the keepOpen:false final stub cycle, whose natural expiry lies beyond the data)? Word the
    // trade-history reason honestly — an early settle closes at the model MARK (time value intact),
    // not "intrinsic". Same for all legs of a cycle, so compute it once.
    const daysLeft = Math.max(0, (cycle.expiryTime - times[i]) / 864e5);
    const isExpiry = daysLeft <= 0;
    for (const leg of cycle.legs) {
      const pos = engine.state.positions[leg.key];
      if (!pos || pos.qty === 0) continue;
      const wasLong = pos.qty > 0;
      const units = Math.abs(pos.qty);
      const intrinsic = priceOptionAt(leg.inst.optType, spot, leg.inst.strike, 0, iv);
      const lots = units / leg.inst.lotSize;
      const side = pos.qty < 0 ? 'BUY' : 'SELL'; // offset to flat
      // Close at the leg's CURRENT marked price, NOT a forced intrinsic. At a TRUE expiry
      // markCycle already set this mark to intrinsic (daysLeft 0), so completed cycles stay
      // byte-identical. For an EARLY settle (the keepOpen:false final cycle, beyond its data)
      // this realises the honest mark-to-market value instead of an intrinsic that would (a)
      // over-credit a short seller unearned time-decay on a stub cycle, or (b) under/over-
      // value a deep-ITM leg vs its discounted model price. Falls back to intrinsic if unmarked.
      const mark = engine.state.lastPrices[leg.key];
      const base = Math.max(Number.isFinite(mark) && mark > 0 ? mark : intrinsic, 0.05);
      // COSTS. A true expiry is a cash SETTLEMENT, not a trade: no spread/exchange charge —
      // but the exchange auto-exercises an ITM LONG, charging STT on the settlement value
      // (sellers pay nothing at expiry). An early settle is a real market close: it crosses
      // the spread + pays the proportional charges (in the fill price) + flat brokerage.
      const closePrice = costModel && !isExpiry ? optFillPrice(costModel, side, base) : base;
      const r0 = engine.realisedTotal();
      engine.placeOrder({ instrument: leg.inst, side, orderType: 'MARKET', lots, price: closePrice });
      if (costModel) {
        if (!isExpiry) chargeFee(engine, costModel.brokeragePerOrder);
        else if (wasLong && intrinsic > 0) chargeFee(engine, costModel.settleLongSttRate * intrinsic * units);
      }
      trades++;
      const reason = isExpiry
        ? `Expiry — the ${leg.inst.strike} ${leg.inst.optType} settled at its intrinsic value (₹${closePrice.toFixed(2)}); the monthly cycle closed and its margin is freed for the next one.`
        : `Closed the ${leg.inst.strike} ${leg.inst.optType} early at its current model price (mark-to-market, ₹${closePrice.toFixed(2)}) — the run ended before this cycle's expiry; its margin is freed.`;
      logTrade(times[i], leg.inst, `${side} (close)`, lots, closePrice, r0, reason);
    }
    cycle = null;
  };

  for (let i = 0; i < n; i++) {
    const spot = closes[i];
    if (!(spot > 0)) { equityCurve.push(engine.equity()); continue; }
    const iv = modelIV(closes, i, { volPremium });

    markCycle(i, iv);
    // Settle only when the cycle has TRULY reached its natural expiry (within the data). The
    // FINAL cycle's natural expiry can lie beyond the data; it must NOT be force-settled here
    // (the old `min(i+HOLD_BARS, n-1)` clamp did, which dropped its remaining time value and
    // hid the bot's live position — making F&O bots look "flat" and un-copyable at the edge).
    if (cycle && i >= cycle.naturalExpiryIndex) closeCycle(i, iv);

    // Open a fresh cycle when flat (and we have enough history + room to run).
    if (!cycle && i >= 20 && i + 2 < n) {
      // The NATURAL expiry is HOLD_BARS bars out. Its timestamp is a real bar when that's
      // within the data; for the FINAL cycle (expiry beyond the data) we extrapolate it from
      // the average bar spacing, so the legs are priced AND marked as a real ~1-month option
      // rather than one expiring at the data boundary.
      const naturalExpiryIndex = i + HOLD_BARS;
      // Clamp the extrapolated expiry to be strictly AFTER the last bar, so an irregular final
      // gap (a long exchange closure) can never make daysLeft collapse to 0 and wrongly mark
      // the still-open cycle at intrinsic — the very mis-valuation this whole change removes.
      const expiryTime = naturalExpiryIndex <= n - 1 ? times[naturalExpiryIndex] : Math.max(times[i] + HOLD_BARS * avgBarMs, times[n - 1] + avgBarMs);
      const daysToExpiry = Math.max(1, (expiryTime - times[i]) / 864e5);
      const specs = strategy.entry(spot, iv, { strikeStep }).map((s) => ({ ...s, strike: roundStrike(s.strike, strikeStep) }));
      // If two legs of the SAME option type snap to the SAME strike they'd share
      // one instrument key and NET each other to flat inside the engine, silently
      // collapsing the structure (e.g. an iron condor's short+long CE merging) and
      // possibly leaving a naked leg. Skip the whole cycle rather than deploy a
      // broken position. (Reachable via a large strikeStep or tightly-spaced
      // evolved legs.)
      const keys = specs.map((s) => `${s.strike}:${s.type}`);
      const collides = new Set(keys).size !== keys.length;
      const legs = [];
      if (!collides) {
        // ATOMIC multi-leg open. A strangle / straddle / iron condor is only the
        // intended (market-neutral or defined-risk) strategy if ALL its legs open.
        // So place them, but if ANY leg can't open — priced out, OR the engine
        // REJECTS it for funds — roll back every leg that already filled and skip the
        // whole cycle. The book then sits flat this month, exactly as this file's
        // header documents ("a cycle that can't be funded simply doesn't open").
        //
        // Why this matters: each leg is funded independently, so the FIRST leg
        // reserves its margin (premium + notional × %), shrinking availableFunds() —
        // and after a big loss has shrunk the account (and a sharp move has ballooned
        // option margins) the SECOND leg gets rejected. The old code kept whatever
        // filled, silently running a HALF-BUILT, one-sided NAKED position (a 2-leg
        // strangle collapsing to a lone short call) with a completely different
        // directional, unbounded-risk profile. Its violent mark-to-market swings then
        // never matched any logged trade — a real bug that looked like "the chart
        // dives but the trade history shows no losing trade".
        const opened = []; // { inst, key, spec, price, lots } for legs that actually filled
        let allOk = true;
        for (const spec of specs) {
          const modelPrice = priceOptionAt(spec.type, spot, spec.strike, daysToExpiry, iv);
          if (!(modelPrice > 0)) { allOk = false; break; }
          // The model price is a MID; a real order crosses half the bid-ask spread and
          // pays the proportional charges — both baked into the fill price when a cost
          // model runs (a SELL collects less than mid, a BUY pays more). The rollback
          // path below offsets at this SAME fill price, so an aborted cycle is an
          // exact, costless undo either way.
          const price = costModel ? optFillPrice(costModel, spec.side, modelPrice) : modelPrice;
          // expiryMs (a real timestamp) + iv are carried so the Auto-Pilot copy can
          // RE-MARK this leg client-side from the live underlying (the cyc{i} expiry never
          // appears in a real option chain). iv is refreshed each bar in markCycle.
          const inst = { kind: 'OPT', symbol, expiry: `cyc${i}`, strike: spec.strike, optType: spec.type, lotSize, underlyingPrice: spot, expiryMs: expiryTime, iv };
          const lots = (spec.lots || 1) * lotScale;
          const order = engine.placeOrder({ instrument: inst, side: spec.side, orderType: 'MARKET', lots, price });
          if (order.status === 'REJECTED') { allOk = false; break; }
          opened.push({ inst, key: instrumentKey(inst), spec, price, lots });
        }
        if (allOk && opened.length === specs.length) {
          // Every leg filled — commit the cycle (log + count each opening trade).
          // An open realises nothing (each leg opens into a flat, unique-key book),
          // so the per-trade realised delta is ~0, as before.
          const r0 = engine.realisedTotal();
          for (const o of opened) {
            legs.push({ inst: o.inst, key: o.key });
            if (costModel) chargeFee(engine, costModel.brokeragePerOrder); // flat ₹/order, only on a COMMITTED leg
            trades++;
            const why = o.spec.side === 'SELL'
              ? `Sold the ${o.spec.strike} ${o.spec.type} for ₹${o.price.toFixed(2)} — an opening leg of this month's premium-selling cycle, collecting time-decay (theta) while the index stays in range.`
              : `Bought the ${o.spec.strike} ${o.spec.type} for ₹${o.price.toFixed(2)} as a protective wing — it caps the loss if the index makes a big move against the short legs.`;
            logTrade(times[i], o.inst, `${o.spec.side} (open)`, o.lots, o.price, r0, why);
          }
        } else {
          // Roll back any leg that DID fill so no half-built structure survives. An
          // offset at the same modelled price realises ~0 (premium collected then
          // returned), so the account is unchanged — the cycle simply never happened.
          for (const o of opened) {
            const pos = engine.state.positions[o.key];
            if (!pos || pos.qty === 0) continue;
            const side = pos.qty < 0 ? 'BUY' : 'SELL'; // offset to flat
            const lots = Math.abs(pos.qty) / o.inst.lotSize;
            engine.placeOrder({ instrument: o.inst, side, orderType: 'MARKET', lots, price: o.price });
          }
        }
      }
      if (legs.length) cycle = { legs, entryIndex: i, naturalExpiryIndex, expiryTime };
    }

    equityCurve.push(engine.equity());
  }

  // A still-open final cycle (its natural expiry lies beyond the data): a BACKTEST settles it
  // at intrinsic to realise final P&L (the standard "close out at the end of a run") and
  // rewrites the last curve point to that settled value, so backtest metrics are unchanged in
  // spirit. The LIVE tournament (keepOpen) leaves it OPEN so the board shows the bot's true
  // current position, marked-to-market (intrinsic + remaining time value) — the last curve
  // point already reflects that from markCycle at the final bar.
  if (cycle && !keepOpen) {
    // Settle at the last VALID bar (closes[si] > 0), NOT blindly at n-1. A NaN / zero /
    // negative FINAL bar would otherwise be fed to priceOptionAt as the settle spot and
    // fabricate a garbage intrinsic — e.g. a short PE "settled" at spot 0 looks like a
    // full-strike catastrophic loss. Clean (sanitised) data never hits this, but a single
    // bad last print must not invent a loss or a NaN equity.
    let si = n - 1;
    while (si >= 0 && !(closes[si] > 0)) si--;
    if (si >= 0) {
      closeCycle(si, modelIV(closes, si, { volPremium }));
      if (equityCurve.length) equityCurve[equityCurve.length - 1] = engine.equity();
    }
  }

  let position = 'flat (between cycles)';
  if (cycle && keepOpen) {
    const legDescs = cycle.legs
      .map((l) => {
        const p = engine.state.positions[l.key];
        if (!p || p.qty === 0) return null;
        const lots = Math.abs(p.qty) / l.inst.lotSize;
        return `${p.qty < 0 ? 'S' : 'L'}${lots}x ${l.inst.strike}${l.inst.optType}`;
      })
      .filter(Boolean);
    position = legDescs.length ? `open: ${legDescs.join('  ')}` : 'flat';
  }

  const years = n >= 2 ? (times[n - 1] - times[0]) / (365.25 * 864e5) : undefined;
  return {
    name: strategy.name, note: strategy.note, equityCurve, position,
    finalPositions: snapshotPositions(engine),
    metrics: summarize(equityCurve, { years, trades }),
    costs: { model: costModel ? costModel.kind : 'none', feesPaid: +feesCharged(engine).toFixed(2) },
    ...(tradeLog ? { trades: tradeLog } : {}),
  };
}

// --- starter F&O strategies (index option selling — the classic "crazy") -----
// Each entry(spot) returns legs with ABSOLUTE strikes (snapped to the strike grid
// by the backtester). side SELL collects premium; BUY pays it (for protection).
const FNO_STRATEGIES = [
  {
    name: 'Short straddle (monthly)',
    note: 'Sell ATM call + ATM put each month. Max premium, naked, brutal on a big move.',
    entry: (spot) => [
      { type: 'CE', side: 'SELL', strike: spot, lots: 1 },
      { type: 'PE', side: 'SELL', strike: spot, lots: 1 },
    ],
  },
  {
    name: 'Short strangle (monthly)',
    note: 'Sell ~4% OTM call + ~4% OTM put. Wider safe zone, less premium.',
    entry: (spot) => [
      { type: 'CE', side: 'SELL', strike: spot * 1.04, lots: 1 },
      { type: 'PE', side: 'SELL', strike: spot * 0.96, lots: 1 },
    ],
  },
  {
    name: 'Iron condor (monthly)',
    note: 'Short strangle + long wings: defined, capped risk. The "safe" premium sale.',
    entry: (spot) => [
      { type: 'CE', side: 'SELL', strike: spot * 1.03, lots: 1 },
      { type: 'CE', side: 'BUY', strike: spot * 1.06, lots: 1 },
      { type: 'PE', side: 'SELL', strike: spot * 0.97, lots: 1 },
      { type: 'PE', side: 'BUY', strike: spot * 0.94, lots: 1 },
    ],
  },
];

export { runFnoBacktest, FNO_STRATEGIES };
