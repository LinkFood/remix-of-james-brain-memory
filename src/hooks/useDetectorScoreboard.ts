/**
 * useDetectorScoreboard — reads ct_detector_scoreboard latest snapshot per
 * detector + ct_detector_lifecycle_state for stability streak / proposed flip
 * countdown.
 *
 * Cron: ct-detector-scoreboard-update fires every 30 min RTH / hourly off-hours.
 * UI refetches every 30s during page open. Read-only — purely a window into
 * the lifecycle state machine.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type DetectorStatus = 'shadow' | 'trial' | 'live' | 'decay' | 'retired';

export interface DetectorScoreboardRow {
  detector_id: string;
  current_status: DetectorStatus;
  proposed_status: DetectorStatus;
  proposed_streak: number;
  n_total: number;
  n_graded: number;
  hit_rate_7d: number | null;
  hit_rate_30d: number | null;
  current_streak: number;
  computed_at: string;
  last_flip_at: string | null;
  last_flip_from: string | null;
  last_flip_to: string | null;
}

interface RawScoreboard {
  detector_id: string;
  current_status: DetectorStatus;
  proposed_status: DetectorStatus;
  n_total: number;
  n_graded: number;
  hit_rate_7d: number | null;
  hit_rate_30d: number | null;
  current_streak: number;
  computed_at: string;
}

interface RawLifecycleState {
  detector_id: string;
  proposed_status: DetectorStatus | null;
  proposed_streak: number;
  last_flip_at: string | null;
  last_flip_from: string | null;
  last_flip_to: string | null;
}

export const STABILITY_K = 4;

export function useDetectorScoreboard() {
  return useQuery<DetectorScoreboardRow[]>({
    queryKey: ['ct_detector_scoreboard_latest'],
    queryFn: async () => {
      // Get the most recent snapshot per detector_id. Two-step query because
      // the table is append-only (one row per cron run); we want the latest
      // row per detector.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: snapshots, error: scbErr } = await (supabase
        .from('ct_detector_scoreboard' as never) as any)
        .select('detector_id, current_status, proposed_status, n_total, n_graded, hit_rate_7d, hit_rate_30d, current_streak, computed_at')
        .order('computed_at', { ascending: false })
        .limit(500);
      if (scbErr) throw scbErr;

      const rows = (snapshots ?? []) as RawScoreboard[];
      const latestPerDetector = new Map<string, RawScoreboard>();
      for (const r of rows) {
        if (!latestPerDetector.has(r.detector_id)) latestPerDetector.set(r.detector_id, r);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: stateData, error: stErr } = await (supabase
        .from('ct_detector_lifecycle_state' as never) as any)
        .select('detector_id, proposed_status, proposed_streak, last_flip_at, last_flip_from, last_flip_to');
      if (stErr) throw stErr;
      const stateMap = new Map<string, RawLifecycleState>();
      for (const s of (stateData ?? []) as RawLifecycleState[]) {
        stateMap.set(s.detector_id, s);
      }

      const merged: DetectorScoreboardRow[] = [];
      for (const [detId, snap] of latestPerDetector.entries()) {
        const state = stateMap.get(detId);
        merged.push({
          detector_id: detId,
          current_status: snap.current_status,
          proposed_status: snap.proposed_status,
          proposed_streak: state?.proposed_streak ?? 0,
          n_total: snap.n_total,
          n_graded: snap.n_graded,
          hit_rate_7d: snap.hit_rate_7d,
          hit_rate_30d: snap.hit_rate_30d,
          current_streak: snap.current_streak,
          computed_at: snap.computed_at,
          last_flip_at: state?.last_flip_at ?? null,
          last_flip_from: state?.last_flip_from ?? null,
          last_flip_to: state?.last_flip_to ?? null,
        });
      }

      // Sort: pending flips first (current != proposed), then by hit_rate_30d desc
      merged.sort((a, b) => {
        const aPend = a.current_status !== a.proposed_status ? 1 : 0;
        const bPend = b.current_status !== b.proposed_status ? 1 : 0;
        if (aPend !== bPend) return bPend - aPend;
        return (b.hit_rate_30d ?? 0) - (a.hit_rate_30d ?? 0);
      });

      return merged;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}
