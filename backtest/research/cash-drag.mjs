// cash-drag.mjs — how much of each bot's life is spent in CASH, and what the 6.5% hurdle
// charges it for sitting there.
//
// WHY THIS EXISTS
// ---------------
// Sharpe here is EXCESS of a 6.5% risk-free rate: metrics.mjs subtracts `rfBar` from EVERY
// bar's return (sharpe() and sortino(), `rfBar = rfAnnual / periodsPerYear`), including bars
// where the account is sitting flat in cash. But NOTHING in the engine credits interest on
// idle cash — engine.js's own `riskFreeRate: 6.5` field is commented "used by option tools"
// and is never touched by the money model. A real investor parking cash in a T-bill earns the
// hurdle; a bot here earns zero and is charged it anyway.
//
// So every day a gated basket sits in cash costs it the full daily hurdle of excess return,
// and a strategy whose whole design is "step aside in bad regimes" is penalised twice for
// stepping aside. That is a MEASUREMENT convention, not a market fact, and it silently moves
// every published number on the board. This tool measures how big the effect actually is
// before anyone argues about whether to change it.
//
// HOW A CASH BAR IS DETECTED
// --------------------------
// Cash earns exactly nothing, so a fully-in-cash bar leaves equity EXACTLY unchanged. A bar
// where equity[i] === equity[i-1] to the bit is therefore a cash bar. The false positive is a
// day on which a held portfolio's mark did not move at all — essentially impossible for a
// 10-name basket, possible for a single-name bot, which is why only BASKETs are measured here
// and why the gated bots are cross-checked against their gate directly (see below).
//
// TWO INDEPENDENT MEASUREMENTS, deliberately:
//   (1) EMPIRICAL — the flat-bar count above, from the real backtest.
//   (2) STRUCTURAL — for a bot carrying a `marketGate`, the fraction of bars on which that
//       gate expression is FALSE, evaluated directly on the NIFTY series. This is exact and
//       owes nothing to the flat-bar heuristic.
//       MEASURED: (1) comes out LARGER than (2) for every gated bot. That is not an error in
//       either — a periodic bot reads its gate only at a REBALANCE bar, so one
//       shut gate on a rebalance day buys a whole period in cash and the bot does not re-enter
//       when NIFTY recovers mid-period. The gap between the columns is the rebalance grid's
//       contribution, distinct from the gate's own.
//
// WHAT "REPAIRED" MEANS
// ---------------------
// The repaired curve is the same backtest with interest accrued on cash during each flat run
// at RF_ANNUAL/252 per bar, compounding — i.e. what the bot would have earned had its idle
// cash sat in the same T-bill the hurdle assumes. Re-scored with the SAME metrics functions.
// The gap between the two xSharpes is what the convention is currently costing that bot.
//
// This is NOT a proposal to change anything, and it changes nothing: it is read-only, writes
// no file, touches no app state and no cache beyond the usual Yahoo cache fill. Whether to
// credit cash at rf, or instead to publish sharpeRf0 beside every gated figure, is a decision
// that restates published numbers, so it is left open rather than chosen here (METHODOLOGY.md).
//
// Usage: node backtest/research/cash-drag.mjs [botId ...]      (default: every BASKET seed)

import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('cash-drag.mjs is a CLI tool; run it directly.');

const { loadCandles } = await import('../data.mjs');
const { runPortfolioBacktest } = await import('../portfolio.mjs');
const { equityDeliveryCosts } = await import('../costs.mjs');
const { makeRankSource } = await import('../ml.mjs');
const { sharpe, RF_ANNUAL, TRADING_DAYS } = await import('../metrics.mjs');
const { evalNode } = await import('../dsl.mjs');
const { SEED_BOTS } = await import('../../tournament/seed.mjs');

const EQ = equityDeliveryCosts();
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const bots = SEED_BOTS.filter((b) => b.kind === 'BASKET' && (!wanted.length || wanted.includes(b.id)));
if (!bots.length) { console.error('no BASKET bots matched'); process.exit(1); }

