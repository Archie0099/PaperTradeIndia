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
//       - index options:    ~0.03503% of PREMIUM (charged on premium, both sides)
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
// NSE equity-derivatives OPTION transaction charge: ₹3,503 per crore of PREMIUM
// turnover (SEBI's uniform schedule) = 0.03503%. Named so the published schedule has
// ONE home and a future change is a one-line edit the cost test asserts against.
const OPT_EXCH_RATE = 0.0003503;

// The rest of the published statutory schedule, NAMED for the same reason OPT_EXCH_RATE is:
// a test that re-types a magic literal from the implementation proves only that the code
// equals itself. That is exactly how the option exchange charge sat 10x too high for months
// behind a passing test (W17). These are now load-bearing for MORE bots than before, since
// every EQ/basket bot pays the DELIVERY schedule unless it declares squareOffDaily.
const EQ_STT_DELIVERY = 0.001;      // 0.10% of value, BOTH sides (GoI)
const EQ_STAMP_DELIVERY = 0.00015;  // 0.015%, BUY side only
const EQ_STT_INTRADAY_SELL = 0.00025; // 0.025%, SELL side only
const EQ_STAMP_INTRADAY = 0.00003;  // 0.003%, BUY side only
const OPT_STT_SELL = 0.001;         // 0.10% of PREMIUM, sell side only (raised Oct-2024)
const OPT_STAMP = 0.00003;          // 0.003% of premium, buy side only
const OPT_SETTLE_LONG_STT = 0.00125; // 0.125% of SETTLEMENT value on an exercised ITM long

// --- Equity, DELIVERY (held overnight — the baskets, pairs legs, EQ bots) ----
// All-in per-side fractions of trade value. With the default 5bps slippage this
// lands ≈ 16.9bps on a buy / ≈ 15.4bps on a sell (vs the old flat 5bps).
function equityDeliveryCosts({ slippageBps = 5, borrowRatePA = 0.06 } = {}) {
  const slip = slippageBps / 10000;
  return {
    kind: 'eq-delivery',
    buyRate: EQ_STT_DELIVERY + EQ_STAMP_DELIVERY + EQ_EXCH + SEBI_FEE + slip,
    sellRate: EQ_STT_DELIVERY + EQ_EXCH + SEBI_FEE + slip, // no stamp on a sell
    // Overnight shorts borrow stock via SLB at this annual fee on notional.
    borrowRatePA,
  };
}

// --- Equity, INTRADAY (MIS: genuinely in and out within one session) --------
// NOTE: this is NOT "the 60m bot". Bar interval does not imply holding period — the shipped
// hourly bot holds 88 of its 94 round trips overnight and so pays the DELIVERY schedule above.
// A strategy reaches this schedule only by declaring `squareOffDaily`, i.e. certifying it is
// flat by the close. Nothing on the current roster does.
// STT is sell-side only and 4x lighter; stamp duty is lighter; no overnight
// borrow needed for an intraday short. ≈ 3.7bps buy / 6.2bps sell at 3bps slip.
function equityIntradayCosts({ slippageBps = 3 } = {}) {
  const slip = slippageBps / 10000;
  return {
    kind: 'eq-intraday',
    buyRate: EQ_STAMP_INTRADAY + EQ_EXCH + SEBI_FEE + slip, // NO STT on an intraday buy
    sellRate: EQ_STT_INTRADAY_SELL + EQ_EXCH + SEBI_FEE + slip,
    borrowRatePA: 0,
  };
}

// --- Index OPTIONS (the F&O premium-selling bots) ----------------------------
// Charged on PREMIUM (that's how options work): the NSE transaction charge is
// ₹3,503 per crore of premium turnover = 0.03503% (SEBI's uniform schedule) —
// about 12x the equity rate — plus STT on the sell side, plus crossing a real
// bid-ask spread that the Black-Scholes MID price doesn't show.
// All-in ≈ 0.044% of premium buy-side + half-spread; ≈ 0.141% sell-side + half-
// spread; ₹20/order flat brokerage on top (charged via harness.chargeFee).
function indexOptionCosts({ halfSpreadPct = 0.005, tick = 0.05, brokeragePerOrder = 20 } = {}) {
  // NOTE THE DECIMAL PLACE: 0.03503% of premium, NOT 0.3503%. This was wrong by a
  // factor of 10 until it was caught — an inflated charge that made every modelled
  // F&O return here (and on the live board) worse than the real schedule allows.
  const exch = OPT_EXCH_RATE * (1 + GST); // NSE option transaction charge, GST-inclusive
  return {
    kind: 'index-opt',
    buyRate: OPT_STAMP + exch + SEBI_FEE,
    sellRate: OPT_STT_SELL + exch + SEBI_FEE,
    halfSpreadPct, // you buy at mid + half-spread, sell at mid − half-spread
    tick,          // the half-spread is floored at one price tick (₹0.05)
    brokeragePerOrder,
    // STT charged on the SETTLEMENT value of an in-the-money LONG option at
    // expiry (the exchange auto-exercises it). Sellers pay nothing at expiry.
    settleLongSttRate: OPT_SETTLE_LONG_STT,
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
  eqFillPrice, optFillPrice, borrowFee, GST, SEBI_FEE, EQ_EXCH,
  OPT_EXCH_RATE, EQ_STT_DELIVERY, EQ_STAMP_DELIVERY, EQ_STT_INTRADAY_SELL, EQ_STAMP_INTRADAY,
  OPT_STT_SELL, OPT_STAMP, OPT_SETTLE_LONG_STT,
};
