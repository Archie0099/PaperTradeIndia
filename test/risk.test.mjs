// ---------------------------------------------------------------------------
// test/risk.test.mjs
// Locks backtest/risk.mjs — VaR, Expected Shortfall, EWMA/GARCH volatility and
// VaR back-testing — to the TEXTBOOK's own printed numbers.
//
// Every expected value below is a figure printed in Hull, *Risk Management and
// Financial Institutions* 4e ([RMFI p.N] = PDF page), Hull's *Solutions to Further
// Problems* ([RMFI-sol]). NOT ONE is a number
// this code produced and was then pasted back in: that would prove only that the
// code equals itself. Where a printed figure did NOT reproduce, the
// test says so and locks the value the arithmetic supports instead.
//
// Pure + offline: no engine, no clock, no network.
// ---------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normInv, normPdf,
  parametricVaR, parametricES, convertVaRConfidence, convertESConfidence, scaleHorizon,
  discreteVaR, discreteES,
  percentileInc, interpolatedPercentileCS, historicalVaR, weightedHistoricalVaR, brwWeight,
  ewmaVariance, garchVariance, garchLongRunVariance, garchForecastVariance,
  binomialTailProb, kupiecStatistic, KUPIEC_CRITICAL, baselZone, backtestSummary,
  lossSeries,
  rollingVaRBacktest, riskProfile,
} from '../backtest/risk.mjs';
import { maxDrawdownPct, dailyReturns } from '../backtest/metrics.mjs';

