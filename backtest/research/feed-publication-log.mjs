// feed-publication-log.mjs — WHEN does the free feed publish a daily close, and does that
// first value SETTLE or get revised?
//
// WHY THIS EXISTS
// The suggestion log can only record a day once the feed serves a usable close for it, so the
// feed's publication time — not the code's session rule — is what decides when a day is
// recorded. Two things about that are still unmeasured:
//   (1) WHEN a usable close first appears. Observed so far: one session had one by close+3h,
//       another still had `close: null` more than 12 hours after the bell.
//   (2) Whether that first value is FINAL. For the close+3h case, none of the ten prices
//       recorded from it match the close the feed serves for that date today — so a value
//       appearing is not the same event as a value settling.
// Sampling the same session repeatedly is the only way to separate the two.
//
// WHY IT READS THE RAW ENDPOINT
// src/dataSources/freeProvider.js skips any row whose close is null — correct (it must never
// invent a price), but it hides the exact state being measured here. So this goes straight to
// the chart API and reports the row as-is, nulls included.
//
// SCOPE: read-only. Fetches and appends to its own log file; touches no app state, no candle
// cache, and nothing the tournament reads.
//
// USAGE
//   node backtest/research/feed-publication-log.mjs            # take one sample, append to the log
//   node backtest/research/feed-publication-log.mjs --report   # summarise the log so far
//   node backtest/research/feed-publication-log.mjs --log <path>
//
// HOW TO RUN THE EXPERIMENT
// On a trading day take samples at roughly close+30m, +3h, +6h, and again the next morning
// (~+24h), then `--report`. NSE closes 15:30 IST. The report prints, per session date, when a
// non-null close was first seen and every time the value changed after that.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
// The NSE holiday list, from the app's own source rather than a second copy — a session's
// close that never appears is only evidence of a feed lag if there WAS a session that day.
import mh from '../../src/marketHours.js';
const { HOLIDAYS } = mh;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const SYMBOLS = ['%5ENSEI', 'RELIANCE.NS', 'TCS.NS', 'HDFCBANK.NS', 'INFY.NS', 'NIFTYBEES.NS'];

const args = process.argv.slice(2);
const logPath = args.includes('--log') ? args[args.indexOf('--log') + 1] : 'backtest/research/feed-publication-log.json';
const istDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const istTime = (ms) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
// NSE's bell for a given IST date, as a UTC instant (15:30 IST = 10:00Z).
const closeOf = (date) => Date.parse(`${date}T10:00:00.000Z`);
const load = () => (existsSync(logPath) ? JSON.parse(readFileSync(logPath, 'utf8')) : []);

