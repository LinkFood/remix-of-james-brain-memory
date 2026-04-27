-- Split ct-flow-ingester into two cron lanes for UW efficiency:
--
--   1. Per-ticker lane: runs every 5min RTH, every 15min off-RTH.
--      Calls per_ticker_only=true so it skips the market-wide pass +
--      top-movers + sweeps. Just hits the 10 watchlist tickers for
--      flow_alerts + net_premium_ticks + greek_flow + nope.
--      ~30 UW calls/invocation.
--
--   2. Market-wide lane: runs every 30min RTH only.
--      Default body = market-wide pass + top-movers + sweeps + per-ticker
--      (still does per-ticker since the function does both). Picks up
--      cross-ticker context that per-ticker would miss.
--      ~41 UW calls/invocation.
--
-- Replaces the */5 + */15 lanes from 20260427233000_throttle_flow_
-- ingester_uw_budget.sql which still ran the full pass on every fire.
--
-- Expected daily UW savings vs today's 19,997-call burn:
--   Per-ticker lane: 84 RTH runs × 30 calls + 20 off-RTH × 30 = 3,120
--   Market-wide lane: 14 RTH runs × 41 calls = 574
--   Total: ~3,700 calls/day vs today's ~10,000 from this function alone.
--   Expected close: ~50% UW (was 100%).
--
-- Plus: WATCHLIST filter at insertion (added in same commit) prevents the
-- 77% off-watchlist noise (5,236 of 6,799 today) from hitting ct_flow_alerts.
SET search_path = public, extensions;

DO $cron$
BEGIN
  -- Drop both lanes from the previous throttle migration.
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flow-ingester-rth') THEN
    PERFORM cron.unschedule('ct-flow-ingester-rth');
  END IF;
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-flow-ingester-offrth') THEN
    PERFORM cron.unschedule('ct-flow-ingester-offrth');
  END IF;

  -- Per-ticker lane (the freshness-critical path):
  --   RTH: every 5min weekdays 13-20 UTC
  --   Pre/post: every 15min weekdays 10-12 + 21-22 UTC
  PERFORM cron.schedule(
    'ct-flow-ingester-perticker-rth',
    '*/5 13-20 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-flow-ingester',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{"per_ticker_only":true}'::jsonb
      )
    $body$
  );
  PERFORM cron.schedule(
    'ct-flow-ingester-perticker-offrth',
    '*/15 10-12,21-22 * * 1-5',
    $body$
      SELECT net.http_post(
        url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-flow-ingester',
        headers := jsonb_build_object(
          'Content-Type',  'application/json',
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
        ),
        body    := '{"per_ticker_only":true}'::jsonb
      )
    $body$
  );

  -- Market-wide lane (cross-ticker context, runs less often):
  --   Every 30min weekdays 13-20 UTC. Picks up unusual flow on tickers
  --   we don't actively watch but might be relevant to broader regime.
  PERFORM cron.schedule(
    'ct-flow-ingester-marketwide',
    '0,30 13-20 * * 1-5',
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
