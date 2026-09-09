// ---------------------------------------------------------------------------
// backtest/research/hedged-seller.mjs
// STUDY: does delta-hedging rescue the option sellers?
//
// The board's premium sellers are NAKED, and the F&O honesty check already says
// that at fair value (volPremium 1.0) every one of them loses after costs — the
// modelled edge exists only if options are systematically priced ABOVE realised
// volatility (the 1.2 assumption). A naked seller's P&L, though, mixes two
// questions: "was there a volatility premium?" and "did the market happen not
// to crash?". Delta-hedging isolates the first: a hedged seller's P&L is
// (implied − realised) volatility, minus what the daily rebalancing costs.
//
// This run replays the SAME monthly cycles the fno backtester uses (21 bars,
// ATM straddle or ±6% strangle at the model IV) on real NIFTY history, and
// prices each cycle two ways on the same path: naked, and delta-hedged daily
// with the index future at the volatility that was sold (Hull's set-up).
//
// ★ WHAT THIS IS NOT. Not a strategy pick and not a board bot: it is a
// mechanism study over the whole history (in-sample by construction — there is
// nothing to fit, but there is also no holdout claim). Options are MODELLED
// (Black–Scholes at realised vol × premium; no free real chain exists), and the
// hedge-instrument cost is an ASSUMPTION run as a sensitivity (0 / 2 / 5 bps
// per side), stated rather than claimed — no sourced index-futures schedule
// lives in this repo (see costs.mjs). Every number printed is
// "indicative", like every other F&O figure here.
//
// Reproduce: node backtest/research/hedged-seller.mjs
// ---------------------------------------------------------------------------

import { loadCandles } from '../data.mjs';
import { modelIV, R } from '../options-model.mjs';
import { indexOptionCosts } from '../costs.mjs';
import { summarize } from '../metrics.mjs';
import { simulateDeltaHedge, nakedSellerPnl } from '../hedge.mjs';

const HOLD_BARS = 21;          // one monthly cycle, as in backtest/fno.mjs
const LOT = 75;                // NIFTY lot size
const LOTS = 1;                // one lot per cycle on a ₹10L account (margin ≈ ₹1.5L) — realistic, not levered
const CASH = 1_000_000;
const roundStrike = (x, step = 50) => Math.round(x / step) * step;

const SPECS = {
  'ATM straddle': (spot) => [{ type: 'CE', K: roundStrike(spot) }, { type: 'PE', K: roundStrike(spot) }],
  '±6% strangle': (spot) => [{ type: 'CE', K: roundStrike(spot * 1.06) }, { type: 'PE', K: roundStrike(spot * 0.94) }],
};

// Option-leg costs, identical for naked and hedged: sell-side statutory schedule on the
// premium, half a bid–ask spread on each leg, flat brokerage per order.
const OPT = indexOptionCosts();
const legCost = (premiumPerUnit, units) => units * premiumPerUnit * (OPT.sellRate + OPT.halfSpreadPct) + OPT.brokeragePerOrder;

