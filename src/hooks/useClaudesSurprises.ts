/**
 * useClaudesSurprises — pull the 30-day graded calls where Claude's claimed
 * odds diverged most from reality.
 *
 * calibration_delta convention (from ct_grades + ct_pre_bell_grader):
 *   - Large POSITIVE = Claude claimed low odds but it hit → underconfident win
 *   - Large NEGATIVE = Claude claimed high odds but it missed → overconfident miss
 *
 * We split the top 20 by |calibration_delta| into two lists:
 *   biggest_misses: verdict = 'wrong' AND calibration_delta < 0 (sorted by delta asc)
 *   biggest_wins:   verdict = 'right' AND calibration_delta > 0 (sorted by delta desc)
 *
 * This hook also surfaces a "big delta" threshold (|delta| >= 30) used by
 * the net-calibration-bias header stat on /scorecard. The threshold is
 * derived from the delta scale we actually see in ct_grades — deltas are
 * expressed in percentage-point space (0..100), so 30pp is a clear "Claude
 * was meaningfully off" bar without being so strict it empties in sparse data.
 *
 * Read-only. No mutations. 5-minute refresh.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/** Threshold (in percentage points, since calibration_delta is odds_pp-space)
 *  above which we count a grade as a "big" over/underconfidence event for
 *  the net-bias ratio. */
export const BIG_CALIBRATION_DELTA = 30;

export interface SurpriseGrade {
  id: string;
  subject_type: 'flag' | 'alert' | 'james_view';
  subject_id: string;
  instrument: string;
  claimed_direction: string;
  claimed_odds_up: number | null;
  claimed_odds_down: number | null;
  actual_direction: string;
  actual_return_pct: number;
  verdict: 'right' | 'wrong' | 'ambiguous' | 'partial';
  calibration_delta: number;
  graded_at: string;
}

export interface ClaudesSurprises {
  biggest_misses: SurpriseGrade[];
  biggest_wins: SurpriseGrade[];
  /** Count in last 30d where calibration_delta <= -BIG (claimed high, missed). */
  overconfident_count: number;
  /** Count in last 30d where calibration_delta >= +BIG (claimed low, hit). */
  underconfident_count: number;
  /** Total graded rows in the 30d window with non-null delta (denominator). */
  sample: number;
}

const TOP_N_PER_COLUMN = 10;
const DAYS_BACK = 30;

export function useClaudesSurprises() {
  return useQuery<ClaudesSurprises>({
    queryKey: ['ct_claudes_surprises', DAYS_BACK],
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<ClaudesSurprises> => {
      const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000).toISOString();

      // Pull the last-30d graded rows with non-null calibration_delta. We keep
      // the fetch modest (500) — the split + sort happens client-side so we
      // can apply |delta| ordering without a view.
      const { data, error } = await supabase
        .from('ct_grades')
        .select(
          'id, subject_type, subject_id, instrument, claimed_direction, claimed_odds_up, claimed_odds_down, actual_direction, actual_return_pct, verdict, calibration_delta, graded_at'
        )
        .gte('graded_at', since)
        .not('calibration_delta', 'is', null)
        .order('graded_at', { ascending: false })
        .limit(500);

      if (error) {
        // Don't throw — scorecard should degrade gracefully.
        return {
          biggest_misses: [],
          biggest_wins: [],
          overconfident_count: 0,
          underconfident_count: 0,
          sample: 0,
        };
      }

      const rows = ((data ?? []) as SurpriseGrade[]).filter(
        (r) => r.calibration_delta != null
      );

      // Tie-break convention: when two rows share the same |calibration_delta|,
      // the more recent grade wins (graded_at desc). This matches intuition —
      // "fresher evidence of miscalibration" ranks higher — and keeps the
      // panel kinetic rather than frozen on a single old outlier.
      const byMostRecent = (a: SurpriseGrade, b: SurpriseGrade) =>
        new Date(b.graded_at).getTime() - new Date(a.graded_at).getTime();

      const misses = rows
        .filter((r) => r.verdict === 'wrong' && (r.calibration_delta ?? 0) < 0)
        .sort((a, b) => {
          // Most negative first (biggest overconfidence).
          const da = a.calibration_delta ?? 0;
          const db = b.calibration_delta ?? 0;
          if (da !== db) return da - db;
          return byMostRecent(a, b);
        })
        .slice(0, TOP_N_PER_COLUMN);

      const wins = rows
        .filter((r) => r.verdict === 'right' && (r.calibration_delta ?? 0) > 0)
        .sort((a, b) => {
          // Most positive first (biggest underconfidence).
          const da = a.calibration_delta ?? 0;
          const db = b.calibration_delta ?? 0;
          if (da !== db) return db - da;
          return byMostRecent(a, b);
        })
        .slice(0, TOP_N_PER_COLUMN);

      // Net-bias counts: use |delta| >= BIG across ALL verdicts, because
      // over/underconfidence shows up in partial and ambiguous grades too.
      // Sign of delta is what splits the two counts.
      let overconfident_count = 0;
      let underconfident_count = 0;
      for (const r of rows) {
        const d = r.calibration_delta ?? 0;
        if (d <= -BIG_CALIBRATION_DELTA) overconfident_count += 1;
        else if (d >= BIG_CALIBRATION_DELTA) underconfident_count += 1;
      }

      return {
        biggest_misses: misses,
        biggest_wins: wins,
        overconfident_count,
        underconfident_count,
        sample: rows.length,
      };
    },
  });
}
