// cov-alignment.mjs — the optimiser's covariance window pairs returns from DIFFERENT
// calendar dates. How often, why, what it does to the weights, and does it reach the result?
//
// WHY THIS EXISTS
// ---------------
// portfolio.mjs builds the covariance window for the mean-variance / risk-parity weightings
// out of each chosen name's OWN last `covLookback` returns, ending at that name's own decision
// bar. Row u of every column is therefore "this name's u-th most recent return", NOT "the
// return on date D". Those coincide only while every chosen name traded on exactly the same
// days; a name that lacks a bar the others have reaches one bar further back, and its whole
// column is displaced against the others from there on.
//
// optimizer.mjs had always said so, in a header note that also judged it harmless:
//
//     "for a name with interior gaps the pairing is approximate — acceptable because
//      (a) such names are rare in this universe and (b) the optimiser degrades to
//      inverse-vol when the covariance is ill-conditioned anyway."
//
// Neither had been measured. (a) is roughly right and now quantified; (b) is WRONG — see
// below. The original form is quoted here on purpose so the correction stays legible.
//
// ★★ THE CAUSE IS NOT IN THE OPTIMISER. The first version of this study said it was, and a
// a later re-check found otherwise. The affected names are not missing sessions — the GRID
// has too many. `alignSeries` builds the master timeline from the UNION of every symbol's
// timestamps, so a date that two symbols printed on becomes a bar for all of them. See the
// THIN DATES section: five such dates explain 100% of the misalignment, one of them a
// Saturday. Repairing the covariance window treats a symptom; dropping thin dates from the
// grid would remove the cause — and would also take them out of the price grid, out of
// marking, and out of the `rebalanceBars` counter, which counts GRID bars. That restates
// published figures, so it is a user decision, not a silent fix.
//
// THE MECHANISM (registered before measuring, and it survived)
// -----------------------------------------------------------
// Displacing a column drives its covariance with every other name toward zero — daily equity
// returns are strongly correlated contemporaneously and barely at a one-day lag. A name that
// looks uncorrelated looks like a DIVERSIFIER, and both optimisers reward that. Prediction:
// a displaced name is systematically OVER-weighted, not randomly perturbed.
//
// ★ IT IS THE CORRELATION, NOT THE VARIANCE, and the obvious argument for that is wrong.
// "Reordering a column cannot change its variance" describes a PERMUTATION; sliding a window
// drops the newest return and adds an older one, so the sample really does change (measured:
// -0.06%). The clean separation is the two control arms below: a cyclic ROLL keeps the
// multiset bit-identical and reproduces the whole effect, while rescaling an aligned column to
// the slid column's sd does nothing.
//
// WHAT IS COMPARED
// ----------------
//   OWN     — what portfolio.mjs does today: each name's own last covLookback returns.
//   DATES   — returns over the last covLookback intervals between dates on which EVERY chosen
//             name traded. Intervals can span more than one session, but the same interval for
//             everyone. Reads nothing after the decision bar.
//   PLACEBO — a control the first version lacked: on an ALIGNED bar, drop one common date for
//             EVERYBODY. That applies the return-horizon change and the extra lookback reach
//             with ZERO alignment change, so it says how much of an own-vs-dates difference is
//             not about alignment at all. ★ Mean-variance FAILS this control — the placebo
//             moves its weights more than the whole real difference does — so no mean-variance
//             number here is attributable to alignment. Risk-parity clears it ~6:1.
//
// ★ ALWAYS SAY WHICH BASIS. Misalignment is ~3x more common on the board's untrimmed timeline
// than on one cut to the market's span.
// ★ AND SAY WHICH DENOMINATOR: "3.2% of rebalances" is the most flattering of three true
// numbers (per displaced column 0.61%, per displaced return cell 0.21%, and in absolute terms
// six rebalances in twenty years).
//
// Usage:  node backtest/research/cov-alignment.mjs [botId ...] [--scale]
// Read-only: loads cached data, runs backtests in memory, writes nothing.

