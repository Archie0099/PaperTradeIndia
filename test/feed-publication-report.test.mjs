// feed-publication-report.test.mjs — locks the FOUR outcomes the feed-publication report tells apart.
//
// WHY THIS FILE EXISTS
// `backtest/research/feed-publication-log.mjs --report` is the only thing that reads the feed log,
// and its whole job is to distinguish four shapes that look nearly identical in the raw samples:
//
//   (a) a close appeared and never moved          -> "first value +Xh" (+ "no revision observed")
//   (b) a close appeared and was later CHANGED    -> "REVISED at +Xh: A -> B"
//   (c) a close appeared and then went null       -> "★ WITHDRAWN: served a close, then null again"
//   (d) a close appeared, went null, and CAME BACK-> "★ WITHDRAWN at +Xh, RETURNED by +Yh"
//
// Those labels are quoted straight into the project notes and steer a real decision (whether a session
// may be recorded from the bell quote when the daily row has no close). A report that mislabels one
// of them writes a wrong fact into the docs, and until now nothing tested it — the tool grew all
// four branches by hand, each after a real mislabelling in production.
//
// The log is DATA, so the fixture is a hand-built log rather than a live fetch: the four shapes
// here have all been observed for real, but waiting for the feed to produce them again is not a test.
// It runs the real CLI in a child process (the tool refuses to be imported — it is a CLI by design),
// against a temp log passed with `--log`, so the committed log is never read or written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = join(ROOT, 'backtest', 'research', 'feed-publication-log.mjs');

// 2026-09-11 is a Friday and is NOT in the app's NSE holiday list, so the report classifies it as a
// real session. That matters: the report deliberately refuses to read a publication lag off a day
// the exchange was shut, and a non-session fixture would exercise the wrong branch entirely.
const SESSION = '2026-09-11';
// 2026-09-14 (Ganesh Chaturthi) IS in the list. The feed still served a 09-14 row, and an early
// version of this report filed that as "session 2026-09-14 … NEVER appeared (still null at +14h)" —
// which reads later as a 14-hour publication lag on a day the exchange never opened. That is the
// single measurement this whole log exists to make, so the classification gets its own test.
const HOLIDAY = '2026-09-14';
const bellOf = (date) => Date.parse(`${date}T10:00:00.000Z`); // 15:30 IST
const BELL = bellOf(SESSION);

// One sample row, in exactly the shape `sample()` writes.
const row = (sym, hoursSinceClose, close, date = SESSION) => ({
  at: bellOf(date) + hoursSinceClose * 3600000,
  sym,
  date,
  close,
  adjclose: close,
  volume: close == null ? null : 1000,
  marketTime: BELL + 60000,
  marketPrice: close == null ? 100 : close,
  hoursSinceClose: +hoursSinceClose.toFixed(2),
});

// The four outcomes, one symbol each, plus a symbol seen ONLY before the bell.
const FIXTURE = [
  // (a) served, unchanged, and WATCHED across the window a withdrawal has been seen in (+8..+21h)
  row('SETTLED.NS', 1.3, 101.5),
  row('SETTLED.NS', 12.0, 101.5),
  row('SETTLED.NS', 24.5, 101.5),
  // (a2) served and unchanged, but only ever sampled OUTSIDE that window — the report must not let
  // this read as "the close stayed put", because nobody looked while it might have been withdrawn.
  row('UNWATCHED.NS', 1.3, 606.5),
  row('UNWATCHED.NS', 24.5, 606.5),
  // (b) served, then the value changed
  row('REVISED.NS', 1.3, 202.5),
  row('REVISED.NS', 8.7, 203.75),
  // (c) served, then withdrawn and still gone at the latest sample
  row('GONE.NS', 1.3, 303.5),
  row('GONE.NS', 8.7, null),
  row('GONE.NS', 24.5, null),
  // (d) served, withdrawn, then back at the same value
  row('ROUNDTRIP.NS', 1.3, 404.5),
  row('ROUNDTRIP.NS', 8.7, null),
  row('ROUNDTRIP.NS', 24.5, 404.5),
  // (e) only ever seen while the session was still running — a forming bar, not a published close
  row('FORMING.NS', -3.2, 505.5),
  // (f) a row the feed served for a day the exchange was SHUT. A close that never appears here is
  // not a lag — there was nothing to publish.
  row('HOLIDAYROW.NS', 5.0, null, HOLIDAY),
  row('HOLIDAYROW.NS', 20.0, null, HOLIDAY),
];

