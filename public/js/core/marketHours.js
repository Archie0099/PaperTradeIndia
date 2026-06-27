// ---------------------------------------------------------------------------
// core/marketHours.js  (client side)
// Same logic as the server's marketHours.js, but in the browser so the status
// bar clock and market state update every second without a network call.
//
// All times are computed in IST (UTC+5:30, no daylight saving).
// ---------------------------------------------------------------------------

// NSE trading-holiday list (YYYY-MM-DD) — mirror of src/marketHours.js; keep the
// two arrays IDENTICAL (or fetch the server's via /api/status, which the status
// bar already prefers once loaded). Source: official NSE 2026 trading holidays
// (nseindia.com), cross-checked against major brokers. UPDATE EACH JANUARY.
//
// Only WEEKDAY closures are listed: festivals on a Sat/Sun in 2026 (Mahashivratri
// 15 Feb, Id-ul-Fitr 21 Mar, Independence Day 15 Aug) need no entry; Diwali
// Muhurat (Sun 8 Nov) is a special session, not a full-day holiday — the full-day
// Diwali closure is Balipratipada (10 Nov).
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

// Get the current moment expressed in IST. IST is a FIXED UTC+5:30 (no DST), so
// we shift the absolute epoch by +5:30 and then read the parts with the **UTC**
// getters below. This is correct on any host timezone — including hosts that
// observe DST. (The previous version used getTimezoneOffset(), which is off by
// an hour for a few hours around the host's own DST transition.)
function istNow(date = new Date()) {
  return new Date(date.getTime() + 5.5 * 3600000);
}

function isoDate(ist) {
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// "HH:MM:SS" in IST, for the live clock. No "IST" suffix — the status bar
// already shows a static "IST" label next to it, so a suffix here would double
// it up ("IST  10:00:00 IST").
function istClockString(date = new Date()) {
  const ist = istNow(date);
  const hh = String(ist.getUTCHours()).padStart(2, '0');
  const mm = String(ist.getUTCMinutes()).padStart(2, '0');
  const ss = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// Returns { state:'REGULAR'|'PREOPEN'|'CLOSED', isOpen, reason }.
function getMarketState(date = new Date(), holidays = HOLIDAYS) {
  const ist = istNow(date);
  const weekday = ist.getUTCDay();
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const PREOPEN = 9 * 60;
  const OPEN = 9 * 60 + 15;
  const CLOSE = 15 * 60 + 30;

  if (weekday === 0 || weekday === 6) return { state: 'CLOSED', isOpen: false, reason: 'Weekend' };
  if (holidays.includes(isoDate(ist)))
    return { state: 'CLOSED', isOpen: false, reason: 'Exchange holiday' };
  if (minutes >= PREOPEN && minutes < OPEN)
    return { state: 'PREOPEN', isOpen: false, reason: 'Pre-open (09:00-09:15)' };
  if (minutes >= OPEN && minutes < CLOSE)
    return { state: 'REGULAR', isOpen: true, reason: 'Regular session' };
  return { state: 'CLOSED', isOpen: false, reason: 'Outside trading hours' };
}

export { getMarketState, istClockString, HOLIDAYS };
