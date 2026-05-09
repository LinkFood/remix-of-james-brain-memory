-- JAC Emission Layer Phase 2 PR-1: news_flow_causality trigger
--
-- Captain-authorized 2026-05-09 evening — expand emission from 1/10 → 4/10
-- triggers. This migration registers Trigger 1 (news_flow_causality) and ships
-- alongside PR-3 (regime_transition). Trigger 2 (first_daily_cross) deferred for
-- substrate gap.
--
-- Phase A — brief-author state-vs-intent retarget (cascade #37 family):
--   Brief asserted detection threshold uses ct_news_causality.impact_score.
--   Empirical column check: that column does NOT exist on ct_news_causality.
--   Actual columns: id, news_id, ticker, news_source, news_at,
--     flow_hits_15min, flow_premium_15min,
--     dp_hits_15min, dp_notional_15min,
--     moved (boolean), analyzed_at.
--   Detection logic retargeted to: moved=true AND
--     (flow_premium_15min >= signal_min OR dp_notional_15min >= dp_signal_min).
--   Severity tiering uses the same premium fields with alert_min thresholds.
--
--   Brief also asserted headline lives on ct_breaking_news. Empirical FK check:
--   ct_news_causality.news_id REFERENCES ct_news_analyses(id), NOT
--   ct_breaking_news. Headline + source + impact + significance live on
--   ct_news_analyses (news_headline, news_source, impact, significance).
--   Detection function LEFT JOINs that table to surface headline in the event
--   payload for compose-time use.
--
--   Both retargets documented in PR description + iteration log entry.
--
-- 24h cadence sample (PR Phase A, 2026-05-09):
--   moved=true rows in last 24h = 9 (~9/day RTH); premium range $109k → $2.24M.
--   Slack budget: well-bounded; 60-min per-news-per-ticker debounce prevents
--   storms when a single headline triggers across multiple watchlist tickers
--   (each ticker is a separate emission per design).
--
-- Cross-references:
--   - Phase 1 kernel: 20260510030000_jac_emission_layer_phase_1.sql
--   - Detection contract mirrors detect_hot_contract() shape: 4-col TABLE
--   - Compose template: cotrader_news_flow_causality_v1 added in companion edit
--     to supabase/functions/jac-compose-emission/index.ts (this PR).
--   - Migration timestamp 20260510120000 verified vs origin/main pre-stage
--     (latest on main was 20260510100000_drainer_skip_locked_class_kill.sql).
--     PR #100's CI workflow tests for migration-timestamp collisions.

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. Detection function — news_flow_causality (CO-TRADER APPLICATION)
-- ---------------------------------------------------------------------------
-- Returns rows from ct_news_causality where:
--   * moved = true (UW-defined: flow_premium_15min > 0 OR dp_notional_15min ≥ 10M)
--   * AND either flow_premium_15min ≥ premium_signal_min OR dp_notional_15min ≥
--     dp_signal_min (gate on premium magnitude — moved alone fires too often)
--   * AND analyzed_at within p_lookback_minutes
--   * AND ticker in 10-name watchlist (universe lock — Tenet 4)
--   * AND no prior emission for the same (news_id, ticker) within debounce window
--
-- Severity:
--   alert  if flow_premium_15min ≥ premium_alert_min OR
--             dp_notional_15min ≥ dp_alert_min
--   signal otherwise
--
-- Headline + source + impact + significance pulled from ct_news_analyses via
-- LEFT JOIN on news_id. Defensive against headline missing — payload still
-- composes, headline-derived fields stay null.

CREATE OR REPLACE FUNCTION public.detect_news_flow_causality(
  p_params JSONB DEFAULT '{}'::jsonb
) RETURNS TABLE (
  event_dedup_key TEXT,
  event_payload JSONB,
  severity TEXT,
  ticker_focus TEXT
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions
AS $$
DECLARE
  v_premium_signal_min NUMERIC;
  v_premium_alert_min  NUMERIC;
  v_dp_signal_min      NUMERIC;
  v_dp_alert_min       NUMERIC;
  v_lookback_minutes   INT;
  v_debounce_minutes   INT;
BEGIN
  v_premium_signal_min := COALESCE((p_params->>'premium_signal_min')::NUMERIC, 250000);
  v_premium_alert_min  := COALESCE((p_params->>'premium_alert_min')::NUMERIC, 500000);
  v_dp_signal_min      := COALESCE((p_params->>'dp_signal_min')::NUMERIC, 500000);
  v_dp_alert_min       := COALESCE((p_params->>'dp_alert_min')::NUMERIC, 1000000);
  v_lookback_minutes   := COALESCE((p_params->>'lookback_minutes')::INT, 30);
  v_debounce_minutes   := COALESCE((p_params->>'debounce_minutes')::INT, 60);

  RETURN QUERY
  WITH candidates AS (
    SELECT
      nc.id              AS causality_id,
      nc.news_id,
      nc.ticker,
      nc.news_source,
      nc.news_at,
      nc.flow_hits_15min,
      nc.flow_premium_15min,
      nc.dp_hits_15min,
      nc.dp_notional_15min,
      nc.analyzed_at,
      na.news_headline,
      na.news_url,
      na.impact         AS news_impact,
      na.significance   AS news_significance,
      ('news_flow_causality:' || nc.news_id::text || ':' || nc.ticker)::TEXT AS dedup_key,
      CASE
        WHEN nc.flow_premium_15min >= v_premium_alert_min
          OR nc.dp_notional_15min  >= v_dp_alert_min
        THEN 'alert'
        ELSE 'signal'
      END AS sev
    FROM public.ct_news_causality nc
    LEFT JOIN public.ct_news_analyses na ON na.id = nc.news_id
    WHERE nc.moved = true
      AND (
            nc.flow_premium_15min >= v_premium_signal_min
         OR nc.dp_notional_15min  >= v_dp_signal_min
      )
      AND nc.analyzed_at >= now() - (v_lookback_minutes || ' minutes')::interval
      AND nc.ticker = ANY (ARRAY[
        'NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','QQQ','SPY','IWM'
      ])
      AND nc.news_id IS NOT NULL
  )
  SELECT
    c.dedup_key,
    jsonb_build_object(
      'causality_id',        c.causality_id,
      'news_id',             c.news_id,
      'ticker',              c.ticker,
      'news_source',         c.news_source,
      'news_at',             c.news_at,
      'analyzed_at',         c.analyzed_at,
      'flow_hits_15min',     c.flow_hits_15min,
      'flow_premium_15min',  c.flow_premium_15min,
      'dp_hits_15min',       c.dp_hits_15min,
      'dp_notional_15min',   c.dp_notional_15min,
      'news_headline',       c.news_headline,
      'news_url',            c.news_url,
      'news_impact',         c.news_impact,
      'news_significance',   c.news_significance
    ) AS event_payload,
    c.sev AS severity,
    c.ticker AS ticker_focus
  FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.jac_emissions e
    WHERE e.trigger_name = 'news_flow_causality'
      AND e.event_dedup_key = c.dedup_key
      AND e.created_at >= now() - (v_debounce_minutes || ' minutes')::interval
  )
  ORDER BY c.analyzed_at DESC,
           GREATEST(c.flow_premium_15min, c.dp_notional_15min) DESC;
END;
$$;

COMMENT ON FUNCTION public.detect_news_flow_causality IS
  'Co-Trader application detection: ct_news_causality rows where moved=true and either flow_premium_15min or dp_notional_15min crosses signal/alert thresholds, scoped to the 10-name watchlist, deduped per (news_id, ticker) within the debounce window. Headline pulled from ct_news_analyses via LEFT JOIN on news_id.';

GRANT EXECUTE ON FUNCTION public.detect_news_flow_causality TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Trigger registration — news_flow_causality (CO-TRADER APPLICATION)
-- ---------------------------------------------------------------------------
-- jac-emission-detector picks up the new row on its next minute tick. No
-- code change required — Tenet 25 (adding a trigger is a database INSERT).

INSERT INTO public.jac_emission_triggers (
  trigger_name, application, detection_function, detection_params,
  default_severity, cadence_mode, cadence_params,
  composition_template, emission_targets, model_override, enabled
) VALUES (
  'news_flow_causality',
  'cotrader',
  'detect_news_flow_causality',
  jsonb_build_object(
    'premium_signal_min', 250000,
    'premium_alert_min',  500000,
    'dp_signal_min',      500000,
    'dp_alert_min',       1000000,
    'lookback_minutes',   30,
    'debounce_minutes',   60
  ),
  'signal',
  'debounced',
  jsonb_build_object('debounce_minutes', 60, 'per_key', 'news_id_ticker'),
  'cotrader_news_flow_causality_v1',
  ARRAY['slack']::TEXT[],
  NULL,  -- severity-default model (haiku for signal, sonnet for alert)
  true
)
ON CONFLICT (trigger_name) DO UPDATE SET
  detection_params     = EXCLUDED.detection_params,
  default_severity     = EXCLUDED.default_severity,
  cadence_mode         = EXCLUDED.cadence_mode,
  cadence_params       = EXCLUDED.cadence_params,
  composition_template = EXCLUDED.composition_template,
  emission_targets     = EXCLUDED.emission_targets,
  model_override       = EXCLUDED.model_override,
  enabled              = EXCLUDED.enabled,
  updated_at           = now();
