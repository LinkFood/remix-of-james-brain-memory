-- Plug ct_central_bank_rates + ct_events into build_ticker_quant_card macro.
-- Both tables are populated but the existing CTEs read the wrong column names
-- (captured_at vs capture_date, and events wasn't overlaid at all).
--
-- Extends the existing decorator with two more helpers + two more overlays.
-- No rewrite of the 580-line orig function.

SET search_path = public, extensions;

-- ============================================================================
-- Helper: latest central bank rates (capture_date ordering)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_compute_central_bank_state()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    jsonb_agg(to_jsonb(t) ORDER BY capture_date DESC),
    '[]'::jsonb
  )
  FROM (
    -- One row per central bank, latest per bank
    SELECT DISTINCT ON (country_code)
      country_code, capture_date, rate, direction_trend,
      next_meeting_date, expected_move_bps, ingested_at
    FROM ct_central_bank_rates
    ORDER BY country_code, capture_date DESC
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.ct_compute_central_bank_state()
  TO authenticated, service_role;

-- ============================================================================
-- Helper: upcoming + recent market events for a ticker (or macro-wide)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.ct_compute_events(
  p_ticker   TEXT,
  p_days_fwd INT DEFAULT 7,
  p_days_bwd INT DEFAULT 3
) RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    jsonb_agg(to_jsonb(t) ORDER BY event_date ASC),
    '[]'::jsonb
  )
  FROM (
    SELECT
      event_type, ticker, event_date, event_time,
      title, importance, report_time,
      eps_estimate, prev_actual, iv_rank_at_capture
    FROM ct_events
    WHERE event_date BETWEEN (CURRENT_DATE - p_days_bwd) AND (CURRENT_DATE + p_days_fwd)
      AND (
        upper(coalesce(ticker, '')) = upper(p_ticker)
        OR ticker IS NULL
        OR event_type IN ('fomc','fed','cpi','ppi','nfp','gdp','retail_sales','econ','macro')
      )
    ORDER BY event_date ASC
    LIMIT 50
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.ct_compute_events(TEXT, INT, INT)
  TO authenticated, service_role;

-- ============================================================================
-- Extend build_ticker_quant_card decorator to overlay central_bank + events
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
  v_cb_live    jsonb;
  v_events_live jsonb;
BEGIN
  v_result      := public.build_ticker_quant_card_orig(p_ticker, p_as_of);
  v_flip        := public.ct_compute_gamma_flip(p_ticker, p_as_of);
  v_flow_live   := public.ct_compute_flow_last_hour(p_ticker, p_as_of);
  v_corr_live   := public.ct_compute_correlations(p_ticker, 25);
  v_yc_live     := public.ct_compute_yield_curve_latest();
  v_cb_live     := public.ct_compute_central_bank_state();
  v_events_live := public.ct_compute_events(p_ticker, 7, 3);

  IF v_result IS NULL THEN RETURN v_result; END IF;

  -- gamma_flip
  IF v_flip IS NOT NULL THEN
    IF v_result ? 'gamma_flip' THEN
      v_result := jsonb_set(v_result, '{gamma_flip}', to_jsonb(v_flip), false);
    END IF;
    IF v_result ? 'structural' AND (v_result->'structural') ? 'gamma_flip' THEN
      v_result := jsonb_set(v_result, '{structural,gamma_flip}', to_jsonb(v_flip), false);
    END IF;
  END IF;

  -- flow_last_hour (merge)
  IF v_result ? 'flow_last_hour' AND v_flow_live IS NOT NULL THEN
    v_result := jsonb_set(
      v_result, '{flow_last_hour}',
      (v_result->'flow_last_hour') || v_flow_live,
      false
    );
  END IF;

  -- macro.correlations
  IF v_result ? 'macro' AND v_corr_live IS NOT NULL AND jsonb_array_length(v_corr_live) > 0 THEN
    v_result := jsonb_set(v_result, '{macro,correlations}', v_corr_live, false);
  END IF;

  -- macro.yield_curve_snapshot
  IF v_result ? 'macro' AND v_yc_live IS NOT NULL THEN
    v_result := jsonb_set(v_result, '{macro,yield_curve_snapshot}', v_yc_live, false);
  END IF;

  -- macro.central_bank_state
  IF v_result ? 'macro' AND v_cb_live IS NOT NULL AND jsonb_array_length(v_cb_live) > 0 THEN
    v_result := jsonb_set(v_result, '{macro,central_bank_state}', v_cb_live, false);
  END IF;

  -- events (root-level — overwrite null/missing with live array)
  IF v_events_live IS NOT NULL AND jsonb_array_length(v_events_live) > 0 THEN
    v_result := jsonb_set(v_result, '{events}', v_events_live, true);
  END IF;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.build_ticker_quant_card(TEXT, TIMESTAMPTZ)
  TO authenticated, service_role;
