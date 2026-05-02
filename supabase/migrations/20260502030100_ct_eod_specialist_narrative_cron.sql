-- =============================================================================
-- 20260502030100_ct_eod_specialist_narrative_cron.sql
--
-- Cron schedule for ct-eod-specialist-narrative.
-- 4:30 PM ET (= 21:30 UTC during ET-DST May 2026) weekdays — fires after
-- EOD grade-pass at 4:00 PM ET so most flags expiring at horizon today
-- have outcome labels by the time the narrative pulls them.
-- =============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_eod_specialist_narrative()
RETURNS bigint LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public.invoke_edge_function('ct-eod-specialist-narrative', '{}'::jsonb); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_eod_specialist_narrative() TO authenticated, service_role;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-eod-specialist-narrative') THEN
    PERFORM cron.unschedule('ct-eod-specialist-narrative');
  END IF;
  PERFORM cron.schedule(
    'ct-eod-specialist-narrative',
    '30 21 * * 1-5',
    $body$ SELECT public.trigger_ct_eod_specialist_narrative(); $body$
  );
END
$cron$;

COMMENT ON FUNCTION public.trigger_ct_eod_specialist_narrative IS
  'Daily 4:30 PM ET cron — generates per-ticker EOD narrative summaries. Read-only consumer of specialist context. C1-safe.';
