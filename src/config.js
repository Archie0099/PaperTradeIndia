// ---------------------------------------------------------------------------
// config.js
// One place for every tunable setting. Reads from environment variables
// (loaded from .env by dotenv in server.js) and falls back to sane defaults,
// so the app works even with no .env file present.
// ---------------------------------------------------------------------------

'use strict';

// Read a number from the environment, or use a default. A MISSING or
// BLANK/whitespace value yields the default — important because Number('') and
// Number('  ') are 0, which would silently (e.g.) disable the cache and break
// NSE's rate-limit protection. Out-of-domain values (e.g. a negative port or
// TTL) are also rejected back to the default.
function num(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

const config = {
  // Web server port.
  port: num('PORT', 3000, { min: 1, max: 65535 }),

  // Cache lifetimes in milliseconds. Keeping these >= 3000ms for the option
  // chain respects NSE's ~1 request / 3 second rate limit.
  cache: {
    quoteMs: num('QUOTE_CACHE_MS', 4000, { min: 0 }),
    chainMs: num('CHAIN_CACHE_MS', 4000, { min: 0 }),
    historyMs: num('HISTORY_CACHE_MS', 60000, { min: 0 }),
  },

  // Pretend to be a normal desktop browser. Yahoo and NSE block obvious bots.
  userAgent:
    process.env.USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',

  // Upstream endpoints for the free public data provider.
  endpoints: {
    yahooChart: 'https://query1.finance.yahoo.com/v8/finance/chart/',
    nseBase: 'https://www.nseindia.com',
  },
};

// Note: the option-pricing risk-free rate lives ON THE CLIENT (engine settings,
// default 6.5%) because Greeks/IV are computed in the browser. There is
// deliberately no server-side riskFreeRate here — it would be unused and could
// drift in units (fraction vs percent) from the value the UI actually applies.

// Exported for unit tests (pure, no side effects).
config._num = num;
module.exports = config;
