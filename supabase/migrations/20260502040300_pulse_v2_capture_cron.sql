-- =============================================================================
-- 20260502040300_pulse_v2_capture_cron.sql
--
-- Pulse v2 producer cron — schedules ct-regime-capture for RTH (every 5 min)
-- and off-hours (hourly). Idempotent: unschedule first, then schedule.
--
-- Cadence (per design):
--   - rth      : */5 13-21 UTC weekdays  (covers 9 AM ET pre-bell heat through
--                                          5 PM ET post-close minute, +/- DST slop)
--   - offhours : 0  10-12,21-22 UTC weekdays
-- Wraps `public.invoke_edge_function` (commit 20260227000001) which uses
-- vault keys `project_url` + `service_role_key` to net.http_post the function.
-- =============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_regime_capture()
RETURNS bigint LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public.invoke_edge_function('ct-regime-capture', '{}'::jsonb); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_regime_capture() TO authenticated, service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-regime-capture-rth') THEN
    PERFORM cron.unschedule('ct-regime-capture-rth');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-regime-capture-offhours') THEN
    PERFORM cron.unschedule('ct-regime-capture-offhours');
  END IF;

  -- RTH: every 5 min, weekdays 13-21 UTC (9 AM ET pre-bell through 5 PM ET).
  PERFORM cron.schedule(
    'ct-regime-capture-rth',
    '*/5 13-21 * * 1-5',
    $body$ SELECT public.trigger_ct_regime_capture(); $body$
  );

  -- Off-hours: hourly during the morning ramp + evening tail. Specifically:
  --   10-12 UTC weekdays  (6-8 AM ET — overnight tape state heading into open)
  --   21-22 UTC weekdays  (5-6 PM ET — post-close evolution)
  -- Weekend/dead-of-night left to warden's weekend pass invariant logic.
  PERFORM cron.schedule(
    'ct-regime-capture-offhours',
    '0 10-12,21-22 * * 1-5',
    $body$ SELECT public.trigger_ct_regime_capture(); $body$
  );
END
$cron$;

-- Bump the timeout on the underlying http_post calls so a slow Voyage round
-- doesn't get killed mid-batch. invoke_edge_function uses net.http_post; the
-- timeout lives on the request itself. The default in invoke_edge_function is
-- 30000 ms (30s); we override here only if invoke_edge_function exposes a
-- timeout knob. Defensive: most Voyage calls return well under 5s, watchlist
-- size is 10 + 1 market-wide, so worst-case ~11 sequential embeds = 11 * 1s.

COMMENT ON FUNCTION public.trigger_ct_regime_capture IS
  'Pulse v2 capture cron trigger. RTH every 5min weekdays 13-21 UTC + offhours hourly 10-12,21-22 UTC weekdays.';
