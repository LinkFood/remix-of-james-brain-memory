-- D3 Path 3 — autonomize nightly capture. Closes cascade #51
-- (manual-experiment-cadence-doesnt-survive-captain-life-cadence) structurally.
--
-- Schedule: 5 21 * * 1-5 UTC (17:05 ET, end-of-RTH + 5 min buffer). Captures
-- the trailing 24h wakeups; window-end is now() at fire time. Misses Saturday
-- and Sunday by design (no fresh wakeups). Memorial Day / federal holidays
-- still fire and write zero rows — harmless (the freshness invariant won't
-- be fooled because it checks rows in window, not row count > 0).
--
-- Idempotency: per feedback_pg_cron_schedule_idempotency.md, unschedule-then-
-- schedule inside a DO block to handle re-applies cleanly.
--
-- Auth: both `Authorization: Bearer` AND `apikey` headers per 5/7
-- supabase-gateway-rewrites-authorization class-kill — Supabase gateway
-- rewrites the Bearer JWT before it reaches Deno, so isServiceRoleRequest
-- checks the apikey header for gateway-passthrough.

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
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1) || '/functions/v1/ct-d3-feature-extension',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
          'apikey',        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
        ),
        body := jsonb_build_object('window_hours', 24)
      );
    $cron$
  );
END
$migration$;
