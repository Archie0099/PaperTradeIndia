// ---------------------------------------------------------------------------
// backtest/backtester.mjs
// Replays a daily close series through the REAL simulation engine, rebalancing a
// long-only equity position toward the strategy's target weight each bar.
//
// NO LOOK-AHEAD: the weight a strategy computes from bars [0..i] is executed at
// bar i+1's price. We mark the account to each bar's clean close for the equity
// curve, and bake a per-trade cost into the fill price (buys pay a little more,
// sells receive a little less).
// ---------------------------------------------------------------------------

import { freshEngine, snapshotPositions, chargeFee, feesCharged } from './harness.mjs';
import { summarize, inferPeriodsPerYear } from './metrics.mjs';
import { describeExpr } from './dsl.mjs';
import { flatCosts, eqFillPrice, borrowFee } from './costs.mjs';

// `intraday: true` annualises the Sharpe by the series' own bars-per-year (e.g. ~1600
// for 60-min NSE bars) instead of the daily 252 — so an intraday strategy isn't scored
// as if its bars were days. Everything else (no-look-ahead one-bar lag, the engine) is
// interval-agnostic, so the SAME backtester replays 60-min bars just like daily ones.
//
// COSTS: pass a `costModel` (backtest/costs.mjs — the all-in Indian schedule, incl. an
// SLB borrow fee on overnight shorts) for honest results; without one the legacy flat
// `costBps` applies, byte-identical to the old behaviour (kept for tests/back-compat).
// `rebalanceBand` (fraction of equity, default 0 = off, byte-identical to the old
// behaviour): with a CONTINUOUS target weight, the engine would otherwise trade a
// tiny qty drift almost every bar (cash sits still while the position's value
// moves, so target·equity/price wanders a few units daily) — real cost bleed on
// phantom "rebalances" the strategy never asked for. With a band, a SAME-SIDE
// adjustment smaller than band·equity is skipped; entries, exits and side flips
// always trade (a band must never suppress a signal, only sizing drift).
function runBacktest({ strategy, candles, symbol = 'TEST', cash = 1_000_000, costBps = 5, costModel = null, recordTrades = false, intraday = false, spec = null, rebalanceBand = 0 }) {
  const closes = candles.map((c) => c.c);
  const times = candles.map((c) => c.t);
  const engine = freshEngine(cash);
  const inst = { kind: 'EQ', symbol, lotSize: 1 };
  const key = `EQ:${symbol.toUpperCase()}`;
  const decide = strategy.make(); // fresh per-run state
  const cm = costModel || flatCosts(costBps);
  // Liquidity instrumentation (honesty, not simulation): count fills whose rupee
  // value exceeds PARTICIPATION_CAP of that bar's traded value (volume × close).
  // We do NOT model impact — we FLAG that the fill wouldn't be executable as
  // simulated, so an over-sized bot can't quietly claim an impossible result.
  const PARTICIPATION_CAP = 0.10;
  let liqChecked = 0, liqFlagged = 0;

  const equityCurve = [];
  let target = 0; // weight decided on the PREVIOUS bar, executed on THIS bar
  let trades = 0;
  // Optional per-trade log (for the "show me a bot's full history" UI). Each fill
  // records its bar timestamp, side, qty, fill price and the REALISED P&L it booked
  // (≈0 on a buy; the round-trip profit/loss on a sell that closes part of a position).
  const tradeLog = recordTrades ? [] : null;
  // Plain-English "why this trade" text, derived from the strategy's entry/exit rules
  // (when a DSL `spec` is supplied). A fresh entry vs a top-up, and a full exit vs a trim,
  // are distinguished from the qty transition at the trade site.
  const isContinuous = !spec || spec.entry === undefined; // buy & hold / continuous-weight
  // Fuller, price-aware "why this trade" text (more detailed trade reasons).
  const entryReason = (px) => isContinuous
    ? `Bought ${symbol} at ₹${px.toFixed(2)} — an always-invested / continuous-weight strategy, so it holds a long whenever its target exposure is above zero.`
    : `Buy signal at ₹${px.toFixed(2)} — ${describeExpr(spec.entry)} became true, so the strategy opened a long position in ${symbol}.`;
  const exitReason = (px) => isContinuous
    ? `Reduced ${symbol} at ₹${px.toFixed(2)} toward its lower target exposure.`
    : (spec.exit !== undefined
      ? `Sell signal at ₹${px.toFixed(2)} — ${describeExpr(spec.exit)} triggered, so the strategy closed its long in ${symbol}.`
      : `Exit at ₹${px.toFixed(2)} — ${describeExpr(spec.entry)} no longer holds, so the strategy stepped out of ${symbol}.`);
  // Bearish (side:'short') reasons — opening a short is a SELL, closing it is a BUY.
  const shortEntryReason = (px) => isContinuous
    ? `Sold ${symbol} SHORT at ₹${px.toFixed(2)} — a continuously-short strategy; it profits as the price falls.`
    : `Short signal at ₹${px.toFixed(2)} — ${describeExpr(spec.entry)} became true, so the strategy SOLD ${symbol} short (it profits if the price falls).`;
  const coverReason = (px) => isContinuous
    ? `Covered part of the ${symbol} short at ₹${px.toFixed(2)} toward a smaller short.`
    : (spec.exit !== undefined
      ? `Cover signal at ₹${px.toFixed(2)} — ${describeExpr(spec.exit)} triggered, so the strategy bought back its ${symbol} short.`
      : `Cover at ₹${px.toFixed(2)} — ${describeExpr(spec.entry)} no longer holds, so the strategy closed its ${symbol} short.`);
  // Pick the right "why" text from the position transition (covers long open/add/trim/exit
  // AND short open/add/cover). Direction is inferred from the signed cur/desired quantities.
  const tradeReason = (curQty, desiredQty, side, px) => {
    if (side === 'BUY') {
      if (curQty < 0) return coverReason(px); // buying back a short
      return curQty === 0 ? entryReason(px) : `Added to ${symbol} at ₹${px.toFixed(2)} — scaling the long up toward the strategy's higher target exposure.`;
    }
    if (curQty > 0) return desiredQty <= 0 ? exitReason(px) : `Trimmed ${symbol} at ₹${px.toFixed(2)} — scaling the long down toward the strategy's lower target exposure.`;
    return curQty === 0 ? shortEntryReason(px) : `Added to the ${symbol} short at ₹${px.toFixed(2)} — increasing the short toward the strategy's larger target.`;
  };
  const logTrade = (t, side, qty, fillPrice, realisedBefore, reason) => {
    if (!tradeLog) return;
    tradeLog.push({ t, symbol, side, qty, price: +fillPrice.toFixed(2), value: Math.round(qty * fillPrice), realised: +(engine.realisedTotal() - realisedBefore).toFixed(2), reason: reason || '' });
  };

  for (let i = 0; i < closes.length; i++) {
    const price = closes[i];
    if (!Number.isFinite(price) || price <= 0) { // skip a bad candle, keep curve continuous
      equityCurve.push(engine.equity());
      continue;
    }
    engine.updateEquityPrice(symbol, price, true); // mark to market (silent)

    // --- accrue the SLB borrow fee on an overnight SHORT ------------------
    // A short in the Indian cash market is only holdable via Securities Lending
    // & Borrowing, which charges a fee on the borrowed stock's notional for the
    // CALENDAR time held (weekends included) — accrued here bar by bar.
    if (cm.borrowRatePA > 0 && i > 0) {
      const posB = engine.state.positions[key];
      if (posB && posB.qty < 0) {
        chargeFee(engine, borrowFee(Math.abs(posB.qty) * price, cm.borrowRatePA, times[i] - times[i - 1]));
      }
    }

    // --- execute the previous bar's target at THIS bar's price -------------
    // `target` is SIGNED: > 0 long, < 0 SHORT (a bearish bot), 0 flat. desiredQty is the
    // signed unit count we want to hold; we trade the difference, funding only the part
    // that OPENS new exposure — closing the opposite side is always allowed / frees funds.
    // For a long-only strategy (target ≥ 0) this is byte-identical to the old buy/sell path.
    const pos = engine.state.positions[key];
    const curQty = pos ? pos.qty : 0;
    const equity = engine.equity();
    let desiredQty = Math.trunc((target * equity) / price); // signed; truncates toward zero
    // A spec's target is single-signed (short: [-1,0], long: [0,1]). But `equity` can go
    // NEGATIVE on a losing short (a short's loss is unbounded), which would sign-flip
    // desiredQty and momentarily intend the OPPOSITE side. Clamp to the target's sign so a
    // short can only ever cover toward flat (never flip to long) and vice-versa — making the
    // no-flip property structural, not an emergent side effect of availableFunds()==equity().
    if (target < 0 && desiredQty > 0) desiredQty = 0;
    if (target > 0 && desiredQty < 0) desiredQty = 0;

    // Skip a same-side sizing drift smaller than the rebalance band (see the
    // function comment). Entries (curQty 0), exits (desiredQty 0) and flips
    // change SIDE, not size, so they are never suppressed.
    if (rebalanceBand > 0 && desiredQty !== curQty
      && curQty !== 0 && desiredQty !== 0 && (curQty > 0) === (desiredQty > 0)
      && Math.abs(desiredQty - curQty) * price < rebalanceBand * Math.max(0, equity)) {
      desiredQty = curQty;
    }

    if (desiredQty !== curQty) {
      const buying = desiredQty > curQty;
      const fillPrice = eqFillPrice(cm, buying ? 'BUY' : 'SELL', price);
      let delta = Math.abs(desiredQty - curQty);
      // EQ margin per unit ≈ price for BOTH a long (full cash) and a short (full-notional
      // proxy), so one affordability cap works on either side. Only the NEW-exposure part
      // is capped; closing the opposite position needs no funds.
      const affordable = Math.floor(Math.max(0, engine.availableFunds()) / fillPrice);
      if (buying) {
        const covering = Math.min(delta, Math.max(0, -curQty)); // buy-to-cover a short is free
        delta = covering + Math.min(delta - covering, affordable);
      } else {
        const reducing = Math.min(delta, Math.max(0, curQty)); // sell-to-reduce a long frees cash
        delta = reducing + Math.min(delta - reducing, affordable);
      }
      if (delta > 0) {
        const side = buying ? 'BUY' : 'SELL';
        const r0 = engine.realisedTotal();
        const order = engine.placeOrder({ instrument: inst, side, orderType: 'MARKET', lots: delta, price: fillPrice });
        // Only count/log an order that actually FILLED. The affordability cap means a
        // MARKET EQ order can't be rejected for funds, but guard so a rejection can never
        // become a phantom trade (mirrors pairs.mjs / fno.mjs).
        if (order.status === 'FILLED') {
          trades++;
          logTrade(times[i], side, delta, fillPrice, r0, tradeReason(curQty, desiredQty, side, fillPrice));
          // Liquidity flag: compare the fill's rupee value against the bar's real
          // traded value (raw volume × the raw close where we have it — `craw` is
          // carried when the series is dividend/split-adjusted).
          const vol = candles[i].v;
          if (Number.isFinite(vol) && vol > 0) {
            liqChecked++;
            if (delta * fillPrice > PARTICIPATION_CAP * vol * (candles[i].craw || price)) liqFlagged++;
          }
        }
      }
    }

    // Record account value AFTER rebalancing, marked at the clean close.
    engine.updateEquityPrice(symbol, price, true);
    equityCurve.push(engine.equity());

    // --- decide the target for the NEXT bar, using only info available now --
    // Clamp to [-1, 1]: a SHORT bot returns a negative target, a long bot a positive one.
    const w = decide({ closes, i, price });
    target = Math.max(-1, Math.min(1, Number.isFinite(w) ? w : 0));
  }

  // Prefer real elapsed years (from timestamps) for an accurate CAGR.
  const years = times.length >= 2 && Number.isFinite(times[0]) && Number.isFinite(times[times.length - 1])
    ? (times[times.length - 1] - times[0]) / (365.25 * 864e5)
    : undefined;

  // Describe the CURRENT holding (for the live tournament's leaderboard).
  const finalPos = engine.state.positions[key];
  const finalQty = finalPos ? finalPos.qty : 0;
  const lastClose = closes[closes.length - 1];
  const eqNow = engine.equity();
  const exposurePct = eqNow > 0 && finalQty ? (finalQty * lastClose) / eqNow * 100 : 0;
  // Report exposure as a % of equity when solvent; if a short has lost more than the whole
  // account (eqNow <= 0) the ratio is meaningless, so say so plainly rather than "0% short".
  const position = finalQty > 0 ? `${Math.round(exposurePct)}% long`
    : finalQty < 0 ? (eqNow > 0 ? `${Math.round(Math.abs(exposurePct))}% short` : 'short (account wiped out)')
    : 'flat (cash)';

  return {
    name: strategy.name,
    note: strategy.note,
    equityCurve,
    position,
    finalCash: engine.state.cash,
    finalPositions: snapshotPositions(engine), // current holdings (for the Auto-Pilot copy)
    metrics: summarize(equityCurve, { years, trades, periodsPerYear: intraday ? inferPeriodsPerYear(times) : undefined }),
    // Which cost schedule ran + the non-trade fees it charged (SLB borrow here).
    costs: { model: cm.kind, feesPaid: +feesCharged(engine).toFixed(2) },
    // Honesty flag, not an impact model: how many fills exceeded the participation
    // cap of that bar's traded value (only bars with volume data are checked).
    liquidity: { cap: PARTICIPATION_CAP, checked: liqChecked, flagged: liqFlagged },
    ...(tradeLog ? { trades: tradeLog } : {}),
  };
}

export { runBacktest };
