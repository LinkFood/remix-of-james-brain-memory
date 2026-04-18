/**
 * useBiases — Claude's self-identified structural biases.
 *
 * Reads ct_biases. These are META patterns ("I overweight put flow in
 * low-VIX tape") written weekly by ct-bias-booth (Sunday 22:00 UTC),
 * synthesized from 30d of ct_grades + ct_self_regrades. They are READ
 * on every watcher/morning-brief tick so Claude sees its own blindspots
 * before calling; this hook surfaces them in the UI so James can see
 * them too — and veto (retire) any that feel wrong.
 *
 * Only the sole writer is ct-bias-booth. self-grader writes ct_self_regrades
 * which feeds bias-booth on the next cycle; it does not write biases
 * directly. The evidence column on each bias cites grade IDs / regrade
 * quotes — that's the upstream source trail.
 *
 * Retire action (active=false) is the one write permitted from the UI.
 * Schema has no retired_at / retired_by columns, so veto is best-effort:
 * bias goes inactive and stops being fed to the watcher.
 *
 * 5-min refresh — biases move at weekly cadence, not tick speed.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface Bias {
  id: string;
  pattern: string;
  evidence: string;
  instruments: string[] | null;
  severity: number;
  active: boolean;
  observed_count: number | null;
  first_seen_at: string;
  last_confirmed: string;
  superseded_by: string | null;
  created_at: string;
  /** Derived: days since first_seen_at. */
  age_days: number;
  /** Derived: static label — only ct-bias-booth writes this table.
   *  Upstream feeders are cited in the `evidence` text. */
  source: 'ct-bias-booth';
}

const BIAS_QUERY_KEY = ['ct_biases', 'active'] as const;

function daysSince(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

export function useBiases(limit = 10) {
  return useQuery<Bias[]>({
    queryKey: [...BIAS_QUERY_KEY, limit],
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Bias[]> => {
      const { data, error } = await supabase
        // ct_biases is not in generated types yet — cast through unknown.
        .from('ct_biases' as never)
        .select('id, pattern, evidence, instruments, severity, active, observed_count, first_seen_at, last_confirmed, superseded_by, created_at')
        .eq('active', true)
        .order('severity', { ascending: false })
        .order('last_confirmed', { ascending: false })
        .limit(limit);
      if (error) throw error;
      const rows = (data ?? []) as unknown as Array<Omit<Bias, 'age_days' | 'source'>>;
      return rows.map((r) => ({
        ...r,
        age_days: daysSince(r.first_seen_at),
        source: 'ct-bias-booth' as const,
      }));
    },
  });
}

/**
 * useRetireBias — James's veto. Marks the bias inactive so it stops
 * being injected into the watcher prompt. Schema has no retired_at /
 * retired_by columns; this is pure soft-delete via active=false.
 */
export function useRetireBias() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from('ct_biases' as never)
        .update({ active: false } as never)
        .eq('id', id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: BIAS_QUERY_KEY });
    },
  });
}
