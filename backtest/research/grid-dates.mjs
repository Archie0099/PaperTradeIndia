// grid-dates.mjs — which dates on the master timeline are not clean trading sessions, and
// which side of the feed is wrong about them?
//
// WHY THIS EXISTS
// ---------------
// `alignSeries` builds the master timeline from the UNION of every symbol's timestamps. A date
// only a handful of symbols printed therefore becomes a bar for ALL of them, and a name lacking
// it has its whole trailing window displaced against the names that carry it. That is the cause
// of the optimiser's covariance mispairing (see cov-alignment.mjs), but the grid is used for far
// more than a covariance window: it is the price grid, it is what positions are marked on, and
// `rebalanceBars` counts GRID bars, so a junk date moves every later rebalance date with it.
//
// This tool asks the question the other way round from cov-alignment.mjs. Instead of "which
// rebalances were affected", it asks "which DATES are suspect, and is it the index feed or the
// stock feed that is wrong about each one".
//
// THE TEST, which needs no holiday list and works over the whole span
// ------------------------------------------------------------------
// On a genuine session essentially every listed stock prints a bar; on a closed day essentially
// none do. So for each date the INDEX has no bar for, count the share of names that traded it:
//
//   ~all traded, weekday, not a declared holiday -> a REAL SESSION THE INDEX FEED DROPPED
//   ~all traded, but a DECLARED NSE HOLIDAY      -> the index is right; the STOCK feed printed
//                                                   phantom bars on a closed day
//   ~none traded                                 -> a stray print the UNION promoted to a bar
//   weekend                                      -> either a stray print, or a real Muhurat /
//                                                   Budget session (NSE does trade some of those)
//
// TWO WAYS TO GET A FAKE ANSWER, both guarded here because both produced one first:
//   * counting a name OUTSIDE ITS OWN SPAN. Before its first bar, or after its last, a name
//     cannot be expected to trade — and near the cache's trailing edge only a handful of series
//     are still inside their span, which turned three vintage dates into "100% traded".
//   * counting dates BEFORE THE INDEX SERIES BEGINS. The index starts later than most of the
//     universe, and those leading dates are not "missing sessions", they are history the index
//     simply does not have. Including them is what turned this question into a claim of ~324
//     missing sessions (~16/yr); the measured answer is an order of magnitude smaller.
//
// Usage:  node backtest/research/grid-dates.mjs
// Read-only: loads cached data, writes nothing.

import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('grid-dates.mjs is a CLI tool; run it directly.');

const { loadCandles } = await import('../data.mjs');
const { alignSeries } = await import('../portfolio.mjs');
const { SEED_BOTS } = await import('../../tournament/seed.mjs');
const mh = (await import('../../src/marketHours.js')).default;
const HOLIDAYS = new Set(mh.HOLIDAYS || []);

const MIN_NAMES = 50; // below this a date's verdict is vintage, not a market fact

const universe = new Set();
for (const b of SEED_BOTS) if (b.kind === 'BASKET') for (const s of b.spec.universe) universe.add(s);
const data = {};
for (const s of universe) {
  const { candles, source } = await loadCandles(s, { interval: '1d', range: '20y' });
  if (/synthetic/.test(source) || candles.length < 300) continue;
  data[s] = candles;
}
const { candles: market, source: mSrc } = await loadCandles('NIFTY', { interval: '1d', range: '20y' });
if (/synthetic/.test(mSrc)) { console.error('refusing to measure: the market series is synthetic.'); process.exit(1); }

const A = alignSeries(data, market);
const { master, realIdx, timesBy, volsBy } = A;
const names = Object.keys(data).sort();
const nifty = new Set(market.map((c) => c.t));
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (t) => new Date(t).toISOString().slice(0, 10);

// ★ SAY WHAT THE HOLIDAY LIST ACTUALLY COVERS. It is hand-maintained one year at a time, so over
// a ~20-year grid the "declared holiday" bucket is structurally EMPTY outside those years, and any
// holiday beyond them is silently reclassified as a dropped session or a stray print. The counts
// this tool prints get quoted into the project docs, so the caveat has to travel with them.
const holYears = [...new Set([...HOLIDAYS].map((d) => d.slice(0, 4)))].sort();
console.log(`master grid ${master.length} bars from ${names.length} names; NIFTY ${market.length} bars.`);
console.log(`holiday list covers ${holYears.length ? holYears.join(', ') : '(nothing)'} only — outside those years a holiday cannot be told from a trading day here.`);
console.log(`grid dates NIFTY has no bar for, in total: ${master.filter((t) => !nifty.has(t)).length}`);
console.log(`  ...of which BEFORE the index series even starts: ${master.filter((t) => !nifty.has(t) && t < market[0].t).length}  <- history, NOT missing sessions\n`);

