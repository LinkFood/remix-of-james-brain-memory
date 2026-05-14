-- Ship 2 — daily rotation cron for ct_contract_poller_log.
--
-- Deletes rows older than ct_config.contract_poller_log_retention_days
-- (default 14). Runs at 00:30 UTC, well after end of US extended hours.
--
-- Idempotency: per feedback_pg_cron_schedule_idempotency.md, unschedule-then-
-- schedule inside a DO block to handle re-applies cleanly.
--
-- No edge function — straight SQL inside the cron via DELETE statement. Reads
-- retention from ct_config at fire time so config edits take effect on next fire
-- without redeploying anything.

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct_contract_poller_log_rotate') THEN
    PERFORM cron.unschedule('ct_contract_poller_log_rotate');
  END IF;

  PERFORM cron.schedule(
    'ct_contract_poller_log_rotate',
    '30 0 * * *',
    $cron$
      DELETE FROM public.ct_contract_poller_log
      WHERE created_at < now() - make_interval(
        days => COALESCE(
          (SELECT (value)::text::int FROM public.ct_config WHERE key = 'contract_poller_log_retention_days'),
          14
        )
      );
    $cron$
  );
END
$migration$;
