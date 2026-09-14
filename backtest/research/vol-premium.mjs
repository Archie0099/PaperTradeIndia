// vol-premium.mjs — what IS the option volatility premium in India, and is 1.2 the right number?
//
// WHY THIS IS THE MOST LOAD-BEARING NUMBER IN THE F&O HALF OF THIS PROJECT
// -----------------------------------------------------------------------
// There is no free historical option-price data, so every F&O backtest here PRICES its own
// options: `options-model.mjs` sets implied vol to `realizedVol(closes, end, 20) * volPremium`
// with volPremium ASSUMED to be 1.2. Three bots on the board sell premium against that
// assumption, and `fno-sensitivity.mjs` has already shown the uncomfortable consequence: at
// fair value (volPremium 1.0) every one of them loses after costs. So their profitability is
// not a finding about markets — it is the 1.2 read back to itself.
//
// India VIX is the only free series that can break that circle. It is NSE's 30-day implied
// volatility on NIFTY options, quoted in PERCENT, with daily history back to 2008. It is not
// tradeable (NSE's India VIX futures launched 2014 and were discontinued in 2017; no variance
// swap or inverse-VIX product exists here), so this is purely a measurement input.
//
// TWO DIFFERENT QUESTIONS, and conflating them is the easy mistake
// ----------------------------------------------------------------
//  (1) CALIBRATION — what should `volPremium` be? The model multiplies TRAILING 20-day
//      realized vol, so the honest calibration is exactly
//          ratio_t = IndiaVIX_t / realizedVol20_t
//      computed with THIS project's own `realizedVol`, so it calibrates the actual formula
//      rather than a re-derivation of it. Units: VIX is percent, realizedVol is an annualised
//      decimal, so the VIX is divided by 100 first.
//  (2) THE PREMIUM ITSELF — is an option seller actually paid? That is implied vol against
//      SUBSEQUENTLY realized vol:
//          vrp_t = IndiaVIX_t / realizedVol over the NEXT 21 trading days
//      A ratio above 1 means sellers were overpaid on average. This is a claim about markets;
//      (1) is a claim about a model input. A high (1) with a (2) near 1.0 would mean the model
//      is well calibrated to quoted prices AND that selling earns nothing — entirely possible.
//
// The US literature says to expect (2) to have compressed: Dew-Becker & Giglio (Chicago Fed WP
// 2025-17) find equity-index option alphas indistinguishable from zero for roughly fifteen
// years. So the per-year breakdown matters as much as the average.
//
// Read-only: fetches through the normal cached loader, writes nothing, changes no app state.
//
// Usage: node backtest/research/vol-premium.mjs

import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('vol-premium.mjs is a CLI tool; run it directly.');

const { loadCandles } = await import('../data.mjs');
const { realizedVol } = await import('../options-model.mjs');

const IST = 5.5 * 3600000;
const istDate = (t) => new Date(t + IST).toISOString().slice(0, 10);
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : NaN);

const { candles: vixC, source: vSrc } = await loadCandles('INDIAVIX', { interval: '1d', range: '20y' });
const { candles: nifC, source: nSrc } = await loadCandles('NIFTY', { interval: '1d', range: '20y' });
if (/synthetic/.test(vSrc) || /synthetic/.test(nSrc)) {
  console.error('refusing to measure: a series came back synthetic.');
  process.exit(1);
}
console.log(`India VIX: ${vixC.length} bars ${istDate(vixC[0].t)} -> ${istDate(vixC[vixC.length - 1].t)}`);
console.log(`NIFTY    : ${nifC.length} bars ${istDate(nifC[0].t)} -> ${istDate(nifC[nifC.length - 1].t)}\n`);

// Align on IST date. NIFTY drives the index because realizedVol reads its own close array.
const vixByDate = new Map(vixC.map((c) => [istDate(c.t), c.c]));
const nifCloses = nifC.map((c) => c.c);

// Realized vol over the NEXT `n` bars, in the same annualised-decimal units realizedVol uses.
function forwardVol(closes, start, n) {
  if (start + n >= closes.length) return null;
  const rets = [];
  for (let k = start + 1; k <= start + n; k++) {
    if (closes[k] > 0 && closes[k - 1] > 0) rets.push(Math.log(closes[k] / closes[k - 1]));
  }
  if (rets.length < 2) return null;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) ** 2, 0) / rets.length;
  return Math.sqrt(v) * Math.sqrt(252);
}

