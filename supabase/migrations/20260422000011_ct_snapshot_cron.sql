-- =============================================================================
-- 20260422000011_ct_snapshot_cron.sql
--
-- Wave G: pg_cron schedule for ct-ticker-snapshot-builder. Runs every 2 min
-- during RTH (13-20 UTC, weekdays). Upserts the 12-ticker quant cards into
-- ct_ticker_snapshots so downstream readers (generator, future daily brief)
-- get O(1) cached reads instead of re-aggregating per tick.
--
-- Standard Vault+net.http_post pattern with $cron$/$body$ nesting.
-- =============================================================================

SET search_path = public, extensions;

-- Unschedule any prior version of the job (idempotent redeploy).
DO $$
DECLARE
  j record;
BEGIN
  FOR j IN SELECT jobname FROM cron.job WHERE jobname = 'ct-ticker-snapshot-builder'
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;
END $$;

-- Snapshot builder: every 2 min, 13-20 UTC, weekdays.
SELECT cron.schedule(
  'ct-ticker-snapshot-builder',
  '*/2 13-20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-ticker-snapshot-builder',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body    := '{}'::jsonb
    );
  $cron$
);