import { pathToFileURL } from 'node:url';

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) throw new Error('cov-alignment.mjs is a CLI tool; run it directly.');

const { loadCandles } = await import('../data.mjs');
const { runPortfolioBacktest, alignSeries } = await import('../portfolio.mjs');
const { meanVarWeights, riskParityWeights } = await import('../optimizer.mjs');
const { equityDeliveryCosts } = await import('../costs.mjs');
const { sharpe, cagrPct } = await import('../metrics.mjs');
const { makeRankSource } = await import('../ml.mjs');
const { SEED_BOTS } = await import('../../tournament/seed.mjs');

const EQ = equityDeliveryCosts();
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const bots = SEED_BOTS.filter((b) => b.kind === 'BASKET'
  && (b.spec.weighting === 'meanvar' || b.spec.weighting === 'riskparity')
  && (!wanted.length || wanted.includes(b.id)));
if (!bots.length) { console.error('no optimiser BASKET bots matched'); process.exit(1); }

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
console.log(`data: ${Object.keys(data).length} names loaded (${dropped} dropped), market ${market.length} bars\n`);

// ---------------------------------------------------------------------------
// THIN DATES — the actual cause
// ---------------------------------------------------------------------------
// A grid date held by only a handful of the names that had already listed is not a session;
// it is a stray print that alignSeries promoted to a bar for everybody.
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function thinDates(A, names, threshold = 0.99) {
  const { master, realIdx, timesBy } = A;
  const out = [];
  for (let p = 0; p < master.length; p++) {
    let listed = 0, held = 0;
    for (const s of names) {
      const ri = realIdx[s][p];
      if (ri < 0) continue;            // not listed yet — cannot be expected to hold the date
      listed++;
      if (timesBy[s][ri] === master[p]) held++;
    }
    if (listed && held / listed < threshold) out.push({ p, t: master[p], held, listed });
  }
  return out;
}
{
  const A = alignSeries(data, market);
  const nifty = new Set(market.map((c) => c.t));
  const names = Object.keys(data).sort();
  const thin = thinDates(A, names);
  console.log('THIN DATES — why the columns are displaced at all');
  console.log(`  master grid ${A.master.length} bars vs NIFTY ${market.length}; grid dates NIFTY has no bar for: ${A.master.filter((t) => !nifty.has(t)).length}`);
  console.log(`  grid dates held by <99% of ALREADY-LISTED names: ${thin.length}`);
  for (const d of thin) {
    const dt = new Date(d.t);
    console.log(`    ${dt.toISOString().slice(0, 10)} ${DOW[dt.getUTCDay()]}  held by ${d.held}/${d.listed} (${(100 * d.held / d.listed).toFixed(1)}%)`);
  }
  console.log('  ^ these are stray prints the UNION promoted to real bars. A name lacking one has');
  console.log('    its whole trailing window displaced against the names that carry it.');
  console.log('  ★ ALSO UNEXAMINED, and larger: the grid dates NIFTY lacks which nearly every stock');
  console.log('    HAS. If those are real sessions the index feed missed, then the market proxy every');
  console.log('    basket gates on is short ~16 sessions a year. Separate question, not measured here.\n');
}

// ---- window builders -------------------------------------------------------
function colsByDates(A, syms, gi, L) {
  const { master, realIdx, closesBy, timesBy } = A;
  const hasBarAt = (s, p) => { const ri = realIdx[s][p]; return ri >= 0 && timesBy[s][ri] === master[p]; };
  const pos = [];
  for (let p = gi; p >= 0 && pos.length < L + 1; p--) if (syms.every((s) => hasBarAt(s, p))) pos.push(p);
  if (pos.length < L + 1) return null;
  pos.reverse();
  const cols = [];
  for (const s of syms) {
    const cl = closesBy[s], ri = realIdx[s];
    const rets = new Array(L);
    for (let u = 0; u < L; u++) {
      const a = cl[ri[pos[u]]], b = cl[ri[pos[u + 1]]];
      if (!(a > 0) || !(b > 0)) return null;
      rets[u] = b / a - 1;
    }
    cols.push(rets);
  }
  return { cols, span: pos[pos.length - 1] - pos[0] };
}

