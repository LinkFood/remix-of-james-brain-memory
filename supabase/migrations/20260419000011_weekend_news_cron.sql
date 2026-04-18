-- ============================================================================
-- Weekend news coverage for ct-news-ingester
--
-- Context: prior cron 'ct-news-ingester' ran every 20 min weekdays only
-- (*/20 11-22 * * 1-5). From Friday 22:00 UTC through Monday 11:00 UTC
-- (~61 hours) no news was captured. Earnings prelims, Fed, geopolitics —
-- all lost. The Monday morning brief's weekend_news section was blank.
--
-- This migration:
--   1. Unschedules the existing 'ct-news-ingester' job.
--   2. Re-creates it as two separate jobs so weekday behavior is byte-for-
--      byte unchanged and weekend is a distinct schedule we can tune/kill.
--   3. Weekend job posts {"is_weekend": true} so the function can use a
--      longer lookback + skip low-signal Claude calls.
--
-- Dedupe is preserved: ct-news-ingester's getSeenHeadlines() uses a 48h
-- window on ct_news_analyses.created_at filtered by instrument. Friday's
-- 22:00 ingestion and Saturday's first hourly run both read the same
-- (instrument, news_headline) set — the Sat run sees Friday's inserts and
-- skips them. No boundary gap.
-- ============================================================================
SET search_path = public, extensions;

-- 1. Drop the old combined schedule.
SELECT cron.unschedule('ct-news-ingester');

-- 2a. Weekday job — unchanged cadence, empty body (default = weekday mode).
SELECT cron.schedule(
  'ct-news-ingester-weekday',
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

-- 2b. Weekend job — every hour on Sat (6) and Sun (0). is_weekend flag
--     tells the function to widen the per-ticker fetch window and skip
--     Claude analysis on low-significance headlines to conserve tokens
--     during quiet sessions.
SELECT cron.schedule(
  'ct-news-ingester-weekend',
  '0 * * * 6,0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-news-ingester',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{"is_weekend": true}'::jsonb
    )
  $cron$
);
