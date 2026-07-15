// ---------------------------------------------------------------------------
// test/backend-and-utils.test.mjs
// Coverage for the previously-untested pure logic that can silently go wrong:
//   * NSE market-hours / IST timezone classification (server + client)
//   * the TTL cache (freshness, stale fallback, age)
//   * number formatting (Indian grouping, signs, infinities)
//   * expiry-date parsing and lot-size lookup
//   * the offline synthetic provider (no NaN, well-formed shapes)
//   * the live provider's pure parsers (symbol mapping, NSE chain normalise)
//
// Run with:  node --test
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Server modules are CommonJS; import the default (module.exports) and destructure.
import serverMarketHours from '../src/marketHours.js';
import cachePkg from '../src/cache.js';
import config from '../src/config.js';
import fallback from '../src/dataSources/fallback.js';
import freeProvider from '../src/dataSources/freeProvider.js';

// Frontend utilities are ES modules (public/js has its own package.json).
import { getMarketState as clientMarketState, istClockString, HOLIDAYS as clientHolidays } from '../public/js/core/marketHours.js';
import { guessLotSize, parseExpiryMs } from '../public/js/ui/instruments.js';
import { fmt, rupee, signed, moveClass } from '../public/js/ui/dom.js';

const { getMarketState, HOLIDAYS } = serverMarketHours;
const { TtlCache } = cachePkg;

// A small helper: build a UTC instant from an IST wall-clock time. IST = UTC+5:30.
const istInstant = (iso) => new Date(new Date(iso + 'Z').getTime() - 5.5 * 3600000);

// ===========================================================================
// Market hours (IST). 2026-06-15 is a Monday; 2026-06-13/14 are Sat/Sun.
// ===========================================================================
test('NSE session classification across the IST trading day', () => {
  const mon = '2026-06-15T'; // Monday
  const cases = [
    ['08:59:00', 'CLOSED', false],
    ['09:00:00', 'PREOPEN', false], // pre-open opens
    ['09:14:59', 'PREOPEN', false],
    ['09:15:00', 'REGULAR', true], // regular opens
    ['12:00:00', 'REGULAR', true],
    ['15:29:59', 'REGULAR', true],
    ['15:30:00', 'CLOSED', false], // close is exclusive
    ['18:00:00', 'CLOSED', false],
  ];
  for (const [t, state, open] of cases) {
    const d = istInstant(mon + t);
    const m = getMarketState(d);
    assert.equal(m.state, state, `${t} server state`);
    assert.equal(m.isOpen, open, `${t} isOpen`);
    // Client logic must agree with the server.
    const c = clientMarketState(d);
    assert.equal(c.state, state, `${t} client state`);
    assert.equal(c.isOpen, open, `${t} client isOpen`);
  }
});

test('weekends are CLOSED even during trading hours', () => {
  const sat = getMarketState(istInstant('2026-06-13T11:30:00'));
  assert.equal(sat.state, 'CLOSED');
  assert.equal(sat.reason, 'Weekend');
  const sun = getMarketState(istInstant('2026-06-14T11:30:00'));
  assert.equal(sun.reason, 'Weekend');
});

test('a weekday exchange holiday is CLOSED during hours', () => {
  // 2026-01-26 (Republic Day) is a Monday and is in the holiday list.
  assert.ok(HOLIDAYS.includes('2026-01-26'));
  const m = getMarketState(istInstant('2026-01-26T11:00:00'));
  assert.equal(m.state, 'CLOSED');
  assert.equal(m.reason, 'Exchange holiday');
});

// --- NSE 2026 trading-holiday list (verified + kept in sync) ----------------
// The list used to be a stub with "(example placeholder)" dates; it is now the
// official NSE 2026 trading-holiday set. These tests lock (a) the two copies
// (server + client) stay byte-identical — the original drift risk — and (b)
// every listed date is a real WEEKDAY closure (a holiday on a weekend is moot).
test('client and server holiday lists are identical', () => {
  assert.deepEqual(HOLIDAYS, clientHolidays,
    'src/marketHours.js and public/js/core/marketHours.js must list the same dates, in the same order');
});

