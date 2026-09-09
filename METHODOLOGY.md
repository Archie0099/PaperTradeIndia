# Methodology — how the backtests and the live tournament actually work

Every number this project shows is a **simulation on free public data**. This page states
the conventions, the costs, and — most importantly — the **known biases** that remain, so a
result can be read for what it is. Rigor and honesty over a big backtest number.

## Prices

- **Source:** Yahoo Finance daily history (free). NSE option chains are used live in the
  terminal, but there is **no free historical option data** — see "F&O is modelled" below.
- **Backtests run on the dividend- and split-adjusted close** (Yahoo `adjclose`). That means
  strategies earn total return (dividends included as price appreciation) and a stock split
  is not booked as a fake −50% day. The terminal's charts still show the raw close — the
  price you'd actually have seen that day.
- **Intraday (60m) series carry no adjusted close** — the intraday bot runs on raw prices.
  Recent 2-year windows contain few corporate actions; the residual error is accepted and
  disclosed here.
- **Sanitisation:** a small cleaner (`backtest/data.mjs`) drops obvious Yahoo bad prints
  (e.g. a 1–2 bar −90% "round trip" that snaps straight back) and trims unusable early
  placeholder data. It only ever **removes** bars — it never fabricates a price. Every trim
  is logged at load.
- **Live tournament bars** appended during the day are today's raw prices (no corporate
  action has occurred yet for today's bar) — consistent with the adjusted history.

## Fills and liquidity

- **Convention:** a strategy decides on bar *i*'s close using only data up to *i*, and the
  order fills at bar *i+1*'s close. There is no lookahead anywhere in the pipeline (locked
  by tests that corrupt future bars and assert identical decisions).
- **The fill price is the close plus explicit costs** (below). There is **no market-impact
  model** — the simulator will "fill" any size. Instead of faking impact precision, every
  backtest counts fills whose rupee value exceeds **10% of that bar's traded value** and
  reports the count (`liquidity.flagged`, shown on the per-bot page). A bot with flagged
  fills is claiming a result that would **not be executable at that size**.

## Transaction costs (`backtest/costs.mjs`)

All tournament results, CLIs and headline figures run the full Indian cost schedule.
Statutory rates are the published NSE/SEBI/GoI schedules (FY 2024-25 onward); assumptions
are marked.

Which column applies is decided by HOLDING PERIOD, not by the bar interval: a bot pays the
intraday (MIS) schedule only if it declares `squareOffDaily`, i.e. it is guaranteed flat by the
close. Everything else — including bots trading 60-minute bars — pays delivery, because an
overnight position is a delivery trade in the real market.

| Component | Equity delivery | Equity intraday | Index options |
|---|---|---|---|
| STT | 0.10% buy + sell | 0.025% sell only | 0.10% of premium, sell only |
| Exchange txn charge (+18% GST) | ~0.0035% | ~0.0035% | ~0.041% of premium |
| Stamp duty (buy) | 0.015% | 0.003% | 0.003% |
| SEBI fee | 0.0001% | 0.0001% | 0.0001% |
| Brokerage | ₹0 (discount broker) | ₹0 | ₹20/order (flat) |
| Slippage / spread (**assumption**) | 5bps/side | 3bps/side | half of a ~1% premium spread per side (min one ₹0.05 tick) |

- **Option expiry** is a cash settlement, not a trade: no spread or exchange charge, but an
  in-the-money **long** option pays 0.125% STT on its settlement value (auto-exercise).
- **Short equity borrow (assumption):** overnight shorting in the Indian cash market is only
  possible via SLB (Securities Lending & Borrowing) or stock futures. The pairs/bearish bots
  are therefore charged a **6%/yr borrow fee** on short notional while held (real SLB fees
  range ~0.5–10%/yr and many names aren't borrowable at all — these bots are an
  *approximation* of a stat-arb book, priced but not proven executable).

## Metrics

- **Sharpe is excess-of-risk-free** at **6.5%/yr** (≈ Indian T-bill/repo), annualised by the
  series' own bar frequency. The rf=0 figure is reported alongside as `sharpeRf0`. The
  Auto-Pilot's walk-forward champion is also picked on the excess-rf Sharpe.
