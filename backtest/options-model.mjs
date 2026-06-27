// ---------------------------------------------------------------------------
// backtest/options-model.mjs
// Prices options THROUGH TIME for F&O backtests. We do NOT have free historical
// option chains (NSE blocks bots and offers no deep history), so we MODEL option
// prices from the underlying with the app's own Black-Scholes engine. This is an
// APPROXIMATION — not real traded quotes — but it is consistent and fine for
// comparing strategies in a learning lab. Two modelling choices, both tunable:
//
//   * Implied vol used to price = trailing REALIZED vol (annualised) times a
//     "vol-risk-premium" factor. Real options usually trade RICHER than the vol
//     that subsequently realizes — that gap is the premium option SELLERS harvest.
//   * Risk-free rate ~6.5% (matches the app's settings.riskFreeRate default).
// ---------------------------------------------------------------------------

import { bsPrice } from '../public/js/core/options.js';

const R = 0.065; // ~6.5% risk-free, as a decimal

// Annualised realized volatility from the last n daily LOG returns.
function realizedVol(closes, end, n = 20) {
  if (end < n) return 0.18; // sensible default before we have history
  const rets = [];
  for (let k = end - n + 1; k <= end; k++) {
    // Skip any non-positive close in the window — log(0)/log(neg) would make the
    // whole vol (and every option priced from it) NaN/Infinity.
    if (closes[k] > 0 && closes[k - 1] > 0) rets.push(Math.log(closes[k] / closes[k - 1]));
  }
  if (rets.length < 2) return 0.18;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length;
  return Math.sqrt(v) * Math.sqrt(252); // daily -> annual
}

// The IV we PRICE options at: realized vol * a premium factor, with a floor so a
// dead-flat window doesn't price options at ~0.
function modelIV(closes, end, { volPremium = 1.2, floor = 0.08 } = {}) {
  return Math.max(floor, realizedVol(closes, end, 20) * volPremium);
}

// Price one option leg at a bar. daysToExpiry == 0 -> settle at intrinsic value.
function priceOptionAt(optType, spot, strike, daysToExpiry, iv) {
  const T = Math.max(daysToExpiry, 0) / 365;
  if (T <= 0) return Math.max(0, optType === 'CE' ? spot - strike : strike - spot);
  return bsPrice(optType, spot, strike, T, R, iv);
}

export { realizedVol, modelIV, priceOptionAt, R };
