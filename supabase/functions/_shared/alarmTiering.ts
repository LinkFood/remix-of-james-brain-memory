/**
 * alarmTiering — shared tier evaluator and scoring helpers used by
 * ct-signature-watcher (live alarm) and ct-backtest-harness (replay/calibration).
 *
 * The whole point of pulling this out: BOTH callers must apply the SAME
 * gold/silver/bronze logic. If they drift, replay metrics lie and live trades
 * miss what the harness predicted. Single source of truth = single tuning lever.
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export type AlarmTier = 'gold' | 'silver' | 'bronze' | null;

export interface TierThresholds {
  goldMinScore: number;
  goldMinPeakPct: number;
  goldMinN: number;
  silverMinScore: number;
  silverMinPeakPct: number;
  silverMinN: number;
  silverHighSigPeakPct: number;
  silverHighSigMinN: number;
  bronzeMinPeakPct: number;
  bronzeMinN: number;
  bronzeMinScore: number;
  // Sweep-level (not per-tier).
  lookbackDays: number;
  dedupeMin: number;
  // RPC must use the LOWEST n threshold or bronze candidates get pre-filtered.
  rpcMinN: number;
}

export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  goldMinScore: 80,
  goldMinPeakPct: 1.0,
  goldMinN: 10,
  silverMinScore: 70,
  silverMinPeakPct: 0.50,
  silverMinN: 5,
  silverHighSigPeakPct: 2.0,
  silverHighSigMinN: 10,
  bronzeMinPeakPct: 0.50,
  bronzeMinN: 3,
  bronzeMinScore: 80,
  lookbackDays: 7,
  dedupeMin: 30,
  rpcMinN: 3,
};

/**
 * Pure tier evaluator. Order matters: gold → silver → bronze. Each tier's
 * full predicate is checked before falling through.
 */
export function evaluateTier(
  score: number | null,
  sigMedian: number | null,
  sigN: number | null,
  t: TierThresholds,
): AlarmTier {
  const s = score ?? 0;
  const sp = sigMedian ?? 0;
  const sn = sigN ?? 0;
  // Gold: BOTH layers strong.
  if (s >= t.goldMinScore && sp >= t.goldMinPeakPct && sn >= t.goldMinN) return 'gold';
  // Silver: combined high-confidence OR signature-alone exceptional.
  if (s >= t.silverMinScore && sp >= t.silverMinPeakPct && sn >= t.silverMinN) return 'silver';
  if (sp >= t.silverHighSigPeakPct && sn >= t.silverHighSigMinN) return 'silver';
  // Bronze: weakest tier — either layer alone clears a lower bar.
  if (sp >= t.bronzeMinPeakPct && sn >= t.bronzeMinN) return 'bronze';
  if (s >= t.bronzeMinScore) return 'bronze';
  return null;
}

/**
 * Returns a finer-grained reason a tier eval returned null. Used by the
 * backtest harness to label "why_missed" on top_missed_winners.
 */
export function whyNoTier(
  score: number | null,
  sigMedian: number | null,
  sigN: number | null,
  t: TierThresholds,
): string {
  const hasSig = sigMedian != null && sigN != null && sigN > 0;
  const s = score ?? 0;
  if (!hasSig && s < t.bronzeMinScore) return 'no_signature_match_and_score_below_bronze';
  if (!hasSig) return 'no_signature_match';
  if (s < t.bronzeMinScore && (sigMedian ?? 0) < t.bronzeMinPeakPct) return 'sig_and_score_below_bronze';
  if ((sigMedian ?? 0) < t.bronzeMinPeakPct) return 'sig_peak_below_bronze_floor';
  if ((sigN ?? 0) < t.bronzeMinN) return 'sig_n_below_bronze_floor';
  if (s < t.bronzeMinScore) return 'score_below_bronze_floor';
  return 'tier_eval_returned_null';
}

/**
 * Loads tier thresholds from ct_config, layering optional overrides on top
 * of defaults. Mirrors the DB-key naming used by ct-signature-watcher.
 */
