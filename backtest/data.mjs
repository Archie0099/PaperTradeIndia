// ---------------------------------------------------------------------------
// backtest/data.mjs
// Loads daily history for a symbol, FREE and offline-friendly, in this order:
//   1. a cached JSON under backtest/data/   (instant + reproducible), else
//   2. a live fetch from Yahoo via the existing free provider (then cached), else
//   3. the offline SYNTHETIC provider (clearly labelled) — for wiring only, NOT a
//      meaningful leaderboard, since synthetic prices have no real edge to find.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Backend providers are CommonJS — import the default export, then call methods.
import freeProvider from '../src/dataSources/freeProvider.js';
import fallback from '../src/dataSources/fallback.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(HERE, 'data');

// A single-bar price move beyond this is treated as a DATA/CORPORATE-ACTION ARTIFACT,
// not a real market move. Empirically (a full-universe scan over 20y of NSE daily data),
// genuine single-day large-cap moves top out ~34% (a 2008-crash bar); every move above
// 40% was a stock split / bonus / demerger / bad print that Yahoo did NOT back-adjust
// in the raw close (e.g. NESTLEIND 2010 −76%, BAJAJFINSV 2008 demerger −93%, an LT 2006
// phantom −51%/+95% one-bar glitch). Such a fake bar would book a fake ±50-90% P&L on
// any bot holding that name through it and poison cross-sectional ML/factor features.
const ARTIFACT_RET = 0.40;
// A leading run of >= this many IDENTICAL closes is placeholder data, not real prices
// (real quotes ~never repeat to the paisa for many days). e.g. NESTLEIND's first ~875
// bars are a frozen flat line before its real history begins.
const MIN_FLAT_RUN = 10;
// A bad-print ROUND-TRIP must SNAP BACK within this many bars of the jump's start to count as a
// glitch — i.e. the snap-back bar is at most index (jump-start + MAX_GLITCH_BARS), so the glitch RUN
// itself is ≤ MAX_GLITCH_BARS−1 = 3 bars. This window is DELIBERATELY TIGHT, and widening it is a
// trap: a real instrument CAN move >40% and round-trip over several days in a genuine volatility
// shock (e.g. INDUSINDBK 2020-03-26 spiked +44.7% on the COVID-recovery bar, then FADED back to
// within ~15% of the pre-spike level over the next 4 days — a REAL move that MUST be kept). A wider
// window wrongly reclassifies such a multi-day real move as a glitch and DROPS real price bars
// (verified on real data). Real Yahoo bad prints (e.g. NIFTYBEES Dec-2019) are 1–2 bars, well inside
// this window; a longer round-trip is far more likely a real volatile move, so we leave it visible.
// NOTE: widening this to a literal 4-bar run regresses real moves like INDUSINDBK — it is kept tight
// on purpose; the constant means "snap-back within N bars of the jump", not "run of N".
const MAX_GLITCH_BARS = 4;
// How close to the PRE-glitch level the price must SNAP BACK for the jump to count as a glitch
// round-trip (not a real move). It must be TIGHT: a true Yahoo bad print returns to essentially the
// same real price (the real price barely moved in 1-4 days), whereas a GENUINE big move (e.g.
// IndusInd's +44.7% 2020-03-26 COVID-recovery bar) recovers to a NEW, persistently-different level
// ~28-40% away. A loose ±40% return band wrongly classified those real moves as glitches and DROPPED
// real price bars — so the return must land within ±GLITCH_RETURN_RET of `cur`.
const GLITCH_RETURN_RET = 0.15;

