// ---------------------------------------------------------------------------
// dataSources/freeProvider.js
// The LIVE, free, no-account provider:
//   * Equity quotes + price history  -> Yahoo Finance chart endpoint
//   * Option chain + expiries        -> NSE public (unofficial) endpoints
//
// These are unofficial endpoints that block obvious bots, so we send
// browser-like headers and (for NSE) prime a session cookie first. Failures
// are expected from time to time; we throw on failure and let the orchestrator
// (dataSources/index.js) fall back to cached or synthetic data.
//
// Uses Node 18+ global fetch. No node-fetch, no extra dependencies.
// ---------------------------------------------------------------------------

'use strict';

const config = require('../config');

// --- Symbol mapping ---------------------------------------------------------
// The UI uses friendly tickers (RELIANCE, NIFTY). Yahoo wants suffixes and
// special index codes; NSE wants the bare index/equity symbol.
const INDEX_TO_YAHOO = {
  NIFTY: '^NSEI',
  BANKNIFTY: '^NSEBANK',
  FINNIFTY: '^CNXFIN',
  SENSEX: '^BSESN',
};

// Symbols NSE serves from the index option-chain endpoint (vs. equities).
// NOTE: MIDCPNIFTY / NIFTYNXT50 have working NSE option chains (and the chain
// response carries their underlying value) but no reliable Yahoo quote code, so
// their standalone /api/quote degrades to synthetic — acceptable, and safer than
// guessing a Yahoo ticker that might resolve to a DIFFERENT instrument.
const NSE_INDEX_SYMBOLS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50']);

// Turn a friendly symbol into a Yahoo ticker. ".BO" suffix => BSE.
function toYahooSymbol(symbol) {
  const s = symbol.toUpperCase();
  if (INDEX_TO_YAHOO[s]) return INDEX_TO_YAHOO[s];
  if (s.endsWith('.NS') || s.endsWith('.BO') || s.startsWith('^')) return s; // already mapped
  if (s.endsWith('.BSE')) return s.replace('.BSE', '.BO');
  return s + '.NS'; // default: NSE equity
}

function isNseIndex(symbol) {
  return NSE_INDEX_SYMBOLS.has(symbol.toUpperCase());
}

// Common browser-like headers.
function browserHeaders(extra = {}) {
  return {
    'User-Agent': config.userAgent,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...extra,
  };
}

// Fetch with a timeout so a hung upstream never freezes our server. The abort
// timer stays armed until the WHOLE BODY has been read — the old version cleared
// it the instant the HEADERS arrived, so an upstream that sent headers and then
// stalled/trickled the body left `res.json()` awaiting forever (neither resolve
// nor reject): the tournament boot, the daily/intraday ticks, and every poller
// coalesced onto that in-flight key all froze behind it, and the stale-cache /
// synthetic fallbacks never fired (they only fire on a REJECTION). Reading the
// body here puts it inside the abort window, so a stalled body now REJECTS
// (AbortError) like any other timeout and the normal fallbacks take over.
// Returns a small response-like wrapper (ok/status/headers + json()/text() over
// the already-buffered body) — every field the callers actually use.
async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text(); // body read INSIDE the timeout window
    return {
      ok: res.ok,
      status: res.status,
      headers: res.headers,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  } finally {
    clearTimeout(timer);
  }
}

