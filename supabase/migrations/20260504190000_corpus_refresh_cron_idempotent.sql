-- Idempotent re-schedule of the corpus refresh cron.
--
-- The original migration (20260502060000_ct_flag_analysis_corpus.sql:348) used
-- a bare `SELECT cron.schedule(...)` to register
-- `ct-flag-analysis-corpus-refresh-nightly` at 04:00 UTC daily.
--
-- Observed 2026-05-04 18:30 UTC: warden invariant
-- `flag_analysis_corpus_freshness` reporting lag=69.75h, growing 0.50h per
-- 30-min warden tick. That linear growth means zero refreshes since Saturday's
-- initial seed — the Sun + Mon 04 UTC fires did not run. RPC was verified
-- healthy by manual fire at 18:43 UTC (834ms, 5,825 rows refreshed cleanly).
--
-- Root cause: cron.schedule() with the same jobname behaves differently across
-- pg_cron versions. v1.4+ replaces; older versions can silently no-op or error
-- if the job already exists (e.g., from a re-applied migration). The
-- canonical safe pattern (see 20260426000062_specialist_scoreboard_cron.sql)
-- is unschedule-then-schedule inside a DO block.
--
-- Class-level prevention: every pg_cron registration migration uses the
-- IF EXISTS unschedule-then-schedule pattern. Bare cron.schedule() should
-- never appear in a migration after this point.

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flag-analysis-corpus-refresh-nightly') THEN
    PERFORM cron.unschedule('ct-flag-analysis-corpus-refresh-nightly');
  END IF;

  PERFORM cron.schedule(
    'ct-flag-analysis-corpus-refresh-nightly',
    '0 4 * * *',
    $body$SELECT public.refresh_flag_analysis_corpus(true);$body$
  );
END
$cron$;
