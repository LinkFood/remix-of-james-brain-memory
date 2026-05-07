/**
 * D3 Feature-Isolation Experiment — per-wakeup feature reconstruction.
 *
 * Status: SCAFFOLD ONLY (2026-05-08). Each loader returns the type-correct
 * shape but contains a TODO block instead of the real query. Fill in one
 * loader at a time and verify against a held-out set per brief §4.
 *
 * Brief: scope/2026-05-08-d3-feature-isolation-experiment.md §3 (F1-F8).
 *
 * Cost: ZERO UW calls. All 8 features reconstruct from internal Supabase
 * tables and RPCs. Phase A verified 2026-05-08.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.84.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Wakeup {
  ticker: string;
  wakeup_at: string; // ISO timestamp
  conviction: number;
  read_id: string;
}

export interface FeatureVector {
  // F1 — flow_pulse.is_unusual (boolean)
  f1_flow_pulse_unusual: boolean | null;
  // F2 — flow_heatmap front-week stack value (continuous, signed)
  f2_heatmap_front_week_value: number | null;
  // F3 — regime (positive_gamma / negative_gamma / neutral)
  f3_regime: "positive_gamma" | "negative_gamma" | "neutral" | null;
  // F4 — news count + max severity
  f4_news_count: number;
  f4_news_max_severity: number | null;
  // F5 — event_recency.whatJustHappened non-empty
  f5_event_recency_present: boolean;
  // F6 — signature_alarms recent count
  f6_signature_alarm_count: number;
  // F7 — has_0dte_today (deterministic from ticker + date)
  f7_has_0dte_today: boolean;
  // F8 — last_flag_outcome (WIN/LOSS/EXPIRED_*/none)
  f8_last_flag_outcome: string | null;
}

// ---------------------------------------------------------------------------
// F1 — ct_flow_pulse RPC, p_window_min=360, anchored at wakeup_at - epsilon
// ---------------------------------------------------------------------------

export async function loadF1(
  _supabase: SupabaseClient,
  _wakeup: Wakeup,
): Promise<Pick<FeatureVector, "f1_flow_pulse_unusual">> {
  // TODO: call supabase.rpc('ct_flow_pulse', { p_window_min: 360, p_ticker })
  //       with anchor = wakeup_at - 1 minute. Return is_unusual boolean.
  //       Reconstruction caveat: ct_flow_pulse is a live aggregate; back-dated
  //       anchor required for 14-day window. Validate 24h window first per brief.
  return { f1_flow_pulse_unusual: null };
}

// ---------------------------------------------------------------------------
// F2 — flow_heatmap front-week stack value
// ---------------------------------------------------------------------------

export async function loadF2(
  _supabase: SupabaseClient,
  _wakeup: Wakeup,
): Promise<Pick<FeatureVector, "f2_heatmap_front_week_value">> {
  // TODO: reuse _shared/flowHeatmapContext.ts buildFlowHeatmapContext logic
  //       with anchor = wakeup_at, include_0dte=true. Extract front-week
  //       stack value (sum or signed-net per brief — clarify before fill).
  //       PR #25 (2026-05-06) lifted magic numbers to ct_config.flow_heatmap;
  //       reconstruct using cotrader-mcp default config to match captain frame.
  return { f2_heatmap_front_week_value: null };
}

// ---------------------------------------------------------------------------
// F3 — ct_ticker_snapshots.regime nearest wakeup_at
// ---------------------------------------------------------------------------

export async function loadF3(
  _supabase: SupabaseClient,
  _wakeup: Wakeup,
): Promise<Pick<FeatureVector, "f3_regime">> {
  // TODO: SELECT regime FROM ct_ticker_snapshots
  //       WHERE ticker = X AND captured_at <= wakeup_at
  //       ORDER BY captured_at DESC LIMIT 1
  //       Validate: regime ∈ {positive_gamma, negative_gamma, neutral}.
  //       chop_neutral rule applied 2026-05-04 — confirm column shape.
  return { f3_regime: null };
}

