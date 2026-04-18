-- =============================================================================
-- 20260420000025_earnings_sync_cron.sql
--
-- Two crons:
--   1. ct-earnings-sync            — Sunday 12:00 UTC (weekly, 12 UW calls)
--   2. ct-earnings-pre-event-check — every hour Mon–Fri 13:00–21:00 UTC
--                                    (covers 9AM–5PM ET RTH window including
--                                    one post-close tick to catch 16:00 AMC)
--
-- Both use the standard vault.decrypted_secrets pattern. No $$ inside $$.
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- 1) Weekly earnings sync — Sundays 12:00 UTC.
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-earnings-sync',
  '0 12 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-earnings-sync',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);

-- -----------------------------------------------------------------------------
-- 2) Hourly pre-event check — Mon–Fri 13:00–21:00 UTC (RTH + 1 post-close).
--    Covers the 48h / 24h / 1h thresholds for both BMO and AMC earnings.
-- -----------------------------------------------------------------------------
SELECT cron.schedule(
  'ct-earnings-pre-event-check',
  '0 13-21 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-earnings-pre-event-check',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    )
  $cron$
);