function runReport() {
  const dir = mkdtempSync(join(tmpdir(), 'pti-feedlog-'));
  const logPath = join(dir, 'log.json');
  try {
    writeFileSync(logPath, JSON.stringify(FIXTURE, null, 1));
    return execFileSync(process.execPath, [TOOL, '--report', '--log', logPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Count NON-OVERLAPPING occurrences of a literal. Used instead of a bare `includes` so an assertion
// fails if a label ever starts printing twice as well as if it stops printing at all.
const count = (haystack, needle) => haystack.split(needle).length - 1;

// The lines the report prints for ONE symbol: its own line plus the indented lines under it.
//
// ★ NOT `out.slice(indexOf(symA), indexOf(symB))`. The report groups by session date and lists the
// symbols in the order they first appear in the time-sorted log, so FORMING.NS (sampled before the
// bell) is printed FIRST — ahead of the symbol it was being used to bound. That slice ran backwards
// and returned '', which made a "this label must NOT appear here" assertion pass while checking
// nothing at all. Bounding by the report's own indentation cannot go backwards.
function blockFor(out, sym) {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.trimStart().startsWith(`${sym} `));
  assert.notEqual(start, -1, `${sym} must appear in the report at all`);
  let end = start + 1;
  while (end < lines.length && lines[end].startsWith('      ')) end++;
  return lines.slice(start, end).join('\n');
}

test('the report labels the session, and reads a forming-bar-only symbol as nothing to read yet', () => {
  const out = runReport();
  assert.equal(count(out, `=== session ${SESSION} ===`), 1, 'the fixture date must be read as a real session');
  const block = blockFor(out, 'FORMING.NS');
  assert.equal(
    count(block, 'samples  1  (all taken before the bell — forming bar only, nothing to read yet)'),
    1,
    'a pre-bell sample is a running intraday print, never a published close',
  );
  assert.equal(count(block, 'first value'), 0, 'a forming bar must never be read as a published close');
});

test('(a) a close that never moves, WATCHED across the window, reports no revision plainly', () => {
  const block = blockFor(runReport(), 'SETTLED.NS');
  assert.equal(count(block, 'samples  3  first value +1.3h = 101.50'), 1);
  assert.equal(count(block, 'no revision observed across the samples taken'), 1);
  assert.equal(count(block, 'NO SAMPLE fell in'), 0, 'it WAS watched, so no caveat');
  assert.equal(count(block, '★ WITHDRAWN'), 0, 'nothing was ever withdrawn here');
});

test('(a2) an UNWATCHED session says so — "no revision" is not evidence when nobody looked', () => {
  // ★ The report already refuses to read a late null as "never published". This is the SAME caution
  // in reverse, and it was missing: a session sampled only just after the bell and again the next
  // day prints "no revision observed", which reads as "the close stayed put" — when in truth no
  // sample fell in the +8h..+21h window where the one observed withdrawal happened. A missed
  // scheduled sample is the normal case on a laptop, so a sampling gap must never become evidence.
  // Plain substrings, not regex: `+` and `.` are regex metacharacters and the window text is full of
  // them, so a hand-written pattern here is easy to get silently wrong (it was, once).
  const block = blockFor(runReport(), 'UNWATCHED.NS');
  assert.equal(count(block, 'NO SAMPLE fell in the +8h..+21h window'), 1, 'it names the window it missed');
  assert.equal(count(block, 'NOT evidence the close stayed put'), 1, 'and says plainly what cannot be concluded');
  assert.equal(count(block, 'no revision observed across the samples taken'), 0,
    'and it must NOT also print the unqualified line, which reads as "nothing happened"');
});

test('(b) a changed close reports a REVISION with both values', () => {
  const block = blockFor(runReport(), 'REVISED.NS');
  assert.equal(count(block, 'REVISED at +8.7h: 202.50 -> 203.75'), 1, 'the one real revision must be named once');
  // A revision must NOT also claim nothing changed.
  assert.equal(count(block, 'no revision observed'), 0);
});

test('(c) a close that went null and stayed null reports a WITHDRAWAL, not "still null"', () => {
  const block = blockFor(runReport(), 'GONE.NS');
  assert.equal(count(block, '★ WITHDRAWN: served a close, then null again at +24.5h'), 1);
  // It must not be mistaken for a close that never arrived.
  assert.equal(count(block, 'not published yet'), 0, 'a value WAS served — this is a withdrawal, not a lag');
  assert.equal(count(block, 'RETURNED'), 0, 'this one never came back');
});

test('(d) a close that came back reports WITHDRAWN + RETURNED, and that the value was unchanged', () => {
  const block = blockFor(runReport(), 'ROUNDTRIP.NS');
  assert.equal(count(block, '★ WITHDRAWN at +8.7h, RETURNED by +24.5h (same value)'), 1);
  // The round trip must not be reported as still missing — that was the shape the old report printed
  // silently, and it is the one this branch exists for.
  assert.equal(count(block, '★ WITHDRAWN: served a close'), 0);
});

test('a listed NSE holiday is labelled NOT A SESSION and excluded from the reading', () => {
  const out = runReport();
  assert.equal(count(out, `=== NOT A SESSION: ${HOLIDAY} ===  (listed NSE holiday — no session)`), 1);
  assert.equal(count(out, `=== session ${HOLIDAY} ===`), 0, 'a shut exchange must never be counted as a session');
  // The footer's own arithmetic must agree: one session date in, one non-session excluded.
  assert.equal(count(out, '★ Count only the 1 SESSION date above toward that.'), 1);
  assert.equal(count(out, '1 date is marked NOT A SESSION'), 1);
  // And its missing close must not be read as a lag.
  assert.equal(count(blockFor(out, 'HOLIDAYROW.NS'), '★ WITHDRAWN'), 0, 'nothing was published, so nothing was withdrawn');
});

test('each of the four outcomes is reported exactly once — no label bleeds onto another symbol', () => {
  const out = runReport();
  assert.equal(count(out, 'first value +'), 5, 'a, a2, b, c, d each served a close; the forming-only symbol did not');
  assert.equal(count(out, '      REVISED at +'), 1);
  assert.equal(count(out, '★ WITHDRAWN at +'), 1);
  assert.equal(count(out, '★ WITHDRAWN: served a close'), 1);
  assert.equal(count(out, 'forming bar only'), 1);
});
