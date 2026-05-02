# Tables Map

Generated 2026-05-01. 68 tables in scope.

Producers detected via three patterns: (1) `supabase.from('t').insert/upsert/update/delete()` in function body, (2) raw `fetch(.../rest/v1/t)` POSTs, (3) `INSERT INTO t` in SQL migrations / RPCs / triggers. `_shared/*.ts` writes are tagged with their importing function dirs.

Status legend:
- LIVE — rows>0 + at least one live producer found
- DORMANT — empty but producer exists, OR rows but producer unclear
- DEAD — no rows + no producer
- DEAD-BY-DESIGN — known-dead path documented in code/migration

Brain organ column shows which `_shared/*Context.ts` consumes the table (transitive — table feeds the named organ).


## Co-Trader tables (`ct_*`)

Count: 50

| table | rows | producer (function) | producer (_shared via callers) | SQL writers (migration/trigger) | edge consumers | UI hooks | brain organ | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `ct_brain_telemetry` | 4201 | - | `ct-alert-post-mortem`, `ct-chat`, `ct-curiosity` +15 | - | _shared | - | - | LIVE |
| `ct_contract_quotes` | 20098 | `ct-contract-poller`, `ct-historical-quote-backfill` | - | - | ct-contract-poller, ct-historical-quote-backfill, ct-print-grader | - | - | LIVE |
| `ct_contract_track_alerts` | 13937 | - | - | `20260428230500_track_alert_ledger` | ct-print-grader | - | - | DORMANT (rows but no live producer in code) |
| `ct_contract_tracks` | 8791 | `ct-contract-poller` | - | `20260428230100_track_dedup_schema_additi`, `20260428230200_track_dedup_merge` +2 | ct-backtest-harness, ct-contract-poller, ct-eod-report, ct-historical-quote-backfill, ct-print-grader, ct-reflect-to-jac, +0 | - | - | LIVE |
| `ct_debates` | 0 | `ct-chat`, `ct-debate-outcome-scorer` | - | - | ct-chat, ct-debate-outcome-scorer | - | - | DORMANT (empty, has producer) |
| `ct_detector_lifecycle_state` | 14 | `ct-detector-scoreboard-update` | - | - | ct-detector-scoreboard-update | - | - | LIVE |
| `ct_detector_scoreboard` | 28 | `ct-detector-scoreboard-update` | - | - | ct-detector-scoreboard-update | - | - | LIVE |
| `ct_detector_state` | 8 | - | `ct-detector-flow-stack-v1`, `ct-detector-pair-qqq-iwm`, `ct-detector-small-cap-inverted-put` +6 | `20260427000220_detector_state_and_seeds`, `20260428000100_smart_money_repeat_detect` +4 | _shared | - | - | DORMANT-LOW (few rows) |
| `ct_detectors` | 14 | `ct-detector-scoreboard-update` | - | `20260427000200_detectors_first_class`, `20260427000220_detector_state_and_seeds` +6 | _shared, ct-detector-scoreboard-update | - | - | LIVE |
| `ct_dreams` | 4 | - | - | - | - | - | - | DORMANT (4 rows, no live writer — table seeded by migration only) |
| `ct_earnings_moves` | 0 | `ct-earnings-moves-sync` | - | - | _shared, ct-earnings-moves-sync, ct-watcher | useEventRecency | event_recency | DORMANT (empty, has producer) |
| `ct_edge_attribution` | 952 | - | - | `20260422000024_ct_signal_attribution`, `20260422000032_ct_edge_per_ticker` +1 | - | - | - | DORMANT (rows but no live producer in code) |
| `ct_edge_daily` | 13 | `ct-edge-miner` | - | - | _shared, ct-edge-miner, ct-eod-summary | - | - | LIVE |
| `ct_eod_reports` | 3 | `ct-eod-report` | - | - | ct-eod-report | - | - | DORMANT-LOW (few rows) |
| `ct_eod_specialist_narratives` | 3 | `ct-eod-specialist-narrative` | - | - | ct-eod-specialist-narrative | - | - | DORMANT-LOW (few rows) |
| `ct_eod_summaries` | 6 | `ct-eod-summary` | - | - | ct-eod-report, ct-eod-summary | - | - | DORMANT-LOW (few rows) |
| `ct_flag_grades` | 1407 | `ct-flag-grader` | - | - | _shared, ct-eod-specialist-narrative, ct-eod-summary, ct-flag-grader | - | specialist_recall | LIVE |
| `ct_flag_patterns` | 12 | - | - | `20260423000031_v2_flag_pattern_update` | _shared, ct-slack-push-flag | - | - | DORMANT (rows but no live producer in code) |
| `ct_flags` | 5255 | `ct-detector-flow-stack-v1`, `ct-detector-pair-qqq-iwm`, `ct-detector-scorer`, `ct-detector-small-cap-inverted-put` +10 | `ct-specialist-aapl`, `ct-specialist-amzn`, `ct-specialist-googl` +7 | `20260424000061_repair_weekend_horizons`, `20260427000010_unify_flags` +5 | _shared, ct-chat, ct-detector-flow-stack-v1, ct-detector-pair-qqq-iwm, ct-detector-scorer, ct-detector-small-cap-inverted-put, +24 | useAttentionLeaderboard, useAxisAttribution, useCalibration, useCoTraderData, +6 | specialist_recall, james_flags, detector | LIVE |
| `ct_flow_pulse_ticks` | 5410 | - | - | `20260424000033_flow_pulse_ticks` | _shared, ct-detector-pair-qqq-iwm, ct-eod-report | - | pulse | DORMANT (rows but no live producer in code) |
| `ct_interval_flow` | 2582 | `ct-interval-flow-ingester` | - | - | ct-interval-flow-ingester | - | - | LIVE |
| `ct_invariant_log` | 993 | `ct-system-warden` | - | - | ct-system-warden | useWardenHealth | - | LIVE |
| `ct_invariants` | 19 | `ct-system-warden` | - | `20260501050000_system_warden`, `20260501060000_schedule_warden_and_seed_` +9 | ct-system-warden | - | - | LIVE |
| `ct_kill_switch` | 1 | - | - | `20260420000006_kill_switch` | ct-slack-slash | useCtKillSwitch, usePreflightChecks | - | DORMANT (rows but no live producer in code) |
| `ct_oi_snapshots` | 6379 | `ct-oi-backfill-historical`, `ct-oi-snapshot` | - | `20260423000028_v2_oi_delta_compute` | _shared, ct-flag-grader, ct-oi-backfill-historical, ct-oi-snapshot | - | - | LIVE |
| `ct_options_screener_hits` | 5621 | `ct-options-screener-ingester` | - | - | ct-options-screener-ingester | - | - | LIVE |
| `ct_prediction_traders` | 218 | `ct-prediction-smart-money-ingester` | - | - | ct-prediction-smart-money-ingester | - | - | LIVE |
| `ct_price_bars` | 153494 | `ct-price-backfill`, `ct-price-live-poll` | - | - | ct-edge-miner, ct-eod-report, ct-eod-summary, ct-flag-grader, ct-price-backfill, ct-price-live-poll, +1 | - | - | LIVE |
| `ct_price_ticks` | 5709 | `ct-price-tick-capture` | - | - | ct-correlation-compute, ct-debate-outcome-scorer, ct-earnings-moves-sync, ct-price-tick-capture, ct-replay | - | - | LIVE |
| `ct_print_grades` | 1205 | `ct-print-grader` | - | - | _shared, ct-edge-miner, ct-eod-summary, ct-print-grader | - | - | LIVE |
| `ct_print_tracks` | 17647 | `ct-print-grader` | - | - | ct-edge-miner, ct-print-grader | - | - | LIVE |
| `ct_pulse_events` | 620 | - | - | `20260423000018_ct_pulse`, `20260423000021_dp_scrub_pass1` +1 | - | - | - | DORMANT (rows but no live producer in code) |
| `ct_pulse_timeline` | 7280 | - | - | `20260423000018_ct_pulse`, `20260423000019_ct_pulse_refresh_fix` +1 | - | - | - | DORMANT (rows but no live producer in code) |
| `ct_regime_inversions` | 0 | `ct-regime-watch` | - | `20260418000008_regime_inversions` | ct-slack-digest | useRegimeInversions | - | EVENT-DRIVEN (event-only writes — empty during stable regimes is normal). Warden coverage via `allow_empty=true` row in `ct_growth_crons` (2026-05-02 amendment). |
| `ct_scored_flow` | 18309 | - | - | `20260423000027_v2_flow_scoring`, `20260424000003_v2_score_flow_alerts_fix` +4 | _shared, ct-eod-report, ct-eod-summary, ct-oi-backfill-historical, ct-oi-snapshot, ct-slack-digest, +2 | - | - | DORMANT (rows but no live producer in code) |
| `ct_signature_alarm_log` | 1151 | `ct-signature-watcher` | - | `20260428145000_signature_watcher_score_f`, `20260428162000_backfill_zero_score_flags` +1 | ct-signature-watcher | - | - | LIVE |
| `ct_signature_alarm_state` | 1 | `ct-signature-watcher` | - | `20260426000050_signature_alarm_state` | ct-signature-watcher | - | - | DORMANT-LOW (few rows) |
| `ct_signatures` | 1131 | `ct-edge-miner` | - | - | _shared, ct-edge-miner, ct-eod-summary | - | - | LIVE |
| `ct_specialist_memory` | 3 | - | - | - | - | - | - | DEAD-BY-DESIGN (legacy v1 substrate; warden invariant flips fail if rows accumulate) |
| `ct_specialist_principles` | 0 | - | - | - | - | - | - | DEAD (no producer, no rows) |
| `ct_specialist_prompts` | 20 | - | - | `20260424000064_specialist_prompts_table` | - | - | - | DORMANT (rows but no live producer in code) |
| `ct_specialist_reads` | 367 | - | `ct-specialist-aapl`, `ct-specialist-amzn`, `ct-specialist-googl` +7 | - | _shared, ct-eod-report, ct-eod-specialist-narrative, ct-eod-summary | - | specialist, specialist_recall | LIVE |
| `ct_specialist_scoreboard` | 7 | `ct-specialist-scoreboard-update` | - | - | ct-specialist-scoreboard-update | - | - | DORMANT-LOW (few rows) |
| `ct_tavily_alarm_state` | 1 | - | - | `20260429230000_tavily_budget_tracking` | _shared | - | - | DORMANT (rows but no live producer in code) |
| `ct_tavily_usage` | 311 | - | `ct-news-sweep`, `ct-tavily-news-watcher`, `jac-web-search` | - | - | - | - | LIVE |
| `ct_technicals` | 36162 | `ct-technicals-ingester` | - | - | ct-technicals-ingester | - | - | LIVE |
| `ct_ticker_baselines` | 60 | - | - | `20260424000001_v2_baselines_rollup` | - | - | - | DORMANT (rows but no live producer in code) |
| `ct_ticker_correlation_cache` | 78 | `ct-correlation-compute` | - | - | ct-correlation-compute | - | - | LIVE |
| `ct_uw_alarm_state` | 1 | `ct-contract-poller` | - | `20260427000040_uw_budget_guard` | ct-contract-poller | - | - | DORMANT-LOW (few rows) |
| `ct_warden_alarm_state` | 20 | `ct-system-warden` | - | - | ct-system-warden | - | - | LIVE |
| `ct_weekly_reviews` | 0 | - | - | - | _shared | - | - | DEAD (no producer, no rows) |

