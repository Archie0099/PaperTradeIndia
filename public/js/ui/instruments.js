// ---------------------------------------------------------------------------
// ui/instruments.js
// Small shared helpers about contracts: a best-effort lot-size lookup and an
// expiry-date parser. Lot sizes change over time and differ per stock, so
// these are sensible DEFAULTS — always editable in the order ticket.
// ---------------------------------------------------------------------------

// F&O lot sizes. ★ WHERE THESE ACTUALLY REACH THE SCREEN, corrected after a browser check showed
// the older wording here ("used to pre-fill the ticket") was not how it works: typing a symbol
// into the order ticket does NOT fill its Lot size box — that box defaults to 1 and is only set
// when a whole instrument is seeded into the ticket. The real consumers are `guessLotSize`'s two
// callers: the OPTION CHAIN, which sizes the instrument it hands to the ticket, and the STRATEGY
// BUILDER, which sizes every leg it builds. A wrong value is not harmless in either: on the
// builder, max profit, max loss, margin and breakeven are all wrong by the same factor.
// (Verified in a real browser: a built BANKNIFTY leg carries 30, NIFTY 65, FINNIFTY 60.)
//
// ★ THE INDEX ROWS MUST MATCH `FNO_INDICES` in tournament/universe.mjs, AND FOR MONTHS THEY DID
// NOT. This table carried BANKNIFTY 15 and FINNIFTY 40 — the pre-November-2024 contract sizes —
// while universe.mjs and all three backtest CLIs carried 35 and 65. NIFTY had been updated here to
// 75 and the other two had not, which is what a half-finished edit looks like rather than a
// deliberate difference. A BANKNIFTY leg was being built at 43% of the real contract.
// `test/ui-instruments.test.mjs` now cross-locks the overlap, the same way the NSE holiday list is
// locked across its two copies, so the two tables cannot drift apart again in silence.
// ★★ THEN CHECKED AGAINST NSE ITSELF, WHICH THE CROSS-LOCK COULD NEVER DO. Comparing the two
// tables proves they AGREE; it cannot prove they are RIGHT — and they were not. NSE circular
// NSE/FAOP/70616 (Ref 176/2025, 03-Oct-2025), "Revision in Market Lot of Derivative Contracts on
// Indices", read from the primary PDF, gives Present -> Revised:
//     NIFTY 75 -> 65 | BANKNIFTY 35 -> 30 | FINNIFTY 65 -> 60 | MIDCPNIFTY 140 -> 120
//     (NIFTYNXT50 unchanged at 25)
// In force from 28-Oct-2025 EOD; weekly/monthly contracts ran on the old sizes until the
// 30-Dec-2025 expiry, quarterly/half-yearly revised 30-Dec-2025 EOD. No later revision found.
// Both tables had been carrying the circular's PRESENT column — the values it replaced.
//
// ★★★ THE TWO TABLES NOW DELIBERATELY DIFFER, AND THAT IS THE POINT. They answer two different
// questions, which is why one number could never be right for both:
//   * THIS table sizes a contract you are building RIGHT NOW (the ticket pre-fill, the Option
//     Chain, the Strategy Builder). The only correct answer is today's contract, so these carry
//     the circular's REVISED column.
//   * `FNO_INDICES` sizes a 20-year REPLAY. The true lot size is TIME-VARYING across it (NIFTY has
//     been 50, 75 and 65 at different times) while that table holds ONE value for all history, so
//     today's number is not automatically the right one there — and changing it would restate
//     every published F&O board figure. It keeps its documented convention.
// ★ So the cross-lock is NOT deleted, which would let real drift back in. It now requires each
// overlapping symbol to either AGREE or be DECLARED below with its reason — and it fails on a
// stale declaration too, so this map cannot rot once the conventions are reconciled.
const LOT_SIZES = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 60,
  // ★ NOT cross-locked: MIDCPNIFTY is in no server table (no bot trades it), so nothing in this
  // repo could confirm it and it was long flagged unverified. The circular settles it: the 75 that
  // sat here matched NEITHER the old 140 nor the new 120 — it was simply wrong, not stale.
  MIDCPNIFTY: 120,
  RELIANCE: 250,
  TCS: 175,
  INFY: 400,
  HDFCBANK: 550,
  SBIN: 750,
};

// Every symbol whose browser lot size deliberately differs from `FNO_INDICES`, and what the
// browser value is required to BE. The cross-lock reads this, so a difference is allowed only when
// someone declared it — and only at the declared number.
//
// ★★ `nseLot` IS LOAD-BEARING, NOT DECORATION. The first version of this map held only a reason
// string and the lock merely checked that a reason existed — which permitted ANY value for a
// declared symbol and so re-opened the exact bug the cross-lock was built to catch: a
// later review set BANKNIFTY back to 15 (the pre-Nov-2024 contract, the half-finished edit
// that sized a leg at 43% of the real one) and the whole file stayed green. Pinning the value
// closes it. ★ This is NOT the "re-typed literal" trap (W17) inverted: `nseLot` is not a copy of
// `LOT_SIZES` taken for comparison's sake, it is the contract the named circular DECLARES, so the
// assertion reads "the ticket sizes what NSE says it sizes" and the number's source travels with
// it. Changing the table alone now fails; changing both is a deliberate, sourced edit.
const LOT_SIZE_DIVERGENCE = {
  NIFTY: {
    nseLot: 65,
    backtestLot: 75,
    circular: 'NSE/FAOP/70616 (Ref 176/2025, 03-Oct-2025), in force 28-Oct-2025 EOD',
    why: 'NSE cut the contract 75 -> 65. The backtest keeps 75 as its documented all-history '
      + 'convention; changing it would restate every published F&O board figure.',
  },
  BANKNIFTY: {
    nseLot: 30,
    backtestLot: 35,
    circular: 'NSE/FAOP/70616 (Ref 176/2025, 03-Oct-2025), in force 28-Oct-2025 EOD',
    why: 'NSE cut the contract 35 -> 30. The backtest keeps 35, for the reason above.',
  },
  FINNIFTY: {
    nseLot: 60,
    backtestLot: 65,
    circular: 'NSE/FAOP/70616 (Ref 176/2025, 03-Oct-2025), in force 28-Oct-2025 EOD',
    why: 'NSE cut the contract 65 -> 60. The backtest keeps 65, for the reason above.',
  },
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

export { LOT_SIZES, LOT_SIZE_DIVERGENCE, guessLotSize, parseExpiryMs };
