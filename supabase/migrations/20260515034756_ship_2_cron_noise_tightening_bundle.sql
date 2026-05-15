-- Ship 2 — cron noise tightening bundle (4 schedule changes).
--
-- Source: /goal #6 Item 2 diagnose-only finding. Sibling of:
--   - 20260515014119 (jac-emission-detector RTH-only) — goal #3 item 3
--   - 20260515022141 (ct-trade-advisories + ct-curiosity 13-19) — goal #5 item 2
--
-- Phase A reconciliation vs mega-prompt 2026-05-15 03:55Z:
-- Brief asked for 1 + 3 + 3 = 7 tightenings. Engine-room /goal #6 Item 2
-- diagnose identified exactly FOUR candidates (1 offhours weekday+cadence
-- combined + 3 RTH hour-20 tightenings). Phase A re-survey confirms no
-- additional clear noise candidates in the remaining 151 non-hour-20 active
-- pg_cron entries — the other Slack-pushers either have internal quiet-hours
-- gates (jac-heartbeat) or are appropriate 24/7 substrate (ct-system-warden,
-- ct-cron-health-check). Shipping the empirically-validated four; surfacing
-- the brief/diagnose count mismatch for captain awareness.
--
-- The four tightenings:
--
-- 1. ct-signature-watcher-offhours: */5 0-12,21-23 * * * → */15 0-12,21-23 * * 1-5
--    Combines weekday-only filter + 3× cadence reduction. Weekend execution
--    (96 hours of */5 firing on stale tape) produces zero actionable signal
--    — markets closed, captain can't act on a Saturday signature alarm.
--    Off-hours cadence cut from every-5-min to every-15-min (3× fewer fires)
--    aligns with the off-hours flow rate, which is naturally sparse.
--    Net: ~6,720 fires/week → ~2,160 fires/week (−68%).
--
-- 2. ct-slack-push-flag: * 13-20 * * 1-5 → * 13-19 * * 1-5
--    Pushes flags with score ≥ 80 to Slack every RTH minute. Post-20:00 UTC
--    fires push late-cascade detector output on an already-closed market.
--    Mirrors the jac-emission-detector pattern (goal #3 item 3).
--    Net: −60 fires/weekday.
--
-- 3. ct-sweep-cluster: * 13-20 * * 1-5 → * 13-19 * * 1-5
--    Cluster pattern detector every minute. Post-bell tape is thin →
--    20:00-20:59 cluster detection is settle-time artifact noise.
--    Net: −60 fires/weekday.
--
-- 4. ct-signature-watcher-rth: * 13-20 * * 1-5 → * 13-19 * * 1-5
--    Direct producer of signature alarms during RTH. Post-bell signatures
--    are usually false-fires on tape settle and feed into the
--    ct-slack-push-flag cascade tightened in (2). Companion change.
--    Net: −60 fires/weekday.
--
-- Total session reduction: ~5,400 fewer cron fires/week.
--
-- Class-kill payload (Tenet 15) is captured in a sibling migration:
--   20260515034757_ship_2_cron_fire_rate_warden.sql adds a warden invariant
--   tracking emission counts in a configurable rolling window, watching for
--   re-drift after future cron tunings overshoot. EXISTS-guard pattern
--   matches d3_capture_freshness_weeknights from 5/14.
--
-- Idempotent pattern per feedback_pg_cron_schedule_idempotency.md.

DO $cron$
BEGIN
  -- (1) Offhours signature watcher: weekday-only + 3× cadence cut.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-signature-watcher-offhours') THEN
    PERFORM cron.unschedule('ct-signature-watcher-offhours');
  END IF;
  PERFORM cron.schedule(
    'ct-signature-watcher-offhours',
    '*/15 0-12,21-23 * * 1-5',
    $body$SELECT public._ct_post('ct-signature-watcher');$body$
  );

  -- (2) Slack push flag: drop hour 20.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-slack-push-flag') THEN
    PERFORM cron.unschedule('ct-slack-push-flag');
  END IF;
  PERFORM cron.schedule(
    'ct-slack-push-flag',
    '* 13-19 * * 1-5',
    $body$SELECT public._ct_post('ct-slack-push-flag');$body$
  );

  -- (3) Sweep cluster: drop hour 20.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-sweep-cluster') THEN
    PERFORM cron.unschedule('ct-sweep-cluster');
  END IF;
  PERFORM cron.schedule(
    'ct-sweep-cluster',
    '* 13-19 * * 1-5',
    $body$SELECT public._ct_post('ct-sweep-cluster');$body$
  );

  -- (4) Signature watcher RTH: drop hour 20.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-signature-watcher-rth') THEN
    PERFORM cron.unschedule('ct-signature-watcher-rth');
  END IF;
  PERFORM cron.schedule(
    'ct-signature-watcher-rth',
    '* 13-19 * * 1-5',
    $body$SELECT public._ct_post('ct-signature-watcher');$body$
  );
END
$cron$;
