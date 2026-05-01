-- =============================================================================
-- 20260501180000_warden_expand_observability.sql
--
-- Add three new warden invariants to expand silent-wrongness coverage. Per
-- Tenet 25, adding an invariant is a database INSERT, not a code change.
--
-- 1) eod_report_yesterday_landed
--    Catches a silent failure of the daily EOD report. ct-eod-report fires
--    `0 21 * * 1-5`. By 09:00 ET the next business day the most recent
--    business-day report should be in ct_eod_reports. If it's missing,
--    something failed silently (function deploy issue, pg_net body=null
--    swallow, etc.). Gates ON weekends + early-morning to avoid a Monday
--    9am false-positive when Friday's report ages into stale window.
--
-- 2) news_pipeline_freshness_rth
--    Catches a stale news pipeline (Tavily / GDELT). ct_breaking_news
--    should ingest at least one row within 120 min during RTH M-F.
--    Threshold 120min because news is bursty — calm tapes legitimately
--    have 60-90min gaps between qualifying catalysts. Mirrors
--    flow_alerts_freshness_rth's gating pattern.
--
-- 3) detector_flags_today_min
--    Catches a silent detector portfolio failure (watermark stall, scoring
--    fail, batched-insert rollback). Threshold ≥5 detector flags fired by
--    11:00 ET is well below typical session volume (today: 384 flags by
--    14:35 UTC). If we see <5, the detector pipeline is hung — same class
--    of failure mode as the score-zero stale-watermark bug from 2026-04-29.
--
-- Live-applied via direct INSERT during the 2026-05-01 session (after
-- the heatmap + warden boundary fixes). This migration locks them in
-- source for DB-restore durability.
-- =============================================================================

INSERT INTO public.ct_invariants (
  name, category, description, query_sql,
  expected_min, expected_max, expected_bool,
  severity, runbook_path, enabled
) VALUES
(
  'eod_report_yesterday_landed',
  'data_freshness',
  'ct_eod_reports must have a row for the most recent business day. Gates ON weekends + early-morning (before 09:00 ET). Catches a silent EOD cron failure within 16 hours of the missed run.',
  $$SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 1
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '09:00' THEN 1
         ELSE CASE WHEN EXISTS (
           SELECT 1 FROM ct_eod_reports
           WHERE session_date >= (now() AT TIME ZONE 'America/New_York')::date - interval '4 days'
             AND session_date < (now() AT TIME ZONE 'America/New_York')::date
         ) THEN 1 ELSE 0 END
       END::numeric AS metric_value,
       'most-recent business-day EOD report row exists' AS message$$,
  1, NULL, NULL,
  'warn', 'docs/runbooks/eod_pipeline.md', true
),
(
  'news_pipeline_freshness_rth',
  'data_freshness',
  'ct_breaking_news should ingest a row within 120 min during RTH M-F. Catches a stale news ingester (Tavily / GDELT pipelines). 0 outside RTH. Threshold 120min because news is bursty by nature — calm tapes legitimately have 60-90min gaps between qualifying catalysts.',
  $$SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '09:35' THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time > '15:58' THEN 0
         ELSE COALESCE(EXTRACT(EPOCH FROM (now() - MAX(published_at)))/60, 999)
       END::numeric AS metric_value,
       'minutes since latest ct_breaking_news row (RTH-only)' AS message
     FROM ct_breaking_news
     WHERE published_at > now() - interval '4 hour'$$,
  NULL, 120, NULL,
  'warn', 'docs/runbooks/news_pipeline.md', true
),
(
  'detector_flags_today_min',
  'data_freshness',
  'Detector portfolio should fire at least 5 flags during today''s RTH. Catches a silent detector pipeline (watermark stall, scoring failure, batched insert fail). Gate: weekends + before 11:00 ET pass automatically. Threshold 5 is well below typical session volume (200+ flags by close).',
  $$SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 5
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '11:00' THEN 5
         ELSE count(*)
       END::numeric AS metric_value,
       'detector flags fired today during RTH' AS message
     FROM ct_flags
     WHERE created_at >= (((now() AT TIME ZONE 'America/New_York')::date)::text || ' 09:30:00')::timestamp AT TIME ZONE 'America/New_York'
       AND detector_id IS NOT NULL$$,
  5, NULL, NULL,
  'warn', 'docs/runbooks/detector_pipeline.md', true
)
ON CONFLICT (name) DO UPDATE SET
  category = EXCLUDED.category,
  description = EXCLUDED.description,
  query_sql = EXCLUDED.query_sql,
  expected_min = EXCLUDED.expected_min,
  expected_max = EXCLUDED.expected_max,
  expected_bool = EXCLUDED.expected_bool,
  severity = EXCLUDED.severity,
  runbook_path = EXCLUDED.runbook_path,
  enabled = EXCLUDED.enabled,
  updated_at = now();
