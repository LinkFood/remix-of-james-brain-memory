/**
 * useRegimeTransitions — surfaces ct_regime_history flips that have been
 * silently logged but never rendered.
 *
 * Phase 6 of the audit-driven loop (2026-05-09). Per fusion ground-truth
 * audit Section E #3: /pulse shows current regime + sparkline only.
 * Transition timestamps + prior→next + trigger annotations (rationale
 * jsonb) have no UI surface today.
 *
 * Calls get_regime_transitions RPC (migration 20260510080000) which uses
 * a LAG window function to detect classification flips per (ticker OR
 * market-wide) sequence.
 *
 * Default: 72h lookback, 50-row cap, market-wide row INCLUDED. Refetch
 * every 2 min — regime classifier writes every 15 min so 2 min surfaces
 * fresh flips quickly.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface RegimeTransition {
  id: number;
  ticker: string | null;
  bucket_ts: string;
  prior_classification: string;
  classification: string;
  confidence: number;
  momentum: number | null;
  breadth: number | null;
  trajectory: string | null;
  duration_minutes: number | null;
  rationale: Record<string, unknown> | null;
  rich_text: string | null;
}

interface UseRegimeTransitionsArgs {
  lookbackHours?: number;
  tickers?: string[] | null;
  limit?: number;
  includeMarketWide?: boolean;
}

interface RawRow {
  id: number;
  ticker: string | null;
  bucket_ts: string;
  prior_classification: string;
  classification: string;
  confidence: number | string;
  momentum: number | string | null;
  breadth: number | string | null;
  trajectory: string | null;
  duration_minutes: number | null;
  rationale: Record<string, unknown> | null;
  rich_text: string | null;
}

function toRow(r: RawRow): RegimeTransition {
  return {
    id: r.id,
    ticker: r.ticker,
    bucket_ts: r.bucket_ts,
    prior_classification: r.prior_classification,
    classification: r.classification,
    confidence: Number(r.confidence),
    momentum: r.momentum == null ? null : Number(r.momentum),
    breadth: r.breadth == null ? null : Number(r.breadth),
    trajectory: r.trajectory,
    duration_minutes: r.duration_minutes,
    rationale: r.rationale,
    rich_text: r.rich_text,
  };
}

export function useRegimeTransitions(args: UseRegimeTransitionsArgs = {}) {
  const lookbackHours = Math.max(1, Math.min(720, args.lookbackHours ?? 72));
  const limit = Math.max(1, Math.min(200, args.limit ?? 50));
  const includeMarketWide = args.includeMarketWide ?? true;
  const tickers = args.tickers ?? null;

  const query = useQuery<RegimeTransition[]>({
    queryKey: ['regime-transitions', { lookbackHours, limit, includeMarketWide, tickers }],
    refetchInterval: 2 * 60_000,
    staleTime: 100_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      const { data, error } = await sb.rpc('get_regime_transitions', {
        p_lookback_hours: lookbackHours,
        p_tickers: tickers,
        p_limit: limit,
        p_include_market_wide: includeMarketWide,
      });
      if (error) throw error;
      return Array.isArray(data) ? (data as RawRow[]).map(toRow) : [];
    },
  });

  const transitions = query.data ?? [];

  // Group consecutive same-bucket flips (regime synchronization across
  // tickers) so the UI can render "9 tickers flipped together at HH:MM"
  // as one event rather than 9 rows.
  const grouped: Array<{ bucket_ts: string; classification: string; rows: RegimeTransition[] }> = [];
  for (const t of transitions) {
    const last = grouped[grouped.length - 1];
    if (
      last &&
      last.bucket_ts === t.bucket_ts &&
      last.classification === t.classification
    ) {
      last.rows.push(t);
    } else {
      grouped.push({ bucket_ts: t.bucket_ts, classification: t.classification, rows: [t] });
    }
  }

  return {
    transitions,
    grouped,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