function colsByOwn(A, syms, gi, L) {
  const { realIdx, closesBy, timesBy } = A;
  const cols = [], stamps = [];
  for (const s of syms) {
    const tri = realIdx[s][gi], cl = closesBy[s];
    if (tri < L) return null;
    const rets = new Array(L), ts = new Array(L);
    for (let u = 0; u < L; u++) {
      const j = tri - L + 1 + u;
      if (!(cl[j - 1] > 0)) return null;
      rets[u] = cl[j] / cl[j - 1] - 1;
      ts[u] = timesBy[s][j];
    }
    cols.push(rets); stamps.push(ts);
  }
  return { cols, stamps };
}

// Ablation arms on an ALIGNED bar, everything but the named change held fixed.
//   'slide' : pull one column back a whole bar   (upper bound — real gaps are never whole-column)
//   'gap'   : delete ONE session `frac` of the way back for ONE name and rebuild its own
//             window — partial displacement plus a two-day seam, i.e. what really happens
//   'roll'  : cyclically rotate one column — identical multiset, so variance is bit-identical
//             and ONLY the alignment changes. The clean test of the stated cause.
//   'var'   : rescale an aligned column to the slid column's sd — variance change, correlations
//             intact. The other half of the same test.
function ablate(A, syms, gi, L, idx, arm, frac = 0.5) {
  const { realIdx, closesBy } = A;
  const cols = [];
  for (let n = 0; n < syms.length; n++) {
    const s = syms[n];
    const cl = closesBy[s];
    const tri = realIdx[s][gi];
    if (tri < L + 2) return null;
    const rets = [];
    if (n !== idx || arm === 'roll' || arm === 'var') {
      for (let u = 0; u < L; u++) {
        const j = tri - L + 1 + u;
        if (!(cl[j - 1] > 0)) return null;
        rets.push(cl[j] / cl[j - 1] - 1);
      }
    } else if (arm === 'slide') {
      for (let u = 0; u < L; u++) {
        const j = tri - 1 - L + 1 + u;
        if (!(cl[j - 1] > 0)) return null;
        rets.push(cl[j] / cl[j - 1] - 1);
      }
    } else if (arm === 'gap') {
      // Drop the session at `frac` back: bars after it keep their real returns, the seam
      // spans two sessions, and one extra bar is pulled in at the far end.
      const skip = tri - Math.floor(L * frac);
      for (let j = tri; rets.length < L; j--) {
        if (j === skip) continue;
        const prev = j - 1 === skip ? j - 2 : j - 1;
        if (prev < 1 || !(cl[prev] > 0)) return null;
        rets.unshift(cl[j] / cl[prev] - 1);
      }
    }
    cols.push(rets);
  }
  if (arm === 'roll') {
    const c = cols[idx];
    cols[idx] = c.slice(1).concat(c.slice(0, 1));
  } else if (arm === 'var') {
    const slid = ablate(A, syms, gi, L, idx, 'slide');
    if (!slid) return null;
    const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
    const base = cols[idx], want = sd(slid[idx]), have = sd(base);
    if (!(have > 0)) return null;
    const m = base.reduce((x, y) => x + y, 0) / base.length;
    cols[idx] = base.map((v) => m + (v - m) * (want / have));
  }
  return cols;
}

const solve = (weighting, cols, mu, gross, maxWeight) => (weighting === 'meanvar'
  ? meanVarWeights(cols, mu, gross, maxWeight)
  : riskParityWeights(cols, gross, maxWeight));

const modeKey = (stamps) => {
  const c = new Map();
  for (const ts of stamps) { const k = `${ts[0]}:${ts[ts.length - 1]}`; c.set(k, (c.get(k) || 0) + 1); }
  let best = null, bn = -1;
  for (const [k, n] of c) if (n > bn) { bn = n; best = k; }
  return best;
};

