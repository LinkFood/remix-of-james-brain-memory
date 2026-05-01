-- =============================================================================
-- 20260501160000_warden_flow_alerts_freshness_open_grace.sql
--
-- Patch the `flow_alerts_freshness_rth` warden invariant to add 5-min
-- grace at market open (09:30 → 09:35 ET) and 2-min grace at close
-- (16:00 → 15:58 ET).
--
-- BUG: At 2026-05-01 13:30:07 UTC (09:30:07 ET, 7 seconds after market
-- open), the warden ran this invariant. The lower gate `time < '09:30'`
-- evaluated false (we were past 09:30:00). Query fell through to the
-- ELSE branch, but the 1-hour `WHERE ingested_at > now() - interval '1
-- hour'` window had ZERO rows — yesterday's last fire was at 20:15 UTC
-- the prior day, well outside the 1h window. MAX(ingested_at) returned
-- NULL, COALESCE(NULL/60, 999) = 999, threshold (5) breached → critical
-- Slack alarm fired exactly at open.
--
-- This is the same boundary-bug class as ct-cron-health-check fixed in
-- 20260501150000 — the moment a window opens, last data is from yesterday's
-- close, no grace period for crons to fire their first tick → false-positive
-- "stale 999" reading.
--
-- FIX: gate ON until 09:35 ET so ingester crons (ct-flow-ingester-perticker-rth
-- fires every 5 min */5 13-20 * * 1-5, first today-tick at 13:35 UTC) get a
-- chance to land their first batch before the freshness check runs.
-- Symmetric tighten at close (15:58 ET) so a late ingest gap at 15:59 ET
-- doesn't double-fire on the warden's 16:00 UTC scheduled tick.
--
-- The freshness threshold (5 min during the open window) is unchanged.
-- =============================================================================

UPDATE public.ct_invariants
SET
  query_sql = $$SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '09:35' THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time > '15:58' THEN 0
         ELSE COALESCE(EXTRACT(EPOCH FROM (now() - MAX(ingested_at)))/60, 999)
       END::numeric AS metric_value,
       'minutes since latest ct_flow_alerts row (RTH-only, 5min grace at open)' AS message
     FROM ct_flow_alerts
     WHERE ingested_at > now() - interval '1 hour'$$,
  description = 'ct_flow_alerts should receive a row within 5 min during RTH M-F. 0 outside RTH (gated). Open-grace: gates ON until 09:35 ET to let first ingester batch land before invariant runs.',
  updated_at = now()
WHERE name = 'flow_alerts_freshness_rth';