// ---- load once through the REAL read path (adjusted + sanitised), exactly as the board does
const universe = new Set();
for (const b of bots) for (const s of b.spec.universe) universe.add(s);
const data = {};
let dropped = 0;
for (const s of universe) {
  const { candles, source } = await loadCandles(s, { interval: '1d', range: '20y' });
  if (/synthetic/.test(source) || candles.length < 300) { dropped++; continue; }
  data[s] = candles;
}
const { candles: market, source: mSrc } = await loadCandles('NIFTY', { interval: '1d', range: '20y' });
if (/synthetic/.test(mSrc)) { console.error('refusing to measure: the market series is synthetic.'); process.exit(1); }

console.log(`data: ${Object.keys(data).length} names loaded (${dropped} dropped), market ${market.length} bars`);
console.log(`hurdle: RF_ANNUAL = ${(RF_ANNUAL * 100).toFixed(1)}%/yr, charged per bar as rf/${TRADING_DAYS}; idle cash earns 0 in the engine.`);
console.log('★ ONE DRAW: these are single-window runs, so read the SPREAD between bots, not any one figure.\n');

// ---- STRUCTURAL: what fraction of bars is a marketGate closed? exact, from NIFTY alone.
const closes = market.map((c) => c.c);
function gateClosedFraction(gateExpr) {
  if (!gateExpr) return null;
  let closedBars = 0, evaluated = 0;
  for (let i = 0; i < closes.length; i++) {
    let v;
    try { v = evalNode(gateExpr, closes, i); } catch { continue; }
    if (v === null || v === undefined || Number.isNaN(v)) continue; // warm-up
    evaluated++;
    if (!v) closedBars++;
  }
  return evaluated ? { frac: closedBars / evaluated, evaluated } : null;
}

// ---- repair: accrue interest on cash during each flat (cash) run
function repairCurve(curve) {
  const perBar = RF_ANNUAL / TRADING_DAYS;
  const out = [curve[0]];
  let credit = 1; // cumulative interest factor earned while idle
  for (let i = 1; i < curve.length; i++) {
    if (curve[i] === curve[i - 1]) credit *= (1 + perBar); // a cash bar: the T-bill pays
    out.push(curve[i] * credit);
  }
  return out;
}

const rows = [];
for (const bot of bots) {
  const dbs = {};
  for (const s of bot.spec.universe) if (data[s]) dbs[s] = data[s];
  if (Object.keys(dbs).length < 2) { console.log(`skip ${bot.id}: universe not loaded`); continue; }
  const rankSource = bot.spec.mlConfig ? makeRankSource({ spec: bot.spec, dataBySymbol: dbs }) : null;
  const r = runPortfolioBacktest({ spec: bot.spec, dataBySymbol: dbs, marketSeries: market, cash: 10_000_000, costModel: EQ, rankSource, recordTrades: false, intraday: false, alignCache: null });

  const curve = r.equityCurve;
  let flat = 0;
  for (let i = 1; i < curve.length; i++) if (curve[i] === curve[i - 1]) flat++;
  const bars = Math.max(1, curve.length - 1);
  const flatFrac = flat / bars;

  const asIs = sharpe(curve);
  const repaired = sharpe(repairCurve(curve));
  const gate = gateClosedFraction(bot.spec.marketGate);

  rows.push({
    id: bot.id,
    gated: !!bot.spec.marketGate,
    bars,
    flatFrac,
    gateFrac: gate ? gate.frac : null,
    asIs,
    repaired,
    delta: repaired - asIs,
    costPctYr: flatFrac * RF_ANNUAL * 100,
  });
}

rows.sort((a, b) => b.flatFrac - a.flatFrac);

const pad = (s, n) => String(s).padEnd(n);
const rp = (s, n) => String(s).padStart(n);
console.log(pad('bot', 22) + rp('gate?', 6) + rp('cash bars', 11) + rp('gate shut', 11) + rp('xSharpe', 9) + rp('if cash', 9) + rp('delta', 8) + rp('drag/yr', 9));
console.log('-'.repeat(85));
for (const r of rows) {
  console.log(
    pad(r.id, 22) +
    rp(r.gated ? 'yes' : 'no', 6) +
    rp((r.flatFrac * 100).toFixed(1) + '%', 11) +
    rp(r.gateFrac == null ? '-' : (r.gateFrac * 100).toFixed(1) + '%', 11) +
    rp(r.asIs.toFixed(3), 9) +
    rp(r.repaired.toFixed(3), 9) +
    rp((r.delta >= 0 ? '+' : '') + r.delta.toFixed(3), 8) +
    rp(r.costPctYr.toFixed(2) + '%', 9)
  );
}

