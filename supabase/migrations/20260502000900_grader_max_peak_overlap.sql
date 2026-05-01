-- =============================================================================
-- 20260502000900_grader_max_peak_overlap.sql
--
-- The previous version filtered by track.print_time INSIDE the flag window
-- (created - 1h, horizon). That excluded tracks whose first print landed
-- BEFORE the flag was created — common for contracts the poller had been
-- watching for days before a signature_alarm fired. Result: track_count=0,
-- grader skipped the flag, status stuck at 'active' indefinitely.
--
-- New criterion: track LIFETIME (first_tracked_at .. last_tracked_at) must
-- OVERLAP the flag's actionable window (created - 1h .. horizon). A track
-- that was alive at any point during the flag's horizon contributes its
-- peak. Captures pre-flag tracks that continued into the flag period.
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
  -- Tracks for this option_symbol whose tracked-lifetime overlaps the flag's
  -- actionable window. Standard interval-overlap test:
  --   track_alive_until >= window_start AND track_started_before <= window_end
  -- Take the MAX peak observed and MAX drawdown across overlapping tracks.
  SELECT
    MAX(peak_contract_pct)::NUMERIC AS peak_contract_pct,
    MAX(max_drawdown_pct)::NUMERIC  AS max_drawdown_pct,
    COUNT(*)::INTEGER               AS track_count
  FROM public.ct_contract_tracks
  WHERE option_symbol = p_option_symbol
    AND COALESCE(last_tracked_at, first_tracked_at, print_time) >= (p_flag_created - INTERVAL '1 hour')
    AND COALESCE(first_tracked_at, print_time) <= p_flag_horizon;
$$;

GRANT EXECUTE ON FUNCTION public.ct_max_peak_for_flag(TEXT, TIMESTAMPTZ, TIMESTAMPTZ)
  TO authenticated, service_role;
