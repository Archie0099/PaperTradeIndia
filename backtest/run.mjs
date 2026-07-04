// ---------------------------------------------------------------------------
// backtest/run.mjs
// The Strategy Arena: backtest every strategy over a symbol's history and print
// one combined leaderboard — EQUITY (long-only timing) AND, for index symbols,
// F&O (option-selling) strategies — all on the same capital, so they compete
// head to head. All free + offline-capable.
//
//   node backtest/run.mjs [SYMBOL] [range]
//   e.g.  node backtest/run.mjs NIFTY 5y
//         node backtest/run.mjs RELIANCE 10y     (equity only — not an index)
// ---------------------------------------------------------------------------

import { STRATEGIES } from './strategies.mjs';
import { runBacktest } from './backtester.mjs';
import { FNO_STRATEGIES, runFnoBacktest } from './fno.mjs';
import { loadCandles } from './data.mjs';
import { equityDeliveryCosts, indexOptionCosts } from './costs.mjs';

// Index option specs (lot size + strike grid). Only these get F&O strategies —
// single-stock option lots/grids vary and aren't wired up for the MVP.
const INDEX_SPECS = {
  NIFTY: { lotSize: 75, strikeStep: 50 },
  BANKNIFTY: { lotSize: 35, strikeStep: 100 },
  FINNIFTY: { lotSize: 65, strikeStep: 50 },
};

const symbol = (process.argv[2] || 'NIFTY').toUpperCase();
const range = process.argv[3] || '5y';
const CASH = 1_000_000;
// The real all-in Indian cost schedules (backtest/costs.mjs): STT/stamp/exchange/
// GST + slippage on equity; spread + charges + brokerage on options.
const EQ_COSTS = equityDeliveryCosts();
const OPT_COSTS = indexOptionCosts();

const { candles, source } = await loadCandles(symbol, { range });
const n = candles.length;
const first = candles[0];
const last = candles[n - 1];
const span = first && last
  ? `${new Date(first.t).toISOString().slice(0, 10)} → ${new Date(last.t).toISOString().slice(0, 10)}`
  : '';

console.log(`\nStrategy Arena — ${symbol}   (${n} daily bars   ${span})`);
console.log(`Data: ${source}   Capital: ₹${CASH.toLocaleString('en-IN')}   Costs: full Indian schedule (~${(EQ_COSTS.buyRate * 10000).toFixed(1)}bps equity buy side; options pay spread + charges)`);

const results = STRATEGIES.map((s) => ({
  type: 'EQ',
  ...runBacktest({ strategy: s, candles, symbol, cash: CASH, costModel: EQ_COSTS }),
}));

const spec = INDEX_SPECS[symbol];
if (spec) {
  console.log(`F&O: option prices are Black-Scholes-MODELLED (realized vol x 1.2) — not real quotes; monthly cycles, lot ${spec.lotSize}.`);
  for (const s of FNO_STRATEGIES) {
    results.push({ type: 'F&O', ...runFnoBacktest({ strategy: s, candles, symbol, cash: CASH, costModel: OPT_COSTS, ...spec }) });
  }
} else {
  console.log('F&O: skipped (not a known index symbol).');
}
console.log('');

results.sort((a, b) => b.metrics.totalReturnPct - a.metrics.totalReturnPct);

const padR = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
const header =
  padR('#', 3) + padR('Strategy', 26) + padR('Kind', 5) + padL('Return%', 9) + padL('CAGR%', 8) +
  padL('Sharpe', 8) + padL('MaxDD%', 8) + padL('Trades', 8) + padL('Final', 14);
console.log(header);
console.log('-'.repeat(header.length));
results.forEach((r, idx) => {
  const m = r.metrics;
  console.log(
    padR(idx + 1, 3) + padR(r.name, 26) + padR(r.type, 5) + padL(m.totalReturnPct, 9) + padL(m.cagrPct, 8) +
    padL(m.sharpe, 8) + padL(m.maxDrawdownPct, 8) + padL(m.trades, 8) +
    padL('₹' + Math.round(m.finalEquity).toLocaleString('en-IN'), 14)
  );
});
console.log('\nBenchmark to beat: "Buy & Hold". Anything that cannot beat "Coin flip (control)"');
console.log('on a risk-adjusted basis is almost certainly noise. F&O P&L is modelled — treat as indicative.\n');
