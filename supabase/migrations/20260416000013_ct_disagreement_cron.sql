-- ============================================================================
-- ct-disagreement-materializer — cron + manual-trigger RPC
-- Runs every 10 min during weekday market hours (11:00–22:00 UTC ≈ 7am–6pm ET).
-- Materializes rows in ct_disagreements when James and Claude disagree
-- on the same instrument + horizon within a 4-hour window.
-- ============================================================================
SET search_path = public, extensions;

-- Manual trigger RPC
CREATE OR REPLACE FUNCTION public.trigger_ct_disagreement_materializer()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-disagreement-materializer'); $fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_disagreement_materializer()
  TO authenticated, service_role;

-- Production schedule: every 10 min, weekdays, extended market hours
SELECT cron.schedule(
  'ct-disagreement-materializer',
  '*/10 11-22 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-disagreement-materializer',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
