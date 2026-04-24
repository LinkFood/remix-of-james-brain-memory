-- ============================================================================
-- Co-Trader v2 — ct-flag-grader cron (every 30 min)
-- ============================================================================
-- Two jobs inside the edge function:
--   Job A: grade any ct_flags with horizon_ts <= now()
--   Job B: T+1 OI confirmation (upgrade active → conviction)
--
-- This closes the self-learning loop. Flag → grade → memory → pattern.
-- ============================================================================

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_flag_grader()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-flag-grader'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_flag_grader() TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flag-grader') THEN
    PERFORM cron.unschedule('ct-flag-grader');
  END IF;

  PERFORM cron.schedule(
    'ct-flag-grader',
    '*/30 * * * *',
    $body$ SELECT public.trigger_ct_flag_grader(); $body$
  );
END $$;

COMMENT ON FUNCTION public.trigger_ct_flag_grader IS
  'V2 cron trigger for ct-flag-grader (every 30 min). Closes flag → grade → memory loop.';
