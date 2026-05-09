-- JAC emission Phase 2 — Trigger 3: regime_transition.
--
-- Expansion: emission coverage 1/10 → 2/10 (alongside parallel PR-1 news_flow_causality
-- which lands as the simultaneous +1). Phase 1 kernel + hot_contract proof lives at
-- supabase/migrations/20260510030000_jac_emission_layer_phase_1.sql. This migration
-- mirrors the detect_hot_contract shape and registers a new trigger row.
--
-- What we emit on:
--   A regime classification flip on a ticker (or market-wide) since the previous
--   ct_regime_history bucket. ct_regime_history is the Pulse v2 append-only
--   regime evolution table; classification is the labeled state (e.g. trend_up,
--   pre_event_macro, chop_neutral). A flip means the captain's regime backdrop
--   for that ticker just changed — load-bearing for every other detector.
--
-- Phase A finding driving inline-LAG path:
--   PR #91's get_regime_transitions RPC migration is on the PR branch but NOT on
--   origin/main. Cherry-picking would couple this PR to PR #91's merge state.
--   Computing transitions inline via LAG window is cheap (one per (ticker, bucket_ts)
--   in the lookback window) and keeps this PR independent. When PR #91 merges, the
--   RPC and this detector co-exist — different consumers (Regime Flip Journal UI
--   vs proactive emission).
--
-- Severity ladder (per detection_params, all tunable):
--   alert  → synchronized multi-ticker flip (≥ synchronized_flip_threshold tickers
--            transitioning at the same bucket_ts; the "9 tickers all flipped to
--            pre_event_macro at 5/6 10:00" pattern from PR #91's findings)
--   signal → high-confidence single-ticker flip (confidence ≥ signal_confidence_min)
--   info   → routine flip below the confidence floor (still emitted; captain
--            observes regime drift in low-conviction states)
--
-- Dedup:
--   event_dedup_key = 'regime_transition:' || COALESCE(ticker,'MKT') || ':' || bucket_ts.
--   One emission per (ticker, transition timestamp). Debounced 60min via the
--   detect-side LEFT-JOIN to jac_emissions (mirrors detect_hot_contract).
--
-- Cross-references:
--   - Phase 1 kernel:   20260510030000_jac_emission_layer_phase_1.sql
--   - ct_regime_history schema: 20260502040100_pulse_v2_schemas.sql
--   - Composition template: supabase/functions/jac-compose-emission/index.ts (TEMPLATES)

SET search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- 1. detect_regime_transition — CO-TRADER application detection function
-- ---------------------------------------------------------------------------
-- Inline LAG over ct_regime_history partitioned by COALESCE(ticker,'__MKT__'),
-- ordered by bucket_ts ASC. A row is a "transition" when its classification
-- differs from the prior row in the same partition.
--
-- Synchronized-flip detection: per bucket_ts across watchlist tickers (NOT NULL
-- ticker rows), count how many flipped to the SAME current classification at
-- that same bucket. >= synchronized_flip_threshold → severity bumps to alert
-- on every contributing row.

CREATE OR REPLACE FUNCTION public.detect_regime_transition(
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
  v_lookback_minutes          INT;
  v_debounce_minutes          INT;
  v_signal_confidence_min     NUMERIC;
  v_synchronized_threshold    INT;
BEGIN
  v_lookback_minutes       := COALESCE((p_params->>'lookback_minutes')::INT, 30);
  v_debounce_minutes       := COALESCE((p_params->>'debounce_minutes')::INT, 60);
  v_signal_confidence_min  := COALESCE((p_params->>'signal_confidence_min')::NUMERIC, 75);
  v_synchronized_threshold := COALESCE((p_params->>'synchronized_flip_threshold')::INT, 5);

  RETURN QUERY
  WITH lagged AS (
    SELECT
      rh.id,
      rh.ticker,
      rh.bucket_ts,
      rh.classification,
      rh.confidence,
      rh.trajectory,
      rh.momentum,
      rh.rationale,
      LAG(rh.classification) OVER (
        PARTITION BY COALESCE(rh.ticker, '__MKT__')
        ORDER BY rh.bucket_ts ASC
      ) AS prev_classification,
      LAG(rh.bucket_ts) OVER (
        PARTITION BY COALESCE(rh.ticker, '__MKT__')
        ORDER BY rh.bucket_ts ASC
      ) AS prev_bucket_ts
    FROM public.ct_regime_history rh
    -- Generous lookback window in the LAG partition so we can compute
    -- transitions whose "prev" sits just before the emission lookback edge.
    -- We filter to the emission window in the next CTE.
    WHERE rh.bucket_ts >= now() - ((v_lookback_minutes + 60) || ' minutes')::interval
  ),
  transitions AS (
    SELECT *
    FROM lagged
    WHERE prev_classification IS NOT NULL
      AND classification IS DISTINCT FROM prev_classification
      AND bucket_ts >= now() - (v_lookback_minutes || ' minutes')::interval
  ),
  -- For each ticker-row transition, count peers (other watchlist tickers, ticker
  -- IS NOT NULL) flipping to the same classification at the same bucket_ts.
  synchronized AS (
    SELECT
      t.id,
      COUNT(*) FILTER (
        WHERE peer.ticker IS NOT NULL
          AND peer.bucket_ts = t.bucket_ts
          AND peer.classification = t.classification
      )::INT AS sync_count
    FROM transitions t
    LEFT JOIN transitions peer
      ON peer.bucket_ts = t.bucket_ts
     AND peer.classification = t.classification
    WHERE t.ticker IS NOT NULL
    GROUP BY t.id
  ),
  scored AS (
    SELECT
      t.id,
      t.ticker,
      t.bucket_ts,
      t.classification,
      t.prev_classification,
      t.prev_bucket_ts,
      t.confidence,
      t.trajectory,
      t.momentum,
      t.rationale,
      COALESCE(s.sync_count, 0) AS sync_count,
      ('regime_transition:' || COALESCE(t.ticker, 'MKT') || ':' || t.bucket_ts::text)::TEXT AS dedup_key,
      CASE
        WHEN COALESCE(s.sync_count, 0) >= v_synchronized_threshold THEN 'alert'
        WHEN t.confidence >= v_signal_confidence_min THEN 'signal'
        ELSE 'info'
      END AS sev
    FROM transitions t
    LEFT JOIN synchronized s ON s.id = t.id
  )
  SELECT
    sc.dedup_key,
    jsonb_build_object(
      'regime_history_id',     sc.id,
      'ticker',                sc.ticker,
      'is_market_wide',        (sc.ticker IS NULL),
      'bucket_ts',             sc.bucket_ts,
      'prev_bucket_ts',        sc.prev_bucket_ts,
      'prev_classification',   sc.prev_classification,
      'current_classification', sc.classification,
      'confidence',            sc.confidence,
      'trajectory',            sc.trajectory,
      'momentum',              sc.momentum,
      'sync_count',            sc.sync_count,
      'synchronized_flip',     (sc.sync_count >= v_synchronized_threshold),
      'rationale_snippet',     LEFT(sc.rationale::text, 200)
    ) AS event_payload,
    sc.sev AS severity,
    COALESCE(sc.ticker, 'MKT') AS ticker_focus
  FROM scored sc
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.jac_emissions e
    WHERE e.trigger_name = 'cotrader_regime_transition_v1'
      AND e.event_dedup_key = sc.dedup_key
      AND e.created_at >= now() - (v_debounce_minutes || ' minutes')::interval
  )
  ORDER BY sc.bucket_ts DESC, sc.sync_count DESC, sc.confidence DESC;
END;
$$;

COMMENT ON FUNCTION public.detect_regime_transition IS
  'Co-Trader application detection: regime classification flips on ct_regime_history (per-ticker or market-wide) since the previous bucket. Inline LAG window — independent of get_regime_transitions RPC. Severity tiers on synchronized-flip count (alert) and confidence floor (signal vs info). Returns one row per fresh transition that has not already emitted within the debounce window.';

GRANT EXECUTE ON FUNCTION public.detect_regime_transition TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Trigger registration: cotrader_regime_transition_v1
-- ---------------------------------------------------------------------------
-- detection_params live in the row (Tenet 25 — adding/tuning a trigger is a DB
-- INSERT/UPDATE, not a code change). Defaults chosen to match the brief:
--   lookback_minutes=30   — emission detector runs every 5 min during RTH; 30min
--                           gives a comfortable safety margin against missed ticks.
--   debounce_minutes=60   — same ticker shouldn't re-emit within an hour even if
--                           it flip-flops (chop). Captain reads regime as a slow signal.
--   signal_confidence_min=75 — empirical Pulse v2 confidence distribution sits
--                              mostly at 100 (the macro_proximity rule fires hard);
--                              75 is a soft tier that still catches meaningful
--                              non-macro flips.
--   synchronized_flip_threshold=5 — half the watchlist (10 tickers) flipping
--                                   together is a regime-shift signal worth alert tier.

INSERT INTO public.jac_emission_triggers (
  trigger_name, application, detection_function, detection_params,
  default_severity, cadence_mode, cadence_params,
  composition_template, emission_targets, model_override, enabled
) VALUES (
  'cotrader_regime_transition_v1',
  'cotrader',
  'detect_regime_transition',
  jsonb_build_object(
    'lookback_minutes', 30,
    'debounce_minutes', 60,
    'signal_confidence_min', 75,
    'synchronized_flip_threshold', 5
  ),
  'signal',
  'debounced',
  jsonb_build_object('debounce_minutes', 60, 'per_key', 'ticker_bucket'),
  'cotrader_regime_transition_v1',
  ARRAY['slack']::TEXT[],
  NULL,
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
-- 3. (No new cron required.)
-- ---------------------------------------------------------------------------
-- jac-emission-detector (registered by Phase 1) iterates every enabled row in
-- jac_emission_triggers each tick and runs its detection_function. This trigger
-- is picked up automatically on the next 5-min RTH tick. First-fire timing:
-- regime classification is recomputed by the ct-regime-capture cron every 5min,
-- so a true regime flip can surface within ~10min of the underlying market move.
