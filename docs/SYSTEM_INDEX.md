# System Index — Where to Start

If you're a future Claude session and the System Warden flagged something, or James pasted a Slack alert into chat, or a badge on the site looks wrong — start here. Find your category below, follow the link in reading order, and don't pattern-match the symptom to whichever runbook you read most recently. The categories are the load-bearing distinctions; the symptom is the cover.

---

## Brain / Synthesis Layer broken
Symptoms: `/health` RPC returns errors, helper warnings everywhere, a consumer's prompt missing a section it used to have, telemetry showing a sparse `consumers[]` list.

1. `docs/SYNTHESIS_LAYER.md` — operational reference. The 9 organs, audience filter, read/write separation rule (D4), how to add an organ.
2. `docs/SYNTHESIS_LAYER_ARCHITECTURE.md` — design rationale and decision log. Read when "should I do X" is the question.
3. `docs/runbooks/hallucination_class.md` — when temporal anchor / event recency is the failing piece.

---

## Budget views or rate limiting wrong
Symptoms: UW budget badge drops to 0% mid-session, Tavily count vanishes at month boundary, Slack EXHAUST alert fires then "recovers" without anything actually changing.

1. `docs/runbooks/budget_views.md` — the runbook.
2. `~/.claude/projects/-Users-jameschellis/memory/feedback_budget_views_use_et_not_utc.md` — the canonical bug class. The Warden was built because of this.

---

## UW pollers stopped or wrong data
Symptoms: `/tape` stale, ct_flow_alerts not advancing, ct_uw_usage hourly count drops to zero mid-day, contract poller missing rows.

1. `docs/runbooks/uw_pollers.md` — the runbook.

---

## Specialists silent or biased
Symptoms: ct_specialist_reads has no row for some watchlist ticker, all flags one-sided (bullish or bearish), specialist scoreboard frozen, Sonnet output truncates mid-array.

1. `docs/runbooks/specialists.md` — the runbook.
2. `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_specialist_bias_weekend.md` — the prompt-bias precedent.

---

## Cron didn't fire / fired-but-zero-rows
Symptoms: cron-health card red, last_run_at stale, last_run_status='failed' or 'never', or "succeeded" but nothing landed in the target table.

1. `docs/runbooks/cron_health.md` — the runbook. Especially: pg_cron's "succeeded" reflects the SQL, not the HTTP response. The ct-session-analog 404 precedent lives here.

---

## Detector flags wrong / missing
Symptoms: ct_flags has 0 rows for a detector today, score=0 on all flags > 6 min old, detector lifecycle stalled, scoreboard not updating.

1. `docs/runbooks/detectors.md` — the runbook.

---

## Data freshness (flow_alerts, news, OI snapshots)
Symptoms: latest row in ct_flow_alerts > 10 min old during RTH, ct_news_analyses gap, ct_oi_snapshots missing for the day, /tape banner says "stale".

1. `docs/runbooks/data_freshness.md` — the runbook. Per-table freshness expectations and the diagnostic ladder.

---

## Hallucinations / temporal anchor / event recency
Symptoms: morning brief / EOD report frames yesterday's events as today, Claude promises to "pull live" something, preamble says wrong day, specialist quotes a refuted hypothesis as live.

1. `docs/runbooks/hallucination_class.md` — the runbook.
2. `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_morning_brief_temporal_bug_2026_04_30.md` — the canonical incident. 2026-04-30 brief framed Wednesday's FOMC + Mag7 earnings as Thursday. Read this before touching the temporal stack.

---

## System Warden — adding invariants and reading health

Manifest table: `public.ct_invariants` (one row per check). Append-only history: `public.ct_invariant_log`. Slack one-fire-per-state-change tracking: `public.ct_warden_alarm_state`. Migration: `supabase/migrations/20260501050000_system_warden.sql`.

**Add a new invariant — 2 steps:**
1. Write a SELECT-only query that returns one row with columns `(metric_value numeric, message text)`.
2. `INSERT INTO ct_invariants (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path) VALUES (...)`. The Warden cron picks it up on the next run. No code change.

**Read current Warden health:**
```sql
SELECT public.get_warden_health(window_hours => 24);
```
Returns `totals` (passing/failing/errored/never_ran/critical_failing), `by_category` breakdown, and a `failures[]` array sorted by severity then `consecutive_fails`. Each failure carries its `runbook_path` — that's the link back into this index.

**Severity grades:** `info` (log only), `warn` (Slack on first fail and on recovery), `critical` (Slack on first fail, on every escalation, and on recovery).

---

## Memory layer — persistent feedback and project notes

The user's auto-memory at `~/.claude/projects/-Users-jameschellis/memory/MEMORY.md` is the persistent index across sessions. It lists every `feedback_*.md` (rules James has given) and `project_*.md` (incidents, decisions, pickup state) with one-line hooks. Read it on session start; cite specific files when this index points there.

The agent-memory at `~/.claude/agent-memory/core-logic-builder/MEMORY.md` is this builder agent's own learnings — patterns, gotchas, schema-verification reminders. Read on session start, write when something non-obvious bites.
