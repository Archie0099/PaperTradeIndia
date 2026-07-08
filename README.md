# Paper Trade India

Paper Trade India is a browser-based paper-trading terminal for Indian stocks and F&O (NSE and BSE). It uses virtual money only and never places a real order. A small Node and Express backend serves the frontend and proxies free market data, and the whole trading simulation runs in your browser.

Live demo: https://paper-trade-india.onrender.com

![Paper Trade India demo](docs/demo.gif)

## Features

- **Virtual portfolio:** a default of one crore in virtual cash, editable and resettable, saved in your browser, with JSON export and import.
- **Orders:** market and limit orders, buy and sell, for equities and F&O. F&O is entered in lots. Optional bracket stop-loss and target attach to a position and close it automatically when hit, plus modify a resting limit and square off everything in one click.
- **Positions and P&L:** signed quantity, weighted-average price, realised and unrealised P&L that update as prices poll.
- **Portfolio analytics:** net option Greeks across open F&O, an account equity curve, day P&L versus total return, and a trade log with per-fill realised P&L.
- **Option chain and Greeks:** the full chain with last price, open interest, volume, and implied volatility, with Greeks computed locally using Black-Scholes.
- **Strategy builder:** fifteen templates (spreads, straddles, strangles, iron condor, covered call, butterfly, calendar, diagonal, and more) with a payoff diagram, breakevens, max profit and loss, and net Greeks. Multi-expiry spreads are valued correctly. It works fully offline.
- **Strategy lab and bot tournament:** an offline backtester that replays history through the same engine, a small JSON strategy language, and a live tournament where automated strategies compete forward on real data. Strategies range from single-stock trend and momentum to multi-stock baskets, market-neutral pairs, option-selling, and baskets ranked by local machine-learning models (ridge, logistic, and gradient-boosted trees, all hand-rolled). Backtests use dividend-adjusted prices and pay a realistic Indian cost schedule (STT, stamp duty, exchange charges, brokerage, spreads, and stock-borrow fees on shorts); [METHODOLOGY.md](METHODOLOGY.md) documents every assumption and known bias.
- **Auto-pilot:** copies the best-performing tournament strategy onto your own virtual account, with an honest walk-forward check of whether following it would have beaten the index.
- **Terminal UI:** hand-rolled canvas charts, a market-hours status bar in IST, a light and dark theme, keyboard shortcuts, price alerts, multiple watchlists, and a mobile layout.

The Strategy research section below walks through how those backtests are kept honest, with three published failures and one strategy that beat the market out-of-sample.

## Getting started

You need Node 18 or newer. Then:

```bash
npm install
npm start
```

Open http://localhost:3000 in your browser. Use `npm run dev` to auto-restart on file changes. No `.env` file is required; `.env.example` documents the optional settings.

## How it works

The backend is Node and Express with only two runtime dependencies, `express` and `dotenv`. It serves the static frontend from one origin (so there is no CORS) and exposes a small read-only `/api` that fetches and caches free public market data from Yahoo (quotes and history) and NSE (option chain), degrading to cached and then synthetic data when a source is blocked.

The simulation engine, the option pricing (Black-Scholes price, Greeks, and an implied-volatility solver), and all order handling live in the browser as plain ES modules and persist to local storage. There is no build step and no framework, and the charts are drawn by hand on a canvas. The backtester and the tournament reuse the very same browser engine under Node, so a backtest obeys the same money math as live trading. The machine-learning rankers are written from scratch and run locally, with no external model service.

The money model holds one identity exactly across every instrument type: realised plus unrealised P&L equals account equity minus starting cash. The test suite checks it directly, including a five-thousand-sequence fuzz.

## Strategy research

Beyond the terminal, the repository has a small research lab that tries to answer one honest question: do any of these trading ideas actually beat the market after real costs, or do they only look good in a backtest? The discipline matters more than any single result, so it is enforced in code rather than by good intentions. The rules were fixed before any strategy was run:

