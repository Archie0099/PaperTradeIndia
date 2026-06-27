// ---------------------------------------------------------------------------
// test/data-sanitize.test.mjs
// Locks sanitizeCandles (backtest/data.mjs) — the load-time guard that trims early
// stock-split / bad-print / frozen-placeholder artifacts out of the ~20y daily history
// the tournament now backfills. A fake ±50-90% bar would otherwise book fake P&L on any
// bot holding that name and poison cross-sectional ML/factor features (seen on real
// NESTLEIND/BAJAJFINSV/LT data).
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { sanitizeCandles, loadCandles, trailingSuspectJump } from '../backtest/data.mjs';
import freeProvider from '../src/dataSources/freeProvider.js';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'backtest', 'data');

// Build a candle series from an array of closes (daily timestamps).
const series = (closes) => closes.map((c, i) => ({ t: i * 864e5, c }));
const closes = (cs) => cs.map((c) => c.c);

test('a CORRUPT cache file does not throw — loadCandles ignores it and falls through', async () => {
  // loadCandles JSON.parse'd the on-disk cache WITHOUT a try/catch, so one
  // corrupt file (a write interrupted by a crash) threw -> mapLimit rejects fast -> the WHOLE
  // ~200-symbol tournament boot aborts (the tournament stays permanently null until a redeploy).
  // A corrupt cache must now be IGNORED (fall through to a fresh fetch / synthetic), never fatal.
  const sym = 'ZZ_CORRUPT_PROBE';
  const file = join(CACHE_DIR, `${sym}-1d-20y.json`);
  // Two flavours of bad cache: (1) truncated/invalid JSON; (2) valid JSON but garbage close VALUES
  // (a non-truncation corruption / external tampering). Both must fall through to a usable series.
  const badContents = [
    '{"symbol":"ZZ_CORRUPT_PROBE","source":"yahoo","candles":[', // truncated JSON
    '{"symbol":"ZZ_CORRUPT_PROBE","source":"yahoo","candles":[{"t":1,"c":"abc"},{"t":2,"c":null},{"t":3}]}', // valid JSON, bad closes
  ];
  // The cache dir is created on demand by loadCandles, but this test writes the probe
  // file BEFORE the first loadCandles call, so ensure the dir exists (a fresh clone has none).
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    for (const bad of badContents) {
      writeFileSync(file, bad);
      let res;
      await assert.doesNotReject(async () => { res = await loadCandles(sym, { interval: '1d', range: '20y' }); }, 'a corrupt cache must not throw');
      assert.ok(res && Array.isArray(res.candles) && res.candles.length > 0, 'falls through to a usable series instead of aborting');
      assert.ok(res.candles.every((c) => Number.isFinite(c.c) && c.c > 0), 'the returned series has only finite, positive closes (no NaN leaks in)');
    }
  } finally {
    rmSync(file, { force: true });
  }
});

test('trailingSuspectJump flags only an UNRESOLVED final-window jump', () => {
  const mk = (cs) => cs.map((c, i) => ({ t: i * 864e5, c }));
  assert.equal(trailingSuspectJump(mk([100, 101, 99, 100, 10])), true, 'a -90% final bar is suspect (unconfirmed by construction)');
  assert.equal(trailingSuspectJump(mk([100, 101, 99, 100, 102])), false, 'a clean tail is not suspect');
  assert.equal(trailingSuspectJump(mk([100, 10, 100, 101, 99, 100, 102, 101])), false, 'an OLD mid-series jump is not trailing (dropBadPrints owns that case)');
  assert.equal(trailingSuspectJump(mk([100])), false, 'degenerate input is safe');
  assert.equal(trailingSuspectJump([]), false, 'empty input is safe');
});

