/**
 * riskMetrics — pure-math risk/performance helpers.
 *
 * Hedge-fund-grade stats for Co-Trader's paper book. No React, no
 * side effects. All inputs are plain arrays/rows and outputs are
 * numbers (or tiny structs). Functions handle short arrays gracefully:
 * if there isn't enough sample to compute a meaningful value they
 * return NaN (scalar) or a sentinel struct. Callers are expected to
 * `Number.isFinite()`-guard before rendering.
 *
 * Conventions:
 *   - Returns are fractional decimals (0.012 = +1.2%).
 *   - `rfAnnual` defaults to 0.045 (4.5%) — roughly front-bill yield.
 *   - 252 trading days per year.
 *   - "Equity series" is a dollar balance per day (not a return series).
 */
import type { CtBookRow, CtTradeRow } from '@/hooks/useCoTraderData';

const TRADING_DAYS = 252;
const MIN_SAMPLE = 5;

// ---------------------------------------------------------------------------
// Return series
// ---------------------------------------------------------------------------

/**
 * Daily fractional returns from a ct_book history.
 *
 * Uses ending_balance when the session is closed, otherwise the live
 * approximation `starting + realized + unrealized`. Returns are computed
 * session-to-session, so the first row contributes no return (we need a
 * prior balance to divide by).
 *
 * If the computed balance is non-positive on the prior row, the return
 * for the next step is skipped — division by zero would poison every
 * downstream stat.
 */
export function dailyReturnsFromBook(rows: CtBookRow[]): number[] {
  if (!Array.isArray(rows) || rows.length < 2) return [];

  // Sort ascending by session_date so we walk forward in time.
  const sorted = [...rows].sort((a, b) =>
    a.session_date.localeCompare(b.session_date)
  );

  const balances: number[] = sorted.map(r => {
    if (r.ending_balance != null) return r.ending_balance;
    return r.starting_balance + (r.realized_pnl ?? 0) + (r.unrealized_pnl ?? 0);
  });

  const out: number[] = [];
  for (let i = 1; i < balances.length; i++) {
    const prev = balances[i - 1];
    const curr = balances[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) continue;
    out.push((curr - prev) / prev);
  }
  return out;
}

/**
 * Equity series (dollar balances) from ct_book, ascending.
 * Same balance resolution as `dailyReturnsFromBook`.
 */
export function equitySeriesFromBook(rows: CtBookRow[]): number[] {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const sorted = [...rows].sort((a, b) =>
    a.session_date.localeCompare(b.session_date)
  );
  return sorted.map(r =>
    r.ending_balance != null
      ? r.ending_balance
      : r.starting_balance + (r.realized_pnl ?? 0) + (r.unrealized_pnl ?? 0)
  );
}

// ---------------------------------------------------------------------------
// Moments
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function stdDev(xs: number[], ddof = 1): number {
  if (xs.length < 2) return NaN;
  const m = mean(xs);
  let sq = 0;
  for (const x of xs) sq += (x - m) * (x - m);
  const denom = xs.length - ddof;
  if (denom <= 0) return NaN;
  return Math.sqrt(sq / denom);
}

// ---------------------------------------------------------------------------
// Sharpe / Sortino / Calmar
// ---------------------------------------------------------------------------

/**
 * Annualized Sharpe ratio.
 *   sharpe = (mean(daily_excess) * sqrt(252)) / std(daily_excess)
 * where daily_excess = daily_return - (rfAnnual / 252).
 */
export function sharpeRatio(returns: number[], rfAnnual = 0.045): number {
  if (!Array.isArray(returns) || returns.length < MIN_SAMPLE) return NaN;
  const rfDaily = rfAnnual / TRADING_DAYS;
  const excess = returns.map(r => r - rfDaily);
  const mu = mean(excess);
  const sd = stdDev(excess, 1);
  if (!Number.isFinite(mu) || !Number.isFinite(sd) || sd === 0) return NaN;
  return (mu * Math.sqrt(TRADING_DAYS)) / sd;
}

/**
 * Annualized Sortino ratio — same as Sharpe but uses downside deviation
 * (stdev of negative excess returns only). Penalizes losses, not volatility.
 */