- **One fixed split:** the in-sample period ends on 31 December 2019, and everything from 2020 onward (the COVID crash, the 2021 bull market, the 2022 bear) is a holdout that each strategy may touch exactly once, and only on a deliberate decision to spend it. The harness refuses to score any window that overlaps the holdout without that opt-in.
- **Real costs, always on:** every backtest pays the full Indian cost schedule, and the benchmark is a buy-and-hold of the Nifty ETF pushed through the same engine and the same costs.
- **A sensitivity grid before any holdout:** a strategy has to survive a plus or minus fifty percent nudge of each parameter in-sample before it earns a holdout run. An edge that flips sign under a small parameter change is treated as curve-fitting.
- **Failures are published:** a strategy that does not clear the costed benchmark is written up as exactly that.

Four studies have run so far. Three failed and one survived, and all four are in the repo.

- **Trend following with volatility targeting (failed in-sample):** a slow trend filter on the Nifty ETF, sized by recent volatility, on the theory that Indian drawdowns trend enough for a timed exit to pay. It did not clear the bar: an excess Sharpe of 0.02 against the market's 0.25, a lower return, and only a slightly smaller drawdown to show for it. The sensitivity grid never lifted it past 0.08, so no parameter choice rescued it and the holdout was never spent.
- **Cross-sectional momentum (survived out-of-sample):** each month, hold the ten strongest names by their twelve-month return skipping the most recent month, weight them by inverse volatility, and step to cash when the index is below a buffered long-term average. In-sample it scored an excess Sharpe of 0.98 against 0.24, with every cell of the sensitivity grid staying positive. The single holdout run came back at 0.59 against the market's 0.40: the edge decayed out-of-sample, as edges do, but stayed above the bar after full costs. One design element failed along the way, a hard rule to flatten the book permanently on a deep drawdown that tripped at the very bottom of the 2020 crash and would have locked in the loss, so that rule was dropped while the underlying edge stood. It now runs as a live bot in the tournament, which is its real forward test.
- **Option-premium timing (negative by construction):** sell more index-option premium when it is expensive and stand aside when it is cheap. This one is closed without a backtest, because it cannot be tested on the data available. There is no free historical option-price data, so the simulator prices options from the underlying using trailing realised volatility times a fixed premium, which means "expensive" is only a function of past volatility and any timing signal would just read the pricing formula back to itself. A separate script already quantifies the ceiling: at fair value the option sellers net roughly zero after costs, so the whole apparent edge is that one assumption.
- **Risk overlays on a momentum basket (failed in-sample):** take the best in-sample basket and add two overlays borrowed from the studies above, reading the regime filter daily instead of monthly and scaling exposure by volatility. Neither cleared the bar. The daily filter scored 0.65 against the base 0.86 because it whipsawed in and out of the whole book roughly twenty times a decade and paid costs each way, and its parameter grid was unstable rather than robust. The volatility overlay was smoother but traded return for drawdown almost one-for-one, which is a dial and not an edge, so the holdout stayed unspent.

Every figure here is an upper bound. The universe is the set of names that are liquid today, held fixed across the whole history, so a company that would have ranked well in 2008 and later collapsed can never be picked, which flatters the long-history numbers by an unknowable amount. Even the one survivor decayed from an in-sample excess Sharpe of 0.98 to 0.59 out-of-sample, and that is still measured against a benchmark carried through the same costs. [METHODOLOGY.md](METHODOLOGY.md) states these biases in full.

## Tests

```bash
npm test          # 527 tests, runs with node --test
```

The suite covers the engine and money invariants, option pricing and payoffs, the backtester and tournament, the machine-learning rankers, and the browser UI (driven through jsdom). `jsdom` is the only development dependency.

## Deployment

The server binds `process.env.PORT`, so it deploys to any free Node host. `render.yaml` makes it a one-click Blueprint deploy on Render, and `DEPLOY.md` has the full walkthrough.
