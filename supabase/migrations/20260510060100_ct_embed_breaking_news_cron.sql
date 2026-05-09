-- ============================================================================
-- Phase 2 (Section B gap, breaking news): cron for ct-embed-breaking-news
-- backlog drainer.
--
-- Schedule: every 5 min, all hours (news ingestion runs 24/7 unlike RTH-
-- only flow tables — Tavily watcher fires off-hours during weekends + after
-- close, so the drainer must too). 50 rows/batch is enough to keep up with
-- the empirical ingestion rate (~50-150 rows/day baseline).
--
-- Idempotent unschedule-then-schedule per
-- feedback_pg_cron_schedule_idempotency.md.
-- ============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('ct-embed-breaking-news-24x7')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-embed-breaking-news-24x7');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-embed-breaking-news-24x7',
  '*/5 * * * *',
  $cron$ SELECT public.invoke_edge_function('ct-embed-breaking-news', '{"batch_size": 50}'::jsonb); $cron$
);