const near = (got, want, tol, msg) => assert.ok(Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want} ± ${tol}`);

// --- The inverse normal against the standard one-tailed z-table -----------
test('normInv reproduces the one-tailed z-table printed in the market-risk deck', () => {
  near(normInv(0.90), 1.282, 0.0006, '90%');
  near(normInv(0.95), 1.645, 0.0006, '95%');
  near(normInv(0.975), 1.960, 0.0006, '97.5%');
  near(normInv(0.99), 2.326, 0.0006, '99%');
  near(normInv(0.995), 2.576, 0.0006, '99.5%');
  near(normInv(0.999), 3.090, 0.0006, '99.9%');
  near(normInv(0.9999), 3.719, 0.0006, '99.99%');
  // The deck prints 3.430 for 99.97%. The true value is 3.4316 — a rounding slip in
  // the printed table, so this locks the TRUE value and records the slip.
  near(normInv(0.9997), 3.4316, 0.0006, '99.97% (deck prints 3.430)');
  assert.ok(Number.isNaN(normInv(0)) && Number.isNaN(normInv(1)), 'outside (0,1) is not a quantile');
});

// --- Parametric VaR / ES — Hull eq (12.1) / (12.2) [RMFI p.292] ---------------
test('parametric VaR and ES reproduce RMFI Ch 12 problems 12.1, 12.6, 12.9, 12.10, 12.16', () => {
  // 12.9 / 12.10: 10-day change ~ N(0, $20M): VaR $46.5M, ES $53.3M [RMFI p.677]
  near(parametricVaR(0, 20, 0.99), 46.5, 0.05, '12.9 VaR');
  near(parametricES(0, 20, 0.99), 53.3, 0.05, '12.10 ES');
  // 12.1: gain ~ N($2M, $10M) over 6 months, 99% -> a LOSS mean of -2: 2.326×10 − 2 = $21.3M [RMFI p.676]
  near(parametricVaR(-2, 10, 0.99), 21.3, 0.05, '12.1 (his sample problem line 1)');
  // 12.6: σ = $2M/day. (a) 97.5% one-day 3.92 (b) five-day 8.77 (c) 99% five-day 10.40 [RMFI p.677]
  near(parametricVaR(0, 2, 0.975), 3.92, 0.005, '12.6a');
  near(scaleHorizon(3.92, 5), 8.77, 0.005, '12.6b √5');
  near(scaleHorizon(parametricVaR(0, 2, 0.99), 5), 10.40, 0.005, '12.6c');
  // 12.16: 99.5% three-month, mean GAIN $500k (loss mean −500), σ $3,000k: VaR $7,227k [RMFI-sol p.30]
  near(parametricVaR(-500, 3000, 0.995), 7227, 2, '12.16 VaR');
  // ⚠ The solutions manual prints ES = $9,176k — a SIGN slip: it plugs +500 into the same
  // formula whose VaR line correctly used −500. With the consistent −500 the ES is $8,18xk.
  // Locked to the arithmetic-supported value, not the printed one.
  near(parametricES(-500, 3000, 0.995), 8176, 5, '12.16 ES (consistent sign; manual prints 9,176)');
});

test('confidence-level conversion — eq (12.6) reproduces 12.12; eq (12.7) is locked as an identity', () => {
  // 12.12: 95% one-day VaR $1.5M -> 99%: 1.5 × 2.326/1.645 = $2.12M [RMFI p.677]
  near(convertVaRConfidence(1.5, 0.95, 0.99), 2.12, 0.005, '12.12 VaR 95→99');
  // 12.12's printed 99% ES ($2.58M) could not be reproduced from any reading of the setup
  // available to the note, so it is NOT locked. Instead eq (12.7) is locked as an identity
  // against eq (12.2): converting the 95% ES to 99% must equal the 99% ES computed directly
  // from the same σ. Two different formulas agreeing is a real check, not self-comparison.
  const sigma = 1.5 / normInv(0.95);
  near(convertESConfidence(parametricES(0, sigma, 0.95), 0.95, 0.99), parametricES(0, sigma, 0.99), 1e-9, 'eq 12.7 vs eq 12.2');
});

// --- Time scaling with autocorrelation — eq (12.5) [RMFI p.293] --------------
test('√T scaling with first-order autocorrelation reproduces 12.11 and 12.14', () => {
  // 12.11: σ = 3/day, T = 5, ρ = 0.1: 3√(5 + 0.8 + 0.06 + 0.004 + 0.0002) = 7.265; 95% VaR 11.95; ES 14.98
  const s5 = scaleHorizon(3, 5, 0.1);
  near(s5, 7.265, 0.002, '12.11 five-day σ');
  near(parametricVaR(0, s5, 0.95), 11.95, 0.01, '12.11 VaR');
  near(parametricES(0, s5, 0.95), 14.98, 0.01, '12.11 ES');
  // 12.14: T = 10, ρ = 0.12 -> the variance multiplier 10 + 2·9·0.12 + … = 12.417 [RMFI-sol p.29]
  near(Math.pow(scaleHorizon(1, 10, 0.12), 2), 12.417, 0.002, '12.14 multiplier');
  // ρ = 0 is the plain √T rule; ignoring a positive ρ makes the scaled VaR TOO LOW [RMFI p.294]
  near(scaleHorizon(1, 10, 0), Math.sqrt(10), 1e-12, 'ρ=0 is √T');
  assert.ok(scaleHorizon(1, 10, 0.12) > scaleHorizon(1, 10, 0), 'positive autocorrelation raises the T-day figure');
});

// --- Discrete distributions and SUBADDITIVITY — Problem 12.5 ---
test('12.5 / his var-es deck: VaR fails subadditivity, ES satisfies it', () => {
  // One investment: 0.9% chance of losing $10M, else $1M. 99% VaR $1M; ES $9.1M [RMFI p.676]
  const one = [{ loss: 10, p: 0.009 }, { loss: 1, p: 0.991 }];
  assert.equal(discreteVaR(one, 0.99), 1, 'single VaR');
  near(discreteES(one, 0.99), 9.1, 1e-6, 'single ES = (0.009×10 + 0.001×1)/0.01');
  // Two such, independent: P($20M) 0.000081, P($11M) 0.017838, P($2M) 0.982081 -> VaR $11M, ES $11.07M
  const both = [{ loss: 20, p: 0.000081 }, { loss: 11, p: 0.017838 }, { loss: 2, p: 0.982081 }];
  assert.equal(discreteVaR(both, 0.99), 11, 'portfolio VaR');
  near(discreteES(both, 0.99), 11.07, 0.005, 'portfolio ES (RMFI states the ÷0.01 explicitly)');
  // The punchline: 1 + 1 < 11 (VaR fails), 9.1 + 9.1 > 11.07 (ES holds)
  assert.ok(discreteVaR(one, 0.99) * 2 < discreteVaR(both, 0.99), 'VaR is NOT subadditive here');
  assert.ok(discreteES(one, 0.99) * 2 > discreteES(both, 0.99), 'ES IS subadditive here');
});

test('RMFI Examples 12.5–12.8 at 97.5% reproduce (ES $8.2M and $11.144M)', () => {
  const one = [{ loss: 10, p: 0.02 }, { loss: 1, p: 0.98 }];
  near(discreteES(one, 0.975), 8.2, 1e-6, 'single ES = 0.8×10 + 0.2×1');
  const both = [{ loss: 20, p: 0.0004 }, { loss: 11, p: 0.0392 }, { loss: 2, p: 0.9604 }];
  assert.equal(discreteVaR(both, 0.975), 11);
  near(discreteES(both, 0.975), 11.144, 0.001, 'portfolio ES = (0.04/2.5)×20 + (2.46/2.5)×11');
});

// --- Historical simulation — the four-index example [RMFI p.306–310] ----------
test("historical simulation: Hull's 'fifth worst of 500' and the mean of the five worst", () => {
  // The five worst scenario losses ($000s): 477.841, 345.435, 282.204, 277.041, 253.385
  const worst5 = [477.841, 345.435, 282.204, 277.041, 253.385];
  const losses = worst5.concat(Array.from({ length: 495 }, (_, i) => 200 - i * 0.3));
  const hs = historicalVaR(losses.map((l) => -l), { conf: 0.99, method: 'hull' });
  assert.equal(hs.k, 5, '99% of 500 = a five-point tail');
  assert.equal(hs.var, 253.385, 'one-day 99% VaR = the fifth worst = $253,385');
  near(hs.es, 327.181, 0.001, 'one-day 99% ES = mean of the five worst = $327,181');
  near(scaleHorizon(hs.var, 10), 801.274, 0.01, 'ten-day VaR = ×√10 = $801,274');
  assert.equal(historicalVaR([0.01, -0.02, 0.005], { conf: 0.99 }), null, 'three returns cannot hold a 1% tail — null, not a guess');
});

test('weighted historical simulation (BRW) — the weight formula, 13.6, and the $400,914 question', () => {
  // The weight of scenario 494 of 500 at λ = 0.995 is 0.00528 [RMFI p.313]
  near(brwWeight(494, 500, 0.995), 0.00528, 0.000005, 'w_494');
  // Fixture: the four-index losses placed at scenario numbers consistent with the printed
  // weights (494 for the worst; 339 gives the printed 0.00243 for the second).
  const wl = new Array(500).fill(0).map((_, i) => 50 + (i % 7));
  wl[493] = 477.841; wl[338] = 345.435; wl[329] = 282.204; wl[100] = 277.041; wl[50] = 253.385;
  const rets = wl.map((l) => -l);
  // λ = 0.995: cumulative weight passes 1% at the THIRD-worst loss -> VaR $282,204 [RMFI p.313]
  const w995 = weightedHistoricalVaR(rets, { conf: 0.99, lambda: 0.995 });
  assert.equal(w995.var, 282.204, 'λ=0.995 VaR is the third-worst loss');
  // ⚠ RMFI's TEXT prints the ES as $400,914; Problems 13.6/13.15 restate it as $400,583, and the
  // knowledge-base note calls the text figure an erratum. The arithmetic says the opposite: with
  // the tail filled to exactly 1% (the ONLY convention under which 13.6 below reproduces), the
  // ES is 400.914 to the rupee. 400,583 is what you get by rounding w₁ to 0.00528 AND treating
  // the third weight as a full 0.00228 while still dividing by 0.01 — a rounding artifact.
  // Locked to the arithmetic-supported figure.
  near(w995.es, 400.914, 0.05, 'λ=0.995 ES (RMFI text; the problems’ 400,583 does not reproduce)');
  // 13.6: λ = 0.99 -> VaR is the SECOND-worst, ES = 0.948×477,841 + 0.052×345,435 = $470,917 [RMFI p.677]
  // 0.948 is w₁ as a share of the 1% tail and 0.052 is the REMAINDER — this is what pins the fill rule.
  const w99 = weightedHistoricalVaR(rets, { conf: 0.99, lambda: 0.99 });
  assert.equal(w99.var, 345.435, 'λ=0.99 VaR is the second-worst loss');
  near(w99.es, 470.917, 0.05, 'λ=0.99 ES');
  // At λ = 0.994 over 500 days the most recent six months (126 scenarios) carry ~56% of the weight
  let recent = 0; for (let i = 375; i <= 500; i++) recent += brwWeight(i, 500, 0.994);
  near(recent, 0.556, 0.005, '~56% of the weight in the last six months');
});

test('the two common percentile conventions are both available and DIFFER', () => {
  // Excel PERCENTILE.INC — the spreadsheet convention: with 21 returns at p = 0.05
  // the position is 1 + 0.05×20 = exactly the 2nd-worst; the ES is the mean of everything
  // STRICTLY beyond it, i.e. the single worst return.
  const r21 = Array.from({ length: 21 }, (_, i) => -0.02 + i * 0.002);
  near(percentileInc(r21, 0.05), r21[1], 1e-12, 'PERCENTILE.INC lands on the 2nd-worst');
  const hp = historicalVaR(r21, { conf: 0.95, method: 'percentile' });
  near(hp.var, 0.018, 1e-12, 'VaR = −(2nd-worst return)');
  assert.equal(hp.k, 1, 'exactly one return is strictly beyond it');
  near(hp.es, 0.02, 1e-12, 'ES = −(the single worst)');
  // The practitioner interpolated percentile: 510 points, 1st percentile between the
  // 5th and 6th worst: (6 − 5.1)(−26,848,951) + (5.1 − 5)(−23,767,719) = −26,540,828
  const cs = new Array(510).fill(0).map((_, i) => -1000 + i * 100);
  for (let i = 0; i < 4; i++) cs[i] = -30000000 - i;
  cs[4] = -26848951; cs[5] = -23767719;
  const asc = cs.slice().sort((a, b) => a - b);
  near(interpolatedPercentileCS(asc, 0.01), -26540828, 1, 'CS interpolated percentile');
  // …and the two conventions give DIFFERENT positions on the same data (1 + p(n−1) vs pn).
  assert.notEqual(percentileInc(asc, 0.01), interpolatedPercentileCS(asc, 0.01), 'Excel and CS conventions differ');
});

// --- EWMA and GARCH(1,1) — RMFI Ch 10 ---------------------------------------
test('EWMA — eq (10.8) — reproduces Example 10.7 and answers 10.9, 10.12, 10.19a', () => {
  // Example 10.7: λ = 0.9, σ = 1%, u = 2% -> 1.14% [RMFI p.241]
  near(Math.sqrt(ewmaVariance(0.01 ** 2, 0.02, 0.9)), 0.0114, 0.00005, 'Ex 10.7');
  // 10.9: σ = 1.5%, $30.00 -> $30.50, λ = 0.94 -> 1.5103% (u is the PERCENTAGE change) [RMFI p.672]
  near(Math.sqrt(ewmaVariance(0.015 ** 2, 0.5 / 30, 0.94)), 0.015103, 0.00001, 'ans 10.9');
  // 10.12: σ = 0.6%, 1.5000 -> 1.4950, λ = 0.9 -> 0.579%
  near(Math.sqrt(ewmaVariance(0.006 ** 2, -0.005 / 1.5, 0.9)), 0.00579, 0.000005, 'ans 10.12');
  // 10.19(a): σ = 1.3%, $300 -> $298, λ = 0.94 -> 1.271% [RMFI-sol p.22]
  near(Math.sqrt(ewmaVariance(0.013 ** 2, -2 / 300, 0.94)), 0.01271, 0.000005, 'sol 10.19a');
});

test('GARCH(1,1) — eq (10.10) — reproduces Example 10.8, answers 10.11, 10.19b and the S&P fit', () => {
  // Example 10.8: ω = 0.000002, α = 0.13, β = 0.86: γ = 0.01, V_L = 0.0002, long-run vol 1.4142%;
  // with σ = 1.6%, u = 1% the new estimate is 1.53% [RMFI p.243]
  const g = { omega: 0.000002, alpha: 0.13, beta: 0.86 };
  near(garchLongRunVariance(g), 0.0002, 1e-9, 'V_L');
  near(Math.sqrt(garchLongRunVariance(g)), 0.014142, 0.000001, 'long-run vol');
  near(Math.sqrt(garchVariance(0.016 ** 2, 0.01, g)), 0.0153, 0.00005, 'Ex 10.8');
  // 10.11: index 1,040 -> 1,060, σ = 1%, ω = 2e−6, α = 0.06, β = 0.92 -> 1.078%
  near(Math.sqrt(garchVariance(0.0001, 20 / 1040, { omega: 2e-6, alpha: 0.06, beta: 0.92 })), 0.01078, 0.000005, 'ans 10.11');
  // 10.19(b): $300 -> $298, σ = 1.3%, ω = 2e−6, α = 0.04, β = 0.94 -> 1.275% (the manual prints "0.1275", a misplaced decimal)
  near(Math.sqrt(garchVariance(0.013 ** 2, -2 / 300, { omega: 2e-6, alpha: 0.04, beta: 0.94 })), 0.01275, 0.000005, 'sol 10.19b');
  // GARCH gives a HIGHER estimate than EWMA on the same data — the ω term's weight on V_L
  assert.ok(garchVariance(0.013 ** 2, -2 / 300, { omega: 2e-6, alpha: 0.04, beta: 0.94 }) > ewmaVariance(0.013 ** 2, -2 / 300, 0.94));
  // The S&P 500 maximum-likelihood fit: ω = 0.0000013465, α = 0.083394, β = 0.910116 -> V_L 0.0002075, 1.4404%/day [RMFI p.247]
  const sp = { omega: 0.0000013465, alpha: 0.083394, beta: 0.910116 };
  near(garchLongRunVariance(sp), 0.0002075, 5e-8, 'S&P V_L');
  near(Math.sqrt(garchLongRunVariance(sp)), 0.014404, 0.000001, 'S&P long-run vol');
  // Forecasting — eq (10.14): from V(0) = 0.0003, 10 days -> 1.72%, 500 days -> 1.45% (≈ V_L) [RMFI p.251]
  near(Math.sqrt(garchForecastVariance(0.0003, 10, sp)), 0.0172, 0.00005, '10-day forecast');
  near(Math.sqrt(garchForecastVariance(0.0003, 500, sp)), 0.0145, 0.00005, '500-day forecast ≈ V_L');
  // An unstable fit (α + β ≥ 1) has no long-run variance
  assert.ok(Number.isNaN(garchLongRunVariance({ omega: 1e-6, alpha: 0.5, beta: 0.5 })), 'α+β=1 is not mean-reverting');
});

// --- Back-testing a VaR model — RMFI §12.11, Ch 15 ---------------------------
test('binomial exception test reproduces RMFI p.299–300, 12.9 and 15.18', () => {
  // 600 days at 99%: P(≥9) = 0.152 (don’t reject), P(≥12) = 0.019 (reject); reject from m = 11
  near(binomialTailProb(9, 600, 0.01), 0.152, 0.001, 'P(≥9)');
  near(binomialTailProb(12, 600, 0.01), 0.019, 0.001, 'P(≥12)');
  assert.ok(binomialTailProb(11, 600, 0.01) < 0.05 && binomialTailProb(10, 600, 0.01) >= 0.05, 'reject at m ≥ 11');
  // 12.9: 1,000 days, 17 exceptions: 2.64% < 5% -> reject [RMFI p.677]
  near(binomialTailProb(17, 1000, 0.01), 0.0264, 0.0002, '12.9');
  // 15.18: P(≥5 in 250 days) = 10.8% — "regulators are using a confidence level of about 10%" [RMFI p.682]
  near(binomialTailProb(5, 250, 0.01), 0.108, 0.001, '15.18');
  assert.equal(binomialTailProb(0, 250, 0.01), 1, 'P(≥0) is 1');
});

test('Kupiec two-tailed test — eq (12.11) — accepts 2 ≤ m ≤ 11 of 600 days at 99% and nothing outside', () => {
  // [RMFI p.300]: the model is rejected for TOO FEW exceptions as well as too many.
  assert.ok(kupiecStatistic(1, 600, 0.01) > KUPIEC_CRITICAL, 'm=1 rejected (too few)');
  assert.ok(kupiecStatistic(2, 600, 0.01) <= KUPIEC_CRITICAL, 'm=2 accepted');
  assert.ok(kupiecStatistic(11, 600, 0.01) <= KUPIEC_CRITICAL, 'm=11 accepted');
  assert.ok(kupiecStatistic(12, 600, 0.01) > KUPIEC_CRITICAL, 'm=12 rejected (too many)');
  assert.equal(KUPIEC_CRITICAL, 3.84, 'χ²₁ at 5%');
  // Exactly the expected count gives a statistic of zero
  near(kupiecStatistic(6, 600, 0.01), 0, 1e-9, 'm = np is the null exactly');
});

test('the Basel traffic light — the m_c ladder for 250-day back-testing [RMFI p.364]', () => {
  assert.deepEqual(baselZone(0), { zone: 'green', mc: 3 });
  assert.deepEqual(baselZone(4), { zone: 'green', mc: 3 });
  assert.deepEqual(baselZone(5), { zone: 'yellow', mc: 3.4 });
  assert.deepEqual(baselZone(6), { zone: 'yellow', mc: 3.5 });
  assert.deepEqual(baselZone(7), { zone: 'yellow', mc: 3.65 });
  assert.deepEqual(baselZone(8), { zone: 'yellow', mc: 3.75 });
  assert.deepEqual(baselZone(9), { zone: 'yellow', mc: 3.85 });
  assert.deepEqual(baselZone(10), { zone: 'red', mc: 4 });
  assert.deepEqual(baselZone(37), { zone: 'red', mc: 4 });
  const s = backtestSummary(5, 250, 0.99);
  assert.equal(s.expected, 2.5, '250 × 1% = 2.5 expected exceptions');
  assert.equal(s.zone, 'yellow');
  near(s.tooManyP, 0.108, 0.001, 'the same 10.8% as 15.18');
});

// --- The rolling, no-hindsight back-test on an equity curve -------------------
test('rollingVaRBacktest uses only PRIOR returns for each day’s VaR and counts real breaches', () => {
  // A calm curve with one engineered crash on the last day. Every prior day's VaR is
  // computed from returns strictly before it, so the crash cannot lower its own VaR.
  let e = 1e7; const eq = [e];
  for (let i = 1; i < 700; i++) { e *= 1 + ((i * 7919) % 13 - 6) * 0.001; eq.push(e); } // ±0.6% wiggle
  const calm = rollingVaRBacktest(eq, { conf: 0.99, window: 500, testDays: 250, minWindow: 100 });
  assert.ok(calm && calm.days === 250, 'tests the last 250 days (699 returns; the first tested day is max(minWindow, 699−250) = 449)');
  assert.equal(calm.exceptions, 0, 'a bounded wiggle never breaches a VaR built from the same wiggle');
  const crashed = eq.slice(); crashed.push(crashed[crashed.length - 1] * 0.90); // −10% on the final day
  const bt = rollingVaRBacktest(crashed, { conf: 0.99, window: 500, testDays: 250, minWindow: 100 });
  assert.equal(bt.exceptions, 1, 'the crash is exactly one exception');
  assert.deepEqual(bt.exceptionIdx, [699], 'and it is the final day, not an earlier one');
  assert.equal(rollingVaRBacktest([100, 101, 102], {}), null, 'too short to test -> null, never a made-up zone');
});

test('riskProfile returns the board’s risk block and stays null-safe on a short curve', () => {
  let e = 1e7; const eq = [e];
  for (let i = 1; i < 800; i++) { e *= 1 + ((i * 7919) % 13 - 6) * 0.002; eq.push(e); }
  const rp = riskProfile(eq);
  assert.equal(rp.conf, 0.99);
  assert.equal(rp.window, 500, 'trailing 500 returns, Hull’s window');
  assert.ok(rp.var1dPct > 0 && rp.es1dPct >= rp.var1dPct, 'ES is never below VaR');
  near(rp.var10dPct, rp.var1dPct * Math.sqrt(10), 0.002, '10-day is the √10 rule');
  assert.ok(rp.backtest && rp.backtest.days === 250 && rp.backtest.zone === 'green', 'a well-behaved curve is green');
  const short = riskProfile([1e7, 1.01e7, 1.02e7]);
  assert.equal(short.var1dPct, null);
  assert.equal(short.backtest, null, 'no tail, no back-test — nulls, not zeros');
});

// --- Sanity on the pieces everything else leans on -----------------------------
test('normPdf and the tail-fill rule behave at the edges', () => {
  near(normPdf(0), 1 / Math.sqrt(2 * Math.PI), 1e-12, 'φ(0)');
  near(parametricES(0, 1, 0.99), normPdf(normInv(0.99)) / 0.01, 1e-12, 'ES = φ(z)/(1−X) at σ=1');
  assert.ok(parametricES(0, 1, 0.99) > parametricVaR(0, 1, 0.99), 'ES exceeds VaR for a normal');
});

// --- A WIPED account inside the window -----------
test('a bar into negative equity is a 100% loss, not a 2600% one — VaR/ES stay ≤ 100% and the profile says wiped', () => {
  // A calm ±0.6% curve, then ONE bar from ₹20L to −₹5cr (a short blow-up, unbounded by design).
  let v = 2e6; const eq = [v];
  for (let i = 1; i < 600; i++) { v *= 1 + ((i * 7919) % 13 - 6) * 0.001; eq.push(v); }
  const wiped = eq.concat([-5e7]);
  const rp = riskProfile(wiped);
  // Before the fix this read es1dPct = 524.594 — one −2600% "return" dominating the five-point tail.
  assert.ok(rp.es1dPct <= 100, `ES is capped at a total loss (got ${rp.es1dPct}%)`);
  assert.ok(rp.var1dPct <= 100 && rp.var10dPct <= 100, 'so are the VaRs');
  assert.equal(rp.wiped, true, 'and the profile SAYS the window holds a wipe-out');
  // The wipe bar is exactly ONE extra exception. Compared against the same curve WITHOUT the
  // wipe (which carries one floating-point tie of its own) — two different inputs, not the
  // code against itself.
  const cleanBt = rollingVaRBacktest(eq), withWipe = rollingVaRBacktest(wiped);
  assert.equal(withWipe.exceptions, cleanBt.exceptions + 1, 'the wipe bar adds exactly one exception — a 100% loss beats any VaR');
  assert.ok(withWipe.exceptionIdx.includes(600 - 1), 'and it is the final bar');
  // The Basel ladder exists only on 250 days: a 25-day span must NOT get a pro-rated RED zone
  // beside a Kupiec line that does not reject.
  const short = backtestSummary(1, 25, 0.99);
  assert.equal(short.zone, null, 'no zone on a 25-day span');
  assert.equal(short.kupiecReject, false, 'while Kupiec, on the raw count, does not reject');
  assert.equal(backtestSummary(5, 250, 0.99).zone, 'yellow', 'the 250-day ladder still applies');
  // The clamp mirrors maxDrawdownPct's own convention on the same curve.
  assert.equal(maxDrawdownPct(wiped), 100, 'metrics.mjs already reads this curve as a total loss');
  // On a curve that NEVER wipes the clamp is a no-op: losses equal −dailyReturns exactly, so
  // every textbook number above is untouched. (Compared against the SHARED helper, not against
  // this module's own output — a genuine independent reference.)
  const clean = riskProfile(eq);
  assert.equal(clean.wiped, false);
  const L = lossSeries(eq);
  const R = dailyReturns(eq);
  assert.equal(L.length, R.length);
  for (let i = 0; i < L.length; i++) assert.ok(Math.abs(L[i] + R[i]) < 1e-15, `bar ${i}: clamped loss == −return when nothing wiped`);
});
