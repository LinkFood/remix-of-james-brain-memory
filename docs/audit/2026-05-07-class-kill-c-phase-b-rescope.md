# Class-kill C Phase B — Rescope Audit (2026-05-07)

## Phase A finding — material divergence from brief

The Cowork brief estimated 23-40 invariants needed for "universal consumer
health monitoring." Phase A first-step empirical verification revealed the
real coverage gap is **9 invariants**, not 23-40.

### Brain consumer enumeration (real, via `get_brain_health(168)`)

18 recurring brain consumers in production telemetry, split into two classes:

**Class 1: 9 RTH-frequent (B-4 covers, RTH-only)**

| Consumer | 7d invocations | B-4 threshold |
|----------|----------------|---------------|
| ct-tape-reader | 3,203 | 0.5h |
| ct-watcher | 1,670 | 1.0h |
| ct-hypothesis-health-check | 1,380 | 1.0h |
| ct-curiosity | 661 | 2.0h |
| ct-news-sweep | 606 | 2.0h |
| ct-alert-post-mortem | 652 | 4.0h |
| ct-self-grader | 181 | 4.0h |
| ct-daily-brief | 172 | 26.0h |
| ct-hypothesis-proposer | 165 | 2.0h |

**Class 2: 9 event-driven (legitimate hours-to-days silence)**

| Consumer | 7d invocations | Why no freshness invariant |
|----------|----------------|----------------------------|
| ct-trade-idea-generator | 908 | Fires only on alerts during RTH |
| ct-eod-specialist-narrative | 340 | Daily near EOD |
| ct-trade-advisories | 252 | Fires only on advisory candidates |
| ct-eod-report | 111 | Daily 22:00 UTC |
| ct-eod-summary | 41 | Daily near EOD |
| ct-debate-outcome-scorer | 38 | Fires only on debate completion |
| ct-chat | 18 | On-demand (James in browser) |
| ct-lessons-curator | 9 | Weekly cadence |
| ct-playbook-curator | 9 | Weekly cadence |

Putting freshness invariants on Class 2 would generate noise, not signal.
A "this consumer hasn't fired in N hours" check on ct-chat would fire
constantly when James isn't actively in chat. Class 2 is better served by:
- `brain_telemetry_consumer_coverage_24h` (already exists — counts distinct
  consumer_names in last 24h)
- A separate "consumer dead for >7 days" invariant if/when we have evidence
  of a silent-class problem (none today)

### Specialist enumeration (claim: "10 covered by none")

20 distinct specialist consumer_names exist (10 base + 10 `/peers`):
ct-specialist-{aapl, amzn, googl, iwm, meta, msft, nvda, qqq, spy, tsla}
× {base, /peers}.

Already covered by 4 invariants:
- `specialist_oldest_ticker_freshness_rth` (CRITICAL — currently misfires
  per instance #40 measurement-shape bug, queued post-D2.2 5/14)
- `specialist_per_ticker_freshness_rth` (warn)
- `specialist_reads_today` (warn)
- `specialist_reads_per_ticker_today_rth` (warn)

**Adding specialist invariants now would touch the D2.2 measured surface
during the passive window.** Out of scope per brief's D2.2-safety
requirement.

### Cron consumers (claim: "4 critical NEW")

All 4 already monitored:

| Brief's claim | Actual invariant covering it |
|---------------|------------------------------|
| flow-ingester-perticker | `flow_alerts_freshness_rth` (CRITICAL) |
| news-causality | `news_pipeline_freshness_rth` (warn) |
| eod-summary | `eod_report_yesterday_landed` (warn) — also see brain consumer ct-eod-summary |
| morning-brief | `morning_brief_freshness` (warn) |

Zero net-new invariants needed.

## What shipped — 9 invariants

For each of B-4's 9 RTH-frequent consumers, a 24/7 phase-classifier
invariant supplements B-4. Phase classifier mirrors
`regime_state_freshness_rth` (Class B Phase B fix at
`20260510000000_class_b_dead_of_night_fix.sql`) — four phases:

- `weekend` — UTC dow not 1-5
- `rth` — UTC hr 13-20, weekday
- `offhours_active` — UTC hr 10-12 or 21-22, weekday
- `dead_of_night` — everything else

### Per-consumer threshold matrix (minutes)

| Consumer | weekend | dead_of_night | offhours_active | rth |
|----------|---------|---------------|-----------------|-----|
| ct-tape-reader | pass | pass | pass | 30 |
| ct-watcher | pass | pass | pass | 60 |
| ct-curiosity | pass | pass | pass | 120 |
| ct-news-sweep | 720 | 480 | 120 | 120 |
| ct-hypothesis-health-check | pass | pass | pass | 60 |
| ct-hypothesis-proposer | pass | pass | pass | 120 |
| ct-alert-post-mortem | pass | pass | 240 | 240 |
| ct-self-grader | pass | pass | 240 | 240 |
| ct-daily-brief | 1560 | 1560 | 1500 | 1500 |

`pass` means metric_value=0 with explicit "phase=X pass" message — same
semantics as B-4's RTH-only gate at the inactive end.

`ct-news-sweep` is the only Class-1 consumer with a true 24/7 threshold
profile (news doesn't sleep). All others are RTH-only with the
classifier disabling checks during legitimate silence windows.

`ct-daily-brief` 1500-minute (25h) active threshold catches today's
gateway-rewrite-class incident at 14:00 UTC RTH boundary — vs B-4's 26h
threshold + RTH gate which would catch at 15:00 UTC. ~1-hour earlier
detection of the daily-fire-failed class.

### EXISTS-guard

Each invariant returns `metric_value=0` with a dormant message until the
consumer has any row in the last 7 days. Prevents permanent-yellow during
the grace period after deploy. Consumers dead for 8+ days fall back to
`brain_telemetry_consumer_coverage_24h` coverage.

### Path C SQL authoring

Per `docs/runbooks/ct_invariants_sql_authoring.md` (PR #55):

- Single SELECT per `query_sql`
- No inline comments inside dollar-quoted body
- `$inv$` outer dollar-quoting
- Phase classifier as CTE
- EXISTS-guard as CTE

## Cascade catalog instances

**#37 (`audit-comment-state-can-go-stale-when-underlying-state-changes`)**:
The brief's "23-40" estimate didn't survive Phase A. Same class as 5/5
brain_principles audit comment, 5/6 PR #25 ReferenceError, 5/7 v2 Tier 1
already-shipped tools. Phase A first-step verification caught this before
3-4× over-shipping the actual gap.

## D2.2 contamination check

ZERO contamination risk:
- Pure passive monitoring (read-only SQL on `ct_brain_telemetry`)
- No producer code touched
- No specialist surface modified
- No cron schedules changed
- ct_brain_telemetry is append-only (Tenet 16-adjacent) — read traffic
  is bounded

## Acceptance

- Migration applied: `20260507210000_consumer_freshness_24x7_invariants.sql`
- ct_invariants count delta: 45 → 54 (+9)
- All 9 new invariants registered with `enabled=true, severity=warn`
- New category `consumer_freshness` (single-word per project convention,
  instance #35 watch satisfied)
- First warden tick at 17:00 UTC will populate last_status

## Out of scope (deferred)

- 9 event-driven brain consumers — separate "dead consumer" check class
- 20 specialist consumers — already covered + queued behind D2.2 5/14
- 4 cron consumers — already covered (no gap)
- ct_config-driven thresholds — Tenet 16 satisfied by INSERT-into-invariants
  tuning surface; explicit ct_config rows can be added later if a pattern
  of frequent threshold churn emerges
