// ---------------------------------------------------------------------------
// backtest/costs.mjs
// An ALL-IN Indian transaction-cost model for the backtesters. Until this module
// existed, equity trades paid a flat 5bps and option legs paid NOTHING — which
// silently flattered every strategy (option premium-sellers most of all). A quant
// treats costs as part of the strategy, so they live here in ONE documented place.
//
// Everything is a PURE function of the trade — no state, no clocks, no deps —
// so backtests stay deterministic. Rates are the published NSE/SEBI/GoI schedules
// (as of FY 2024-25 onward) plus explicit, tunable ASSUMPTIONS for the parts no
// schedule can give you (slippage, option bid-ask spread, SLB borrow). Every
// component is listed so any single number can be challenged and re-derived:
//
//   * STT (Securities Transaction Tax, GoI):
//       - equity DELIVERY:  0.100% of value, BOTH buy and sell
//       - equity INTRADAY:  0.025% of value, SELL side only
//       - index OPTIONS:    0.100% of PREMIUM, SELL side only (raised Oct-2024)
//                           0.125% of the SETTLEMENT value on an exercised
//                           (expiring in-the-money) LONG option
//   * Exchange transaction charge (NSE):
//       - equity (cash):    ~0.00297% of value
//       - index options:    ~0.3503% of PREMIUM  (charged on premium, both sides)
//   * SEBI turnover fee:    0.0001% (₹10/crore), all segments
//   * Stamp duty (buy side only): 0.015% delivery, 0.003% intraday, 0.003% options
//   * GST: 18% on (brokerage + exchange charge + SEBI fee)
//   * Brokerage: ₹0 for delivery at discount brokers; ~₹20/order for F&O
//   * SLIPPAGE (assumption): crossing the spread + a little impact. Default 5bps
//     per side for liquid large-caps at the daily close, 3bps intraday.
//   * OPTION SPREAD (assumption): index options trade with a real bid-ask; we
//     charge HALF a ~1% spread per side (floored at one ₹0.05 tick), since the
//     Black-Scholes model price is a MID — you sell at the bid, buy at the ask.
//   * SLB BORROW (assumption): overnight SHORT equity is not possible in the
//     Indian cash market; the honest proxy is the Securities Lending & Borrowing
//     window at a borrow fee. Default 6%/yr on the short's notional while held.
//     (Real SLB fees range ~0.5-10%/yr and many names simply aren't borrowable —
//     see METHODOLOGY.md; this default prices the constraint without pretending
//     precision.)
//
// The models expose per-side RATES (fractions of trade value) so a backtester can
// keep its existing "bake the cost into the fill price" mechanics — which keeps
// the engine untouched and the MASTER money invariant intact. Flat ₹ fees (F&O
// brokerage) can't be a rate, so they're charged separately via harness.chargeFee.
// ---------------------------------------------------------------------------

const GST = 0.18;          // GST on brokerage + exchange charge + SEBI fee
const SEBI_FEE = 0.000001; // 0.0001% turnover fee

// One NSE cash-equity exchange transaction charge, GST-inclusive (brokerage is 0
// for delivery at discount brokers, so GST applies to the exchange+SEBI part).
const EQ_EXCH = 0.0000297 * (1 + GST);

// --- Equity, DELIVERY (held overnight — the baskets, pairs legs, EQ bots) ----
// All-in per-side fractions of trade value. With the default 5bps slippage this
// lands ≈ 16.9bps on a buy / ≈ 15.4bps on a sell (vs the old flat 5bps).
function equityDeliveryCosts({ slippageBps = 5, borrowRatePA = 0.06 } = {}) {
  const slip = slippageBps / 10000;
  return {
    kind: 'eq-delivery',
    buyRate: 0.001 /* STT */ + 0.00015 /* stamp */ + EQ_EXCH + SEBI_FEE + slip,
    sellRate: 0.001 /* STT */ + EQ_EXCH + SEBI_FEE + slip,
    // Overnight shorts borrow stock via SLB at this annual fee on notional.
    borrowRatePA,
  };
}

