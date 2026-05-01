-- =============================================================================
-- 20260501170000_warden_threshold_tuning_post_open.sql
--
-- Two warden invariants flipped to fail at 14:00 UTC RTH today (2026-05-01,
-- the first session after the warden shipped). Both were threshold/gating
-- mismatches, not real failures.
--
-- 1) flow_alerts_freshness_rth: expected_max was 5 (min). Cadence of
--    ct-flow-ingester-perticker-rth is `*/5 13-20 * * 1-5` — fires every
--    5 minutes. Threshold equal to cadence is mathematically guaranteed to
--    fire on tick alignment when the warden's 30-min cron sits between
--    ingester ticks. Bump to 8 min (1.6× cadence + insert latency budget).
--
-- 2) specialist_reads_today: expected ≥8 distinct watchlist tickers writing
--    reads, gated ON until 14:00 UTC. Two issues:
--      a) Threshold of 8 is too aggressive — QQQ has wakeup_threshold=65
--         (vs default 60) and may legitimately have low-conviction days
--         where its scored_flow events cluster at score=60 exactly. Lower
--         to 7 of 10.
--      b) Gate cutoff `hour(UTC) < 14` is too early. Specialists fire on
--         staggered hourly minute-slots (06,12,18,24,30,36,42,48,54,00).
--         The first complete post-13:30-UTC cycle ends at 14:24 UTC (MSFT
--         minute slot). Until then, some specialists haven't had a chance
--         to fire post-open AT ALL. Move gate to 10:30 ET (=14:30 UTC EDT
--         / 15:30 UTC EST), which is +6 min past MSFT's slot — adequate
--         buffer for the longest cron round-trip.
--
-- Both patches were applied live via PATCH RPC on 2026-05-01 ~14:08 UTC and
-- ~14:21 UTC respectively. After the second, warden flipped to 15/15 passing.
-- This migration captures both in source so DB restores don't regress.
--
-- Class lesson (extends the boundary-grace fix in 20260501160000): warden
-- invariants whose value depends on a CRON's progress need to model the
-- cron's schedule. Threshold equals cadence → false positive every tick.
-- Gate ON until first complete post-event-cycle → false positive every
-- session start.
-- =============================================================================

-- (1) flow_alerts_freshness_rth: bump expected_max from 5 → 8
UPDATE public.ct_invariants
SET
  expected_max = 8,
  description = 'ct_flow_alerts should receive a row within 8 min during RTH M-F (cadence is 5min, threshold is 1.6x cadence to absorb insert latency + one tardy tick). 0 outside RTH (gated).',
  updated_at = now()
WHERE name = 'flow_alerts_freshness_rth';

-- (2) specialist_reads_today: move gate to 10:30 ET, lower threshold 8 → 7
UPDATE public.ct_invariants
SET
  query_sql = $$WITH wl AS (
       SELECT jsonb_array_elements_text((value)::jsonb) AS ticker
       FROM ct_config WHERE key='watcher.watchlist'
     ),
     reads AS (
       SELECT DISTINCT ticker FROM ct_specialist_reads
       WHERE updated_at >= (now() AT TIME ZONE 'America/New_York')::date
     )
     SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 7
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '10:30' THEN 7
         ELSE count(*)
       END::numeric AS metric_value,
       'watchlist tickers with reads today (gate: 10:30 ET = full first-cycle complete)' AS message
     FROM reads, wl
     WHERE reads.ticker = wl.ticker$$,
  expected_min = 7,
  description = 'Count of distinct watchlist tickers with reads today. Threshold 7 of 10 (allows 3 no_events for restrictive-threshold tickers like QQQ wakeup_threshold=65). Gates ON until 10:30 ET — by which point all 10 specialists have completed their first post-13:30-UTC fire (last is MSFT at 14:24 UTC = 10:24 ET, +6min grace).',
  updated_at = now()
WHERE name = 'specialist_reads_today';
