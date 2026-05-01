-- =============================================================================
-- 20260502000600_grader_max_peak_window_fix.sql
--
-- ct_max_peak_for_flag previously used a fixed (created - 1h, created + 6h)
-- window. Specialist flags have 24h+ horizons; signature_alarm horizons can
-- be 4-12h. The 6h cap excluded valid tracks for any flag whose horizon
-- extended beyond the window, dropping `track_count` to 0 and forcing the
-- grader to skip them.
--
-- New signature accepts the flag's horizon_ts so the window matches the
-- flag's actual actionable lifetime: (created - 1h, horizon).
--
-- Old 2-arg signature kept as a thin wrapper that defaults horizon = created
-- + 6h, preserving any pre-existing callers without breakage.
-- =============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.ct_max_peak_for_flag(
  p_option_symbol  TEXT,
  p_flag_created   TIMESTAMPTZ,
  p_flag_horizon   TIMESTAMPTZ
)
RETURNS TABLE(
  peak_contract_pct NUMERIC,
  max_drawdown_pct  NUMERIC,
  track_count       INTEGER
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  -- Tracks for this option_symbol whose print_time falls within the flag's
  -- actionable window: 1h before flag creation through flag horizon.
  -- Take the MAX peak observed and MAX drawdown across those tracks.
  SELECT
    MAX(peak_contract_pct)::NUMERIC AS peak_contract_pct,
    MAX(max_drawdown_pct)::NUMERIC  AS max_drawdown_pct,
    COUNT(*)::INTEGER               AS track_count
  FROM public.ct_contract_tracks
  WHERE option_symbol = p_option_symbol
    AND print_time >= (p_flag_created - INTERVAL '1 hour')
    AND print_time <= p_flag_horizon;
$$;

GRANT EXECUTE ON FUNCTION public.ct_max_peak_for_flag(TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated, service_role;

-- Backwards-compat wrapper — defaults horizon to created + 6h. Used by any
-- pre-existing caller; new code passes the explicit horizon.
CREATE OR REPLACE FUNCTION public.ct_max_peak_for_flag(
  p_option_symbol  TEXT,
  p_flag_created   TIMESTAMPTZ
)
RETURNS TABLE(
  peak_contract_pct NUMERIC,
  max_drawdown_pct  NUMERIC,
  track_count       INTEGER
)
LANGUAGE sql STABLE
SET search_path = public, extensions
AS $$
  SELECT * FROM public.ct_max_peak_for_flag(
    p_option_symbol,
    p_flag_created,
    p_flag_created + INTERVAL '6 hours'
  );
$$;
