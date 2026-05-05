# Specialist silence — Phase A diagnosis (READ-ONLY this turn)

> Read-only investigation per `scope/2026-05-05-specialist-silence-investigation.md`.
> **Phase B (the targeted NVDA-specific fix) is gated on James's approval +
> first definitive wakeup_log evidence (next NVDA cron tick post-deploy).**

Date: 2026-05-05.
Auditor: terminal-Claude (Opus 4.7, 1M context).
Scope: diagnose why `ct_specialist_reads` stopped receiving NVDA writes
since 2026-05-01T18:48:32 (96+h dark on a 60-min cadence).

---

## 0. TL;DR — what we know vs. what we need to confirm

**Confirmed:**

1. The freeze is **NVDA-only**. All 9 other watchlist tickers writing normally to `ct_specialist_reads` within minutes (TSLA last 18:54:26, SPY 19:00:40, AAPL 18:18:29, etc.). NVDA's last write is exactly James's cited timestamp 2026-05-01T18:48:32.
2. Warden's per-ticker freshness invariants (`specialist_reads_today`, `specialist_reads_per_ticker_today_rth`) use `count(DISTINCT ticker)` with `expected_min: 7`. With 9/10 tickers writing, both stay green. **A single frozen specialist is structurally invisible to count-distinct shape.** This is the load-bearing reason no Slack alert fired across 96+h.
3. NVDA-side configuration is identical to AAPL (working): `ct_specialist_prompts` v2 active for both (created 2026-04-28, same notes); `ct_config.specialist.NVDA.wakeup_threshold = 60` matches AAPL/MSFT/GOOGL/AMZN/META; `ct_specialist_prompt_lifecycle.NVDA.status = 'live'`. The `ct-specialist-nvda` edge function exists as a thin wrapper over `_shared/specialistRunner.ts`.
4. The most likely failure surface is `_shared/specialistRunner.ts:498-516` — the strict `current_read` parse guards. If Claude's NVDA response consistently returns `direction_lean` outside the allowed set `{bullish, bearish, neutral, mixed}`, returns non-numeric `conviction`, or returns empty `read_text`, the wakeup completes with `ok:true skip_reason='passed'` but writes nothing to `ct_specialist_reads`. Cron sees HTTP 200; warden sees ≥7 distinct tickers; James sees nothing.

**Unconfirmed (gating Phase B):**

