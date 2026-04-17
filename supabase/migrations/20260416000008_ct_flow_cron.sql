-- ct-flow-ingester cron + RPC
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_flow_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-flow-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_flow_ingester() TO authenticated, service_role;

-- Every 3 minutes during extended hours (10:00-22:00 UTC weekdays).
-- Flow is event-driven; we want freshness.
SELECT cron.schedule(
  'ct-flow-ingester',
  '*/3 10-22 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-flow-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
