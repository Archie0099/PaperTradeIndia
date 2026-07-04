// ---------------------------------------------------------------------------
// backtest/run-generated.mjs
// Backtests a batch of GENERATED strategy specs across a small UNIVERSE of
// symbols, and ranks them by ROBUST performance — the MEDIAN return across
// symbols — to favour edges that generalise over one-symbol flukes. Buy & Hold
// and a coin-flip control are shown as the bars to beat.
//
//   node backtest/run-generated.mjs [specs.json]
//   (defaults to backtest/generated-specs.json)
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { safeCompile } from './dsl.mjs';
import { runBacktest } from './backtester.mjs';
import { equityDeliveryCosts } from './costs.mjs';

// Rank the generated strategies under the REAL Indian cost schedule (see costs.mjs).
const EQ_COSTS = equityDeliveryCosts();
import { runFnoBacktest } from './fno.mjs';
import { loadCandles } from './data.mjs';
import { STRATEGIES } from './strategies.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EQ_UNIVERSE = ['NIFTY', 'RELIANCE', 'TCS', 'INFY'];
const FNO_UNIVERSE = { NIFTY: { lotSize: 75, strikeStep: 50 }, BANKNIFTY: { lotSize: 35, strikeStep: 100 } };
const CASH = 1_000_000;
const RANGE = '5y';

const specsFile = process.argv[2] || join(HERE, 'generated-specs.json');
const specs = JSON.parse(readFileSync(specsFile, 'utf8'));

// Preload (and cache) candle data once per symbol.
const data = {};
for (const sym of [...new Set([...EQ_UNIVERSE, ...Object.keys(FNO_UNIVERSE)])]) {
  data[sym] = (await loadCandles(sym, { range: RANGE })).candles;
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function scoreSpec(spec) {
  const c = safeCompile(spec);
  if (!c.ok) return { ok: false, error: c.error };
  const rows = [];
  if (c.kind === 'EQ') {
    for (const sym of EQ_UNIVERSE) rows.push(runBacktest({ strategy: c.strategy, candles: data[sym], symbol: sym, cash: CASH, costModel: EQ_COSTS }).metrics);
  } else {
    for (const [sym, fspec] of Object.entries(FNO_UNIVERSE)) rows.push(runFnoBacktest({ strategy: c.strategy, candles: data[sym], symbol: sym, cash: CASH, ...fspec }).metrics);
  }
  return {
    ok: true,
    kind: c.kind,
    medReturn: +median(rows.map((r) => r.totalReturnPct)).toFixed(2),
    medSharpe: +median(rows.map((r) => r.sharpe)).toFixed(2),
    worstDD: +Math.max(...rows.map((r) => r.maxDrawdownPct)).toFixed(2),
  };
}

// Reference rows: Buy & Hold + Coin flip, median across the equity universe.
const refOf = (name) => {
  const s = STRATEGIES.find((x) => x.name === name);
  const rows = EQ_UNIVERSE.map((sym) => runBacktest({ strategy: s, candles: data[sym], symbol: sym, cash: CASH, costModel: EQ_COSTS }).metrics);
  return { medReturn: +median(rows.map((r) => r.totalReturnPct)).toFixed(2), medSharpe: +median(rows.map((r) => r.sharpe)).toFixed(2) };
};
const bh = refOf('Buy & Hold');
const coin = refOf('Coin flip (control)');

const scored = [];
let invalid = 0;
for (const s of specs) {
  const r = scoreSpec(s);
  if (!r.ok) { invalid++; continue; }
  scored.push({ name: s.name, persona: s._persona || '', ...r });
}
scored.sort((a, b) => b.medReturn - a.medReturn);

console.log(`\nAI Strategy Arena — ${specs.length} generated specs (${invalid} invalid skipped), scored by MEDIAN return across ${EQ_UNIVERSE.length} symbols.`);
console.log(`Bars to beat:  Buy & Hold  median ${bh.medReturn}% (Sharpe ${bh.medSharpe})   |   Coin flip  median ${coin.medReturn}% (Sharpe ${coin.medSharpe})\n`);

const padR = (s, w) => String(s).padEnd(w);
const padL = (s, w) => String(s).padStart(w);
console.log(padR('#', 3) + padR('Strategy', 30) + padR('Kind', 5) + padL('MedRet%', 9) + padL('MedShrp', 9) + padL('WorstDD%', 10) + '  Persona');
console.log('-'.repeat(82));
scored.slice(0, 20).forEach((r, i) => console.log(
  padR(i + 1, 3) + padR(String(r.name).slice(0, 29), 30) + padR(r.kind, 5) + padL(r.medReturn, 9) + padL(r.medSharpe, 9) + padL(r.worstDD, 10) + '  ' + r.persona
));

const beatBH = scored.filter((r) => r.medReturn > bh.medReturn).length;
const beatCoin = scored.filter((r) => r.medSharpe > coin.medSharpe).length;
console.log(`\n${beatBH}/${scored.length} valid strategies beat Buy & Hold on median return;  ${beatCoin}/${scored.length} beat the coin flip on median Sharpe.`);
console.log('Reminder: a 5-year bull-market sample + modelled F&O prices. "Beats buy-hold here" is NOT proof of real edge — forward-paper-test before believing.\n');
