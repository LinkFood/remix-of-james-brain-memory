/**
 * useHourlyPerformance — "is Claude sharper at any particular hour?"
 *
 * Builds on wave 24's regime-conditional slices but drills finer than the
 * open/midday/close session cuts. Buckets graded flag+alert outcomes into
 * 13 half-hour ET windows across the regular session (09:30 → 15:59 open,
 * grouped into 13 half-hour labels starting at 09:30 and ending at 15:30).
 *
 *   09:30 · 10:00 · 10:30 · 11:00 · 11:30 · 12:00 · 12:30 ·
 *   13:00 · 13:30 · 14:00 · 14:30 · 15:00 · 15:30
 *
 * Each bucket is a 30-minute window starting at its label (e.g. 10:30 =
 * 10:30-10:59 ET). Labels express the START of the bucket. A claim at
 * 10:29 ET lands in 10:00; a claim at 10:30 ET lands in 10:30.
 *
 * Bucketing is ET-aware — we use Intl.DateTimeFormat with
 * timeZone='America/New_York' and parse the hour+minute out of the
 * formatted string. This is correct through DST transitions (unlike a
 * fixed UTC offset, which drifts ±1h twice a year and is the exact thing
 * we want to avoid because market open time in UTC shifts with DST).
 *
 * Per bucket we report:
 *   - count        — total graded rows landing in the bucket
 *   - wins         — verdict='right'
 *   - winRate      — right / (right + partial + wrong); 'ambiguous' excluded
 *   - avgReturnPct — mean actual_return_pct across all rows in the bucket
 *   - avgR         — mean R-multiple (null when no banded claims survive)
 *   - alertsTotal  — total alerts+flags *created* in the bucket (not just
 *                    graded). Reveals firing-rate per hour, so the UI can
 *                    show whether Claude fires a lot in weak hours.
 *   - insufficient — count < SPARSE_THRESHOLD (3). UI renders muted.
 *   - edgeFlag     — 'red' | 'green' | null (see thresholds below)
 *
 * Edge flags (cross-check step 3 of the task):
 *   - 'red'   — count >= EDGE_MIN_SAMPLE (10) AND winRate < 0.40
 *               → "consider avoiding this window"
 *   - 'green' — count >= EDGE_MIN_SAMPLE (10) AND winRate > 0.65
 *               → "edge window"
 *
 * Sharpest / deadest are picked from buckets with count >= SPARSE_THRESHOLD,
 * breaking ties by count (more samples = more trustworthy). If no bucket
 * clears the sparse bar, both fields are null and the UI shows only the
 * multiple-testing caveat in the footer.
 *
 * R-multiple definition matches useRegimeConditionalPerformance:
 *   R = actual_return_pct / (|high_pct - low_pct| / 2)
 *   Skip when expected_move is missing or half-band <= 0.
 *
 * 5-minute refresh to match the rest of the scorecard rhythm. Client-side
 * aggregation only — no new RPCs.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ─── public types ────────────────────────────────────────────────────────────

export type HourBucketLabel =
  | '09:30'
  | '10:00'
  | '10:30'
  | '11:00'
  | '11:30'
  | '12:00'
  | '12:30'
  | '13:00'
  | '13:30'
  | '14:00'
  | '14:30'
  | '15:00'
  | '15:30';

export interface HourBucket {
  label: HourBucketLabel;
  count: number;            // graded rows in bucket
  wins: number;             // verdict='right'
  winRate: number;          // right / (right + partial + wrong)
  avgReturnPct: number;     // mean actual_return_pct
  avgR: number | null;      // mean R (null when no banded rows)
  rSample: number;          // rows contributing to avgR
  alertsTotal: number;      // alerts+flags created in bucket (pre-grading)
  insufficient: boolean;    // count < SPARSE_THRESHOLD
  edgeFlag: 'red' | 'green' | null; // count >= EDGE_MIN_SAMPLE gates
}

export interface HourlyPerformance {
  buckets: HourBucket[];           // always 13, in chronological order
  sample: number;                  // sum of bucket.count (graded)
  alertsSample: number;            // sum of bucket.alertsTotal
  overallWinRate: number;          // baseline across all 13 buckets
  sharpest: HourBucket | null;     // highest winRate w/ count >= SPARSE_THRESHOLD
  deadest: HourBucket | null;      // lowest winRate w/ count >= SPARSE_THRESHOLD
  dataThin: boolean;               // sample < MIN_SAMPLE_FOR_CLAIMS
  dataThinNote: string | null;
}

// ─── tuning knobs ────────────────────────────────────────────────────────────

const DAYS_BACK = 30;
const SPARSE_THRESHOLD = 3;       // below this: render muted "insufficient"
const EDGE_MIN_SAMPLE = 10;       // red/green flag requires >= 10 rows
const EDGE_RED_MAX = 0.40;        // winRate strictly below -> red flag
const EDGE_GREEN_MIN = 0.65;      // winRate strictly above -> green flag
const MIN_SAMPLE_FOR_CLAIMS = 15; // headline/"sharpest" trustworthy if >= 15
const CLAIM_LIMIT = 1000;

const BUCKET_LABELS: HourBucketLabel[] = [
  '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '13:00', '13:30', '14:00', '14:30', '15:00', '15:30',
];

// ─── row shapes ──────────────────────────────────────────────────────────────

interface GradeRow {
  id: string;
  subject_type: 'flag' | 'alert';
  subject_id: string;
  verdict: 'right' | 'wrong' | 'partial' | 'ambiguous';
  actual_return_pct: number | null;
  graded_at: string;
}

interface ClaimRow {
  id: string;
  created_at: string;
  expected_move: { low_pct?: number; high_pct?: number } | null;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract ET {hour, minute} from an ISO timestamp using Intl.DateTimeFormat.
 *
 * Why Intl and not offset math:
 *   ET is UTC-5 in winter and UTC-4 in summer. Subtracting a fixed offset
 *   would drift by an hour on the DST switch dates (second Sun of March,
 *   first Sun of November). Market open is always 09:30 *local* ET — so
 *   the bucket boundaries must be computed in ET, not in UTC-with-offset.
 *   Intl handles this correctly for every date without a hardcoded DST
 *   calendar.
 *
 * Implementation detail: we use hourCycle='h23' to get 00-23 (not 1-24
 * or 12-hour), and formatToParts so we can grab hour/minute without
 * parsing a localized string.
 */
