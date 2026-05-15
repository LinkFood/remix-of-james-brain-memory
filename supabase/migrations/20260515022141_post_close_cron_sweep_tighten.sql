-- Item 2 — Post-close cron schedule sweep (sibling of jac-emission-detector
-- tightening goal #3 item 3 2026-05-15).
--
-- Phase A surveyed 237 active cron jobs; 86 fire at some minute in hour 20
-- UTC. Most are intentionally post-close-meaningful:
--   - EOD-anchored (fires AT 20:xx by design):
--       ct-eod-summary, ct-heatmap-snapshot-eod, ct-butterfly-grader-*,
--       ct-lean-score-close, ct-oi-snapshot-close, ct-earnings-pre-event-check
--   - 24x7 background autonomous (ambient, hits 20 incidentally):
--       backfill-embeddings, ct-cron-health-check, ct-embed-breaking-news,
--       ct-mcp-verification-runner, ct-system-warden, jac-heartbeat,
--       jac-watch-scheduler, reminder-timed, stale-task-cleanup, hunt-* jobs
--   - Extended-hours intentional (covers premarket + afterhours news/regime):
--       ct-disagreement-materializer, ct-news-ingester-weekday,
--       ct-tavily-news-watcher-weekday, ct-score-flow-continuous, ct-watcher,
--       ct-embed-specialist-reads-rth, ct-embed-tape-commentary-rth,
--       ct-pulse-tick, ct-regime-capture-rth, ct-technicals-ingester
--
-- Clear noise candidates in the 20:00-20:59 window are jobs that Slack-push
-- to the captain about market-state actions the captain CAN'T TAKE post-
-- close. Two clear cases:
--
-- 1. ct-trade-advisories (7,22,37,52 13-20 * * 1-5)
--    Emits advisory recommendations for OPEN TRADES via Claude Haiku.
--    ctSlackPushDirect at urgency >= 4 (ct-trade-advisories/index.ts:32 +
--    threshold logic). At 20:07 / 20:22 / 20:37 / 20:52 UTC = 16:07-16:52
--    ET — captain can't act on advisories during market close. Tightening
--    to 13-19 removes 4 post-close fires per weekday, preserves the 19:07-
--    19:52 fires that capture late-RTH advisories.
--
-- 2. ct-curiosity (7,37 13-20 * * 1-5)
--    Proactive Claude exploratory detection. Slack-pushes at
--    attention_score >= 60 (ct-curiosity/index.ts:33). Post-close
--    curiosity fires at 20:07 + 20:37 are exploratory observations on
--    tape that's already settled — captain can't act on the signal
--    intraday. Tightening to 13-19 removes 2 post-close fires per weekday.
--
-- Idempotent pattern per feedback_pg_cron_schedule_idempotency.md.

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-trade-advisories') THEN
    PERFORM cron.unschedule('ct-trade-advisories');
  END IF;
  PERFORM cron.schedule(
    'ct-trade-advisories',
    '7,22,37,52 13-19 * * 1-5',
    $body$SELECT public._ct_post('ct-trade-advisories');$body$
  );

  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-curiosity') THEN
    PERFORM cron.unschedule('ct-curiosity');
  END IF;
  PERFORM cron.schedule(
    'ct-curiosity',
    '7,37 13-19 * * 1-5',
    $body$SELECT public._ct_post('ct-curiosity');$body$
  );
END
$cron$;
