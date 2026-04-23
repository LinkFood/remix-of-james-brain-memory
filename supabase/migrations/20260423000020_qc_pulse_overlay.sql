-- Extend build_ticker_quant_card decorator with pulse overlay.
-- Claude sees a compressed aggregate of all signals feeding into his quant card.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.build_ticker_quant_card(
  p_ticker TEXT,
  p_as_of  TIMESTAMPTZ DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  v_result        jsonb;
  v_flip          numeric;
  v_flow_live     jsonb;
  v_corr_live     jsonb;
  v_yc_live       jsonb;
  v_cb_live       jsonb;
  v_events_live   jsonb;
  v_tech_live     jsonb;
  v_int_live      jsonb;
  v_pulse_live    jsonb;
BEGIN
  v_result       := public.build_ticker_quant_card_orig(p_ticker, p_as_of);
  v_flip         := public.ct_compute_gamma_flip(p_ticker, p_as_of);
  v_flow_live    := public.ct_compute_flow_last_hour(p_ticker, p_as_of);
  v_corr_live    := public.ct_compute_correlations(p_ticker, 25);
  v_yc_live      := public.ct_compute_yield_curve_latest();
  v_cb_live      := public.ct_compute_central_bank_state();
  v_events_live  := public.ct_compute_events(p_ticker, 7, 3);
  v_tech_live    := public.ct_compute_technicals(p_ticker);
  v_int_live     := public.ct_compute_interval_flow_summary(p_ticker, p_as_of);
  v_pulse_live   := public.ct_pulse_snapshot(p_ticker);

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

  -- flow_last_hour merge
  IF v_result ? 'flow_last_hour' AND v_flow_live IS NOT NULL THEN
    v_result := jsonb_set(v_result, '{flow_last_hour}',
      (v_result->'flow_last_hour') || v_flow_live, false);
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

  -- events root
  IF v_events_live IS NOT NULL AND jsonb_array_length(v_events_live) > 0 THEN
    v_result := jsonb_set(v_result, '{events}', v_events_live, true);
  END IF;

  -- technicals root
  IF v_tech_live IS NOT NULL AND jsonb_typeof(v_tech_live) = 'object'
     AND (SELECT count(*) FROM jsonb_object_keys(v_tech_live)) > 0 THEN
    v_result := jsonb_set(v_result, '{technicals}', v_tech_live, true);
  END IF;

  -- interval_flow_summary nested in flow_last_hour
  IF v_int_live IS NOT NULL AND (v_int_live->>'row_count')::int > 0 THEN
    v_result := jsonb_set(v_result, '{flow_last_hour,interval_summary}', v_int_live, true);
  END IF;

  -- pulse root — aggregate score over all today's signals
  IF v_pulse_live IS NOT NULL AND (v_pulse_live->>'score') IS NOT NULL THEN
    v_result := jsonb_set(v_result, '{pulse}', v_pulse_live, true);
  END IF;

  RETURN v_result;
END $$;

GRANT EXECUTE ON FUNCTION public.build_ticker_quant_card(TEXT, TIMESTAMPTZ)
  TO authenticated, service_role;