const ET_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  hourCycle: 'h23',
});

function etParts(iso: string): { hour: number; minute: number; weekday: string } | null {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const parts = ET_FORMATTER.formatToParts(d);
  let hour = NaN;
  let minute = NaN;
  let weekday = '';
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
    else if (p.type === 'weekday') weekday = p.value;
  }
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { hour, minute, weekday };
}

/**
 * Map an ET {hour, minute} into one of 13 half-hour bucket labels.
 * Returns null for pre-market, post-market, or weekend timestamps so the
 * consumer can skip them cleanly.
 *
 * Boundaries (inclusive start, exclusive end):
 *   09:30 = [09:30, 10:00)  ← shortened last row: 15:30 = [15:30, 16:00)
 *   Anything outside [09:30, 16:00) ET or on Sat/Sun returns null.
 */
function bucketFor(iso: string): HourBucketLabel | null {
  const p = etParts(iso);
  if (!p) return null;
  // Skip weekends. en-US short weekday: Sun, Mon, Tue, Wed, Thu, Fri, Sat.
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return null;
  const mins = p.hour * 60 + p.minute;
  const OPEN = 9 * 60 + 30;  // 09:30
  const CLOSE = 16 * 60;     // 16:00
  if (mins < OPEN || mins >= CLOSE) return null;
  // First bucket is 09:30-09:59; after that, half-hour steps anchored on :00/:30.
  if (mins < 10 * 60) return '09:30';
  const fromTen = mins - 10 * 60;           // minutes past 10:00
  const stepIdx = Math.floor(fromTen / 30); // 0..11 covers 10:00 through 15:30
  // stepIdx 0 = 10:00 (index 1 in BUCKET_LABELS). 11 = 15:30 (index 12).
  const labelIdx = 1 + stepIdx;
  return BUCKET_LABELS[labelIdx] ?? null;
}

