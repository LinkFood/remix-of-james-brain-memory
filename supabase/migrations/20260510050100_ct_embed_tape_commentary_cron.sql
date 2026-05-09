-- ============================================================================
-- Phase 1 (Section B gap #2): cron for ct-embed-tape-commentary backlog
-- drainer.
--
-- Steady-state schedule: every 5 minutes during RTH (13:00-21:00 UTC, M-F).
-- Producer (ct-tape-reader) runs every 10 min RTH; cron at 5 min cadence
-- catches any write-time embed miss within 5 min.
--
-- During the rollout window (~1 hour from migration apply), this cron also
-- drains the historical 1.1k row backlog. After that, it's mostly idempotent
-- no-ops (count query + 0 rows to process).
--
-- Pattern matches every other cron in the system: idempotent unschedule-then-
-- schedule inside DO block per feedback_pg_cron_schedule_idempotency.md.
-- ============================================================================

DO $$
BEGIN
  PERFORM cron.unschedule('ct-embed-tape-commentary-rth')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-embed-tape-commentary-rth');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-embed-tape-commentary-rth',
  '*/5 13-21 * * 1-5',
  $cron$ SELECT public.invoke_edge_function('ct-embed-tape-commentary', '{"batch_size": 50}'::jsonb); $cron$
);

COMMENT ON EXTENSION pg_cron IS
  'ct-embed-tape-commentary-rth: every 5 min RTH 13-21 UTC weekdays. Drains tape_commentary_embedding backlog + catches write-time misses. Producer runs every 10 min; this catches misses within 5 min.';
