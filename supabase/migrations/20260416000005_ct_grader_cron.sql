-- ============================================================================
-- ct-grader: pg_cron schedule + manual-trigger RPC
-- ============================================================================
SET search_path = public, extensions;

-- Manual trigger (for testing / ad-hoc)
CREATE OR REPLACE FUNCTION public.trigger_ct_grader()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
DECLARE
  _project_url text;
  _service_key text;
  _request_id  bigint;
BEGIN
  SELECT decrypted_secret INTO _project_url FROM vault.decrypted_secrets WHERE name = 'project_url';
  SELECT decrypted_secret INTO _service_key FROM vault.decrypted_secrets WHERE name = 'service_role_key';

  IF _project_url IS NULL OR _service_key IS NULL THEN
    RETURN jsonb_build_object('error', 'Vault missing project_url or service_role_key');
  END IF;

  SELECT net.http_post(
    url     := _project_url || '/functions/v1/ct-grader',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _service_key
    ),
    body    := '{}'::jsonb
  ) INTO _request_id;

  RETURN jsonb_build_object('request_id', _request_id, 'fired_at', now());
END
$fn$;

GRANT EXECUTE ON FUNCTION public.trigger_ct_grader() TO authenticated, service_role;

-- Production schedule: every 15 min. Runs around the clock — late-horizon
-- flags might have resolutions at EOD or next-day, not just market hours.
-- Cheap (no-op when nothing due).
SELECT cron.schedule(
  'ct-grader',
  '*/15 * * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-grader',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
