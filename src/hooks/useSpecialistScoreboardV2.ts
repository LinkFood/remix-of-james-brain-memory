/**
 * useSpecialistScoreboardV2 — multi-axis + regime-conditional + conviction
 * calibration + prompt lifecycle for the 10 per-ticker specialists.
 *
 * Truth sources (all updated by ct-specialist-prompt-lifecycle-v2):
 * - ct_specialist_scoreboard_v2 — multi-axis hit rates per (ticker, regime, window).
 *   Brief filters: window_label='lifetime'; regime='all' for unconditional;
 *   regime != 'all' ORDER BY n_graded DESC LIMIT 5 for regime-conditional.
 * - ct_specialist_conviction_calibration — bucketed hit rate by conviction.
 *   Per-specialist when N>=30 in bucket; '__ALL__' fallback otherwise.
 * - ct_specialist_prompt_lifecycle — current live prompt version, K=4 stable
 *   gate, decay/retire flow.
 *
 * Co-exists with v1 useSpecialistScoreboard (live commentary). v1 is the
 * sparkline + 7d hit rate; v2 is the multi-axis scoreboard. Parallel-run
 * discipline per the v2 build brief.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface SpecialistScoreboardV2Row {
  specialist_ticker: string;
  regime: string;
  window_label: string;
  hit_rate_premium: number | null;
  hit_rate_underlying_4h: number | null;
  hit_rate_underlying_1d: number | null;
  hit_rate_underlying_3d: number | null;
  hit_rate_blended: number | null;
  n_total: number;
  n_graded: number;
  n_partial: number;
  read_streak_signed: number;
  graded_streak_signed: number;
  drift_slope_7d: number | null;
  last_updated: string;
  computed_at: string;
}

export interface ConvictionCalibrationRow {
  specialist_ticker: string;
  conviction_bucket: string; // '0-20' | '20-40' | '40-60' | '60-80' | '80-100'
  window_label: string;
  hit_rate: number | null;
  n: number;
}

export interface PromptLifecycleRow {
  specialist_ticker: string;
  prompt_version: string;
  status: string; // 'live' | 'trial' | 'shadow' | 'decay' | 'retired'
  proposed_status: string | null;
  consecutive_stable_runs: number;
  status_changed_at: string;
  hit_rate_current: number | null;
  last_run_at: string | null;
}

export interface SpecialistScoreboardV2Bundle {
  scoreboardAll: SpecialistScoreboardV2Row[];   // window_label='lifetime', regime='all'
  scoreboardRegime: SpecialistScoreboardV2Row[]; // window_label='lifetime', regime!='all'
  calibrationPerSpecialist: ConvictionCalibrationRow[]; // window_label='lifetime', specialist != '__ALL__'
  calibrationBaseline: ConvictionCalibrationRow[]; // window_label='lifetime', specialist='__ALL__'
  lifecycleLive: PromptLifecycleRow[]; // status='live', one per specialist
}

const REFRESH_MS = 5 * 60_000;
const STALE_MS = 60_000;

export function useSpecialistScoreboardV2() {
  return useQuery<SpecialistScoreboardV2Bundle>({
    queryKey: ['ct_specialist_scoreboard_v2_bundle'],
    queryFn: async () => {
      // Fan out — 4 parallel reads. All defensive: empty arrays if RPC hasn't
      // populated for this regime/window yet.
      const [scoreboardRes, calibrationRes, lifecycleRes] = await Promise.all([
        supabase
          .from('ct_specialist_scoreboard_v2' as never)
          .select('specialist_ticker, regime, window_label, hit_rate_premium, hit_rate_underlying_4h, hit_rate_underlying_1d, hit_rate_underlying_3d, hit_rate_blended, n_total, n_graded, n_partial, read_streak_signed, graded_streak_signed, drift_slope_7d, last_updated, computed_at')
          .eq('window_label', 'lifetime'),
        supabase
          .from('ct_specialist_conviction_calibration' as never)
          .select('specialist_ticker, conviction_bucket, window_label, hit_rate, n')
          .eq('window_label', 'lifetime'),
        supabase
          .from('ct_specialist_prompt_lifecycle' as never)
          .select('specialist_ticker, prompt_version, status, proposed_status, consecutive_stable_runs, status_changed_at, hit_rate_current, last_run_at')
          .eq('status', 'live'),
      ]);

      if (scoreboardRes.error) throw scoreboardRes.error;
      if (calibrationRes.error) throw calibrationRes.error;
      if (lifecycleRes.error) throw lifecycleRes.error;

      const scoreboardRows = (scoreboardRes.data ?? []) as unknown as SpecialistScoreboardV2Row[];
      const calibrationRows = (calibrationRes.data ?? []) as unknown as ConvictionCalibrationRow[];
      const lifecycleRows = (lifecycleRes.data ?? []) as unknown as PromptLifecycleRow[];

      return {
        scoreboardAll: scoreboardRows.filter((r) => r.regime === 'all'),
        scoreboardRegime: scoreboardRows.filter((r) => r.regime !== 'all'),
        calibrationPerSpecialist: calibrationRows.filter((r) => r.specialist_ticker !== '__ALL__'),
        calibrationBaseline: calibrationRows.filter((r) => r.specialist_ticker === '__ALL__'),
        lifecycleLive: lifecycleRows,
      };
    },
    refetchInterval: REFRESH_MS,
    staleTime: STALE_MS,
  });
}

// --- Helpers consumed by the Specialists tile ---

export const CONVICTION_BUCKETS = ['0-20', '20-40', '40-60', '60-80', '80-100'] as const;
export type ConvictionBucket = typeof CONVICTION_BUCKETS[number];

export interface ConvictionBucketView {
  bucket: ConvictionBucket;
  hitRate: number | null;
  n: number;
  source: 'specialist' | 'baseline' | 'empty';
}

/** Build the 5-bucket conviction view for one ticker, falling back per-bucket. */
export function buildConvictionView(
  ticker: string,
  perSpecialist: ConvictionCalibrationRow[],
  baseline: ConvictionCalibrationRow[],
  minPerSpecialistN = 30,
): ConvictionBucketView[] {
  return CONVICTION_BUCKETS.map((bucket) => {
    const own = perSpecialist.find(
      (r) => r.specialist_ticker === ticker && r.conviction_bucket === bucket,
    );
    if (own && own.n >= minPerSpecialistN && own.hit_rate != null) {
      return { bucket, hitRate: own.hit_rate, n: own.n, source: 'specialist' as const };
    }
    const all = baseline.find((r) => r.conviction_bucket === bucket);
    if (all && all.hit_rate != null) {
      return { bucket, hitRate: all.hit_rate, n: all.n, source: 'baseline' as const };
    }
    return { bucket, hitRate: null, n: 0, source: 'empty' as const };
  });
}

/** Top-N regimes for a ticker by n_graded, excluding regime='all'. */
export function topRegimes(
  ticker: string,
  scoreboardRegime: SpecialistScoreboardV2Row[],
  limit = 5,
): SpecialistScoreboardV2Row[] {
  return scoreboardRegime
    .filter((r) => r.specialist_ticker === ticker && r.window_label === 'lifetime')
    .sort((a, b) => b.n_graded - a.n_graded)
    .slice(0, limit);
}
