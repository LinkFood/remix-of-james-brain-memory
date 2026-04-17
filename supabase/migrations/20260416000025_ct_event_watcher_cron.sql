-- ct-event-watcher: every 1 min during market hours, looks for structural
-- events and fires ct-watcher if detected. Cooldown is enforced in-function.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_event_watcher()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-event-watcher'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_event_watcher() TO authenticated, service_role;

-- Every minute, weekdays 12-22 UTC (8am-6pm ET extended hours)
SELECT cron.schedule(
  'ct-event-watcher',
  '* 12-21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-event-watcher',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
