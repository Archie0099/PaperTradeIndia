// ---------------------------------------------------------------------------
// tournament/seed.mjs
// The starting line-up of the live paper-trading tournament. Each bot is a DSL
// spec + starting virtual cash (₹1 crore). Deliberate variety so different
// trading philosophies compete head-to-head:
//   * a benchmark (Buy & Hold the index),
//   * three F&O premium-SELLERS (so we watch option tail-risk play out live),
//   * multi-company BASKET bots — each dynamically PICKS and REBALANCES a
//     portfolio of the best names from a broad 36-stock universe, NOT a single symbol:
//       - momentum, low-volatility (gated), and breakout RULE baskets, plus
//       - TWO genuine local-ML baskets (a ridge regressor and a logistic
//         classifier) that LEARN which stocks to hold — free, local, no API, plus
//       - THREE ACTIVE opportunity-hunters (momentum / breakout / dip-buyer) that
//         rotate WEEKLY into the strongest fresh names across the whole universe, plus
//       - the QUANT LAB four: a multi-factor composite, a mean-variance (Markowitz)
//         optimiser, a risk-parity optimiser, and a gradient-boosted-tree ranker —
//         all free, local, deterministic, look-ahead-safe.
//
// Evolution (a local genetic algorithm) then breeds challengers across BOTH the
// strategy AND the basket/ML configuration, so the roster explores what works.
//
// VIRTUAL money only. These bots never place a real order.
// ---------------------------------------------------------------------------

import { BASKET_UNIVERSE, ETF_UNIVERSE } from './universe.mjs';

// The seed baskets slice their hunting field from the (~200-name) BASKET_UNIVERSE.
// A single basket is capped at MAX_BASKET_UNIVERSE (240, see dsl.mjs). Each basket
// hunts across a broad field (a ~3-5× coverage jump over the original 24/30). We do
// NOT scan the WHOLE ~200 per basket — the per-rebalance scoring (and ML training)
// cost grows ~linearly with the scan width, so ~100-140 is the measured sweet spot
// that keeps the daily computeStandings responsive on the free host. The full pool is
// still available to evolution / future widening.
//   WIDE  — a broad 120-name field for the CHEAP baskets: rule (momentum/low-vol/breakout/dip/
//           guarded), the multi-factor composite, and the optimisers (mean-variance/risk-parity).
//           These only RANK the N names (cheap) and then work on the small chosen k, so scanning
//           120 names is a ~4-5× coverage jump at low cost — the bulk of the board hunts wide.
//   CORE  — a narrower 40-name field for the LOCAL-ML baskets (ridge/logistic/GBM). These TRAIN a
//           model on every scanned name's features walk-forward, so their cost grows fast with the
//           scan width; 40 bounds the daily computeStandings while still ~1.7× the old 24.
// (The cost split was MEASURED — scanning the whole ~200 per ML basket made the daily recompute
//  too heavy on the free host.)
const WIDE = BASKET_UNIVERSE.slice(0, 120);
const CORE = BASKET_UNIVERSE.slice(0, 40);

// Sector-clustered subset for the market-neutral PAIRS (stat-arb) bot. Pairs trading
// needs names that genuinely CO-MOVE, which is where they cluster by sector — two
// banks, two IT majors, two metal names — so this is a deliberately tight list of
// banks / IT / metals / pharma rather than a broad cross-sector field.
const PAIRS_UNIVERSE = [
  'HDFCBANK', 'ICICIBANK', 'AXISBANK', 'KOTAKBANK', 'SBIN', // banks
  'TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM',               // IT
  'TATASTEEL', 'JSWSTEEL', 'HINDALCO',                      // metals
  'SUNPHARMA', 'CIPLA', 'DRREDDY',                          // pharma
];
// A broader field for the PATIENT (longer-horizon) pairs bot — adds energy/utilities
// and autos clusters so it hunts a different, more diversified set of co-moving pairs.
const PAIRS_UNIVERSE_WIDE = [
  ...PAIRS_UNIVERSE,
  'ONGC', 'NTPC', 'POWERGRID', 'COALINDIA', // energy / utilities
  'MARUTI', 'HEROMOTOCO',                    // autos (HEROMOTOCO replaced TATAMOTORS — see universe.mjs)
];