## JAC tables

Count: 10

| table | rows | producer (function) | producer (_shared via callers) | SQL writers (migration/trigger) | edge consumers | UI hooks | brain organ | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `agent_activity_log` | 4213 | - | `health-check`, `jac-code-agent`, `jac-dispatcher` +5 | - | _shared | - | - | LIVE |
| `agent_conversations` | 460 | `jac-code-agent`, `jac-dispatcher`, `jac-research-agent`, `jac-save-agent` +1 | - | - | jac-code-agent, jac-dispatcher, jac-research-agent, jac-save-agent, jac-search-agent | - | - | LIVE |
| `agent_tasks` | 410 | `jac-code-agent`, `jac-dispatcher`, `jac-heartbeat`, `jac-kill-switch` +6 | `brain-insights`, `calculate-importance`, `classify-content` +39 | `20260227000001_fix_cron_jobs`, `20260303000001_fix_watch_protection` +1 | _shared, brain-insights, calendar-reminder-check, health-check, jac-code-agent, jac-dispatcher, +10 | useActivityLog, useAgentStats, useCodeWorkspace, useDashboardActivity, +4 | - | LIVE |
| `brain_insights` | 6 | `brain-insights`, `ct-debate-outcome-scorer`, `jac-heartbeat`, `jac-morning-brief` | - | - | brain-insights, ct-debate-outcome-scorer, jac-heartbeat, jac-morning-brief | useProactiveInsights | - | DORMANT-LOW (few rows) |
| `brain_reports` | 324 | `delete-all-user-data`, `generate-brain-report`, `jac-morning-brief`, `jac-research-agent` +1 | - | - | delete-all-user-data, export-all-data, generate-brain-report, jac-heartbeat, jac-morning-brief, jac-research-agent, +1 | - | - | LIVE |
| `code_projects` | 2 | `jac-code-agent`, `sync-codebase` | - | - | jac-code-agent, jac-dispatcher, read-file, sync-codebase | - | - | DORMANT-LOW (few rows) |
| `code_sessions` | 6 | `jac-code-agent`, `poll-ci` | - | - | jac-code-agent, poll-ci | useDashboardActivity, useTickerData | - | DORMANT-LOW (few rows) |
| `entries` | 515 | `backfill-embeddings`, `calendar-reminder-check`, `delete-all-user-data`, `enrich-entry` +4 | - | `20260301000002_memory_decay`, `20260301000005_heartbeat_and_crons` | _shared, backfill-embeddings, brain-insights, calendar-reminder-check, classify-content, delete-all-user-data, +12 | useBrainGraph, useCalendarEntries, useDashboardActivity, useEntries, +4 | - | LIVE |
| `entry_relationships` | 1770 | `backfill-embeddings`, `smart-save` | - | - | backfill-embeddings, find-related-entries, jac-dashboard-query, smart-save | - | - | LIVE |
| `user_activity` | 4700 | - | - | - | - | - | - | LIVE (frontend useActivityTracker hook writes via PostgREST — not visible to function grep) |

