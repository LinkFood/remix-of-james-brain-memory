-- ct_butterfly_cross_events table — Flow Butterfly Rank 1 substrate.
--
-- Captures every cum_all_call vs cum_all_put zero-crossing the detector
-- finds, plus forward-window outcomes (5/15/30/60min, EOD, NextClose) the
-- grader fills in. Builds the empirical corpus that feeds:
--   - Inline hit-rate per cross on the live chart (UI follow-up)
--   - Live rolling confidence levels in flow_butterfly brain organ (replaces
--     static empirical thresholds from PR #64 § A.3 / § A.4)
--   - Warden hit_rate_drift invariant
--   - Future per-ticker role re-derivation from rolling 30d data
--
-- Per PR #64 design pass § C.1 schema. Append-only; idempotent under
-- re-detection via UNIQUE (ticker, cross_at).

CREATE TABLE IF NOT EXISTS public.ct_butterfly_cross_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker TEXT NOT NULL,
  session_date DATE NOT NULL,
  cross_at TIMESTAMPTZ NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('bullish','bearish')),

  -- Cross-moment state (signed gap snapshot)
  cum_all_call NUMERIC NOT NULL,
  cum_all_put NUMERIC NOT NULL,
  gap_dollars NUMERIC NOT NULL,
  magnitude_dollars NUMERIC NOT NULL,
  magnitude_tertile TEXT NOT NULL CHECK (magnitude_tertile IN ('small','mid','large')),

  -- Session context
  minutes_into_session INT NOT NULL,
  session_phase TEXT NOT NULL CHECK (session_phase IN ('open_hour','midday','mid_afternoon','close_hour')),
  order_in_day INT NOT NULL,

  -- Price at cross moment (filled by detector if available; else null)
  price_at_cross NUMERIC,
  price_source TEXT,

  -- Forward outcomes (filled by grader)
  price_5min NUMERIC,
  price_15min NUMERIC,
  price_30min NUMERIC,
  price_60min NUMERIC,
  price_eod NUMERIC,
  price_nextclose NUMERIC,
  next_close_at TIMESTAMPTZ,

  -- Hit booleans (computed: did direction predict each forward window?)
  hit_5min BOOLEAN,
  hit_15min BOOLEAN,
  hit_30min BOOLEAN,
  hit_60min BOOLEAN,
  hit_eod BOOLEAN,
  hit_nextclose BOOLEAN,

  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  graded_at TIMESTAMPTZ,
  generation_id TEXT,

  UNIQUE (ticker, cross_at)
);

CREATE INDEX IF NOT EXISTS idx_butterfly_cross_session
  ON public.ct_butterfly_cross_events (session_date);

CREATE INDEX IF NOT EXISTS idx_butterfly_cross_ticker_time
  ON public.ct_butterfly_cross_events (ticker, cross_at DESC);

CREATE INDEX IF NOT EXISTS idx_butterfly_cross_magnitude
  ON public.ct_butterfly_cross_events (magnitude_tertile, direction);

CREATE INDEX IF NOT EXISTS idx_butterfly_cross_ungrade
  ON public.ct_butterfly_cross_events (graded_at, cross_at)
  WHERE graded_at IS NULL;

ALTER TABLE public.ct_butterfly_cross_events OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE ON public.ct_butterfly_cross_events TO service_role;
GRANT SELECT ON public.ct_butterfly_cross_events TO anon, authenticated;

COMMENT ON TABLE public.ct_butterfly_cross_events IS
  'Per PR #64 Rank 1 ship — butterfly cross-event corpus. Detector populates cross-moment fields; grader fills forward-window outcomes. UNIQUE (ticker, cross_at) keeps detection idempotent across re-runs.';

