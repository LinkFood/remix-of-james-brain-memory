-- Volume mode: triple ct-hypothesis-proposer cadence.
-- Old: 11:00 UTC once/day (07:00 ET pre-bell).
-- New: 11:00 + 15:00 + 19:00 UTC (pre-bell, mid-session, pre-close).
-- Keeps the fresh hypothesis inventory topping up throughout RTH instead of
-- starving by noon after 3-4 hours of health-check invalidations.
--
-- Rationale: Gen 1 produced 15 hypotheses total in 4 RTH days, 0 alerts
-- today, 3 trades in 4 days. Inventory bottleneck, not Claude's willingness.

DO $$
BEGIN
  PERFORM cron.unschedule('ct-hypothesis-proposer')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-hypothesis-proposer');

  -- 11:00, 15:00, 19:00 UTC weekdays (07:00, 11:00, 15:00 ET)
  PERFORM cron.schedule(
    'ct-hypothesis-proposer',
    '0 11,15,19 * * 1-5',
    $body$ SELECT public._ct_post('ct-hypothesis-proposer'); $body$
  );
END $$;