const rows = [];
for (let i = 20; i < nifC.length; i++) {
  const d = istDate(nifC[i].t);
  const vix = vixByDate.get(d);
  if (!Number.isFinite(vix) || vix <= 0) continue;
  const iv = vix / 100;                       // percent -> annualised decimal
  const rvTrail = realizedVol(nifCloses, i, 20); // the project's OWN function
  if (!(rvTrail > 0)) continue;
  const rvFwd = forwardVol(nifCloses, i, 21);
  rows.push({ date: d, year: d.slice(0, 4), iv, rvTrail, calib: iv / rvTrail, vrp: rvFwd ? iv / rvFwd : null });
}

if (rows.length < 200) { console.error(`only ${rows.length} aligned observations — refusing to conclude.`); process.exit(1); }

const calib = rows.map((r) => r.calib).sort((a, b) => a - b);
const vrpAll = rows.filter((r) => r.vrp != null).map((r) => r.vrp).sort((a, b) => a - b);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

console.log(`aligned observations: ${rows.length} (${rows[0].date} -> ${rows[rows.length - 1].date})\n`);

console.log('(1) CALIBRATION — India VIX / TRAILING 20d realized vol');
console.log('    This is literally what `volPremium` multiplies, so it is the number to use.');
console.log(`    mean ${mean(calib).toFixed(3)}   median ${pct(calib, 0.5).toFixed(3)}   p10 ${pct(calib, 0.1).toFixed(3)}   p90 ${pct(calib, 0.9).toFixed(3)}`);
console.log(`    the model currently assumes 1.200`);
const dCal = mean(calib) - 1.2;
console.log(`    -> measured ${dCal >= 0 ? 'ABOVE' : 'BELOW'} the assumption by ${Math.abs(dCal).toFixed(3)}\n`);

console.log('(2) THE PREMIUM ITSELF — India VIX / SUBSEQUENT 21d realized vol');
console.log('    Above 1.0 means sellers were, on average, overpaid. This is a market claim.');
console.log(`    mean ${mean(vrpAll).toFixed(3)}   median ${pct(vrpAll, 0.5).toFixed(3)}   p10 ${pct(vrpAll, 0.1).toFixed(3)}   p90 ${pct(vrpAll, 0.9).toFixed(3)}`);
console.log(`    share of days with VIX above subsequent realized: ${((vrpAll.filter((x) => x > 1).length / vrpAll.length) * 100).toFixed(1)}%\n`);

console.log('BY YEAR (has it compressed, as it has in the US?)');
console.log('  year   n    calib   premium');
const years = [...new Set(rows.map((r) => r.year))].sort();
for (const y of years) {
  const yr = rows.filter((r) => r.year === y);
  const c = yr.map((r) => r.calib);
  const v = yr.filter((r) => r.vrp != null).map((r) => r.vrp);
  console.log(`  ${y}  ${String(yr.length).padStart(4)}   ${mean(c).toFixed(3)}    ${v.length ? mean(v).toFixed(3) : '  -  '}`);
}

console.log('\nWHAT THIS MEANS FOR THE BOARD');
const m = mean(calib);
if (m < 1.15) {
  console.log(`  The assumed 1.2 is TOO GENEROUS to the premium sellers: quoted implied vol has run at`);
  console.log(`  ${m.toFixed(3)}x trailing realized, not 1.2x. Since fno-sensitivity.mjs already shows every`);
  console.log(`  seller losing at 1.0, and ${m.toFixed(3)} sits nearer 1.0 than 1.2, the F&O rows are flattered`);
  console.log(`  by the assumption rather than by an edge. Re-run fno-sensitivity at the measured value`);
  console.log(`  before any F&O figure is quoted again.`);
} else {
  console.log(`  The assumed 1.2 is within reach of the measured ${m.toFixed(3)} — the model input is defensible.`);
  console.log(`  That does NOT make the sellers profitable: see (2), which is the market question.`);
}
console.log('\n  ★ CAVEAT that bounds all of this: India VIX is a 30-day NIFTY-option implied vol, while');
console.log('  the model applies its multiplier to whatever expiry and strike a spec trades. The premium');
console.log('  is not flat across strikes (a real smile exists and this model has none), so treat the');
console.log('  measured figure as the ATM-ish, 30-day anchor, not a universal constant.');
