-- =============================================================================
-- 20260501060000_schedule_warden_and_seed_invariants.sql
--
-- (a) Schedule ct-system-warden cron — every 30 minutes, all day. James said
--     don't worry about Slack spam yet; the warden only posts on STATE
--     CHANGE, so steady-state silence is structural, not configured.
--
-- (b) Seed 12 first-pass invariants — the failure modes the project has
--     actually been bitten by. Each row carries the runbook_path that
--     points back into docs/runbooks/ via SYSTEM_INDEX.md.
--
-- Idempotent: cron unschedule-then-schedule, INSERT ... ON CONFLICT DO NOTHING.
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- (a) Schedule the cron — vault-keyed pg_cron, $cron$/$body$ delimiters.
-- ----------------------------------------------------------------------------
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'ct-system-warden') THEN
    PERFORM cron.unschedule('ct-system-warden');
  END IF;

  PERFORM cron.schedule(
    'ct-system-warden',
    '*/30 * * * *',  -- every 30 min, all day
    $body$
    SELECT
      net.http_post(
        url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url' LIMIT 1) || '/functions/v1/ct-system-warden',
        headers := jsonb_build_object(
          'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1),
          'Content-Type', 'application/json'
        ),
        body := jsonb_build_object('triggered_by', 'cron'),
        timeout_milliseconds := 60000
      );
    $body$
  );
END
$cron$;

-- ----------------------------------------------------------------------------
-- (b) Seed 12 first-pass invariants. ON CONFLICT (name) DO NOTHING — re-running
--     this migration is a no-op for existing names. To change a query, INSERT
--     a new name or UPDATE in a follow-up migration; the manifest is versioned
--     by name (Tenet 25 — structure evolves).
-- ----------------------------------------------------------------------------

-- 1. UW daily peak — direct guard against the canonical bug class. The Warden
--    exists because James caught the UTC-rollover budget bug 2026-04-30.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, severity, runbook_path)
VALUES (
  'uw_budget_view_sane',
  'budget',
  'UW daily peak should never exceed configured limit (20k/day). Caught 2026-04-30 — view returned wrong column for one session.',
  'SELECT MAX(daily_count)::numeric AS metric_value, ''today UW peak'' AS message FROM ct_uw_usage WHERE session_date = (now() AT TIME ZONE ''America/New_York'')::date AND daily_count IS NOT NULL',
  0, 20000, 'warn', 'docs/runbooks/budget_views.md'
) ON CONFLICT (name) DO NOTHING;

-- 2. UW pollers heartbeat — at least one row today (UTC) once we are past the
--    first poll window. Time-gated: hour-of-day-UTC < 13 returns 1 to skip the
--    overnight gap before pre-market kicks off.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, severity, runbook_path)
VALUES (
  'uw_budget_today_recorded',
  'data_freshness',
  'ct_uw_usage must have at least one row today (UTC) once past 13:00 UTC. 0 = pollers stopped.',
  $q$SELECT
       CASE WHEN extract(hour from now() AT TIME ZONE 'UTC') < 13 THEN 1
            ELSE count(*)
       END::numeric AS metric_value,
       'rows today (gated post-13UTC)' AS message
     FROM ct_uw_usage
     WHERE observed_at >= date_trunc('day', now())
       AND observed_at <  date_trunc('day', now()) + interval '1 day'$q$,
  1, 'critical', 'docs/runbooks/uw_pollers.md'
) ON CONFLICT (name) DO NOTHING;

-- 3. Tavily monthly tier — guard against accidental quota burn.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, severity, runbook_path)
VALUES (
  'tavily_budget_view_sane',
  'budget',
  'Tavily monthly budget should never exceed 95%. Above = exhausted tier, paid surprise next API call.',
  'SELECT pct_used::numeric AS metric_value, tier AS message FROM ct_tavily_budget_tier()',
  0, 95, 'warn', 'docs/runbooks/budget_views.md'
) ON CONFLICT (name) DO NOTHING;

