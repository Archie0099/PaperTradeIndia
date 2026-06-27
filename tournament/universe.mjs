// ---------------------------------------------------------------------------
// tournament/universe.mjs
// The pool of symbols the bots can trade — and HUNT across. Equity strategies
// can run on any of these liquid NSE names + indices (all free via Yahoo). F&O
// (option-selling) strategies run only on the index symbols that have a modelled
// lot size + strike grid. Evolution explores both the STRATEGY and the SYMBOL,
// so bots migrate toward the best (strategy × stock) combinations over time.
// ---------------------------------------------------------------------------

// The multi-company BASKET pool: a broad set of liquid large/mid-cap NSE names
// (all clean Yahoo `.NS` tickers, no '&'/'-' so the symbol map never trips — a few
// majors like M&M / BAJAJ-AUTO are deliberately excluded for that reason). This is
// the field the bots HUNT across: a basket scores its slice of these each rebalance
// and rotates into the best names.
//
// Sized at ~105 liquid large/mid-caps — broad enough for the baskets to hunt across,
//   while keeping the full 20-year cold boot (re-download + re-backtest of every name)
//   comfortably within a free single-instance host (memory + a rate-limited data IP).
//   The boot is RESILIENT: any ticker that 404s, returns synthetic (no real data), or is
//   too gappy is DROPPED at load (tournament.mjs + backtest/data.mjs), so the EFFECTIVE
//   universe is "the names that fetch clean ~20y history" — never a fake/synthetic series
//   polluting a basket. The original 36 are kept FIRST (already cached, and the seed
//   baskets slice the front of this list, so their cached data + relative behaviour stay
//   stable). A single basket is capped at MAX_BASKET_UNIVERSE (see dsl.mjs). Widen by
//   appending more vetted names here only if the host has the headroom.
const BASKET_UNIVERSE = [
  // --- the original 36 (kept FIRST — already cached; seed baskets slice the front) ------
  // the original 12
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'ITC', 'LT',
  'AXISBANK', 'KOTAKBANK', 'BHARTIARTL', 'HINDUNILVR',
  // + 24 more liquid Nifty large-caps across sectors
  'HCLTECH', 'WIPRO', 'TECHM', 'MARUTI', 'BAJFINANCE', 'BAJAJFINSV',
  'ASIANPAINT', 'TITAN', 'ULTRACEMCO', 'NESTLEIND', 'SUNPHARMA', 'DRREDDY',
  // HEROMOTOCO replaced TATAMOTORS (post-2025-demerger TATAMOTORS.NS 404s; TMPV.NS carries a
  // too-recent ~40% demerger gap the early-only sanitiser can't trim). HEROMOTOCO is a clean,
  // liquid Nifty-50 auto large-cap with full ~20y history — keeps the auto sector + slot index.
  'CIPLA', 'POWERGRID', 'NTPC', 'ONGC', 'COALINDIA', 'HEROMOTOCO',
  'TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'ADANIPORTS', 'BRITANNIA', 'APOLLOHOSP',

  // --- + ~69 more Nifty-200-grade names, by sector --------------------------------------
  // Banks & financials
  'INDUSINDBK', 'BANKBARODA', 'PNB', 'CANBK', 'UNIONBANK', 'IDFCFIRSTB', 'FEDERALBNK',
  'BANDHANBNK', 'AUBANK', 'RBLBANK', 'BANKINDIA', 'INDIANB', 'CHOLAFIN', 'SHRIRAMFIN',
  'SBICARD', 'ICICIGI', 'ICICIPRULI', 'SBILIFE', 'HDFCLIFE', 'HDFCAMC', 'LICI', 'PFC',
  'RECLTD', 'IRFC', 'MUTHOOTFIN', 'MANAPPURAM', 'POONAWALLA', 'ABCAPITAL', 'LICHSGFIN',
  'BAJAJHLDNG',
  // IT / tech services
  'LTIM', 'PERSISTENT', 'COFORGE', 'MPHASIS', 'LTTS', 'OFSS', 'TATAELXSI', 'BSOFT',
  'KPITTECH', 'CYIENT',
  // Autos & auto components
  'EICHERMOT', 'TVSMOTOR', 'ASHOKLEY', 'BHARATFORG', 'BOSCHLTD', 'MOTHERSON', 'BALKRISIND',
  'MRF', 'APOLLOTYRE', 'EXIDEIND', 'SONACOMS', 'TIINDIA', 'UNOMINDA',
  // Pharma & healthcare
  'DIVISLAB', 'AUROPHARMA', 'LUPIN', 'BIOCON', 'ZYDUSLIFE', 'ALKEM', 'TORNTPHARM',
  'IPCALAB', 'LAURUSLABS', 'MANKIND', 'MAXHEALTH', 'FORTIS', 'LALPATHLAB', 'METROPOLIS',
  'ABBOTINDIA', 'GLAND',
];

// --- ETFs -------------------------------------------------------------------------------
// A curated set of liquid Indian ETFs for the ETF bots (a momentum ROTATION basket + a
// single-ETF TREND bot). ETFs trade exactly like stocks on NSE (clean `.NS` tickers, lot
// size 1), so they reuse the EQ/BASKET engines unchanged. Deliberately DIVERSIFIED across
// asset classes so a momentum rotation has genuinely different streams to rotate between:
// broad equity, sector/PSU equity, GOLD + SILVER (the hedges that rise when equities fall),
// and US tech (MON100 = Nasdaq-100). All verified to return REAL ~10-17y Yahoo history
// (probe-etfs); the resilient boot drops any that ever fail. These are loaded at boot via the
// ETF bots' seed sources (sourcesOf), so they do NOT need to be in STOCKS.
const ETF_UNIVERSE = [
  'NIFTYBEES',  // Nifty 50 (broad equity)        ~17.5y
  'JUNIORBEES', // Nifty Next 50                  ~17.5y
  'BANKBEES',   // Bank Nifty                     ~17.5y
  'PSUBNKBEES', // PSU Banks                      ~17.5y
  'GOLDBEES',   // GOLD (the equity hedge)        ~17.5y
  'SILVERBEES', // Silver                         ~4.4y
  'MON100',     // Nasdaq-100 (US tech, intl.)    ~15.2y
  'INFRABEES',  // Infrastructure                 ~15.7y
  'CONSUMBEES', // Consumption                    ~12.2y
  'ITBEES',     // IT sector                      ~6y
];

// Equity-tradeable symbols (indices are "buy the index"). The two indices + the
// whole basket pool; EQ bots + evolution hunt across ALL of these.
const STOCKS = ['NIFTY', 'BANKNIFTY', ...BASKET_UNIVERSE];

// Index symbols where the modelled F&O (option-selling) bots can run, with their
// lot size + strike grid.
const FNO_INDICES = {
  NIFTY: { lotSize: 75, strikeStep: 50 },
  BANKNIFTY: { lotSize: 35, strikeStep: 100 },
  FINNIFTY: { lotSize: 65, strikeStep: 50 },
};

const EQ_SYMBOLS = STOCKS;
const FNO_SYMBOLS = Object.keys(FNO_INDICES);

export { STOCKS, BASKET_UNIVERSE, ETF_UNIVERSE, FNO_INDICES, EQ_SYMBOLS, FNO_SYMBOLS };
