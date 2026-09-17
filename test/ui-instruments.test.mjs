// ---------------------------------------------------------------------------
// test/ui-instruments.test.mjs
// The contract helpers (public/js/ui/instruments.js): timezone-stable expiry
// parsing and the best-effort lot-size lookup. These are pure functions (no
// DOM), so no harness is needed.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guessLotSize, parseExpiryMs, LOT_SIZES, LOT_SIZE_DIVERGENCE } from '../public/js/ui/instruments.js';

test('parseExpiryMs builds 15:30 IST (= 10:00 UTC) regardless of host timezone', () => {
  // Month is 0-based: Jun = 5. 15:30 IST == 10:00 UTC on the same calendar day.
  assert.equal(parseExpiryMs('26-Jun-2026'), Date.UTC(2026, 5, 26, 10, 0));
  assert.equal(parseExpiryMs('01-Jan-2027'), Date.UTC(2027, 0, 1, 10, 0));
});

test('parseExpiryMs falls back to ~7 days ahead for an unrecognised label', () => {
  const days = (parseExpiryMs('not-a-date') - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, `expected ~7 days, got ${days}`);
});

// ★ UPDATED when the browser table moved to NSE's current contract (NIFTY 75 -> 65). This asserted
// `guessLotSize('NIFTY') === 75` — a literal re-typed from the table, which proves only that the
// code equals itself (W17) and goes stale on every genuine contract revision. What is worth
// locking here is the LOOKUP, not the value: it reads the table, ignores case, and falls back to 1
// for anything it does not know. Values are covered by the cross-lock below, against a real source.
test('guessLotSize reads the table, is case-insensitive, and falls back to 1', () => {
  assert.equal(guessLotSize('NIFTY'), LOT_SIZES.NIFTY);
  assert.equal(guessLotSize('reliance'), LOT_SIZES.RELIANCE, 'case-insensitive');
  assert.equal(guessLotSize('NiFtY'), LOT_SIZES.NIFTY, 'mixed case too');
  assert.equal(guessLotSize('ZZZ'), 1);
  assert.equal(guessLotSize(''), 1);
  assert.equal(guessLotSize(undefined), 1);
});