async function sample() {
  const log = load();
  const at = Date.now();
  console.log(`sampling at ${istTime(at)} IST`);
  for (const sym of SYMBOLS) {
    try {
      const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`, { headers: { 'User-Agent': UA } });
      const txt = await res.text();
      if (!txt.trim()) throw new Error(`empty body (HTTP ${res.status}) — rate limited`);
      const r = JSON.parse(txt).chart.result[0];
      const q = r.indicators.quote[0];
      const adjArr = r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose;
      // ★ RECORD EVERY ROW IN THE WINDOW, NOT ONLY THE NEWEST. The first version logged the last
      // row alone, which was fine while one session was under observation — and blind the moment
      // the next session opened: on 2026-09-16 the midday sample logged the FORMING 09-16 row and
      // could not see that the 09-15 close (withdrawn overnight) had come BACK. Whether a withdrawn
      // close returns is the question this log exists to answer, so every row the feed serves is
      // recorded, each under its own date; the report groups by date, so nothing else changes.
      // ★ A row whose session has NOT CLOSED yet is a forming bar, not a published close; it is
      // recorded (a true record of what was served) with a NEGATIVE hoursSinceClose so the report
      // can exclude it from "first value" instead of reading a running intraday print as one.
      const lines = [];
      for (let i = 0; i < r.timestamp.length; i++) {
        const date = istDate(r.timestamp[i] * 1000);
        const entry = {
          at, sym, date,
          close: q.close[i] != null ? q.close[i] : null,
          adjclose: adjArr && adjArr[i] != null ? adjArr[i] : null,
          volume: q.volume && q.volume[i] != null ? q.volume[i] : null,
          marketTime: r.meta.regularMarketTime ? r.meta.regularMarketTime * 1000 : null,
          marketPrice: r.meta.regularMarketPrice != null ? r.meta.regularMarketPrice : null,
          hoursSinceClose: +((at - closeOf(date)) / 3600000).toFixed(2),
        };
        log.push(entry);
        const shown = entry.close == null ? 'NULL' : entry.close.toFixed(2);
        const age = entry.hoursSinceClose < 0 ? `FORMING (${entry.hoursSinceClose}h)` : `+${entry.hoursSinceClose}h`;
        lines.push(`${entry.date} ${shown.padStart(9)} ${age}`);
      }
      console.log(`  ${sym.padEnd(14)} ${lines.join('  |  ')}  (quote ${r.meta.regularMarketPrice})`);
    } catch (err) {
      console.error(`  ${sym.padEnd(14)} FAILED — ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 900)); // be polite to a free endpoint
  }
  writeFileSync(logPath, JSON.stringify(log, null, 1));
  console.log(`\nlog: ${logPath} (${log.length} samples)`);
}