const rows = [];
for (let p = 0; p < master.length; p++) {
  if (nifty.has(master[p]) || master[p] < market[0].t) continue;
  let listed = 0, held = 0;
  for (const s of names) {
    const ts = timesBy[s];
    if (master[p] < ts[0] || master[p] > ts[ts.length - 1]) continue; // outside the name's own span
    const ri = realIdx[s][p];
    if (ri < 0) continue;
    listed++;
    // ★ A BAR IS NOT A TRADE. The free feed emits carried-forward rows on days the market was
    // shut: same close as the day before, volume EXACTLY 0, and often a different timestamp of
    // day. Counting those as "this name traded" is what made an earlier version of this tool
    // report phantom dates as sessions the index had dropped. Require real volume.
    if (ts[ri] === master[p] && volsBy[s][ri] > 0) held++;
  }
  if (listed) rows.push({ t: master[p], dow: new Date(master[p]).getUTCDay(), listed, held, frac: held / listed });
}

const vintage = rows.filter((r) => r.listed < MIN_NAMES);
const solid = rows.filter((r) => r.listed >= MIN_NAMES);
const weekday = solid.filter((r) => r.dow !== 0 && r.dow !== 6);
const weekend = solid.filter((r) => r.dow === 0 || r.dow === 6);
const dropped = weekday.filter((r) => r.frac >= 0.9 && !HOLIDAYS.has(iso(r.t)));
const phantom = weekday.filter((r) => r.frac >= 0.9 && HOLIDAYS.has(iso(r.t)));
const stray = weekday.filter((r) => r.frac < 0.9);

const line = (r, tail = '') => `    ${iso(r.t)} ${DOW[r.dow]}  ${r.held}/${r.listed} traded (${(100 * r.frac).toFixed(1)}%)${tail}`;
const years = {};
for (const r of dropped) { const y = iso(r.t).slice(0, 4); years[y] = (years[y] || 0) + 1; }
const span = (master[master.length - 1] - market[0].t) / (365.25 * 864e5);

console.log(`SESSIONS THE INDEX FEED DROPPED — weekday, ~all stocks traded, not a declared holiday: ${dropped.length}`);
console.log(`  ${(dropped.length / span).toFixed(1)} per year over ${span.toFixed(1)} years (~${(100 * dropped.length / master.length).toFixed(2)}% of bars)`);
console.log(`  per year: ${Object.keys(years).sort().map((y) => `${y}:${years[y]}`).join('  ')}`);
for (const r of dropped) console.log(line(r, HOLIDAYS.has(iso(r.t)) ? '  [declared holiday]' : ''));
const jan1 = dropped.filter((r) => iso(r.t).slice(5) === '01-01' || iso(r.t).slice(5) === '01-02');
console.log(`  ★ ${jan1.length} of them fall on 1-2 January. NSE trades on New Year's Day, so this is a`);
console.log(`    recognisable, repeating hole in the index history rather than scattered noise.`);

console.log(`\nDECLARED NSE HOLIDAYS on which ~all STOCKS still printed a bar: ${phantom.length}`);
console.log('  (here the INDEX is right and the STOCK feed is the wrong one — the reverse of the above)');
for (const r of phantom) console.log(line(r, '  [declared holiday]'));

console.log(`\nSTRAY PRINTS — weekday, hardly anything traded: ${stray.length}`);
for (const r of stray) console.log(line(r));

console.log(`\nWEEKEND dates on the grid: ${weekend.length}`);
console.log('  (NSE does hold real Saturday/Sunday sessions — Diwali Muhurat, some Budget days — so a');
console.log('   dense weekend date is a genuine session, and a near-empty one is a stray print.)');
for (const r of weekend) console.log(line(r, r.frac >= 0.9 ? '  <- a REAL weekend session' : '  <- stray'));

console.log(`\nExcluded as cache-edge vintage (fewer than ${MIN_NAMES} names inside their own span): ${vintage.length}`);
for (const r of vintage) console.log(line(r));

console.log('\nWHAT THIS MEANS FOR THE BOARD');
console.log('  A date the index lacks is FORWARD-FILLED in the grid, so on those bars every basket');
console.log("  evaluates its market gate against a stale index close. With ~21 such dates in ~4,900");
console.log('  bars and monthly rebalances, the chance of one landing on a decision bar is small —');
console.log('  but it is not zero, and it is invisible unless something looks for it.');