function runStudy({ closes, times, volPremium, hedgeCostRate, spec }) {
  const units = LOT * LOTS;
  const cycles = [];
  for (let i = 20; i + HOLD_BARS < closes.length; i += HOLD_BARS) {
    const spot = closes[i];
    const iv = modelIV(closes, i, { volPremium });
    const legs = spec(spot).map((l) => ({ ...l, units }));
    const path = closes.slice(i, i + HOLD_BARS + 1); // HOLD_BARS periods, expiry at the last close
    const T = HOLD_BARS / 252;
    const naked = nakedSellerPnl({ legs, path, T, r: R, sigma: iv });
    const hedged = simulateDeltaHedge({ legs, path, T, r: R, sigma: iv, costRate: hedgeCostRate });
    const optCosts = legs.reduce((s, l) => s + legCost(naked.premium / units / legs.length, l.units), 0);
    cycles.push({ t: times[i], naked: naked.pnl - optCosts, hedged: hedged.pnl - optCosts, premium: naked.premium, hedgeTrading: hedged.tradingCosts });
  }
  const curve = (key) => { let e = CASH; const out = [e]; for (const c of cycles) { e += c[key]; out.push(e); } return out; };
  const stats = (key) => {
    const eq = curve(key);
    const s = summarize(eq, { years: cycles.length / 12, periodsPerYear: 12 });
    const worst = cycles.reduce((w, c) => (c[key] < w.pnl ? { pnl: c[key], t: c.t } : w), { pnl: Infinity, t: null });
    // Both Sharpes: the project's headline is EXCESS of a 6.5% risk-free hurdle, which punishes a
    // low-volatility series with a small positive drift (3% CAGR at ~1% vol reads −1.5); the rf=0
    // figure is printed beside it so the hedged rows can be read for what they are.
    return { totalReturnPct: s.totalReturnPct, cagrPct: s.cagrPct, sharpe: s.sharpe, sharpeRf0: s.sharpeRf0, maxDrawdownPct: s.maxDrawdownPct, worstCyclePct: +(worst.pnl / CASH * 100).toFixed(2), worstCycleDate: worst.t ? new Date(worst.t).toISOString().slice(0, 10) : null, losingCycles: cycles.filter((c) => c[key] < 0).length };
  };
  return { cycles: cycles.length, naked: stats('naked'), hedged: stats('hedged'), avgHedgeTradingCosts: +(cycles.reduce((s, c) => s + c.hedgeTrading, 0) / cycles.length).toFixed(0) };
}

const { candles } = await loadCandles('NIFTY', { interval: '1d', range: '20y' });
const closes = candles.map((c) => c.c);
const times = candles.map((c) => c.t);
console.log(`NIFTY ${closes.length} bars, ${new Date(times[0]).toISOString().slice(0, 10)} → ${new Date(times.at(-1)).toISOString().slice(0, 10)}; ${LOTS} lot/cycle on ₹${CASH.toLocaleString('en-IN')}; daily delta-hedge with the index future at the SOLD vol.`);
console.log('★ Options MODELLED (BS at realised vol × premium). Hedge cost per side is an ASSUMPTION (sensitivity below). In-sample mechanism study, not a strategy pick.\n');

const fmt = (s) => `${String(s.totalReturnPct).padStart(8)}%  CAGR ${String(s.cagrPct).padStart(6)}%  Sharpe ${String(s.sharpe).padStart(6)} (rf0 ${String(s.sharpeRf0).padStart(5)})  maxDD ${String(s.maxDrawdownPct).padStart(6)}%  worst cycle ${String(s.worstCyclePct).padStart(7)}% (${s.worstCycleDate})  losing ${s.losingCycles}`;
for (const [name, spec] of Object.entries(SPECS)) {
  console.log(`=== ${name} ===`);
  for (const volPremium of [1.0, 1.1, 1.2]) {
    const base = runStudy({ closes, times, volPremium, hedgeCostRate: 0, spec });
    console.log(`volPremium ${volPremium.toFixed(1)}  (${base.cycles} cycles)`);
    console.log(`  naked                      ${fmt(base.naked)}`);
    for (const bps of [0, 2, 5]) {
      const r = bps === 0 ? base : runStudy({ closes, times, volPremium, hedgeCostRate: bps / 10000, spec });
      console.log(`  hedged @ ${String(bps).padStart(1)} bps/side  ${fmt(r.hedged)}   [avg hedge trading cost/cycle ₹${r.avgHedgeTradingCosts}]`);
    }
  }
  console.log();
}
console.log('Reading guide: the NAKED line at volPremium 1.0 is the F&O honesty check (every seller loses at fair value).');
console.log('The HEDGED lines answer a narrower question — is there a volatility premium net of rebalancing? — and at 1.0 they should sit near zero minus costs: no premium, no edge, by construction.');
console.log('Compare worst-cycle and maxDD naked vs hedged: that gap is what the hedge buys, and the CAGR gap at 1.2 is what it costs.');
