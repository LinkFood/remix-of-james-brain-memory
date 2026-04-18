/**
 * useFreshness — derive freshness tier + display string from a timestamp.
 *
 * Reads the shared FreshnessClock tick (1 Hz) so every chip in the tree
 * re-evaluates on the same heartbeat instead of spinning its own interval.
 *
 * Returns:
 *   - age_sec: seconds since the timestamp (null if timestamp is null/invalid)
 *   - tier: 'fresh' | 'aging' | 'stale' | 'unknown'
 *   - display: short "3s ago" / "2m ago" / "12m ago" / "—" label
 */
import { useMemo } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { useFreshnessClock } from '@/components/FreshnessClock';

export type FreshnessTier = 'fresh' | 'aging' | 'stale' | 'unknown';

export interface FreshnessThresholds {
  /** max age (sec) to be considered fresh (green). Default 60. */
  fresh: number;
  /** max age (sec) to be considered aging (amber). Default 300. */
  aging: number;
  /** anything older than `aging` is stale (red). Kept for symmetry / future use. */
  stale?: number;
}

export interface FreshnessResult {
  age_sec: number | null;
  tier: FreshnessTier;
  display: string;
}

export const DEFAULT_THRESHOLDS: FreshnessThresholds = {
  fresh: 60,
  aging: 300,
  stale: Infinity,
};

function parseTimestamp(ts: Date | string | number | null | undefined): number | null {
  if (ts == null) return null;
  if (ts instanceof Date) return Number.isFinite(ts.getTime()) ? ts.getTime() : null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAge(sec: number): string {
  if (sec < 1) return 'just now';
  if (sec < 60) return `${Math.floor(sec)}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Pull the last successful `dataUpdatedAt` for an existing React Query cache
 * entry. Useful for panels whose hook doesn't expose a domain timestamp —
 * the last successful refetch is a truthful "last pulled" anchor. Returns
 * null when the query hasn't fetched yet. The shared FreshnessClock tick is
 * what re-reads this; the function itself is pure so it's safe to call
 * inside a normal component render.
 */
export function useQueryFreshness(queryKey: QueryKey): number | null {
  const qc = useQueryClient();
  // Read inside render so a FreshnessClock tick causes a re-read. We don't
  // subscribe because the clock handles liveness; on-demand lookups keep
  // the overhead at "one Map.get per tick per chip".
  useFreshnessClock();
  const state = qc.getQueryState(queryKey);
  return state?.dataUpdatedAt ?? null;
}

export function useFreshness(
  timestamp: Date | string | number | null | undefined,
  thresholds: FreshnessThresholds = DEFAULT_THRESHOLDS,
): FreshnessResult {
  const now = useFreshnessClock();

  return useMemo(() => {
    const ts = parseTimestamp(timestamp);
    if (ts == null) {
      return { age_sec: null, tier: 'unknown', display: '—' };
    }
    const age_sec = Math.max(0, (now - ts) / 1000);
    const tier: FreshnessTier =
      age_sec <= thresholds.fresh
        ? 'fresh'
        : age_sec <= thresholds.aging
        ? 'aging'
        : 'stale';
    return { age_sec, tier, display: formatAge(age_sec) };
  }, [timestamp, now, thresholds.fresh, thresholds.aging]);
}
