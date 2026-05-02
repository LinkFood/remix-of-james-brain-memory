# Cron Schedules

Live `cron.job` snapshot — **221 jobs total**. Source: `/tmp/sysmap_crons.json` extracted 2026-05-01 23:07.

Bucket totals:
- Co-Trader (`ct-*`): 124
- JAC (`jac-*`): 3
- JAC-shared (other): 12
- Duck Countdown (`hunt-*`/`dcd-*`): 82

Active failures (`last_run_status = failed`): 0
Never-run on non-weekly cadence (suspicious): 6


## Co-Trader crons (ct-*)

| jobname | schedule | function/SQL | last_run_at (UTC) | last_status | active | health |
| --- | --- | --- | --- | --- | --- | --- |
| `ct-alert-book-commit` | `*/15 14-19 * * 1-5` | `ct-alert-book-commit` | 2026-05-01T19:45:00 | succeeded | Y | OK |
| `ct-alert-post-mortem` | `*/30 13-20 * * 1-5` | `ct-alert-post-mortem` | 2026-05-01T20:30:00 | succeeded | Y | OK |
| `ct-analyst-ingester` | `0 12-22/2 * * 1-5` | `ct-analyst-ingester` | 2026-05-01T22:00:00 | succeeded | Y | OK |
| `ct-attribute-signals-nightly` | `40 22 * * 1-5` | `SQL/inline` | 2026-05-01T22:40:00 | succeeded | Y | OK |
| `ct-central-bank-ingester` | `0 9 * * 1-5` | `ct-central-bank-ingester` | 2026-05-01T09:00:00 | succeeded | Y | OK |
| `ct-contract-poller` | `*/4 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:56:00 | succeeded | Y | OK |
| `ct-contract-poller-offhours` | `0 0,4,8,21 * * *` | `SQL/inline` | 2026-05-02T00:00:00 | succeeded | Y | OK |
| `ct-correlation-compute` | `0 22 * * 1-5` | `ct-correlation-compute` | 2026-05-01T22:00:00 | succeeded | Y | OK |
| `ct-correlations-ingester` | `0 9 * * 1-5` | `ct-correlations-ingester` | 2026-05-01T09:00:00 | succeeded | Y | OK |
| `ct-cron-health-check` | `*/10 * * * *` | `ct-cron-health-check` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `ct-curiosity` | `7,37 13-20 * * 1-5` | `ct-curiosity` | 2026-05-01T20:37:00 | succeeded | Y | OK |
| `ct-daily-brief` | `0 11 * * 1-5` | `ct-daily-brief` | 2026-05-01T11:00:00 | succeeded | Y | OK |
| `ct-debate-outcome-scorer` | `0 22 * * 1-5` | `ct-debate-outcome-scorer` | 2026-05-01T22:00:00 | succeeded | Y | OK |
| `ct-detector-flow-stack-v1` | `2-58/5 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:57:00 | succeeded | Y | OK |
| `ct-detector-pair-qqq-iwm-rth` | `*/5 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:55:00 | succeeded | Y | OK |
| `ct-detector-scoreboard-update-offhours` | `0 0-12,21-23 * * 1-5` | `SQL/inline` | - | NEVER_RUN | Y | BROKEN |
| `ct-detector-scoreboard-update-rth` | `*/30 13-20 * * 1-5` | `SQL/inline` | - | NEVER_RUN | Y | BROKEN |
| `ct-detector-scoreboard-update-weekend` | `0 * * * 0,6` | `SQL/inline` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `ct-detector-scorer-rth` | `*/5 13-20 * * 1-5` | `ct-detector-scorer` | 2026-05-01T20:55:00 | succeeded | Y | OK |
| `ct-detector-small-cap-inverted-put-rth` | `4,9,14,19,24,29,34,39,44,49,54,59 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:59:00 | succeeded | Y | OK |
| `ct-detector-smart-money-repeat-rth` | `0,5,10,15,20,25,30,35,40,45,50,55 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:55:00 | succeeded | Y | OK |
| `ct-detector-unusual-oi-rth` | `*/5 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:55:00 | succeeded | Y | OK |
| `ct-detector-weekly-atm-voi-rth` | `1,6,11,16,21,26,31,36,41,46,51,56 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:56:00 | succeeded | Y | OK |
| `ct-detector-whale-off` | `0 0,4,8,21 * * *` | `SQL/inline` | 2026-05-02T00:00:00 | succeeded | Y | OK |
| `ct-detector-whale-rth` | `*/5 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:55:00 | succeeded | Y | OK |
| `ct-detector-zerodte-opening-call-rth` | `2,7,12,17,22,27,32,37,42,47,52,57 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:57:00 | succeeded | Y | OK |
| `ct-detector-zerodte-put-voi-rth` | `3,8,13,18,23,28,33,38,43,48,53,58 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:58:00 | succeeded | Y | OK |
| `ct-disagreement-materializer` | `*/10 11-22 * * 1-5` | `ct-disagreement-materializer` | 2026-05-01T22:50:00 | succeeded | Y | OK |
| `ct-drawdown-watch` | `*/10 13-20 * * 1-5` | `ct-drawdown-watch` | 2026-05-01T20:50:00 | succeeded | Y | OK |
| `ct-earnings-moves-sync` | `15 22 * * 0` | `ct-earnings-moves-sync` | 2026-04-26T22:15:00 | succeeded | Y | OK |
| `ct-earnings-pre-event-check` | `0 13-21 * * 1-5` | `ct-earnings-pre-event-check` | 2026-05-01T21:00:00 | succeeded | Y | OK |
| `ct-earnings-sync` | `0 12 * * 0` | `ct-earnings-sync` | 2026-04-26T12:00:00 | succeeded | Y | OK |
| `ct-edge-miner` | `0 21 * * 1-5` | `ct-edge-miner` | 2026-05-01T21:00:00 | succeeded | Y | OK |
| `ct-eod-positioning` | `0 21 * * 1-5` | `ct-eod-positioning` | 2026-05-01T21:00:00 | succeeded | Y | OK |
| `ct-eod-report` | `0 21 * * 1-5` | `SQL/inline` | 2026-05-01T21:00:00 | succeeded | Y | OK |
| `ct-eod-specialist-narrative` | `30 21 * * 1-5` | `SQL/inline` | - | NEVER_RUN | Y | BROKEN |
| `ct-eod-summary` | `30 20 * * 1-5` | `ct-eod-summary` | 2026-05-01T20:30:00 | succeeded | Y | OK |
| `ct-event-calendar-ingester` | `0 */4 * * 1-5` | `ct-event-calendar-ingester` | 2026-05-01T20:00:00 | succeeded | Y | OK |
| `ct-flag-grader` | `*/30 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:30:00 | succeeded | Y | OK |
| `ct-flow-ingester-marketwide` | `0,30 13-20 * * 1-5` | `ct-flow-ingester` | 2026-05-01T20:30:00 | succeeded | Y | OK |
| `ct-flow-ingester-perticker-offrth` | `*/15 10-12,21-22 * * 1-5` | `ct-flow-ingester` | 2026-05-01T22:45:00 | succeeded | Y | OK |
| `ct-flow-ingester-perticker-rth` | `*/5 13-20 * * 1-5` | `ct-flow-ingester` | 2026-05-01T20:55:00 | succeeded | Y | OK |
| `ct-flow-pulse-capture` | `1-58/5 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:56:00 | succeeded | Y | OK |
| `ct-fundamentals-sync` | `0 22 * * 0` | `ct-fundamentals-sync` | 2026-04-26T22:00:00 | succeeded | Y | OK |
| `ct-grader` | `*/15 13-20 * * 1-5` | `ct-grader` | 2026-05-01T20:45:00 | succeeded | Y | OK |
| `ct-heatmap-snapshot-eod` | `5 20 * * 1-5` | `ct-heatmap-snapshot` | 2026-05-01T20:05:00 | succeeded | Y | OK |
| `ct-heatmap-snapshot-offrth` | `0 10-12,21-22 * * 1-5` | `ct-heatmap-snapshot` | 2026-05-01T22:00:00 | succeeded | Y | OK |
| `ct-heatmap-snapshot-rth` | `*/5 13-20 * * 1-5` | `ct-heatmap-snapshot` | 2026-05-01T20:55:00 | succeeded | Y | OK |
| `ct-historical-quote-backfill` | `*/30 * * * 0,6` | `SQL/inline` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `ct-hypothesis-health-check` | `*/15 13-20 * * 1-5` | `ct-hypothesis-health-check` | 2026-05-01T20:45:00 | succeeded | Y | OK |
| `ct-hypothesis-proposer` | `0 11,15,19 * * 1-5` | `SQL/inline` | 2026-05-01T19:00:00 | succeeded | Y | OK |
| `ct-hypothesis-reaper` | `0 6 * * 1-5` | `ct-hypothesis-reaper` | 2026-05-01T06:00:00 | succeeded | Y | OK |
| `ct-indicator-events-ingester` | `*/30 13-20 * * 1-5` | `ct-indicator-events-ingester` | 2026-05-01T20:30:00 | succeeded | Y | OK |
| `ct-insider-ingester` | `0 7 * * 1-5` | `ct-insider-ingester` | 2026-05-01T07:00:00 | succeeded | Y | OK |
| `ct-institutional-ingester` | `0 22 * * 0` | `ct-institutional-ingester` | 2026-04-26T22:00:00 | succeeded | Y | OK |
| `ct-interval-flow-ingester` | `*/15 14-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:45:00 | succeeded | Y | OK |
| `ct-iv-shift-watch` | `5 21 * * 1-5` | `ct-iv-shift-watch` | 2026-05-01T21:05:00 | succeeded | Y | OK |
| `ct-lean-score-close` | `5 20 * * 1-5` | `SQL/inline` | 2026-05-01T20:05:00 | succeeded | Y | OK |
| `ct-lean-score-live` | `*/15 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:45:00 | succeeded | Y | OK |
| `ct-lessons-curator` | `0 23 * * 0` | `ct-lessons-curator` | 2026-04-26T23:00:00 | succeeded | Y | OK |
| `ct-news-causality` | `*/15 13-20 * * 1-5` | `ct-news-causality` | 2026-05-01T20:45:00 | succeeded | Y | OK |
| `ct-news-ingester-weekday` | `*/20 11-22 * * 1-5` | `ct-news-ingester` | 2026-05-01T22:40:00 | succeeded | Y | OK |
| `ct-news-ingester-weekend` | `0 * * * 6,0` | `ct-news-ingester` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `ct-news-sweep-rth` | `*/30 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:30:00 | succeeded | Y | OK |
| `ct-oi-overnight-summary` | `30 12 * * 1-5` | `SQL/inline` | 2026-05-01T12:30:00 | succeeded | Y | OK |
| `ct-oi-snapshot-close` | `5 20 * * 1-5` | `SQL/inline` | - | NEVER_RUN | Y | BROKEN |
| `ct-oi-snapshot-mid` | `0 17 * * 1-5` | `SQL/inline` | 2026-05-01T17:00:01 | succeeded | Y | OK |
| `ct-oi-snapshot-open` | `35 13 * * 1-5` | `SQL/inline` | 2026-05-01T13:35:00 | succeeded | Y | OK |
| `ct-options-screener-ingester` | `*/30 14-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:30:00 | succeeded | Y | OK |
| `ct-playbook-curator` | `45 22 * * 0` | `ct-playbook-curator` | 2026-04-26T22:45:00 | succeeded | Y | OK |
| `ct-political-ingester` | `0 7 * * 1-5` | `ct-political-ingester` | 2026-05-01T07:00:00 | succeeded | Y | OK |
| `ct-prediction-markets-ingester` | `0 9 * * 1-5` | `ct-prediction-markets-ingester` | 2026-05-01T09:00:00 | succeeded | Y | OK |
| `ct-prediction-smart-money-ingester` | `0 8 * * 1-5` | `SQL/inline` | 2026-05-01T08:00:00 | succeeded | Y | OK |
| `ct-premarket-scan` | `15 13 * * 1-5` | `ct-premarket-scan` | 2026-05-01T13:15:00 | succeeded | Y | OK |
| `ct-price-backfill-weekly` | `30 12 * * 6` | `SQL/inline` | - | NEVER_RUN | Y | BROKEN |
| `ct-price-live-poll` | `*/2 13-20 * * 1-5` | `ct-price-live-poll` | 2026-05-01T20:58:00 | succeeded | Y | OK |
| `ct-price-tick-capture` | `*/2 13-20 * * 1-5` | `ct-price-tick-capture` | 2026-05-01T20:58:00 | succeeded | Y | OK |
| `ct-price-ticks-retention` | `0 6 * * 1-5` | `SQL: DELETE ct_price_ticks` | 2026-05-01T06:00:00 | succeeded | Y | OK |
| `ct-print-grader-offhours` | `0,30 0-12,21-23 * * *` | `SQL/inline` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `ct-print-grader-rth` | `*/10 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:50:00 | succeeded | Y | OK |
| `ct-pulse-tick` | `*/5 13-21 * * 1-5` | `SQL/inline` | 2026-05-01T21:55:00 | succeeded | Y | OK |
| `ct-reflect-to-jac` | `30 22 * * 1-5` | `ct-reflect-to-jac` | 2026-05-01T22:30:00 | succeeded | Y | OK |
| `ct-regime-watch` | `*/5 13-20 * * 1-5` | `ct-regime-watch` | 2026-05-01T20:55:00 | succeeded | Y | OK |
| `ct-score-flow-continuous` | `*/2 10-22 * * 1-5` | `SQL/inline` | 2026-05-01T22:58:00 | succeeded | Y | OK |
| `ct-score-self-grade-nightly` | `0 22 * * 1-5` | `ct-score-self-grade` | 2026-05-01T22:00:00 | succeeded | Y | OK |
| `ct-seasonality-ingester` | `0 22 * * 0` | `ct-seasonality-ingester` | 2026-04-26T22:00:00 | succeeded | Y | OK |
| `ct-sector-tide-ingester` | `*/15 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:45:00 | succeeded | Y | OK |
| `ct-self-grader` | `0 13-20/2 * * 1-5` | `ct-self-grader` | 2026-05-01T19:00:00 | succeeded | Y | OK |
| `ct-session-analog` | `30 21 * * 1-5` | `ct-session-analog` | 2026-05-01T21:30:00 | succeeded | Y | OK |
| `ct-short-interest-ingester` | `0 8 * * 1-5` | `ct-short-interest-ingester` | 2026-05-01T08:00:00 | succeeded | Y | OK |
| `ct-signature-watcher-offhours` | `*/5 0-12,21-23 * * *` | `SQL/inline` | 2026-05-02T03:05:00 | succeeded | Y | OK |
| `ct-signature-watcher-rth` | `* 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:59:00 | succeeded | Y | OK |
| `ct-skew-ingester` | `30 9 * * 1-5` | `ct-skew-ingester` | 2026-05-01T09:30:00 | succeeded | Y | OK |
| `ct-slack-digest` | `0,30 13-20 * * 1-5` | `ct-slack-digest` | 2026-05-01T20:30:00 | succeeded | Y | OK |
| `ct-slack-push-flag` | `* 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:59:00 | succeeded | Y | OK |
| `ct-specialist-aapl` | `18 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:18:00 | succeeded | Y | OK |
| `ct-specialist-amzn` | `36 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:36:00 | succeeded | Y | OK |
| `ct-specialist-dispatcher` | `*/5 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:55:00 | succeeded | Y | OK |
| `ct-specialist-googl` | `30 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:30:00 | succeeded | Y | OK |
| `ct-specialist-iwm` | `12 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:12:00 | succeeded | Y | OK |
| `ct-specialist-meta` | `42 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:42:00 | succeeded | Y | OK |
| `ct-specialist-msft` | `24 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:24:00 | succeeded | Y | OK |
| `ct-specialist-nvda` | `48 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:48:00 | succeeded | Y | OK |
| `ct-specialist-qqq` | `6 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:06:00 | succeeded | Y | OK |
| `ct-specialist-scoreboard-nightly` | `0 23 * * 1-5` | `SQL/inline` | 2026-05-01T23:00:00 | succeeded | Y | OK |
| `ct-specialist-spy` | `0 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:00:00 | succeeded | Y | OK |
| `ct-specialist-tsla` | `54 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:54:00 | succeeded | Y | OK |
| `ct-spy-capture` | `5 21 * * 1-5` | `ct-spy-capture` | 2026-05-01T21:05:00 | succeeded | Y | OK |
| `ct-sweep-cluster` | `* 13-20 * * 1-5` | `ct-sweep-cluster` | 2026-05-01T20:59:00 | succeeded | Y | OK |
| `ct-system-warden` | `*/30 * * * *` | `ct-system-warden` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `ct-tape-reader-rth` | `*/10 13-20 * * 1-5` | `ct-tape-reader` | 2026-05-01T20:50:00 | succeeded | Y | OK |
| `ct-tavily-news-watcher-weekday` | `*/30 11-22 * * 1-5` | `ct-tavily-news-watcher` | 2026-05-01T22:30:00 | succeeded | Y | OK |
| `ct-tavily-news-watcher-weekend` | `0 14,22 * * 6,0` | `SQL/inline` | - | NEVER_RUN | Y | BROKEN |
| `ct-technicals-ingester` | `*/30 14-21 * * 1-5` | `SQL/inline` | 2026-05-01T21:30:00 | succeeded | Y | OK |
| `ct-ticker-baselines-nightly` | `45 22 * * 1-5` | `SQL/inline` | 2026-05-01T22:45:00 | succeeded | Y | OK |
| `ct-ticker-snapshot-builder` | `*/2 13-20 * * 1-5` | `ct-ticker-snapshot-builder` | 2026-05-01T20:58:00 | succeeded | Y | OK |
| `ct-trade-advisories` | `7,22,37,52 13-20 * * 1-5` | `ct-trade-advisories` | 2026-05-01T20:52:00 | succeeded | Y | OK |
| `ct-trade-idea-generator` | `*/5 13-20 * * 1-5` | `ct-trade-idea-generator` | 2026-05-01T20:55:00 | succeeded | Y | OK |
| `ct-uw-endpoint-health-check` | `0 5 * * 1-5` | `ct-uw-endpoint-health-check` | 2026-05-01T05:00:00 | succeeded | Y | OK |
| `ct-uw-mcp-scout` | `0 4 * * 1-5` | `ct-uw-mcp-scout` | 2026-05-01T04:00:00 | succeeded | Y | OK |
| `ct-vix-capture-eod` | `0 22 * * 1-5` | `SQL/inline` | 2026-05-01T22:00:00 | succeeded | Y | OK |
| `ct-vix-capture-rth` | `*/10 13-20 * * 1-5` | `SQL/inline` | 2026-05-01T20:50:00 | succeeded | Y | OK |
| `ct-watcher` | `0,15,30,45 12-21 * * 1-5` | `ct-watcher` | 2026-05-01T21:45:00 | succeeded | Y | OK |
| `ct-yield-curve-ingester` | `0 9 * * 1-5` | `ct-yield-curve-ingester` | 2026-05-01T09:00:00 | succeeded | Y | OK |

## JAC crons (jac-*)

| jobname | schedule | function/SQL | last_run_at (UTC) | last_status | active | health |
| --- | --- | --- | --- | --- | --- | --- |
| `jac-heartbeat` | `*/30 * * * *` | `jac-heartbeat` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `jac-morning-brief` | `0 10 * * *` | `jac-morning-brief` | 2026-05-01T10:00:00 | succeeded | Y | OK |
| `jac-watch-scheduler` | `*/5 * * * *` | `SQL/inline` | 2026-05-02T03:05:00 | succeeded | Y | OK |

## JAC shared / other (no jac- prefix)

| jobname | schedule | function/SQL | last_run_at (UTC) | last_status | active | health |
| --- | --- | --- | --- | --- | --- | --- |
| `backfill-embeddings-every-30min` | `*/30 * * * *` | `backfill-embeddings` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `brain-insights-cleanup` | `0 2 * * *` | `SQL: DELETE brain_insights` | 2026-05-02T02:00:00 | succeeded | Y | OK |
| `brain-insights-evening` | `0 22 * * *` | `brain-insights` | 2026-05-01T22:00:00 | succeeded | Y | OK |
| `brain-insights-morning` | `0 15 * * *` | `brain-insights` | 2026-05-01T15:00:00 | succeeded | Y | OK |
| `distill-principles` | `0 3 * * 0` | `distill-principles` | 2026-04-26T03:00:00 | succeeded | Y | OK |
| `market-snapshot` | `0 21 * * 1-5` | `market-snapshot` | 2026-05-01T21:00:00 | succeeded | Y | OK |
| `memory-decay-sweep` | `0 4 * * *` | `SQL: UPDATE entries` | 2026-05-01T04:00:00 | succeeded | Y | OK |
| `reminder-evening` | `0 23 * * *` | `SQL/inline` | 2026-05-01T23:00:00 | succeeded | Y | OK |
| `reminder-morning` | `0 13 * * *` | `SQL/inline` | 2026-05-01T13:00:00 | succeeded | Y | OK |
| `reminder-timed` | `*/5 * * * *` | `SQL/inline` | 2026-05-02T03:05:00 | succeeded | Y | OK |
| `stale-task-cleanup` | `*/30 * * * *` | `SQL: UPDATE agent_tasks` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `sync-all-codebases` | `0 */6 * * *` | `sync-codebase` | 2026-05-02T00:00:00 | succeeded | Y | OK |

## Duck Countdown crons (hunt-*, dcd-*) — shared instance, NOT in this repo

| jobname | schedule | function/SQL | last_run_at (UTC) | last_status | active | health |
| --- | --- | --- | --- | --- | --- | --- |
| `hunt-absence-detector` | `0 14 * * 0` | `hunt-absence-detector` | 2026-04-26T14:00:00 | succeeded | Y | OK |
| `hunt-air-quality` | `15 6 * * *` | `hunt-air-quality` | 2026-05-01T06:15:00 | succeeded | Y | OK |
| `hunt-alert-calibration` | `0 13 * * 0` | `hunt-alert-calibration` | 2026-04-26T13:00:00 | succeeded | Y | OK |
| `hunt-alert-grader` | `30 11 * * *` | `hunt-alert-grader` | 2026-05-01T11:30:00 | succeeded | Y | OK |
| `hunt-alert-grader-afternoon` | `0 17 * * *` | `hunt-alert-grader` | 2026-05-01T17:00:00 | succeeded | Y | OK |
| `hunt-anomaly-detector` | `30 9 * * *` | `hunt-anomaly-detector` | 2026-05-01T09:30:00 | succeeded | Y | OK |
| `hunt-anomaly-detector-daily` | `30 10 * * *` | `hunt-anomaly-detector` | 2026-05-01T10:30:00 | succeeded | Y | OK |
| `hunt-arc-narrator` | `0 9 * * *` | `hunt-arc-narrator` | 2026-05-01T09:00:00 | succeeded | Y | OK |
| `hunt-bio-correlator` | `15 * * * *` | `hunt-bio-correlator` | 2026-05-02T02:15:00 | succeeded | Y | OK |
| `hunt-birdcast-b1` | `0 10 * * *` | `hunt-birdcast` | 2026-05-01T10:00:00 | succeeded | Y | OK |
| `hunt-birdcast-b2` | `2 10 * * *` | `hunt-birdcast` | 2026-05-01T10:02:00 | succeeded | Y | OK |
| `hunt-birdcast-b3` | `4 10 * * *` | `hunt-birdcast` | 2026-05-01T10:04:00 | succeeded | Y | OK |
| `hunt-birdcast-b4` | `6 10 * * *` | `hunt-birdcast` | 2026-05-01T10:06:00 | succeeded | Y | OK |
| `hunt-birdcast-b5` | `8 10 * * *` | `hunt-birdcast` | 2026-05-01T10:08:00 | succeeded | Y | OK |
| `hunt-birdweather-daily` | `30 5 * * *` | `hunt-birdweather` | 2026-05-01T05:30:00 | succeeded | Y | OK |
| `hunt-brain-synthesizer-b1` | `0 12 * * *` | `hunt-brain-synthesizer` | 2026-05-01T12:00:00 | succeeded | Y | OK |
| `hunt-brain-synthesizer-b2` | `2 12 * * *` | `hunt-brain-synthesizer` | 2026-05-01T12:02:00 | succeeded | Y | OK |
| `hunt-brain-synthesizer-b3` | `4 12 * * *` | `hunt-brain-synthesizer` | 2026-05-01T12:04:00 | succeeded | Y | OK |
| `hunt-brain-synthesizer-b4` | `6 12 * * *` | `hunt-brain-synthesizer` | 2026-05-01T12:06:00 | succeeded | Y | OK |
| `hunt-brain-synthesizer-b5` | `8 12 * * *` | `hunt-brain-synthesizer` | 2026-05-01T12:08:00 | succeeded | Y | OK |
| `hunt-climate-indices-weekly` | `0 11 * * 1` | `hunt-climate-indices` | 2026-04-27T11:00:00 | succeeded | Y | OK |
| `hunt-convergence-alerts-daily` | `15 8 * * *` | `hunt-convergence-alerts` | 2026-05-01T08:15:00 | succeeded | Y | OK |
| `hunt-convergence-alerts-pm` | `0 16 * * *` | `hunt-convergence-alerts` | 2026-05-01T16:00:00 | succeeded | Y | OK |
| `hunt-convergence-engine-b1` | `0 8 * * *` | `hunt-convergence-engine` | 2026-05-01T08:00:00 | succeeded | Y | OK |
| `hunt-convergence-engine-b2` | `2 8 * * *` | `hunt-convergence-engine` | 2026-05-01T08:02:00 | succeeded | Y | OK |
| `hunt-convergence-engine-b3` | `4 8 * * *` | `hunt-convergence-engine` | 2026-05-01T08:04:00 | succeeded | Y | OK |
| `hunt-convergence-engine-b4` | `6 8 * * *` | `hunt-convergence-engine` | 2026-05-01T08:06:00 | succeeded | Y | OK |
| `hunt-convergence-engine-b5` | `8 8 * * *` | `hunt-convergence-engine` | 2026-05-01T08:08:00 | succeeded | Y | OK |
| `hunt-convergence-engine-batch1-early` | `58 7 * * *` | `hunt-convergence-engine` | 2026-05-01T07:58:00 | succeeded | Y | OK |
| `hunt-convergence-report-card` | `0 12 * * 0` | `hunt-convergence-report-card` | 2026-04-26T12:00:00 | succeeded | Y | OK |
| `hunt-correlation-engine` | `30 10 * * *` | `hunt-correlation-engine` | 2026-05-01T10:30:00 | succeeded | Y | OK |
| `hunt-correlation-engine-daily` | `30 11 * * *` | `hunt-correlation-engine` | 2026-05-01T11:30:00 | succeeded | Y | OK |
| `hunt-crop-progress-weekly` | `0 14 * * 5` | `hunt-crop-progress` | 2026-05-01T14:00:03 | succeeded | Y | OK |
| `hunt-daily-digest` | `0 7 * * *` | `hunt-daily-digest` | 2026-05-01T07:00:00 | succeeded | Y | OK |
| `hunt-disaster-watch` | `0 6 * * 3,6` | `hunt-disaster-watch` | 2026-04-29T06:00:00 | succeeded | Y | OK |
| `hunt-drought-batch1` | `0 7 * * 2` | `hunt-drought-monitor` | 2026-04-28T07:00:00 | succeeded | Y | OK |
| `hunt-drought-batch2` | `3 7 * * 2` | `hunt-drought-monitor` | 2026-04-28T07:03:00 | succeeded | Y | OK |
| `hunt-drought-batch3` | `6 7 * * 2` | `hunt-drought-monitor` | 2026-04-28T07:06:00 | succeeded | Y | OK |
| `hunt-drought-batch4` | `9 7 * * 2` | `hunt-drought-monitor` | 2026-04-28T07:09:00 | succeeded | Y | OK |
| `hunt-drought-batch5` | `12 7 * * 2` | `hunt-drought-monitor` | 2026-04-28T07:12:00 | succeeded | Y | OK |
| `hunt-du-alerts-weekly` | `0 6 * * 1` | `hunt-du-alerts` | 2026-04-27T06:00:00 | succeeded | Y | OK |
| `hunt-du-map` | `0 12 * * 1,4` | `hunt-du-map` | 2026-04-30T12:00:00 | succeeded | Y | OK |
| `hunt-du-map-weekly` | `0 12 * * 1` | `hunt-du-map` | 2026-04-27T12:00:00 | succeeded | Y | OK |
| `hunt-forecast-tracker` | `0 10 * * *` | `hunt-forecast-tracker` | 2026-05-01T10:00:00 | succeeded | Y | OK |
| `hunt-gbif-daily` | `45 9 * * *` | `hunt-gbif` | 2026-05-01T09:45:00 | succeeded | Y | OK |
| `hunt-historical-news-weekly` | `0 8 * * 6` | `hunt-historical-news` | 2026-04-25T08:00:00 | succeeded | Y | OK |
| `hunt-inaturalist-weekly` | `0 11 * * 3` | `hunt-inaturalist` | 2026-04-29T11:00:00 | succeeded | Y | OK |
| `hunt-migration-batch1` | `0 7 * * *` | `hunt-migration-monitor` | 2026-05-01T07:00:00 | succeeded | Y | OK |
| `hunt-migration-batch2` | `5 7 * * *` | `hunt-migration-monitor` | 2026-05-01T07:05:00 | succeeded | Y | OK |
| `hunt-migration-batch3` | `10 7 * * *` | `hunt-migration-monitor` | 2026-05-01T07:10:00 | succeeded | Y | OK |
| `hunt-migration-batch4` | `15 7 * * *` | `hunt-migration-monitor` | 2026-05-01T07:15:00 | succeeded | Y | OK |
| `hunt-migration-batch5` | `20 7 * * *` | `hunt-migration-monitor` | 2026-05-01T07:20:00 | succeeded | Y | OK |
| `hunt-migration-report-card` | `0 11 * * *` | `hunt-migration-report-card` | 2026-05-01T11:00:00 | succeeded | Y | OK |
| `hunt-movebank-weekly` | `0 14 * * 1` | `hunt-movebank` | 2026-04-27T14:00:00 | succeeded | Y | OK |
| `hunt-multi-species-daily` | `0 11 * * *` | `hunt-multi-species` | 2026-05-01T11:00:00 | succeeded | Y | OK |
| `hunt-narrator-daily` | `0 12 * * *` | `hunt-narrator` | 2026-05-01T12:00:00 | succeeded | Y | OK |
| `hunt-nasa-power-batch1` | `30 6 * * *` | `hunt-nasa-power` | 2026-05-01T06:30:00 | succeeded | Y | OK |
| `hunt-nasa-power-batch2` | `33 6 * * *` | `hunt-nasa-power` | 2026-05-01T06:33:00 | succeeded | Y | OK |
| `hunt-nws-monitor` | `0 * * * *` | `hunt-nws-monitor` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `hunt-ocean-buoy` | `45 0,6,12,18 * * *` | `hunt-ocean-buoy` | 2026-05-02T00:45:00 | succeeded | Y | OK |
| `hunt-ops-cache-refresh` | `17 * * * *` | `SQL/inline` | 2026-05-02T02:17:00 | succeeded | Y | OK |
| `hunt-phenology-weekly` | `0 9 * * 3` | `hunt-phenology` | 2026-04-29T09:00:00 | succeeded | Y | OK |
| `hunt-power-outage-6h` | `0 */3 * * *` | `hunt-power-outage` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `hunt-query-signal-daily` | `0 23 * * *` | `hunt-query-signal` | 2026-05-01T23:00:00 | succeeded | Y | OK |
| `hunt-river-discharge` | `0 5 * * *` | `hunt-river-discharge` | 2026-05-01T05:00:00 | succeeded | Y | OK |
| `hunt-scout-report` | `0 9 * * *` | `hunt-scout-report` | 2026-05-01T09:00:00 | succeeded | Y | OK |
| `hunt-search-trends-daily` | `0 12 * * *` | `hunt-search-trends` | 2026-05-01T12:00:00 | succeeded | Y | OK |
| `hunt-snotel-daily` | `0 8 * * *` | `hunt-snotel` | 2026-05-01T08:00:00 | succeeded | Y | OK |
| `hunt-snow-cover-daily` | `0 7 * * *` | `hunt-snow-cover` | 2026-05-01T07:00:00 | succeeded | Y | OK |
| `hunt-soil-monitor` | `30 5 * * *` | `hunt-soil-monitor` | 2026-05-01T05:30:00 | succeeded | Y | OK |
| `hunt-solunar-precompute` | `0 6 * * 0` | `hunt-solunar-precompute` | 2026-04-26T06:00:00 | succeeded | Y | OK |
| `hunt-space-weather` | `15 0,6,12,18 * * *` | `hunt-space-weather` | 2026-05-02T00:15:00 | succeeded | Y | OK |
| `hunt-synthesis-reviewer` | `0 15 * * 0` | `hunt-synthesis-reviewer` | 2026-04-26T15:00:00 | succeeded | Y | OK |
| `hunt-usfws-survey-monthly` | `0 6 1 * *` | `hunt-usfws-survey` | 2026-05-01T06:00:00 | succeeded | Y | OK |
| `hunt-weather-realtime` | `*/15 * * * *` | `hunt-weather-realtime` | 2026-05-02T03:00:00 | succeeded | Y | OK |
| `hunt-weather-watchdog-b1` | `0 6 * * *` | `hunt-weather-watchdog` | 2026-05-01T06:00:00 | succeeded | Y | OK |
| `hunt-weather-watchdog-b2` | `2 6 * * *` | `hunt-weather-watchdog` | 2026-05-01T06:02:00 | succeeded | Y | OK |
| `hunt-weather-watchdog-b3` | `4 6 * * *` | `hunt-weather-watchdog` | 2026-05-01T06:04:00 | succeeded | Y | OK |
| `hunt-weather-watchdog-b4` | `6 6 * * *` | `hunt-weather-watchdog` | 2026-05-01T06:06:00 | succeeded | Y | OK |
| `hunt-weather-watchdog-b5` | `8 6 * * *` | `hunt-weather-watchdog` | 2026-05-01T06:08:00 | succeeded | Y | OK |
| `hunt-web-curator` | `0 7 * * *` | `hunt-web-curator` | 2026-05-01T07:00:00 | succeeded | Y | OK |
| `hunt-wildfire-perimeters` | `30 8 * * *` | `hunt-wildfire-perimeters` | 2026-05-01T08:30:00 | succeeded | Y | OK |

## Flagged: never-run on non-weekend cadence

| jobname | schedule | bucket | command_preview |
| --- | --- | --- | --- |
| `ct-detector-scoreboard-update-offhours` | `0 0-12,21-23 * * 1-5` | cotrader | ` SELECT public.trigger_ct_detector_scoreboard(); ` |
| `ct-detector-scoreboard-update-rth` | `*/30 13-20 * * 1-5` | cotrader | ` SELECT public.trigger_ct_detector_scoreboard(); ` |
| `ct-eod-specialist-narrative` | `30 21 * * 1-5` | cotrader | ` SELECT public.trigger_ct_eod_specialist_narrative(); ` |
| `ct-oi-snapshot-close` | `5 20 * * 1-5` | cotrader | ` SELECT public.trigger_ct_oi_snapshot_with_slot('close'); ` |
| `ct-price-backfill-weekly` | `30 12 * * 6` | cotrader | ` SELECT public.trigger_ct_price_backfill(7); ` |
| `ct-tavily-news-watcher-weekend` | `0 14,22 * * 6,0` | cotrader | `SELECT public.invoke_edge_function('ct-tavily-news-watcher', '{}'::jsonb);` |

## Last-run = failed (0)

None.

## Disabled crons (0)

None — every cron is active.