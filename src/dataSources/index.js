// ---------------------------------------------------------------------------
// dataSources/index.js
// The PROVIDER INTERFACE and the orchestrator that the rest of the app uses.
//
// PROVIDER INTERFACE (implement this to slot in a real broker like Dhan later):
//   async getQuote(symbol)                    -> { symbol, ltp, prevClose, change,
//                                                  changePct, currency, ts, source }
//   async getHistory(symbol, {interval,range})-> { symbol, candles:[{t,o,h,l,c,v}], source }
//   async getExpiries(symbol)                 -> { symbol, expiries:[...], source }
//   async getOptionChain(symbol, expiry?)     -> { symbol, underlying, expiry,
//                                                  expiries, strikes:[...], source }
//
// IMPORTANT: providers are READ-ONLY market data. There is no order-placement
// method anywhere in this interface, by design. This app never trades for real.
//
// This module wraps the live free provider with caching and a synthetic
// fallback, so callers always get a usable answer:
//   1. Serve a FRESH cached value if we have one (respects rate limits).
//   2. Otherwise fetch LIVE.
//   3. If live fails, serve the last STALE cached value (marked stale).
//   4. If we never had one, serve SYNTHETIC offline data.
// ---------------------------------------------------------------------------

'use strict';

const config = require('../config');
const { TtlCache } = require('../cache');
const live = require('./freeProvider');
const fallback = require('./fallback');

const cache = new TtlCache();

// In-flight fetches, keyed by cache key. Lets concurrent identical requests
// (e.g. a burst of polls, or getExpiries + getOptionChain) share ONE upstream
// call instead of each hitting NSE/Yahoo — important for NSE's ~1-req/3s limit.
const inflight = new Map();

// Track which upstreams are currently reachable, for the /api/status endpoint.
const health = {
  yahoo: { ok: null, lastError: null, lastOkAt: null },
  nse: { ok: null, lastError: null, lastOkAt: null },
};

function markHealth(which, ok, err) {
  health[which].ok = ok;
  if (ok) health[which].lastOkAt = Date.now();
  else health[which].lastError = err ? String(err.message || err) : 'unknown';
}

// Generic helper implementing the live -> stale -> synthetic chain.
// `key`     : cache key
// `ttlMs`   : how long a fresh value lasts
// `liveFn`  : () => Promise<value>   (the live fetch)
// `synthFn` : () => value            (offline synthetic)
// `which`   : 'yahoo' | 'nse' for health tracking
async function resolve(key, ttlMs, liveFn, synthFn, which) {
  const fresh = cache.getFresh(key, ttlMs);
  if (fresh) return fresh;

  // Coalesce concurrent callers for the same key onto one in-flight fetch.
  if (inflight.has(key)) return inflight.get(key);

  const work = (async () => {
    try {
      const value = await liveFn();
      markHealth(which, true);
      return cache.set(key, value);
    } catch (err) {
      markHealth(which, false, err);
      // Serve the last good value if we have one, re-tagged as stale.
      const stale = cache.getStale(key);
      if (stale) {
        return { ...stale, source: 'stale', staleAgeMs: cache.ageOf(key) };
      }
      // Nothing cached: synthesize so the UI still works.
      const synth = synthFn();
      return { ...synth, note: 'offline synthetic data (live source unavailable)' };
    }
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

const provider = {
  getQuote(symbol) {
    return resolve(
      `quote:${symbol}`,
      config.cache.quoteMs,
      () => live.getQuote(symbol),
      () => fallback.getQuote(symbol),
      'yahoo'
    );
  },

  getHistory(symbol, opts = {}) {
    const key = `hist:${symbol}:${opts.interval || '1d'}:${opts.range || '1mo'}`;
    return resolve(
      key,
      config.cache.historyMs,
      () => live.getHistory(symbol, opts),
      () => fallback.getHistory(symbol, opts),
      'yahoo'
    );
  },

  getOptionChain(symbol, expiry) {
    const key = `chain:${symbol}:${expiry || 'near'}`;
    return resolve(
      key,
      config.cache.chainMs,
      () => live.getOptionChain(symbol, expiry),
      () => fallback.getOptionChain(symbol, expiry),
      'nse'
    );
  },

  getExpiries(symbol) {
    // The NSE chain response already lists every expiry, so reuse the cached
    // option chain instead of a second NSE round-trip (and the in-flight map
    // coalesces the two when they're requested together).
    return this.getOptionChain(symbol).then((chain) => ({
      symbol: symbol.toUpperCase(),
      expiries: chain.expiries || [],
      source: chain.source,
    }));
  },

  getHealth() {
    return health;
  },
};

module.exports = provider;