-- 4. Flow alerts freshness during RTH. Returns 0 outside RTH (PASS) — gate is
--    inside the SQL so the invariant is single-row regardless of clock.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_max, severity, runbook_path)
VALUES (
  'flow_alerts_freshness_rth',
  'data_freshness',
  'ct_flow_alerts should receive a row within 5 min during RTH M-F. 0 outside RTH (gated).',
  $q$SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '09:30' THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time > '16:00' THEN 0
         ELSE COALESCE(EXTRACT(EPOCH FROM (now() - MAX(created_at)))/60, 999)
       END::numeric AS metric_value,
       'minutes since latest ct_flow_alerts row (RTH-only)' AS message
     FROM ct_flow_alerts
     WHERE created_at > now() - interval '1 hour'$q$,
  5, 'critical', 'docs/runbooks/data_freshness.md'
) ON CONFLICT (name) DO NOTHING;

-- 5. Specialist coverage — most watchlist tickers have at least one read today.
--    Time-gated to >= 14:00 UTC (10 AM ET, after first specialist sweep).
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, severity, runbook_path)
VALUES (
  'specialist_reads_today',
  'specialists',
  'Most watchlist tickers should have at least one specialist read today during/after RTH. 8/10 floor accounts for one specialist hiccup.',
  $q$WITH wl AS (
       SELECT jsonb_array_elements_text((value)::jsonb) AS ticker
       FROM ct_config WHERE key='watcher.watchlist'
     ),
     reads AS (
       SELECT DISTINCT ticker FROM ct_specialist_reads
       WHERE created_at >= (now() AT TIME ZONE 'America/New_York')::date
     )
     SELECT
       CASE WHEN extract(hour from now() AT TIME ZONE 'UTC') < 14 THEN 8
            ELSE count(*)
       END::numeric AS metric_value,
       'watchlist tickers with reads today' AS message
     FROM reads, wl
     WHERE reads.ticker = wl.ticker$q$,
  8, 'warn', 'docs/runbooks/specialists.md'
) ON CONFLICT (name) DO NOTHING;

-- 6. Brain telemetry rolling-24h volume — orchestrator wire health.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, severity, runbook_path)
VALUES (
  'brain_telemetry_insert_rate_24h',
  'synthesis',
  'Brain telemetry should accumulate >100 rows/24h once consumers redeploy. Below = orchestrator wire broken.',
  $q$SELECT count(*)::numeric AS metric_value,
            'telemetry rows last 24h' AS message
     FROM ct_brain_telemetry
     WHERE created_at > now() - interval '24 hours'$q$,
  100, 'warn', 'docs/SYNTHESIS_LAYER.md'
) ON CONFLICT (name) DO NOTHING;

-- 7. Brain telemetry consumer coverage — distinct consumers seen in 24h.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, severity, runbook_path)
VALUES (
  'brain_telemetry_consumer_coverage_24h',
  'synthesis',
  '>=8 distinct consumers should be writing telemetry. Lower = a consumer is on a stale bundle without consumerName plumbing.',
  $q$SELECT count(DISTINCT consumer_name)::numeric AS metric_value,
            'distinct consumers in last 24h' AS message
     FROM ct_brain_telemetry
     WHERE created_at > now() - interval '24 hours'
       AND consumer_name != 'unknown'$q$,
  8, 'warn', 'docs/SYNTHESIS_LAYER.md'
) ON CONFLICT (name) DO NOTHING;

-- 8. Brain telemetry real-error rate — not warnings/skipped, only true errors.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_max, severity, runbook_path)
VALUES (
  'brain_telemetry_real_errors_24h',
  'synthesis',
  'Real telemetry errors (excluding warnings/skipped) should be near zero. >5/24h = an organ is throwing.',
  $q$SELECT count(*)::numeric AS metric_value,
            'real errors (excluding warnings/skipped) in last 24h' AS message
     FROM ct_brain_telemetry
     WHERE created_at > now() - interval '24 hours'
       AND error IS NOT NULL
       AND error NOT LIKE 'warning:%'
       AND error NOT LIKE 'skipped:%'$q$,
  5, 'critical', 'docs/SYNTHESIS_LAYER.md'
) ON CONFLICT (name) DO NOTHING;

