-- ct-event-calendar-ingester cron + RPC
-- Calendars change rarely, so 4hr cadence.
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_event_calendar_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-event-calendar-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_event_calendar_ingester() TO authenticated, service_role;

-- Every 4 hours.
SELECT cron.schedule(
  'ct-event-calendar-ingester',
  '0 */4 * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-event-calendar-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