function rMultipleOf(claim: ClaimRow, actualPct: number): number | null {
  const em = claim.expected_move;
  if (!em) return null;
  const low = Number(em.low_pct);
  const high = Number(em.high_pct);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const halfBand = Math.abs(high - low) / 2;
  if (halfBand <= 0) return null;
  return actualPct / halfBand;
}

function emptyBucket(label: HourBucketLabel): HourBucket {
  return {
    label,
    count: 0,
    wins: 0,
    winRate: 0,
    avgReturnPct: 0,
    avgR: null,
    rSample: 0,
    alertsTotal: 0,
    insufficient: true,
    edgeFlag: null,
  };
}

// ─── main hook ───────────────────────────────────────────────────────────────

export function useHourlyPerformance() {
  return useQuery<HourlyPerformance>({
    queryKey: ['ct_hourly_performance', DAYS_BACK],
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<HourlyPerformance> => {
      const since = new Date(
        Date.now() - DAYS_BACK * 24 * 3600_000,
      ).toISOString();

      const [gradesRes, flagsRes, alertsRes] = await Promise.all([
        supabase
          .from('ct_grades')
          .select('id, subject_type, subject_id, verdict, actual_return_pct, graded_at')
          .in('subject_type', ['flag', 'alert'])
          .gte('graded_at', since)
          .order('graded_at', { ascending: false })
          .limit(CLAIM_LIMIT),
        supabase
          .from('ct_flags')
          .select('id, created_at, expected_move')
          .gte('created_at', since)
          .limit(CLAIM_LIMIT),
        supabase
          .from('ct_alerts')
          .select('id, created_at, expected_move')
          .gte('created_at', since)
          .limit(CLAIM_LIMIT),
      ]);

      const grades = (gradesRes.data ?? []) as GradeRow[];
      const flags = (flagsRes.data ?? []) as ClaimRow[];
      const alerts = (alertsRes.data ?? []) as ClaimRow[];

      // Index claim rows by id for grade → claim join.
      const flagMap = new Map<string, ClaimRow>();
      for (const f of flags) flagMap.set(f.id, f);
      const alertMap = new Map<string, ClaimRow>();
      for (const a of alerts) alertMap.set(a.id, a);

      // Initialize 13 buckets in chronological order.
      const buckets = new Map<HourBucketLabel, HourBucket>();
      for (const lbl of BUCKET_LABELS) buckets.set(lbl, emptyBucket(lbl));

      // ─── alerts-per-hour overlay (all claims, not just graded) ──────────
      // Iterate both ct_flags and ct_alerts — captures firing rate per hour
      // independent of whether the horizon has closed/been graded yet. This
      // is what reveals "Claude fires a lot in weak hours."
      for (const list of [flags, alerts]) {
        for (const c of list) {
          const lbl = bucketFor(c.created_at);
          if (!lbl) continue;
          const b = buckets.get(lbl);
          if (!b) continue;
          b.alertsTotal += 1;
        }
      }

      // ─── graded-grade aggregation ───────────────────────────────────────
      // Accumulate sums in a parallel scratch map so winRate/avgs can be
      // computed after all rows are counted without a second pass.
      const scratch = new Map<
        HourBucketLabel,
        { retSum: number; rSum: number; rN: number; scored: number }
      >();
      for (const lbl of BUCKET_LABELS) {
        scratch.set(lbl, { retSum: 0, rSum: 0, rN: 0, scored: 0 });
      }

      for (const g of grades) {
        const claim =
          g.subject_type === 'flag'
            ? flagMap.get(g.subject_id)
            : alertMap.get(g.subject_id);
        if (!claim) continue;
        if (g.actual_return_pct == null || !Number.isFinite(g.actual_return_pct)) continue;
        const lbl = bucketFor(claim.created_at);
        if (!lbl) continue;

        const b = buckets.get(lbl)!;
        const s = scratch.get(lbl)!;
        b.count += 1;
        s.retSum += g.actual_return_pct;
        if (g.verdict !== 'ambiguous') {
          s.scored += 1;
          if (g.verdict === 'right') b.wins += 1;
        }
        const r = rMultipleOf(claim, g.actual_return_pct);
        if (r != null && Number.isFinite(r)) {
          s.rSum += r;
          s.rN += 1;
        }
      }

      // ─── finalize bucket stats ──────────────────────────────────────────
      const finalized: HourBucket[] = BUCKET_LABELS.map((lbl) => {
        const b = buckets.get(lbl)!;
        const s = scratch.get(lbl)!;
        const winRate = s.scored > 0 ? b.wins / s.scored : 0;
        const avgReturnPct = b.count > 0 ? s.retSum / b.count : 0;
        const avgR = s.rN > 0 ? s.rSum / s.rN : null;
        const insufficient = b.count < SPARSE_THRESHOLD;

        // Edge flags gate on EDGE_MIN_SAMPLE (10), not SPARSE_THRESHOLD (3) —
        // tighter bar for the "avoid this window" / "edge window" callouts.
        let edgeFlag: 'red' | 'green' | null = null;
        if (b.count >= EDGE_MIN_SAMPLE) {
          if (winRate < EDGE_RED_MAX) edgeFlag = 'red';
          else if (winRate > EDGE_GREEN_MIN) edgeFlag = 'green';
        }

        return {
          ...b,
          winRate,
          avgReturnPct,
          avgR,
          rSample: s.rN,
          insufficient,
          edgeFlag,
        };
      });

      // ─── headline + baseline ────────────────────────────────────────────
      const totalGraded = finalized.reduce((acc, b) => acc + b.count, 0);
      const totalAlerts = finalized.reduce((acc, b) => acc + b.alertsTotal, 0);
      const totalWins = finalized.reduce((acc, b) => acc + b.wins, 0);
      const totalScored = finalized.reduce((acc, b, i) => {
        const s = scratch.get(BUCKET_LABELS[i])!;
        return acc + s.scored;
      }, 0);
      const overallWinRate = totalScored > 0 ? totalWins / totalScored : 0;

      // Sharpest / deadest: only from buckets with count >= SPARSE_THRESHOLD.
      // Break ties by higher count (more trustworthy sample).
      const eligible = finalized.filter((b) => !b.insufficient);
      const sharpest = eligible.length === 0
        ? null
        : eligible.reduce((a, b) => {
            if (b.winRate > a.winRate) return b;
            if (b.winRate === a.winRate && b.count > a.count) return b;
            return a;
          });
      const deadest = eligible.length === 0
        ? null
        : eligible.reduce((a, b) => {
            if (b.winRate < a.winRate) return b;
            if (b.winRate === a.winRate && b.count > a.count) return b;
            return a;
          });

      const dataThin = totalGraded < MIN_SAMPLE_FOR_CLAIMS;
      const dataThinNote = dataThin
        ? `Only ${totalGraded} graded claims across 13 half-hour ET buckets — expect most to be sparse. Treat as directional only.`
        : null;

      return {
        buckets: finalized,
        sample: totalGraded,
        alertsSample: totalAlerts,
        overallWinRate,
        sharpest,
        deadest,
        dataThin,
        dataThinNote,
      };
    },
  });
}
