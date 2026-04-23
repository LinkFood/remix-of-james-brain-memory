-- Fix: build_ticker_quant_card has stale aggregator queries that reference
-- columns/filters that don't match live data. Claude's quant_card shows
-- flow_last_hour=zero, macro.correlations=null, macro.yield_curve=null
-- EVEN THOUGH those tables have thousands of rows written today.
--
-- Specifically:
--   flow_agg CTE     filters ct_flow_alerts.executed_at (NULL in all rows)
--                    → should use COALESCE(executed_at, ingested_at)
--   correlations     filters ct_correlations.window_days = 20 (all rows = 0)
--                    → drop the filter, take most recent regardless
--   yield_curve      orders by captured_at (col is capture_date)
--
-- Decorator pattern (same as gamma_flip fix): helpers compute the correct
-- values, the build_ticker_quant_card wrapper overlays them into the JSON
-- result. Avoids restating the 580-line orig function.

SET search_path = public, extensions;

-- ============================================================================
-- Helper: live flow_last_hour computed from real ct_flow_alerts + ct_sweeps
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_compute_flow_last_hour(
  p_ticker TEXT,
  p_as_of  TIMESTAMPTZ DEFAULT now()
) RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  WITH flow AS (
    SELECT
      sum(CASE WHEN side = 'call' THEN premium ELSE 0 END) AS net_call_prem,
      sum(CASE WHEN side = 'put'  THEN premium ELSE 0 END) AS net_put_prem,
      sum(premium)                                         AS total_premium,
      count(*) FILTER (WHERE alert_type ILIKE '%sweep%')  AS sweep_count,
      count(*)                                             AS alert_count,
      count(*) FILTER (WHERE alert_type ILIKE '%whale%')  AS whale_count,
      -- Top 5 whales by premium, if any
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'side', side, 'strike', strike, 'expiry', expiry,
            'premium', premium, 'alert_type', alert_type
          ) ORDER BY premium DESC
        )
        FROM (
          SELECT side, strike, expiry, premium, alert_type
          FROM ct_flow_alerts
          WHERE upper(ticker) = upper(p_ticker)
            AND COALESCE(executed_at, ingested_at)
                BETWEEN p_as_of - INTERVAL '1 hour' AND p_as_of
            AND alert_type ILIKE '%whale%'
          ORDER BY premium DESC
          LIMIT 5
        ) w
      ) AS whales_j
    FROM ct_flow_alerts
    WHERE upper(ticker) = upper(p_ticker)
      AND COALESCE(executed_at, ingested_at)
          BETWEEN p_as_of - INTERVAL '1 hour' AND p_as_of
  ),
  sweep_only AS (
    SELECT count(*) AS sweep_count_canonical
    FROM ct_sweeps
    WHERE upper(ticker) = upper(p_ticker)
      AND snapshot_at BETWEEN p_as_of - INTERVAL '1 hour' AND p_as_of
  ),
  net_prem AS (
    SELECT
      sum(COALESCE(net_call_premium, 0) - COALESCE(net_put_premium, 0)) AS net_prem_tick
    FROM ct_net_premium_ticks
    WHERE upper(ticker) = upper(p_ticker)
      AND tick_timestamp BETWEEN p_as_of - INTERVAL '1 hour' AND p_as_of
  )
  SELECT jsonb_build_object(
    'net_call_prem',  COALESCE((SELECT net_call_prem FROM flow), 0),
    'net_put_prem',   COALESCE((SELECT net_put_prem  FROM flow), 0),
    'total_premium',  COALESCE((SELECT total_premium FROM flow), 0),
    'net_prem',       COALESCE((SELECT net_prem_tick FROM net_prem), 0),
    'alert_count',    COALESCE((SELECT alert_count  FROM flow), 0),
    'sweep_count',    GREATEST(
                        COALESCE((SELECT sweep_count FROM flow), 0),
                        COALESCE((SELECT sweep_count_canonical FROM sweep_only), 0)
                      ),
    'whale_count',    COALESCE((SELECT whale_count FROM flow), 0),
    'whales',         COALESCE((SELECT whales_j FROM flow), '[]'::jsonb)
  );
