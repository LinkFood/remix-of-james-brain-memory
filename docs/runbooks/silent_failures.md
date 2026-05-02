# Silent Failure Class — Runbook

**Invariant:** `cron_zero_row_upsert_silent_failure_class`
**Severity:** warn
**Cadence:** every 30 min via System Warden
**Owner table:** `ct_growth_crons` (manifest), `ct_invariants` (config)

---

## What the alarm means

A growth-cron registered in `ct_growth_crons` has not produced fresh rows in its target table within the expected window. The cron may be reporting HTTP 200 + success, but the actual side-effect — rows landing in the table — is not happening.

This is the **silent failure class**: the kind of bug that doesn't crash, doesn't log an error, doesn't fail a health check, and isn't caught by the synthesis layer or cron health monitors. The only signal is *absence of work*.

The Warden makes absence visible.

---

## The canonical case — specialist scoreboard v1, 2026-05-02

The reason this invariant exists.

### Symptom
- `/specialists` page rendered stale data — outcome row showing zero updates over multiple consecutive days
- Cron `ct-specialist-scoreboard-update` reported `last_run_status = succeeded` after each fire
- `ct_specialist_scoreboard` row count was flat at the previous-week value
- No errors in edge function logs (HTTP 200 returned)
- No alerts from cron-health monitor (which gates on HTTP status, not row count)

### Root cause chain
1. RPC `ct_specialist_outcome_stats(p_since_days := 7)` aggregates `ct_flags` by `specialist_ticker` (the per-specialist column).
2. The query did not filter `WHERE f.specialist_ticker IS NOT NULL`. Result set therefore included an extra row aggregating **5,402 flags where `specialist_ticker IS NULL`** (flags from non-specialist sources — detector portfolio, James's hand-flags, etc.). That row carried `specialist_name = NULL`.
3. Edge function `ct-specialist-scoreboard-update/index.ts` upserted the full RPC payload verbatim into `ct_specialist_scoreboard`, which has `specialist_name` as part of its `NOT NULL` PK.
4. The NULL-specialist_name row violated the `NOT NULL` constraint at insert time.
5. **PostgreSQL atomic upsert semantics:** the entire batch rolled back. None of the 10 valid specialist rows landed.
6. The edge function caught the error, logged it as a warning, but **returned HTTP 200** with a partial-success payload.
7. The cron's `net.http_post` saw HTTP 200, marked the job `succeeded`. No alert fired.
8. James caught the staleness by visual diff against prior days (Tenet 13 — "I am the AI").

### Fix class (Tenet 15 — does this class become impossible?)
- **Patch the instance:** `WHERE f.specialist_ticker IS NOT NULL` in the RPC, OR `if (r.specialist_name)` filter in the edge function before upsert. Both are 1-line changes.
- **Kill the class:** the `cron_zero_row_upsert_silent_failure_class` warden invariant. Catches *any* future silent-success-zero-row pattern across all registered growth-crons, not just this one. Adding a new growth-cron = `INSERT INTO ct_growth_crons` — no code change.

---

## How the invariant works

1. The Warden cron (every 30 min) runs `cron_zero_row_upsert_silent_failure_class.query_sql`.
2. The query calls `check_growth_cron_silent_failures()`.
3. That function iterates `ct_growth_crons WHERE enabled=true`, evaluates each row's `scope` (always / rth / weekday / daily) against the current UTC time.
4. For rows currently in scope, it queries `MAX(<freshness_column>)` from the `target_table`.
5. If the gap from `now()` exceeds `expected_window_minutes + 5` (5-min grace for clock skew), the cron is reported as failing.
6. The invariant aggregates all failures into a single metric_value (count). `expected_max = 0` means any failure trips the alarm.

---

## What to do when the alarm fires

1. Read the alarm message — the failure messages list which cron(s) and how stale they are.
2. Query the target table directly:
   ```sql
   SELECT MAX(<freshness_column>) FROM <target_table>;
   ```
   Confirm the staleness.
3. Check the edge function logs for the failing cron (Supabase Dashboard → Edge Functions → Logs).
4. If logs show 200s with no actual writes:
   - Look for "atomic", "rollback", "NOT NULL", "constraint" in error breadcrumbs
   - Check the RPC the function calls — is it returning rows that violate the target table's constraints?
5. If no edge function activity at all — check `cron.job_run_details` for the cron's last few runs. The cron may have stopped firing entirely (vault key missing, schedule unscheduled, etc.).
6. Apply Tenet 15: don't just patch the instance. Ask "what made this class possible?" If the answer is a new failure mode, add a new invariant covering it.

---

## Adding a new growth-cron to the manifest

```sql
INSERT INTO public.ct_growth_crons
  (cron_jobname, target_table, freshness_column, scope, expected_window_minutes, description)
VALUES
  ('ct-my-new-cron', 'public.ct_my_table', 'created_at', 'rth', 30,
   'What this cron does + why it must produce rows on this cadence');
```

`scope` values:
- `always` — check 24/7 (e.g., warden self-check, telemetry)
- `rth` — check only Mon-Fri 13:00-20:00 UTC (e.g., flow ingest, regime capture)
- `weekday` — check Mon-Fri all day (e.g., off-hours scoreboards)
- `daily` — once per day; the +5min grace handles intra-day cron timing

`expected_window_minutes` — set to ~1.5× the cron's expected interval. A `*/30` cron should be ≤45 min stale; a daily cron at 23:00 UTC should be ≤1500 min stale (1 day + grace).

---

## Why this class became important

The synthesis layer (2026-04-30) catches *crashes* — null returns, missing context, exceptions in helpers. Cron health checks (existing) catch *non-firing* — schedules that stopped, vault keys that went missing.

Neither catches **silent atomic rollback inside an HTTP 200**. That's a third failure mode, and the 2026-05-02 specialist scoreboard incident proved it shows up in production. The Warden plus this invariant close the gap.

Tenet 13: hallucination is inevitable; structural prevention is the answer. Same principle applied to silent operational failure: bugs are inevitable; structural visibility into "did the work actually happen?" is the answer.