-- 9. ct-session-analog deployment health. Cron fires 21:30 UTC weekdays into
--    the analog encoder. Expectation: at least one row in the last 96h. The
--    function was 404-in-prod-from-launch through 2026-04-30 — this is the
--    structural guard against a repeat.
--    Note: time-gate would require a CASE on (now() < '2026-05-02') which we
--    bake into the SQL so the migration is single-statement.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_max, severity, runbook_path)
VALUES (
  'ct_session_analog_deployed',
  'cron_health',
  'ct-session-analog cron should produce one embedding per weekday at 21:30 UTC. Stale > 4 days = function 404 again. Pre-2026-05-02 grace returns 0.',
  $q$SELECT
       CASE WHEN now() < timestamptz '2026-05-02 00:00:00+00' THEN 0
            ELSE COALESCE(EXTRACT(EPOCH FROM (now() - MAX(through_utc)))/3600, 999)
       END::numeric AS metric_value,
       'hours since last ct_session_embeddings row' AS message
     FROM ct_session_embeddings$q$,
  96, 'critical', 'docs/runbooks/cron_health.md'
) ON CONFLICT (name) DO NOTHING;

-- 10. ct-chat must NEVER call UW MCP at runtime — D4 read/write separation.
--     Any row in ct_mcp_calls with caller='ct-chat' is a Phase 4 violation.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_max, severity, runbook_path)
VALUES (
  'ct_chat_no_uw_mcp',
  'synthesis',
  'ct-chat must never call UW MCP at runtime (D4 read/write separation). Any row = Phase 4 violation.',
  $q$SELECT count(*)::numeric AS metric_value,
            'mcp_calls in ct-chat last 24h' AS message
     FROM ct_mcp_calls
     WHERE caller='ct-chat'
       AND called_at > now() - interval '24 hours'$q$,
  0, 'critical', 'docs/SYNTHESIS_LAYER.md'
) ON CONFLICT (name) DO NOTHING;

-- 11. Morning brief written for today — temporal-anchor / hallucination class
--     guard. Weekend returns 1 (PASS). Pre-11 UTC returns 1 (grace). Otherwise
--     1 if today's row exists, 0 if missing.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_bool, severity, runbook_path)
VALUES (
  'morning_brief_freshness',
  'data_freshness',
  'Morning brief cron writes one row per weekday by 11:00 UTC. Missing = ct-daily-brief broken.',
  $q$SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 1
         WHEN extract(hour from now() AT TIME ZONE 'UTC') < 11 THEN 1
         WHEN MAX(brief_date) >= (now() AT TIME ZONE 'America/New_York')::date THEN 1
         ELSE 0
       END::numeric AS metric_value,
       'morning brief written for today (gated weekday post-11UTC)' AS message
     FROM ct_daily_briefs$q$,
  true, 'warn', 'docs/runbooks/hallucination_class.md'
) ON CONFLICT (name) DO NOTHING;

-- 12. UW caller hygiene — % of last 1k UW calls with caller tagged. Below 80%
--     means an ingester is missing setUwCaller import.
INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, severity, runbook_path)
VALUES (
  'uw_caller_set_on_recent_calls',
  'data_freshness',
  'setUwCaller hygiene — 80%+ of recent calls should be tagged. Below = an ingester missing setUwCaller import.',
  $q$SELECT
       COALESCE(100.0 * count(*) FILTER (WHERE caller IS NOT NULL) / NULLIF(count(*), 0), 100)::numeric AS metric_value,
       'pct of last 1000 UW calls with caller set' AS message
     FROM (SELECT caller FROM ct_uw_usage ORDER BY observed_at DESC LIMIT 1000) sub$q$,
  80, 'info', 'docs/runbooks/uw_pollers.md'
) ON CONFLICT (name) DO NOTHING;
