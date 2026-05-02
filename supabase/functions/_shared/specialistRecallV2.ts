/**
 * specialistRecallV2 — read-side joins onto Specialist Scoreboard v2.
 *
 * Extracted from specialistRecallContext.ts to keep the recall organ under
 * the 400-line ceiling. Schemas come from migration
 *   20260502040200_specialist_v2_schemas.sql
 * which adds:
 *   ct_specialist_scoreboard_v2          — per (specialist × regime × window)
 *   ct_specialist_conviction_calibration — per-specialist + '__ALL__' cross
 *   ct_specialist_prompt_lifecycle       — per-prompt-version lifecycle
 *
 * Fail-soft policy: every query is wrapped so that table-empty / null /
 * query-error returns undefined for that field rather than throwing. The
 * recall organ surfaces meta.warning='v2_enrichment_empty' when a ticker
 * was scoped but no v2 data was found anywhere — operator-visible without
 * taking down the recall organ.
 *
 * Tenet 16: per-specialist calibration N-floor lives in ct_config under
 *   specialist.conviction.per_specialist_min_n (default 30).
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { getConfig } from './configCache.ts';

// ---------------------------------------------------------------------------
// Public types — mirrored on RecallStats fields in specialistRecallContext.ts
// ---------------------------------------------------------------------------

export const CONVICTION_BUCKETS = ['0-20', '20-40', '40-60', '60-80', '80-100'] as const;
export type ConvictionBucket = typeof CONVICTION_BUCKETS[number];

export interface MultiAxisStats {
  hit_rate_premium: number | null;
  hit_rate_underlying_4h: number | null;
  hit_rate_underlying_1d: number | null;
  hit_rate_underlying_3d: number | null;
  hit_rate_blended: number | null;
  n_total: number;
  n_graded: number;
  read_streak_signed: number;
  graded_streak_signed: number;
  drift_slope_7d: number | null;
}

export interface RegimeConditionalRow {
  regime: string;
  hit_rate_blended: number | null;
  n_graded: number;
}

export interface ConvictionCurveRow {
  bucket: ConvictionBucket;
  hit_rate: number | null;
  n: number;
  is_per_specialist: boolean;
}

export interface LifecycleRow {
  prompt_version: string;
  status: 'shadow' | 'trial' | 'live' | 'decay' | 'retired';
  hit_rate_current: number | null;
}

export interface V2EnrichmentResult {
  multi_axis_stats?: MultiAxisStats;
  regime_conditional?: RegimeConditionalRow[];
  conviction_calibration_curve?: ConvictionCurveRow[];
  lifecycle?: LifecycleRow;
  /** "v2_enrichment_empty" if ticker was scoped but no v2 data found anywhere. */
  warning?: string;
}

// ---------------------------------------------------------------------------
// Internal raw-row types
// ---------------------------------------------------------------------------

interface V2ScoreboardRow {
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
  read_streak_signed: number;
  graded_streak_signed: number;
  drift_slope_7d: number | null;
}

interface V2CalibrationRow {
  specialist_ticker: string;
  conviction_bucket: ConvictionBucket;
  window_label: string;
  hit_rate: number | null;
  n: number;
}

interface V2LifecycleRow {
  specialist_ticker: string;
  prompt_version: string;
  status: 'shadow' | 'trial' | 'live' | 'decay' | 'retired';
  hit_rate_current: number | null;
}

const REGIME_COND_LIMIT = 5;
const PER_SPECIALIST_MIN_N_DEFAULT = 30;
const SCOREBOARD_COLS =
  'specialist_ticker, regime, window_label, hit_rate_premium, hit_rate_underlying_4h, hit_rate_underlying_1d, hit_rate_underlying_3d, hit_rate_blended, n_total, n_graded, read_streak_signed, graded_streak_signed, drift_slope_7d';

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

function toMultiAxis(row: V2ScoreboardRow | null): MultiAxisStats | undefined {
  if (!row) return undefined;
  return {
    hit_rate_premium: row.hit_rate_premium == null ? null : Number(row.hit_rate_premium),
    hit_rate_underlying_4h: row.hit_rate_underlying_4h == null ? null : Number(row.hit_rate_underlying_4h),
    hit_rate_underlying_1d: row.hit_rate_underlying_1d == null ? null : Number(row.hit_rate_underlying_1d),
    hit_rate_underlying_3d: row.hit_rate_underlying_3d == null ? null : Number(row.hit_rate_underlying_3d),
    hit_rate_blended: row.hit_rate_blended == null ? null : Number(row.hit_rate_blended),
    n_total: Number(row.n_total ?? 0),
    n_graded: Number(row.n_graded ?? 0),
    read_streak_signed: Number(row.read_streak_signed ?? 0),
    graded_streak_signed: Number(row.graded_streak_signed ?? 0),
    drift_slope_7d: row.drift_slope_7d == null ? null : Number(row.drift_slope_7d),
  };
}

/**
 * Per-bucket conviction curve. For each of the 5 buckets:
 *   - Use the per-specialist row when n ≥ minN (config-driven, default 30).
 *   - Otherwise fall back to the cross-specialist '__ALL__' row.
 *   - is_per_specialist flags which source was used.
 * Buckets with neither source available are omitted.
 */