test('a trailing >40% jump in a CACHED file triggers ONE fresh re-fetch (frozen-bad-print regression)', async () => {
  // The bug: a Yahoo bad print on the LAST bar(s) of a backfill fetch survives the
  // sanitiser BY DESIGN (a late move might be real; no snap-back is visible yet) —
  // but the write-once disk cache then FREEZES it mid-series forever: the healing
  // snap-back lands in the tournament's LIVE bars, which the sanitiser never sees
  // together with the cached prefix. A cache whose FINAL few bars hold a >40% jump
  // is now treated as suspect and re-fetched once (Yahoo has usually corrected it).
  const sym = 'ZZTRAILGLITCH';
  const file = join(CACHE_DIR, `${sym}-1d-20y.json`);
  mkdirSync(CACHE_DIR, { recursive: true });
  const DAY = 864e5;
  // 80 clean bars around ~100, then a -90% bad print on the FINAL cached bar.
  const glitched = Array.from({ length: 81 }, (_, i) => ({ t: i * DAY, c: i === 80 ? 10 : 100 + (i % 3) }));
  // What Yahoo serves NOW: the same history with the bad print corrected (+1 new bar).
  const corrected = Array.from({ length: 82 }, (_, i) => ({ t: i * DAY, c: 100 + (i % 3) }));
  const orig = freeProvider.getHistory;
  try {
    writeFileSync(file, JSON.stringify({ symbol: sym, source: 'yahoo', candles: glitched }));
    let fetched = 0;
    freeProvider.getHistory = async () => { fetched++; return { symbol: sym, candles: corrected }; };
    const res = await loadCandles(sym, { interval: '1d', range: '20y' });
    assert.equal(fetched, 1, 'the suspect cache triggered exactly one re-fetch');
    assert.equal(res.candles.length, corrected.length, 'the corrected series replaced the frozen glitch');
    assert.ok(res.candles.every((c) => c.c > 50), 'the -90% bad print is gone');

    // OFFLINE the cache still serves as-is — availability is never sacrificed.
    writeFileSync(file, JSON.stringify({ symbol: sym, source: 'yahoo', candles: glitched }));
    freeProvider.getHistory = async () => { throw new Error('HTTP 404'); }; // fails fast (no retry)
    const off = await loadCandles(sym, { interval: '1d', range: '20y' });
    assert.equal(off.candles.length, glitched.length, 'offline: the cached series is served unchanged');

    // A CLEAN cache never re-fetches (the fast path stays byte-identical).
    writeFileSync(file, JSON.stringify({ symbol: sym, source: 'yahoo', candles: corrected }));
    let extra = 0;
    freeProvider.getHistory = async () => { extra++; return { symbol: sym, candles: corrected }; };
    await loadCandles(sym, { interval: '1d', range: '20y' });
    assert.equal(extra, 0, 'a clean cache is served without any network call');
  } finally {
    freeProvider.getHistory = orig;
    rmSync(file, { force: true });
  }
});

test('a clean rising series is returned unchanged', () => {
  const s = series(Array.from({ length: 300 }, (_, i) => 100 * 1.001 ** i));
  assert.equal(sanitizeCandles(s).length, s.length, 'no trim on clean data');
  assert.deepEqual(sanitizeCandles(s), s);
});

test('a real crash (<40% single bar) is NOT trimmed (it is a market move, not an artifact)', () => {
  // A -33% crash bar (the worst real NSE large-cap day ~ -34%) that does NOT snap back —
  // the level steps down and continues normally (no >40% recovery bar). The surrounding
  // bars VARY (a real walk), so nothing trips the frozen-flat rule.
  const cs = [];
  for (let i = 0; i < 150; i++) cs.push(1000 + i); // a rising walk, then...
  for (let i = 0; i < 150; i++) cs.push(1149 * 0.67 + i * 0.5); // ...a -33% step down, then a normal walk
  const out = sanitizeCandles(series(cs));
  assert.equal(out.length, 300, 'a sub-40% move is preserved');
});

test('a persistent split/step >40% trims the pre-artifact history (NESTLEIND/BAJAJFINSV shape)', () => {
  // 50 bars at ~500, then a -76% split to ~120 that PERSISTS — the unadjusted-split shape.
  const pre = Array.from({ length: 50 }, (_, i) => 500 + i);
  const post = Array.from({ length: 200 }, (_, i) => 120 + i * 0.1);
  const out = sanitizeCandles(series([...pre, ...post]));
  assert.equal(out.length, 200, 'the pre-split era is dropped, the clean suffix kept');
  assert.ok(out[0].c < 130, `starts on the post-split base, got ${out[0].c}`);
  // No surviving >40% single-bar move.
  const c = closes(out);
  for (let i = 1; i < c.length; i++) assert.ok(Math.abs(c[i] / c[i - 1] - 1) <= 0.4, 'no artifact remains');
});