test('the holiday list is the verified NSE 2026 set (no placeholders)', () => {
  // Corrected/real dates are present...
  for (const d of ['2026-01-15', '2026-01-26', '2026-03-03', '2026-04-03', '2026-10-02', '2026-11-10', '2026-12-25']) {
    assert.ok(HOLIDAYS.includes(d), `${d} should be a listed NSE 2026 holiday`);
  }
  // ...and the old stub's wrong / placeholder entries are gone. (Holi 2026 is
  // 03-03 not 03-04; 03-21 and 11-09 were placeholders; Independence Day
  // 08-15 falls on a Saturday in 2026, so it needs no holiday entry.)
  for (const d of ['2026-03-04', '2026-03-21', '2026-08-15', '2026-11-09']) {
    assert.ok(!HOLIDAYS.includes(d), `${d} must NOT be listed`);
  }
});

test('every listed holiday falls on a weekday and reads CLOSED', () => {
  for (const d of HOLIDAYS) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay(); // 0=Sun .. 6=Sat
    assert.ok(dow >= 1 && dow <= 5, `${d} should be a weekday (a weekend holiday is pointless)`);
    // The market must report CLOSED with the holiday reason at midday IST.
    const m = getMarketState(istInstant(d + 'T11:00:00'));
    assert.equal(m.state, 'CLOSED', `${d} should be CLOSED`);
    assert.equal(m.reason, 'Exchange holiday', `${d} reason`);
  }
});

test('istClockString renders IST wall-clock regardless of host timezone', () => {
  // No "IST" suffix: the status bar shows a static "IST" label next to this, so
  // a suffix here would double it up ("IST  09:15:00 IST").
  const s = istClockString(istInstant('2026-06-15T09:15:00'));
  assert.match(s, /^\d{2}:\d{2}:\d{2}$/);
  assert.equal(s, '09:15:00');
});

// ===========================================================================
// TTL cache.
// ===========================================================================
test('TtlCache: fresh within TTL, stale beyond it, age tracks time', () => {
  const realNow = Date.now;
  try {
    let clock = 1000;
    Date.now = () => clock;
    const c = new TtlCache();
    assert.equal(c.getFresh('k', 100), null, 'nothing cached yet');
    assert.equal(c.getStale('k'), null);
    assert.equal(c.ageOf('k'), Infinity);

    c.set('k', { v: 42 });
    clock = 1050; // 50ms later
    assert.deepEqual(c.getFresh('k', 100), { v: 42 }, 'fresh within ttl');
    assert.equal(c.ageOf('k'), 50);

    clock = 1200; // 200ms after set
    assert.equal(c.getFresh('k', 100), null, 'expired beyond ttl');
    assert.deepEqual(c.getStale('k'), { v: 42 }, 'stale value still available');
    assert.equal(c.ageOf('k'), 200);
  } finally {
    Date.now = realNow;
  }
});

// ===========================================================================
// Number formatting (the terminal's signature is aligned Indian numbers).
// ===========================================================================
test('fmt uses Indian digit grouping and handles bad input', () => {
  assert.equal(fmt(100000, 0), '1,00,000'); // lakh grouping (needs full ICU)
  assert.equal(fmt(1234567.5, 2), '12,34,567.50');
  assert.equal(fmt(0, 2), '0.00');
  assert.equal(fmt(5, 0), '5');
  assert.equal(fmt(null), '–');
  assert.equal(fmt(NaN), '–');
  assert.equal(fmt(Infinity), '–');
});

test('rupee and signed format signs, currency and infinities correctly', () => {
  assert.equal(rupee(1234.5), '₹1,234.50');
  assert.equal(rupee(-1234.5), '-₹1,234.50');
  assert.equal(rupee(null), '–');

  assert.equal(signed(5), '+5.00');
  assert.equal(signed(-5), '-5.00');
  assert.equal(signed(0), '0.00');
  assert.equal(signed(null), '–');
  assert.equal(signed(NaN), '–');
  // Infinities (unbounded P&L) must not collapse to '–'.
  assert.equal(signed(Infinity), '+∞');
  assert.equal(signed(-Infinity), '-∞');

  assert.equal(moveClass(5), 'up');
  assert.equal(moveClass(-5), 'down');
  assert.equal(moveClass(0), 'flat');
});

