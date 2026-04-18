/**
 * useRiskMetrics — hedge-fund-grade stats for Claude's paper book.
 *
 * Pulls ct_book + ct_trades, filters by period, and runs the pure-math
 * helpers in `src/lib/riskMetrics.ts`. No edge function calls. No SPY
 * price table exists in the DB yet, so beta/alpha are reported as NaN
 * with a `benchmarkAvailable = false` flag; the panel renders "—" and
 * a tooltip explaining the gap.
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
  rHistogram: RBucket[];
  grade: 'A' | 'B' | 'C' | 'D' | 'N/A';
  gradeReason: string;
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

export function useRiskMetrics(period: RiskPeriod = '30d') {
  const query = useQuery<{ book: CtBookRow[]; trades: CtTradeRow[] }>({
    queryKey: ['risk_metrics_raw'],
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
    queryFn: async () => {
      const [bookRes, tradesRes] = await Promise.all([
        supabase
          .from('ct_book')
          .select('*')
          .order('session_date', { ascending: true }),
        supabase
          .from('ct_trades')
          .select('*')
          .order('session_date', { ascending: true })
          .limit(5000),
      ]);
      if (bookRes.error) throw bookRes.error;
      if (tradesRes.error) throw tradesRes.error;
      return {
        book: (bookRes.data ?? []) as CtBookRow[],
        trades: (tradesRes.data ?? []) as CtTradeRow[],
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

    // SPY benchmark not stored in DB yet. Punt with NaN + flag.
    // When a SPY price pipeline lands, fetch daily closes aligned to
    // book session_date and pass here.
    const benchmarkAvailable = false;
    const beta = benchmarkAvailable ? betaVsSpy(returns, []) : NaN;
    const alpha = NaN;

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
