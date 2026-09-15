// zero-volume-date.mjs — what happened on a single suspect date, name by name?
//
// WHY THIS EXISTS
// ---------------
// An earlier pass established two facts about the cached history that look contradictory when
// they meet on one date:
//
//   * the feed emits CARRIED-FORWARD rows on days the exchange was shut — same close as the
//     previous session, volume exactly 0 — so a bar is not a trade;
//   * on a genuine session essentially every listed name trades.
//
// 2025-03-18 is the only date found that is neither shape: ~112 names carry a zero-volume row
// while the INDEX has a bar of its own. A closed day should have no index bar; an open day
// should have volume. This tool prints the per-name evidence for any date so the shape can be
// read rather than guessed at, and it prints CONTROL dates beside it because "112 names look
// odd" means nothing without knowing what an ordinary session looks like in the same cache.
//
// WHAT IT CANNOT DO, stated up front: the holiday list is hand-maintained one year at a time and
// currently covers 2026 only, so for any other year this tool cannot tell you whether a date was
// a declared holiday. It reports the shape; the calendar question stays open unless the date
// falls inside the list's coverage, and it says which case you are in.
//
// Usage:
//   node backtest/research/zero-volume-date.mjs                 # the suspect date + controls
//   node backtest/research/zero-volume-date.mjs 2025-03-18      # any date
//   node backtest/research/zero-volume-date.mjs 2025-03-18 --names   # list every name
//   node backtest/research/zero-volume-date.mjs --sweep         # EVERY date of this shape
//
// ★ Prefer --sweep before quoting anything. One odd date is an anecdote: it cannot tell you
// whether the shape is a one-off glitch or a recurring property of the feed, and those two call
// for completely different responses. The single-date mode exists to read the evidence for a date
// the sweep has already flagged.
//
// Read-only: loads cached data, writes nothing.

import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('zero-volume-date.mjs is a CLI tool; run it directly.');

const { loadCandles } = await import('../data.mjs');
const { SEED_BOTS } = await import('../../tournament/seed.mjs');
const mh = (await import('../../src/marketHours.js')).default;

const args = process.argv.slice(2);
const SHOW_NAMES = args.includes('--names');
const TARGET = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '2025-03-18';
// Controls: the sessions either side of the target. An anomaly is only an anomaly against the
// ordinary days around it, measured in the SAME cache with the SAME code.
const CONTROLS = ['2025-03-13', '2025-03-17', '2025-03-19', '2025-03-20', '2025-03-21'];

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const dow = (d) => DOW[new Date(`${d}T00:00:00Z`).getUTCDay()];

const universe = new Set();
for (const b of SEED_BOTS) if (b.kind === 'BASKET') for (const s of b.spec.universe) universe.add(s);

process.stderr.write(`loading ${universe.size} names from cache...\n`);
const data = {};
for (const s of universe) {
  const { candles, source } = await loadCandles(s, { interval: '1d', range: '20y' });
  if (/synthetic/.test(source) || candles.length < 300) continue;
  data[s] = candles;
}
const names = Object.keys(data).sort();
const { candles: market, source: mSrc } = await loadCandles('NIFTY', { interval: '1d', range: '20y' });
if (/synthetic/.test(mSrc)) {
  console.error('refusing to measure: the market series is synthetic.');
  process.exit(1);
}

// One date, one name: does a bar exist, did anything trade, and is the close simply the previous
// one carried forward? `v == null` is deliberately NOT folded in with `v === 0` — "the feed made
// no claim about volume" and "nothing traded" are different facts, and conflating them is how a
// phantom day gets read as a quiet one.
function probe(candles, date) {
  const i = candles.findIndex((c) => iso(c.t) === date);
  if (i < 0) return { bar: false };
  const c = candles[i];
  const prev = i > 0 ? candles[i - 1] : null;
  return {
    bar: true,
    v: c.v,
    zeroVol: c.v === 0,
    unknownVol: c.v == null,
    carried: prev != null && c.c === prev.c,
    // An untouched row: open, high, low and close all equal, i.e. no range at all. The third
    // clause must tie the BODY to the RANGE — repeating `c.o === c.c` (as this first did) leaves
    // o===c===100 with h===l===105 passing as "no range".
    flat: c.o === c.c && c.h === c.l && c.o === c.h,
    close: c.c,
    prevClose: prev ? prev.c : null,
    stampUtc: new Date(c.t).toISOString().slice(11, 19),
  };
}