// --- the two lot-size tables must not drift apart ---------------------------
// ★ THIS IS A CROSS-LOCK, NOT A RESTATEMENT. Nothing here re-types a number: it compares the
// browser's table against `FNO_INDICES` in tournament/universe.mjs, which the server, the live
// bots and all three backtest CLIs already share. A test that re-typed "35" would only prove the
// code equals itself (the trap W17 records); this one fails the moment the two copies disagree,
// whichever of them changed.
//
// It exists because they DID disagree, for months and unnoticed: this table carried BANKNIFTY 15
// and FINNIFTY 40 (the pre-November-2024 contracts) while the server carried 35 and 65. NIFTY had
// been updated here and the other two had not. Nothing caught it because the old assertions above
// check NIFTY and RELIANCE — never the two symbols that had drifted.
// ★★ THE TWO TABLES NOW DELIBERATELY DIFFER, so the lock changed shape rather than being deleted.
// NSE cut the index contracts on 28-Oct-2025 (circular NSE/FAOP/70616). The browser table sizes a
// contract being built RIGHT NOW and must carry today's number; `FNO_INDICES` sizes a 20-year
// replay whose true lot size is time-varying, holds ONE value for all of it, and cannot be changed
// without restating every published F&O figure. One number was never going to be right for both.
//
// Deleting the lock would have let the ORIGINAL drift back in — the silent, half-finished edit
// that left BANKNIFTY at 15 and FINNIFTY at 40 for months. So a difference is still a failure
// UNLESS it is declared in `LOT_SIZE_DIVERGENCE`, at the number that declaration names.
// ★ ON W17, precisely: the declaration DOES carry a number (`nseLot`), so this is not the pure
// table-vs-table comparison it used to be. That is deliberate and it is not the trap W17 records.
// The trap is a test re-typing a literal from the code it checks, which proves only that the code
// equals itself; `nseLot` is not copied from `LOT_SIZES` — it is the contract the NAMED circular
// declares, so the assertion reads "the browser sizes what NSE says", and its source travels with
// it. Editing one alone fails; editing both is a deliberate, sourced change.
test('an index lot size either matches the server table or is a DECLARED divergence', async () => {
  const { FNO_INDICES } = await import('../tournament/universe.mjs');
  const overlap = Object.keys(FNO_INDICES).filter((s) => s in LOT_SIZES);
  assert.ok(overlap.length >= 3, `expected the index symbols to overlap, got ${overlap.join(',')}`);
  for (const sym of overlap) {
    if (LOT_SIZES[sym] === FNO_INDICES[sym].lotSize) continue;
    const decl = LOT_SIZE_DIVERGENCE[sym];
    assert.ok(
      decl && typeof decl.why === 'string' && decl.why.length > 20 && decl.circular,
      `${sym}: the chain and builder size legs at ${LOT_SIZES[sym]} but every bot and backtest trades `
        + `${FNO_INDICES[sym].lotSize}, and nothing declares why. Either fix the drift or add a `
        + `reason to LOT_SIZE_DIVERGENCE — an undeclared difference is the bug this lock exists for.`,
    );
    // ★ AND IT MUST BE THE DECLARED NUMBER. Accepting any value once a reason exists is what made
    // the first version of this lock useless: with NIFTY/BANKNIFTY/FINNIFTY blanket-declared, a
    // drift straight back to the old BANKNIFTY 15 passed. The declaration names NSE's contract, so
    // this asserts the browser sizes what the circular says — not merely that it differs.
    assert.equal(
      LOT_SIZES[sym], decl.nseLot,
      `${sym}: the chain and builder size legs at ${LOT_SIZES[sym]}, but ${decl.circular} puts the contract at `
        + `${decl.nseLot}. A declared divergence is allowed only at the declared number — otherwise `
        + `the declaration is a blank cheque and any drift on this symbol passes silently.`,
    );
    // ★★ AND THE SERVER END MUST BE PINNED TOO, or this lock protects only half of what it used to.
    // Every overlapping symbol is now a declared divergence, so the equality check above never runs
    // and NOTHING here would look at `FNO_INDICES` at all — a review verified that mutating
    // `FNO_INDICES.NIFTY.lotSize` from 75 to 100 left this file 5/5 green. That is precisely the
    // silent drift this lock exists to catch, moved to the table that sizes every F&O bot's
    // positions. Pinning BOTH ends means a divergence stays exactly the one that was signed off.
    assert.equal(
      FNO_INDICES[sym].lotSize, decl.backtestLot,
      `${sym}: the backtest trades ${FNO_INDICES[sym].lotSize} but the declared convention is `
        + `${decl.backtestLot}. If the backtest convention is being changed deliberately, update the `
        + `declaration (and expect every published F&O figure to be restated); if not, this is drift.`,
    );
  }
});

// The other direction, so the map cannot rot: once the two tables are reconciled for a symbol, its
// declaration must go too. Without this, a stale entry would silently pre-authorise the NEXT drift
// on that symbol — which is exactly the hole the original lock was closing.
test('no symbol is declared as diverging while the two tables actually agree', async () => {
  const { FNO_INDICES } = await import('../tournament/universe.mjs');
  for (const sym of Object.keys(LOT_SIZE_DIVERGENCE)) {
    assert.ok(sym in FNO_INDICES && sym in LOT_SIZES, `${sym} is declared but is not in both tables`);
    assert.notEqual(
      LOT_SIZES[sym], FNO_INDICES[sym].lotSize,
      `${sym}: the tables now AGREE, so its LOT_SIZE_DIVERGENCE entry is stale and must be removed `
        + `— leaving it would pre-authorise the next real drift on this symbol.`,
    );
  }
});
