// ---------------------------------------------------------------------------
// marketHours.js  (server side)
// Works out whether the NSE cash/F&O session is open right now, in IST.
// The frontend has its own copy for the live clock; the server uses this to
// tag API responses with a market-state hint.
//
// Regular session: 09:15-15:30 IST, Monday-Friday.
// Pre-open       : 09:00-09:15 IST.
// Weekends and listed holidays are CLOSED.
// ---------------------------------------------------------------------------

'use strict';

// NSE trading-holiday list (YYYY-MM-DD, IST calendar dates) — days the regular
// equity / F&O session is CLOSED all day. Source: official NSE 2026 trading
// holidays (nseindia.com), cross-checked against major brokers (Zerodha, Kotak,
// Angel One). NSE republishes this every year, so UPDATE THIS LIST EACH JANUARY.
//
// Only WEEKDAY closures are listed: festivals that fall on a Sat/Sun in 2026
// (Mahashivratri 15 Feb, Id-ul-Fitr 21 Mar, Independence Day 15 Aug) are already
// non-trading days and need no entry. Diwali Laxmi Pujan (Sun 8 Nov 2026) has
// only a special one-hour "Muhurat" session — it is NOT a full-day holiday, so
// it is deliberately absent; the full-day Diwali closure is Balipratipada
// (10 Nov). Keep this array IDENTICAL to public/js/core/marketHours.js.
const HOLIDAYS = [
  '2026-01-15', // Special holiday (Maharashtra municipal elections)
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Ram Navami
  '2026-03-31', // Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id (Eid ul-Adha)
  '2026-06-26', // Muharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali (Balipratipada)
  '2026-11-24', // Guru Nanak Jayanti
  '2026-12-25', // Christmas
];

// ★ THE LIST HAS AN EXPIRY, AND IT FAILS OPEN — which is the dangerous direction.
// It is hand-maintained one year at a time, so from 1 January of the year after the last one it
// lists, every NSE holiday reads as an ordinary trading session: getMarketState() says REGULAR,
// isOpen true, while the exchange is shut. Nothing downstream can notice that on its own (a
// holiday and a quiet trading day look identical from here), so the coverage is derived FROM THE
// LIST — it can never drift from it separately — and then published on every market-state read
// and shouted once at boot. Callers that must not INVENT a session (the advisor's staleness
// count, the feed sampler) already skip dates outside it.
// ★ A YEAR IS "COVERED" ONLY IF THE LIST HOLDS A FULL YEAR OF IT — year-PRESENCE is not enough.
// Otherwise the first 2027 date pasted in ahead of the rest (a half-finished update, or a stray
// out-of-year entry) switches the alarm off while fourteen holidays are still missing, which is
// exactly the silent-wrong state this whole mechanism exists to prevent. NSE publishes 13-17
// weekday closures a year, so a real list clears this floor with room to spare and a partial one
// does not.
const MIN_DATES_PER_COVERED_YEAR = 8;

// Which years does a holiday list actually cover? Returns a sorted array of "YYYY" strings —
// ONE shape for this concept everywhere, so no caller has to remember whether it got a Set.
function holidayYearsOf(holidays = HOLIDAYS) {
  const perYear = new Map();
  for (const d of holidays || []) {
    const y = String(d).slice(0, 4);
    perYear.set(y, (perYear.get(y) || 0) + 1);
  }
  return [...perYear.entries()]
    .filter(([, n]) => n >= MIN_DATES_PER_COVERED_YEAR)
    .map(([y]) => y)
    .sort();
}

const HOLIDAY_YEARS = Object.freeze(holidayYearsOf(HOLIDAYS));

// Does the hand-maintained list actually cover the year this IST date falls in? `false` means
// "I cannot tell a holiday from a trading day on this date", NOT "this is a trading day".
function holidaysCoverDate(date = new Date()) {
  return HOLIDAY_YEARS.includes(String(istParts(date).year));
}

