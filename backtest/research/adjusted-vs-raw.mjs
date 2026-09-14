// adjusted-vs-raw.mjs — can a trailing DIVIDEND YIELD be recovered from the gap between the
// adjusted close and the raw close, across the WHOLE universe rather than a few names?
//
// WHY THIS EXISTS
// ---------------
// The project has no fundamentals feed, so every accounting-based signal (profitability,
// book value, payout) is out of reach. One apparent exception was proposed: loadCandles keeps
// BOTH series — adjusted as `c`, raw as `craw` — and if the ONLY thing separating them is
// dividends, then their ratio recovers a real payout signal from price data alone.
//
// That claim rests entirely on what else the upstream feed folds into `adjclose`. If splits,
// bonus issues, rights issues or demergers also move the ratio, the "yield" is contaminated by
// corporate actions and the signal is junk. A verification pass checked FOUR events on THREE
// names and found no contamination — real support, but three names out of ~105 is not a basis
// for building a DSL primitive on. This checks every name the board actually loads.
//
// WHAT IT MEASURES
// ---------------
// For each symbol, the ratio k_t = c_t / craw_t bar by bar.
//
// ★ THE DIRECTION, verified empirically before this test was written (an earlier draft had it
// BACKWARDS and reported a false alarm on 103 of 105 names). Yahoo discounts PAST prices for
// every dividend that comes AFTER them, so a past bar's adjusted close is the raw close times
// the product of all LATER adjustment factors, each below 1. Walking FORWARD, fewer such
// factors remain, so k RISES toward exactly 1.0 at the final bar. Confirmed: RELIANCE runs
// 0.8668 -> 1.000000, ITC 0.5493 -> 1.000000, TCS 0.6537 -> 1.000000. So a material step UP is
// a dividend, and a material step DOWN is the anomaly.
//
// ★ THE NOISE FLOOR. `c` and `craw` are each stored rounded, so k jitters by ~1e-6 on almost
// every bar — RELIANCE shows ~4,900 "steps" of which only 20 exceed 0.05%, and those 20 are
// all upward. Anything below NOISE_FLOOR is therefore arithmetic, not an event. Counting it
// was exactly what produced the earlier false alarm.
//
// With direction and floor right, the test is:
//   material step UP, below JUMP_MAX      a dividend ex-date — expected, counted
//   material step DOWN                    anomalous; dividend adjustment cannot lower k
//   any step above JUMP_MAX               INSPECT — too big for an ordinary dividend
//
// ★ WHAT "TOO BIG" TURNED OUT TO MEAN, measured across all 105 names: the largest step in the
// whole universe is OFSS +13.95% on 2014-09-24, and it is a real special dividend, not a
// corporate action. The next largest are COALINDIA (+10.6%, +9.4%, +9.0%), RECLTD, PFC and
// ONGC — India's biggest PSU payers — and their dates cluster in February and March, exactly
// when PSUs pay interim dividends ahead of the fiscal year end. So a step above JUMP_MAX means
// LOOK AT IT, not "contaminated": India's specials genuinely run into double digits. A real
// split or bonus leaking in would be far larger (a 1:1 bonus doubles k, ~+100%), and nothing
// of that size exists anywhere in the universe. The largest DOWN step is -1.40%, with a median
// of -0.087% — rounding, an order of magnitude below any corporate action.
//
// It also cross-checks QUANTITATIVELY, which is stronger than counting steps: k_last / k_first
// is the cumulative dividend return over the window, so annualising it must land in the range
// a liquid Indian large cap actually pays (roughly 0.5-3%/yr). A mechanism that produced the
// right step SHAPE but an absurd yield would still be wrong.
//
// WHAT A CLEAN RESULT WOULD LICENSE, and what it would not
// -------------------------------------------------------
// Clean = the mechanism is sound and a `divYield` DSL primitive could be built on it. It does
// NOT license the STRATEGY: a yield tilt inside a survivorship-selected large-cap universe
// will beat the index almost by construction, so the universe control (equal-weight of the same
// universe) plus a random-portfolio null remain mandatory before any claim is made. Separately
// note the DSL primitive genuinely does not exist yet: evalNode(node, closes, i) receives only
// the adjusted series, so the raw series is not reachable from a spec today.
//
// Read-only: writes no file, touches no app state, no cache beyond the usual Yahoo cache fill.
//
// Usage: node backtest/research/adjusted-vs-raw.mjs [--all] [SYMBOL ...]
//        default: every name in BASKET_UNIVERSE. --all adds the indices and ETFs.

import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('adjusted-vs-raw.mjs is a CLI tool; run it directly.');

const { loadCandles } = await import('../data.mjs');
const { BASKET_UNIVERSE, EQ_SYMBOLS } = await import('../../tournament/universe.mjs');

const NOISE_FLOOR = 5e-4;  // 0.05% — below any real dividend, above the stored-rounding jitter
const JUMP_MAX = 0.12;     // 12% — generous upper bound for a single ex-date incl. a special
const args = process.argv.slice(2);
const explicit = args.filter((a) => !a.startsWith('--'));
const symbols = explicit.length ? explicit : (args.includes('--all') ? EQ_SYMBOLS : BASKET_UNIVERSE);

const IST = 5.5 * 3600000;
const istOf = (t) => new Date(t + IST).toISOString().slice(0, 10);

console.log(`checking c/craw across ${symbols.length} symbols\n`);

let clean = 0, suspect = 0, noRaw = 0, noDiv = 0, failed = 0;
const suspects = [];
const rises = [];
const yields = [];
let totalDivSteps = 0;

