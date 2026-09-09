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
      const n = r.timestamp.length - 1;
      const date = istDate(r.timestamp[n] * 1000);
      const entry = {
        at, sym, date,
        close: q.close[n] != null ? q.close[n] : null,
        adjclose: adjArr && adjArr[n] != null ? adjArr[n] : null,
        marketTime: r.meta.regularMarketTime ? r.meta.regularMarketTime * 1000 : null,
        marketPrice: r.meta.regularMarketPrice != null ? r.meta.regularMarketPrice : null,
        hoursSinceClose: +((at - closeOf(date)) / 3600000).toFixed(2),
      };
      log.push(entry);
      const shown = entry.close == null ? 'NULL' : entry.close.toFixed(2);
      console.log(`  ${sym.padEnd(14)} ${entry.date}  close=${shown.padStart(10)}  +${entry.hoursSinceClose}h  (quote ${entry.marketPrice})`);
    } catch (err) {
      console.error(`  ${sym.padEnd(14)} FAILED — ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 900)); // be polite to a free endpoint
  }
  writeFileSync(logPath, JSON.stringify(log, null, 1));
  console.log(`\nlog: ${logPath} (${log.length} samples)`);
}

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
  for (const [date, rows] of [...byDate].sort()) {
    console.log(`=== session ${date} ===`);
    for (const { sym, arr } of rows) {
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
      const appear = firstNonNull ? `first value +${firstNonNull.hoursSinceClose}h = ${firstNonNull.close.toFixed(2)}` : 'NEVER appeared';
      const stillNull = lastNull && (!firstNonNull || lastNull.at > firstNonNull.at) ? `  (still null at +${lastNull.hoursSinceClose}h)` : '';
      console.log(`  ${sym.padEnd(14)} samples ${String(arr.length).padStart(2)}  ${appear}${stillNull}`);
      for (const c of changes) console.log(`      REVISED at +${c.at}h: ${c.from.toFixed(2)} -> ${c.to.toFixed(2)}  (${(((c.to / c.from) - 1) * 100).toFixed(4)}%)`);
      if (firstNonNull && !changes.length && arr.length > 1) console.log('      no revision observed across the samples taken');
    }
    console.log();
  }
  console.log('Reading this: a first value that never changes across a +24h sample is evidence the');
  console.log('feed SETTLES on publication; any REVISED line is direct evidence it does not.');
}

if (args.includes('--report')) report(); else await sample();