## Shared infrastructure / orphan candidates

Count: 8

| table | rows | producer (function) | producer (_shared via callers) | SQL writers (migration/trigger) | edge consumers | UI hooks | brain organ | status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `conversations` | ? | - | - | - | - | - | - | DEAD (empty + no producers) |
| `deploy_environments` | 0 | - | - | - | - | - | - | DEAD (no producer, no rows) |
| `deploy_operations` | 0 | - | - | - | - | - | - | DEAD (no producer, no rows) |
| `messages` | ? | `calculate-importance` | - | - | calculate-importance | - | - | DORMANT (empty, has producer) |
| `profiles` | 1 | `delete-all-user-data` | - | `20251122000000_bootstrap_profiles`, `20260222045347_84e7c966-fa11-40fa-a8c6-6` | calendar-reminder-check, ct-chat, ct-contract-poller, ct-cron-health-check, ct-curiosity, ct-daily-brief, +25 | - | - | DORMANT-LOW (few rows) |
| `subscriptions` | 1 | - | - | `20260125075133_045aa7db-6fd0-4cf3-bff9-b`, `20260125075213_e238e10a-dc46-4ea4-87f6-f` | - | - | - | DORMANT (rows but no live producer in code) |
| `user_api_keys` | ? | - | - | - | - | - | - | DEAD (empty + no producers) |
| `user_settings` | 1 | `slack-incoming` | - | - | _shared, calendar-reminder-check, ct-dp-cluster, ct-preset-apply, ct-slack-slash, ct-sweep-cluster, +5 | useWatches | - | DORMANT-LOW (few rows) |