- **Idle cash earns 0%** in the simulator (no interest accrual). Combined with the excess-rf
  Sharpe this is *conservative* for cash-heavy strategies: they forfeit the T-bill yield in
  returns and are still measured against the T-bill hurdle.
- Max drawdown is peak-to-trough on the marked-to-market equity curve (open positions valued
  every bar), capped at 100%.
- **Sortino** follows the same conventions as the Sharpe (excess-of-rf numerator, wiped-account
  cap) but its denominator penalises only downside deviation.

## Risk measures (`backtest/risk.mjs`)

Every bot row and the per-bot page carry a risk block; the Advisor scales it to real capital.
Every formula is Hull's (*Risk Management and Financial Institutions* 4e, cited by PDF page),
and every one is unit-tested against a number printed in that book — never against a number
this code produced.

- **VaR** answers "how bad can things get?"; **Expected Shortfall** answers "if things do get
  bad, what is the expected loss?" [RMFI p.287]. Both are **one-day, 99%**, by **historical
  simulation on the trailing 500 daily returns** — Hull's window and his "fifth worst of 500"
  rule for the VaR, the mean of those five for the ES [RMFI p.306, 310]. Sign convention is
  Hull's: a VaR is a positive fraction of equity you might lose.
- **The ten-day VaR is the √10 rule** (eq 12.3) and is labelled an approximation: it is exact
  only for i.i.d. zero-mean normal daily changes, and a positive first-order autocorrelation
  makes it **too low** [RMFI p.293–294]. The autocorrelation-corrected form (eq 12.5) is
  implemented and tested but not shown.
- **The VaR back-test is the honest part, and is a forward test by construction.** Over the
  last 250 days, each day's VaR is built only from the returns strictly before it, and a day
  whose loss exceeded it is an *exception*. At 99% you expect 2.5 in 250. Two verdicts are
  shown: **Kupiec's two-tailed likelihood-ratio test** (eq 12.11, reject above 3.84) — which
  rejects for too FEW exceptions as well as too many, since a VaR that is never breached is
  overstating risk — and the **Basel traffic light** (green ≤ 4, yellow 5–9, red ≥ 10 in 250
  days, the regulator's capital-multiplier ladder [RMFI p.364]). A bot in the red zone is
  mis-measuring its own risk, whatever its Sharpe says.
- **Also implemented, tested, and available to research but not shown on the board:**
  parametric (variance–covariance) VaR/ES (eq 12.1–12.2); confidence-level conversion
  (12.6–12.7); the discrete-distribution VaR/ES that shows VaR failing subadditivity while ES
  keeps it (Problem 12.5); **weighted historical simulation** — the "Responsive VaR" of the
  practitioner systems, λ = 0.994, ~56% of the weight in the last six months [RMFI p.312–313]; the
  **EWMA** (eq 10.8, λ = 0.94) and **GARCH(1,1)** (eq 10.10) variance recursions with the
  long-run variance and the mean-reverting forecast (eq 10.14); and the Excel
  `PERCENTILE.INC` and practitioner interpolated-percentile conventions, because the two
  differ and spreadsheets use one while the textbook uses the other.
- **What this is NOT.** None of these measures is a trading edge, and none is claimed as one.
  They measure the risk of a strategy that already exists; the fair-benchmark and survivorship
  rules above still govern every return figure. A VaR built from a 500-day window carries the
  same "history repeats" assumption as every backtest here [RMFI p.677, 13.1].

## Delta-hedged option sellers (`backtest/hedge.mjs`, a study — not a board bot)

The premium-selling bots are **naked**: they hold nothing against the options they sell, so their
P&L mixes "was there a volatility premium?" with "did the market happen not to crash?". The
textbook's answer is delta hedging — hold delta × N of the underlying and rebalance as delta moves
[OFOD p.420; RMFI p.185–188] — which turns the position into a bet on implied-minus-realised
volatility, minus the cost of rebalancing. `hedge.mjs` is Hull's own simulation as a pure
function (his Table 8.2 mechanics: rebalance to delta, simple interest on the hedge cost, an
exercised call delivers the shares at the strike). It is locked three ways: the printed week-0
and week-1 lines of his 100,000-call example, exactly; the invariant he states in words — with
fine enough rebalancing the discounted hedge cost equals the Black–Scholes price on every path,
and the spread of outcomes shrinks with frequency; and the sign rule — a hedged seller profits
when realised volatility is below the volatility sold and loses when above.

`backtest/research/hedged-seller.mjs` replays the fno backtester's monthly cycles (ATM straddle
and ±6% strangle, one lot, options modelled at realised vol × premium) on real NIFTY history,
naked and daily-hedged with the index future at the volatility sold, at volPremium 1.0/1.1/1.2
and a hedge-cost sensitivity of 0/2/5 bps per side (an assumption stated, not a claimed
schedule — no sourced index-futures cost schedule lives here). Measured over 218 cycles:

