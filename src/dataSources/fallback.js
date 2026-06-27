// ---------------------------------------------------------------------------
// dataSources/fallback.js
// A fully OFFLINE provider. It never touches the network. When the live
// provider is blocked or you have no internet, this keeps the app usable:
// it invents a plausible (but clearly synthetic) quote, history and option
// chain so the option tools, payoff diagrams and order simulation still work.
//
// Everything it returns is marked source: 'synthetic' so the UI can label it.
// ---------------------------------------------------------------------------

'use strict';

// Rough "reasonable" spot prices so synthetic data looks sensible per symbol.
const SEED_PRICES = {
  NIFTY: 23500,
  BANKNIFTY: 51000,
  FINNIFTY: 23000,
  RELIANCE: 2900,
  TCS: 3850,
  INFY: 1550,
  HDFCBANK: 1650,
  SBIN: 820,
};

// Deterministic pseudo-random so the same symbol always looks the same within
// a run (no Math.random surprises between calls). Simple hash -> 0..1.
function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Map to 0..1
  return ((h >>> 0) % 100000) / 100000;
}

function seedPrice(symbol) {
  const key = symbol.toUpperCase();
  if (SEED_PRICES[key]) return SEED_PRICES[key];
  // Unknown symbol: derive something in the ₹100-₹2100 range from its name.
  return 100 + Math.round(hash01(key) * 2000);
}

// A gentle wobble around the seed so the LTP isn't frozen between polls.
function wobble(base, symbol) {
  const t = Math.floor(Date.now() / 4000); // changes every ~4s
  const swing = Math.sin(t + hash01(symbol) * 6.28) * 0.004; // +/- 0.4%
  return base * (1 + swing);
}

function getQuote(symbol) {
  const base = seedPrice(symbol);
  const ltp = +wobble(base, symbol).toFixed(2);
  const prevClose = +base.toFixed(2);
  return {
    symbol: symbol.toUpperCase(),
    ltp,
    prevClose,
    change: +(ltp - prevClose).toFixed(2),
    changePct: +(((ltp - prevClose) / prevClose) * 100).toFixed(2),
    currency: 'INR',
    ts: Date.now(),
    source: 'synthetic',
  };
}

// Candle spacing per Yahoo interval, and a readable point-count per lookback
// range, so synthetic charts honour the chart timeframe (1D/1W/1M/1Y/Max) with a
// correct time axis even fully offline.
const INTERVAL_MS = {
  '1m': 60e3, '2m': 120e3, '5m': 300e3, '15m': 900e3, '30m': 1.8e6,
  '60m': 3.6e6, '90m': 5.4e6, '1h': 3.6e6,
  '1d': 86.4e6, '5d': 5 * 86.4e6, '1wk': 604.8e6, '1mo': 2.592e9, '3mo': 7.776e9,
};
const RANGE_COUNT = {
  '1d': 78, '5d': 65, '1mo': 22, '3mo': 65, '6mo': 130,
  '1y': 250, '2y': 105, '5y': 60, '10y': 120, ytd: 120, max: 120,
  // Long daily windows the tournament backfill uses (rangeFor → '20y'). Sized so an
  // OFFLINE synthetic fallback still has enough bars to warm a 200-period indicator,
  // so a degraded (Yahoo-down) boot doesn't leave every gated bot stuck cold in cash.
  '15y': 200, '20y': 260, '25y': 320,
};

function getHistory(symbol, opts = {}) {
  const base = seedPrice(symbol);
  const interval = opts.interval || '1d';
  const stepMs = INTERVAL_MS[interval] || INTERVAL_MS['1d'];
  // No range given -> 60 points (the original default); else size to the range.
  const count = opts.range ? RANGE_COUNT[opts.range] || 60 : 60;
  const candles = [];
  let price = base * 0.9;
  const start = Date.now() - count * stepMs;
  for (let i = 0; i < count; i++) {
    // Smooth deterministic drift so the chart looks like a real series.
    const drift = Math.sin(i / 6 + hash01(symbol) * 6.28) * base * 0.01;
    const o = price;
    const c = price + drift + base * 0.002;
    const h = Math.max(o, c) * 1.004;
    const l = Math.min(o, c) * 0.996;
    candles.push({
      t: start + i * stepMs,
      o: +o.toFixed(2),
      h: +h.toFixed(2),
      l: +l.toFixed(2),
      c: +c.toFixed(2),
      v: Math.round(100000 + hash01(symbol + i) * 900000),
    });
    price = c;
  }
  return { symbol: symbol.toUpperCase(), candles, source: 'synthetic' };
}