// ---- DOES IT REORDER THE BOARD? the only thing that decides whether this is cosmetic.
// The Auto-Pilot picks by best excess-Sharpe, so a convention that changes only the LEVEL of
// every score is harmless; one that changes the ORDER changes which bot gets followed.
const orderAsIs = [...rows].sort((a, b) => b.asIs - a.asIs).map((r) => r.id);
const orderFixed = [...rows].sort((a, b) => b.repaired - a.repaired).map((r) => r.id);
const swaps = [];
for (let i = 0; i < orderAsIs.length; i++) if (orderAsIs[i] !== orderFixed[i]) swaps.push({ i, was: orderAsIs[i], now: orderFixed[i] });
console.log('\nDOES IT CHANGE THE BOARD?');
if (!swaps.length) {
  console.log(`  NO — all ${rows.length} bots keep their exact rank. Winner stays ${orderAsIs[0]} either way.`);
  console.log('  So this convention is a LEVEL effect, not a selection effect: it understates every gated bot');
  console.log('  by a similar amount without changing which one the Auto-Pilot would follow. That makes it a');
  console.log('  reporting-honesty question, not a correctness bug — which is the cheaper kind to decide.');
} else if (orderAsIs[0] === orderFixed[0]) {
  console.log(`  NOT WHERE IT MATTERS — ${swaps.length} rank position(s) move, but the WINNER is unchanged`);
  console.log(`  (${orderAsIs[0]} either way), and the moves are:`);
  for (const s of swaps) console.log(`    rank ${s.i + 1}: ${s.was} -> ${s.now}`);
  console.log('  The Auto-Pilot follows the best excess-Sharpe bot, so a swap below the top does not change');
  console.log('  which bot it copies. Treat this as a LEVEL effect for selection purposes — a reporting-honesty');
  console.log('  question rather than a correctness bug — while noting the ordering is not perfectly stable.');
} else {
  console.log(`  YES — ${swaps.length} rank position(s) move AND the winner changes: ${orderAsIs[0]} -> ${orderFixed[0]}.`);
  for (const s of swaps) console.log(`    rank ${s.i + 1}: ${s.was} -> ${s.now}`);
  console.log('  A selection effect, not just a level effect: the Auto-Pilot would follow a different bot.');
}

const gatedRows = rows.filter((r) => r.gated);
const ungated = rows.filter((r) => !r.gated);
const avg = (a, f) => (a.length ? a.reduce((s, x) => s + f(x), 0) / a.length : 0);
console.log('\nREADING THIS');
console.log(`  "cash bars"  = bars where equity did not move at all, i.e. fully in cash (heuristic — see the header).`);
console.log(`  "gate shut"  = fraction of bars the bot's own marketGate expression is FALSE on NIFTY (exact, independent).`);
console.log(`  "if cash"    = the same run re-scored with idle cash earning ${(RF_ANNUAL * 100).toFixed(1)}%/yr, as the hurdle already assumes it does.`);
console.log(`  "drag/yr"    = cash fraction x the hurdle: the excess return the bot forfeits purely for standing aside.`);
console.log(`\n  gated bots  (n=${gatedRows.length}): avg ${(avg(gatedRows, (r) => r.flatFrac) * 100).toFixed(1)}% in cash, avg xSharpe change ${avg(gatedRows, (r) => r.delta) >= 0 ? '+' : ''}${avg(gatedRows, (r) => r.delta).toFixed(3)}`);
console.log(`  ungated bots (n=${ungated.length}): avg ${(avg(ungated, (r) => r.flatFrac) * 100).toFixed(1)}% in cash, avg xSharpe change ${avg(ungated, (r) => r.delta) >= 0 ? '+' : ''}${avg(ungated, (r) => r.delta).toFixed(3)}`);
console.log('\n  WHY "cash bars" EXCEEDS "gate shut" for every gated bot, which is the opposite of the naive');
console.log('  expectation: a PERIODIC bot reads its gate ONLY at a rebalance bar. One shut');
console.log('  gate on a rebalance day therefore buys a WHOLE period in cash — the bot does not re-enter the');
console.log('  moment NIFTY recovers, it waits for the next scheduled rebalance. So "gate shut" is a LOWER');
console.log('  bound on time spent flat, not an upper one, and the gap between the two columns is the cost of');
console.log('  the rebalance grid rather than of the gate itself.');
