# Warden Invariants

Live `ct_invariants` snapshot — **19 invariants**. State pulled from `ct_warden_alarm_state`.

Cron: `ct-system-warden` every 30 min. Slack on first state-change pass→fail/error and on recovery; once-per-day heartbeat.

Current status: 20 pass / 0 fail / 0 error / 20 total.

## budget

| name | severity | enabled | watches | runbook | current_status |
| --- | --- | --- | --- | --- | --- |
| `tavily_budget_view_sane` | warn | Y | Tavily monthly budget should never exceed 95% | docs/runbooks/budget_views.md | pass |
| `uw_budget_view_sane` | warn | Y | UW daily peak should never exceed configured limit (20k/day) | docs/runbooks/budget_views.md | pass |

## cron_health

| name | severity | enabled | watches | runbook | current_status |
| --- | --- | --- | --- | --- | --- |
| `ct_session_analog_deployed` | critical | Y | ct-session-analog cron should produce one embedding per weekday at 21:30 UTC | docs/runbooks/cron_health.md | pass |

## data_freshness

| name | severity | enabled | watches | runbook | current_status |
| --- | --- | --- | --- | --- | --- |
| `detector_flags_today_min` | warn | Y | Detector portfolio should fire at least 5 flags during today's RTH | docs/runbooks/detector_pipeline.md | pass |
| `detector_scoreboard_freshness` | warn | Y | #9 detector lifecycle scoreboard cron freshness | docs/runbooks/detector_scoreboard.md | pass |
| `eod_report_yesterday_landed` | warn | Y | ct_eod_reports must have a row for the most recent business day | docs/runbooks/eod_pipeline.md | pass |
| `flow_alerts_freshness_rth` | critical | Y | ct_flow_alerts should receive a row within 8 min during RTH M-F (cadence is 5min, threshold is 1 | docs/runbooks/data_freshness.md | pass |
| `morning_brief_freshness` | warn | Y | Morning brief cron writes one row per weekday by 11:00 UTC | docs/runbooks/hallucination_class.md | pass |
| `news_pipeline_freshness_rth` | warn | Y | Latest Tavily request observation must be within 60min during RTH M-F | docs/runbooks/news_pipeline.md | pass |
| `uw_budget_today_recorded` | critical | Y | ct_uw_usage must have at least one row today (UTC) once past 13:00 UTC | docs/runbooks/uw_pollers.md | pass |
| `uw_caller_set_on_recent_calls` | info | Y | setUwCaller hygiene — 80%+ of recent calls should be tagged | docs/runbooks/uw_pollers.md | pass |

## specialists

| name | severity | enabled | watches | runbook | current_status |
| --- | --- | --- | --- | --- | --- |
| `specialist_memory_table_dead` | info | Y | ct_specialist_memory is the legacy v1 substrate | docs/runbooks/specialists.md | pass |
| `specialist_reads_per_ticker_today_rth` | warn | Y | Per-ticker specialists must fire during RTH | docs/runbooks/specialists.md | pass |
| `specialist_reads_today` | warn | Y | Count of distinct watchlist tickers with reads today | docs/runbooks/specialists.md | pass |

## synthesis

| name | severity | enabled | watches | runbook | current_status |
| --- | --- | --- | --- | --- | --- |
| `brain_telemetry_consumer_coverage_24h` | warn | Y | >=8 distinct consumers should be writing telemetry | docs/SYNTHESIS_LAYER.md | pass |
| `brain_telemetry_insert_rate_24h` | warn | Y | Brain telemetry should accumulate >100 rows/24h once consumers redeploy | docs/SYNTHESIS_LAYER.md | pass |
| `brain_telemetry_real_errors_24h` | critical | Y | Real telemetry errors (excluding warnings/skipped) should be near zero | docs/SYNTHESIS_LAYER.md | pass |
| `chat_off_universe_mentions_24h` | critical | Y | ct-chat responses must not mention tickers outside the 10-ticker watchlist + macro symbols + supplied-context tickers | docs/runbooks/hallucination_class.md | pass |
| `ct_chat_no_uw_mcp` | critical | Y | ct-chat must never call UW MCP at runtime (D4 read/write separation) | docs/SYNTHESIS_LAYER.md | pass |

## Per-invariant details

### `tavily_budget_view_sane`  
category: `budget` · severity: `warn` · runbook: `docs/runbooks/budget_views.md`

Tavily monthly budget should never exceed 95%. Above = exhausted tier, paid surprise next API call.

```sql
SELECT pct_used::numeric AS metric_value, tier AS message FROM ct_tavily_budget_tier()
```

### `uw_budget_view_sane`  
category: `budget` · severity: `warn` · runbook: `docs/runbooks/budget_views.md`

UW daily peak should never exceed configured limit (20k/day). Caught 2026-04-30 — view returned wrong column for one session.

```sql
SELECT MAX(daily_count)::numeric AS metric_value, 'today UW peak' AS message FROM ct_uw_usage WHERE session_date = (now() AT TIME ZONE 'America/New_York')::date AND daily_count IS NOT NULL
```

### `ct_session_analog_deployed`  
category: `cron_health` · severity: `critical` · runbook: `docs/runbooks/cron_health.md`

ct-session-analog cron should produce one embedding per weekday at 21:30 UTC. Stale > 4 days = function 404 again. Pre-2026-05-02 grace returns 0.

```sql
SELECT
       CASE WHEN now() < timestamptz '2026-05-02 00:00:00+00' THEN 0
            ELSE COALESCE(EXTRACT(EPOCH FROM (now() - MAX(through_utc)))/3600, 999)
       END::numeric AS metric_value,
       'hours since last ct_session_embeddings row' AS message
     FROM ct_session_embeddings
```

### `detector_flags_today_min`  
category: `data_freshness` · severity: `warn` · runbook: `docs/runbooks/detector_pipeline.md`

Detector portfolio should fire at least 5 flags during today's RTH. Catches a silent detector pipeline (watermark stall, scoring failure, batched insert fail). Gate: weekends + before 11:00 ET pass automatically. Threshold 5 is well below typical session volume (200+ flags by close).

```sql
SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 5
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '11:00' THEN 5
         ELSE count(*)
       END::numeric AS metric_value,
       'detector flags fired today during RTH' AS message
     FROM ct_flags
     WHERE created_at >= (((now() AT TIME ZONE 'America/New_York')::date)::text || ' 09:30:00')::timestamp AT TIME ZONE 'America/New_York'
       AND detector_id IS NOT NULL
```

### `detector_scoreboard_freshness`  
category: `data_freshness` · severity: `warn` · runbook: `docs/runbooks/detector_scoreboard.md`

#9 detector lifecycle scoreboard cron freshness. Warns if no scoreboard snapshot in last 90 min RTH or last 120 min off-hours.

```sql
WITH last_run AS (
      SELECT MAX(computed_at) AS last_at FROM public.ct_detector_scoreboard
    ),
    rth_now AS (
      SELECT
        EXTRACT(DOW FROM now() AT TIME ZONE 'UTC') BETWEEN 1 AND 5 AS is_weekday,
        EXTRACT(HOUR FROM now() AT TIME ZONE 'UTC') BETWEEN 13 AND 20 AS is_rth_hour
    )
    SELECT
      CASE
        WHEN last_at IS NULL THEN 0
        ELSE EXTRACT(EPOCH FROM (now() - last_at)) / 60
      END                                              AS metric_value,
      CASE
        WHEN last_at IS NULL THEN '[detector_scoreboard] no snapshots yet — first cron fire pending'
        ELSE '[detector_scoreboard] last snapshot ' || ROUND(EXTRACT(EPOCH FROM (now() - last_at)) / 60)::text || ' min ago'
      END                                              AS message
    FROM last_run, rth_now
```

### `eod_report_yesterday_landed`  
category: `data_freshness` · severity: `warn` · runbook: `docs/runbooks/eod_pipeline.md`

ct_eod_reports must have a row for the most recent business day. Gates ON weekends + early-morning (before 09:00 ET). Catches a silent EOD cron failure within 16 hours of the missed run.

```sql
SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 1
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '09:00' THEN 1
         ELSE CASE WHEN EXISTS (
           SELECT 1 FROM ct_eod_reports
           WHERE session_date >= (now() AT TIME ZONE 'America/New_York')::date - interval '4 days'
             AND session_date < (now() AT TIME ZONE 'America/New_York')::date
         ) THEN 1 ELSE 0 END
       END::numeric AS metric_value,
       'most-recent business-day EOD report row exists' AS message
```

### `flow_alerts_freshness_rth`  
category: `data_freshness` · severity: `critical` · runbook: `docs/runbooks/data_freshness.md`

ct_flow_alerts should receive a row within 8 min during RTH M-F (cadence is 5min, threshold is 1.6x cadence to absorb insert latency + one tardy tick). 0 outside RTH (gated).

```sql
SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '09:35' THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time > '15:58' THEN 0
         ELSE COALESCE(EXTRACT(EPOCH FROM (now() - MAX(ingested_at)))/60, 999)
       END::numeric AS metric_value,
       'minutes since latest ct_flow_alerts row (RTH-only, 5min grace at open)' AS message
     FROM ct_flow_alerts
     WHERE ingested_at > now() - interval '1 hour'
```

### `morning_brief_freshness`  
category: `data_freshness` · severity: `warn` · runbook: `docs/runbooks/hallucination_class.md`

Morning brief cron writes one row per weekday by 11:00 UTC. Missing = ct-daily-brief broken.

```sql
SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 1
         WHEN extract(hour from now() AT TIME ZONE 'UTC') < 11 THEN 1
         WHEN MAX(session_date) >= (now() AT TIME ZONE 'America/New_York')::date THEN 1
         ELSE 0
       END::numeric AS metric_value,
       'morning brief written for today (gated weekday post-11UTC)' AS message
     FROM ct_daily_briefs
```

### `news_pipeline_freshness_rth`  
category: `data_freshness` · severity: `warn` · runbook: `docs/runbooks/news_pipeline.md`

Latest Tavily request observation must be within 60min during RTH M-F. Catches a stuck news pipeline (function timeout, cron disabled, network outage). Measures pipeline LIVENESS via ct_tavily_usage rows — a calm news day where Tavily returns no qualifying headlines is healthy. If Tavily auth-fails, rows still land here so the pipeline-was-firing signal is preserved.

```sql
SELECT
       CASE
         WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time < '09:35' THEN 0
         WHEN (now() AT TIME ZONE 'America/New_York')::time > '15:58' THEN 0
         ELSE COALESCE(EXTRACT(EPOCH FROM (now() - MAX(observed_at)))/60, 999)
       END::numeric AS metric_value,
       'minutes since latest Tavily request observed (RTH-only)' AS message
     FROM ct_tavily_usage
     WHERE observed_at > now() - interval '4 hour'
```

### `uw_budget_today_recorded`  
category: `data_freshness` · severity: `critical` · runbook: `docs/runbooks/uw_pollers.md`

ct_uw_usage must have at least one row today (UTC) once past 13:00 UTC. 0 = pollers stopped.

```sql
SELECT
       CASE WHEN extract(hour from now() AT TIME ZONE 'UTC') < 13 THEN 1
            ELSE count(*)
       END::numeric AS metric_value,
       'rows today (gated post-13UTC)' AS message
     FROM ct_uw_usage
     WHERE observed_at >= date_trunc('day', now())
       AND observed_at <  date_trunc('day', now()) + interval '1 day'
```

### `uw_caller_set_on_recent_calls`  
category: `data_freshness` · severity: `info` · runbook: `docs/runbooks/uw_pollers.md`

setUwCaller hygiene — 80%+ of recent calls should be tagged. Below = an ingester missing setUwCaller import.

```sql
SELECT
       COALESCE(100.0 * count(*) FILTER (WHERE caller IS NOT NULL) / NULLIF(count(*), 0), 100)::numeric AS metric_value,
       'pct of last 1000 UW calls with caller set' AS message
     FROM (SELECT caller FROM ct_uw_usage ORDER BY observed_at DESC LIMIT 1000) sub
```

### `specialist_memory_table_dead`  
category: `specialists` · severity: `info` · runbook: `docs/runbooks/specialists.md`

ct_specialist_memory is the legacy v1 substrate. The writer in ct-flag-grader gates on flag.source=specialist which v2 never produces, so the table is empty BY DESIGN. The recall property sources from ct_specialist_reads + ct_flag_grades instead (see specialistRecallContext.ts). This invariant flips to fail if rows start accumulating — which would mean someone reactivated the dead path. Severity info: never Slacks, just shows in get_warden_health.

```sql
SELECT
      count(*)::numeric                                  AS metric_value,
      'rows in legacy ct_specialist_memory'              AS message
    FROM ct_specialist_memory
```

### `specialist_reads_per_ticker_today_rth`  
category: `specialists` · severity: `warn` · runbook: `docs/runbooks/specialists.md`

Per-ticker specialists must fire during RTH. By 14:30 UTC (10:30 ET), at least 7 of the 10 watchlist tickers should have at least one row in ct_specialist_reads written today (ET trading day). Below that = a specialist cron is dead, watchlist filter is wrong, or the dispatcher stopped.

```sql
SELECT
      CASE
        -- Weekend: no specialists expected
        WHEN extract(dow from now() AT TIME ZONE 'America/New_York') NOT IN (1,2,3,4,5) THEN 10
        -- Pre-RTH-warmup window: don't fire yet
        WHEN (now() AT TIME ZONE 'America/New_York')::time < '10:30' THEN 10
        ELSE (
          SELECT count(DISTINCT ticker)
          FROM ct_specialist_reads
          WHERE updated_at >= ((now() AT TIME ZONE 'America/New_York')::date
                                AT TIME ZONE 'America/New_York')
        )
      END::numeric                                                  AS metric_value,
      'distinct watchlist tickers with reads today'                 AS message
```

### `specialist_reads_today`  
category: `specialists` · severity: `warn` · runbook: `docs/runbooks/specialists.md`

Count of distinct watchlist tickers with reads today. Threshold 7 of 10 (allows 3 no_events for restrictive-threshold tickers like QQQ wakeup_threshold=65). Gates ON until 10:30 ET — by which point all 10 specialists have completed their first post-13:30-UTC fire (last is MSFT at 14:24 UTC = 10:24 ET, +6min grace).

```sql
WITH wl AS (
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
     WHERE reads.ticker = wl.ticker
```

### `brain_telemetry_consumer_coverage_24h`  
category: `synthesis` · severity: `warn` · runbook: `docs/SYNTHESIS_LAYER.md`

>=8 distinct consumers should be writing telemetry. Lower = a consumer is on a stale bundle without consumerName plumbing.

```sql
SELECT count(DISTINCT consumer_name)::numeric AS metric_value,
            'distinct consumers in last 24h' AS message
     FROM ct_brain_telemetry
     WHERE created_at > now() - interval '24 hours'
       AND consumer_name != 'unknown'
```

### `brain_telemetry_insert_rate_24h`  
category: `synthesis` · severity: `warn` · runbook: `docs/SYNTHESIS_LAYER.md`

Brain telemetry should accumulate >100 rows/24h once consumers redeploy. Below = orchestrator wire broken.

```sql
SELECT count(*)::numeric AS metric_value,
            'telemetry rows last 24h' AS message
     FROM ct_brain_telemetry
     WHERE created_at > now() - interval '24 hours'
```

### `brain_telemetry_real_errors_24h`  
category: `synthesis` · severity: `critical` · runbook: `docs/SYNTHESIS_LAYER.md`

Real telemetry errors (excluding warnings/skipped) should be near zero. >5/24h = an organ is throwing.

```sql
SELECT count(*)::numeric AS metric_value,
            'real errors (excluding warnings/skipped) in last 24h' AS message
     FROM ct_brain_telemetry
     WHERE created_at > now() - interval '24 hours'
       AND error IS NOT NULL
       AND error NOT LIKE 'warning:%'
       AND error NOT LIKE 'skipped:%'
```

### `chat_off_universe_mentions_24h`  
category: `synthesis` · severity: `critical` · runbook: `docs/runbooks/hallucination_class.md`

ct-chat responses must not mention tickers outside the 10-ticker watchlist + macro symbols + supplied-context tickers. Off-universe mentions = Claude fabricating data. tickerCoherenceValidator flags these on every chat response and persists to ct_chat_tokens.validator_warnings. Threshold 0: any flagged response is a hallucination event.

```sql
SELECT
      count(*)::numeric                                AS metric_value,
      'chat rows with off-universe mentions in last 24h' AS message
    FROM ct_chat_tokens
    WHERE created_at > now() - interval '24 hours'
      AND validator_warnings IS NOT NULL
      AND jsonb_typeof(validator_warnings) = 'array'
      AND jsonb_array_length(validator_warnings) > 0
```

### `ct_chat_no_uw_mcp`  
category: `synthesis` · severity: `critical` · runbook: `docs/SYNTHESIS_LAYER.md`

ct-chat must never call UW MCP at runtime (D4 read/write separation). Any row = Phase 4 violation.

```sql
SELECT count(*)::numeric AS metric_value,
                          'mcp_calls in ct-chat last 24h' AS message
                   FROM ct_mcp_calls
                   WHERE source = 'ct-chat'
                     AND created_at > now() - interval '24 hours'
```
