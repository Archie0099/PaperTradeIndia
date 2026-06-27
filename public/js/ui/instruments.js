// ---------------------------------------------------------------------------
// ui/instruments.js
// Small shared helpers about contracts: a best-effort lot-size lookup and an
// expiry-date parser. Lot sizes change over time and differ per stock, so
// these are sensible DEFAULTS — always editable in the order ticket.
// ---------------------------------------------------------------------------

// Approximate F&O lot sizes. Edit freely; the ticket lets you override too.
const LOT_SIZES = {
  NIFTY: 75,
  BANKNIFTY: 15,
  FINNIFTY: 40,
  MIDCPNIFTY: 75,
  RELIANCE: 250,
  TCS: 175,
  INFY: 400,
  HDFCBANK: 550,
  SBIN: 750,
};

function guessLotSize(symbol) {
  return LOT_SIZES[(symbol || '').toUpperCase()] || 1;
}

// Parse an NSE-style expiry like "26-Jun-2026" into a millisecond timestamp.
// Falls back to "7 days from now" if the string is missing/unrecognised, so
// the option tools always have a usable time-to-expiry.
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

function parseExpiryMs(label) {
  if (typeof label === 'string') {
    const m = label.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
    if (m) {
      const day = Number(m[1]);
      const mon = MONTHS[m[2][0].toUpperCase() + m[2].slice(1, 3).toLowerCase()];
      const year = Number(m[3]);
      if (mon != null) {
        // Expiry is end-of-day 15:30 IST, which is 10:00 UTC. Build the instant
        // in UTC so it is identical on every device. `new Date(y,m,d,15,30)`
        // would be 15:30 in the BROWSER's local timezone, shifting time-to-expiry
        // (and thus the displayed Greeks) by the host's UTC offset off-IST.
        return Date.UTC(year, mon, day, 10, 0);
      }
    }
  }
  return Date.now() + 7 * 24 * 3600 * 1000;
}

export { LOT_SIZES, guessLotSize, parseExpiryMs };