export async function loadTierThresholds(
  supabase: SupabaseClient,
  overrides?: Partial<TierThresholds>,
): Promise<TierThresholds> {
  const defaults = { ...DEFAULT_TIER_THRESHOLDS };
  const { data, error } = await supabase
    .from('ct_config')
    .select('key, value')
    .in('key', [
      'signature_alarm_gold_min_score',
      'signature_alarm_gold_min_peak_pct',
      'signature_alarm_gold_min_n',
      'signature_alarm_silver_min_score',
      'signature_alarm_silver_min_peak_pct',
      'signature_alarm_silver_min_n',
      'signature_alarm_silver_high_sig_peak_pct',
      'signature_alarm_silver_high_sig_min_n',
      'signature_alarm_bronze_min_peak_pct',
      'signature_alarm_bronze_min_n',
      'signature_alarm_bronze_min_score',
      'signature_alarm_lookback_days',
      'signature_alarm_dedupe_min',
    ]);
  const out = { ...defaults };
  if (!error && data) {
    for (const row of data) {
      const v = row.value;
      const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v) : NaN;
      if (!Number.isFinite(n) || n < 0) continue;
      switch (row.key) {
        case 'signature_alarm_gold_min_score':           out.goldMinScore = n; break;
        case 'signature_alarm_gold_min_peak_pct':        out.goldMinPeakPct = n; break;
        case 'signature_alarm_gold_min_n':               out.goldMinN = Math.floor(n); break;
        case 'signature_alarm_silver_min_score':         out.silverMinScore = n; break;
        case 'signature_alarm_silver_min_peak_pct':      out.silverMinPeakPct = n; break;
        case 'signature_alarm_silver_min_n':             out.silverMinN = Math.floor(n); break;
        case 'signature_alarm_silver_high_sig_peak_pct': out.silverHighSigPeakPct = n; break;
        case 'signature_alarm_silver_high_sig_min_n':    out.silverHighSigMinN = Math.floor(n); break;
        case 'signature_alarm_bronze_min_peak_pct':      out.bronzeMinPeakPct = n; break;
        case 'signature_alarm_bronze_min_n':             out.bronzeMinN = Math.floor(n); break;
        case 'signature_alarm_bronze_min_score':         out.bronzeMinScore = n; break;
        case 'signature_alarm_lookback_days':            out.lookbackDays = Math.floor(n); break;
        case 'signature_alarm_dedupe_min':               out.dedupeMin = Math.floor(n); break;
      }
    }
  }
  // Apply caller overrides last — body params win over DB config.
  if (overrides) {
    for (const k of Object.keys(overrides) as (keyof TierThresholds)[]) {
      const v = overrides[k];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
        (out as unknown as Record<string, number>)[k] = v;
      }
    }
  }
  // RPC fetch must use the LOWEST n threshold any tier could fire on.
  out.rpcMinN = Math.max(1, Math.min(out.bronzeMinN, out.silverMinN, out.goldMinN));
  return out;
}

/**
 * Looks up the per-alert flow score from ct_scored_flow. Returns null if no
 * matching scored row exists — bronze can still fire on signature alone.
 */
export async function loadScoreForAlert(
  supabase: SupabaseClient,
  alertId: string,
): Promise<number | null> {
  const { data: scored } = await supabase
    .from('ct_scored_flow')
    .select('score')
    .eq('source_table', 'ct_flow_alerts')
    .eq('source_id', alertId)
    .order('event_ts', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (scored && Number.isFinite(Number(scored.score))) return Number(scored.score);
  return null;
}

/**
 * Looks up the per-alert flow score AND the ct_scored_flow.id (BIGINT) for the
 * matching row. Used by ct-signature-watcher to wire ct_flags.source_flow_ids
 * (BIGINT[] of ct_scored_flow.id values — Ship 9b).
 *
 * Returns both score and scoredFlowId as null if no matching scored row exists,
 * which is normal for fresh alerts that bronze fires on (score-only path is
 * impossible without a scored row, but signature-only is — sourceFlowId will
 * be null in that case and ct_flags.source_flow_ids stays null).
 */
export async function loadScoreAndIdForAlert(
  supabase: SupabaseClient,
  alertId: string,
): Promise<{ score: number | null; scoredFlowId: number | null }> {
  const { data: scored } = await supabase
    .from('ct_scored_flow')
    .select('id, score')
    .eq('source_table', 'ct_flow_alerts')
    .eq('source_id', alertId)
    .order('event_ts', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!scored) return { score: null, scoredFlowId: null };
  const score = Number.isFinite(Number(scored.score)) ? Number(scored.score) : null;
  const scoredFlowId = typeof scored.id === 'number'
    ? scored.id
    : (Number.isFinite(Number(scored.id)) ? Number(scored.id) : null);
  return { score, scoredFlowId };
}

/**
 * Bulk score lookup — single RPC-style query keyed by alert_id list. Avoids
 * N+1 round-trips when the harness evaluates 1,000+ alerts in a window.
 * Paginates internally so an oversized id list doesn't get truncated.
 */
export async function loadScoresBulk(
  supabase: SupabaseClient,
  alertIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (alertIds.length === 0) return out;
  const CHUNK = 200; // PostgREST IN-list practical ceiling.
  for (let i = 0; i < alertIds.length; i += CHUNK) {
    const chunk = alertIds.slice(i, i + CHUNK);
    const { data } = await supabase
      .from('ct_scored_flow')
      .select('source_id, score, event_ts')
      .eq('source_table', 'ct_flow_alerts')
      .in('source_id', chunk)
      .order('event_ts', { ascending: false });
    if (!data) continue;
    // Latest event_ts wins per source_id (already sorted DESC).
    for (const r of data) {
      const id = r.source_id as string;
      if (out.has(id)) continue;
      const n = Number(r.score);
      if (Number.isFinite(n)) out.set(id, n);
    }
  }
  return out;
}