// ★ THE WINDOW IN WHICH A WITHDRAWAL HAS ACTUALLY BEEN OBSERVED, from the only session where one
// was caught end to end (2026-09-15: served by +1.27h, gone at +8.69h, back by +20.84h). It is an
// OBSERVED range, not a law — one session is one session — and it exists here for one purpose: to
// stop the report implying a session was watched when it was not.
//
// WHY THIS MATTERS MORE THAN IT LOOKS. Without it a session sampled only in the hour after the
// bell prints "first value +0.98h / no revision observed across the samples taken", which reads as
// "the close was served and stayed" — when in truth nobody looked during the hours when it might
// have been taken back. That is the same error the report already guards in the other direction
// ("treat a late null as NOT SEEN, never as never published"), and it would quietly turn a gap in
// the sampling schedule into evidence of stability. A missed scheduled sample is the normal case
// on a laptop, so this had to be said out loud.
const WATCH_WINDOW = { from: 8, to: 21 };
function report() {
  const log = load();
  if (!log.length) { console.error(`${logPath} is empty — take a sample first.`); process.exit(1); }
  console.log(`${logPath}: ${log.length} samples\n`);
  // group by (session date, symbol) and walk the samples in time order
  const key = (e) => `${e.date}|${e.sym}`;
  const groups = new Map();
  for (const e of [...log].sort((a, b) => a.at - b.at)) {
    if (!groups.has(key(e))) groups.set(key(e), []);
    groups.get(key(e)).push(e);
  }
  const byDate = new Map();
  for (const [k, arr] of groups) {
    const [date, sym] = k.split('|');
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push({ sym, arr });
  }
  // ★ A DAILY ROW IS NOT A SESSION. The feed emits a row for days the exchange was shut — on
  // 2026-09-14 (Ganesh Chaturthi) it served a 09-14 row with a null close, and this report
  // dutifully filed it as "session 2026-09-14 … NEVER appeared (still null at +14.01h)". Read
  // later that is direct evidence of a 14-hour publication lag, when in truth there was nothing
  // to publish. The whole point of this log is to measure the lag, so a non-session left in the
  // sample would corrupt the one measurement it exists for.
  //
  // Weekends and the listed NSE holidays are therefore labelled and EXCLUDED from the reading at
  // the bottom. The samples themselves are kept — they are a true record of what the feed served,
  // and deleting a measurement because it is inconvenient is the opposite of the point.
  // ★ The holiday list is maintained one year at a time, so a date outside its coverage cannot be
  // judged; those are reported plainly rather than silently assumed to be sessions.
  const holYears = new Set(HOLIDAYS.map((d) => d.slice(0, 4)));
  const DOWN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const classify = (date) => {
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (dow === 0 || dow === 6) return { session: false, why: `${DOWN[dow]} — not a trading day` };
    if (HOLIDAYS.includes(date)) return { session: false, why: 'listed NSE holiday — no session' };
    if (!holYears.has(date.slice(0, 4))) return { session: true, why: 'holiday list does not cover this year — assumed a session, unverified' };
    return { session: true, why: null };
  };
  let sessionDates = 0, skipped = 0;
  for (const [date, rows] of [...byDate].sort()) {
    const cls = classify(date);
    if (cls.session) sessionDates++; else skipped++;
    console.log(`=== ${cls.session ? 'session' : 'NOT A SESSION:'} ${date} ===${cls.why ? `  (${cls.why})` : ''}`);
    for (const { sym, arr: all } of rows) {
      // ★ A sample taken BEFORE the bell sees the forming bar — a running intraday print, not a
      // published close. Those samples are kept in the log but excluded here, or the report would
      // print "first value -3.19h" for a session still in progress and later read it as a close
      // that appeared before the market shut.
      const arr = all.filter((e) => e.hoursSinceClose >= 0);
      if (!arr.length) {
        console.log(`  ${sym.padEnd(14)} samples ${String(all.length).padStart(2)}  (all taken before the bell — forming bar only, nothing to read yet)`);
        continue;
      }
      const firstNonNull = arr.find((e) => e.close != null);
      const lastNull = [...arr].reverse().find((e) => e.close == null);
      // every time the value changed after it first appeared
      const changes = [];
      let seen = null;
      for (const e of arr) {
        if (e.close == null) continue;
        if (seen != null && e.close !== seen) changes.push({ from: seen, to: e.close, at: e.hoursSinceClose });
        seen = e.close;
      }
      // ★ "NEVER appeared" is a claim this log usually cannot support, and it used to print it
      // from a single sample. Now that a close is known to be servable at +1.3h and gone by
      // +8.7h, one late sample showing null is equally consistent with "not published yet" and
      // with "published, then withdrawn before I looked". Say what was observed — no value in the
      // samples taken — and let the reader see how many that was.
      const appear = firstNonNull
        ? `first value +${firstNonNull.hoursSinceClose}h = ${firstNonNull.close.toFixed(2)}`
        : `no value in ${arr.length} sample${arr.length === 1 ? '' : 's'}`;
      // ★ A NULL AFTER A VALUE IS NOT THE SAME STORY AS A NULL BEFORE ONE, AND THIS LINE USED TO
      // TELL BOTH THE SAME WAY. "still null" is right when the close has not appeared yet; it is
      // exactly backwards once a value HAS been served and the row has gone empty again, which is
      // a WITHDRAWAL — the feed taking back something it had already published. Telling those two
      // apart is the entire reason this log exists, so the wording has to branch.
      // "Trailing" means the LATEST sample is null — not merely "a null came after the first
      // value", which is also true of a close that was withdrawn and then came back (the branch
      // below), and used to print that shape as still withdrawn.
      const latest = arr[arr.length - 1];
      const trailingNull = latest.close == null && lastNull;
      // ★ THE FOURTH OUTCOME, measured 2026-09-16: served, WITHDRAWN overnight, then BACK the next
      // day. A null that sits BETWEEN two served values is that shape, and without this branch the
      // line would read "first value … no revision observed" — true, and silent about the one
      // thing worth knowing. Say when it vanished and when it was next seen, and whether it came
      // back at the same value.
      const gapNull = firstNonNull && arr.find((e) => e.close == null && e.at > firstNonNull.at);
      const returned = gapNull && arr.find((e) => e.close != null && e.at > gapNull.at);
      const roundTrip = returned
        ? `  ★ WITHDRAWN at +${gapNull.hoursSinceClose}h, RETURNED by +${returned.hoursSinceClose}h ` +
          `(${returned.close === firstNonNull.close ? 'same value' : `REVISED: ${firstNonNull.close.toFixed(2)} -> ${returned.close.toFixed(2)}`})`
        : '';
      const stillNull = !trailingNull
        ? roundTrip
        : firstNonNull
          ? `  ★ WITHDRAWN: served a close, then null again at +${lastNull.hoursSinceClose}h`
          // Not "has not appeared yet" — that asserts the close was never served, which a late
          // sample cannot establish now that withdrawal is known to happen.
          : `  (null as of +${lastNull.hoursSinceClose}h — not published yet, OR published and withdrawn before this sample)`;
      console.log(`  ${sym.padEnd(14)} samples ${String(arr.length).padStart(2)}  ${appear}${stillNull}`);
      for (const c of changes) console.log(`      REVISED at +${c.at}h: ${c.from.toFixed(2)} -> ${c.to.toFixed(2)}  (${(((c.to / c.from) - 1) * 100).toFixed(4)}%)`);
      // Say "no revision" only about the values actually seen. A withdrawal is not a revision,
      // and printing the reassuring line beside one would read as "nothing happened".
      // Did ANY sample land in the window where a withdrawal has been seen? If not, say so —
      // 'no revision observed' would otherwise be read as 'nothing happened'.
      const watched = arr.some((e) => e.hoursSinceClose >= WATCH_WINDOW.from && e.hoursSinceClose <= WATCH_WINDOW.to);
      if (firstNonNull && !changes.length && arr.length > 1 && !trailingNull) {
        console.log(watched
          ? '      no revision observed across the samples taken'
          : `      no revision observed — but NO SAMPLE fell in the +${WATCH_WINDOW.from}h..+${WATCH_WINDOW.to}h window`
            + ' where a withdrawal has been seen, so this is NOT evidence the close stayed put');
      } else if (firstNonNull && !changes.length && trailingNull) {
        console.log('      (no REVISION among the values served — but see the withdrawal above)');
      }
    }
    console.log();
  }
  console.log('Reading this: a first value that never changes across a +24h sample is evidence the');
  console.log('feed SETTLES on publication; any REVISED line is direct evidence it does not.');
  console.log('★ A WITHDRAWN line is a third outcome, and it was not anticipated: the close was');
  console.log('  served and then taken back. It means availability is a WINDOW, not a threshold —');
  console.log('  sampling late can miss a close that really was published. Treat any single late');
  console.log('  null as "not seen", never as "never published".');
  console.log(`★ And the same caution in reverse: a session with no sample between +${WATCH_WINDOW.from}h and`);
  console.log(`  +${WATCH_WINDOW.to}h was never WATCHED across the window a withdrawal has been seen in, so`);
  console.log('  "no revision observed" there means nobody looked — not that nothing happened.');
  console.log(`\n★ Count only the ${sessionDates} SESSION date${sessionDates === 1 ? '' : 's'} above toward that.`);
  if (skipped) {
    console.log(`  ${skipped} date${skipped === 1 ? ' is' : 's are'} marked NOT A SESSION — the feed emits a daily row for days the`);
    console.log('  exchange was shut, and a close that never appears for one of those is not a lag,');
    console.log('  it is nothing to publish. Those rows are kept as a record of what was served.');
  }
}

// ★ RUN ONLY WHEN INVOKED DIRECTLY, like every other tool in this folder. Without this guard a
// bare `import` of the module fires six live network requests and appends to the log — I did
// exactly that by accident while checking the file parsed, in the public mirror, where the log is
// deliberately never carried. The other research tools already guard this way; this one did not.
import { pathToFileURL } from 'node:url';
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('feed-publication-log.mjs is a CLI tool; run it directly.');

if (args.includes('--report')) report(); else await sample();