// ---------------------------------------------------------------------------
// PER BOT: frequency, the real weight effect, the placebo, and the ablation arms
// ---------------------------------------------------------------------------
for (const bot of bots) {
  const L = bot.spec.covLookback || 63;
  const dbs = {};
  for (const s of bot.spec.universe) if (data[s]) dbs[s] = data[s];
  const rankSource = bot.spec.mlConfig ? makeRankSource({ spec: bot.spec, dataBySymbol: dbs }) : null;
  const uni = [...bot.spec.universe].filter((s) => Array.isArray(dbs[s]) && dbs[s].length).sort();
  const dfu = {}; for (const s of uni) dfu[s] = dbs[s];
  const A = alignSeries(dfu, market);
  const thin = new Set(thinDates(A, uni).map((d) => d.t));

  const probes = [];
  runPortfolioBacktest({
    spec: bot.spec, dataBySymbol: dbs, marketSeries: market, cash: 10_000_000,
    costModel: EQ, rankSource, recordTrades: false, intraday: false, alignCache: null,
    _covProbe: (p) => probes.push(p),
  });

  let solved = 0, bailed = 0, misaligned = 0, explainedByThin = 0;
  let cells = 0, cellsBad = 0, colsSeen = 0, colsBad = 0;
  let realSum = 0, realN = 0, worst = null;
  const dispFrac = [];
  let realDown = 0, realUp = 0;
  let plaSum = 0, plaN = 0, plaMax = 0;
  const arms = { slide: [], gap25: [], gap50: [], gap75: [], roll: [], var: [] };

  for (const p of probes) {
    if (!p.optimised || !p.syms.length) { bailed++; continue; }
    solved++;
    const own = colsByOwn(A, p.syms, p.gi, L);
    if (!own) continue;
    const key = modeKey(own.stamps);
    const shifted = own.stamps.map((ts) => `${ts[0]}:${ts[ts.length - 1]}` !== key);
    colsSeen += p.syms.length;
    cells += p.syms.length * L;
    const ref = own.stamps[shifted.indexOf(false) >= 0 ? shifted.indexOf(false) : 0];

    if (shifted.some(Boolean)) {
      misaligned++;
      colsBad += shifted.filter(Boolean).length;
      for (let i = 0; i < p.syms.length; i++) {
        if (!shifted[i]) continue;
        let diff = 0;
        for (let u = 0; u < L; u++) if (own.stamps[i][u] !== ref[u]) diff++;
        cellsBad += diff;
        dispFrac.push(diff / L);
      }
      if ([...thin].some((t) => t >= ref[0] && t <= ref[ref.length - 1])) explainedByThin++;

      const dat = colsByDates(A, p.syms, p.gi, L);
      if (dat) {
        const wOwn = solve(p.weighting, own.cols, p.mu, p.gross, p.maxWeight);
        const wDat = solve(p.weighting, dat.cols, p.mu, p.gross, p.maxWeight);
        if (wOwn && wDat && wOwn.length === wDat.length) {
          let mx = 0, arg = -1;
          for (let i = 0; i < wOwn.length; i++) { const d = Math.abs(wOwn[i] - wDat[i]); if (d > mx) { mx = d; arg = i; } }
          realSum += mx; realN++;
          if (!worst || mx > worst.mx) worst = { mx, t: p.t, sym: p.syms[arg], o: wOwn[arg], d: wDat[arg] };
          for (let i = 0; i < p.syms.length; i++) {
            if (!shifted[i] || wOwn[i] === wDat[i]) continue;
            if (wOwn[i] > wDat[i]) realDown++; else realUp++;
          }
        }
      }
      continue;
    }

    // ---- ALIGNED bar: the placebo and the ablation arms
    const base = solve(p.weighting, own.cols, p.mu, p.gross, p.maxWeight);
    if (!base) continue;
    const dat = colsByDates(A, p.syms, p.gi, L);
    if (dat) {
      // PLACEBO: drop one common date for EVERYBODY (horizon + reach, no alignment change)
      const shortened = colsByDates(A, p.syms, p.gi - 1, L);
      if (shortened) {
        const wS = solve(p.weighting, shortened.cols, p.mu, p.gross, p.maxWeight);
        if (wS && wS.length === base.length) {
          let mx = 0;
          for (let i = 0; i < base.length; i++) mx = Math.max(mx, Math.abs(wS[i] - base[i]));
          plaSum += mx; plaN++; plaMax = Math.max(plaMax, mx);
        }
      }
    }
    for (const [armName, spec] of [['slide', ['slide']], ['gap25', ['gap', 0.25]], ['gap50', ['gap', 0.5]], ['gap75', ['gap', 0.75]], ['roll', ['roll']], ['var', ['var']]]) {
      for (let i = 0; i < p.syms.length; i++) {
        const c2 = ablate(A, p.syms, p.gi, L, i, spec[0], spec[1]);
        if (!c2) continue;
        const w2 = solve(p.weighting, c2, p.mu, p.gross, p.maxWeight);
        if (!w2 || w2.length !== base.length) continue;
        if (base[i] === 0 && w2[i] === 0) continue;
        arms[armName].push(w2[i] - base[i]);
      }
    }
  }

  const pct = (n, d) => (d ? (100 * n / d).toFixed(2) : '0.00');
  console.log(`=== ${bot.id}  (${bot.spec.weighting}, k=${bot.spec.k}, every ${bot.spec.rebalanceBars} bars, covLookback=${L})`);
  console.log('  basis: the FULL union timeline, untrimmed — what the deployed board runs on.');
  console.log(`  optimiser solves ${solved} (${bailed} fell back before solving)`);
  console.log(`  MISALIGNED, three honest denominators:`);
  console.log(`    per rebalance    : ${misaligned}/${solved} = ${pct(misaligned, solved)}%   <- the flattering one`);
  console.log(`    per column       : ${colsBad}/${colsSeen} = ${pct(colsBad, colsSeen)}%`);
  console.log(`    per return cell  : ${cellsBad}/${cells} = ${pct(cellsBad, cells)}%`);
  console.log(`    in absolute terms: ${misaligned} rebalances in ~20 years`);
  console.log(`  explained by a THIN DATE inside the window: ${explainedByThin}/${misaligned}`);
  if (dispFrac.length) {
    const mean = dispFrac.reduce((a, b) => a + b, 0) / dispFrac.length;
    console.log(`  displaced share of a shifted column: ${(100 * Math.min(...dispFrac)).toFixed(1)}%..${(100 * Math.max(...dispFrac)).toFixed(1)}%, mean ${(100 * mean).toFixed(1)}%  (never 100%)`);
  }
  if (realN) {
    console.log(`  REAL effect (own vs dates, misaligned bars, n=${realN}): mean max |dw| ${(100 * realSum / realN).toFixed(2)} pp`);
    console.log(`    worst: ${(100 * worst.mx).toFixed(2)} pp on ${worst.sym} @ ${new Date(worst.t).toISOString().slice(0, 10)} (own ${(100 * worst.o).toFixed(1)}% vs dates ${(100 * worst.d).toFixed(1)}%)`);
    console.log(`    displaced columns that LOSE weight when date-aligned: ${realDown}/${realDown + realUp}  <- the prediction, observed on real bars`);
  }
  if (plaN) {
    const pm = 100 * plaSum / plaN;
    const rm = realN ? 100 * realSum / realN : 0;
    console.log(`  PLACEBO (horizon + reach, NO alignment change, n=${plaN}): mean max |dw| ${pm.toFixed(2)} pp, worst ${(100 * plaMax).toFixed(2)} pp`);
    console.log(`    placebo / real = ${realN ? (100 * pm / rm).toFixed(0) : '?'}%  -> ${realN && pm < rm / 2 ? 'alignment dominates; this arm is measurable' : 'NOT ATTRIBUTABLE TO ALIGNMENT — the control moves weights as much or more'}`);
  }
  const fmt = (a) => {
    if (!a.length) return 'n/a';
    const up = a.filter((x) => x > 0).length;
    const mean = a.filter((x) => x !== 0).reduce((s, x) => s + x, 0) / Math.max(1, a.filter((x) => x !== 0).length);
    return `${(100 * up / a.length).toFixed(1)}% gain, mean ${(mean >= 0 ? '+' : '') + (100 * mean).toFixed(3)} pp  (n=${a.length})`;
  };
  console.log('  ABLATION on ALIGNED bars — does a displaced column gain weight?');
  console.log(`    slide (whole column, UPPER BOUND) : ${fmt(arms.slide)}`);
  console.log(`    gap 25% back                      : ${fmt(arms.gap25)}`);
  console.log(`    gap mid-window (TYPICAL)          : ${fmt(arms.gap50)}`);
  console.log(`    gap 75% back                      : ${fmt(arms.gap75)}`);
  console.log(`    roll (same multiset: variance FIXED, alignment destroyed) : ${fmt(arms.roll)}`);
  console.log(`    var  (variance changed, correlations INTACT)              : ${fmt(arms.var)}`);
  console.log('    ^ roll reproducing slide while var does nothing is what identifies the CORRELATION');
  console.log('      as the channel. Quote the gap rows, not slide: real displacement is partial.');
  console.log('');
}

