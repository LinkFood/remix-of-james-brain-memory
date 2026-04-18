/**
 * useAlertPostMortems — forensic autopsies on wrong alerts / flags.
 *
 * Written by ct-alert-post-mortem every 30 min (or on-demand from ct-grader).
 * Each row names the exact signal that was missed, the weakest evidence axis,
 * the implicated bias, the lesson, and Claude's confidence that the lesson
 * generalizes. This hook exposes:
 *
 *   - rows: last 20 post-mortems (descending created_at)
 *   - axisCounts: [{ axis: 'A', count: 14 }, ...] — "axis A has 14 cites"
 *     reveals which evidence axis is systematically the false signal.
 *   - total: total rows considered for axisCounts (last 100)
 *   - misremembered: count in recent set where Claude cited an axis the
 *     alert didn't actually include (sanity metric)
 *
 * Refetches every 60s to match Scorecard cadence.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type PostMortemAxis = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
const AXIS_LETTERS: PostMortemAxis[] = ['A', 'B', 'C', 'D', 'E', 'F'];

export interface AlertPostMortem {
  id: string;
  alert_id: string;
  alert_kind: 'alert' | 'flag';
  grade_id: string | null;
  what_missed: string;
  weakest_evidence_axis: PostMortemAxis | null;
  bias_implicated: string | null;
  lesson: string;
  confidence_in_lesson: number;
  axis_misremembered: boolean;
  tokens_used: number | null;
  cost_usd: number | null;
  model: string | null;
  created_at: string;
}

export interface AxisCount {
  axis: PostMortemAxis;
  count: number;
}

export interface UseAlertPostMortemsResult {
  rows: AlertPostMortem[];
  axisCounts: AxisCount[];
  total: number;
  misremembered: number;
}

export function useAlertPostMortems() {
  const query = useQuery<{ recent: AlertPostMortem[]; pool: AlertPostMortem[] }>({
    queryKey: ['ct_alert_post_mortems'],
    refetchInterval: 60_000,
    queryFn: async () => {
      // Two reads: the 20 shown in the list, and a 100-row window for
      // the axis rollup. Kept separate so the list is always tight.
      const [recentRes, poolRes] = await Promise.all([
        supabase
          .from('ct_alert_post_mortems')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(20),
        supabase
          .from('ct_alert_post_mortems')
          .select('weakest_evidence_axis, axis_misremembered, created_at')
          .order('created_at', { ascending: false })
          .limit(100),
      ]);
      return {
        recent: (recentRes.data ?? []) as AlertPostMortem[],
        pool: (poolRes.data ?? []) as AlertPostMortem[],
      };
    },
  });

  const derived = useMemo<UseAlertPostMortemsResult>(() => {
    const recent = query.data?.recent ?? [];
    const pool = query.data?.pool ?? [];
    const counts = new Map<PostMortemAxis, number>();
    for (const a of AXIS_LETTERS) counts.set(a, 0);
    let misremembered = 0;
    for (const r of pool) {
      if (r.weakest_evidence_axis && AXIS_LETTERS.includes(r.weakest_evidence_axis)) {
        counts.set(r.weakest_evidence_axis, (counts.get(r.weakest_evidence_axis) ?? 0) + 1);
      }
      if (r.axis_misremembered) misremembered++;
    }
    const axisCounts: AxisCount[] = AXIS_LETTERS.map(axis => ({ axis, count: counts.get(axis) ?? 0 }));
    return { rows: recent, axisCounts, total: pool.length, misremembered };
  }, [query.data]);

  return { ...derived, isLoading: query.isLoading, error: query.error };
}