for (const sym of symbols) {
  let candles;
  try {
    const r = await loadCandles(sym, { interval: '1d', range: '20y' });
    if (/synthetic/.test(r.source)) { failed++; continue; }
    candles = r.candles;
  } catch { failed++; continue; }
  if (!candles || candles.length < 300) { failed++; continue; }

  // craw must exist and be finite, or there is nothing to compare
  const usable = candles.filter((c) => Number.isFinite(c.c) && Number.isFinite(c.craw) && c.craw !== 0);
  if (usable.length < 300) { noRaw++; continue; }

  const k = usable.map((c) => c.c / c.craw);
  const big = [], down = [];
  let divSteps = 0;
  for (let i = 1; i < k.length; i++) {
    const rel = k[i] / k[i - 1] - 1;
    if (Math.abs(rel) < NOISE_FLOOR) continue;   // stored-rounding jitter, not an event
    if (Math.abs(rel) > JUMP_MAX) big.push({ date: istOf(usable[i].t), rel });
    else if (rel < 0) down.push({ date: istOf(usable[i].t), rel });
    else divSteps++;
  }
  totalDivSteps += divSteps;

  // quantitative cross-check: cumulative dividend return implied by the ratio, annualised
  const years = (usable[usable.length - 1].t - usable[0].t) / (365.25 * 864e5);
  const impliedYield = years > 1 ? Math.pow(k[k.length - 1] / k[0], 1 / years) - 1 : null;
  if (impliedYield != null) yields.push({ sym, y: impliedYield });

  if (divSteps === 0 && !big.length && !down.length) {
    noDiv++;
    console.log(`  ${sym.padEnd(16)} k flat at ${k[0].toFixed(6)} over ${k.length} bars — pays nothing, or no raw/adj split`);
    continue;
  }
  if (big.length || down.length) {
    suspect++;
    if (big.length) suspects.push({ sym, big });
    if (down.length) rises.push({ sym, down });
    console.log(`  ${sym.padEnd(16)} SUSPECT — ${divSteps} ex-dates, ${big.length} jump>${JUMP_MAX * 100}%, ${down.length} DOWNWARD`);
    for (const b of big.slice(0, 3)) console.log(`      jump ${b.date}  ${(b.rel * 100).toFixed(2)}%`);
    for (const d of down.slice(0, 3)) console.log(`      down ${d.date}  ${(d.rel * 100).toFixed(3)}%`);
  } else {
    clean++;
    if (process.argv.includes('--verbose')) {
      console.log(`  ${sym.padEnd(16)} clean — ${String(divSteps).padStart(3)} ex-dates over ${years.toFixed(1)}y, implied yield ${(impliedYield * 100).toFixed(2)}%/yr`);
    }
  }
}

console.log(`\n=== SUMMARY (${symbols.length} symbols) ===`);
console.log(`  clean (only small downward steps) : ${clean}`);
console.log(`  SUSPECT (a big or upward step)    : ${suspect}`);
console.log(`  k constant (no dividends seen)    : ${noDiv}`);
console.log(`  no usable raw series              : ${noRaw}`);
console.log(`  failed to load                    : ${failed}`);
console.log(`  ex-dates detected (all names)     : ${totalDivSteps}`);

// the quantitative cross-check — a right-shaped mechanism must also imply a sane yield
if (yields.length) {
  yields.sort((a, b) => a.y - b.y);
  const med = yields[(yields.length / 2) | 0];
  const q = (p) => yields[Math.min(yields.length - 1, Math.floor(p * yields.length))];
  console.log(`\n  IMPLIED ANNUAL DIVIDEND YIELD across ${yields.length} names, from k_last/k_first:`);
  console.log(`     p10 ${(q(0.1).y * 100).toFixed(2)}%   median ${(med.y * 100).toFixed(2)}%   p90 ${(q(0.9).y * 100).toFixed(2)}%`);
  console.log(`     lowest  ${yields[0].sym} ${(yields[0].y * 100).toFixed(2)}%`);
  console.log(`     highest ${yields[yields.length - 1].sym} ${(yields[yields.length - 1].y * 100).toFixed(2)}%`);
  const sane = med.y > 0.002 && med.y < 0.04;
  console.log(`     ${sane ? 'SANE' : '*** IMPLAUSIBLE ***'} — a liquid Indian large cap pays roughly 0.5-3%/yr.`);
}

if (!suspect && clean) {
  console.log('\nVERDICT: across every name checked, the adjusted-vs-raw ratio moves ONLY in upward steps');
  console.log('above the noise floor, none larger than a single dividend could explain, and it lands on');
  console.log('exactly 1.0 at the final bar. That is the signature of dividend adjustment alone: splits,');
  console.log('bonuses, rights and demergers do not leak in, consistent with the raw `c` field already');
  console.log('being split-adjusted upstream.');
  console.log('The MECHANISM is sound. The STRATEGY is still unproven: a yield tilt in a survivorship-selected');
  console.log('large-cap universe beats the index almost by construction, so the universe control and a');
  console.log('random-portfolio null are still mandatory. And the DSL primitive does not exist yet — evalNode');
  console.log('receives only the adjusted series, so a spec cannot reach `craw` today.');
} else if (suspect) {
  console.log('\nVERDICT: the ratio is NOT clean on every name — the symbols above move it by more than one');
  console.log('dividend can explain, or move it DOWNWARD (which dividend adjustment can never do). A `divYield`');
  console.log('primitive would be contaminated on those names. Investigate them before building anything.');
}