// ===========================================================================
// Instruments: lot size + expiry parsing.
// ===========================================================================
test('guessLotSize is case-insensitive with a default of 1', () => {
  assert.equal(guessLotSize('NIFTY'), 75);
  assert.equal(guessLotSize('nifty'), 75);
  assert.equal(guessLotSize('RELIANCE'), 250);
  assert.equal(guessLotSize('SOMETHINGELSE'), 1);
  assert.equal(guessLotSize(''), 1);
});

test('parseExpiryMs parses NSE dates and falls back safely', () => {
  const d = new Date(parseExpiryMs('26-Jun-2026'));
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 5); // June (0-based)
  assert.equal(d.getDate(), 26);

  // Case-insensitive month + boundary months.
  assert.equal(new Date(parseExpiryMs('26-jun-2026')).getMonth(), 5);
  assert.equal(new Date(parseExpiryMs('01-Jan-2027')).getMonth(), 0);
  assert.equal(new Date(parseExpiryMs('31-Dec-2026')).getMonth(), 11);

  // Garbage / missing -> ~7 days out, never NaN.
  for (const bad of ['garbage', '', undefined, null, '2026-06-26']) {
    const ms = parseExpiryMs(bad);
    assert.ok(Number.isFinite(ms), `parseExpiryMs(${bad}) finite`);
    const days = (ms - Date.now()) / (24 * 3600 * 1000);
    assert.ok(days > 6 && days < 8, `fallback ~7 days, got ${days}`);
  }
});

// ===========================================================================
// Offline synthetic provider: well-formed and never NaN.
// ===========================================================================
function assertNoNaN(obj, path = '') {
  if (typeof obj === 'number') {
    assert.ok(Number.isFinite(obj), `NaN/Infinity at ${path} = ${obj}`);
  } else if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoNaN(v, `${path}[${i}]`));
  } else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) assertNoNaN(obj[k], `${path}.${k}`);
  }
}

test('synthetic provider returns finite, well-formed quotes/history/chains', () => {
  for (const sym of ['RELIANCE', 'NIFTY', 'TOTALLYUNKNOWNXYZ']) {
    const q = fallback.getQuote(sym);
    assertNoNaN(q, `quote(${sym})`);
    assert.equal(q.source, 'synthetic');
    assert.ok(q.ltp > 0 && q.prevClose > 0, `${sym} positive prices`);
    assert.equal(q.currency, 'INR');

    const h = fallback.getHistory(sym);
    assertNoNaN(h, `history(${sym})`);
    assert.ok(h.candles.length === 60, `${sym} 60 candles`);
    for (let i = 0; i < h.candles.length; i++) {
      const c = h.candles[i];
      assert.ok(c.h >= c.l, `${sym} candle ${i} high>=low`);
      assert.ok(c.o > 0 && c.c > 0, `${sym} candle ${i} positive`);
      if (i > 0) assert.ok(c.t > h.candles[i - 1].t, `${sym} candle ${i} time increasing`);
    }

    const chain = fallback.getOptionChain(sym);
    assertNoNaN(chain, `chain(${sym})`);
    assert.ok(chain.underlying > 0);
    assert.ok(chain.expiries.includes(chain.expiry), 'chosen expiry is listed');
    assert.ok(chain.strikes.length > 0);
    for (let i = 0; i < chain.strikes.length; i++) {
      const s = chain.strikes[i];
      assert.ok(s.strike > 0);
      if (i > 0) assert.ok(s.strike > chain.strikes[i - 1].strike, 'strikes sorted ascending');
      for (const side of ['ce', 'pe']) {
        assert.ok(s[side].iv > 0, `${side} iv > 0`);
        assert.ok(s[side].ask >= s[side].bid, `${side} ask>=bid`);
      }
    }
  }
});