export function sortinoRatio(returns: number[], rfAnnual = 0.045): number {
  if (!Array.isArray(returns) || returns.length < MIN_SAMPLE) return NaN;
  const rfDaily = rfAnnual / TRADING_DAYS;
  const excess = returns.map(r => r - rfDaily);
  const mu = mean(excess);
  const downside = excess.filter(r => r < 0);
  if (downside.length === 0) {
    // No losing days in sample — ratio is mathematically infinite.
    // Return NaN so callers can render "—" rather than Infinity.
    return NaN;
  }
  // Downside deviation uses zero as the reference (not mean). This is
  // the canonical Sortino definition — negative deviations from target.
  let sq = 0;
  for (const r of downside) sq += r * r;
  const dd = Math.sqrt(sq / downside.length);
  if (dd === 0) return NaN;
  return (mu * Math.sqrt(TRADING_DAYS)) / dd;
}

/**
 * Max drawdown on an equity series.
 *
 * Walks the series tracking running peak. The worst (peak - trough)/peak
 * anywhere wins. Recovery index is the first index AFTER troughIndex where
 * balance >= peak; null if the book never recovered.
 *
 * Returns:
 *   maxDd is a negative decimal (e.g., -0.187 = -18.7%).
 *   Indices are positions in the input array.
 */
export function maxDrawdownPct(equitySeries: number[]): {
  maxDd: number;
  peakIndex: number;
  troughIndex: number;
  recoveryIndex: number | null;
} {
  if (!Array.isArray(equitySeries) || equitySeries.length < 2) {
    return { maxDd: NaN, peakIndex: -1, troughIndex: -1, recoveryIndex: null };
  }

  let peak = equitySeries[0];
  let peakIdx = 0;
  let worstDd = 0;
  let worstPeakIdx = 0;
  let worstTroughIdx = 0;

  for (let i = 0; i < equitySeries.length; i++) {
    const v = equitySeries[i];
    if (v > peak) {
      peak = v;
      peakIdx = i;
    }
    if (peak > 0) {
      const dd = (v - peak) / peak; // <= 0
      if (dd < worstDd) {
        worstDd = dd;
        worstPeakIdx = peakIdx;
        worstTroughIdx = i;
      }
    }
  }

  // Recovery: first index after trough where value >= the peak that preceded it.
  let recoveryIdx: number | null = null;
  const recoverTarget = equitySeries[worstPeakIdx];
  for (let i = worstTroughIdx + 1; i < equitySeries.length; i++) {
    if (equitySeries[i] >= recoverTarget) {
      recoveryIdx = i;
      break;
    }
  }

  return {
    maxDd: worstDd,
    peakIndex: worstPeakIdx,
    troughIndex: worstTroughIdx,
    recoveryIndex: recoveryIdx,
  };
}

/**
 * Calmar ratio — annualized return / |max drawdown|.
 * `maxDdPct` is expected in decimal form (e.g., -0.12).
 */
export function calmarRatio(returns: number[], maxDdPct: number): number {
  if (!Array.isArray(returns) || returns.length < MIN_SAMPLE) return NaN;
  if (!Number.isFinite(maxDdPct) || maxDdPct === 0) return NaN;
  const mu = mean(returns);
  if (!Number.isFinite(mu)) return NaN;
  const annReturn = mu * TRADING_DAYS;
  return annReturn / Math.abs(maxDdPct);
}

// ---------------------------------------------------------------------------
// R-multiples / expectancy
// ---------------------------------------------------------------------------

export interface RBucket {
  r: number;   // representative R for the bucket (-3, -2, -1, 0, 1, 2, 3, 4)
  count: number;
}

/**
 * Compute each trade's R multiple.
 *
 * R = realized_pnl_pct / stop_distance_pct
 * where stop_distance_pct = |entry_price - stop_price| / entry_price * 100
 *
 * Trades without stop_price, entry_price, or realized_pnl_pct are skipped.
 * Only `closed` trades are considered.
 */
export function tradeRMultiples(trades: CtTradeRow[]): number[] {
  if (!Array.isArray(trades)) return [];
  const out: number[] = [];
  for (const t of trades) {
    if (t.status !== 'closed') continue;
    if (t.stop_price == null || t.entry_price == null) continue;
    if (t.realized_pnl_pct == null) continue;
    const stopDistPct = (Math.abs(t.entry_price - t.stop_price) / t.entry_price) * 100;
    if (!Number.isFinite(stopDistPct) || stopDistPct <= 0) continue;
    const r = t.realized_pnl_pct / stopDistPct;
    if (!Number.isFinite(r)) continue;
    out.push(r);
  }
  return out;
}

