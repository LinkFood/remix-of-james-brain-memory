-- ============================================================================
-- Fix ct-dream schedule so Saturday morning summarizes Friday's session.
--
-- OLD: '0 6 * * 1-5'  (Mon-Fri 6am UTC = 2am ET) — runs on Mon-Fri mornings,
--                     so Friday's session is never summarized because Saturday
--                     is not in the day-of-week set.
-- NEW: '0 6 * * 2-6'  (Tue-Sat 6am UTC = 2am ET) — Tue morning dreams Monday,
--                     ..., Sat morning dreams Friday. Sun/Mon mornings skip.
-- ============================================================================
SET search_path = public, extensions;

SELECT cron.unschedule('ct-dream');

SELECT cron.schedule(
  'ct-dream',
  '0 6 * * 2-6',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-dream',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
