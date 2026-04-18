-- =============================================================================
-- 20260422000009_ct_brief_crons.sql
--
-- Wave F: Daily Brief + Tavily breaking-news watcher + urgent re-brief.
-- Cron schedules + manual-trigger RPCs for the two edge functions shipped
-- this wave.
--
-- Schedules (UTC):
--   ct-tavily-news-watcher  : */30 11-22 * * 1-5   (weekdays, every 30 min)
--                             AND    0 */2 * * 6,0 (weekends, every 2h)
--   ct-daily-brief          : 0 11 * * 1-5         (weekday mornings, 7am ET)
--
-- Re-briefs are NOT cron-scheduled — they are fired from inside
-- ct-tavily-news-watcher (best-effort HTTP call) whenever a classified
-- breaking-news row has severity >= claude_breaking_news_severity_rebrief.
--
-- Manual-trigger RPCs mirror the ct-* cron family. The brief trigger accepts
-- (triggered_by, reason) so operators can fire a manual re-brief from /crons.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- Manual-trigger RPCs
-- -----------------------------------------------------------------------------

-- Tavily news watcher — zero-arg, empty body.
CREATE OR REPLACE FUNCTION public.trigger_ct_tavily_news_watcher()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions
AS $fn$ SELECT public._ct_post('ct-tavily-news-watcher'); $fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_tavily_news_watcher() TO authenticated, service_role;

-- Daily brief — accepts (triggered_by, reason) and forwards as body.
CREATE OR REPLACE FUNCTION public.trigger_ct_daily_brief(
  p_triggered_by text DEFAULT 'manual',
  p_reason       text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $fn$
DECLARE
  _body jsonb;
BEGIN
  _body := jsonb_build_object('triggered_by', COALESCE(p_triggered_by, 'manual'));
  IF p_reason IS NOT NULL AND length(p_reason) > 0 THEN
    _body := _body || jsonb_build_object('reason', p_reason);
  END IF;
  RETURN public._ct_post_with_body('ct-daily-brief', _body);
END;
$fn$;
GRANT EXECUTE ON FUNCTION public.trigger_ct_daily_brief(text, text) TO authenticated, service_role;

-- -----------------------------------------------------------------------------
-- pg_cron schedules. $cron$ outer + $body$ inner — never $$ inside $$.
-- -----------------------------------------------------------------------------

-- Unschedule any prior versions of these jobs (idempotent redeploy).
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN SELECT jobname FROM cron.job
           WHERE jobname IN (
             'ct-tavily-news-watcher-weekday',
             'ct-tavily-news-watcher-weekend',
             'ct-daily-brief'
           )
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

-- Tavily weekday: every 30 min, 11:00-22:00 UTC, Mon-Fri.
SELECT cron.schedule(
  'ct-tavily-news-watcher-weekday',
  '*/30 11-22 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-tavily-news-watcher',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Tavily weekend: every 2 hours, Sat + Sun.
SELECT cron.schedule(
  'ct-tavily-news-watcher-weekend',
  '0 */2 * * 6,0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-tavily-news-watcher',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);

-- Daily brief: 11:00 UTC weekdays (7am ET).
SELECT cron.schedule(
  'ct-daily-brief',
  '0 11 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-daily-brief',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := jsonb_build_object('triggered_by', 'scheduled')
    );
  $cron$
);
