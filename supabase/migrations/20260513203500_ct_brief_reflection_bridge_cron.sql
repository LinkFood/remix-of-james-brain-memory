-- ============================================================================
-- Ship 6 of Bundle 2 — ct-brief-reflection bridge cron + trigger RPC
--
-- Path A (captain ack 2026-05-13): bridge ct_eod_reports.morning_brief_scorecard
-- → ct_daily_briefs.accuracy_score + accuracy_notes. Deterministic digest, no
-- new Claude calls. Closes the Property loop at brief layer using the grading
-- work ct-eod-report already produces, rather than shipping a duplicate
-- Haiku reflection cron.
--
-- Cron schedule: 30 21 * * 1-5 UTC (21:30 UTC weekdays = 5:30 PM ET = 30 min
-- after ct-eod-report writes at 21:00 UTC). No conflicts at 21:30 with
-- ct-session-analog or ct-eod-specialist-narrative (verified in Ship 6 Phase A
-- — read/write sets don't overlap).
--
-- Trigger RPC: trigger_ct_brief_reflection(p_session_date date DEFAULT NULL,
--                                          p_backfill boolean DEFAULT false)
--   - p_session_date NULL + p_backfill false  → today's session
--   - p_session_date 'YYYY-MM-DD'             → that specific session
--   - p_backfill true                         → ALL historical EOD reports
--                                               with morning_brief_id NOT NULL
--
-- Idempotent unschedule-then-schedule per feedback_pg_cron_schedule_idempotency.md.
-- apikey-header pattern handled by invoke_edge_function.
-- ============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1. trigger_ct_brief_reflection RPC — manual + cron entry point
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.trigger_ct_brief_reflection(
  p_session_date date DEFAULT NULL,
  p_backfill     boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $fn$
DECLARE
  _body jsonb;
BEGIN
  IF p_backfill THEN
    _body := jsonb_build_object('backfill', true);
  ELSIF p_session_date IS NOT NULL THEN
    _body := jsonb_build_object('session_date', p_session_date::text);
  ELSE
    _body := jsonb_build_object();
  END IF;
  RETURN public.invoke_edge_function('ct-brief-reflection', _body);
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_brief_reflection(date, boolean)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.trigger_ct_brief_reflection IS
  'Path A bridge — translates ct_eod_reports.morning_brief_scorecard into ct_daily_briefs.accuracy_score + accuracy_notes. Deterministic digest, no Claude calls. Three modes: today (defaults), specific session_date, or backfill=true for all historical. Property loop closure at brief layer (Ship 6 of Bundle 2, 2026-05-13).';

-- ----------------------------------------------------------------------------
-- 2. Cron schedule — 21:30 UTC weekdays, 30 min after ct-eod-report write
-- ----------------------------------------------------------------------------
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-brief-reflection-rth') THEN
    PERFORM cron.unschedule('ct-brief-reflection-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-brief-reflection-rth',
    '30 21 * * 1-5',
    $body$ SELECT public.trigger_ct_brief_reflection(); $body$
  );
END
$cron$;