// Remove a bad-print ROUND-TRIP anywhere in the series: a short run of bars (1..MAX_GLITCH_BARS)
// that deviates >ARTIFACT_RET from the surrounding level and then SNAPS BACK to ~the SAME level. This
// is a Yahoo data glitch — e.g. NIFTYBEES "fell" to ~1/10th its price for two days in Dec-2019 then
// snapped back (a fake −90% / +897% round-trip that would book huge fake P&L on any bot holding it).
// It is DISTINCT from a split/demerger (a PERMANENT level shift that never returns — handled by the
// early-prefix trim) AND from a real big move that recovers to a DIFFERENT level: the snap-back must
// land within GLITCH_RETURN_RET of the pre-jump price, so a genuine crash/spike that settles at a new
// real level is KEPT. We DROP only the glitch bars (consistent with "only trim, never fabricate");
// the result keeps a clean timestamp gap that the backtester/alignSeries already handle.
function dropBadPrints(candles) {
  if (candles.length < 3) return candles;
  const out = [];
  let i = 0;
  while (i < candles.length) {
    out.push(candles[i]);
    const cur = candles[i].c;
    // A >ARTIFACT_RET jump at the NEXT bar — does the price SNAP BACK to ~cur (a glitch) within a few
    // bars, or recover to a different real level (a genuine move, which we KEEP)?
    if (cur > 0 && i + 1 < candles.length && candles[i + 1].c > 0 && Math.abs(candles[i + 1].c / cur - 1) > ARTIFACT_RET) {
      let returned = -1;
      // Look for a snap-back to ~cur within MAX_GLITCH_BARS bars of the jump's start (so j ≤ i+MAX_GLITCH_BARS,
      // i.e. the loop's `j < i+1+MAX_GLITCH_BARS`). This is intentionally TIGHT — see MAX_GLITCH_BARS:
      // a wider window drops genuine multi-day round-trip moves (the INDUSINDBK 2020 COVID-recovery bar).
      const maxJ = Math.min(i + 1 + MAX_GLITCH_BARS, candles.length);
      for (let j = i + 2; j < maxJ; j++) {
        if (candles[j].c > 0 && Math.abs(candles[j].c / cur - 1) <= GLITCH_RETURN_RET) { returned = j; break; }
      }
      if (returned > 0) { i = returned; continue; } // glitch = bars [i+1 .. returned-1]; skip them
    }
    i++;
  }
  return out;
}

// TRUE when the FINAL few bars of a series contain an as-yet-UNRESOLVED >ARTIFACT_RET
// jump — the one shape the sanitiser DELIBERATELY leaves alone (a late move might be a
// genuine crash/spike, and its healing snap-back isn't visible yet). Used by loadCandles
// to decide a cached file is SUSPECT and worth one fresh re-fetch: if the jump was a
// Yahoo bad print caught at fetch time, the write-once cache would otherwise FREEZE it
// mid-series forever (the snap-back lands in the tournament's LIVE bars, which the
// sanitiser never sees together with the cached prefix). A REAL move simply re-confirms
// on the re-fetch, and once newer bars trail it, it stops looking "trailing" and never
// triggers again.
function trailingSuspectJump(candles) {
  const n = candles.length;
  if (n < 2) return false;
  const from = Math.max(1, n - MAX_GLITCH_BARS);
  for (let i = from; i < n; i++) {
    const prev = candles[i - 1].c, cur = candles[i].c;
    if (prev > 0 && cur > 0 && Math.abs(cur / prev - 1) > ARTIFACT_RET) return true;
  }
  return false;
}