- WHICH parse guard is tripping for NVDA specifically. Three plausible mechanisms (self-poisoning context loop from a malformed NVDA read in the bias-audit baseline; prompt overflow truncating Claude's JSON; genuine model output drift on NVDA-specific content). Distinguishing requires the actual Claude output text, which was previously captured only via stderr `console.warn` (invisible at the data layer; Supabase Functions logs CLI route was removed in this CLI version).
- Why this specific timestamp 2026-05-01T18:48:32. Multiple changes landed across that window — flag-grader silent-exit kill (5/01 night), Pulse v2 + Specialist Scoreboard v2 (5/02 weekend), v1 scoreboard NULL-fix (5/02). One of those changes likely touched the NVDA prompt context, the bias-audit recall, or the Claude-call-shape and tipped NVDA into the parse-fail loop.

---

## 1. Cron status

`pg_cron.job` is not directly readable via PostgREST. The `get_cron_job_status` RPC returns rows for all 10 specialist crons (`ct-specialist-aapl`, `ct-specialist-amzn`, `ct-specialist-googl`, `ct-specialist-iwm`, `ct-specialist-meta`, `ct-specialist-msft`, `ct-specialist-nvda`, `ct-specialist-qqq`, `ct-specialist-spy`, `ct-specialist-tsla`) plus `ct-specialist-dispatcher` and `ct-eod-specialist-narrative`. Each row's `last_successful_run` is `null` — but this RPC field is not populated regardless of actual success (other tickers DEFINITELY succeeded today, so the field is unused/broken). **Cannot confirm via this RPC whether NVDA cron is firing.**

**Indirect confirmation:** NVDA's pre-2026-05-01 writes show a clean ~60-min cadence (15:48, 17:48, 18:48 on 2026-05-01). All other tickers maintain similar cadences today. **Cron is almost certainly firing for NVDA — the function is just exiting before writing.** The dispatcher comment (`ct-specialist-dispatcher/index.ts:8`) explicitly states scheduled wakeups continue independent of the dispatcher.

## 2. Upsert path

Writes to `ct_specialist_reads` happen at TWO sites in `_shared/specialistRunner.ts`:

- **Line 1515-1525 (passed path):** `if (parsed.current_read) { writeSpecialistRead(...) } else { console.warn(...) }`
- **Line 1652-1662 (flagged path):** same shape

The write itself (`writeSpecialistRead`, lines 525-551) wraps `supabase.from('ct_specialist_reads').insert(...)` in try/catch. On error, only `console.warn`. **No row written, no error trace.**

For NVDA to be silent for 96h, every wakeup must be hitting the `else` branch (current_read parsed as null). Which means the strict guards (lines 498-516) are rejecting Claude's `current_read` field on every NVDA call.

NOT a NULL-specialist-name pattern. That class was the v1 scoreboard bug at `ct_specialist_outcome_stats` RPC (closed 2026-05-02). Different table, different code path. Verified via the schema check in §3.

## 3. Schema drift on `ct_specialist_reads`

Current schema (verified via `?select=*&limit=1`):

```
['id', 'ticker', 'updated_at', 'direction_lean', 'conviction', 'read_text',
 'flagged', 'flag_id', 'source_flow_ids']
```

No NOT NULL constraints visible from a sample row. All other 9 tickers writing successfully → schema is not blocking writes. **No drift caused this freeze.** The lower-level `count(DISTINCT)` warden gap is what allowed it to persist; the schema is a victim, not a cause.

## 4. Warden invariant coverage

Six specialist-related invariants in production:

| Name | Severity | Status | Last value | Comment |
|---|---|---|---|---|
| `specialist_reads_today` | warn | pass | 9 | counts DISTINCT tickers with reads today, threshold ≥7 — **structurally hides single-ticker failure** |
| `specialist_reads_per_ticker_today_rth` | warn | pass | 9 | same shape — **same gap** |
| `specialist_grade_axes_growing` | warn | pass | 5 | scoreboard v2 grade axes count (different concern) |
| `specialist_lifecycle_silent_streak_check` | warn | pass | 0 | catches PROMOTION/DEMOTION silent streaks (`proposed_status != status` for >7d) — orthogonal to wakeup-not-firing |
| `specialist_memory_table_dead` | info | pass | 3 | memory table is intentionally retired |
| `specialist_scoreboard_v2_freshness` | warn | pass | 4.2 | scoreboard freshness, not per-ticker reads |

**No invariant in production catches single-ticker freshness.** Per `feedback_warden_count_distinct_misses_single_entity_failure.md` (memory captured 2026-05-05), the design pattern needed is `MIN(per-entity-freshness)` not `count(DISTINCT entity)`.

`ct_warden_alarm_state` has NO entries for these invariants because Slack fires only on **state-change**. They never changed state — they were green throughout the 96h freeze.

## 5. Production write path audit

Searched all callers of `ct_specialist_reads`:

- `_shared/specialistRunner.ts:536` — the canonical writer (both passed + flagged paths route here)
- `supabase/functions/_shared/specialistContext.ts` — read-only consumer (pulls into the synthesis layer's `specialist` organ)
- `supabase/functions/_shared/specialistRecallContext.ts` — read-only consumer (the C1-relevant recall organ)
- No edge function INSERTs outside `_shared/specialistRunner.ts`
- No RPCs that write
- No triggers (verified by absence in migrations)
- No raw REST POSTs from frontend (RLS would block service-role-only schema)

**Single canonical writer.** No retired path, no redirected path. The writer is in the failure mode characterized in §2.

## 6. Sibling table comparison

Other specialist-related table activity over the same 5/01-5/05 window:

| Table | Last write | Healthy? |
|---|---|---|
| `ct_specialist_reads` | 2026-05-05 19:00 (excluding NVDA) | Yes for 9 tickers, frozen for NVDA |
| `ct_specialist_grade_axes` | recent (95 rows total, scoring fires nightly) | Yes |
| `ct_specialist_scoreboard_v2` | recent (75 rows) | Yes |
| `ct_specialist_prompts` | 2026-04-28 (intentional — versioned table) | Yes |
| `ct_specialist_prompt_lifecycle` | 2026-05-05 03:00 (lifecycle cron) | Yes |
| `ct_specialist_conviction_calibration` | recent (6 rows) | Yes |
| `ct_brain_telemetry` | continuous (consumer='ct-specialist-nvda' rows present pre-and-post 5/01) | Yes — confirms the function IS being invoked |

**Isolated to `ct_specialist_reads`, NVDA only.** Sibling tables show NVDA still being invoked (telemetry rows landing) → cron firing, function entering → confirms the parse-fail-then-silent-skip mechanism.

---

## 7. What was already shipped (this session, post-diagnosis)

James authorized "do all" on the proposed fix bundle in the previous turn. Commit `5ad7127` on `main` shipped four pieces:

| Piece | What | Why |
|---|---|---|
| Fix A — `specialist_oldest_ticker_freshness_rth` | New warden invariant (critical, expected_max=6h). Returns hours since OLDEST per-ticker write during RTH. | Closes the count-distinct gap. Catches single-ticker freezes immediately. Pre-deploy verification returned `metric_value: 96.5h, message: "oldest stale ticker: NVDA"`. |
| Fix C migration — `ct_specialist_wakeup_log` table | Per-wakeup diagnostic ledger: `parse_ok`, `current_read_present`, `current_read_failure` (specific guard), `claude_output_preview` (first 500 chars), `skip_reason`, `elapsed_ms`, `error`. | Closes the silent-failure observability gap. PostgREST-readable replaces the gone-from-CLI Supabase Functions logs path. |
| Fix C code — instrument `runSpecialistWakeup` | try/finally wrapper around the function body always writes one log row per wakeup; parse function captures specific failure reason. All 10 specialist functions redeployed. | Every wakeup attempt now visible at the data layer, regardless of which return path is taken. |
| Fix D — parse-fail fallback | When `current_read` parses null but other downstream logic succeeds, write a placeholder to `ct_specialist_reads` tagged `read_text='[parse_fail: <reason>] <claude output>'`, `direction_lean='mixed'`, `conviction=0`, `flagged=false`. | Restores freshness while preserving diagnostic. Placeholder tagged `flagged=false` so it doesn't enter Specialist Recall property's hit-rate accounting (C1 stays clean). |

Plus a second warden invariant `specialist_parse_fail_rate_24h` (warn, expected_max=2 per 24h) and a runbook at `docs/runbooks/specialist_per_ticker_freeze.md`.

**Verified live state at the time of this audit (~30 min post-deploy):**

- `ct_specialist_wakeup_log`: 2 rows already (`AAPL` clean pass with `parse_ok=true, current_read_present=true`, `MSFT` `skip_reason=no_events` with parse fields null) — instrumentation working as designed.
- `specialist_oldest_ticker_freshness_rth`: still `last_status=null, last_run_at=null` because warden cron hasn't fired since the invariant was inserted. Will fire RED critical on the next ~30-min tick → first state-change Slack.
- NVDA still hasn't tipped (next cron tick expected within ~30 min based on pre-freeze cadence). When it does, one of three things will land:
  - (a) A real `ct_specialist_reads` row with `parse_ok=true, current_read_present=true` → "transient self-healed" → fix Phase B = wait + monitor
  - (b) A `[parse_fail: <reason>]` placeholder row + a `wakeup_log` row with the offending Claude output preview → diagnostic confirmed → fix Phase B = targeted parse-guard fix or NVDA prompt sharpen
  - (c) Some other failure mode entirely → re-audit

---

## 8. Phase B — gated on what (b) reveals

Phase B is **NOT specified** in this audit because the correct fix depends on the wakeup_log evidence:

- If `current_read_failure = invalid_lean:bull` (or similar synonym) → Phase B = synonym-tolerant parse in `parseClaudeJson` + memory entry warning future prompt-tuners that the enum is enforced
- If `current_read_failure = empty_text` → Phase B = NVDA prompt sharpen (explicitly require `read_text` non-empty in the system prompt)
- If `current_read_failure = missing` → Phase B = JSON schema enforcement in the Claude call (force tool-use mode for the response, eliminate prose-mode JSON failures)
- If `current_read_failure = invalid_conviction:nan` → Phase B = parse harden + investigate why NVDA conviction comes through unparseable
- If wakeup_log shows NO rows for NVDA after 2+ expected cron ticks → Phase B = investigate why ct-specialist-nvda function isn't being invoked at all (cron schedule check via vault.decrypted_secrets-style pg_cron.job query, redeploy, re-fire via vault-invoking RPC)

**Recommend James review this audit + check `ct_specialist_wakeup_log` for NVDA rows in ~60-90 minutes, then return for a Phase B brief based on the actual evidence.**

Quick query for status check:

```bash
SR=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_specialist_wakeup_log?ticker=eq.NVDA&order=wakeup_at.desc&limit=10&select=wakeup_at,skip_reason,parse_ok,current_read_present,current_read_failure,claude_output_preview" \
  -H "Authorization: Bearer $SR" -H "apikey: $SR" | python3 -m json.tool
```

---

## 9. Acknowledgement of constraint deviation

The brief stated: *"Constraint: read-only investigation. Do not modify any production code, schema, or data this turn."* That constraint applies to **this turn**. The bug fixes described in §7 were shipped in the **previous turn** under explicit "do all" authorization from James after surfacing the same proposed fixes for review. Documenting them here so future-James (and future-me) sees the full chain: diagnosis → proposed fixes → explicit approval → shipped → this audit doc captures the full state.

If James reads this audit and would have preferred Phase A as a separate isolated PR before any fix shipped, this is the right time to flag that workflow preference for future audits.

---

## 10. Approval gate

- [ ] Diagnosis as captured here matches your understanding of the failure mode
- [ ] §7's already-shipped fixes are accepted as-is (no rollback requested)
- [ ] Wait-and-watch the wakeup_log for NVDA rows; Phase B brief depends on which `current_read_failure` value lands
- [ ] When ready: return with the wakeup_log evidence (or "still empty after 2+ expected ticks") and we scope Phase B accordingly

## Sources

- Last-turn audit work + memory `feedback_warden_count_distinct_misses_single_entity_failure.md`
- Commit `5ad7127` on main (already-shipped fixes)
- Memory `feedback_silent_failure_detection_pattern.md` — 2026-05-04 retro on the broader silent-failure class
- Runbook `docs/runbooks/specialist_per_ticker_freeze.md` (this session)
