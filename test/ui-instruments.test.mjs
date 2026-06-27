// ---------------------------------------------------------------------------
// test/ui-instruments.test.mjs
// The contract helpers (public/js/ui/instruments.js): timezone-stable expiry
// parsing and the best-effort lot-size lookup. These are pure functions (no
// DOM), so no harness is needed.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { guessLotSize, parseExpiryMs } from '../public/js/ui/instruments.js';

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
