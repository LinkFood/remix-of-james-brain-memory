-- ============================================================================
-- Day 4: news ingester + EOD recap + lessons curator — crons + RPCs
-- ============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- Manual-trigger RPCs (for testing and ad-hoc runs)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._ct_post(_fn text)
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
    url     := _project_url || '/functions/v1/' || _fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || _service_key
    ),
    body    := '{}'::jsonb
  ) INTO _request_id;
  RETURN jsonb_build_object('request_id', _request_id, 'fired_at', now(), 'fn', _fn);
END
$fn$;

GRANT EXECUTE ON FUNCTION public._ct_post(text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_news_ingester()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-news-ingester'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_news_ingester() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_eod_recap()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-eod-recap'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_eod_recap() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_ct_lessons_curator()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-lessons-curator'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_lessons_curator() TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Cron schedules
-- ----------------------------------------------------------------------------
-- News: every 20 min, weekdays, extended hours 11:00-22:00 UTC
SELECT cron.schedule(
  'ct-news-ingester',
  '*/20 11-22 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-news-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);

-- EOD recap: weekdays at 21:30 UTC (post-close during EDT = 5:30pm ET)
SELECT cron.schedule(
  'ct-eod-recap',
  '30 21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-eod-recap',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);

-- Lessons curator: Sundays at 23:00 UTC
SELECT cron.schedule(
  'ct-lessons-curator',
  '0 23 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-lessons-curator',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
