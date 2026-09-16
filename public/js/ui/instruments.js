// ---------------------------------------------------------------------------
// ui/instruments.js
// Small shared helpers about contracts: a best-effort lot-size lookup and an
// expiry-date parser. Lot sizes change over time and differ per stock, so
// these are sensible DEFAULTS — always editable in the order ticket.
// ---------------------------------------------------------------------------

// F&O lot sizes used to pre-fill the ticket. Editable in the ticket, but a wrong default is not
// harmless: the Strategy Builder sizes every leg from it, so max profit, max loss, margin and
// breakeven on that screen are all wrong by the same factor.
//
// ★ THE INDEX ROWS MUST MATCH `FNO_INDICES` in tournament/universe.mjs, AND FOR MONTHS THEY DID
// NOT. This table carried BANKNIFTY 15 and FINNIFTY 40 — the pre-November-2024 contract sizes —
// while universe.mjs and all three backtest CLIs carried 35 and 65. NIFTY had been updated here to
// 75 and the other two had not, which is what a half-finished edit looks like rather than a
// deliberate difference. A BANKNIFTY leg was being built at 43% of the real contract.
// `test/ui-instruments.test.mjs` now cross-locks the overlap, the same way the NSE holiday list is
// locked across its two copies, so the two tables cannot drift apart again in silence.
const LOT_SIZES = {
  NIFTY: 75,
  BANKNIFTY: 35,
  FINNIFTY: 65,
  // ★ NOT cross-locked: MIDCPNIFTY is not in FNO_INDICES (no bot trades it), so nothing in this
  // repo can confirm it. It is left as found rather than guessed at — treat it as unverified and
  // check NSE's contract circular before relying on it.
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
