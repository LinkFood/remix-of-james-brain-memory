-- =============================================================================
-- 20260430153100_ct_flow_heatmap_cron.sql
--
-- Cron schedules for ct-heatmap-snapshot. Three jobs:
--
--   1. ct-heatmap-snapshot-rth     (*/5 13-20 * * 1-5) — every 5 min RTH
--   2. ct-heatmap-snapshot-offrth  (0 10-12,21-22 * * 1-5) — hourly off-RTH
--   3. ct-heatmap-snapshot-eod     (5 20 * * 1-5) — 4:05 PM ET marker
--
-- Each net.http_post explicitly sets timeout_milliseconds := 60000. pg_net's
-- default cancels long-running edge functions mid-flight (commit b22a3ff,
-- 2026-04-30 live triage of ct-flow-ingester). Snapshot loops over the
-- watchlist and pages ct_flow_alerts per ticker, so this is in the same
-- "needs >1s" class as ct-flow-ingester.
--
-- Idempotent: each schedule is preceded by a guarded unschedule.
-- =============================================================================

SET search_path = public, extensions;

DO $cron$
BEGIN
  -- 1) ct-heatmap-snapshot-rth — every 5 min during RTH
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-heatmap-snapshot-rth') THEN
    PERFORM cron.unschedule('ct-heatmap-snapshot-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-heatmap-snapshot-rth',
    '*/5 13-20 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-heatmap-snapshot',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 60000
      )
    $body$
  );

  -- 2) ct-heatmap-snapshot-offrth — hourly off-RTH
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-heatmap-snapshot-offrth') THEN
    PERFORM cron.unschedule('ct-heatmap-snapshot-offrth');
  END IF;
  PERFORM cron.schedule(
    'ct-heatmap-snapshot-offrth',
    '0 10-12,21-22 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-heatmap-snapshot',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{}'::jsonb,
        timeout_milliseconds := 60000
      )
    $body$
  );

  -- 3) ct-heatmap-snapshot-eod — 4:05 PM ET (20:05 UTC) post-close marker
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-heatmap-snapshot-eod') THEN
    PERFORM cron.unschedule('ct-heatmap-snapshot-eod');
  END IF;
  PERFORM cron.schedule(
    'ct-heatmap-snapshot-eod',
    '5 20 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-heatmap-snapshot',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{"mark_eod":true}'::jsonb,
        timeout_milliseconds := 60000
      )
    $body$
  );
END
$cron$;