-- =============================================================================
-- get_butterfly_hit_rates RPC — empirical baseline computation surface
-- =============================================================================
--
-- Returns a per-cell hit-rate cube: ticker × magnitude_tertile × session_phase
-- × direction × forward_window. Used by the grader's own self-monitoring,
-- by future warden hit_rate_drift invariant, and by terminal-Claude analysis
-- sessions ("how is the midday-mid-bull cell tracking against the empirical
-- 71.9% baseline?").

CREATE OR REPLACE FUNCTION public.get_butterfly_hit_rates(
  p_since DATE DEFAULT (current_date - INTERVAL '60 days')::DATE,
  p_ticker TEXT DEFAULT NULL,
  p_magnitude_tertile TEXT DEFAULT NULL
)
RETURNS TABLE (
  ticker TEXT,
  magnitude_tertile TEXT,
  session_phase TEXT,
  direction TEXT,
  forward_window TEXT,
  n_events INT,
  n_hits INT,
  hit_rate NUMERIC,
  pp_vs_50 NUMERIC
)
LANGUAGE sql
STABLE
AS $fn$
  WITH unpivoted AS (
    SELECT e.ticker, e.magnitude_tertile, e.session_phase, e.direction,
           '5min' AS forward_window, e.hit_5min AS hit FROM public.ct_butterfly_cross_events e
      WHERE e.session_date >= p_since AND e.graded_at IS NOT NULL
        AND (p_ticker IS NULL OR e.ticker = p_ticker)
        AND (p_magnitude_tertile IS NULL OR e.magnitude_tertile = p_magnitude_tertile)
    UNION ALL
    SELECT e.ticker, e.magnitude_tertile, e.session_phase, e.direction,
           '15min', e.hit_15min FROM public.ct_butterfly_cross_events e
      WHERE e.session_date >= p_since AND e.graded_at IS NOT NULL
        AND (p_ticker IS NULL OR e.ticker = p_ticker)
        AND (p_magnitude_tertile IS NULL OR e.magnitude_tertile = p_magnitude_tertile)
    UNION ALL
    SELECT e.ticker, e.magnitude_tertile, e.session_phase, e.direction,
           '30min', e.hit_30min FROM public.ct_butterfly_cross_events e
      WHERE e.session_date >= p_since AND e.graded_at IS NOT NULL
        AND (p_ticker IS NULL OR e.ticker = p_ticker)
        AND (p_magnitude_tertile IS NULL OR e.magnitude_tertile = p_magnitude_tertile)
    UNION ALL
    SELECT e.ticker, e.magnitude_tertile, e.session_phase, e.direction,
           '60min', e.hit_60min FROM public.ct_butterfly_cross_events e
      WHERE e.session_date >= p_since AND e.graded_at IS NOT NULL
        AND (p_ticker IS NULL OR e.ticker = p_ticker)
        AND (p_magnitude_tertile IS NULL OR e.magnitude_tertile = p_magnitude_tertile)
    UNION ALL
    SELECT e.ticker, e.magnitude_tertile, e.session_phase, e.direction,
           'EOD', e.hit_eod FROM public.ct_butterfly_cross_events e
      WHERE e.session_date >= p_since AND e.graded_at IS NOT NULL
        AND (p_ticker IS NULL OR e.ticker = p_ticker)
        AND (p_magnitude_tertile IS NULL OR e.magnitude_tertile = p_magnitude_tertile)
    UNION ALL
    SELECT e.ticker, e.magnitude_tertile, e.session_phase, e.direction,
           'NextClose', e.hit_nextclose FROM public.ct_butterfly_cross_events e
      WHERE e.session_date >= p_since AND e.graded_at IS NOT NULL
        AND (p_ticker IS NULL OR e.ticker = p_ticker)
        AND (p_magnitude_tertile IS NULL OR e.magnitude_tertile = p_magnitude_tertile)
  )
  SELECT
    u.ticker,
    u.magnitude_tertile,
    u.session_phase,
    u.direction,
    u.forward_window,
    COUNT(*) FILTER (WHERE u.hit IS NOT NULL)::INT AS n_events,
    COUNT(*) FILTER (WHERE u.hit IS TRUE)::INT AS n_hits,
    CASE WHEN COUNT(*) FILTER (WHERE u.hit IS NOT NULL) = 0 THEN NULL
         ELSE ROUND(
           (COUNT(*) FILTER (WHERE u.hit IS TRUE))::NUMERIC
           / NULLIF(COUNT(*) FILTER (WHERE u.hit IS NOT NULL), 0)
           , 4)
    END AS hit_rate,
    CASE WHEN COUNT(*) FILTER (WHERE u.hit IS NOT NULL) = 0 THEN NULL
         ELSE ROUND(
           (((COUNT(*) FILTER (WHERE u.hit IS TRUE))::NUMERIC
             / NULLIF(COUNT(*) FILTER (WHERE u.hit IS NOT NULL), 0)) - 0.5) * 100
           , 2)
    END AS pp_vs_50
  FROM unpivoted u
  GROUP BY u.ticker, u.magnitude_tertile, u.session_phase, u.direction, u.forward_window
  ORDER BY u.ticker, u.magnitude_tertile, u.session_phase, u.direction, u.forward_window
$fn$;

ALTER FUNCTION public.get_butterfly_hit_rates(DATE, TEXT, TEXT) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.get_butterfly_hit_rates(DATE, TEXT, TEXT) TO anon, authenticated, service_role;

-- =============================================================================
-- pg_cron schedules
-- =============================================================================
--
-- Detector: every 5 min during RTH (13-19 UTC weekdays — covers 9:35 ET to
-- 4:00 ET; 5min cadence means a cross firing intraday lands within ~5min).
--
-- Grader (intraday + EOD): 20:30 UTC weekday (post-RTH +30min). Fills 5/15/
-- 30/60min and EOD outcomes for crosses fired earlier today.
--
-- Grader (NextClose): 20:30 UTC weekday +1 day. Fills NextClose for crosses
-- from prior trading day.
--
-- Per CLAUDE.md gotcha: $cron$ outer + $body$ inner — never $$ inside $$.
-- Per PR #57 docs-PR discipline + apikey header from invoke_edge_function
-- (which was updated 2026-05-07 to include apikey post-gateway-rewrite).

DO $cron$
BEGIN
  -- Idempotent unschedule first per feedback_pg_cron_schedule_idempotency.md
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-butterfly-detector-rth') THEN
    PERFORM cron.unschedule('ct-butterfly-detector-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-butterfly-detector-rth',
    '*/5 13-19 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-butterfly-detector', '{}'::jsonb);$body$
  );

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-butterfly-grader-intraday') THEN
    PERFORM cron.unschedule('ct-butterfly-grader-intraday');
  END IF;
  PERFORM cron.schedule(
    'ct-butterfly-grader-intraday',
    '30 20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-butterfly-grader', '{"window":"intraday_eod"}'::jsonb);$body$
  );

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-butterfly-grader-nextclose') THEN
    PERFORM cron.unschedule('ct-butterfly-grader-nextclose');
  END IF;
  PERFORM cron.schedule(
    'ct-butterfly-grader-nextclose',
    '30 20 * * 1-5',
    $body$SELECT public.invoke_edge_function('ct-butterfly-grader', '{"window":"nextclose"}'::jsonb);$body$
  );
END
$cron$;
