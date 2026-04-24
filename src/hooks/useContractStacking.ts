/**
 * useContractStacking — leaderboard of contracts hit repeatedly in the
 * configured window. Stacking = the same OCC contract printing 3+ times
 * for >= $100k cumulative premium. That's institutional repetition, the
 * kind of thing a single row on /tape can hide when it's really 12 hits
 * on one strike.
 *
 * RPC: ct_contract_stacking (built in parallel by the backend agent).
 * Handle RPC-not-ready gracefully — skeleton + retry on next poll,
 * never bubble an error banner. retry: false on the query so we don't
 * spam logs while the migration is in flight.
 *
 * Returns the raw row list plus a bySymbol Map for O(1) lookup from
 * the /tape row-level badge renderer.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface StackRow {
  option_symbol: string;
  ticker: string;
  strike: number | null;
  expiry: string | null;      // YYYY-MM-DD
  side: string;                // 'C' or 'P'
  prints_count: number;
  first_ts: string;
  last_ts: string;
  premium_total: number;
  avg_score: number | null;
  max_score: number | null;
  ask_dominant_pct: number | null;
  opening_buy_count: number;
  opening_sell_count: number;
  last_15min_prints: number;
  is_accelerating: boolean;
}

export interface UseContractStackingResult {
  rows: StackRow[];
  bySymbol: Map<string, StackRow>;
  isLoading: boolean;
  isError: boolean;
}

export function useContractStacking(windowMin = 360, limit = 50): UseContractStackingResult {
  const { data, isLoading, isError } = useQuery<StackRow[]>({
    queryKey: ['ct_contract_stacking', windowMin, limit],
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('ct_contract_stacking', {
        p_window_min: windowMin,
        p_min_prints: 3,
        p_min_premium: 100_000,
        p_ticker: null,
        p_limit: limit,
      });
      if (error) throw error;
      return (Array.isArray(data) ? data : []) as StackRow[];
    },
  });

  const rows = useMemo<StackRow[]>(() => data ?? [], [data]);

  const bySymbol = useMemo(() => {
    const m = new Map<string, StackRow>();
    for (const r of rows) m.set(r.option_symbol, r);
    return m;
  }, [rows]);

  return { rows, bySymbol, isLoading, isError };
}

/** Compact print-count formatter: 12 → "×12". */
export function formatStackCount(n: number): string {
  if (!Number.isFinite(n)) return '×0';
  return `×${Math.round(n)}`;
}

/** Compact premium formatter: 4_234_000 → "$4.2M", 890_000 → "$890K". */
export function formatStackPremium(n: number): string {
  if (!Number.isFinite(n)) return '-';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1_000_000_000).toFixed(1)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

/** "3m ago" / "42m ago" / "2h ago" — short relative time for leaderboard. */
export function formatTimeAgo(iso: string): string {
  try {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '-';
    const diffMs = Date.now() - t;
    const sec = Math.max(0, Math.round(diffMs / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const d = Math.round(hr / 24);
    return `${d}d ago`;
  } catch {
    return '-';
  }
}