// Clean a daily series of data/corporate-action artifacts, two ways:
//   (1) TRIM a leading artifact era (a frozen-flat placeholder run, or an EARLY >40% split/
//       demerger/bad-print), leaving the longest clean suffix — only EARLY (first ~60%), since a
//       late PERSISTENT >40% step is more likely a genuine event we'd rather leave visible.
//   (2) DROP a bad-print ROUND-TRIP anywhere (a >40% spike/dip that snaps back — a glitch, not a
//       split). See dropBadPrints. This catches mid/late artifacts the early-only trim cannot.
// alignSeries (portfolio/pairs) already handles a symbol that starts later / has a timestamp gap,
// so neither a trimmed prefix nor a dropped glitch needs special-casing downstream. Pure function.
function sanitizeCandles(candles) {
  if (!Array.isArray(candles) || candles.length < 2) return candles;
  // (0) FIRST drop bad-print round-trips ANYWHERE — BEFORE the early-trim. Otherwise an EARLY
  //     round-trip glitch would feed its >40% down/up legs into the prefix-boundary detection below
  //     and trim away the (real) history before it, instead of dropBadPrints surgically removing just
  //     the glitch bars. On the de-glitched series, the early-trim then only ever
  //     sees genuine leading frozen-flat runs + PERSISTENT splits.
  const clean = dropBadPrints(candles);
  // `firstGood` = the index of the first bar we TRUST; everything before it is the artifact
  // era. For a split/demerger jump the jump bar itself is the first clean bar (it's already
  // on the new, real price base), so we keep it; for a frozen-flat run or a non-positive
  // print, the first good bar is the one AFTER it.
  let firstGood = 0;
  // (1) a leading frozen-flat placeholder run -> real data begins after it.
  let lead = 0;
  while (lead + 1 < clean.length && clean[lead + 1].c === clean[lead].c) lead++;
  if (lead >= MIN_FLAT_RUN) firstGood = lead + 1;
  // (2) a single-bar move beyond ARTIFACT_RET is a split/bonus/demerger boundary (a PERSISTENT step;
  //     any round-trip glitch is already gone) -> trust the series from that bar onward. A non-positive
  //     print is itself bad -> skip it.
  // Only EARLY (first ~60%) artifacts may mark the trim boundary. Gating the accumulation
  // here — not just the final slice — matters: a LATE persistent >40% step (a genuine late
  // corporate action we WANT to leave visible) would otherwise raise firstGood past the 0.6
  // gate and thereby SUPPRESS trimming of a genuine EARLY artifact in the SAME series, leaving
  // a fake split bar in the history. Byte-identical for any series without a late >40% step.
  const earlyLimit = clean.length * 0.6;
  for (let i = 1; i < clean.length; i++) {
    const p0 = clean[i - 1].c, p1 = clean[i].c;
    if (!(p1 > 0)) { if (i + 1 < earlyLimit) firstGood = Math.max(firstGood, i + 1); continue; }
    if (!(p0 > 0)) continue; // the previous bar was bad (already handled); this one stands alone
    if (i < earlyLimit && Math.abs(p1 / p0 - 1) > ARTIFACT_RET) firstGood = Math.max(firstGood, i);
  }
  // Only TRIM EARLY artifacts (first ~60%); a late persistent step is left visible.
  return firstGood > 0 && firstGood < clean.length * 0.6 ? clean.slice(firstGood) : clean;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch daily/intraday history from Yahoo with a few RETRIES + backoff. The wide-universe
// (~200-symbol) cold boot fires a burst of requests, and Yahoo rate-limits bursts (HTTP 429)
// / has the odd transient 5xx or network blip — a single failure should retry rather than
// immediately fall back to a meaningless SYNTHETIC series. Bounded (3 tries) so a genuinely
// dead ticker (404) gives up fast and the boot moves on. Returns clean candles, or throws.
async function fetchYahooWithRetry(symbol, interval, range, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await freeProvider.getHistory(symbol, { interval, range });
      const candles = (res.candles || []).filter((c) => Number.isFinite(c.c) && c.c > 0);
      if (candles.length > 50) return candles;
      lastErr = new Error(`too few candles (${candles.length})`);
    } catch (e) {
      lastErr = e;
      // A 404 is a dead/renamed ticker — retrying won't help, so give up immediately and let
      // the boot drop it. Transient errors (429 rate-limit, 5xx, network) DO retry.
      if (/HTTP 404/.test(String(e && e.message))) break;
    }
    if (i < tries - 1) await sleep(400 * (i + 1)); // 400ms, then 800ms backoff
  }
  throw lastErr || new Error(`fetch failed for ${symbol}`);
}

// Re-base a series onto Yahoo's ADJUSTED close (split + dividend back-adjusted) —
// the price series a backtest must trade on. On RAW closes a 1:1 bonus looks like a
// fake −50% day (booking fake P&L and poisoning momentum/vol/ML features) and 20
// years of dividends are silently forfeited. Policy:
//   * If (nearly) every bar carries `a`, serve `c = a` and keep the raw close as
//     `craw` (display/participation reference). Bars missing `a` inside an
//     otherwise-adjusted series are DROPPED — mixing adjusted and raw scales in
//     one series would fabricate a jump, which is worse than a one-bar gap.
//   * If the series has no/few `a` fields (intraday responses carry none, and old
//     v1 caches predate the field), serve the raw closes unchanged — recent
//     intraday windows contain few corporate actions, and that limitation is
//     disclosed in METHODOLOGY.md.
function toAdjusted(candles) {
  const withAdj = candles.filter((c) => c.a != null && Number.isFinite(c.a) && c.a > 0);
  if (withAdj.length < candles.length * 0.9) return { candles, adjusted: false };
  return {
    candles: withAdj.map((c) => ({ ...c, c: c.a, craw: c.c })),
    adjusted: true,
  };
}

