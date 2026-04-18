/**
 * useCalibration — "is Claude well-calibrated?"
 *
 * Joins graded ct_flags + ct_alerts to ct_grades and buckets by:
 *   (a) conviction 1-5 (stated by Claude at claim time)
 *   (b) attention_score 0-100 in 20-pt buckets
 *
 * For each bucket: hit_rate = right / (right + partial + wrong).
 * 'ambiguous' is excluded from the denominator so it doesn't suppress the rate.
 *
 * NOTE on per-axis scores ($FLOW / HEDGE / NOW / CALLS / PUTS):
 * Axis scores are computed on-the-fly from UW data at render time — they are
 * NOT stored on ct_flags / ct_alerts at claim time. Reconstructing "what the
 * $FLOW score was when alert X fired" requires either replaying UW history or
 * capturing the 5-axis snapshot onto each flag/alert at write time (out of
 * scope for v1). For now, conviction + attention_score are the proxy.
 *
 * 5-minute refresh — data moves at horizon-close speed, not tick speed.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface CalibrationBucket {
  label: string;
  count: number;
  right: number;
  partial: number;
  wrong: number;
  ambiguous: number;
  hit_rate: number;
  ideal?: number;
  sparse: boolean;
}

export interface CalibrationData {
  conviction: CalibrationBucket[];
  attention: CalibrationBucket[];
  sample: number;
  /** Average (hit_rate - ideal) across populated conviction buckets.
   *  Positive = underconfident (delivers more than claimed).
   *  Negative = overconfident (claims more than delivers). */
  convictionGap: number | null;
}

type GradeRow = {
  subject_type: string;
  subject_id: string;
  verdict: string;
};

type ClaimRow = {
  id: string;
  conviction: number | null;
  attention_score: number | null;
};

const SPARSE_THRESHOLD = 3;

/** Ideal calibration line for conviction. Conv 5 should hit ~90%, conv 1 ~15%. */
const IDEAL_CONVICTION: Record<number, number> = {
  1: 0.15,
  2: 0.35,
  3: 0.55,
  4: 0.75,
  5: 0.9,
};

function emptyBucket(label: string, ideal?: number): CalibrationBucket {
  return {
    label,
    count: 0,
    right: 0,
    partial: 0,
    wrong: 0,
    ambiguous: 0,
    hit_rate: 0,
    ideal,
    sparse: true,
  };
}

function finalize(b: CalibrationBucket): CalibrationBucket {
  const denom = b.right + b.partial + b.wrong;
  b.hit_rate = denom > 0 ? b.right / denom : 0;
  b.sparse = b.count < SPARSE_THRESHOLD;
  return b;
}

function attentionBucketLabel(score: number): string {
  if (score < 20) return '0-20';
  if (score < 40) return '20-40';
  if (score < 60) return '40-60';
  if (score < 80) return '60-80';
  return '80-100';
}

const ATTENTION_LABELS = ['0-20', '20-40', '40-60', '60-80', '80-100'];

export function useCalibration() {
  return useQuery<CalibrationData>({
    queryKey: ['ct_calibration'],
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<CalibrationData> => {
      // Fetch-once: three parallel queries, then join in memory.
      // Only flags/alerts graded by horizon close matter for calibration.
      const [gradesRes, flagsRes, alertsRes] = await Promise.all([
        supabase
          .from('ct_grades')
          .select('subject_type, subject_id, verdict')
          .in('subject_type', ['flag', 'alert'])
          .limit(5000),
        supabase
          .from('ct_flags')
          .select('id, conviction, attention_score')
          .limit(5000),
        supabase
          .from('ct_alerts')
          .select('id, conviction, attention_score')
          .limit(5000),
      ]);

      const grades = (gradesRes.data ?? []) as GradeRow[];
      const flagMap = new Map<string, ClaimRow>();
      for (const r of (flagsRes.data ?? []) as ClaimRow[]) flagMap.set(r.id, r);
      const alertMap = new Map<string, ClaimRow>();
      for (const r of (alertsRes.data ?? []) as ClaimRow[]) alertMap.set(r.id, r);

      const convBuckets = new Map<number, CalibrationBucket>();
      for (let c = 1; c <= 5; c++) {
        convBuckets.set(c, emptyBucket(`conv ${c}`, IDEAL_CONVICTION[c]));
      }

      const attnBuckets = new Map<string, CalibrationBucket>();
      for (const label of ATTENTION_LABELS) {
        attnBuckets.set(label, emptyBucket(label));
      }

      let sample = 0;

      for (const g of grades) {
        const claim =
          g.subject_type === 'flag'
            ? flagMap.get(g.subject_id)
            : g.subject_type === 'alert'
              ? alertMap.get(g.subject_id)
              : undefined;
        if (!claim) continue;

        const verdict = g.verdict;
        const bumpCount = (b: CalibrationBucket) => {
          b.count += 1;
          if (verdict === 'right') b.right += 1;
          else if (verdict === 'partial') b.partial += 1;
          else if (verdict === 'wrong') b.wrong += 1;
          else if (verdict === 'ambiguous') b.ambiguous += 1;
        };

        if (claim.conviction != null) {
          const c = Math.max(1, Math.min(5, Math.round(claim.conviction)));
          const b = convBuckets.get(c);
          if (b) bumpCount(b);
        }

        if (claim.attention_score != null) {
          const label = attentionBucketLabel(claim.attention_score);
          const b = attnBuckets.get(label);
          if (b) bumpCount(b);
        }

        sample += 1;
      }

      const conviction = Array.from(convBuckets.values()).map(finalize);
      const attention = ATTENTION_LABELS.map(
        (label) => finalize(attnBuckets.get(label)!),
      );

      // Calibration gap: average of (hit_rate - ideal) across populated
      // conviction buckets (>= SPARSE_THRESHOLD). Positive = underconfident.
      let gapSum = 0;
      let gapN = 0;
      for (const b of conviction) {
        if (!b.sparse && b.ideal != null) {
          gapSum += b.hit_rate - b.ideal;
          gapN += 1;
        }
      }
      const convictionGap = gapN > 0 ? gapSum / gapN : null;

      return { conviction, attention, sample, convictionGap };
    },
  });
}
