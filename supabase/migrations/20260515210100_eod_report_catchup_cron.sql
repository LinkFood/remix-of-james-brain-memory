-- Self-healing catch-up cron for ct-eod-report.
--
-- 2026-05-15 incident: the scheduled 21:00 UTC ct-eod-report run produced no
-- ct_eod_reports row (transient single-attempt failure — slow edge cold-start
-- dropped at the pg_net default timeout). The function is healthy; a re-fired
-- run at 23:16 UTC succeeded with a full scorecard. The gap was the absence of
-- any retry and any same-day alarm.
--
-- This catch-up job runs every 20 minutes from 21:00-22:59 UTC on weekdays and
-- re-fires ct-eod-report ONLY if no ct_eod_reports row exists yet for today's
-- ET session_date. ct-eod-report upserts on the session_date UNIQUE constraint,
-- so a re-fire is fully idempotent and safe.
--
-- session_date logic mirrors ct-eod-report itself (nyDateToday) and the existing
-- eod_report_yesterday_landed warden invariant:
--   (now() AT TIME ZONE 'America/New_York')::date
--
-- triggered_by: ct-eod-report's Triggered type accepts only manual | rerun |
-- scheduled (index.ts:508-511) — 'catchup' is NOT a valid value and would fall
-- through to 'scheduled'. Per scope, this uses 'rerun' (already valid) so the
-- function records the re-fire honestly without a function-side type change.
-- ct-eod-report is NOT redeployed by this migration.
--
-- pg_cron idempotency per feedback_pg_cron_schedule_idempotency.md — bare
-- cron.schedule() is not reliably idempotent across pg_cron versions, so the
-- job is unscheduled (IF EXISTS) then re-scheduled inside a DO block.
-- Delimiter discipline: $cron$/$body$, never $$ inside $$.

SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.eod_report_catchup()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $body$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.ct_eod_reports
    WHERE session_date = (now() AT TIME ZONE 'America/New_York')::date
  ) THEN
    PERFORM public.invoke_edge_function(
      'ct-eod-report',
      '{"triggered_by":"rerun"}'::jsonb
    );
  END IF;
END;
$body$;

COMMENT ON FUNCTION public.eod_report_catchup() IS
  'Self-healing catch-up for ct-eod-report — re-fires the edge function (triggered_by=rerun) only when no ct_eod_reports row exists for today ET session_date. Scheduled */20 21-22 * * 1-5. Idempotent via session_date UNIQUE upsert. Added 2026-05-15 after a transient scheduled-run miss.';

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-eod-report-catchup') THEN
    PERFORM cron.unschedule('ct-eod-report-catchup');
  END IF;

  PERFORM cron.schedule(
    'ct-eod-report-catchup',
    '*/20 21-22 * * 1-5',
    $job$SELECT public.eod_report_catchup();$job$
  );
END;
$cron$;