function buildCalibrationCurve(
  perSpecialist: V2CalibrationRow[],
  crossSpecialist: V2CalibrationRow[],
  minN: number,
): ConvictionCurveRow[] {
  const perByBucket = new Map<string, V2CalibrationRow>();
  for (const r of perSpecialist) perByBucket.set(r.conviction_bucket, r);
  const crossByBucket = new Map<string, V2CalibrationRow>();
  for (const r of crossSpecialist) crossByBucket.set(r.conviction_bucket, r);

  const curve: ConvictionCurveRow[] = [];
  for (const bucket of CONVICTION_BUCKETS) {
    const per = perByBucket.get(bucket);
    const cross = crossByBucket.get(bucket);
    if (per && Number(per.n ?? 0) >= minN) {
      curve.push({
        bucket,
        hit_rate: per.hit_rate == null ? null : Number(per.hit_rate),
        n: Number(per.n ?? 0),
        is_per_specialist: true,
      });
      continue;
    }
    if (cross) {
      curve.push({
        bucket,
        hit_rate: cross.hit_rate == null ? null : Number(cross.hit_rate),
        n: Number(cross.n ?? 0),
        is_per_specialist: false,
      });
    }
    // Both missing → omit. Don't fabricate empty buckets.
  }
  return curve;
}

// ---------------------------------------------------------------------------
// fetchV2Enrichment — 4 fan-out queries, all best-effort
// ---------------------------------------------------------------------------

/**
 * Multi-axis stats + regime-conditional + conviction calibration + lifecycle
 * for a single specialist_ticker. Best-effort: a single failed/missing
 * source does not blank the rest. Returns undefined fields where the source
 * is empty and `warning='v2_enrichment_empty'` when nothing populated.
 */
export async function fetchV2Enrichment(
  supabase: SupabaseClient,
  ticker: string,
): Promise<V2EnrichmentResult> {
  // Resolve config once. Cached 60s by configCache; fail-soft on the default.
  let minN = PER_SPECIALIST_MIN_N_DEFAULT;
  try {
    const v = await getConfig<number>(
      'specialist.conviction.per_specialist_min_n',
      PER_SPECIALIST_MIN_N_DEFAULT,
    );
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) minN = v;
  } catch (_) {
    // ignore — keep default
  }

  const unconditionalQ = supabase
    .from('ct_specialist_scoreboard_v2')
    .select(SCOREBOARD_COLS)
    .eq('specialist_ticker', ticker)
    .eq('regime', 'all')
    .eq('window_label', 'lifetime')
    .maybeSingle();

  const regimeQ = supabase
    .from('ct_specialist_scoreboard_v2')
    .select(SCOREBOARD_COLS)
    .eq('specialist_ticker', ticker)
    .eq('window_label', 'lifetime')
    .neq('regime', 'all')
    .order('n_graded', { ascending: false })
    .limit(REGIME_COND_LIMIT);

  // Single round-trip for both '__ALL__' and per-specialist calibration rows.
  // PostgREST `.in()` keeps it to one HTTP request.
  const calibrationQ = supabase
    .from('ct_specialist_conviction_calibration')
    .select('specialist_ticker, conviction_bucket, window_label, hit_rate, n')
    .in('specialist_ticker', [ticker, '__ALL__'])
    .eq('window_label', 'lifetime');

  const lifecycleQ = supabase
    .from('ct_specialist_prompt_lifecycle')
    .select('specialist_ticker, prompt_version, status, hit_rate_current')
    .eq('specialist_ticker', ticker)
    .eq('status', 'live')
    .order('last_run_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const [uncondR, regimeR, calibR, lifecycleR] = await Promise.allSettled([
    unconditionalQ,
    regimeQ,
    calibrationQ,
    lifecycleQ,
  ]);

  const out: V2EnrichmentResult = {};
  let anyData = false;

  if (uncondR.status === 'fulfilled' && !uncondR.value.error) {
    const row = (uncondR.value.data ?? null) as V2ScoreboardRow | null;
    const ma = toMultiAxis(row);
    if (ma) {
      out.multi_axis_stats = ma;
      anyData = true;
    }
  }

  if (regimeR.status === 'fulfilled' && !regimeR.value.error) {
    const rows = (regimeR.value.data ?? []) as V2ScoreboardRow[];
    if (rows.length > 0) {
      out.regime_conditional = rows.map((r) => ({
        regime: r.regime,
        hit_rate_blended: r.hit_rate_blended == null ? null : Number(r.hit_rate_blended),
        n_graded: Number(r.n_graded ?? 0),
      }));
      anyData = true;
    }
  }

  if (calibR.status === 'fulfilled' && !calibR.value.error) {
    const rows = (calibR.value.data ?? []) as V2CalibrationRow[];
    if (rows.length > 0) {
      const per = rows.filter((r) => r.specialist_ticker === ticker);
      const cross = rows.filter((r) => r.specialist_ticker === '__ALL__');
      const curve = buildCalibrationCurve(per, cross, minN);
      if (curve.length > 0) {
        out.conviction_calibration_curve = curve;
        anyData = true;
      }
    }
  }

  if (lifecycleR.status === 'fulfilled' && !lifecycleR.value.error) {
    const row = (lifecycleR.value.data ?? null) as V2LifecycleRow | null;
    if (row) {
      out.lifecycle = {
        prompt_version: row.prompt_version,
        status: row.status,
        hit_rate_current: row.hit_rate_current == null ? null : Number(row.hit_rate_current),
      };
      anyData = true;
    }
  }

  if (!anyData) {
    out.warning = 'v2_enrichment_empty';
  }
  return out;
}
