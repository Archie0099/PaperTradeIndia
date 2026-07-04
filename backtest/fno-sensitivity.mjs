// ---------------------------------------------------------------------------
// backtest/fno-sensitivity.mjs
// The F&O honesty check: how much of the option-sellers' edge is the MODEL?
//
// There is no free historical option data, so the F&O backtests price options at
// (trailing realized vol × volPremium) — see options-model.mjs. That volPremium
// (default 1.2, "options trade richer than the vol that then realizes") is the
// single assumption the whole premium-selling edge rests on: at 1.0 you sell
// options at exactly fair value and only costs remain. A quant never asserts one
// number for that — they show the sensitivity. This script runs every F&O
// strategy at volPremium 1.0 / 1.1 / 1.2 (with the REAL Indian option cost
// schedule) and prints the grid, so the claim "the sellers make money" can be
// read as what it is: conditional on the vol-risk-premium assumption.
//
//   node backtest/fno-sensitivity.mjs [SYMBOL] [range]
//   e.g.  node backtest/fno-sensitivity.mjs NIFTY 10y
// ---------------------------------------------------------------------------

import { FNO_STRATEGIES, runFnoBacktest } from './fno.mjs';
import { loadCandles } from './data.mjs';
import { indexOptionCosts } from './costs.mjs';

const INDEX_SPECS = {
  NIFTY: { lotSize: 75, strikeStep: 50 },
  BANKNIFTY: { lotSize: 35, strikeStep: 100 },
  FINNIFTY: { lotSize: 65, strikeStep: 50 },
};

const symbol = (process.argv[2] || 'NIFTY').toUpperCase();
const range = process.argv[3] || '10y';
const CASH = 1_000_000;
const PREMIUMS = [1.0, 1.1, 1.2];
const spec = INDEX_SPECS[symbol];
if (!spec) {
  console.error(`No F&O spec for ${symbol} — use one of: ${Object.keys(INDEX_SPECS).join(', ')}`);
  process.exit(1);
}

const { candles, source } = await loadCandles(symbol, { range });
console.log(`\nF&O volPremium sensitivity — ${symbol}  (${candles.length} bars, data: ${source})`);
console.log(`Costs: real Indian option schedule (spread + STT + exchange charges + brokerage).`);
console.log(`volPremium = the assumed richness of option prices over realized vol. 1.0 = fair value.\n`);

const padR = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
const header = padR('Strategy', 28) + padL('volPrem', 8) + padL('Return%', 9) + padL('CAGR%', 8) + padL('Sharpe', 8) + padL('MaxDD%', 8) + padL('Fees ₹', 12);
console.log(header);
console.log('-'.repeat(header.length));

for (const s of FNO_STRATEGIES) {
  for (const volPremium of PREMIUMS) {
    const res = runFnoBacktest({ strategy: s, candles, symbol, cash: CASH, costModel: indexOptionCosts(), volPremium, ...spec });
    const m = res.metrics;
    console.log(
      padR(s.name, 28) + padL(volPremium.toFixed(1), 8) + padL(m.totalReturnPct, 9) + padL(m.cagrPct, 8) +
      padL(m.sharpe, 8) + padL(m.maxDrawdownPct, 8) + padL(Math.round(res.costs.feesPaid).toLocaleString('en-IN'), 12)
    );
  }
  console.log('-'.repeat(header.length));
}
console.log('Read the 1.0 row first: with options at FAIR value, selling premium nets ~zero minus');
console.log('costs. Whatever survives at 1.1–1.2 is the assumed vol-risk premium, not proven edge.\n');