// --- Equity, INTRADAY (the 60m bot: in and out within the session) ----------
// STT is sell-side only and 4x lighter; stamp duty is lighter; no overnight
// borrow needed for an intraday short. ≈ 3.7bps buy / 6.2bps sell at 3bps slip.
function equityIntradayCosts({ slippageBps = 3 } = {}) {
  const slip = slippageBps / 10000;
  return {
    kind: 'eq-intraday',
    buyRate: 0.00003 /* stamp */ + EQ_EXCH + SEBI_FEE + slip,
    sellRate: 0.00025 /* STT */ + EQ_EXCH + SEBI_FEE + slip,
    borrowRatePA: 0,
  };
}

// --- Index OPTIONS (the F&O premium-selling bots) ----------------------------
// Charged on PREMIUM (that's how options work): the NSE transaction charge alone
// is ~0.35% of premium — 100x the equity rate — plus STT on the sell side, plus
// crossing a real bid-ask spread that the Black-Scholes MID price doesn't show.
// All-in ≈ 0.42% of premium buy-side + half-spread; ≈ 0.51% sell-side + half-
// spread; ₹20/order flat brokerage on top (charged via harness.chargeFee).
function indexOptionCosts({ halfSpreadPct = 0.005, tick = 0.05, brokeragePerOrder = 20 } = {}) {
  const exch = 0.003503 * (1 + GST); // NSE option transaction charge, GST-inclusive
  return {
    kind: 'index-opt',
    buyRate: 0.00003 /* stamp */ + exch + SEBI_FEE,
    sellRate: 0.001 /* STT on sell premium */ + exch + SEBI_FEE,
    halfSpreadPct, // you buy at mid + half-spread, sell at mid − half-spread
    tick,          // the half-spread is floored at one price tick (₹0.05)
    brokeragePerOrder,
    // STT charged on the SETTLEMENT value of an in-the-money LONG option at
    // expiry (the exchange auto-exercises it). Sellers pay nothing at expiry.
    settleLongSttRate: 0.00125,
  };
}

// --- Back-compat: the old flat costBps behaviour as a cost model -------------
// Lets every existing call site (and test) keep its exact old numbers by simply
// not passing a costModel: runBacktest et al. wrap their legacy costBps in this.
function flatCosts(costBps) {
  const r = costBps / 10000;
  return { kind: 'flat', buyRate: r, sellRate: r, borrowRatePA: 0 };
}

// --- Fill-price helpers -------------------------------------------------------
// Equity: the effective per-unit price after all proportional charges. A buy
// costs a little more than the print, a sell receives a little less.
function eqFillPrice(model, side, px) {
  return side === 'BUY' ? px * (1 + model.buyRate) : px * (1 - model.sellRate);
}

// Options: cross half the bid-ask spread off the model MID first, then apply the
// proportional charges. A sell of near-worthless premium can't go below one tick's
// worth of nothing — clamp at ₹0.01 so the engine (which rejects price ≤ 0) still
// books the fill; economically "you sold dust for ~nothing", which is the truth.
function optFillPrice(model, side, px) {
  const half = Math.max(px * model.halfSpreadPct, model.tick);
  if (side === 'BUY') return (px + half) * (1 + model.buyRate);
  return Math.max((px - half) * (1 - model.sellRate), 0.01);
}

// --- Time-based fees ----------------------------------------------------------
// SLB borrow fee for holding a SHORT of `notional` rupees for `ms` milliseconds.
// Accrued bar-by-bar by the backtesters (calendar-time, so weekend gaps accrue —
// a real borrow charges you for the days you hold it, traded or not).
function borrowFee(notional, ratePA, ms) {
  if (!(notional > 0) || !(ratePA > 0) || !(ms > 0)) return 0;
  return notional * ratePA * (ms / (365.25 * 864e5));
}

export {
  equityDeliveryCosts, equityIntradayCosts, indexOptionCosts, flatCosts,
  eqFillPrice, optFillPrice, borrowFee, GST, SEBI_FEE,
};