test('synthetic provider honours a requested expiry when valid', () => {
  const { expiries } = fallback.getExpiries('NIFTY');
  const chain = fallback.getOptionChain('NIFTY', expiries[1]);
  assert.equal(chain.expiry, expiries[1]);
});

// ===========================================================================
// Live provider pure parsers (no network).
// ===========================================================================
test('toYahooSymbol maps indices, equities and BSE suffixes', () => {
  const map = freeProvider.toYahooSymbol;
  assert.equal(map('NIFTY'), '^NSEI');
  assert.equal(map('BANKNIFTY'), '^NSEBANK');
  assert.equal(map('FINNIFTY'), '^CNXFIN');
  assert.equal(map('RELIANCE'), 'RELIANCE.NS'); // default NSE
  assert.equal(map('reliance'), 'RELIANCE.NS'); // case-insensitive
  assert.equal(map('RELIANCE.BO'), 'RELIANCE.BO'); // already BSE
  assert.equal(map('INFY.BSE'), 'INFY.BO'); // .BSE -> .BO
  assert.equal(map('^NSEI'), '^NSEI'); // already a Yahoo index
});

test('isNseIndex distinguishes indices from equities', () => {
  assert.equal(freeProvider.isNseIndex('NIFTY'), true);
  assert.equal(freeProvider.isNseIndex('BANKNIFTY'), true);
  assert.equal(freeProvider.isNseIndex('RELIANCE'), false);
});

test('normaliseChain parses NSE JSON, filters by expiry and sorts strikes', () => {
  const raw = {
    records: {
      expiryDates: ['26-Jun-2026', '31-Jul-2026'],
      underlyingValue: 23510.5,
      data: [
        // Out-of-order strikes, two expiries — only the near one should appear.
        { strikePrice: 23500, expiryDate: '26-Jun-2026', CE: { lastPrice: 120, openInterest: 1000, changeinOpenInterest: 50, totalTradedVolume: 200, impliedVolatility: 14.2, bidprice: 119, askPrice: 121 }, PE: { lastPrice: 90, openInterest: 800, changeinOpenInterest: -10, totalTradedVolume: 150, impliedVolatility: 15.1, bidprice: 89, askPrice: 91 } },
        { strikePrice: 23400, expiryDate: '26-Jun-2026', CE: { lastPrice: 180 } },
        { strikePrice: 23600, expiryDate: '26-Jun-2026', PE: { lastPrice: 140 } },
        { strikePrice: 23500, expiryDate: '31-Jul-2026', CE: { lastPrice: 300 } }, // far expiry, excluded
      ],
    },
  };
  const chain = freeProvider.normaliseChain('NIFTY', raw);
  assert.equal(chain.underlying, 23510.5);
  assert.deepEqual(chain.expiries, ['26-Jun-2026', '31-Jul-2026']);
  assert.equal(chain.expiry, '26-Jun-2026'); // defaults to the nearest
  // Only near-expiry strikes, sorted ascending.
  assert.deepEqual(chain.strikes.map((s) => s.strike), [23400, 23500, 23600]);
  const atm = chain.strikes.find((s) => s.strike === 23500);
  assert.equal(atm.ce.ltp, 120);
  assert.equal(atm.ce.iv, 14.2);
  assert.equal(atm.pe.changeOi, -10);
  // Missing fields default to 0 (numOr0), never undefined/NaN.
  const lower = chain.strikes.find((s) => s.strike === 23400);
  assert.equal(lower.pe, null); // no PE row for this strike
  assert.equal(lower.ce.oi, 0); // unset OI -> 0
  assertNoNaN(chain.strikes, 'normalised strikes');
});

test('normaliseChain honours a requested expiry that exists', () => {
  const raw = {
    records: {
      expiryDates: ['26-Jun-2026', '31-Jul-2026'],
      underlyingValue: 100,
      data: [{ strikePrice: 100, expiryDate: '31-Jul-2026', CE: { lastPrice: 5 } }],
    },
  };
  const chain = freeProvider.normaliseChain('X', raw, '31-Jul-2026');
  assert.equal(chain.expiry, '31-Jul-2026');
  assert.equal(chain.strikes.length, 1);
});