// ---------------------------------------------------------------------------
// --scale : how far does the exposure go if the knobs move?
// ---------------------------------------------------------------------------
if (process.argv.includes('--scale')) {
  const A = alignSeries(data, market);
  const { master, realIdx } = A;
  const names = Object.keys(data).sort();
  console.log('--scale : misalignment exposure vs the covariance lookback');
  console.log('  covLookback   name-bars   bars with >=1   k=8 draw');
  for (const L of [42, 63, 126, 252, 504]) {
    let pairs = 0, bad = 0, barsAny = 0, barsN = 0, sumP = 0;
    for (let gi = L; gi < master.length; gi++) {
      let live = 0, gappy = 0;
      for (const s of names) {
        const tri = realIdx[s][gi];
        if (tri < L || gi - L + 1 < 0) continue;
        live++;
        if (realIdx[s][gi - L + 1] !== tri - L + 1) gappy++;
      }
      if (!live) continue;
      pairs += live; bad += gappy; barsN++; if (gappy) barsAny++;
      let q = 1;
      for (let i = 0; i < 8 && live - gappy - i > 0; i++) q *= (live - gappy - i) / (live - i);
      sumP += 1 - Math.max(0, q);
    }
    console.log(`  ${String(L).padStart(11)}   ${(100 * bad / pairs).toFixed(2).padStart(8)}%   `
      + `${(100 * barsAny / barsN).toFixed(1).padStart(12)}%   ${(100 * sumP / barsN).toFixed(1).padStart(7)}%`);
  }
  console.log('  ^ both live optimiser bots sit at 126. evolve.mjs can reach 252; validateSpec allows 504,');
  console.log('    so re-enabling breeding raises both the number of exposed bots and each one\'s exposure.\n');
}