$$;

GRANT EXECUTE ON FUNCTION public.ct_compute_flow_last_hour(TEXT, TIMESTAMPTZ)
  TO authenticated, service_role;

-- ============================================================================
-- Helper: live correlations (drop window_days=20 filter)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_compute_correlations(
  p_ticker TEXT,
  p_limit  INT DEFAULT 25
) RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY ingested_at DESC), '[]'::jsonb)
  FROM (
    SELECT ticker_a, ticker_b, window_days, correlation, as_of_date, ingested_at
    FROM ct_correlations
    WHERE ticker_a = upper(p_ticker) OR ticker_b = upper(p_ticker)
    ORDER BY ingested_at DESC
    LIMIT p_limit
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.ct_compute_correlations(TEXT, INT)
  TO authenticated, service_role;

-- ============================================================================
-- Helper: latest yield curve snapshot (capture_date, not captured_at)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_compute_yield_curve_latest()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT to_jsonb(t) FROM (
    SELECT capture_date, tenors, is_inverted, spread_10y_2y, ingested_at
    FROM ct_yield_curve
    ORDER BY capture_date DESC
    LIMIT 1
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.ct_compute_yield_curve_latest()
  TO authenticated, service_role;

-- ============================================================================
-- Decorator: overlay live aggregators onto build_ticker_quant_card result
-- ============================================================================

CREATE OR REPLACE FUNCTION public.build_ticker_quant_card(
  p_ticker TEXT,
  p_as_of  TIMESTAMPTZ DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result     jsonb;
  v_flip       numeric;
  v_flow_live  jsonb;
  v_corr_live  jsonb;
  v_yc_live    jsonb;
BEGIN
  v_result    := public.build_ticker_quant_card_orig(p_ticker, p_as_of);
  v_flip      := public.ct_compute_gamma_flip(p_ticker, p_as_of);
  v_flow_live := public.ct_compute_flow_last_hour(p_ticker, p_as_of);
  v_corr_live := public.ct_compute_correlations(p_ticker, 25);
  v_yc_live   := public.ct_compute_yield_curve_latest();

  IF v_result IS NULL THEN RETURN v_result; END IF;

  -- Patch gamma_flip (prior fix)
  IF v_flip IS NOT NULL THEN
    IF v_result ? 'gamma_flip' THEN
      v_result := jsonb_set(v_result, '{gamma_flip}', to_jsonb(v_flip), false);
    END IF;
    IF v_result ? 'structural' AND (v_result->'structural') ? 'gamma_flip' THEN
      v_result := jsonb_set(v_result, '{structural,gamma_flip}', to_jsonb(v_flip), false);
    END IF;
  END IF;

  -- Merge live flow_last_hour onto existing (preserves dp_accumulation,
  -- greek_flow_* which are already correct; overwrites net_prem, whales,
  -- sweep_count, alert_count, whale_count with live values).
  IF v_result ? 'flow_last_hour' AND v_flow_live IS NOT NULL THEN
    v_result := jsonb_set(
      v_result,
      '{flow_last_hour}',
      (v_result->'flow_last_hour') || v_flow_live,
      false
    );
  END IF;

  -- Patch macro.correlations
  IF v_result ? 'macro' AND v_corr_live IS NOT NULL AND jsonb_array_length(v_corr_live) > 0 THEN
    v_result := jsonb_set(
      v_result,
      '{macro,correlations}',
      v_corr_live,
      false
    );
  END IF;

  -- Patch macro.yield_curve_snapshot
  IF v_result ? 'macro' AND v_yc_live IS NOT NULL THEN
    v_result := jsonb_set(
      v_result,
      '{macro,yield_curve_snapshot}',
      v_yc_live,
      false
    );
  END IF;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.build_ticker_quant_card(TEXT, TIMESTAMPTZ)
  TO authenticated, service_role;
