/**
 * usePromptAbTest — "did each prompt version actually make things better?"
 *
 * Every ct_flag, ct_alert, and ct_heartbeat carries a `prompt_version` tag at
 * write time. We group by that tag and compute a per-version scorecard by
 * joining flags/alerts to ct_grades (subject_type + subject_id).
 *
 * Metrics per version:
 *   - sample count (graded + ungraded claims)
 *   - graded count (claims that have a ct_grades row)
 *   - hit/partial/wrong rate (graded share)
 *   - calibration gap — avg |claimed_odds - actual_hit_rate|, 0pp = calibrated
 *   - alerts per day — total alerts in version window / days in window
 *   - demotion rate — % of alert attempts in this version that were demoted
 *     to FLAG or OBSERVATION (parsed from ct_heartbeats.status_line)
 *   - band accuracy — % of graded claims with expected_move where
 *     low_pct <= actual_return_pct <= high_pct (v1.3+ only)
 *
 * Results are sorted chronologically by earliest use (version first seen).
 *
 * Sparse handling: versions with < 5 claims are marked `insufficient = true`
 * so callers can label them and skip them in deltas. 5-minute refresh —
 * prompt-level aggregates don't move faster than grades land.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

/** Minimum samples to treat a version as "comparable" in deltas.
 *  Below this we still render the column but label it "insufficient". */
export const PROMPT_AB_MIN_SAMPLES = 5;

/** Threshold below which we show a "directional, not stat-sig" disclaimer. */
export const PROMPT_AB_STAT_SIG_THRESHOLD = 30;

export interface PromptVersionStats {
  version: string;
  /** Earliest created_at across this version's flags/alerts. */
  first_seen: string | null;
  /** Latest created_at across this version's flags/alerts. */
  last_seen: string | null;
  /** Total flags + alerts tagged with this version (graded or not). */
  samples: number;
  /** Subset of samples that have a ct_grades row. */
  graded: number;
  right: number;
  partial: number;
  wrong: number;
  ambiguous: number;
  /** right / (right + partial + wrong). Ambiguous excluded. */
  hit_rate: number | null;
  partial_rate: number | null;
  wrong_rate: number | null;
  /**
   * Calibration gap: average |claimed_odds - actual_hit_rate|, in pp.
   * claimed_odds = up_case_odds when claimed_direction='bullish',
   *                down_case_odds when 'bearish'.
   * actual_hit_rate is the version's overall hit_rate. So a version claiming
   * 70% odds that actually hits 55% has gap = 15pp. Null if no graded claims
   * with odds.
   */
  calibration_gap_pp: number | null;
  /** Alerts per calendar day across the version window (ceil(days)). */
  alerts_per_day: number | null;
  /** Total alert attempts seen in heartbeats for this version. */
  alert_attempts: number;
  /** Count of heartbeats where status_line contained 'ALERT demoted to'. */
  demotions: number;
  /** demotions / alert_attempts. Null if no attempts. */
  demotion_rate: number | null;
  /** Claims in this version with an expected_move payload. */
  banded_claims: number;
  /** Graded banded claims where actual_return_pct fell inside the band. */
  band_hits: number;
  /** band_hits / banded_graded_claims. Null if no banded graded claims. */
  band_accuracy: number | null;
  banded_graded_claims: number;
  /** samples < PROMPT_AB_MIN_SAMPLES. UI should skip delta math. */
  insufficient: boolean;
  /** samples < PROMPT_AB_STAT_SIG_THRESHOLD. UI should flag "directional". */
  below_stat_sig: boolean;
}

type FlagRow = {
  id: string;
  direction: string | null;
  up_case_odds: number | null;
  down_case_odds: number | null;
  prompt_version: string | null;
  expected_move: { low_pct?: number; high_pct?: number } | null;
  created_at: string;
};

type AlertRow = FlagRow;

type GradeRow = {
  subject_type: string;
  subject_id: string;
  verdict: string;
  actual_return_pct: number | null;
};

type HeartbeatRow = {
  prompt_version: string | null;
  status_line: string | null;
};

