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

## Tests

```bash
npm test          # 527 tests, runs with node --test
```

The suite covers the engine and money invariants, option pricing and payoffs, the backtester and tournament, the machine-learning rankers, and the browser UI (driven through jsdom). `jsdom` is the only development dependency.

## Deployment

The server binds `process.env.PORT`, so it deploys to any free Node host. `render.yaml` makes it a one-click Blueprint deploy on Render, and `DEPLOY.md` has the full walkthrough.