test('a phantom spike-and-revert (LT shape) drops ONLY the glitch bar, keeping the real bars', () => {
  // ...300, 145 (a -52% phantom), 295 (a +103% snap-back to ~the real level), then normal. The bad-print
  // pass now SURGICALLY removes just the 145 glitch bar — the real 300 (before) and 295 (after, within
  // ~15% of 300) are KEPT (previously the early-trim discarded the real 300 too; the fix is more precise).
  const out = sanitizeCandles(series([300, 145, 295, 296, 297, 298, ...Array.from({ length: 100 }, (_, i) => 300 + i)]));
  const c = closes(out);
  assert.equal(out.length, 105, 'exactly one bar (the 145 glitch) is dropped');
  assert.ok(!c.includes(145), 'the glitch bar is gone');
  assert.ok(c[0] === 300 && c.includes(295), 'the real bars before/after the glitch are kept');
  for (let i = 1; i < c.length; i++) assert.ok(Math.abs(c[i] / c[i - 1] - 1) <= 0.4, 'no >40% phantom remains');
});

test('a GENUINE big move that recovers to a DIFFERENT real level is KEPT (IndusInd 2020 shape)', () => {
  // A real >40% move whose recovery lands at a NEW, persistently-different
  // level (here a -48% crash to 520 that recovers to 720 = -28% from 1000, then continues) must NOT be
  // treated as a glitch. A glitch snaps back to ~the SAME price; a real move settles at a new level.
  const cs = [...Array.from({ length: 200 }, () => 1000), 520, ...Array.from({ length: 100 }, (_, i) => 720 + i * 0.1)];
  const out = sanitizeCandles(series(cs));
  const c = closes(out);
  assert.equal(out.length, cs.length, 'no bar dropped — the real crash/recovery is preserved');
  assert.ok(c.includes(520), 'the genuine -48% crash bar is KEPT (not dropped as a fake round-trip)');
});

test('a leading frozen-flat placeholder run is dropped (NESTLEIND pre-2010 shape)', () => {
  // 30 identical "placeholder" closes, then real (rising) data WITHOUT a big jump.
  const flat = new Array(30).fill(527.05);
  const real = Array.from({ length: 100 }, (_, i) => 527.05 * 1.002 ** (i + 1));
  const out = sanitizeCandles(series([...flat, ...real]));
  assert.ok(out.length <= 100, 'the frozen-flat run was dropped');
  assert.notEqual(out[0].c, out[1].c, 'the surviving series is not frozen');
});

test('a LATE PERSISTENT step is left visible (not silently discarding most of the history)', () => {
  // A late >40% step that PERSISTS (a genuine event / unhandled late split) must NOT trim away the
  // clean first 60% — only EARLY artifacts are trimmed. (A late ROUND-TRIP glitch is the separate
  // case below, cleaned by the bad-print pass.) The step never returns, so it is NOT a glitch.
  const cs = Array.from({ length: 300 }, (_, i) => (i < 250 ? 1000 : 400)); // -60% step at idx250 that stays
  const out = sanitizeCandles(series(cs));
  assert.equal(out.length, 300, 'a late persistent step is preserved (not trimmed, not glitch-dropped)');
  assert.equal(out[0].c, 1000, 'the clean first 60% is intact');
});

test('a bad-print ROUND-TRIP anywhere is dropped (NIFTYBEES Dec-2019 shape)', () => {
  // The real NIFTYBEES glitch: the price "fell" to ~1/10th for two bars then SNAPPED BACK — a fake
  // -90% / +897% round-trip that would book huge fake P&L. It is mid-series (not early) and not a
  // persistent step, so ONLY the round-trip pass catches it. The two glitch bars are dropped; the
  // rest of the (clean) history is kept.
  const cs = Array.from({ length: 300 }, () => 1000);
  cs[200] = 100; cs[201] = 101; // 2-bar dip to ~1/10th, then back to 1000 at idx 202
  const out = sanitizeCandles(series(cs));
  assert.equal(out.length, 298, 'the 2 glitch bars are dropped; everything else kept');
  const c = closes(out);
  assert.ok(!c.includes(100) && !c.includes(101), 'the fake bars are gone');
  for (let i = 1; i < c.length; i++) assert.ok(Math.abs(c[i] / c[i - 1] - 1) <= 0.4, 'no >40% round-trip remains');
});

