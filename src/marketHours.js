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

// Returns { state, isOpen, reason } where state is one of:
// 'REGULAR' | 'PREOPEN' | 'CLOSED'.
function getMarketState(date = new Date()) {
  const p = istParts(date);
  const PREOPEN_START = 9 * 60; // 09:00
  const OPEN = 9 * 60 + 15; // 09:15
  const CLOSE = 15 * 60 + 30; // 15:30

  if (p.weekday === 0 || p.weekday === 6) {
    return { state: 'CLOSED', isOpen: false, reason: 'Weekend' };
  }
  if (HOLIDAYS.includes(isoDate(p))) {
    return { state: 'CLOSED', isOpen: false, reason: 'Exchange holiday' };
  }
  const m = p.minutesSinceMidnight;
  if (m >= PREOPEN_START && m < OPEN) {
    return { state: 'PREOPEN', isOpen: false, reason: 'Pre-open session' };
  }
  if (m >= OPEN && m < CLOSE) {
    return { state: 'REGULAR', isOpen: true, reason: 'Regular session' };
  }
  return { state: 'CLOSED', isOpen: false, reason: 'Outside trading hours' };
}

module.exports = { getMarketState, HOLIDAYS };