/**
 * Histogram of R-multiples bucketed into integer R-bins.
 * Buckets: -3R or worse, -2R, -1R, 0R, +1R, +2R, +3R, +4R or better.
 *
 * A trade lands in bucket k when floor(r) === k, clamped to [-3, 4].
 */
export function rMultipleDistribution(trades: CtTradeRow[]): RBucket[] {
  const rs = tradeRMultiples(trades);
  const bins: Record<number, number> = {
    [-3]: 0, [-2]: 0, [-1]: 0, 0: 0, 1: 0, 2: 0, 3: 0, 4: 0,
  };
  for (const r of rs) {
    let k = Math.floor(r);
    if (k < -3) k = -3;
    if (k > 4) k = 4;
    bins[k] = (bins[k] ?? 0) + 1;
  }
  return [-3, -2, -1, 0, 1, 2, 3, 4].map(r => ({ r, count: bins[r] ?? 0 }));
}

/**
 * Expectancy + Kelly position sizing %.
 *
 *   meanR   = avg of per-trade R multiples
 *   winRate = #(R>0) / n
 *   avgWinR, avgLossR = conditional means (avgLossR is positive magnitude)
 *   kelly   = winRate - (1 - winRate) / (avgWinR / avgLossR)
 *
 * Kelly is reported as a fraction of book; caller multiplies by 100 for %.
 * Returns NaN for all fields when the sample is too thin.
 */
export function expectancy(trades: CtTradeRow[]): {
  meanR: number;
  winRate: number;
  avgWinR: number;
  avgLossR: number;
  kelly: number;
} {
  const rs = tradeRMultiples(trades);
  if (rs.length < MIN_SAMPLE) {
    return { meanR: NaN, winRate: NaN, avgWinR: NaN, avgLossR: NaN, kelly: NaN };
  }
  const wins = rs.filter(r => r > 0);
  const losses = rs.filter(r => r < 0);
  const meanR = mean(rs);
  const winRate = wins.length / rs.length;
  const avgWinR = wins.length > 0 ? mean(wins) : NaN;
  const avgLossR = losses.length > 0 ? Math.abs(mean(losses)) : NaN;

  let kelly = NaN;
  if (Number.isFinite(avgWinR) && Number.isFinite(avgLossR) && avgLossR > 0) {
    const payoff = avgWinR / avgLossR;
    if (payoff > 0) {
      kelly = winRate - (1 - winRate) / payoff;
    }
  }

  return { meanR, winRate, avgWinR, avgLossR, kelly };
}

// ---------------------------------------------------------------------------
// Beta / kurtosis
// ---------------------------------------------------------------------------

/**
 * Beta of strategy vs SPY.
 *   beta = cov(strategy, spy) / var(spy)
 * Arrays must be the same length and aligned by date. Callers align upstream.
 */
export function betaVsSpy(
  strategyReturns: number[],
  spyReturns: number[]
): number {
  if (!Array.isArray(strategyReturns) || !Array.isArray(spyReturns)) return NaN;
  const n = Math.min(strategyReturns.length, spyReturns.length);
  if (n < MIN_SAMPLE) return NaN;

  const s = strategyReturns.slice(0, n);
  const m = spyReturns.slice(0, n);
  const sMean = mean(s);
  const mMean = mean(m);
  if (!Number.isFinite(sMean) || !Number.isFinite(mMean)) return NaN;

  let cov = 0;
  let varM = 0;
  for (let i = 0; i < n; i++) {
    const ds = s[i] - sMean;
    const dm = m[i] - mMean;
    cov += ds * dm;
    varM += dm * dm;
  }
  if (varM === 0) return NaN;
  return cov / varM;
}

/**
 * Excess kurtosis — standardized 4th moment minus 3.
 *   > 0 = fat-tailed (riskier than normal)
 *   = 0 = normal
 *   < 0 = thin-tailed
 */
export function kurtosisExcess(returns: number[]): number {
  if (!Array.isArray(returns) || returns.length < MIN_SAMPLE) return NaN;
  const mu = mean(returns);
  const sd = stdDev(returns, 0); // population std for kurtosis definition
  if (!Number.isFinite(mu) || !Number.isFinite(sd) || sd === 0) return NaN;

  let s = 0;
  for (const r of returns) {
    const z = (r - mu) / sd;
    s += z * z * z * z;
  }
  return s / returns.length - 3;
}
