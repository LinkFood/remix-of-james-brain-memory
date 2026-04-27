-- Throttle ct-flow-ingester to fit the actual UW budget.
--
-- 2026-04-27 incident: UW hit 100% cap at 22:42 UTC (6:42 PM ET) — 2.5
-- hours after market close. Audit found ct-flow-ingester was firing
-- every 3 min × 12 hours/day × ~41 UW calls per invocation = ~10k
-- calls/day from this single function (50% of 20k budget).
--
-- Code comment in supabase/functions/ct-flow-ingester/index.ts:407-409
-- explicitly states: "well under UW's 50k/day budget" — function was
-- designed for 50k/day. Per memory project_co_trader_contract_grading_
-- 2026_04_25.md the actual budget is 20k/day. Cadence never updated
-- when the budget got cut.
--
-- New schedule:
--   RTH lane:        */5 13-20 * * 1-5  (every 5 min during RTH+1h)
--   Off-RTH lane:    */15 10-12,21-22 * * 1-5  (every 15min pre/post)
-- Off-hours/weekend: not scheduled — overnight backfill jobs handle it.
--
-- Expected savings: ~5,500 calls/day = 27% of daily budget. Combined
-- with letting per-ticker pollers throttle similarly, we should close
-- the day at ~70% UW instead of 100%.
SET search_path = public, extensions;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flow-ingester') THEN
    PERFORM cron.unschedule('ct-flow-ingester');
  END IF;

  -- RTH cadence: every 5 min, 13-20 UTC weekdays (9 AM - 4 PM ET + 1h
  -- post-close cushion for late-flow capture). 5 min is well within UW's
  -- typical alert latency (alerts arrive in 15-60s windows).
  PERFORM cron.schedule(
    'ct-flow-ingester-rth',
    '*/5 13-20 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-flow-ingester',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{}'::jsonb
      )
    $body$
  );

  -- Off-RTH cadence: every 15 min, 10-12 + 21-22 UTC weekdays.
  -- Pre-market (10-12 UTC = 6-8 AM ET) — overnight pricing context.
  -- Post-close (21-22 UTC = 5-6 PM ET) — settle prints + late flow.
  PERFORM cron.schedule(
    'ct-flow-ingester-offrth',
    '*/15 10-12,21-22 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-flow-ingester',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{}'::jsonb
      )
    $body$
  );
END
$cron$;