async function loadCandles(symbol, { interval = '1d', range = '5y', refresh = false } = {}) {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  // `-v2`: the cache format gained the adjusted close (`a`) — a v1 file (raw closes
  // only) must not satisfy a read, or that symbol would silently backtest unadjusted
  // forever. Bumping the name makes stale caches invisible; they refetch once.
  const file = join(CACHE_DIR, `${symbol.toUpperCase()}-${interval}-${range}-v2.json`);

  // The on-disk cache always stores the RAW Yahoo candles (the reproducible source of
  // truth); we ADJUST + SANITIZE on READ so those rules can evolve without re-fetching,
  // and log any trim so it is never silent (the project values honest data handling).
  const clean = (rawCandles, source) => {
    const based = toAdjusted(rawCandles);
    const candles = based.candles;
    const out = sanitizeCandles(candles);
    if (out.length < candles.length) {
      console.log(`data: sanitised ${symbol.toUpperCase()} (${interval}/${range}) — dropped ${candles.length - out.length} artifact bar(s).`);
    }
    return { candles: out, source: based.adjusted ? source : `${source} (unadjusted)` };
  };

  // 1. Cached on disk -> instant + reproducible. A CORRUPT/truncated cache file (e.g. a write
  // interrupted by a crash) must NOT throw — with the ~200-symbol cold boot that single bad file
  // would otherwise abort the whole tournament init (mapLimit rejects fast). Swallow the parse
  // error and fall through to a fresh live fetch instead (the bad file gets overwritten on success).
  if (!refresh && existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8'));
      // Validate the VALUES, not just "is a non-empty array": a cache file with garbage / NaN /
      // non-positive closes would otherwise mark a bot to NaN. Mirror the live-fetch filter; if it
      // empties the series, fall through to a fresh fetch. (Defense-in-depth — the app only writes
      // clean candles, so this guards external tampering / a non-truncation corruption.)
      const cc = (cached && Array.isArray(cached.candles) ? cached.candles : []).filter((c) => c && Number.isFinite(c.c) && c.c > 0);
      if (cc.length) {
        // A >40% jump within the LAST few cached bars is unconfirmed by construction
        // (see trailingSuspectJump): re-fetch ONCE so a bad print caught at fetch time
        // can't be frozen into the cache permanently. Yahoo has usually corrected it —
        // or the snap-back is now visible and dropBadPrints removes the round-trip. If
        // the re-fetch fails (offline / rate-limited), the cache still serves as-is —
        // availability is never sacrificed for this hygiene pass.
        if (interval === '1d' && trailingSuspectJump(cc)) {
          try {
            const fresh = await fetchYahooWithRetry(symbol, interval, range);
            writeFileSync(file, JSON.stringify({ symbol: symbol.toUpperCase(), source: 'yahoo', candles: fresh }));
            console.log(`data: re-fetched ${symbol.toUpperCase()} (${interval}/${range}) — a trailing >40% jump in the cache needed re-confirmation.`);
            return clean(fresh, 'yahoo (live, re-confirmed)');
          } catch {
            /* offline -> serve the cached data unchanged */
          }
        }
        return clean(cc, `${cached.source} (cached)`);
      }
    } catch {
      /* corrupt cache -> ignore it and re-fetch below */
    }
  }

  // 2. Live Yahoo via the free provider (with retry/backoff for the wide-universe cold boot).
  try {
    const candles = await fetchYahooWithRetry(symbol, interval, range);
    writeFileSync(file, JSON.stringify({ symbol: symbol.toUpperCase(), source: 'yahoo', candles }));
    return clean(candles, 'yahoo (live, now cached)');
  } catch {
    /* fall through to synthetic */
  }

  // 3. Offline synthetic (labelled): proves the wiring without any network.
  const syn = fallback.getHistory(symbol, { interval, range });
  return clean(syn.candles, 'synthetic (offline — wiring only)');
}

export { loadCandles, sanitizeCandles, trailingSuspectJump, toAdjusted };
