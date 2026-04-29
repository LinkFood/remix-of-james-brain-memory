-- Pause ct-print-grader crons while we collapse ct_contract_tracks to
-- per-symbol identity. Phase 4 migration re-creates them after the UNIQUE
-- INDEX is in place.
--
-- We unschedule (not just toggle active) because the migration role doesn't
-- have UPDATE on cron.job — but it does have execute on cron.unschedule /
-- cron.schedule. Same effect: zero new WORKING rows land during the merge.
SELECT cron.unschedule('ct-print-grader-rth')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-print-grader-rth');
SELECT cron.unschedule('ct-print-grader-offhours')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-print-grader-offhours');
