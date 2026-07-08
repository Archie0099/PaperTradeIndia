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

| Component | Equity delivery | Equity intraday | Index options |
|---|---|---|---|
| STT | 0.10% buy + sell | 0.025% sell only | 0.10% of premium, sell only |
| Exchange txn charge (+18% GST) | ~0.0035% | ~0.0035% | ~0.41% of premium |
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

## Known biases that remain (read before quoting any long-history number)

1. **Survivorship bias — the big one.** The stock universe is ~105 names that are liquid
   **today**, held fixed across the whole ~20-year replay (`tournament/universe.mjs`). Names
   that would have ranked well in 2008 and then collapsed or delisted — DHFL, Jet Airways,
   RCOM, Yes Bank at its peak — can never be picked, so every long-history basket return,
   Sharpe and drawdown is flattered by an unknowable amount. Free point-in-time index
   membership doesn't exist, so this is **disclosed rather than fixed**. Treat 20-year
   basket figures as upper bounds; recent-window columns (1Y/5Y) are less affected.
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

## Money model

All four backtesters place orders through the **same simulation engine the terminal uses**
(`public/js/core/engine.js`) — there is no separate backtest ledger. The engine's master
invariant (`realised + unrealised − fees == equity − initialCash`) is fuzz-tested and holds
through every backtest. Virtual money only; nothing here places, or can place, a real order.