function summarise(date) {
  const rows = names.map((n) => ({ name: n, ...probe(data[n], date) }));
  const withBar = rows.filter((r) => r.bar);
  const zero = withBar.filter((r) => r.zeroVol);
  const unknown = withBar.filter((r) => r.unknownVol);
  const traded = withBar.filter((r) => r.v > 0);
  const carried = withBar.filter((r) => r.carried);
  const noRange = withBar.filter((r) => r.flat);
  const stamps = new Map();
  for (const r of withBar) stamps.set(r.stampUtc, (stamps.get(r.stampUtc) || 0) + 1);
  return { date, rows, withBar, zero, unknown, traded, carried, noRange, stamps };
}

function line(s) {
  const m = probe(market, s.date);
  const pct = (n) => (s.withBar.length ? ((100 * n) / s.withBar.length).toFixed(1) : '—');
  const idx = m.bar
    ? `bar v=${m.v == null ? 'null' : m.v}${m.zeroVol ? ' ZERO' : ''}${m.carried ? ' CARRIED' : ''}`
    : 'NO BAR';
  console.log(
    `${s.date} ${dow(s.date)}  names with a bar ${String(s.withBar.length).padStart(3)}/${names.length}` +
      `  traded ${String(s.traded.length).padStart(3)} (${pct(s.traded.length)}%)` +
      `  zero-vol ${String(s.zero.length).padStart(3)} (${pct(s.zero.length)}%)` +
      `  unknown-vol ${String(s.unknown.length).padStart(3)}` +
      `  carried close ${String(s.carried.length).padStart(3)}` +
      `  |  NIFTY: ${idx}`
  );
}

// --- SWEEP: every date where most names carry a zero-volume row ---------------------------
// The question one date cannot answer. For every date any name has a bar on, what share of the
// names that HAVE a bar actually traded? Two distinct shapes fall out, and they are opposite
// faults, so they are reported separately rather than as one "bad dates" count:
//
//   index has NO bar  -> the exchange was probably shut and the stock feed invented rows
//                        (the declared-holiday phantoms already documented elsewhere)
//   index HAS a bar, and it MOVED -> the exchange was OPEN and the stock feed served stale rows.
//                        This is the worse one: the bot marks and can trade at prices a day old
//                        while the market moved underneath it.
if (args.includes('--sweep')) {
  const MIN_NAMES = 50; // below this, a date's verdict is about cache vintage, not the market
  const THRESHOLD = 0.5; // "most" — deliberately loose, so the printout shows the whole tail
  const marketBy = new Map(market.map((c) => [iso(c.t), c]));
  const marketPrev = new Map();
  for (let i = 1; i < market.length; i++) marketPrev.set(iso(market[i].t), market[i - 1]);

  const perDate = new Map(); // date -> { bars, zero, traded }
  for (const n of names) {
    for (const c of data[n]) {
      const d = iso(c.t);
      let e = perDate.get(d);
      if (!e) perDate.set(d, (e = { bars: 0, zero: 0, traded: 0 }));
      e.bars += 1;
      if (c.v === 0) e.zero += 1;
      else if (c.v > 0) e.traded += 1;
    }
  }

  const flagged = [...perDate.entries()]
    .filter(([, e]) => e.bars >= MIN_NAMES && e.zero / e.bars >= THRESHOLD)
    .sort((a, b) => a[0].localeCompare(b[0]));

  console.log(`\n=== SWEEP: dates where >=${THRESHOLD * 100}% of the names with a bar show ZERO volume ===`);
  console.log(`(${perDate.size} dates examined; ${names.length} names; a date needs >=${MIN_NAMES} bars to be judged)\n`);
  let openMarket = 0;
  let shutMarket = 0;
  for (const [d, e] of flagged) {
    const m = marketBy.get(d);
    const p = marketPrev.get(d);
    const moved = m && p ? ((100 * (m.c - p.c)) / p.c).toFixed(2) : null;
    // ★ A BAR IS NOT A TRADE — INCLUDING THE INDEX'S. The first version of this line read a bar's
    // mere existence as "index TRADED ... exchange OPEN", which is exactly the mistake this whole
    // tool exists to expose, made about the one series it uses as its control. The feed emits
    // carried-forward index rows too (volume 0, close identical to the previous day), so a
    // phantom index bar would have been reported as evidence the exchange was open.
    // It does not currently mis-fire — the one index-present date here has real volume and a
    // 1.45% move — but a latent wrong verdict in a tool whose counts get quoted is worth closing.
    const indexTraded = m && m.v > 0 && p && m.c !== p.c;
    const verdict = !m
      ? 'index has NO bar -> exchange probably shut, stock rows invented'
      : indexTraded
        ? `index TRADED (v=${m.v}, moved ${moved}%) -> exchange OPEN, stock rows STALE`
        : `index bar is PHANTOM too (v=${m.v == null ? 'null' : m.v}${p && m.c === p.c ? ', close carried' : ''}) -> nothing traded anywhere`;
    if (indexTraded) openMarket += 1;
    else shutMarket += 1;
    console.log(
      `  ${d} ${dow(d)}  bars ${String(e.bars).padStart(3)}  zero ${String(e.zero).padStart(3)}` +
        ` (${((100 * e.zero) / e.bars).toFixed(1)}%)  traded ${String(e.traded).padStart(3)}  |  ${verdict}`
    );
  }
  console.log(
    `\n${flagged.length} dates flagged: ${shutMarket} where the index did not trade either ` +
      `(absent, or a phantom bar of its own), ${openMarket} where the index genuinely traded.`
  );
  console.log(
    'The second group is the one that matters: on those days a basket marks — and may rebalance —\n' +
      'at prices that are a day old while the index moved.'
  );
  process.exit(0);
}

