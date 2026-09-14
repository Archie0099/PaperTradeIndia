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
//        node backtest/research/cash-drag.mjs --phase          (adds the window-start sweep)
//
// --phase answers the question the single run cannot: the run above is ONE window, so a
// verdict that depends on a margin of ~0.01 is not a verdict at all. The sweep re-asks "does
// the best strategy clear the fair bar?" at several window starts and reports how often the
// accounting convention — not the strategies — decides the answer.

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
//
// ★ THE FAIR BAR IS NOT A COMPETITOR AND MUST NOT BE RANKED AS ONE.
// `bar-universe-equal` is the no-information CONTROL, added to the roster later than this tool — the
// whole universe at equal weight, no signal, no filter, no timing — put on the board so that
// "beats the index" stops being quotable as an achievement. Ranking it alongside the strategies
// asks "which row is highest", which is a different and much less interesting question than
// "which STRATEGY is best". Worse, because it is ungated it barely feels this convention at all
// (+0.005) while the gated strategies move by up to +0.090, so it drifts DOWN through them and
// manufactures rank swaps that say nothing about strategy selection.
//
// When this tool first ran the bar did not exist, and the finding was "same winner,
// only ranks 8/9 swap". Re-deriving the ordering on that same 13-bot set reproduces that result
// EXACTLY — so the Round-BS claim was right for the set it was measured on, and only the
// arrival of the control changed the printed verdict. The strategies are held out separately
// below so that claim stays comparable across rounds instead of silently flipping.
const BAR_ID = 'bar-universe-equal';
const strategies = rows.filter((r) => r.id !== BAR_ID);
const barRow = rows.find((r) => r.id === BAR_ID) || null;
const orderAsIs = [...strategies].sort((a, b) => b.asIs - a.asIs).map((r) => r.id);
const orderFixed = [...strategies].sort((a, b) => b.repaired - a.repaired).map((r) => r.id);
const swaps = [];
for (let i = 0; i < orderAsIs.length; i++) if (orderAsIs[i] !== orderFixed[i]) swaps.push({ i, was: orderAsIs[i], now: orderFixed[i] });
console.log('\nDOES IT CHANGE THE BOARD?  (strategies only — the fair bar is the yardstick, not a competitor)');
if (!swaps.length) {
  console.log(`  NO — all ${strategies.length} strategies keep their exact rank. Best stays ${orderAsIs[0]} either way.`);
  console.log('  So this convention is a LEVEL effect, not a selection effect: it understates every gated bot');
  console.log('  by a similar amount without reordering them. That makes it a reporting-honesty question');
  console.log('  rather than a correctness bug — which is the cheaper kind to decide.');
} else if (orderAsIs[0] === orderFixed[0]) {
  console.log(`  NOT AT THE TOP — ${swaps.length} rank position(s) move, but the BEST STRATEGY is unchanged`);
  console.log(`  (${orderAsIs[0]} either way), and the moves are:`);
  for (const s of swaps) console.log(`    rank ${s.i + 1}: ${s.was} -> ${s.now}`);
  console.log('  Treat this as a LEVEL effect for selection purposes — a reporting-honesty question rather');
  console.log('  than a correctness bug — while noting the ordering below the top is not perfectly stable.');
} else {
  console.log(`  YES — ${swaps.length} rank position(s) move AND the best strategy changes: ${orderAsIs[0]} -> ${orderFixed[0]}.`);
  for (const s of swaps) console.log(`    rank ${s.i + 1}: ${s.was} -> ${s.now}`);
  console.log('  That is a selection effect, not just a level effect.');
}
// ★ WHAT THIS TOOL MAY AND MAY NOT SAY ABOUT THE AUTO-PILOT.
// It ranks by LIFETIME xSharpe over one window. The Auto-Pilot does NOT: it re-picks at every
// rebalance bar using `sharpeUpTo` on data available AT THAT BAR, across every bot including
// the EQ/FNO/PAIRS rows this tool does not measure. The two rules genuinely diverge — the
// deployed board's champion is quant-riskparity, which this lifetime ranking does not put top.
// So a reorder here is SUGGESTIVE about which bot gets followed, never proof of it. Anyone
// wanting that answer must re-run computeAutopilotTrack under both conventions and diff the
// followedTimeline, which is how the guard in that function was checked for pick-neutrality.
console.log('  ★ This ranks LIFETIME xSharpe. The Auto-Pilot re-picks point-in-time at each rebalance over');
console.log('    ALL bots, so a reorder here is suggestive about what it would follow, never proof.');

