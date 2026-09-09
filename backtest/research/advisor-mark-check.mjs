// advisor-mark-check.mjs — is a RECORDED suggestion mark still the close that date now serves?
//
// WHY THIS EXISTS
// The suggestion log records, for each entry, the reference price it saw for every holding
// (`targets[].price`). That value is `lastPrices` from the engine — the edge bar's close AS
// SERVED AT RECORD TIME (see snapshotPositions in backtest/harness.mjs). The log is
// APPEND-ONLY and never edited, so if the feed later serves a different close for that same
// date, the recorded mark is frozen slightly wrong. This tool measures that drift.
//
// WHAT IT FOUND (six entries, first run)
//   * THREE entries match today's served close EXACTLY.
//   * ONE is off by a CONTINUOUS 0.05%–0.61%, its best matches split between the entry's own
//     bar and the previous one — the shape of a price taken partway through a session.
//   * TWO sit in two TIGHT clusters SHARED across unrelated symbols (about +0.154% and
//     -0.168%), which is NOT per-symbol dividend re-adjustment.
// The mechanism is OPEN. Two candidates each fail a case, so this tool deliberately reports
// the measurement and does not pick one. The decisive experiment it cannot run by itself:
// capture `close` AND `adjclose` for one session at first publication and again ~24h later.
//
// SCOPE: read-only and offline of the app — nothing live imports this, it places no orders,
// and it writes nothing (not even the on-disk candle cache: it calls the provider directly
// rather than loadCandles, so a run cannot poison a cache file or be served a stale one).
//
// USAGE
//   node backtest/research/advisor-mark-check.mjs [path-to-store.json]
// The store is the persisted forward record. Dump it with:
//   gh api gists/<PERSIST_GIST_ID> --jq '.files|to_entries[0].value.content' > store.json
// With no argument it looks for ./store.json then ./data/tournament.json.

import { readFileSync, existsSync } from 'node:fs';
import provider from '../../src/dataSources/freeProvider.js';

const { getHistory } = provider;

// --- locate the store ------------------------------------------------------
const argPath = process.argv[2];
const candidates = argPath ? [argPath] : ['store.json', 'data/tournament.json'];
const storePath = candidates.find((p) => existsSync(p));
if (!storePath) {
  console.error(`No store found. Tried: ${candidates.join(', ')}`);
  console.error('Dump one with:  gh api gists/<id> --jq \'.files|to_entries[0].value.content\' > store.json');
  process.exit(1);
}
const store = JSON.parse(readFileSync(storePath, 'utf8'));
const log = store.advisorLog || [];
if (!log.length) {
  console.error(`${storePath} holds no advisorLog entries.`);
  process.exit(1);
}
console.log(`store: ${storePath} — ${log.length} entries (${log[0].date} … ${log[log.length - 1].date})\n`);

// --- fetch each symbol ONCE, keyed by IST date -----------------------------
const istDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const symbols = [...new Set(log.flatMap((e) => (e.targets || []).map((t) => t.symbol)))];
const series = new Map();

for (const sym of symbols) {
  try {
    // '6mo' comfortably spans the log; the provider skips rows with no usable close, which is
    // exactly what we want here — a null-close row carries no value to compare against.
    const { candles } = await getHistory(sym, { interval: '1d', range: '6mo' });
    const byDate = new Map();
    for (const c of candles) byDate.set(istDate(c.t), { close: c.c, adj: c.a != null ? c.a : null });
    series.set(sym, byDate);
  } catch (err) {
    console.error(`  ${sym}: fetch failed — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 800)); // be polite to a free endpoint
}
console.log(`fetched ${series.size}/${symbols.length} symbols\n`);

// --- compare ---------------------------------------------------------------
const pct = (a, b) => (a / b - 1) * 100;
const fmt = (n, w) => String(n).padStart(w);

for (const entry of log) {
  const rows = [];
  for (const t of entry.targets || []) {
    const byDate = series.get(t.symbol);
    const bar = byDate && byDate.get(entry.date);
    if (!bar) { rows.push({ sym: t.symbol, missing: true }); continue; }
    rows.push({ sym: t.symbol, rec: t.price, now: bar.close, adj: bar.adj, drift: pct(bar.close, t.price) });
  }
  const ok = rows.filter((r) => !r.missing);
  const missing = rows.filter((r) => r.missing).map((r) => r.sym);

  console.log(`=== ${entry.date}  (${entry.botId}${entry.eligible === false ? ', stand-aside' : ''})  ${ok.length}/${rows.length} re-checkable ===`);
  for (const r of ok.sort((a, b) => a.drift - b.drift)) {
    // Flag when the feed's CURRENT adjusted close differs from its raw close for that date:
    // that is a genuine corporate-action adjustment and must not be confused with drift.
    const adjNote = r.adj != null && Math.abs(r.adj - r.now) > 0.005 ? `  adj=${r.adj.toFixed(2)}` : '';
    console.log(`  ${r.sym.padEnd(12)} recorded ${fmt(r.rec, 10)}   now ${fmt(r.now.toFixed(2), 10)}   ${r.drift >= 0 ? '+' : ''}${r.drift.toFixed(4)}%${adjNote}`);
  }
  if (missing.length) console.log(`  (no data: ${missing.join(', ')})`);

  const drifts = ok.map((r) => r.drift);
  if (drifts.length) {
    const exact = drifts.filter((d) => Math.abs(d) < 1e-6).length;
    const distinct = [...new Set(drifts.map((d) => d.toFixed(3)))];
    const span = `${Math.min(...drifts).toFixed(4)}% … ${Math.max(...drifts).toFixed(4)}%`;
    console.log(`  -> exact: ${exact}/${drifts.length}   span: ${span}   distinct(3dp): ${distinct.length}`);
  }
  console.log();
}

console.log('Reminder: forward SCORING re-reads closes from the live series (closeAtOrBefore),');
console.log('so a drift here moves the displayed/scaling reference, not the scored returns.');
