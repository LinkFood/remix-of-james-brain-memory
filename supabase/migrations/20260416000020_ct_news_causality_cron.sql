-- ============================================================================
-- News → Flow causality — RPC + cron
-- Runs every 15 minutes. Analyzes any ct_news_analyses rows from the last
-- 24 hours that don't yet have a ct_news_causality row.
-- ============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.trigger_ct_news_causality()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-news-causality'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_news_causality() TO authenticated, service_role;

SELECT cron.schedule(
  'ct-news-causality',
  '*/15 * * * *',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-news-causality',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
