/**
 * useSpecialistScoreboard — reads the latest ct_specialist_scoreboard snap.
 *
 * Truth source: nightly cron (ct-specialist-scoreboard-update, 23:00 UTC weekdays).
 * Each row is one specialist's outcome stats over the trailing 7d, derived from
 * ct_contract_tracks.track_status (not flag volume).
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface SpecialistScoreboardRow {
  specialist_name: string;
  snap_date: string;
  flags_total: number;
  flags_with_track: number;
  wins: number;
  losses: number;
  flat: number;
  hit_rate: number | null;
  median_peak_pct: number | null;
  expected_peak_pct: number | null;
  top_pick: string | null;
}

export function useSpecialistScoreboard() {
  return useQuery<SpecialistScoreboardRow[]>({
    queryKey: ['ct_specialist_scoreboard_latest'],
    queryFn: async () => {
      // Two-step so we always read the most recent snap_date even if today's
      // cron hasn't fired yet (e.g. mid-day before 23:00 UTC).
      const { data: latest, error: latestErr } = await supabase
        .from('ct_specialist_scoreboard' as never)
        .select('snap_date')
        .order('snap_date', { ascending: false })
        .limit(1);
      if (latestErr) throw latestErr;
      const snapDate = (latest as unknown as { snap_date: string }[])?.[0]?.snap_date;
      if (!snapDate) return [];

      const { data, error } = await supabase
        .from('ct_specialist_scoreboard' as never)
        .select('specialist_name, snap_date, flags_total, flags_with_track, wins, losses, flat, hit_rate, median_peak_pct, expected_peak_pct, top_pick')
        .eq('snap_date', snapDate)
        .order('hit_rate', { ascending: false, nullsFirst: false });
      if (error) throw error;
      return (data ?? []) as unknown as SpecialistScoreboardRow[];
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}