const covered = new Set(mh.HOLIDAY_YEARS || []);
console.log(`\ncache: ${names.length} names with real daily history; NIFTY ${market.length} bars.`);
console.log(
  `holiday list covers ${[...covered].join(', ') || '(nothing)'} — ` +
    (covered.has(TARGET.slice(0, 4))
      ? `so ${TARGET} CAN be checked against it: ${mh.HOLIDAYS.includes(TARGET) ? 'it IS a declared NSE holiday.' : 'it is NOT a declared holiday.'}`
      : `so this tool CANNOT say whether ${TARGET} was a declared NSE holiday. Shape only.`)
);

console.log(`\n--- the date in question, then ordinary sessions around it ---`);
const target = summarise(TARGET);
line(target);
for (const d of CONTROLS) if (d !== TARGET) line(summarise(d));

// The timestamp is its own evidence: the phantom rows found earlier were stamped at a different
// time of day from real ones, which is a property of how the feed writes them, not of the market.
console.log(`\n--- UTC timestamps carried by the ${TARGET} bars (a real session shares one) ---`);
for (const [stamp, n] of [...target.stamps].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${stamp}Z  x${n}`);
}
const mkt = probe(market, TARGET);
console.log(`  NIFTY: ${mkt.bar ? `${mkt.stampUtc}Z  close ${mkt.close} (prev ${mkt.prevClose})` : 'no bar'}`);

// Did the zero-volume names simply not exist yet, or had they stopped trading? A name outside its
// own life cannot be expected to trade, and counting it is the documented way to manufacture a
// fake answer.
//
// ★ THE OBVIOUS VERSION OF THIS CHECK CANNOT FAIL, WHICH MAKES IT WORSE THAN NO CHECK. Comparing
// TARGET against the first and last BAR is vacuous here: every name in `target.zero` has a bar ON
// the target date by construction, so the date always lies inside that range and the count is
// always 0. Printed beside real findings, an always-zero number reads as evidence that the
// zero-volume rows are not a listing artifact, while proving nothing whatsoever.
// The question has to be asked of TRADING, not of rows: bracket each name by its first and last
// bar with POSITIVE VOLUME. That can genuinely be non-zero — a name whose feed carries padding
// rows before it listed, or after it stopped trading, falls outside it.
const tradedSpan = (name) => {
  const c = data[name];
  let first = null;
  let last = null;
  for (const bar of c) {
    if (!(bar.v > 0)) continue;
    if (first == null) first = iso(bar.t);
    last = iso(bar.t);
  }
  return { first, last };
};
const outOfSpan = target.zero.filter((r) => {
  const { first, last } = tradedSpan(r.name);
  return first == null || first > TARGET || last < TARGET;
});
console.log(
  `\nzero-volume names outside their own TRADED span (first..last bar with real volume): ` +
    `${outOfSpan.length} of ${target.zero.length}`
);
if (outOfSpan.length) console.log(`  ${outOfSpan.slice(0, 10).map((r) => r.name).join(', ')}`);

if (SHOW_NAMES) {
  console.log(`\n--- every name, ${TARGET} ---`);
  for (const r of target.rows) {
    if (!r.bar) { console.log(`  ${r.name.padEnd(14)} no bar`); continue; }
    console.log(
      `  ${r.name.padEnd(14)} v=${String(r.v == null ? 'null' : r.v).padStart(9)}` +
        `  close ${String(r.close).padStart(10)}  prev ${String(r.prevClose).padStart(10)}` +
        `${r.carried ? '  CARRIED' : ''}${r.flat ? '  NO-RANGE' : ''}`
    );
  }
}
