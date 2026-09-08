// phase-sensitivity.mjs — how much of a basket's LIFETIME figure is just PHASE?
//
// WHY THIS EXISTS
// ---------------
// A BASKET rebalances every `rebalanceBars` bars counted from bar 0 of the aligned master
// timeline. The tournament fetches "20y from today" (rangeFor in tournament.mjs), so bar 0
// CREEPS FORWARD every single day — and every rebalance date moves with it. Two boots a
// month apart therefore trade the same strategy on different dates, and for a SELECTION
// strategy that is not a rounding difference: a different rebalance date picks different
// names, which changes the next holding period, and 240 monthly decisions compound the
// divergence.
//
// This measures that directly: hold the DATA, the SPEC, the COSTS and the END date fixed,
// and vary ONLY where the history begins. Anything that moves is phase, not performance.
//
// WHY IT MATTERS
// --------------
// It bounds how much of a leaderboard number is real. If a strategy's terminal wealth swings
// 3x across start dates it could not affect, then quoting any single run's lifetime return as
// "the" figure is quoting one draw from a wide distribution. It is the same discipline as the
// survivorship control in universe-bench.mjs: measure the bias before believing the number.
//
// This is NOT a holdout evaluation — no parameter is chosen and no strategy is scored against
// a bar. It re-runs one fixed spec over windows of the SAME cached data.
//
// Usage: node backtest/research/phase-sensitivity.mjs [botId ...]
//        (default: the three quant optimisers + the momentum graduate)
// Deterministic and cache-served: no network beyond the usual Yahoo cache fill.

import { pathToFileURL } from 'node:url';

const IST = 5.5 * 3600000;
const istOf = (t) => new Date(t + IST).toISOString().slice(0, 10);

// The window starts to compare. Chosen to span ~4 months of creep — roughly what a board
// drifts through between one look at it and the next — INCLUDING two starts only a week
// apart, so a large gap between those cannot be blamed on "a different era of history".
const DEFAULT_STARTS = ['2006-07-03', '2006-07-10', '2006-08-01', '2006-09-08', '2006-10-02', '2006-11-01'];
const DEFAULT_BOTS = ['quant-riskparity', 'quant-multifactor', 'quant-meanvar', 'xsmom-research'];

export { DEFAULT_STARTS };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { loadCandles } = await import('../data.mjs');
  const { runPortfolioBacktest } = await import('../portfolio.mjs');
  const { equityDeliveryCosts } = await import('../costs.mjs');
  const { makeRankSource } = await import('../ml.mjs');
  const { SEED_BOTS } = await import('../../tournament/seed.mjs');

  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const botIds = wanted.length ? wanted : DEFAULT_BOTS;
  const EQ = equityDeliveryCosts();

  // Load once through the REAL read path (adjusted + sanitised), exactly as the board does.
  const universe = new Set();
  for (const id of botIds) {
    const b = SEED_BOTS.find((x) => x.id === id);
    if (!b) { console.error(`no such bot: ${id}`); process.exit(1); }
    if (b.kind !== 'BASKET') { console.error(`${id} is ${b.kind}, not a BASKET — phase applies to rebalanced baskets`); process.exit(1); }
    for (const s of b.spec.universe) universe.add(s);
  }
  const data = {};
  let dropped = 0;
  for (const s of universe) {
    const { candles, source } = await loadCandles(s, { interval: '1d', range: '20y' });
    if (/synthetic/.test(source) || candles.length < 300) { dropped++; continue; }
    data[s] = candles;
  }
  const { candles: market, source: mSrc } = await loadCandles('NIFTY', { interval: '1d', range: '20y' });
  if (/synthetic/.test(mSrc)) { console.error('refusing to evaluate: the market series is synthetic.'); process.exit(1); }
  console.log(`data: ${Object.keys(data).length} names loaded (${dropped} dropped)`);
  console.log('★ SURVIVORSHIP: the universe is today\'s liquid names held fixed across history — every figure below is an UPPER BOUND (METHODOLOGY.md).');
  console.log('★ Only the WINDOW START changes below. Same bars, same spec, same costs, same end date — so every difference is PHASE, not skill.\n');

  for (const id of botIds) {
    const bot = SEED_BOTS.find((x) => x.id === id);
    const rows = [];
    for (const start of DEFAULT_STARTS) {
      const dbs = {};
      for (const s of bot.spec.universe) dbs[s] = (data[s] || []).filter((c) => istOf(c.t) >= start);
      const mkt = market.filter((c) => istOf(c.t) >= start);
      if (!mkt.length) continue;
      const rankSource = bot.spec.mlConfig ? makeRankSource({ spec: bot.spec, dataBySymbol: dbs }) : null;
      const r = runPortfolioBacktest({ spec: bot.spec, dataBySymbol: dbs, marketSeries: mkt, cash: 10_000_000, costModel: EQ, rankSource, recordTrades: false, intraday: false, alignCache: null });
      rows.push({ start, cr: r.metrics.finalEquity / 1e7, sharpe: r.metrics.sharpe, cagr: r.metrics.cagrPct });
    }
    if (!rows.length) continue;
    const crs = rows.map((r) => r.cr), shs = rows.map((r) => r.sharpe);
    const lo = Math.min(...crs), hi = Math.max(...crs);
    console.log(`=== ${bot.name} (${id}) ===`);
    for (const r of rows) console.log(`  starts ${r.start}   final ₹${r.cr.toFixed(2).padStart(7)} cr   CAGR ${r.cagr.toFixed(2).padStart(6)}%   xSharpe ${r.sharpe.toFixed(2)}`);
    console.log(`  → terminal wealth ${lo.toFixed(2)}–${hi.toFixed(2)} cr = ${(hi / lo).toFixed(2)}x, xSharpe ${Math.min(...shs).toFixed(2)}–${Math.max(...shs).toFixed(2)}, from PHASE ALONE\n`);
  }
  console.log('Read a single lifetime figure as ONE DRAW from that range, not as the strategy\'s value.');
}
