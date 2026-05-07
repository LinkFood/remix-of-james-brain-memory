-- D3 Feature-Isolation Experiment — daily window-extension cron
--
-- Status: DESIGN-ONLY 2026-05-08. NOT REGISTERED. Do not run until
-- feature_reconstruction.ts loaders are filled in and verified per
-- brief §4 reconstructibility check.
--
-- Schedule: daily 21:05 UTC (~17:05 ET, end-of-RTH + 5 min buffer).
-- No weekend cadence (no fresh wakeups Sat/Sun).
-- pg_cron uses dollar-tag nesting per gotcha — $cron$ outer / $body$ inner.
--
-- Idempotency: per feedback_pg_cron_schedule_idempotency.md, always
-- unschedule-then-schedule inside a DO block.

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-d3-feature-extension') THEN
    PERFORM cron.unschedule('ct-d3-feature-extension');
  END IF;

  PERFORM cron.schedule(
    'ct-d3-feature-extension',
    '5 21 * * 1-5',
    $cron$
      SELECT net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-d3-feature-extension',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body := jsonb_build_object('window_hours', 24)
      );
    $cron$
  );
END
$migration$;

-- Note: the above assumes a wrapper edge function `ct-d3-feature-extension`
-- which would be the autonomous-mode (Tenet 26) shim around the analysis-mode
-- script. If James prefers to run the script manually nightly from terminal,
-- DELETE THIS FILE — no autonomous-mode shim needed for an experiment.
--
-- Default recommendation: manual terminal run during the 14-day window
-- (3 weeks of pulls). Promote to cron only if the analysis itself
-- becomes recurring infrastructure post-experiment.