interface Aggregate {
  version: string;
  first_seen: string | null;
  last_seen: string | null;
  samples: number;
  graded: number;
  right: number;
  partial: number;
  wrong: number;
  ambiguous: number;
  /** Sum of claimed_odds (as 0-1 share) over graded non-ambiguous claims. */
  claimed_odds_sum: number;
  claimed_odds_n: number;
  alerts: number;
  alert_attempts: number;
  demotions: number;
  banded_claims: number;
  banded_graded_claims: number;
  band_hits: number;
}

function emptyAgg(version: string): Aggregate {
  return {
    version,
    first_seen: null,
    last_seen: null,
    samples: 0,
    graded: 0,
    right: 0,
    partial: 0,
    wrong: 0,
    ambiguous: 0,
    claimed_odds_sum: 0,
    claimed_odds_n: 0,
    alerts: 0,
    alert_attempts: 0,
    demotions: 0,
    banded_claims: 0,
    banded_graded_claims: 0,
    band_hits: 0,
  };
}

function touch(agg: Aggregate, when: string): void {
  if (!agg.first_seen || when < agg.first_seen) agg.first_seen = when;
  if (!agg.last_seen || when > agg.last_seen) agg.last_seen = when;
}

/** claimed odds in 0-1 share for the claimed direction. */
function claimedOddsShare(row: FlagRow): number | null {
  const dir = (row.direction ?? '').toLowerCase();
  let raw: number | null = null;
  if (dir === 'bullish') raw = row.up_case_odds;
  else if (dir === 'bearish') raw = row.down_case_odds;
  else {
    // neutral / volatility — use max(up, down) as the "called" side
    const u = row.up_case_odds ?? 0;
    const d = row.down_case_odds ?? 0;
    raw = Math.max(u, d) || null;
  }
  if (raw == null) return null;
  // odds may be stored as 0-1 or 0-100; normalize.
  return raw > 1 ? raw / 100 : raw;
}

function bandContains(
  em: { low_pct?: number; high_pct?: number } | null,
  actualPct: number | null,
): boolean {
  if (!em || actualPct == null) return false;
  const lo = em.low_pct;
  const hi = em.high_pct;
  if (typeof lo !== 'number' || typeof hi !== 'number') return false;
  const [lower, upper] = lo <= hi ? [lo, hi] : [hi, lo];
  return actualPct >= lower && actualPct <= upper;
}

