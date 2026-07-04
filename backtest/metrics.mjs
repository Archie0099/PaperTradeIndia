// ---------------------------------------------------------------------------
// backtest/metrics.mjs
// Pure performance metrics computed from a backtest's equity curve (the account
// value over time) plus a trade count. No side effects -> easy to unit-test.
//
// SHARPE CONVENTION: the headline Sharpe is EXCESS-of-risk-free (rf ≈ 6.5%/yr,
// matching the app's own riskFreeRate setting). The old rf = 0 convention made
// every strategy look better than it is — earning 12%/yr at 15% vol is Sharpe
// 0.80 at rf=0 but only ~0.37 in excess terms, and a quant reads the latter.
// The rf=0 figure is still reported alongside (`sharpeRf0`) for continuity.
// ---------------------------------------------------------------------------

const TRADING_DAYS = 252; // ~NSE trading days per year, for annualising
const RF_ANNUAL = 0.065;  // ~Indian T-bill / repo rate; the Sharpe hurdle

// Daily simple returns from an equity series: r[i] = c[i] / c[i-1] - 1.
function dailyReturns(equity) {
  const r = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1];
    if (prev > 0) r.push(equity[i] / prev - 1);
  }
  return r;
}

function mean(xs) {
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

// Total return over the whole curve, as a percentage.
function totalReturnPct(equity) {
  if (equity.length < 2 || !(equity[0] > 0)) return 0;
  return (equity[equity.length - 1] / equity[0] - 1) * 100;
}

// Compound annual growth rate (%/yr). `years` defaults to bars/252 if omitted.
function cagrPct(equity, years) {
  if (equity.length < 2 || !(equity[0] > 0)) return 0;
  // A wiped-out account (≤0 final equity, e.g. a naked-short F&O blowup) is a
  // total loss. Raising a NEGATIVE ratio to a fractional power yields NaN, so
  // report -100% directly instead.
  if (!(equity[equity.length - 1] > 0)) return -100;
  const yrs = years && years > 0 ? years : (equity.length - 1) / TRADING_DAYS;
  if (yrs <= 0) return 0;
  return (Math.pow(equity[equity.length - 1] / equity[0], 1 / yrs) - 1) * 100;
}

// Annualised Sharpe ratio: mean / std of per-BAR returns IN EXCESS of the
// risk-free rate, * sqrt(periodsPerYear). `rfAnnual` defaults to RF_ANNUAL
// (~6.5%); pass 0 explicitly for the raw rf=0 figure. `periodsPerYear` defaults
// to 252 (one bar = one trading day). For INTRADAY series (e.g. ~6.25 hourly
// bars/day) pass a larger value — use inferPeriodsPerYear(times) — so the
// per-bar Sharpe is annualised by the right factor (else hourly bars would be
// under-annualised ~sqrt(6) and look artificially poor).
function sharpe(equity, periodsPerYear = TRADING_DAYS, rfAnnual = RF_ANNUAL) {
  const ppy = periodsPerYear > 0 ? periodsPerYear : TRADING_DAYS;
  const rfBar = (rfAnnual || 0) / ppy; // per-bar risk-free hurdle (simple, standard)
  const r = dailyReturns(equity).map((x) => x - rfBar);
  const sd = stddev(r);
  if (sd === 0) return 0;
  const value = (mean(r) / sd) * Math.sqrt(ppy);
  // A WIPED account (equity touched <= 0 at some point — a blown short / naked-option blowup) must
  // never advertise a POSITIVE risk-adjusted return: dailyReturns SKIPS the steps from non-positive
  // equity (prev>0 guard), so the surviving early gains could otherwise yield a positive Sharpe on a
  // bot that actually went to -100%. Cap it at 0 in that case.
  if (equity.some((e) => !(e > 0))) return Math.min(value, 0);
  return value;
}

// Annualised SORTINO ratio: same numerator as `sharpe` (mean per-bar return in
// EXCESS of the risk-free hurdle), but the denominator penalises only DOWNSIDE
// deviation — the square root of the mean of squared NEGATIVE excess returns,
// computed over ALL bars (the standard convention: calm up-bars still dilute the
// downside average, they just contribute 0 to the sum). Two strategies with the
// same Sharpe can differ a lot here: the one whose volatility is mostly upside
// scores higher. Conventions mirror `sharpe` exactly: rf defaults to RF_ANNUAL,
// zero downside deviation returns 0 (never Infinity), and a WIPED account
// (equity touched <= 0) can never advertise a positive figure.
function sortino(equity, periodsPerYear = TRADING_DAYS, rfAnnual = RF_ANNUAL) {
  const ppy = periodsPerYear > 0 ? periodsPerYear : TRADING_DAYS;
  const rfBar = (rfAnnual || 0) / ppy;
  const r = dailyReturns(equity).map((x) => x - rfBar);
  if (r.length < 2) return 0;
  const downside = Math.sqrt(r.reduce((a, x) => a + (x < 0 ? x * x : 0), 0) / r.length);
  if (downside === 0) return 0;
  const value = (mean(r) / downside) * Math.sqrt(ppy);
  if (equity.some((e) => !(e > 0))) return Math.min(value, 0);
  return value;
}

// Estimate bars-per-year from a series' own timestamps — i.e. how many bars actually
// elapsed per calendar year. For daily data this is ~252 (so the Sharpe is unchanged);
// for 60-min NSE bars it lands near ~1600. Self-consistent: annualising per-bar returns
// by (bars / yearsSpanned) is correct regardless of the bar frequency. Falls back to
// 252 when the span is too short to estimate.
function inferPeriodsPerYear(times) {
  if (!Array.isArray(times) || times.length < 3) return TRADING_DAYS;
  const span = times[times.length - 1] - times[0];
  const years = span / (365.25 * 864e5);
  if (!(years > 0.02)) return TRADING_DAYS; // < ~1 week of span: not enough to estimate
  return (times.length - 1) / years;
}

// Maximum peak-to-trough drawdown, as a POSITIVE percentage (0 = no drawdown).
// This is the "how bad did it hurt at the worst point" number.
function maxDrawdownPct(equity) {
  let peak = -Infinity;
  let maxDd = 0;
  for (const c of equity) {
    if (c > peak) peak = c;
    if (peak > 0) {
      // Clamp at 1 (100%): once equity goes negative, (peak−c)/peak overstates a
      // loss that is really capped at a total wipeout.
      const dd = Math.min(1, (peak - c) / peak);
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd * 100;
}

// Bundle every metric for one curve. `years` optional (from real timestamps).
// `periodsPerYear` optional — pass it (e.g. inferPeriodsPerYear(times)) for INTRADAY
// curves so the Sharpe annualises correctly; omit it for daily (defaults to 252, so
// existing daily backtests are byte-identical).
function summarize(equity, { years, trades = 0, periodsPerYear = TRADING_DAYS } = {}) {
  return {
    totalReturnPct: +totalReturnPct(equity).toFixed(2),
    cagrPct: +cagrPct(equity, years).toFixed(2),
    // Headline Sharpe is EXCESS-of-rf (the honest hurdle); the rf=0 figure is
    // kept alongside so the two conventions are never silently confused.
    sharpe: +sharpe(equity, periodsPerYear).toFixed(2),
    sharpeRf0: +sharpe(equity, periodsPerYear, 0).toFixed(2),
    sortino: +sortino(equity, periodsPerYear).toFixed(2),
    maxDrawdownPct: +maxDrawdownPct(equity).toFixed(2),
    trades,
    finalEquity: +(equity[equity.length - 1] || 0).toFixed(2),
  };
}

export {
  dailyReturns, mean, stddev,
  totalReturnPct, cagrPct, sharpe, sortino, maxDrawdownPct,
  summarize, inferPeriodsPerYear, TRADING_DAYS, RF_ANNUAL,
};
