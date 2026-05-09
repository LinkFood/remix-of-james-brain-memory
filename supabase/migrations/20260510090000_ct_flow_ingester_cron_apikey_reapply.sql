-- ct-flow-ingester crons — add apikey header (RE-APPLY 2026-05-09).
--
-- 2026-05-09 morning slate-clean discovered the original migration
-- 20260510040000_ct_flow_ingester_cron_apikey_fix.sql (PR #70, merged
-- 2026-05-09 11:09 UTC) was MERGED to main but NEVER APPLIED to remote —
-- its timestamp prefix collided with the already-applied
-- 20260510040000_ct_butterfly_cross_events.sql, so the supabase migration
-- system silently no-op'd the apply. The cron commands on the remote DB
-- still contain the buggy Authorization-only headers and ct_flow_alerts
-- may not be ingesting RTH.
--
-- Cascade catalog instance:
--   docs-PR-merge-doesnt-imply-migration-applied
-- Detection: `npx supabase migration list` shows duplicate Local entries
-- with one row missing the Remote column. The migration file shipped, the
-- file is on main, but the schema_migrations table never recorded a second
-- 20260510040000 apply, so PostgreSQL never ran the SQL.
--
-- Companion class to phantom-schema-migrations-record (5/8 PR #80 incident
-- where remote schema_migrations recorded a row but the table didn't
-- actually exist — opposite direction same root: trust schema_migrations
-- is dangerous when timestamps duplicate).
--
-- This re-ship uses a fresh timestamp + identical idempotent body
-- (DROP + re-CREATE the 3 ct-flow-ingester crons). Safe to re-run; if the
-- bug isn't live it's a no-op.
--
-- Original incident header preserved below for archeology.
-- ============================================================================
--
-- 2026-05-08 INCIDENT: captain reports "nothing hitting the tape, flow
-- butterflies broken." Empirical state at diagnosis time:
--   - ct_flow_alerts last write: 2026-05-07 20:15 UTC (yesterday's close)
--   - 13:30 UTC marketwide cron fired (30+ MCP calls, all status 200)
--   - 13:30 UTC fire wrote ZERO rows to ct_flow_alerts
--   - Manual invocation via invoke_edge_function (apikey path) writes rows fine
--   - Per-ticker downstream tables (ct_nope_minute, ct_greek_flow_minute,
--     ct_net_premium_ticks) DID get fresh writes from same cron fires
--
-- Same shape as 2026-05-07 service-role-key gateway-rewrite incident
-- (feedback_supabase_gateway_rewrites_authorization.md). Cron last_run_status=
-- succeeded; HTTP dispatch reports OK; upstream observability says clean;
-- but write-side falls silently on the trip from edge function back to DB.
--
-- The 5/07 mass-apikey-fix migration (20260507140000_tmp_add_apikey_to_crons)
-- updated 154 cron commands but DID NOT touch the 3 ct-flow-ingester crons —
-- they bypass the _ct_post() helper and use raw net.http_post with
-- Authorization-only headers. The gateway rewrites Authorization to a
-- short-lived ES256 JWT before reaching Deno; apikey passes through unmodified.
-- isServiceRoleRequest checks apikey first; without it, the function may
-- accept the request (auth-permissive fallback), but writes can fail at
-- supabase-js client layer because the client also needs the apikey for
-- correct service-role identification.
--
-- Fix shape: drop and re-create all 3 ct-flow-ingester crons with apikey
-- header alongside Authorization. Mirrors the pattern already in 154 other
-- crons post-5/07 (sister _ct_post helper has the same fix).
--
-- Also: same migration regenerates the cron entries which kills any latent
-- pg_cron-side state (cron registration drift class — caught earlier in
-- session via methodology-patterns.md "growth-cron-vs-snapshot-cron-distinction").

SET search_path = public, extensions;

DO $cron$
BEGIN
  -- 1) ct-flow-ingester-perticker-rth (every 5min RTH)
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flow-ingester-perticker-rth') THEN
    PERFORM cron.unschedule('ct-flow-ingester-perticker-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-flow-ingester-perticker-rth',
    '*/5 13-20 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-flow-ingester',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'apikey',        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{"per_ticker_only":true}'::jsonb,
        timeout_milliseconds := 60000
      )
    $body$
  );

  -- 2) ct-flow-ingester-perticker-offrth (pre/post-market every 15min)
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flow-ingester-perticker-offrth') THEN
    PERFORM cron.unschedule('ct-flow-ingester-perticker-offrth');
  END IF;
  PERFORM cron.schedule(
    'ct-flow-ingester-perticker-offrth',
    '*/15 10-12,21-22 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-flow-ingester',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'apikey',        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{"per_ticker_only":true}'::jsonb,
        timeout_milliseconds := 60000
      )
    $body$
  );

  -- 3) ct-flow-ingester-marketwide (every 30min RTH)
  -- Empty body = perTickerOnly defaults to false → ingestFlowAlerts runs
  -- which writes the market-wide flow rows to ct_flow_alerts.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flow-ingester-marketwide') THEN
    PERFORM cron.unschedule('ct-flow-ingester-marketwide');
  END IF;
  PERFORM cron.schedule(
    'ct-flow-ingester-marketwide',
    '0,30 13-20 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-flow-ingester',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'apikey',        (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key'),
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 60000
      )
    $body$
  );
END
$cron$;