const SEED_BOTS = [
  {
    id: 'buy-hold',
    name: 'Buy & Hold',
    note: 'Benchmark — always fully invested in the index.',
    kind: 'EQ',
    symbol: 'NIFTY',
    protected: true, // the benchmark is never retired by evolution
    spec: { kind: 'EQ', name: 'Buy & Hold', weight: 1 },
  },

  // --- BEARISH sleeve (directional coverage: bull / bear / neutral) -----------
  // Almost every other bot is long-only (bullish) and the PAIRS bots are market-
  // NEUTRAL — so the board had no way to PROFIT when the market falls. This bot fills
  // that gap: using the new `side:'short'` DSL flag, it SHORTS the index (NIFTY)
  // whenever it is in a confirmed downtrend (the 50-DMA below the 200-DMA — the classic
  // "death cross") and covers when the trend turns back up. It makes money in exactly
  // the regime that hurts the long-only bots, so it also HEDGES the board.
  {
    id: 'bearish-trend',
    name: 'Bearish trend (short the index)',
    note: 'Shorts NIFTY while it is in a downtrend (50-DMA below the 200-DMA); covers when the trend turns up. The board’s BEARISH sleeve — profits when the market falls and hedges the long-only bots.',
    kind: 'EQ',
    symbol: 'NIFTY',
    spec: { kind: 'EQ', name: 'Bearish trend (short the index)', side: 'short', entry: ['<', ['sma', 50], ['sma', 200]], exit: ['>', ['sma', 50], ['sma', 200]], weight: 1 },
  },

  // --- F&O premium sellers (modelled Black-Scholes; indicative) --------------
  {
    id: 'defensive-strangle',
    name: 'Defensive far-OTM strangle',
    note: 'Best backtest Sharpe — sell 8% OTM CE+PE monthly.',
    kind: 'FNO',
    symbol: 'NIFTY',
    spec: { kind: 'FNO', name: 'Defensive far-OTM strangle', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.08 }, { type: 'PE', side: 'SELL', strikePct: 0.92 }] },
  },
  {
    id: 'wide-strangle',
    name: 'Wide 6% strangle',
    note: 'Top backtest return — sell 6% OTM CE+PE (2 lots each).',
    kind: 'FNO',
    symbol: 'BANKNIFTY',
    spec: { kind: 'FNO', name: 'Wide 6% strangle', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.06, lots: 2 }, { type: 'PE', side: 'SELL', strikePct: 0.94, lots: 2 }] },
  },
  {
    id: 'atm-straddle',
    name: 'ATM short straddle (naked)',
    note: 'The steamroller risk — sell ATM CE+PE, undefined risk both sides.',
    kind: 'FNO',
    symbol: 'NIFTY',
    spec: { kind: 'FNO', name: 'ATM short straddle', legs: [{ type: 'CE', side: 'SELL', strikePct: 1.0 }, { type: 'PE', side: 'SELL', strikePct: 1.0 }] },
  },

  // --- multi-company BASKET bots (the new "trade many companies" core) --------
  {
    id: 'basket-momentum',
    name: 'Momentum basket',
    note: 'Hold the 3 strongest names by 6-month return; rebalance monthly.',
    kind: 'BASKET',
    spec: { kind: 'BASKET', name: 'Momentum basket', universe: WIDE, rank: ['mom', 126], k: 3, weighting: 'equal', rebalanceBars: 21 },
  },
  {
    id: 'basket-lowvol',
    name: 'Low-volatility basket',
    note: 'Hold the 4 calmest up-trending names, inverse-vol weighted.',
    kind: 'BASKET',
    spec: { kind: 'BASKET', name: 'Low-volatility basket', universe: WIDE, rank: ['*', -1, ['vol', 20]], k: 4, weighting: 'volinv', gate: ['>', ['price'], ['sma', 200]], rebalanceBars: 21 },
  },
  {
    id: 'basket-breakout',
    name: 'Breakout basket',
    note: 'Hold the 3 names nearest their 6-month high, only while trending up.',
    kind: 'BASKET',
    spec: { kind: 'BASKET', name: 'Breakout basket', universe: WIDE, rank: ['distHigh', 126], k: 3, weighting: 'equal', gate: ['>', ['mom', 63], 0], rebalanceBars: 21 },
  },
  {
    id: 'basket-ml-ridge',
    name: 'ML ridge basket',
    note: 'A LOCAL ridge regressor learns which names to hold (free, no API).',
    kind: 'BASKET',
    spec: {
      kind: 'BASKET', name: 'ML ridge basket', universe: CORE, rank: ['mom', 63], k: 3, weighting: 'rankw', rebalanceBars: 21,
      mlConfig: { model: 'ridge', features: ['mom21', 'mom63', 'rsi14', 'smaSlope', 'zscore50', 'volratio'], horizon: 21, lambda: 1, lookback: 504, trainEveryBars: 42, minTrain: 80 },
    },
  },
  {
    id: 'basket-ml-logistic',
    name: 'ML logistic basket',
    note: 'A LOCAL logistic classifier predicts each month’s top performers.',
    kind: 'BASKET',
    spec: {
      kind: 'BASKET', name: 'ML logistic basket', universe: CORE, rank: ['mom', 63], k: 3, weighting: 'equal', rebalanceBars: 21,
      mlConfig: { model: 'logistic', features: ['mom21', 'mom63', 'rsi14', 'smaSlope', 'zscore50', 'volratio'], horizon: 21, lambda: 1, lookback: 504, trainEveryBars: 42, minTrain: 80 },
    },
  },

  // --- QUANT LAB (principled quantitative-finance bots) ----------------------
  // These showcase the quant layer built on top of the basket machinery — a real
  // multi-factor model, a portfolio optimiser (mean-variance & risk-parity), and a
  // tree-ensemble ML ranker. All free, local, deterministic, look-ahead-safe. They run
  // ALONGSIDE the existing bots (grow mode) so you can compare quant vs rule head-to-head.
  {
    id: 'quant-multifactor',
    name: 'Multi-factor basket',
    note: 'Blend momentum + low-volatility + trend + reversal into one composite rank; hold the top 4. Steps to cash in a confirmed market downturn (a buffered regime filter) — over 20y this ~halves the drawdown (55%→28%) while keeping the Sharpe.',
    kind: 'BASKET',
    spec: {
      kind: 'BASKET', name: 'Multi-factor basket', universe: WIDE,
      rank: ['mom', 126], // fallback / tie-break (the factor composite is the real score)
      factors: [
        { name: 'momentum', expr: ['mom', 126], weight: 1 },
        { name: 'low-vol', expr: ['*', -1, ['vol', 20]], weight: 0.7 },
        { name: 'trend', expr: ['slope', 50], weight: 0.8 },
        { name: 'reversal', expr: ['*', -1, ['rsi', 14]], weight: 0.4 },
      ],
      k: 4, weighting: 'rankw', rebalanceBars: 21,
      // DOWN-REGIME PROTECTION (the quant "tuning"): step entirely to cash when NIFTY is in a
      // CONFIRMED downtrend — more than 5% below its 100-day average. The 5% buffer is what
      // makes this a NET win: a naive "below the 200-DMA" gate whipsaws and hurt the Sharpe
      // (tested: 1.02→0.92), but this buffered 100-DMA gate only triggers in real declines
      // (2008/2011/2015/2020/2022), so it protects in the crash and stays invested in the
      // bull — over 20y it cut max drawdown 55%→28% with the Sharpe slightly UP (1.02→1.04).
      marketGate: ['>', ['price'], ['*', 0.95, ['sma', 100]]],
    },
  },
  {
    id: 'quant-meanvar',
    name: 'Mean-variance basket',
    note: 'Pick the strongest trending names, then size them by Markowitz mean-variance on a Ledoit-Wolf covariance. Steps to cash in a confirmed market downturn (buffered regime filter) — over 20y this cut the drawdown 48%→30% at no Sharpe cost.',
    kind: 'BASKET',
    spec: {
      kind: 'BASKET', name: 'Mean-variance basket', universe: WIDE,
      rank: ['mom', 126], k: 6, weighting: 'meanvar', rebalanceBars: 21,
      covLookback: 126, maxWeight: 0.4, gate: ['>', ['price'], ['sma', 200]],
      marketGate: ['>', ['price'], ['*', 0.95, ['sma', 100]]], // see quant-multifactor — buffered regime protection
    },
  },
  {
    id: 'quant-riskparity',
    name: 'Risk-parity basket',
    note: 'Hold a broad set of up-trending names, sized so each contributes EQUALLY to portfolio risk. Steps to cash in a confirmed market downturn (buffered regime filter) — over 20y this cut the drawdown 54%→23% without sacrificing the risk-adjusted return (in-sample; the Live column is the judge).',
    kind: 'BASKET',
    spec: {
      kind: 'BASKET', name: 'Risk-parity basket', universe: WIDE,
      rank: ['mom', 63], k: 8, weighting: 'riskparity', rebalanceBars: 21,
      covLookback: 126, maxWeight: 0.25, gate: ['>', ['mom', 126], 0],
      marketGate: ['>', ['price'], ['*', 0.95, ['sma', 100]]], // see quant-multifactor — buffered regime protection
    },
  },
  // NOTE on the ML baskets (gbm here + the ridge/logistic ones above): they are deliberately
  // NOT regime-gated, unlike the 3 quant OPTIMISERS. The buffered gate DOES cut their drawdown
  // too (gbm 43%→28%), BUT empirically (20y, all gate variants tested) it does so at a SHARPE
  // COST — ridge 1.01→0.87, logistic 0.99→0.81, gbm 1.05→0.96 — i.e. it trades away more
  // risk-adjusted return than it's worth, because the ML's edge is cross-sectional SELECTION
  // (not market-timing) and a crude regime overlay degrades it. (Contrast the OPTIMISERS, where
  // the same gate cut DD with the Sharpe flat-to-up.) The ML's real "tuning" is the full ~20y
  // warm-training window (vs an ~1y cold-start), which gives it multiple regimes to learn from.
  // So we prioritise that selection edge and leave the ML ungated. In-sample numbers; the live
  // board is the judge. (Don't "fix" this without re-measuring.)
  {
    id: 'quant-ml-gbm',
    name: 'ML gradient-boosted basket',
    note: 'A LOCAL gradient-boosted tree ensemble learns which names to hold (free, no API). NOT regime-gated by design — its edge is selection, and a regime overlay measurably hurt it; full-history training is its tuning.',
    kind: 'BASKET',
    spec: {
      kind: 'BASKET', name: 'ML gradient-boosted basket', universe: CORE,
      rank: ['mom', 63], k: 3, weighting: 'rankw', rebalanceBars: 21,
      mlConfig: { model: 'gbm', features: ['mom21', 'mom63', 'rsi14', 'smaSlope', 'zscore50', 'volratio'], horizon: 21, lambda: 1, lookback: 504, trainEveryBars: 42, minTrain: 80, rounds: 40, learnRate: 0.1 },
    },
  },

  // --- ACTIVE opportunity-hunters — scan the WIDE 30-name field and ROTATE every
  // ~5 bars (≈weekly, the fastest the daily-bar engine allows) into the strongest
  // fresh opportunities.
  // Higher turnover + higher return potential (and higher drawdown) than the steadier
  // monthly baskets above. Backtests don't guarantee profit; the Live column is the judge.
  {
    id: 'active-momentum',
    name: 'Active momentum hunter',
    note: 'Weekly: rotate into the 5 strongest 1-month movers (only names still trending up). Aggressive, high-turnover.',
    kind: 'BASKET',
    spec: { kind: 'BASKET', name: 'Active momentum hunter', universe: WIDE, rank: ['mom', 21], k: 5, weighting: 'rankw', rebalanceBars: 5, gate: ['>', ['mom', 63], 0] },
  },
  {
    id: 'active-breakout',
    name: 'Breakout sprinter',
    note: 'Weekly: hold the 4 names nearest their 3-month high while above their 50-day average. Chases fresh breakouts.',
    kind: 'BASKET',
    spec: { kind: 'BASKET', name: 'Breakout sprinter', universe: WIDE, rank: ['distHigh', 63], k: 4, weighting: 'equal', rebalanceBars: 5, gate: ['>', ['price'], ['sma', 50]] },
  },
  {
    id: 'active-dip',
    name: 'Dip buyer (mean-reversion)',
    note: 'Weekly: buy the 4 most oversold names (low 5-day RSI) that are still in an up-trend. Active mean-reversion.',
    kind: 'BASKET',
    spec: { kind: 'BASKET', name: 'Dip buyer', universe: WIDE, rank: ['*', -1, ['rsi', 5]], k: 4, weighting: 'equal', rebalanceBars: 5, gate: ['>', ['price'], ['sma', 100]] },
  },

  // --- INTRADAY track — the FIRST bot that runs on 60-minute bars instead of daily.
  // `interval:'60m'`
  // on the roster entry tells the tournament to load dense hourly history and tick it
  // during the live session. A short-horizon hourly breakout on one liquid name: go long
  // when price breaks its ~2-session (12-bar) high, exit when it breaks the 12-bar low.
  // (No intraday F&O — there's no free intraday option data — so the intraday track is
  // EQ/baskets only; baskets-intraday come later. Evolution leaves this track alone.)
  {
    id: 'intraday-breakout-60m',
    name: 'Intraday breakout (60m)',
    note: 'Hourly bars on RELIANCE: go long on a 12-bar (~2-session) breakout, exit on a 12-bar breakdown. Active, short-horizon.',
    kind: 'EQ',
    symbol: 'RELIANCE',
    interval: '60m',
    spec: { kind: 'EQ', name: 'Intraday breakout (60m)', entry: ['>=', ['price'], ['high', 12]], exit: ['<=', ['price'], ['low', 12]] },
  },

  // --- "EXCELLENT BOTS" -------------------------------------------------------
  // Designed to address a real finding: almost every basket above LOSES to plain
  // Buy & Hold once you adjust for risk, because they're long-only large-cap rotation
  // with NO downside protection. A TRAIN/TEST sweep (score on the first ~3.5y, validate
  // on a held-out ~1.5y that happened to be a market DOWNTURN) showed two structural
  // fixes that actually survive out-of-sample: (1) a MARKET-REGIME gate that steps to
  // cash when NIFTY is below its 200-day average, and (2) a genuinely MARKET-NEUTRAL
  // stat-arb stream that makes money regardless of market direction. These three lean
  // on those findings. (Backtests are still in-sample; the Live column is the judge.)

  // (D) The headline NEW kind — STATISTICAL ARBITRAGE / PAIRS. Long the cheap leg,
  // short the rich one of a co-moving pair; profit when the spread reverts. Market-
  // neutral, so its returns are largely uncorrelated with the index — in the test
  // downturn it was the ONLY approach that made money with a tiny drawdown.
  {
    id: 'pairs-statarb',
    name: 'Market-neutral stat-arb',
    note: 'Long/short co-moving pairs (banks, IT, metals, pharma); profits when a stretched spread reverts. Largely UNCORRELATED with the market — can make money when it falls.',
    kind: 'PAIRS',
    spec: {
      kind: 'PAIRS', name: 'Market-neutral stat-arb', universe: PAIRS_UNIVERSE,
      lookback: 60, entryZ: 2, exitZ: 0.5, stopZ: 4, maxPairs: 6, formationBars: 21, minCorr: 0.6, gross: 0.9,
    },
  },

  // A second, PATIENT stat-arb stream — a longer-horizon cousin of the bot above. It
  // forms pairs over a 90-bar window, re-selects only every ~42 bars, and waits for a
  // WIDER ±2.5σ stretch before trading, on a BROADER (energy/utilities/autos-inclusive)
  // field. Lower turnover, more selective, and a genuinely different return stream from
  // the active 60-bar bot — two market-neutral desks running different horizons.
  {
    id: 'pairs-statarb-slow',
    name: 'Patient stat-arb (90d)',
    note: 'A slower, more selective market-neutral pairs bot — longer 90-bar formation, wider ±2.5σ entry, broader universe. Low turnover, uncorrelated with the market.',
    kind: 'PAIRS',
    spec: {
      kind: 'PAIRS', name: 'Patient stat-arb (90d)', universe: PAIRS_UNIVERSE_WIDE,
      lookback: 90, entryZ: 2.5, exitZ: 0.5, stopZ: 4, maxPairs: 5, formationBars: 42, minCorr: 0.65, gross: 0.9,
    },
  },

  // Protected MOMENTUM — hold the strongest up-trending names, but step ENTIRELY to cash
  // whenever NIFTY drops below its 200-day average. Plain momentum baskets above blew up
  // out-of-sample (mom252 lost ~10% in the test window); the market gate is the fix.
  {
    id: 'momentum-guarded',
    name: 'Protected momentum basket',
    note: 'Hold the 3 strongest up-trending names — but move fully to cash whenever NIFTY falls below its 200-day average. Momentum with a circuit-breaker.',
    kind: 'BASKET',
    spec: {
      kind: 'BASKET', name: 'Protected momentum basket', universe: WIDE,
      rank: ['mom', 126], k: 3, weighting: 'equal', rebalanceBars: 21,
      gate: ['>', ['mom', 126], 0],
      marketGate: ['>', ['price'], ['sma', 200]],
    },
  },

  // --- ETF sleeve -------------------------------------------------------------
  // ETFs trade like stocks on NSE, so these reuse the EQ + BASKET engines unchanged.
  // (1) A momentum ROTATION across a DIVERSIFIED set of ETFs (broad/sector equity, GOLD +
  //     SILVER, and US-tech via MON100) — every month it buys the 3 strongest by 6-month
  //     momentum that are still trending up, and sells the rest. So it naturally rotates OUT
  //     of equity and INTO gold/precious-metals when equities weaken (a real diversifier),
  //     and steps (partly) to cash when nothing is trending. (2) A single-ETF TREND bot that
  //     buys NIFTYBEES (the Nifty-50 ETF) while it is above its 50-day average and sells when
  //     it drops below — the literal "ETF buying/selling bot".
  {
    id: 'etf-rotation',
    name: 'ETF momentum rotation',
    note: 'Monthly: buy the 3 strongest of a diversified ETF set (equity / gold / silver / US-tech) by 6-month momentum, only those still trending up; sells the rest. Rotates into gold when equities weaken.',
    kind: 'BASKET',
    spec: {
      kind: 'BASKET', name: 'ETF momentum rotation', universe: ETF_UNIVERSE,
      rank: ['mom', 126], k: 3, weighting: 'rankw', rebalanceBars: 21,
      gate: ['>', ['mom', 63], 0], // dual-momentum: only hold an ETF still trending up (else partial cash)
    },
  },
  {
    id: 'etf-trend-nifty',
    name: 'ETF trend (NIFTYBEES)',
    note: 'Buys the Nifty-50 ETF (NIFTYBEES) while it trades above its 50-day average; sells when it drops below. A simple, active ETF buy/sell trend follower.',
    kind: 'EQ',
    symbol: 'NIFTYBEES',
    spec: { kind: 'EQ', name: 'ETF trend (NIFTYBEES)', entry: ['>', ['price'], ['sma', 50]], exit: ['<', ['price'], ['sma', 50]] },
  },
];

export { SEED_BOTS };