// ---------------------------------------------------------------------------
// END-TO-END: does any of this reach the RESULT?
// ---------------------------------------------------------------------------
// Both arms get IDENTICAL data, spec, costs and window; only the covariance construction
// differs, so this is a within-run comparison — the only kind that is safe when the
// rebalance grid moves with the window start (see research/phase-sensitivity.mjs).
//
// ★ MANY STARTS, AND NONE A MULTIPLE OF `rebalanceBars`. The rebalance grid is counted from
// bar 0 of the aligned timeline, so shifting the start by a whole number of rebalance
// periods lands every decision on the same dates — a sweep of 0/21/63/126/252 looks like five
// window starts and is really ONE draw. The first version of this tool did exactly that.
// ★ AND SIX STARTS IS NOT ENOUGH EITHER. With six, this study reported |dxSharpe| <= 0.0035
// with a consistent sign for risk-parity/trimmed. Both were artefacts of the sample: at 19
// starts the max is ~0.008 and EVERY bot x basis combination flips sign. Report the LEAN, never
// a bound and never a sign — and do not run a significance test on these, because the starts
// share an end date and ~99% of their data.
const marketFrom = market[0].t;
const trimmed = {};
for (const [s, c] of Object.entries(data)) { const w = c.filter((x) => x.t >= marketFrom); if (w.length) trimmed[s] = w; }
const unionGrid = [...new Set(Object.values(data).flatMap((c) => c.map((x) => x.t)))].sort((a, b) => a - b);

