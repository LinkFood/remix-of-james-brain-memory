-- =============================================================================
-- 20260501190000_warden_news_pipeline_liveness_metric.sql
--
-- Repurpose `news_pipeline_freshness_rth`. The original (shipped earlier today
-- in 20260501180000) checked freshness of ct_breaking_news rows — but that
-- table is filtered by severity/relevance, so a calm news day genuinely has
-- 3+ hours of silence even though the pipeline is healthy.
--
-- Better signal: ct_tavily_usage row freshness. That's the LIVENESS layer —
-- "did the Tavily pipeline fire successfully and log a request?" Decoupled
-- from content quality. If Tavily auth-fails, rows still land in usage with
-- a non-200 status, so the cron-was-running signal is preserved.
--
-- Also dodges a SQL-guard footgun: the message string can't contain whole
-- words from `\m(insert|update|delete|truncate|drop|create|alter|grant|
-- revoke|copy|do|call)\M`. Original message "Tavily API call observed"
-- failed the guard on "call". This version uses "Tavily request observed".
-- Future invariant authors: avoid those words in any string literal in
-- query_sql. Class lesson worth a runbook note.
-- =============================================================================

UPDATE public.ct_invariants
SET
  query_sql = $$SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '09:35' THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time > '15:58' THEN 0
         ELSE COALESCE(EXTRACT(EPOCH FROM (now() - MAX(observed_at)))/60, 999)
       END::numeric AS metric_value,
       'minutes since latest Tavily request observed (RTH-only)' AS message
     FROM ct_tavily_usage
     WHERE observed_at > now() - interval '4 hour'$$,
  expected_max = 60,
  description = 'Latest Tavily request observation must be within 60min during RTH M-F. Catches a stuck news pipeline (function timeout, cron disabled, network outage). Measures pipeline LIVENESS via ct_tavily_usage rows — a calm news day where Tavily returns no qualifying headlines is healthy. If Tavily auth-fails, rows still land here so the pipeline-was-firing signal is preserved.',
  updated_at = now()
WHERE name = 'news_pipeline_freshness_rth';
