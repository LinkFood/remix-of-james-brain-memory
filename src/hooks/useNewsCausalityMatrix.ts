/**
 * useNewsCausalityMatrix — per-source × per-ticker news causality hit rates.
 *
 * Phase 5 of the audit-driven loop (2026-05-09). Surfaces the derived signal
 * documented in the ct_news_causality schema comment but never rendered:
 * "Per-source hit rates become a novel derived signal ('Bloomberg moves NVDA
 * flow 68% of the time, Tradex 12%')."
 *
 * Calls get_news_causality_hit_rates RPC (migration 20260510070000) with
 * watchlist filter + 7-day default lookback. Returns flat list of
 * (news_source, ticker, total_n, moved_count, hit_pct, ...) sorted by
 * total_n DESC then hit_pct DESC.
 *
 * Component reshapes into a source × ticker matrix for the UI.
 *
 * Refetch every 5 min — news_causality cron runs every 15 min so any
 * fresh data appears within a third-cron interval.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA'];

export interface NewsCausalityRow {
  news_source: string;
  ticker: string;
  total_n: number;
  moved_count: number;
  hit_pct: number;
  flow_moved_count: number;
  dp_moved_count: number;
  total_flow_premium: number;
  total_dp_notional: number;
}

interface UseNewsCausalityMatrixArgs {
  /** Lookback in days. Default 7. Max 30. */
  lookbackDays?: number;
  /** Min N per (source,ticker) cell to surface. Default 3. */
  minN?: number;
}

export function useNewsCausalityMatrix(args: UseNewsCausalityMatrixArgs = {}) {
  const lookbackDays = Math.max(1, Math.min(30, args.lookbackDays ?? 7));
  const minN = Math.max(1, args.minN ?? 3);

  const query = useQuery<NewsCausalityRow[]>({
    queryKey: ['news-causality-matrix', { lookbackDays, minN }],
    refetchInterval: 5 * 60_000,
    staleTime: 4 * 60_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      const { data, error } = await sb.rpc('get_news_causality_hit_rates', {
        p_lookback_days: lookbackDays,
        p_min_n: minN,
        p_tickers: WATCHLIST,
      });
      if (error) throw error;
      return Array.isArray(data) ? (data as NewsCausalityRow[]) : [];
    },
  });

  const rows = query.data ?? [];

  // Reshape: source -> { ticker: row }. Track per-source totals for ranking.
  const matrix = new Map<string, { rows: Map<string, NewsCausalityRow>; total: number; meanHit: number }>();
  for (const r of rows) {
    if (!matrix.has(r.news_source)) {
      matrix.set(r.news_source, { rows: new Map(), total: 0, meanHit: 0 });
    }
    const bucket = matrix.get(r.news_source)!;
    bucket.rows.set(r.ticker, r);
    bucket.total += r.total_n;
  }
  // Compute mean hit_pct per source (across cells that exist)
  for (const bucket of matrix.values()) {
    let sum = 0;
    let n = 0;
    for (const r of bucket.rows.values()) {
      sum += r.hit_pct;
      n += 1;
    }
    bucket.meanHit = n > 0 ? sum / n : 0;
  }

  // Sources sorted by total_n DESC (most-active first).
  const sources = Array.from(matrix.entries())
    .map(([name, b]) => ({ name, total: b.total, meanHit: b.meanHit, rows: b.rows }))
    .sort((a, b) => b.total - a.total);

  return {
    rows,
    sources,
    watchlist: WATCHLIST,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