const OFFSETS = [0, 5, 11, 17, 23, 26, 29, 34, 37, 41, 46, 52, 55, 59, 64, 67, 71, 76, 80];
console.log('END-TO-END: the same backtest built both ways (DATES minus OWN), many window starts.\n');

for (const bot of bots) for (const basis of ['board', 'trimmed']) {
  const source = basis === 'trimmed' ? trimmed : data;
  const anchor = basis === 'trimmed' ? market.map((c) => c.t) : unionGrid;
  const dbsAll = {};
  for (const s of bot.spec.universe) if (source[s]) dbsAll[s] = source[s];
  const rankSource = bot.spec.mlConfig ? makeRankSource({ spec: bot.spec, dataBySymbol: dbsAll }) : null;
  const diffs = [];
  let maxAbs = 0, maxAt = null;
  for (const off of OFFSETS) {
    if (off >= anchor.length) continue;
    const fromT = anchor[off], toT = anchor[anchor.length - 1];
    const win = (arr) => arr.filter((c) => c.t >= fromT && c.t <= toT);
    const sliced = {};
    for (const [s, c] of Object.entries(dbsAll)) { const w = win(c); if (w.length) sliced[s] = w; }
    const mkt = win(market);
    const run = (covAlign) => runPortfolioBacktest({
      spec: bot.spec, dataBySymbol: sliced, marketSeries: mkt, cash: 10_000_000,
      costModel: EQ, rankSource, recordTrades: false, intraday: false, alignCache: null, covAlign,
    });
    const own = run('own'), dat = run('dates');
    // Recomputed from the curves: summarize() rounds sharpe to TWO decimals, which at this
    // magnitude prints a tidy "+0.000" that is rounding, not measurement.
    const dS = sharpe(dat.equityCurve) - sharpe(own.equityCurve);
    const dW = dat.equityCurve[dat.equityCurve.length - 1] / own.equityCurve[own.equityCurve.length - 1] - 1;
    diffs.push({ off, fromT, dS, dW });
    if (Math.abs(dS) > maxAbs) { maxAbs = Math.abs(dS); maxAt = { off, fromT, dS, dW }; }
  }
  const pos = diffs.filter((x) => x.dS > 0).length, neg = diffs.filter((x) => x.dS < 0).length;
  const lean = pos > neg ? 'positive' : neg > pos ? 'negative' : 'even';
  console.log(`=== ${bot.id} [${basis}]  ${diffs.length} starts`);
  console.log(`  sign tally: ${pos}+ / ${neg}-   -> leans ${lean} (${(100 * Math.max(pos, neg) / diffs.length).toFixed(0)}%), NOT a consistent sign`);
  console.log(`  largest |dxSharpe| ${maxAbs.toFixed(4)} at ${new Date(maxAt.fromT).toISOString().slice(0, 10)} (dwealth ${(maxAt.dW >= 0 ? '+' : '') + (100 * maxAt.dW).toFixed(2)}%)`);
  console.log(`  median |dxSharpe| ${[...diffs].map((d) => Math.abs(d.dS)).sort((a, b) => a - b)[Math.floor(diffs.length / 2)].toFixed(4)}`);
  console.log('');
}
console.log('Against a ~0.25 xSharpe spread from rebalance phase alone, all of this is noise.');
console.log('The finding worth acting on is the THIN DATES above, and that is a grid question, not');
console.log('an optimiser one — and fixing it restates board figures, so it is left open.');
