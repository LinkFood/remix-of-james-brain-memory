/**
 * useRiskMetrics — hedge-fund-grade stats for Claude's paper book.
 *
 * Pulls ct_book, ct_trades, and ct_spy_daily, filters by period, runs the
 * pure-math helpers in `src/lib/riskMetrics.ts`. No edge function calls.
 *
 * Benchmark: ct_spy_daily is populated daily by the ct-spy-capture cron
 * (4:05 PM ET weekdays). When the table has ≥ MIN_SAMPLE aligned rows with
 * ct_book, we compute a real beta + annualized alpha. Before the pipeline
 * has enough history, benchmarkAvailable stays false and the panel renders
 * "—" as before.
 *
 * Re-fetches every 5 min. The panel passes a period selector; the
 * filter is applied client-side so the React Query cache is shared
 * across the three period views (one fetch, three slices).
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { CtBookRow, CtTradeRow } from './useCoTraderData';
import {
  dailyReturnsFromBook,
  equitySeriesFromBook,
  sharpeRatio,
  sortinoRatio,
  maxDrawdownPct,
  calmarRatio,
  kurtosisExcess,
  betaVsSpy,
  rMultipleDistribution,
  expectancy,
  tradeRMultiples,
  type RBucket,
} from '@/lib/riskMetrics';

const TRADING_DAYS = 252;
const BETA_MIN_SAMPLE = 5;

interface CtSpyDailyRow {
  date: string;
  close: number | null;
  prev_close: number | null;
  daily_return_pct: number | null;
}

export type RiskPeriod = '7d' | '30d' | 'all';

export interface RiskMetrics {
  period: RiskPeriod;
  sampleSize: { sessions: number; trades: number; tradesWithR: number };
  sharpe: number;
  sortino: number;
  calmar: number;
  maxDd: number;                         // decimal (negative)
  maxDdPeakDate: string | null;
  maxDdTroughDate: string | null;
  recoveredAt: string | null;            // null = still underwater or never drew down
  kurtosisExcess: number;
  beta: number;                          // NaN when benchmark missing
  alpha: number;                         // NaN when benchmark missing — annualized decimal
  benchmarkAvailable: boolean;
  expectancy: {
    meanR: number;
    winRate: number;
    avgWinR: number;
    avgLossR: number;
    kelly: number;
  };
  /**
   * Forward-looking expectancy from Claude's expected_move claims.
   * Per graded+banded call: midpoint = (low_pct + high_pct) / 2,
   * weighted by confidence_pct/100. Compared against the mean absolute
   * realized move in the same universe — answers "is Claude's claimed
   * magnitude roughly anchored to what actually happened?"
   */
  forwardExpectancy: {
    meanClaimedMidPct: number;          // NaN when no graded+banded samples
    meanRealizedAbsPct: number;         // mean |actual_return_pct| in %
    sampleSize: number;
  };
  /**
   * Band accuracy — CALIBRATION of magnitude claims.
   * % of graded flags/alerts where actual_return_pct fell inside
   * [low_pct, high_pct]. Confidence-weighted variant upweights higher
   * claimed-confidence calls so "I said 85% and nailed it" is worth
   * more than "I said 55% and nailed it." NaN when no samples exist.
   */
  bandAccuracy: {
    hitRate: number;                    // 0..1
    sampleSize: number;
    weightedHitRate: number;            // 0..1, each claim weighted by confidence_pct
    meanClaimedConfidence: number;      // average confidence_pct (sanity anchor)
  };
  rHistogram: RBucket[];
  grade: 'A' | 'B' | 'C' | 'D' | 'N/A';
  gradeReason: string;
}

/**
 * Graded flag/alert that had an expected_move claim at write time.
 * Used to compute band accuracy + forward expectancy.
 *
 * As of migration 20260420000029, band_* columns live directly on ct_grades,
 * so we no longer need to cross-reference ct_flags/ct_alerts at read time.
 * A row with `band_hit = null` is pre-v1.3 (no band claim) and is dropped.
 */
interface BandedGradeRow {
  graded_at: string;
  actual_return_pct: number;
  band_hit: boolean;
  band_low_pct: number;
  band_high_pct: number;
  band_confidence_pct: number;
}

function sliceByPeriod<T extends { session_date: string }>(
  rows: T[],
  period: RiskPeriod
): T[] {
  if (period === 'all') return rows;
  const days = period === '7d' ? 7 : 30;
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - days);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return rows.filter(r => r.session_date >= cutoffStr);
}