- **The hedge does what the textbook says for the tail.** Straddle worst month −20.2% → −13.1%,
  max drawdown at fair value 78.8% → 43.2%; strangle worst month −18.5% → **−2.8%**, drawdown
  39.9% → 4.9%.
- **It manufactures no edge.** At fair value the hedged straddle still loses −36.5% over the
  history with *zero* hedge cost: leg costs, discrete-rebalancing error, and gaps. Any edge
  lives entirely in the vol-premium assumption — hedging makes that explicit rather than fixing
  it. At 1.2 it improves the return (+47% → +78%) and halves the drawdown; 5 bps/side of hedge
  cost eats about a third of that.
- **What it cannot do is a gap.** The hedged straddle's worst cycle is no longer COVID (a slide the
  daily hedge followed) but the cycle holding the June-2024 election-day gap.
- **Read the two Sharpes.** The headline excess-of-6.5% Sharpe punishes a low-volatility series
  with a small drift (a 3% CAGR at ~1% vol reads −0.9); the rf = 0 figure beside it (+0.88) is the
  one that describes the shape.

This is an in-sample **mechanism** study over the whole history (nothing is fitted, and nothing is
claimed out of sample) and every F&O figure remains "indicative". A hedged seller on the live
board would need daily futures rehedging through the real engine — a separate build — and the
study says it would be a *better-behaved* published negative at fair value, not an edge.

## Regime gates (the quant optimisers' market filter)

Three optimiser baskets (multi-factor, mean-variance, risk-parity) carry a *buffered market gate*:
they step entirely to cash when NIFTY closes more than 5% below its 100-day average. Measured
through the live path with the full cost model over the ~20-year history, against the same bot with
the gate removed, this is honestly **crash insurance, not an alpha source** — and each bot's label
now says so:

- It cut max drawdown by roughly **a quarter to a third** (full-window drawdown ratios, gated over
  ungated, ≈ 0.62 / 0.72 / 0.75 for multi-factor / mean-variance / risk-parity), not the "halving"
  an earlier note claimed.
- **Almost the entire benefit is one event — the 2008 bear market**, a slow grind a monthly-
  rebalanced gate can step aside from (it cut the 2008 peak-to-trough from ~50–65% down to ~6–9%).
  Exclude 2008 and the drawdown benefit is negligible.
- It **cannot help in a fast crash**: in the 2020 COVID drop the gate cut nothing off the drawdown
  and cost ~20–30 points of return by sitting in cash through the rebound — a monthly gate is read
  only at rebalance bars.
- On risk-adjusted return it is roughly a **wash over the full history** and a mild **drag in calm
  years**. The excess-Sharpe change is sensitive to how the window is anchored: NIFTY (the gate's
  proxy) starts later than the oldest basket names, so on the raw full window the gated bots sit in
  cash through that early stretch, which flatters their drawdown but penalises their Sharpe; measured
  from a fair common start both bots see, the gate slightly *improves* Sharpe for all three, driven
  again by the 2008 dodge.
- Risk-parity is the most conservative of the three — it gives up the most calm-market return for
  the same insurance.

An earlier version of these notes cited specific "55%→28%"-style before/after drawdowns; those
figures do not reproduce under the current adjusted-close prices and cost model. The likely reason is
that they predate the switch to dividend/split-adjusted closes and the data sanitiser (unadjusted
corporate-action bars used to inflate the un-gated drawdown), but that explanation has **not been
verified** and is offered only as a hypothesis.