// --- Yahoo: quotes + history ------------------------------------------------
async function fetchYahooChart(symbol, interval, range) {
  const ysym = toYahooSymbol(symbol);
  // Encode interval/range too (not just the symbol): they come from the client's
  // query string, so a crafted value could otherwise smuggle extra Yahoo params
  // or corrupt the URL.
  const url = `${config.endpoints.yahooChart}${encodeURIComponent(ysym)}?interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}`;
  const res = await fetchWithTimeout(url, { headers: browserHeaders() });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status} for ${ysym}`);
  const json = await res.json();
  const result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result) throw new Error(`Yahoo returned no data for ${ysym}`);
  return result;
}

async function getQuote(symbol) {
  // 1-minute candles over today gives us a fresh last price + previous close.
  const result = await fetchYahooChart(symbol, '1m', '1d');
  return parseQuote(symbol, result.meta || {});
}

// Pure parser for a Yahoo chart `meta` block (exported for tests, no network).
function parseQuote(symbol, meta) {
  const ltp = meta.regularMarketPrice;
  // Reject a missing OR non-numeric price: a string/NaN would become `null` here
  // and be surfaced as a `source:'live'` quote with a null price, instead of
  // throwing so the orchestrator falls back to the last stale / synthetic value.
  if (ltp == null || !Number.isFinite(Number(ltp))) throw new Error(`No usable price in Yahoo meta for ${symbol}`);
  const prevRaw = meta.previousClose != null ? meta.previousClose : meta.chartPreviousClose;
  // Only a POSITIVE finite previous close is usable. Keep change and changePct
  // consistent: with no real previous close, BOTH are 0 — never "change != 0 but
  // changePct == 0" (which happened when prevClose was exactly 0).
  const havePrev = prevRaw != null && Number(prevRaw) > 0;
  const change = havePrev ? ltp - prevRaw : 0;
  return {
    symbol: symbol.toUpperCase(),
    ltp: +Number(ltp).toFixed(2),
    prevClose: prevRaw != null ? +Number(prevRaw).toFixed(2) : null,
    change: +change.toFixed(2),
    changePct: havePrev ? +((change / prevRaw) * 100).toFixed(2) : 0,
    currency: meta.currency || 'INR',
    ts: Date.now(),
    source: 'live',
  };
}

// Intraday Yahoo intervals (as opposed to the daily/weekly/monthly ones). Used
// to decide whether the market-closed retry below makes sense.
const INTRADAY_INTERVALS = new Set(['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h']);
function isIntradayInterval(interval) {
  return INTRADAY_INTERVALS.has(interval);
}

// When a short intraday window comes back empty (the market is closed), widen the
// range so the retry can reach the last real trading session.
const WIDER_INTRADAY_RANGE = { '1d': '5d', '5d': '1mo' };

// Group intraday candles by their UTC calendar date and return only the most
// recent day's bars. An NSE session (09:15-15:30 IST = 03:45-10:00 UTC) falls
// entirely within ONE UTC date, so grouping by UTC date yields one session per
// day — which lets the "1D" view show the last real session, not a multi-day blob.
function lastSessionCandles(candles) {
  if (!candles.length) return [];
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  const lastDay = dayOf(candles[candles.length - 1].t);
  return candles.filter((c) => dayOf(c.t) === lastDay);
}

async function getHistory(symbol, opts = {}) {
  const interval = opts.interval || '1d';
  const range = opts.range || '1mo';
  const result = await fetchYahooChart(symbol, interval, range);
  let out = parseHistory(symbol, result);

  // Market-closed fallback. An INTRADAY request over a short range (the "1D" view
  // asks for 5-min bars over today) parses to ZERO candles on a weekend or
  // exchange holiday — there was simply no trading today. Rather than fall through
  // to SYNTHETIC placeholder data (a fake-looking smooth line), widen the window
  // and return the LAST real trading session, so the chart always shows genuine
  // prices regardless of which day someone opens the app.
  if (!out.candles.length && isIntradayInterval(interval)) {
    const widerRange = WIDER_INTRADAY_RANGE[range] || '5d';
    const wider = parseHistory(symbol, await fetchYahooChart(symbol, interval, widerRange));
    // For the "today" view, trim to just the last session; a wider intraday view
    // (e.g. 1W) keeps its full multi-day window.
    const candles = range === '1d' ? lastSessionCandles(wider.candles) : wider.candles;
    if (candles.length) out = { ...wider, candles };
  }

  // A response with timestamps but all-null closes (a halted/illiquid/pre-market
  // window), or a symbol with no intraday history at all, parses to ZERO candles.
  // Throw so the orchestrator falls back to the last cached value, then synthetic —
  // instead of serving an empty "live" series (the offline-first intent above).
  if (!out.candles.length) throw new Error(`Yahoo returned no usable candles for ${symbol}`);
  return out;
}

// Pure parser for a Yahoo chart result (exported for tests, no network).
function parseHistory(symbol, result) {
  const ts = (result && result.timestamp) || [];
  const q = (result && result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    // Skip any row without a usable close: a real gap, OR a response where Yahoo
    // omitted the close array entirely. We must NOT emit all-null candles tagged
    // as live data — an empty series lets the orchestrator fall back instead.
    const close = q.close ? q.close[i] : null;
    if (close == null) continue;
    candles.push({
      t: ts[i] * 1000,
      o: q.open ? num2(q.open[i]) : null,
      h: q.high ? num2(q.high[i]) : null,
      l: q.low ? num2(q.low[i]) : null,
      c: num2(close),
      v: q.volume ? q.volume[i] : null,
    });
  }
  return { symbol: symbol.toUpperCase(), candles, source: 'live' };
}

function num2(n) {
  return n == null ? null : +Number(n).toFixed(2);
}

// --- NSE: option chain + expiries ------------------------------------------
// NSE requires a session cookie obtained by first loading the homepage. We
// cache that cookie and reuse it; on a 401/403 we re-prime once and retry.
let nseCookie = '';
let nseCookieAt = 0;
const COOKIE_TTL = 10 * 60 * 1000; // refresh cookie every 10 minutes

async function primeNseCookie(force = false) {
  if (!force && nseCookie && Date.now() - nseCookieAt < COOKIE_TTL) return nseCookie;
  const res = await fetchWithTimeout(config.endpoints.nseBase, {
    headers: browserHeaders({
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }),
  });
  // Node's fetch exposes multiple Set-Cookie headers via getSetCookie().
  let cookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    cookies = res.headers.getSetCookie();
  } else {
    const single = res.headers.get('set-cookie');
    if (single) cookies = [single];
  }
  // Keep just the "name=value" part of each cookie and join with "; ".
  nseCookie = cookies.map((c) => c.split(';')[0]).join('; ');
  nseCookieAt = Date.now();
  return nseCookie;
}

async function fetchNseJson(path) {
  const url = `${config.endpoints.nseBase}${path}`;
  const headers = browserHeaders({
    Referer: `${config.endpoints.nseBase}/option-chain`,
    Cookie: nseCookie,
  });

  let res = await fetchWithTimeout(url, { headers });
  // If blocked, re-prime the cookie once and retry.
  if (res.status === 401 || res.status === 403) {
    await primeNseCookie(true);
    headers.Cookie = nseCookie;
    res = await fetchWithTimeout(url, { headers });
  }
  if (!res.ok) throw new Error(`NSE HTTP ${res.status}`);
  return res.json();
}

// Normalise NSE's raw chain into our provider shape.
function normaliseChain(symbol, raw, expiry) {
  const records = raw.records || {};
  const expiries = records.expiryDates || [];
  const chosen = expiry && expiries.includes(expiry) ? expiry : expiries[0];
  const underlying = records.underlyingValue;

  const byStrike = new Map();
  for (const row of records.data || []) {
    if (row.expiryDate !== chosen) continue;
    const strike = row.strikePrice;
    if (!byStrike.has(strike)) byStrike.set(strike, { strike, ce: null, pe: null });
    const slot = byStrike.get(strike);
    if (row.CE) slot.ce = mapLeg(row.CE);
    if (row.PE) slot.pe = mapLeg(row.PE);
  }

  const strikes = [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  return {
    symbol: symbol.toUpperCase(),
    underlying: underlying != null ? +Number(underlying).toFixed(2) : null,
    expiry: chosen,
    expiries,
    strikes,
    source: 'live',
  };
}

function mapLeg(leg) {
  return {
    ltp: numOr0(leg.lastPrice),
    oi: numOr0(leg.openInterest),
    changeOi: numOr0(leg.changeinOpenInterest),
    volume: numOr0(leg.totalTradedVolume),
    iv: numOr0(leg.impliedVolatility),
    bid: numOr0(leg.bidprice),
    ask: numOr0(leg.askPrice),
  };
}

function numOr0(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

async function getOptionChain(symbol, expiry) {
  const s = symbol.toUpperCase();
  // Some symbols we can QUOTE via Yahoo (so they're in INDEX_TO_YAHOO) but whose
  // option chain NSE does not serve — e.g. SENSEX is a BSE index. Fail clearly
  // (before any network) instead of mis-querying the NSE *equity* endpoint,
  // which returns confusing empty records; the orchestrator falls back to
  // synthetic.
  if (INDEX_TO_YAHOO[s] && !isNseIndex(s)) {
    throw new Error(`Option chain for ${s} is not available from NSE.`);
  }
  await primeNseCookie();
  const path = isNseIndex(s)
    ? `/api/option-chain-indices?symbol=${encodeURIComponent(s)}`
    : `/api/option-chain-equities?symbol=${encodeURIComponent(s)}`;
  const raw = await fetchNseJson(path);
  if (!raw || !raw.records) throw new Error('NSE returned no option-chain records');
  return normaliseChain(symbol, raw, expiry);
}

async function getExpiries(symbol) {
  // The chain response already lists every expiry, so reuse it.
  const chain = await getOptionChain(symbol);
  return { symbol: symbol.toUpperCase(), expiries: chain.expiries, source: 'live' };
}

module.exports = {
  getQuote,
  getHistory,
  getOptionChain,
  getExpiries,
  toYahooSymbol,
  // Exported for unit tests (pure parsers, no network):
  normaliseChain,
  parseQuote,
  parseHistory,
  isNseIndex,
  isIntradayInterval,
  lastSessionCandles,
  // Exported for unit tests (drives a LOCAL stub server — still no live network):
  // locks the stalled-BODY timeout regression (the timer must cover the body read).
  fetchWithTimeout,
};