// ===========================================================================
// Backend regression tests.
// ===========================================================================

// --- config.num ------------------------------------------------------------
test('config.num: blank/whitespace/invalid env falls back to the default (never 0)', () => {
  const N = config._num;
  const VAR = 'PTI_TEST_NUM';
  try {
    process.env[VAR] = '';
    assert.equal(N(VAR, 4000, { min: 0 }), 4000, 'empty -> default, NOT 0 (which would disable the cache)');
    process.env[VAR] = '   ';
    assert.equal(N(VAR, 4000), 4000, 'whitespace -> default');
    process.env[VAR] = 'abc';
    assert.equal(N(VAR, 4000), 4000, 'non-numeric -> default');
    process.env[VAR] = '8080';
    assert.equal(N(VAR, 3000, { min: 1, max: 65535 }), 8080, 'valid in range -> used');
    process.env[VAR] = '-5';
    assert.equal(N(VAR, 3000, { min: 1, max: 65535 }), 3000, 'out of range -> default');
    process.env[VAR] = '70000';
    assert.equal(N(VAR, 3000, { min: 1, max: 65535 }), 3000, 'above max -> default');
  } finally {
    delete process.env[VAR];
  }
});

test('config no longer exposes the dead/misleading riskFreeRate', () => {
  assert.equal(config.riskFreeRate, undefined);
  assert.ok(config.cache && typeof config.cache.quoteMs === 'number');
});

// --- TtlCache eviction + clock safety --------------------------------------
test('TtlCache evicts the oldest entry once at capacity (bounded memory)', () => {
  const c = new TtlCache(3); // small cap for the test
  c.set('a', 1);
  c.set('b', 2);
  c.set('c', 3);
  c.set('d', 4); // over cap -> evict oldest ('a')
  assert.equal(c.getStale('a'), null, 'oldest entry evicted');
  assert.equal(c.getStale('d'), 4, 'newest entry kept');
  assert.equal(c.store.size, 3, 'size stays bounded');
  // Re-setting an existing key must NOT evict (size unchanged).
  c.set('d', 5);
  assert.equal(c.store.size, 3);
  assert.equal(c.getStale('b'), 2);
});

test('TtlCache.ageOf never returns a negative age across a backward clock step', () => {
  const realNow = Date.now;
  try {
    let clock = 5000;
    Date.now = () => clock;
    const c = new TtlCache();
    c.set('k', 1);
    clock = 4000; // clock jumps BACKWARD 1s (NTP correction)
    assert.equal(c.ageOf('k'), 0, 'age clamped to >= 0, never negative');
  } finally {
    Date.now = realNow;
  }
});

// --- synthetic expiries are never in the past ------------------------------
test('synthetic getExpiries never offers a past-dated default expiry', () => {
  // Late in the month (after the 25th) it must roll to next month.
  const lateJan = fallback.getExpiries('NIFTY', new Date(2026, 0, 28)).expiries;
  assert.match(lateJan[0], /-Feb-2026$/, 'after the 25th -> next month');
  // ON the 25th it must ALSO roll: the synthetic contract expires that day at
  // 15:30 IST, so offering it would be a same-day (intraday-expired) default.
  // (This is the edge the real-clock check below trips on the 25th.)
  const on25 = fallback.getExpiries('NIFTY', new Date(2026, 0, 25)).expiries;
  assert.match(on25[0], /-Feb-2026$/, 'on the 25th -> roll to next month (expires intraday)');
  // The 24th still uses THIS month's 25th (a full day of time-to-expiry remains).
  const on24 = fallback.getExpiries('NIFTY', new Date(2026, 0, 24)).expiries;
  assert.match(on24[0], /-Jan-2026$/, 'the 24th -> this month (still in the future)');
  // Early in the month it uses this month's 25th.
  const earlyJan = fallback.getExpiries('NIFTY', new Date(2026, 0, 10)).expiries;
  assert.match(earlyJan[0], /-Jan-2026$/);
  // And, with the real clock, the nearest synthetic expiry is always in the future
  // — on EVERY day of the month, including the 25th (the bug this locks).
  const near = new Date(parseExpiryMs(fallback.getExpiries('NIFTY').expiries[0]));
  assert.ok(near.getTime() > Date.now(), 'default synthetic expiry is in the future');
});