/**
 * Grade rubric (order matters — earlier wins):
 *   D  = Sharpe <= 0 OR |maxDd| > 20%
 *   A  = Sharpe > 1.5 AND |maxDd| < 10% AND expectancy > 0.3R
 *   B  = Sharpe > 1.0 AND |maxDd| < 15%
 *   C  = Sharpe > 0
 *   N/A = insufficient sample
 */
function computeGrade(
  sharpe: number,
  maxDd: number,
  meanR: number
): { grade: RiskMetrics['grade']; reason: string } {
  if (!Number.isFinite(sharpe)) {
    return { grade: 'N/A', reason: 'Not enough sessions to compute Sharpe.' };
  }
  const ddMag = Number.isFinite(maxDd) ? Math.abs(maxDd) : 0;

  if (sharpe <= 0) {
    return { grade: 'D', reason: `Sharpe ${sharpe.toFixed(2)} — strategy not compensating for risk.` };
  }
  if (ddMag > 0.20) {
    return { grade: 'D', reason: `Max DD ${(ddMag * 100).toFixed(1)}% exceeds 20% guardrail.` };
  }
  if (sharpe > 1.5 && ddMag < 0.10 && Number.isFinite(meanR) && meanR > 0.3) {
    return { grade: 'A', reason: `Sharpe ${sharpe.toFixed(2)}, max DD ${(ddMag * 100).toFixed(1)}%, expectancy ${meanR.toFixed(2)}R.` };
  }
  if (sharpe > 1.0 && ddMag < 0.15) {
    return { grade: 'B', reason: `Sharpe ${sharpe.toFixed(2)}, max DD ${(ddMag * 100).toFixed(1)}%.` };
  }
  if (sharpe > 0) {
    return { grade: 'C', reason: `Sharpe ${sharpe.toFixed(2)} — positive but sub-hedge-fund-grade.` };
  }
  return { grade: 'N/A', reason: 'Metrics incomplete.' };
}

/**
 * Align ct_book-derived daily returns with ct_spy_daily returns by session_date.
 *
 * Book returns are *session-to-session* — row i's return is (balance_i - balance_{i-1})/balance_{i-1}.
 * So we pair book.session_date[i] (i>=1) with ct_spy_daily.date where date == session_date[i].
 * SPY rows missing for a given session are dropped (both sides). Any pair where the
 * SPY return is non-finite is also dropped.
 *
 * Returns { strategy, spy } as two same-length arrays in session order.
 */
function alignBookAndSpy(
  book: CtBookRow[],
  spy: CtSpyDailyRow[],
): { strategy: number[]; spy: number[] } {
  if (!Array.isArray(book) || book.length < 2) return { strategy: [], spy: [] };

  const sorted = [...book].sort((a, b) => a.session_date.localeCompare(b.session_date));
  const balances = sorted.map(r =>
    r.ending_balance != null
      ? r.ending_balance
      : r.starting_balance + (r.realized_pnl ?? 0) + (r.unrealized_pnl ?? 0),
  );

  const spyByDate = new Map<string, number>();
  for (const row of spy) {
    if (!row.date) continue;
    const ret = row.daily_return_pct;
    if (ret == null || !Number.isFinite(ret)) continue;
    // Generated column is in percent. Convert to fractional decimal.
    spyByDate.set(row.date, ret / 100);
  }

  const strategyOut: number[] = [];
  const spyOut: number[] = [];
  for (let i = 1; i < balances.length; i++) {
    const prev = balances[i - 1];
    const curr = balances[i];
    if (!Number.isFinite(prev) || !Number.isFinite(curr) || prev <= 0) continue;
    const sessionDate = sorted[i].session_date;
    const spyRet = spyByDate.get(sessionDate);
    if (spyRet === undefined) continue;
    strategyOut.push((curr - prev) / prev);
    spyOut.push(spyRet);
  }
  return { strategy: strategyOut, spy: spyOut };
}

/**
 * Annualized alpha (Jensen). With aligned daily return arrays:
 *   alpha_daily = mean(strategy - rfDaily) - beta * mean(spy - rfDaily)
 *   alpha_annual = alpha_daily * 252
 */