// The boot-time shout. Returns a warning string when "now" has outrun the list, else null — a
// plain return value rather than a console.log so it is testable with an INJECTED clock: a test
// that read the wall clock for session logic would go red on its own schedule.
function holidayCoverageWarning(now = new Date()) {
  if (holidaysCoverDate(now)) return null;
  const year = istParts(now).year;
  const last = HOLIDAY_YEARS[HOLIDAY_YEARS.length - 1] || '(none)';
  return (
    `WARNING: the NSE holiday list covers ${HOLIDAY_YEARS.join(', ')} but it is now ${year} in IST. ` +
    `Until it is updated, every ${year} exchange holiday will be reported as a normal trading ` +
    `session (the list fails OPEN). Update HOLIDAYS in BOTH src/marketHours.js and ` +
    `public/js/core/marketHours.js from nseindia.com's ${year} trading-holiday circular. ` +
    `Last year listed: ${last}.`
  );
}

// ★ THE BOOT SHOUT IS NOT ENOUGH ON ITS OWN. This process is deliberately kept awake round the
// clock by an external pinger, so a container that starts in December runs straight through the
// lapse with nothing ever printed — the one moment the warning exists for is the one moment a
// boot-only check cannot see. This wrapper is therefore safe to call on a timer: it prints at most
// once per IST day, and nothing at all while the list is current.
let lastCoverageWarningDay = null;
function reportHolidayCoverage(now = new Date(), log = console.warn) {
  const warning = holidayCoverageWarning(now);
  if (!warning) return null; // list is current — say nothing, ever
  const day = isoDate(istParts(now));
  if (day === lastCoverageWarningDay) return null; // already said so today
  lastCoverageWarningDay = day;
  log(warning);
  return warning;
}

// Convert "now" into IST parts no matter what timezone the server runs in.
// IST has no daylight saving, so a fixed +5:30 offset is correct year-round.
// We shift the absolute epoch by +5:30 and read the parts with the UTC getters —
// this is correct on any host, INCLUDING hosts that observe DST. (The earlier
// version used getTimezoneOffset() + local getters, which is off by an hour for
// a few hours around the host's own DST transition.)
function istParts(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 3600000); // +5:30
  return {
    date: ist,
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth() + 1,
    day: ist.getUTCDate(),
    weekday: ist.getUTCDay(), // 0 = Sunday .. 6 = Saturday
    minutesSinceMidnight: ist.getUTCHours() * 60 + ist.getUTCMinutes(),
  };
}

function isoDate(p) {
  const mm = String(p.month).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${p.year}-${mm}-${dd}`;
}

// Returns { state, isOpen, reason, holidayListStale } where state is one of:
// 'REGULAR' | 'PREOPEN' | 'CLOSED'.
//
// `holidayListStale` is true when the holiday list does not cover the queried date's year, i.e.
// the holiday branch below could not have fired even if that date IS a holiday. It rides on every
// return (a weekend's answer does not depend on the list, but a caller should not have to know
// which branch produced its answer to know whether the list was consulted usefully).
function getMarketState(date = new Date()) {
  const p = istParts(date);
  const PREOPEN_START = 9 * 60; // 09:00
  const OPEN = 9 * 60 + 15; // 09:15
  const CLOSE = 15 * 60 + 30; // 15:30
  const stale = !HOLIDAY_YEARS.includes(String(p.year));

  if (p.weekday === 0 || p.weekday === 6) {
    return { state: 'CLOSED', isOpen: false, reason: 'Weekend', holidayListStale: stale };
  }
  if (HOLIDAYS.includes(isoDate(p))) {
    return { state: 'CLOSED', isOpen: false, reason: 'Exchange holiday', holidayListStale: stale };
  }
  const m = p.minutesSinceMidnight;
  if (m >= PREOPEN_START && m < OPEN) {
    return { state: 'PREOPEN', isOpen: false, reason: 'Pre-open session', holidayListStale: stale };
  }
  if (m >= OPEN && m < CLOSE) {
    return { state: 'REGULAR', isOpen: true, reason: 'Regular session', holidayListStale: stale };
  }
  return { state: 'CLOSED', isOpen: false, reason: 'Outside trading hours', holidayListStale: stale };
}

module.exports = {
  getMarketState,
  HOLIDAYS,
  HOLIDAY_YEARS,
  holidayYearsOf,
  holidaysCoverDate,
  holidayCoverageWarning,
  reportHolidayCoverage,
};
