// ---------------------------------------------------------------------------
// test/ui-instruments.test.mjs
// The contract helpers (public/js/ui/instruments.js): timezone-stable expiry
// parsing and the best-effort lot-size lookup. These are pure functions (no
// DOM), so no harness is needed.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guessLotSize, parseExpiryMs, LOT_SIZES } from '../public/js/ui/instruments.js';

test('parseExpiryMs builds 15:30 IST (= 10:00 UTC) regardless of host timezone', () => {
  // Month is 0-based: Jun = 5. 15:30 IST == 10:00 UTC on the same calendar day.
  assert.equal(parseExpiryMs('26-Jun-2026'), Date.UTC(2026, 5, 26, 10, 0));
  assert.equal(parseExpiryMs('01-Jan-2027'), Date.UTC(2027, 0, 1, 10, 0));
});

test('parseExpiryMs falls back to ~7 days ahead for an unrecognised label', () => {
  const days = (parseExpiryMs('not-a-date') - Date.now()) / 86400000;
  assert.ok(days > 6.9 && days < 7.1, `expected ~7 days, got ${days}`);
});

test('guessLotSize returns known sizes (case-insensitive) and 1 for unknown', () => {
  assert.equal(guessLotSize('NIFTY'), 75);
  assert.equal(guessLotSize('reliance'), 250); // case-insensitive
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
test('every index lot size matches the server-side F&O contract table', async () => {
  const { FNO_INDICES } = await import('../tournament/universe.mjs');
  const overlap = Object.keys(FNO_INDICES).filter((s) => s in LOT_SIZES);
  assert.ok(overlap.length >= 3, `expected the index symbols to overlap, got ${overlap.join(',')}`);
  for (const sym of overlap) {
    assert.equal(
      LOT_SIZES[sym], FNO_INDICES[sym].lotSize,
      `${sym}: the ticket pre-fills ${LOT_SIZES[sym]} but every bot and backtest trades ${FNO_INDICES[sym].lotSize}`,
    );
  }
});
