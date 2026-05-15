-- Item 3 — jac-emission-detector cron tighten to RTH-only.
--
-- Bug: original schedule `* 13-20 * * 1-5` includes the 20:00-20:59 UTC hour.
-- During EDT, market close is 20:00 UTC sharp — so the cron fires 60 times
-- post-close every weekday. Empirical 2026-05-14 20:00-21:00 UTC: 65 of 77
-- slack rows = regime_transition emissions, storm starting 20:01:18 UTC
-- (1 min post-bell). 20:31:17–20:32:06 burst = "6 tickers synchronized →
-- unknown" mass-flip as the 30-min momentum window finally fully clears
-- live RTH data. Most flips fire at high confidence even though they're
-- walking-out-of-live-data artifacts. This is captain-noise.
--
-- Per audit Class B framing (goal #2 item 2 diagnose, 2026-05-15): /pulse
-- classifier is correct; emission layer needed suppression. Four switch
-- points evaluated:
--   1. Tighten cron — smallest blast radius. Kills bell-cross Slack push
--      at 20:00 UTC but classifier still records the transition and /pulse
--      renders it. EOD wrap at 20:31 UTC covers session-close state.
--   2. Add isMarketClosed() gate in composer — similar effect; touches more
--      code; preserves Phase A receive-time discipline less cleanly.
--   3. Per-emission filter on to_regime='unknown' AND post-close — surgical
--      but misses non-unknown post-close noise (e.g. trending_up_strong →
--      decaying as the lookback walks out).
--   4. Window-emptiness floor on momentum_window_n_events — structurally
--      best, but ct_regime_history doesn't expose n_events. Scope creep
--      to add the column + populate from classifier.
--
-- Picked option 1 (cron tighten). One-line structural cut; meets goal
-- acceptance ("next post-RTH window emits dramatically fewer
-- regime_transition messages").
--
-- New schedule: `* 13-19 * * 1-5`. Last fire 19:59 UTC = 1 min before EDT
-- bell. The 20:00 UTC bell-cross flip (any ticker transitioning into the
-- 19:55-20:00 bucket) is still recorded by ct-regime-capture and visible
-- on /pulse — only the Slack push is suppressed.
--
-- Sibling pattern memory: feedback_pg_cron_schedule_idempotency.md — use
-- IF EXISTS unschedule-then-schedule inside a DO block; never CREATE OR
-- REPLACE on cron.schedule.

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'jac-emission-detector') THEN
    PERFORM cron.unschedule('jac-emission-detector');
  END IF;
  PERFORM cron.schedule(
    'jac-emission-detector',
    '* 13-19 * * 1-5',
    $body$SELECT public._ct_post('jac-emission-detector');$body$
  );
END
$cron$;
