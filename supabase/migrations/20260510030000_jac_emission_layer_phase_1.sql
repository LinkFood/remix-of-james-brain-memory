-- JAC kernel: Proactive Emission Layer Phase 1.
--
-- Architectural goal: the system has observation (organs ingest, brain composes)
-- and consumption (chat answers when asked) but no emission — it doesn't
-- proactively say things back to the captain unprompted. This migration
-- ships the kernel scaffolding plus one proof trigger (hot_contract) for
-- end-to-end Slack-only emission.
--
-- Kernel-vs-application boundary (per kernel-vs-limb discipline):
--   - Kernel (domain-agnostic):  jac_emission_triggers + jac_emissions tables,
--                                detection-runner cron contract, edge-fn shapes
--                                (jac-compose-emission + jac-emit + jac-emission-detector)
--   - Application (Co-Trader):   hot_contract trigger registration + detect_hot_contract
--                                detection function. Other applications would register
--                                their own triggers in the same table.
--
-- Phase A empirical findings driving this ship:
--   - ct_scored_flow last 7 days: 8,381 rows, score caps at 85, premium p95 ≈ $986k
--   - Threshold @ score≥80 ∧ premium≥$250k = 13 events / 7d = ~1.9/day → signal tier
--   - Threshold @ score≥80 ∧ premium≥$500k = 7 events / 7d = ~1.0/day → alert tier
--   - 60-min per-(ticker,option) debounce prevents same contract re-firing
--
-- Cross-references:
--   - Slack helper: supabase/functions/_shared/ctSlack.ts (ctSlackPushDirect)
--   - Brain composition: supabase/functions/_shared/claudeReadSurface.ts (buildClaudeContext)
--   - _ct_post helper apikey fix: 20260507160000_apikey_in_ct_post_helpers.sql
--   - Bundle Phase 2 organMetadata pattern: supabase/functions/_shared/contextHelper.ts:120-152

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. jac_emission_triggers (KERNEL — domain-agnostic registration table)
-- ---------------------------------------------------------------------------
-- Each row registers one trigger. Adding a new trigger is a database INSERT;
-- detection runner picks it up at next fire. Mirrors the ct_invariants pattern
-- (warden) but emission-flavored: detection returns multiple events per call
-- rather than one boolean per check.

CREATE TABLE IF NOT EXISTS public.jac_emission_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_name TEXT NOT NULL UNIQUE,
  application TEXT NOT NULL CHECK (application IN ('jac', 'cotrader')),
  -- detection_function: name of an SQL function returning rows that match the trigger.
  -- Must accept (params JSONB) and return TABLE (event_dedup_key TEXT, event_payload JSONB,
  --                                              severity TEXT, ticker_focus TEXT).
  detection_function TEXT NOT NULL,
  detection_params JSONB NOT NULL DEFAULT '{}',
  default_severity TEXT NOT NULL CHECK (default_severity IN ('info','signal','alert','critical')),
  -- cadence_mode controls re-fire policy:
  --   per_event:   every detection-row produces an emission
  --   debounced:   skip if event_dedup_key emitted within debounce_minutes
  --   rate_limited: cap to N emissions per window (cadence_params.{n, window_minutes})
  cadence_mode TEXT NOT NULL CHECK (cadence_mode IN ('per_event', 'debounced', 'rate_limited')),
  cadence_params JSONB NOT NULL DEFAULT '{}',
  -- composition_template: a name resolved by jac-compose-emission to a system prompt.
  -- Templates live in code (Phase 1) — promotable to a table later.
  composition_template TEXT NOT NULL,
  -- Targets: ['slack'] in Phase 1. ['slack','feed'] in Phase 2 once site feed lands.
  emission_targets TEXT[] NOT NULL DEFAULT ARRAY['slack'],
  -- model_override: NULL = severity-default (haiku for info/signal, sonnet for alert/critical).
  model_override TEXT,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emission_triggers_enabled
  ON public.jac_emission_triggers (enabled, application);

COMMENT ON TABLE public.jac_emission_triggers IS
  'JAC kernel emission registry. Each row registers one trigger producing proactive emissions to the captain. Adding/disabling a trigger is a DB INSERT/UPDATE — no code change required (Tenet 25).';

