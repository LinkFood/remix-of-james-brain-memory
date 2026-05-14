/**
 * useSpecialistScoreboard — reads the latest per-specialist row from
 * ct_specialist_scoreboard.
 *
 * Truth source: nightly cron (ct-specialist-scoreboard-update, 23:00 UTC weekdays).
 * Each row is one specialist's outcome stats over the trailing 7d, derived from
 * ct_contract_tracks.track_status (not flag volume).
 *
 * Ship 5 (2026-05-14): switched from "MAX(snap_date) globally" to "latest row
 * per specialist." The prior shape silently hid specialists missing from the
 * most-recent snap (verified pre-ship: 2026-05-14 snap had 7/10 tickers;
 * MSFT/AMZN/META rendered as — even though they had rows on prior snaps).
 * We pull the trailing 14d window and reduce to the most-recent row per
 * specialist_name client-side. 10 specialists × <=14 snaps = trivial payload.
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

const LOOKBACK_DAYS = 14;

function isoNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function useSpecialistScoreboard() {
  return useQuery<SpecialistScoreboardRow[]>({
    queryKey: ['ct_specialist_scoreboard_latest_per_ticker'],
    queryFn: async () => {
      const since = isoNDaysAgo(LOOKBACK_DAYS);
      const { data, error } = await supabase
        .from('ct_specialist_scoreboard' as never)
        .select(
          'specialist_name, snap_date, flags_total, flags_with_track, wins, losses, flat, hit_rate, median_peak_pct, expected_peak_pct, top_pick',
        )
        .gte('snap_date', since)
        .order('snap_date', { ascending: false });
      if (error) throw error;

      // Reduce to one row per specialist (latest snap_date wins).
      const latestByName = new Map<string, SpecialistScoreboardRow>();
      for (const r of (data ?? []) as unknown as SpecialistScoreboardRow[]) {
        if (!latestByName.has(r.specialist_name)) {
          latestByName.set(r.specialist_name, r);
        }
      }
      const out = Array.from(latestByName.values());
      out.sort((a, b) => {
        if (a.hit_rate == null && b.hit_rate == null) return 0;
        if (a.hit_rate == null) return 1;
        if (b.hit_rate == null) return -1;
        return b.hit_rate - a.hit_rate;
      });
      return out;
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });
}