## The research lab protocol (`backtest/research/`)

New candidate strategies are developed under a fixed discipline, enforced in code by
`backtest/research/harness.mjs`:

- **A fixed data split, decided before any strategy was run:** in-sample ends **2019-12-31**;
  the holdout (**2020-01-01 → present**: the COVID crash, the 2021 bull, the 2022 bear) is
  evaluated **once per strategy**, on explicit go-ahead only — the harness throws on any
  window touching the holdout unless a deliberate `--holdout` run opts in. Parameters are
  tuned on in-sample data only.
- **Full real cost model always on** (the delivery schedule above), the benchmark is Buy & Hold
  pushed through the same backtester and costs, and indicator warmup bars are excluded from
  every scored metric.
- **A ±50% single-parameter perturbation grid** must be reported before any holdout request;
  an edge that flips sign under a 50% nudge of one parameter is treated as curve-fit.
- Reported per run: excess Sharpe, `sharpeRf0`, Sortino, CAGR, max drawdown, profit factor,
  annualized round-trip turnover, trade count and participation flags.
- **Failures are published like successes** (a strategy that doesn't beat the costed Buy & Hold
  bar is reported as exactly that), matching the F&O volPremium finding above.
- **Negative-by-construction.** A study whose hypothesis the available data cannot test is closed
  by argument, not by a backtest — and a holdout is never spent on it. The worked example is the
  F&O premium-*timing* idea ("sell more when option premium is rich"): the backtester never sees
  real option prices (there is no free historical chain), it PRICES options at trailing realized
  vol × the constant volPremium (see "F&O is modelled" below), so "richness" is a fixed function
  of *trailing* vol and carries no independent signal. Any timing edge would just be the pricing
  rule read back to itself — a model artifact the holdout couldn't separate from a real effect,
  since it is priced identically. `backtest/fno-sensitivity.mjs` already quantifies the ceiling:
  at volPremium 1.0 (fair value) the premium sellers net ≈ zero minus costs, so the entire edge is
  the assumption. Verdict recorded from that argument; no code, no backtest, no holdout.
- **★ Beating the index is not evidence; beating the same universe is.** A basket drawn from
  the survivor universe must be scored against **an equal-weight, no-signal portfolio of that
  same universe**, because the universe itself carries a ~0.6-Sharpe survivorship premium over
  the index (quantified under Known biases below). A study that only clears the index bar has
  demonstrated nothing about its own selection rule. Enforced in practice by an **ablation**:
  re-run the identical machinery (same holdings count, cadence, weighting, universe, costs,
  window) with the ranking signal **removed**, and with the signal **inverted**. If the
  no-signal arm ties the strategy, the strategy is not the source of the result. Where the
  strategy's own number could plausibly be a lucky draw, also report the **null distribution**
  of seeded random portfolios of the same size — a result inside that spread is noise.
  This rule was written *because* a study passed the old bar and failed this one (S6 below).

**Study scoreboard so far** — three published in-sample/by-construction negatives, one
study that beat the index out-of-sample but NOT a fair universe bar, and one killed by its
own control. No study has yet produced a selection edge proven against a fair benchmark:

| # | Strategy | Verdict | Holdout |
|---|---|---|---|
| S1 | Time-series momentum + vol target on NIFTYBEES | **Failed in-sample** (xSharpe 0.02 vs 0.25) | not spent |
| S2 | Cross-sectional 12-1 momentum basket | **Beat the INDEX out-of-sample** (xSharpe 0.59 vs 0.41) — but the index is the WRONG bar (see rule above): against a no-information portfolio of the same universe (0.87–0.91) the whole spec **trailed**, so the index-relative win is survivorship. The ablation this document prescribes (identical machinery, signal replaced by noise, k-matched, plus a null distribution of same-size random portfolios) puts the SELECTION effect at +0.06 (gate off both arms) to +0.24 (gate on both) — non-negative, but 7 of 20 random 10-name portfolios beat it ungated, so it sits inside the noise band and stays UNPROVEN. Most of the −0.32 shortfall is the k=104 diversification premium and the regime gate, neither of which is selection. Kill-switch design rejected. Reproduce: `node backtest/research/universe-bench.mjs` | **SPENT** |
| S4 | F&O premium *timing* | **Negative by construction** (untestable on modelled option prices) | not spent |
| S5 | Risk overlays (daily gate / vol target) on the best basket | **Failed in-sample** (a de-risking dial, not an edge) | not spent |
| S6 | Cross-sectional **low volatility** | **Not promoted** — cleared the index bar by +0.76 Sharpe, then a *no-signal* control tied it and the null distribution put it at ~the 85th percentile of noise. The apparent edge was survivorship. Volatility does reliably order risk (drawdown 15.8% vs the inverted arm's 34.0%), so it is a de-risking dial like S5's vol target — not alpha. | not spent |

## Known biases that remain (read before quoting any long-history number)

0. **Rebalance-phase sensitivity — a lifetime figure is ONE DRAW, not a value. MEASURED.**
   A basket rebalances every `rebalanceBars` bars counted from bar 0 of the aligned master
   timeline, and history is fetched as "20 years from **today**" — so bar 0 moves forward every
   day, and every rebalance date moves with it. For a strategy that *selects* names this is not
   a rounding difference: rebalancing a week later holds a different basket, which changes the
   next period, compounded across roughly 240 monthly decisions.

   **How big is it? Up to about 3x on terminal wealth.** Measured by holding the data, the spec,
   the costs and the END date fixed and varying **only** the window's start date
   (`node backtest/research/phase-sensitivity.mjs`): terminal wealth ranges ₹38.4–84.2 crore for
   the risk-parity basket (**2.19x**), ₹47.5–161.6 crore for the multi-factor basket (**3.40x**)
   and **1.59x** for cross-sectional momentum, with excess-Sharpe spanning **0.71–0.94**. Two
   starts a single week apart already differ materially.

   **Attribution, stated honestly:** a later start moves the rebalance grid **and** measures a
   shorter period, and that experiment does not separate the two. So the spread is not "phase
   alone" — it is how much a published figure moves across start dates the strategy cannot
   influence and nobody deliberately chose. The near-adjacent pair is the cleanest read on the
   grid itself, since the period barely changes across a single week.

   **★ The consequence for reading any number here: a single lifetime return or Sharpe is one
   sample from that range, not the strategy's value.** In particular, a change between two
   runs of the same strategy is *not* evidence that it improved or decayed — this project's own
   board moved roughly 6x between two readings six weeks apart with no code change at all — and
   a local run cannot be compared with the deployed board unless both windows begin on the same
   date. Comparisons that stay valid are ones where the phase is shared: bots against each other
   on the same board and boot, and the forward live record, which does not depend on the window
   at all.

1. **Survivorship bias — the big one, and now MEASURED.** The stock universe is ~105 names
   that are liquid **today**, held fixed across the whole ~20-year replay
   (`tournament/universe.mjs`). Names that would have ranked well in 2008 and then collapsed
   or delisted — DHFL, Jet Airways, RCOM, Yes Bank at its peak — can never be picked, so every
   long-history basket return, Sharpe and drawdown is flattered. Free point-in-time index
   membership doesn't exist, so this is **disclosed rather than fixed**.

   **How big is it? Roughly 0.6 Sharpe and 9 percentage points of CAGR.** Measured directly
   (`node backtest/research/lowvol.mjs`, in-sample 2010–2019, full delivery costs): an
   **equal-weight portfolio of all 104 names — no signal, no selection, no strategy
   whatsoever** — scores excess-Sharpe **0.85 / CAGR 18.32%**, against the index's
   **0.24 / 9.33%**. Simply *being in the survivor set* accounts for that entire gap.

   **★ The consequence for reading any number in this project: comparing a basket against
   the INDEX credits the survivorship premium to the strategy.** The honest null for "does
   this selection rule add value" is an equal-weight portfolio **of the same universe**,
   selected with no information — not the index. Every basket-vs-index figure published here
   inherits the bias, so a basket needs to beat roughly 0.85 Sharpe, not 0.24, before its
   *selection* has demonstrated anything. This was discovered the hard way: study S6 cleared
   its pre-registered bar against the index by +0.76 Sharpe and turned out to add nothing at
   all over a no-signal control (see the research-lab protocol above, and the extended
   write-up at the top of `backtest/research/lowvol.mjs`). Recent-window columns (1Y/5Y) are
   less affected than 20-year ones, but not immune.
2. **The bot line-up is curated survivorship too:** the walk-forward "auto-pick the best
   bot" runs over today's seed strategies. It shows "among these strategies, auto-picking
   beat the market", not "this was buildable in 2008".
3. **F&O is modelled, not traded.** Option prices are Black-Scholes from the underlying at
   implied vol = trailing realized vol × **volPremium (default 1.2)**, flat across strikes
   (no skew), on synthetic monthly expiries with today's lot sizes. The premium-seller edge
   **is** that 1.2 assumption: run `node backtest/fno-sensitivity.mjs NIFTY 10y` for the
   1.0/1.1/1.2 grid — at 1.0 (fair value) selling premium nets ≈ zero minus costs. All F&O
   results are indicative.
4. **Benchmark:** the primary "vs the market" line is the NIFTY **price index** (no
   dividends). Where NIFTYBEES (a dividend-adjusted proxy) overlaps the walk-forward, the
   head-to-head against it is also reported — expect the market's bar to be ~1.3–1.5%/yr
   higher than the price index suggests.
5. **Unlimited liquidity at the close** (see Fills) — flagged, not modelled.
6. **Fixed present-day contract specs** (NIFTY lot 75 etc.) across history.
7. Suspended/non-trading names are marked (and in principle tradeable) at their last real
   close via forward-fill; pairs/baskets on liquid large caps make this negligible.

## What "no lookahead" is backed by

- One-bar decision→execution lag in all four backtesters (equity, basket, pairs, F&O).
- ML rankers train only on labels whose forward window **closed before** the decision time,
  with features z-scored on training-fold statistics only (`backtest/ml.mjs`).
- Factor z-scores are cross-sectional within the decision bar.
- Regression tests corrupt future bars and assert byte-identical early decisions; the
  walk-forward Auto-Pilot has the same corrupt-the-future locks.
- **A daily bar is admitted to the live record no earlier than 16:00 IST — the 15:30 close plus a
  30-minute settle margin** — by one shared predicate (`dailySessionClosed`, `backtest/data.mjs`)
  that both the boot path and the live tick call. NSE’s official close is a last-30-minute VWAP
  published minutes after the bell and a free feed’s bar can be revised in that window; since a
  timestamp is never re-admitted and the suggestion log is append-only, a bar taken at 15:30:01
  could be a bad print made permanent. The margin is the price of never editing the record.
- **In practice the data feed, not that rule, decides when a day is recorded.** The free daily
  endpoint emits the current session’s row with an `open` but a **`null` close** until it
  backfills the settled close, and a null-close row is skipped rather than guessed at (a price is
  never fabricated). Measured on this feed: a usable close was available ~3 hours after one
  session’s bell, while another’s was still absent ~12 hours after — feed-wide across index,
  large-cap and ETF symbols and on both API hosts — even though the same response’s quote field
  and the 60-minute series both carried that close. An early value is not necessarily the final
  one: for that ~3-hour case, none of the ten prices recorded from it match the close the feed
  serves for that date today, so availability and settlement are separate events. The admission
  time is
  `max(close + settle margin, publication)`, the second term usually dominates, and the publication
  lag is variable rather than a fixed offset. A session whose close is never published on the day
  is simply not recorded: missed days are never back-filled, because reconstructing one after the
  fact would be hindsight — the one thing an append-only forward record exists to rule out.
- **The VaR back-test is forward by construction:** each day's VaR is built only from the
  returns strictly before it, and a day is scored against that already-published figure
  (`backtest/risk.mjs`, `rollingVaRBacktest`). It cannot be fitted to the days it judges.

## Money model

All four backtesters place orders through the **same simulation engine the terminal uses**
(`public/js/core/engine.js`) — there is no separate backtest ledger. The engine's master
invariant (`realised + unrealised − fees == equity − initialCash`) is fuzz-tested and holds
through every backtest. Virtual money only; nothing here places, or can place, a real order.