-- ---------------------------------------------------------------------------
-- 2. jac_emissions (KERNEL — append-only event log)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.jac_emissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id UUID REFERENCES public.jac_emission_triggers(id) ON DELETE SET NULL,
  trigger_name TEXT NOT NULL,
  application TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','signal','alert','critical')),

  -- The detection event payload (input to composition).
  event_payload JSONB NOT NULL,
  -- Used by debounce / rate-limit logic: e.g. for hot_contract = "ticker:option_symbol".
  event_dedup_key TEXT NOT NULL,

  -- Composition output (filled by jac-compose-emission).
  headline TEXT,
  take_text TEXT,
  links JSONB,
  source_organs TEXT[],

  -- LLM bookkeeping.
  composed_at TIMESTAMPTZ,
  model_used TEXT,
  cost_cents NUMERIC,
  tokens_in INT,
  tokens_out INT,

  -- Dispatch records (per-target attempt log).
  -- Shape: [{"target":"slack","status":"sent|failed|skipped","at":"<iso>","note":"..."}, ...]
  dispatched_targets JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Metadata.
  context_status TEXT NOT NULL DEFAULT 'pending' CHECK (
    context_status IN ('pending','populated','degraded','error')
  ),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_emissions_trigger_time
  ON public.jac_emissions (trigger_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emissions_dedup
  ON public.jac_emissions (trigger_name, event_dedup_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_emissions_severity_time
  ON public.jac_emissions (severity, created_at DESC);

COMMENT ON TABLE public.jac_emissions IS
  'JAC kernel emission log — every proactive emission to the captain. Append-only; status fields update via the dispatcher. Append substrate for Phase 4 grader (captain-feedback hit-rate).';

-- ---------------------------------------------------------------------------
-- 3. RLS — kernel tables service-role only (no per-user data; system-wide)
-- ---------------------------------------------------------------------------

ALTER TABLE public.jac_emission_triggers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jac_emissions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS service_only_emission_triggers ON public.jac_emission_triggers;
CREATE POLICY service_only_emission_triggers ON public.jac_emission_triggers
  FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS service_only_emissions ON public.jac_emissions;
CREATE POLICY service_only_emissions ON public.jac_emissions
  FOR ALL USING (auth.role() = 'service_role');

-- ---------------------------------------------------------------------------
-- 4. Hot-contract detection function (CO-TRADER APPLICATION layer)
-- ---------------------------------------------------------------------------
-- Application-specific detection. Returns rows from ct_scored_flow that:
--   * meet score + premium minimums
--   * are within p_lookback_minutes (so we only emit fresh events)
--   * have NOT already produced an emission for the same (ticker, option_symbol)
--     within p_debounce_minutes (idempotent within a debounce window)

CREATE OR REPLACE FUNCTION public.detect_hot_contract(
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
  v_score_min NUMERIC;
  v_premium_signal_min NUMERIC;
  v_premium_alert_min NUMERIC;
  v_lookback_minutes INT;
  v_debounce_minutes INT;
BEGIN
  v_score_min          := COALESCE((p_params->>'score_min')::NUMERIC, 80);
  v_premium_signal_min := COALESCE((p_params->>'premium_signal_min')::NUMERIC, 250000);
  v_premium_alert_min  := COALESCE((p_params->>'premium_alert_min')::NUMERIC, 500000);
  v_lookback_minutes   := COALESCE((p_params->>'lookback_minutes')::INT, 5);
  v_debounce_minutes   := COALESCE((p_params->>'debounce_minutes')::INT, 60);

  RETURN QUERY
  WITH candidates AS (
    SELECT
      sf.id,
      sf.ticker,
      sf.option_symbol,
      sf.score,
      sf.premium,
      sf.direction,
      sf.classification,
      sf.event_ts,
      sf.strike,
      sf.expiry,
      sf.dte,
      sf.spot_pct_from_prev_close,
      sf.spot_pct_from_today_open,
      sf.stacking_signal,
      sf.stacking_agrees,
      sf.iv_rank_at_event,
      sf.ticker_regime_agrees,
      (sf.ticker || ':' || COALESCE(sf.option_symbol, ''))::TEXT AS dedup_key,
      CASE
        WHEN sf.premium >= v_premium_alert_min THEN 'alert'
        ELSE 'signal'
      END AS sev
    FROM public.ct_scored_flow sf
    WHERE sf.event_ts >= now() - (v_lookback_minutes || ' minutes')::interval
      AND sf.score >= v_score_min
      AND sf.premium >= v_premium_signal_min
      AND sf.option_symbol IS NOT NULL
      AND sf.ticker IS NOT NULL
  )
  SELECT
    c.dedup_key,
    jsonb_build_object(
      'scored_flow_id', c.id,
      'ticker', c.ticker,
      'option_symbol', c.option_symbol,
      'score', c.score,
      'premium', c.premium,
      'direction', c.direction,
      'classification', c.classification,
      'event_ts', c.event_ts,
      'strike', c.strike,
      'expiry', c.expiry,
      'dte', c.dte,
      'spot_pct_from_prev_close', c.spot_pct_from_prev_close,
      'spot_pct_from_today_open', c.spot_pct_from_today_open,
      'stacking_signal', c.stacking_signal,
      'stacking_agrees', c.stacking_agrees,
      'iv_rank_at_event', c.iv_rank_at_event,
      'ticker_regime_agrees', c.ticker_regime_agrees
    ) AS event_payload,
    c.sev AS severity,
    c.ticker AS ticker_focus
  FROM candidates c
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.jac_emissions e
    WHERE e.trigger_name = 'hot_contract'
      AND e.event_dedup_key = c.dedup_key
      AND e.created_at >= now() - (v_debounce_minutes || ' minutes')::interval
  )
  ORDER BY c.event_ts DESC, c.score DESC, c.premium DESC;
END;
$$;

COMMENT ON FUNCTION public.detect_hot_contract IS
  'Co-Trader application detection: high-score, large-premium options flow events that haven''t already been emitted within the debounce window. Returns one row per fresh hot contract.';

GRANT EXECUTE ON FUNCTION public.detect_hot_contract TO service_role;

-- ---------------------------------------------------------------------------
-- 5. Trigger registration: hot_contract (CO-TRADER APPLICATION)
-- ---------------------------------------------------------------------------

INSERT INTO public.jac_emission_triggers (
  trigger_name, application, detection_function, detection_params,
  default_severity, cadence_mode, cadence_params,
  composition_template, emission_targets, model_override, enabled
) VALUES (
  'hot_contract',
  'cotrader',
  'detect_hot_contract',
  jsonb_build_object(
    'score_min', 80,
    'premium_signal_min', 250000,
    'premium_alert_min', 500000,
    'lookback_minutes', 5,
    'debounce_minutes', 60
  ),
  'signal',
  'debounced',
  jsonb_build_object('debounce_minutes', 60, 'per_key', 'ticker_option'),
  'cotrader_hot_contract_v1',
  ARRAY['slack']::TEXT[],
  NULL,  -- no override; severity-default (haiku/sonnet by severity)
  true
)
ON CONFLICT (trigger_name) DO UPDATE SET
  detection_params = EXCLUDED.detection_params,
  default_severity = EXCLUDED.default_severity,
  cadence_mode = EXCLUDED.cadence_mode,
  cadence_params = EXCLUDED.cadence_params,
  composition_template = EXCLUDED.composition_template,
  emission_targets = EXCLUDED.emission_targets,
  model_override = EXCLUDED.model_override,
  enabled = EXCLUDED.enabled,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 6. Detection runner cron — every minute during RTH weekdays
-- ---------------------------------------------------------------------------
-- Phase 1 simplicity: cron-driven. Phase 2+ may move to Realtime subscriptions
-- on ct_scored_flow for sub-minute latency.
--
-- Uses _ct_post() helper which carries the apikey header per the 2026-05-07
-- gateway-rewrite class kill (isServiceRoleRequest checks apikey).

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'jac-emission-detector') THEN
    PERFORM cron.unschedule('jac-emission-detector');
  END IF;
  PERFORM cron.schedule(
    'jac-emission-detector',
    '* 13-20 * * 1-5',
    $body$SELECT public._ct_post('jac-emission-detector');$body$
  );
END
$cron$;