// ---- THE COMPARISON THAT ACTUALLY MATTERS: does the best strategy clear the fair bar?
// The board exists to answer "is any of this better than holding the whole universe blind?".
// The gated strategies are the ones this convention understates and the bar is ungated, so the
// convention moves the two sides of that comparison by different amounts — and can therefore
// decide the answer. That is a far sharper consequence than any rank swap, and it is the reason
// this is not merely cosmetic.
if (barRow) {
  const bestAsIs = [...strategies].sort((a, b) => b.asIs - a.asIs)[0];
  const bestFixed = [...strategies].sort((a, b) => b.repaired - a.repaired)[0];
  const clearsAsIs = bestAsIs.asIs > barRow.asIs;
  const clearsFixed = bestFixed.repaired > barRow.repaired;
  console.log('\nDOES THE BEST STRATEGY CLEAR THE FAIR BAR?');
  console.log(`  as scored today : ${bestAsIs.id} ${bestAsIs.asIs.toFixed(3)} vs bar ${barRow.asIs.toFixed(3)}  -> ${clearsAsIs ? 'CLEARS' : 'DOES NOT CLEAR'}`);
  console.log(`  crediting cash  : ${bestFixed.id} ${bestFixed.repaired.toFixed(3)} vs bar ${barRow.repaired.toFixed(3)}  -> ${clearsFixed ? 'CLEARS' : 'DOES NOT CLEAR'}`);
  if (clearsAsIs !== clearsFixed) {
    console.log('  ★★ THE CONVENTION DECIDES THE VERDICT at this window start. The bar is ungated and barely');
    console.log('     moves (+' + barRow.delta.toFixed(3) + '); the best strategy is gated and moves +' + bestFixed.delta.toFixed(3) + '. So whether this');
    console.log('     project can say its best strategy beats a no-information portfolio of the same names');
    console.log('     depends on an accounting choice nobody has made. That is not cosmetic.');
    console.log('     ★ ONE WINDOW ONLY. Re-run across several start dates before quoting the flip:');
    console.log('       the deployed board has its best strategy well clear of the bar (0.97 vs 0.79).');
  } else {
    console.log(`  The verdict is the SAME under both conventions here, so on this window the accounting`);
    console.log(`  choice does not decide whether the board beats its own control. (One window only.)`);
  }
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

// ---------------------------------------------------------------------------------------
// --phase : IS THE "CLEARS THE FAIR BAR" VERDICT STABLE, OR IS IT AN ARTEFACT OF ONE WINDOW?
// ---------------------------------------------------------------------------------------
// Everything above is a single window, and the as-scored margin between the best strategy and
// the bar came out around 0.01 — far smaller than the convention's own effect on a gated bot
// (up to 0.090). A margin that thin cannot support a verdict, because the window-start sensitivity study shows the window
// start moves a basket's lifetime figure on its own: the rebalance grid is anchored to bar 0
// of the aligned timeline, so sliding the start slides every rebalance date with it.
//
// So: hold the data, specs, costs and END date fixed, slide ONLY the start bar, and re-ask the
// question at each. The interesting output is not any single row — it is how often the
// ACCOUNTING CHOICE, rather than the strategies, decides whether the board clears its control.
//
// ML baskets are excluded from the sweep: their rankSource must be rebuilt per window, which
// dominates the runtime, and none of them is near the top under either convention.
//
// ★ THESE STARTS ARE NOT INDEPENDENT DRAWS. They share an end date and most of their data, and
// (the same caveat that study carries) moving the start shifts the rebalance grid AND shortens the period, which
// this does not separate. Read the sweep as "how stable is the verdict across start dates
// nobody chose", never as a significance test.
if (process.argv.includes('--phase')) {
  const phaseBots = bots.filter((b) => !b.spec.mlConfig);
  const barBot = phaseBots.find((b) => b.id === BAR_ID);
  if (!barBot) {
    console.log('\n--phase needs the fair bar in the bot set; re-run without a botId filter.');
  } else {
    const OFFSETS = [0, 5, 21, 63, 126, 252]; // trading bars: a week, a month, a quarter, half a year, a year
    console.log('\n' + '='.repeat(104));
    console.log('--phase : DOES THE BEST STRATEGY CLEAR THE FAIR BAR AT OTHER WINDOW STARTS?');
    console.log('='.repeat(104));
    console.log('offset   best strategy            asIs   bar asIs  clears |  best(cash)  bar(cash)  clears | decided by');
    console.log('-'.repeat(104));
    const verdicts = [];
    for (const off of OFFSETS) {
      const sliced = {};
      for (const [s, c] of Object.entries(data)) sliced[s] = off ? c.slice(off) : c;
      const mkt = off ? market.slice(off) : market;
      const res = {};
      for (const bot of phaseBots) {
        const dbs = {};
        for (const s of bot.spec.universe) if (sliced[s]) dbs[s] = sliced[s];
        if (Object.keys(dbs).length < 2) continue;
        const r = runPortfolioBacktest({ spec: bot.spec, dataBySymbol: dbs, marketSeries: mkt, cash: 10_000_000, costModel: EQ, rankSource: null, recordTrades: false, intraday: false, alignCache: null });
        res[bot.id] = { asIs: sharpe(r.equityCurve), rep: sharpe(repairCurve(r.equityCurve)) };
      }
      const bar = res[BAR_ID];
      const strat = Object.entries(res).filter(([id]) => id !== BAR_ID);
      if (!bar || !strat.length) { console.log(String(off).padStart(6) + '   (incomplete — universe did not load at this offset)'); continue; }
      const bestAsIs = strat.slice().sort((a, b) => b[1].asIs - a[1].asIs)[0];
      const bestRep = strat.slice().sort((a, b) => b[1].rep - a[1].rep)[0];
      const cA = bestAsIs[1].asIs > bar.asIs;
      const cR = bestRep[1].rep > bar.rep;
      verdicts.push({ off, cA, cR, flips: cA !== cR });
      console.log(
        String(off).padStart(6) + '   ' + bestAsIs[0].padEnd(22) +
        bestAsIs[1].asIs.toFixed(3).padStart(7) + bar.asIs.toFixed(3).padStart(10) + (cA ? '     yes' : '      no') + ' |' +
        bestRep[1].rep.toFixed(3).padStart(11) + bar.rep.toFixed(3).padStart(11) + (cR ? '     yes' : '      no') + ' |' +
        (cA !== cR ? '  the CONVENTION' : '  the strategies')
      );
    }
    const n = verdicts.length;
    const flips = verdicts.filter((v) => v.flips).length;
    console.log('\nSUMMARY');
    console.log(`  window starts tested                       : ${n}`);
    console.log(`  clears the bar AS SCORED TODAY             : ${verdicts.filter((v) => v.cA).length} of ${n}`);
    console.log(`  clears the bar CREDITING IDLE CASH         : ${verdicts.filter((v) => v.cR).length} of ${n}`);
    console.log(`  verdict decided by the CONVENTION, not the strategies : ${flips} of ${n}`);
    if (flips) {
      console.log('\n  READ THIS CAREFULLY. The question "is the best thing on this board better than holding');
      console.log('  the whole universe blind?" is the headline honesty claim of the project. Under the');
      console.log('  convention in force today the answer is not stable — it depends on where a rolling');
      console.log('  20-year window happens to start, because the gated strategy is charged the hurdle for');
      console.log('  standing aside while the ungated control is not. That is an artefact of an accounting');
      console.log('  choice, not a fact about the strategies, and it is why this is NOT merely cosmetic.');
    }
  }
}
