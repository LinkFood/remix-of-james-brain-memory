/**
 * useHypothesisScorecard — per-thesis scorecard (win rate, Elo, calibration).
 *
 * One row per ct_hypothesis, pre-aggregated server-side by the
 * ct_hypothesis_scorecard() RPC. Cheaper than fetching raw ct_grades and
 * rolling up on the client.
 *
 * Rows arrive sorted by elo DESC, created_at DESC.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface HypothesisScorecardRow {
  hypothesis_id: string;
  claim: string;
  status: 'open' | 'supported' | 'refuted' | 'zombie' | 'retired';
  confidence: number;
  elo: number;
  tickers: string[];
  horizon: 'session' | 'week' | 'month' | 'open';
  total_grades: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  avg_return_pct: number | null;
  last_grade_at: string | null;
  calibration_delta: number | null;
}

export function useHypothesisScorecard() {
  return useQuery<HypothesisScorecardRow[]>({
    queryKey: ['ct_hypothesis_scorecard'],
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any).rpc('ct_hypothesis_scorecard');
      if (error) {
        console.error('[useHypothesisScorecard] rpc error', error);
        return [];
      }
      return (data ?? []) as HypothesisScorecardRow[];
    },
  });
}