export function usePromptAbTest() {
  return useQuery<PromptVersionStats[]>({
    queryKey: ['ct_prompt_ab_test'],
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<PromptVersionStats[]> => {
      const [flagsRes, alertsRes, gradesRes, heartbeatsRes] = await Promise.all([
        supabase
          .from('ct_flags')
          .select('id, direction, up_case_odds, down_case_odds, prompt_version, expected_move, created_at')
          .limit(10000),
        supabase
          .from('ct_alerts')
          .select('id, direction, up_case_odds, down_case_odds, prompt_version, expected_move, created_at')
          .limit(10000),
        supabase
          .from('ct_grades')
          .select('subject_type, subject_id, verdict, actual_return_pct')
          .in('subject_type', ['flag', 'alert'])
          .limit(10000),
        supabase
          .from('ct_heartbeats')
          .select('prompt_version, status_line')
          .limit(20000),
      ]);

      const flags = (flagsRes.data ?? []) as FlagRow[];
      const alerts = (alertsRes.data ?? []) as AlertRow[];
      const grades = (gradesRes.data ?? []) as GradeRow[];
      const heartbeats = (heartbeatsRes.data ?? []) as HeartbeatRow[];

      // Index grades by (subject_type, subject_id).
      const gradeByFlag = new Map<string, GradeRow>();
      const gradeByAlert = new Map<string, GradeRow>();
      for (const g of grades) {
        if (g.subject_type === 'flag') gradeByFlag.set(g.subject_id, g);
        else if (g.subject_type === 'alert') gradeByAlert.set(g.subject_id, g);
      }

      const aggs = new Map<string, Aggregate>();
      const getAgg = (v: string) => {
        let a = aggs.get(v);
        if (!a) {
          a = emptyAgg(v);
          aggs.set(v, a);
        }
        return a;
      };

      const processClaim = (
        row: FlagRow,
        grade: GradeRow | undefined,
        isAlert: boolean,
      ) => {
        const v = row.prompt_version || 'v1';
        const a = getAgg(v);
        a.samples += 1;
        if (isAlert) a.alerts += 1;
        touch(a, row.created_at);

        const hasBand = !!row.expected_move && typeof row.expected_move === 'object';
        if (hasBand) a.banded_claims += 1;

        if (grade) {
          a.graded += 1;
          if (grade.verdict === 'right') a.right += 1;
          else if (grade.verdict === 'partial') a.partial += 1;
          else if (grade.verdict === 'wrong') a.wrong += 1;
          else if (grade.verdict === 'ambiguous') a.ambiguous += 1;

          if (grade.verdict !== 'ambiguous') {
            const share = claimedOddsShare(row);
            if (share != null) {
              a.claimed_odds_sum += share;
              a.claimed_odds_n += 1;
            }
          }

          if (hasBand) {
            a.banded_graded_claims += 1;
            if (bandContains(row.expected_move, grade.actual_return_pct)) {
              a.band_hits += 1;
            }
          }
        }
      };

      for (const f of flags) processClaim(f, gradeByFlag.get(f.id), false);
      for (const a of alerts) processClaim(a, gradeByAlert.get(a.id), true);

      // Heartbeat demotion parsing. Format written by ct-watcher wave 10:
      //   "ALERT demoted to FLAG: <id> (cooldown) ..."
      //   "ALERT demoted to OBSERVATION: <id> (cooldown) ..."
      //   "ALERT written: <id> ..." (the non-demoted case)
      // Both "ALERT written" and "ALERT demoted" count as alert attempts.
      for (const hb of heartbeats) {
        const v = hb.prompt_version || 'v1';
        const line = hb.status_line ?? '';
        const isAttempt = line.startsWith('ALERT ');
        if (!isAttempt) continue;
        const a = getAgg(v);
        a.alert_attempts += 1;
        if (line.includes('demoted')) a.demotions += 1;
      }

      const finalize = (a: Aggregate): PromptVersionStats => {
        const decided = a.right + a.partial + a.wrong;
        const hit_rate = decided > 0 ? a.right / decided : null;
        const partial_rate = decided > 0 ? a.partial / decided : null;
        const wrong_rate = decided > 0 ? a.wrong / decided : null;

        let calibration_gap_pp: number | null = null;
        if (a.claimed_odds_n > 0 && hit_rate != null) {
          const avgClaimed = a.claimed_odds_sum / a.claimed_odds_n;
          calibration_gap_pp = Math.abs(avgClaimed - hit_rate) * 100;
        }

        let alerts_per_day: number | null = null;
        if (a.first_seen && a.last_seen && a.alerts > 0) {
          const ms = new Date(a.last_seen).getTime() - new Date(a.first_seen).getTime();
          const days = Math.max(1, Math.ceil(ms / (24 * 3600 * 1000)));
          alerts_per_day = a.alerts / days;
        }

        const demotion_rate = a.alert_attempts > 0 ? a.demotions / a.alert_attempts : null;
        const band_accuracy = a.banded_graded_claims > 0 ? a.band_hits / a.banded_graded_claims : null;

        return {
          version: a.version,
          first_seen: a.first_seen,
          last_seen: a.last_seen,
          samples: a.samples,
          graded: a.graded,
          right: a.right,
          partial: a.partial,
          wrong: a.wrong,
          ambiguous: a.ambiguous,
          hit_rate,
          partial_rate,
          wrong_rate,
          calibration_gap_pp,
          alerts_per_day,
          alert_attempts: a.alert_attempts,
          demotions: a.demotions,
          demotion_rate,
          banded_claims: a.banded_claims,
          banded_graded_claims: a.banded_graded_claims,
          band_hits: a.band_hits,
          band_accuracy,
          insufficient: a.samples < PROMPT_AB_MIN_SAMPLES,
          below_stat_sig: a.samples < PROMPT_AB_STAT_SIG_THRESHOLD,
        };
      };

      // Sort: chronological by first_seen (earliest first). Unseen (null) last.
      return Array.from(aggs.values())
        .map(finalize)
        .sort((x, y) => {
          if (!x.first_seen && !y.first_seen) return x.version.localeCompare(y.version);
          if (!x.first_seen) return 1;
          if (!y.first_seen) return -1;
          return x.first_seen.localeCompare(y.first_seen);
        });
    },
  });
}