// Build a few monthly-looking expiry labels. Each is the 25th of a month. We
// start at NEXT month once the 25th of the current month has arrived, so the
// nearest/default expiry (expiries[0]) is never a date in the past — an expired
// contract would give the option tools a negative time-to-expiry.
//
// NB the roll is `>= 25`, not `> 25`: ON the 25th the synthetic contract expires
// that very day (parseExpiryMs pins it to 15:30 IST), so for the afternoon of
// the 25th a `> 25` test would still offer a contract that has already expired
// (negative time-to-expiry). Rolling on the 25th itself keeps the default
// strictly in the future on every day of the month.
function getExpiries(symbol, now = new Date()) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const startOffset = now.getDate() >= 25 ? 1 : 0; // this month's 25th here/gone?
  const expiries = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + startOffset + i, 25);
    expiries.push(`${String(d.getDate()).padStart(2, '0')}-${months[d.getMonth()]}-${d.getFullYear()}`);
  }
  return { symbol: symbol.toUpperCase(), expiries, source: 'synthetic' };
}

// A symmetric synthetic chain around spot. IV uses a mild "smile" so Greeks
// computed on the client look realistic. No Greeks here on purpose — the
// client computes them from spot/strike/iv/time via Black-Scholes.
function getOptionChain(symbol, expiry) {
  const spot = seedPrice(symbol);
  const { expiries } = getExpiries(symbol);
  const chosen = expiry && expiries.includes(expiry) ? expiry : expiries[0];

  // Strike spacing: indices use wider steps than stocks.
  const key = symbol.toUpperCase();
  const step = key === 'BANKNIFTY' ? 100 : key === 'NIFTY' || key === 'FINNIFTY' ? 50 : 20;
  const atm = Math.round(spot / step) * step;

  const strikes = [];
  for (let i = -10; i <= 10; i++) {
    const strike = atm + i * step;
    if (strike <= 0) continue;
    const moneyness = Math.abs(strike - spot) / spot;
    const iv = +(18 + moneyness * 120).toFixed(2); // % implied vol smile
    // Cheap intrinsic+time premium guess just so the table has numbers.
    const ceIntrinsic = Math.max(0, spot - strike);
    const peIntrinsic = Math.max(0, strike - spot);
    const timeValue = spot * 0.01 * Math.exp(-moneyness * 8);
    strikes.push({
      strike,
      ce: {
        ltp: +(ceIntrinsic + timeValue).toFixed(2),
        oi: Math.round(hash01('ce' + strike) * 500000),
        changeOi: Math.round((hash01('cec' + strike) - 0.5) * 100000),
        volume: Math.round(hash01('cev' + strike) * 200000),
        iv,
        bid: +(ceIntrinsic + timeValue * 0.98).toFixed(2),
        ask: +(ceIntrinsic + timeValue * 1.02).toFixed(2),
      },
      pe: {
        ltp: +(peIntrinsic + timeValue).toFixed(2),
        oi: Math.round(hash01('pe' + strike) * 500000),
        changeOi: Math.round((hash01('pec' + strike) - 0.5) * 100000),
        volume: Math.round(hash01('pev' + strike) * 200000),
        iv,
        bid: +(peIntrinsic + timeValue * 0.98).toFixed(2),
        ask: +(peIntrinsic + timeValue * 1.02).toFixed(2),
      },
    });
  }

  return {
    symbol: key,
    underlying: +spot.toFixed(2),
    expiry: chosen,
    expiries,
    strikes,
    source: 'synthetic',
  };
}

module.exports = { getQuote, getHistory, getExpiries, getOptionChain };
