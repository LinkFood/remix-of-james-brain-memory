-- =============================================================================
-- 20260420000033_fundamentals_cron.sql
--
-- Weekly fundamentals sync — Sundays 22:00 UTC.
--
-- Why Sunday 22:00 UTC (6 PM ET):
--   - Well after Friday close (no earnings events in-flight)
--   - 10 hours before ct-earnings-sync (Sun 12:00 UTC next cycle) — avoids
--     hammering UW with overlapping per-ticker loops
--   - Gives UW the full weekend to settle any vendor-side data revisions
--
-- Uses the standard vault.decrypted_secrets pattern. No $$ inside $$.
-- =============================================================================

SET search_path = public, extensions;

SELECT cron.schedule(
  'ct-fundamentals-sync',
  '0 22 * * 0',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-fundamentals-sync',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