// ---------------------------------------------------------------------------
// F4 — news_causality count + max severity in 6h prior
// ---------------------------------------------------------------------------

export async function loadF4(
  _supabase: SupabaseClient,
  _wakeup: Wakeup,
): Promise<Pick<FeatureVector, "f4_news_count" | "f4_news_max_severity">> {
  // TODO: SELECT count(*), max(severity) FROM news_causality
  //       WHERE tickers @> ARRAY[X] AND published_at BETWEEN wakeup_at - 6h AND wakeup_at
  //       Caveat: news_causality is re-graded periodically (severity may have
  //       drifted since wakeup); cache severity at wakeup time if possible.
  return { f4_news_count: 0, f4_news_max_severity: null };
}

// ---------------------------------------------------------------------------
// F5 — ct_events presence in 72h prior (whatJustHappened proxy)
// ---------------------------------------------------------------------------

export async function loadF5(
  _supabase: SupabaseClient,
  _wakeup: Wakeup,
): Promise<Pick<FeatureVector, "f5_event_recency_present">> {
  // TODO: SELECT 1 FROM ct_events
  //       WHERE ticker = X AND event_at BETWEEN wakeup_at - 72h AND wakeup_at LIMIT 1
  //       Returns boolean: was there a material event in the prior 72h.
  return { f5_event_recency_present: false };
}

// ---------------------------------------------------------------------------
// F6 — ct_signature_alarms count for ticker, 6h prior
// ---------------------------------------------------------------------------

export async function loadF6(
  _supabase: SupabaseClient,
  _wakeup: Wakeup,
): Promise<Pick<FeatureVector, "f6_signature_alarm_count">> {
  // TODO: SELECT count(*) FROM ct_signature_alarms
  //       WHERE ticker = X AND created_at BETWEEN wakeup_at - 6h AND wakeup_at
  //       AND created_at < now() - interval '6 minutes'  -- score-race filter
  //       Filter intent: count alarms with stable score (not zero-mid-window).
  return { f6_signature_alarm_count: 0 };
}

// ---------------------------------------------------------------------------
// F7 — has_0dte_today (deterministic from ticker + wakeup_at::date)
// ---------------------------------------------------------------------------

export function loadF7(wakeup: Wakeup): Pick<FeatureVector, "f7_has_0dte_today"> {
  // Pure logic. SPY/QQQ/IWM: every weekday. Mag7 + IBIT + AVGO: M/W/F.
  // Non-Mag7: weekly Friday.
  // TODO: import _shared/dteEligibility.ts deterministic logic; copy here
  //       to keep this file dependency-light, or import directly.
  void wakeup;
  return { f7_has_0dte_today: false };
}

// ---------------------------------------------------------------------------
// F8 — most recent ct_flag_grades for specialist_ticker prior to wakeup_at
// ---------------------------------------------------------------------------

export async function loadF8(
  _supabase: SupabaseClient,
  _wakeup: Wakeup,
): Promise<Pick<FeatureVector, "f8_last_flag_outcome">> {
  // TODO: SELECT outcome FROM ct_flag_grades
  //       WHERE specialist_ticker = X AND graded_at < wakeup_at
  //       ORDER BY graded_at DESC LIMIT 1
  //       Caveat: brief notes recall property too new for stable 7d behavior;
  //       F8 is confound check, not primary hypothesis.
  return { f8_last_flag_outcome: null };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export async function reconstructFeatures(
  supabase: SupabaseClient,
  wakeup: Wakeup,
): Promise<FeatureVector> {
  const [f1, f2, f3, f4, f5, f6, f8] = await Promise.all([
    loadF1(supabase, wakeup),
    loadF2(supabase, wakeup),
    loadF3(supabase, wakeup),
    loadF4(supabase, wakeup),
    loadF5(supabase, wakeup),
    loadF6(supabase, wakeup),
    loadF8(supabase, wakeup),
  ]);
  const f7 = loadF7(wakeup);
  return { ...f1, ...f2, ...f3, ...f4, ...f5, ...f6, ...f7, ...f8 };
}