function alphaVsSpy(
  strategy: number[],
  spy: number[],
  beta: number,
  rfAnnual = 0.045,
): number {
  if (strategy.length !== spy.length || strategy.length < BETA_MIN_SAMPLE) return NaN;
  if (!Number.isFinite(beta)) return NaN;
  const rfDaily = rfAnnual / TRADING_DAYS;
  let sS = 0;
  let sM = 0;
  for (let i = 0; i < strategy.length; i++) {
    sS += strategy[i] - rfDaily;
    sM += spy[i] - rfDaily;
  }
  const meanS = sS / strategy.length;
  const meanM = sM / spy.length;
  return (meanS - beta * meanM) * TRADING_DAYS;
}

export function useRiskMetrics(period: RiskPeriod = '30d') {
  const query = useQuery<{
    book: CtBookRow[];
    trades: CtTradeRow[];
    spy: CtSpyDailyRow[];
    bandedGrades: BandedGradeRow[];
  }>({
    queryKey: ['risk_metrics_raw'],
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    queryFn: async () => {
      const [bookRes, tradesRes, spyRes, bandedRes] = await Promise.all([
        supabase
          .from('ct_book')
          .select('*')
          .order('session_date', { ascending: true }),
        supabase
          .from('ct_trades')
          .select('*')
          .order('session_date', { ascending: true })
          .limit(5000),
        supabase
          .from('ct_spy_daily')
          .select('date, close, prev_close, daily_return_pct')
          .order('date', { ascending: true }),
        // Banded grades — band_* columns live directly on ct_grades as of
        // 20260420000029. A row with band_hit IS NOT NULL had an expected_move
        // at write time (v1.3+). Pre-v1.3 grades are filtered at the DB.
        // No more ct_flags/ct_alerts cross-join — the grader now snapshots
        // the claim into ct_grades at horizon close.
        supabase
          .from('ct_grades')
          .select('graded_at, actual_return_pct, band_hit, band_low_pct, band_high_pct, band_confidence_pct')
          .not('band_hit', 'is', null)
          .order('graded_at', { ascending: false })
          .limit(2000),
      ]);
      if (bookRes.error) throw bookRes.error;
      if (tradesRes.error) throw tradesRes.error;
      // ct_spy_daily missing (pre-migration) shouldn't crash the panel —
      // just fall back to the "no benchmark" path.
      const spy: CtSpyDailyRow[] = spyRes.error ? [] : ((spyRes.data ?? []) as CtSpyDailyRow[]);

      const bandedGrades: BandedGradeRow[] = [];
      const bandedRows = (bandedRes.error ? [] : (bandedRes.data ?? [])) as Array<{
        graded_at: string;
        actual_return_pct: number | null;
        band_hit: boolean | null;
        band_low_pct: number | null;
        band_high_pct: number | null;
        band_confidence_pct: number | null;
      }>;
      for (const r of bandedRows) {
        if (
          r.actual_return_pct == null || !Number.isFinite(r.actual_return_pct) ||
          r.band_hit == null ||
          r.band_low_pct == null || !Number.isFinite(r.band_low_pct) ||
          r.band_high_pct == null || !Number.isFinite(r.band_high_pct) ||
          r.band_confidence_pct == null || !Number.isFinite(r.band_confidence_pct)
        ) continue;
        bandedGrades.push({
          graded_at: r.graded_at,
          actual_return_pct: r.actual_return_pct,
          band_hit: r.band_hit,
          band_low_pct: r.band_low_pct,
          band_high_pct: r.band_high_pct,
          band_confidence_pct: r.band_confidence_pct,
        });
      }

      return {
        book: (bookRes.data ?? []) as CtBookRow[],
        trades: (tradesRes.data ?? []) as CtTradeRow[],
        spy,
        bandedGrades,
      };
    },
  });

  const metrics: RiskMetrics | null = useMemo(() => {
    if (!query.data) return null;
    const book = sliceByPeriod(query.data.book, period);
    const trades = sliceByPeriod(query.data.trades, period);

    const returns = dailyReturnsFromBook(book);
    const equity = equitySeriesFromBook(book);
    const sharpe = sharpeRatio(returns);
    const sortino = sortinoRatio(returns);
    const ddInfo = maxDrawdownPct(equity);
    const calmar = calmarRatio(returns, ddInfo.maxDd);
    const kurt = kurtosisExcess(returns);

    // SPY benchmark — ct_spy_daily populated daily by ct-spy-capture cron.
    // Slice SPY rows to the same period filter, then align by session_date.
    const spySliced = (query.data.spy ?? []).filter(r => {
      if (period === 'all') return true;
      const days = period === '7d' ? 7 : 30;
      const cutoff = new Date();
      cutoff.setUTCHours(0, 0, 0, 0);
      cutoff.setUTCDate(cutoff.getUTCDate() - days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      return r.date >= cutoffStr;
    });
    const aligned = alignBookAndSpy(book, spySliced);
    const benchmarkAvailable = aligned.strategy.length >= BETA_MIN_SAMPLE;
    const beta = benchmarkAvailable ? betaVsSpy(aligned.strategy, aligned.spy) : NaN;
    const alpha = benchmarkAvailable ? alphaVsSpy(aligned.strategy, aligned.spy, beta) : NaN;

    const exp = expectancy(trades);
    const rHistogram = rMultipleDistribution(trades);
    const tradesWithR = tradeRMultiples(trades).length;

    const sorted = [...book].sort((a, b) => a.session_date.localeCompare(b.session_date));
    const maxDdPeakDate =
      ddInfo.peakIndex >= 0 && ddInfo.peakIndex < sorted.length
        ? sorted[ddInfo.peakIndex].session_date
        : null;
    const maxDdTroughDate =
      ddInfo.troughIndex >= 0 && ddInfo.troughIndex < sorted.length
        ? sorted[ddInfo.troughIndex].session_date
        : null;
    const recoveredAt =
      ddInfo.recoveryIndex != null && ddInfo.recoveryIndex < sorted.length
        ? sorted[ddInfo.recoveryIndex].session_date
        : null;

    const { grade, reason } = computeGrade(sharpe, ddInfo.maxDd, exp.meanR);

    // Band accuracy + forward expectancy — scoped to the same period.
    // Graded rows use `graded_at` timestamp (not session_date), so we
    // slice on that field directly rather than going through sliceByPeriod.
    const bandedAll = query.data.bandedGrades ?? [];
    const bandedSliced = (() => {
      if (period === 'all') return bandedAll;
      const days = period === '7d' ? 7 : 30;
      const cutoff = new Date();
      cutoff.setUTCHours(0, 0, 0, 0);
      cutoff.setUTCDate(cutoff.getUTCDate() - days);
      return bandedAll.filter(r => Date.parse(r.graded_at) >= cutoff.getTime());
    })();

    let bandHits = 0;
    let weightedHits = 0;
    let weightSum = 0;
    let midSum = 0;
    let absSum = 0;
    let confSum = 0;
    for (const r of bandedSliced) {
      const actual = r.actual_return_pct;
      const weight = r.band_confidence_pct / 100;
      // band_hit is authoritative — the grader already checked inclusion at
      // horizon close against the snapshotted band. Re-deriving here would
      // re-run the same inequality on the same numbers.
      const hit = r.band_hit ? 1 : 0;
      bandHits += hit;
      weightedHits += hit * weight;
      weightSum += weight;
      midSum += (r.band_low_pct + r.band_high_pct) / 2 * weight;
      absSum += Math.abs(actual);
      confSum += r.band_confidence_pct;
    }
    const bandN = bandedSliced.length;
    const bandAccuracy: RiskMetrics['bandAccuracy'] = bandN > 0
      ? {
          hitRate: bandHits / bandN,
          sampleSize: bandN,
          weightedHitRate: weightSum > 0 ? weightedHits / weightSum : NaN,
          meanClaimedConfidence: confSum / bandN,
        }
      : { hitRate: NaN, sampleSize: 0, weightedHitRate: NaN, meanClaimedConfidence: NaN };

    const forwardExpectancy: RiskMetrics['forwardExpectancy'] = bandN > 0
      ? {
          meanClaimedMidPct: weightSum > 0 ? midSum / weightSum : NaN,
          meanRealizedAbsPct: absSum / bandN,
          sampleSize: bandN,
        }
      : { meanClaimedMidPct: NaN, meanRealizedAbsPct: NaN, sampleSize: 0 };

    return {
      period,
      sampleSize: {
        sessions: book.length,
        trades: trades.length,
        tradesWithR,
      },
      sharpe,
      sortino,
      calmar,
      maxDd: ddInfo.maxDd,
      maxDdPeakDate,
      maxDdTroughDate,
      recoveredAt,
      kurtosisExcess: kurt,
      beta,
      alpha,
      benchmarkAvailable,
      expectancy: exp,
      forwardExpectancy,
      bandAccuracy,
      rHistogram,
      grade,
      gradeReason: reason,
    };
  }, [query.data, period]);

  return {
    metrics,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
  };
}
