-- =============================================================================
-- 20260430134500_flow_ingester_timeout_fix.sql
--
-- Live triage 2026-04-30 ~9:35 ET. ct_flow_alerts produced 0 rows from cron
-- fires today despite cron showing last_run_status=succeeded. Manual RPC
-- fires of trigger_ct_flow_ingester completed in ~4.8s with 17+ inserts
-- and net._http_response status_code=200. Cron-fired calls had no recorded
-- response.
--
-- Root cause: pg_net's net.http_post timeout_milliseconds default cancels
-- the HTTP call before ct-flow-ingester (which serial-loops 30+ UW calls
-- across 10 watchlist tickers, ~4-5s total) returns. The function was
-- being killed mid-flight from cron context. Manual RPC fires sometimes
-- got through because of caching/timing variance.
--
-- Fix: explicitly pass timeout_milliseconds := 60000 (60s) on every cron
-- schedule that calls a function known to run >1s. Tenet 15: this class
-- of failure becomes impossible going forward — cron HTTP calls now have
-- enough budget to actually complete.
--
-- Scope tonight (live triage): the 4 crons known broken from this morning.
-- Saturday weekend work: audit ALL cron schedules using net.http_post,
-- standardize on a _ct_post_long helper or 60s default.
-- =============================================================================

SET search_path = public, extensions;

DO $cron$
BEGIN
  -- 1) ct-flow-ingester-perticker-rth (*/5 13-20 * * 1-5)
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
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{"per_ticker_only":true}'::jsonb,
        timeout_milliseconds := 60000
      )
    $body$
  );

  -- 2) ct-flow-ingester-perticker-offrth (*/15 10-12,21-22 * * 1-5)
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
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{"per_ticker_only":true}'::jsonb,
        timeout_milliseconds := 60000
      )
    $body$
  );

  -- 3) ct-flow-ingester-marketwide (0,30 13-20 * * 1-5)
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
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 60000
      )
    $body$
  );
END
$cron$;