// --- Yahoo parsers ---------------------------------------------------------
test('parseQuote keeps change and changePct consistent when prevClose is 0/missing', () => {
  // prevClose === 0: must NOT report a non-zero change with a 0% pct.
  const zero = freeProvider.parseQuote('X', { regularMarketPrice: 100, previousClose: 0 });
  assert.equal(zero.change, 0);
  assert.equal(zero.changePct, 0);
  // Normal case still works.
  const up = freeProvider.parseQuote('X', { regularMarketPrice: 110, previousClose: 100 });
  assert.equal(up.change, 10);
  assert.equal(up.changePct, 10);
  // Missing prevClose -> null prevClose, 0 change/pct (consistent).
  const none = freeProvider.parseQuote('X', { regularMarketPrice: 50 });
  assert.equal(none.prevClose, null);
  assert.equal(none.change, 0);
  assert.equal(none.changePct, 0);
});

test('parseQuote THROWS on a non-numeric price (so the orchestrator falls back to stale/synthetic)', () => {
  // A string/NaN price would otherwise be surfaced as a `source:'live'` quote with
  // ltp:null instead of triggering graceful degradation.
  assert.throws(() => freeProvider.parseQuote('X', { regularMarketPrice: 'abc', previousClose: 90 }), /usable price/);
  assert.throws(() => freeProvider.parseQuote('X', {}), /usable price/);
  assert.equal(freeProvider.parseQuote('X', { regularMarketPrice: 100, previousClose: 90 }).ltp, 100);
});

test('parseHistory returns an EMPTY series (not all-null candles) when close is missing', () => {
  const result = { timestamp: [1000, 2000, 3000], indicators: { quote: [{ open: [1, 2, 3], volume: [9, 9, 9] }] } };
  assert.deepEqual(freeProvider.parseHistory('X', result).candles, [], 'no usable close -> empty');
  // Individual null closes are skipped; valid rows kept.
  const mixed = { timestamp: [1, 2, 3], indicators: { quote: [{ close: [10, null, 12] }] } };
  const candles = freeProvider.parseHistory('X', mixed).candles;
  assert.equal(candles.length, 2);
  assert.deepEqual(candles.map((c) => c.c), [10, 12]);
});

test('parseHistory drops a row with a non-finite timestamp (regression: a NaN `t` crashes istDate() on the live tick)', () => {
  // A misaligned/short Yahoo `timestamp` array can pair a VALID close with an undefined
  // (or NaN) ts. The old filter only checked the close, so t = ts[i] * 1000 = NaN slipped
  // through and later threw in istDate()'s `new Date(NaN).toISOString()`, silently
  // stalling the live-forward tick (and a NaN `t` also breaks the seriesFor sort).
  const bad = { timestamp: [1000, undefined, 3000], indicators: { quote: [{ close: [10, 11, 12] }] } };
  const candles = freeProvider.parseHistory('X', bad).candles;
  assert.equal(candles.length, 2, 'the undefined-timestamp row is dropped');
  assert.deepEqual(candles.map((c) => c.c), [10, 12]);
  assert.ok(candles.every((c) => Number.isFinite(c.t)), 'no candle carries a non-finite timestamp');
});

