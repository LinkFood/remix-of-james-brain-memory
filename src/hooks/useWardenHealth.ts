import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface WardenFailure {
  name: string;
  category: string;
  severity: 'info' | 'warn' | 'critical';
  last_value: string | null;
  consecutive_fails: number;
  runbook_path: string | null;
  last_run_at: string | null;
}

export interface WardenCategoryStat {
  category: string;
  total: number;
  passing: number;
  failing: number;
  errored: number;
}

export interface WardenHealth {
  window_hours: number;
  totals: {
    total_enabled: number;
    passing: number;
    failing: number;
    errored: number;
    never_ran: number;
    critical_failing: number;
  };
  by_category: WardenCategoryStat[];
  failures: WardenFailure[];
  generated_at: string;
}

export interface WardenLatestRun {
  /** ISO timestamp of the most recent ct_invariant_log row across all invariants. */
  last_run_at: string | null;
}

/**
 * Live read of get_warden_health(24) plus the most-recent log row for "last fired".
 * Refreshes every 30s — Warden cron runs every 30 min, so this stays well ahead of state.
 */
export function useWardenHealth() {
  return useQuery<{ health: WardenHealth; latest: WardenLatestRun } | null>({
    queryKey: ['warden-health'],
    queryFn: async () => {
      const [healthRes, latestRes] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any).rpc('get_warden_health', { window_hours: 24 }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (supabase as any)
          .from('ct_invariant_log')
          .select('ran_at')
          .order('ran_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (healthRes.error) return null;
      const health = healthRes.data as WardenHealth | null;
      if (!health) return null;
      const latest: WardenLatestRun = {
        last_run_at: latestRes.data?.ran_at ?? null,
      };
      return { health, latest };
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

// Compute the next Warden cron fire from cron expression "*/30 * * * *" — round
// up `now` to the next :00 or :30 wall-clock minute (UTC, but minute-of-hour is
// timezone-agnostic).
export function computeNextWardenRun(now: Date = new Date()): Date {
  const next = new Date(now);
  next.setSeconds(0, 0);
  const minute = next.getMinutes();
  if (minute < 30) {
    next.setMinutes(30);
  } else {
    next.setMinutes(0);
    next.setHours(next.getHours() + 1);
  }
  return next;
}