## Summary

- LIVE: 33
- DORMANT (incl. DORMANT-LOW): 28
- DEAD / DEAD-BY-DESIGN: 7

### Tables flagged for inspection

| table | row count | issue |
| --- | --- | --- |
| `ct_dreams` | 4 | populated 4 times then went silent — Dream Mode (overnight reflection) is dormant |
| `ct_specialist_memory` | 3 | DEAD-BY-DESIGN (warden invariant `specialist_memory_table_dead`) — gates on legacy v1 path |
| `ct_specialist_principles` | 0 | empty + no producer + no consumer — orphan |
| `ct_weekly_reviews` | 0 | empty + no producer — read by `claudeReadSurface.ts` only — orphan |
| `ct_earnings_moves` | 0 | producer `ct-earnings-moves-sync` exists; cron may not have run live yet |
| `ct_debates` | 0 | producer exists (`ct-chat`, `ct-debate-outcome-scorer`) but never populated |
| `deploy_environments` | 0 | empty + no producer |
| `deploy_operations` | 0 | empty + no producer |
| `subscriptions` | 1 | one row, no producer in functions — likely seeded by stripe webhook (out of tree) |
| `code_projects` | 2 | only 2 rows after months — code agent rarely registers new projects |
| `brain_insights` | 6 | low row count for a feature with two crons writing twice daily — investigate if cron writes are landing |