test('market-closed intraday fallback: lastSessionCandles keeps only the most recent trading day', () => {
  // Three UTC days of 5-min bars; the helper must return only the final day's, so
  // the "1D" view shows the last real session instead of a multi-day blob.
  const D = 864e5;
  const day = (base, n) => Array.from({ length: n }, (_, i) => ({ t: base + i * 3e5, c: 100 + i }));
  const candles = [...day(0, 4), ...day(D, 4), ...day(2 * D, 3)];
  const last = freeProvider.lastSessionCandles(candles);
  assert.equal(last.length, 3, 'only the final UTC day survives');
  const lastDay = new Date(2 * D).toISOString().slice(0, 10);
  assert.ok(last.every((c) => new Date(c.t).toISOString().slice(0, 10) === lastDay), 'all from the last day');
  // Degenerate inputs do not throw.
  assert.deepEqual(freeProvider.lastSessionCandles([]), [], 'empty -> empty');
  assert.equal(freeProvider.lastSessionCandles(day(0, 5)).length, 5, 'a single session is returned whole');
});

test('isIntradayInterval flags only the intraday Yahoo intervals', () => {
  for (const iv of ['1m', '5m', '15m', '30m', '60m', '90m', '1h']) assert.equal(freeProvider.isIntradayInterval(iv), true, iv);
  for (const iv of ['1d', '1wk', '1mo', '3mo']) assert.equal(freeProvider.isIntradayInterval(iv), false, iv);
});

// --- symbol-map consistency ------------------------------------------------
test('getOptionChain rejects a non-NSE index (SENSEX) clearly instead of mis-querying NSE', async () => {
  // SENSEX is quotable via Yahoo but has no NSE option chain. The guard runs
  // before any network call, so this is offline-safe.
  await assert.rejects(() => freeProvider.getOptionChain('SENSEX'), /not available from NSE/);
});

test('synthetic getHistory honours the chart timeframe (interval spacing + range count)', () => {
  // No opts -> 60 daily candles (back-compat with the original default).
  assert.equal(fallback.getHistory('NIFTY').candles.length, 60);

  // 1D preset: 5-minute spacing, ~78 intraday points.
  const intraday = fallback.getHistory('NIFTY', { interval: '5m', range: '1d' });
  assert.equal(intraday.candles.length, 78);
  assert.equal(intraday.candles[1].t - intraday.candles[0].t, 5 * 60 * 1000, '5-minute spacing');

  // 1Y preset: daily spacing, ~250 points, strictly increasing time, no NaN.
  const year = fallback.getHistory('NIFTY', { interval: '1d', range: '1y' });
  assert.equal(year.candles.length, 250);
  assert.equal(year.candles[1].t - year.candles[0].t, 24 * 3600 * 1000, 'daily spacing');
  assertNoNaN(year, 'year history');
  for (let i = 1; i < year.candles.length; i++) {
    assert.ok(year.candles[i].t > year.candles[i - 1].t, 'time strictly increasing');
  }
});

// ===========================================================================
// fetchWithTimeout: the abort timer must cover the response BODY, not just the
// headers (regression — a stalled/trickling body used to hang the request
// forever: neither resolve nor reject, freezing the tournament boot + ticks
// behind it, and the stale-cache/synthetic fallbacks never fired because they
// only fire on a rejection). Drives a LOCAL stub server — no live network.
// ===========================================================================
test('fetchWithTimeout aborts a STALLED response body (timer covers the whole read)', async () => {
  const { createServer } = await import('node:http');
  const sockets = new Set();
  // A stub upstream that sends headers + a few body bytes, then never finishes.
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100000' });
    res.write('{"chart":'); // partial body — the rest never arrives
  });
  server.on('connection', (s) => sockets.add(s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => freeProvider.fetchWithTimeout(`http://127.0.0.1:${port}/hang`, {}, 500),
      /abort/i,
      'a stalled body must REJECT (AbortError), never hang'
    );
    assert.ok(Date.now() - t0 < 5000, 'rejected promptly, near the configured timeout');
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

test('fetchWithTimeout still serves a normal completing response (ok/status/json surface)', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true,"n":42}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const res = await freeProvider.fetchWithTimeout(`http://127.0.0.1:${port}/fine`, {}, 2000);
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, n: 42 });
    assert.equal(await res.text(), '{"ok":true,"n":42}');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
