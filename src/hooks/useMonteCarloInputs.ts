/**
 * useMonteCarloInputs — builds the weighted R-distribution + starting equity
 * that the Monte Carlo panel needs.
 *
 * Data source: `useRiskMetrics(all)` — already pulls ct_book + ct_trades +
 * R histogram. We reuse that cache so the panel doesn't fire its own query.
 *
 * Sparse-data defaults: if < MIN_TRADES closed trades with R-values exist,
 * we flag `usingDefaults = true` and return a rough book: 50% hit rate,
 * R ∈ {-1, +1.5} evenly weighted. The panel surfaces this so the user
 * knows they're looking at an ansatz, not a fit.
 *
 * Starting equity: the panel is asking "from here, what happens next?"
 * so we pull the most recent ending_balance from ct_book. Falls back to
 * $10k (the book's seed) if the book is empty.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useRiskMetrics } from './useRiskMetrics';
import type { CtBookRow } from './useCoTraderData';
import type { RWeighted } from '@/lib/monteCarlo';

const MIN_TRADES_FOR_FIT = 10;
const SEED_EQUITY = 10_000;

/** Rough defaults when trade history is too thin to trust. */
const DEFAULT_DISTRIBUTION: RWeighted[] = [
  { r: -1, weight: 0.5 },
  { r: 1.5, weight: 0.5 },
];

export interface MonteCarloInputs {
  startingEquity: number;
  winRate: number;               // 0..1
  rDistribution: RWeighted[];
  tradesWithR: number;           // how many closed trades backed the fit
  usingDefaults: boolean;
  defaultReason: string | null;  // populated when usingDefaults = true
  isLoading: boolean;
}

export function useMonteCarloInputs(): MonteCarloInputs {
  // Tap the same cache RiskMetricsPanel uses — no duplicate network call.
  const { metrics, isLoading: metricsLoading } = useRiskMetrics('all');

  // Current book equity — most recent session's ending balance (or
  // starting + realized + unrealized if the session hasn't closed).
  const { data: latestBook, isLoading: bookLoading } = useQuery<CtBookRow | null>({
    queryKey: ['mc_latest_book_row'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_book')
        .select('*')
        .order('session_date', { ascending: false })
        .limit(1);
      if (error) throw error;
      const row = (data ?? [])[0] ?? null;
      return row as CtBookRow | null;
    },
  });

  return useMemo<MonteCarloInputs>(() => {
    const startingEquity = (() => {
      if (!latestBook) return SEED_EQUITY;
      if (latestBook.ending_balance != null) return latestBook.ending_balance;
      return (
        latestBook.starting_balance +
        (latestBook.realized_pnl ?? 0) +
        (latestBook.unrealized_pnl ?? 0)
      );
    })();

    const tradesWithR = metrics?.sampleSize.tradesWithR ?? 0;
    const winRateFit = metrics?.expectancy.winRate ?? NaN;

    if (!metrics || tradesWithR < MIN_TRADES_FOR_FIT) {
      return {
        startingEquity,
        winRate: 0.5,
        rDistribution: DEFAULT_DISTRIBUTION,
        tradesWithR,
        usingDefaults: true,
        defaultReason: `insufficient history (${tradesWithR} closed trades with stops) — using rough defaults (hit rate 50%, R ∈ [-1, +1.5])`,
        isLoading: metricsLoading || bookLoading,
      };
    }

    // Build weights from the R-multiple histogram. The bucket's
    // representative R is used as-is (already -3, -2, -1, 0, 1, 2, 3, 4
    // in the rMultipleDistribution helper). Empty buckets drop out
    // since `buildSampler` filters weight=0.
    const rDistribution: RWeighted[] = metrics.rHistogram
      .filter(b => b.count > 0)
      .map(b => ({ r: b.r, weight: b.count }));

    // Defensive — if the histogram collapsed to one sign only, flag
    // defaults. A 0-win or 0-loss book will sim to guaranteed-profit
    // or guaranteed-ruin, which is never actually what we want to show.
    const hasWin = rDistribution.some(b => b.r > 0);
    const hasLoss = rDistribution.some(b => b.r < 0);
    if (!hasWin || !hasLoss) {
      return {
        startingEquity,
        winRate: 0.5,
        rDistribution: DEFAULT_DISTRIBUTION,
        tradesWithR,
        usingDefaults: true,
        defaultReason: `history is one-sided (${hasWin ? 'no losses' : 'no wins'}) — using rough defaults so the sim isn't degenerate`,
        isLoading: metricsLoading || bookLoading,
      };
    }

    return {
      startingEquity,
      winRate: Number.isFinite(winRateFit) ? winRateFit : 0.5,
      rDistribution,
      tradesWithR,
      usingDefaults: false,
      defaultReason: null,
      isLoading: metricsLoading || bookLoading,
    };
  }, [metrics, latestBook, metricsLoading, bookLoading]);
}
