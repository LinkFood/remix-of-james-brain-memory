-- ============================================================================
-- Morning Brief — RPC + cron schedule
-- Weekdays at 10:45 UTC (6:45am ET during EDT)
-- ============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_morning_brief()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-morning-brief'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_morning_brief() TO authenticated, service_role;

SELECT cron.schedule(
  'ct-morning-brief',
  '45 10 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-morning-brief',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