test('a GENUINE multi-day round-trip MOVE (INDUSINDBK 2020 COVID shape) is KEPT — the window is deliberately tight', () => {
  // The real, shipped-data regression that a "widen the round-trip window" change would cause: INDUSINDBK
  // spiked +44.7% on 2020-03-26 (a genuine COVID-recovery bar), then FADED back over the next 4 days to
  // within ~15% of the pre-spike level. That is a REAL volatile move — NOT a data glitch — so every bar
  // MUST be kept. The snap-back lands 5 bars after the jump's start (outside the tight MAX_GLITCH_BARS
  // window), so the round-trip pass correctly leaves it alone. (Locks that we never drop this real move.)
  const pre = Array.from({ length: 200 }, () => 301.3); // a flat-ish lead-in (real walk simplified)
  const move = [435.9, 411.1, 413.4, 351.3, 342.25]; // +44.7% spike then a 4-day fade back to ~+13.6%
  const post = Array.from({ length: 100 }, (_, i) => 342 + i * 0.2);
  const out = sanitizeCandles(series([...pre, ...move, ...post]));
  const c = closes(out);
  assert.ok(c.includes(435.9), 'the genuine +44.7% COVID-recovery bar is KEPT (not dropped as a fake round-trip)');
  assert.ok(c.includes(411.1) && c.includes(413.4) && c.includes(351.3), 'every bar of the real multi-day move is kept');
});

test('a tight ≤3-bar glitch IS still dropped (the widest run the snap-back window catches)', () => {
  // The round-trip pass still does its job for SHORT bad prints: a 3-bar dip to ~1/10th that snaps back
  // within MAX_GLITCH_BARS bars of the jump is dropped (real Yahoo glitches like NIFTYBEES are 1–2 bars,
  // well inside this). A 3-bar run snaps back at index jump+4 = i+1+3, the tight window's last slot.
  const cs = Array.from({ length: 300 }, () => 1000);
  cs[200] = 95; cs[201] = 92; cs[202] = 98; // 3-bar dip, then back to 1000 at idx 203
  const out = sanitizeCandles(series(cs));
  assert.equal(out.length, 297, 'all 3 tight-glitch bars are dropped; everything else kept');
  const c = closes(out);
  assert.ok(![95, 92, 98].some((g) => c.includes(g)), 'the 3 fake bars are gone');
});

test('an EARLY split is trimmed even when a LATE split also exists (early+late interaction)', () => {
  // The bug: the early-prefix trim accumulated firstGood over EVERY >40% jump ANYWHERE, then only
  // trimmed when that max index landed early (firstGood < 60%). So a LATE persistent split (which we
  // WANT to leave visible) pushed firstGood past the 0.6 gate and thereby SUPPRESSED trimming of a
  // genuine EARLY split — leaving a fake split bar in the series (a >40% one-bar P&L on any holder +
  // poisoned cross-sectional features). The fix gates the accumulation to EARLY indices, so only an
  // early jump marks the trim boundary; a late step is left visible without defeating the early trim.
  const earlyPre = Array.from({ length: 50 }, (_, i) => 500 + i * 0.2);    // pre early-split @~500
  const mid = Array.from({ length: 200 }, (_, i) => 120 + i * 0.1);         // post early-split, clean base @~120
  const latePost = Array.from({ length: 80 }, (_, i) => 480 + i * 0.1);     // post LATE +300% split @~480
  // early split @idx50 (~15%, IN the first 60%); late split @idx250 (~76%, in the last 40%).
  const out = sanitizeCandles(series([...earlyPre, ...mid, ...latePost]));
  const c = closes(out);
  assert.equal(out.length, 280, 'the EARLY split era (50 bars) is trimmed DESPITE the late split');
  assert.ok(out[0].c < 130, `series starts on the post-early-split base (~120), got ${out[0].c}`);
  assert.ok(c.includes(480), 'the LATE persistent step is left visible (not trimmed, not glitch-dropped)');
  // Exactly ONE >40% jump remains — the deliberately-kept late step, NOT the trimmed early one.
  let jumps = 0;
  for (let i = 1; i < c.length; i++) if (Math.abs(c[i] / c[i - 1] - 1) > 0.4) jumps++;
  assert.equal(jumps, 1, 'only the kept late step remains; the early split bar is gone');
});

test('degenerate inputs are returned as-is (no crash)', () => {
  assert.deepEqual(sanitizeCandles([]), []);
  assert.deepEqual(sanitizeCandles([{ t: 0, c: 100 }]).length, 1);
  assert.equal(sanitizeCandles(null), null);
});
