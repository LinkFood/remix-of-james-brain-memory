# 2026-05-02 — P0 #3 Score-Race Coverage — Final Audit

**Decision class:** Investigation / coverage verification
**Source pattern:** Class-kill verification per Tenet 15 ("Does this class of failure become impossible going forward?")
**Audit type:** Read-only — no code changes shipped
**Supersedes:** [`2026-05-02-p0-3-score-race-coverage-audit.md`](./2026-05-02-p0-3-score-race-coverage-audit.md)

## Context

**The bug class.** `ct-flow-ingester` writes raw alerts to `ct_flow_alerts`. A scorer turns each alert into a `ct_scored_flow` row carrying `score`. A consumer (`ct-signature-watcher`) reads `score`, decides whether to fire a flag, and writes `ct_flags.score`. If the consumer runs in the gap between alert ingest and scorer-write, the consumer reads `score=NULL`, writes `ct_flags.score=0`, and dedupe in `ct_signature_alarm_log` prevents a re-fire when the score eventually arrives.

**Diagnostic of harm (Apr 27).** 24/26 signature_v1 flags landed with `score=0`. Top scored flag of the day = 45 (vs prior day = 85). Trust-killer.

**Two-layer kill shipped:**
- `f5f2c4e` (Apr 28 morning) — cron-level: watcher cron now runs `ct_score_existing_flow(now()-15min)` in the same SQL statement before invoking the watcher edge function.
- `e88cc79` (Apr 28 afternoon) — function-level: per-alert inline recovery. When `loadScoreForAlert` returns null, watcher force-runs `ct_score_existing_flow` over a 60-sec window around the alert's `executed_at ?? ingested_at`, then re-reads.

**What this final audit verifies.** Did the kill land everywhere a `ct_scored_flow.score` write happens, and is every consumer of `ct_scored_flow.score` either structurally race-free or covered by one of the two layers above? Saturday-night audit claimed "10 functions touch ct_scored_flow" but didn't classify per-call-site. This is the per-call-site classification.

## Phase A — Writer inventory

**Search scope:**
```bash
grep -rn "ct_scored_flow" supabase/functions/ supabase/migrations/ | grep -iE "INSERT INTO|UPSERT|UPDATE.*ct_scored_flow"
```

**Key finding upfront:** ZERO edge functions write to `ct_scored_flow`. All `INSERT`/`UPDATE` traffic flows through SQL RPCs (`ct_score_existing_flow`, `ct_rescore_flow_since`). Edge functions read or invoke RPCs — they do not write directly.

The latest `CREATE OR REPLACE FUNCTION` for each scoring RPC is in migration **`20260424000038_scorer_context_columns.sql`**. Earlier definitions (`20260423000027`, `20260424000003`, `20260424000010`, `20260424000024`, `20260424000022`) are superseded — they would only be writers if rolled back to.

| # | Writer (live) | File:line | Write type | Fields written | Comment |
|---|---|---|---|---|---|
| 1 | `ct_score_existing_flow` (ct_sweeps loop) | `supabase/migrations/20260424000038_scorer_context_columns.sql:652-682` | `INSERT … ON CONFLICT (source_table, source_id) DO NOTHING` | `score`, `raw_score`, `score_breakdown`, `penalty_breakdown`, `classification`, `direction`, all context cols | Atomic single-statement insert. Score is part of the row from creation. |
| 2 | `ct_score_existing_flow` (ct_flow_alerts loop) | `supabase/migrations/20260424000038_scorer_context_columns.sql:739-771` | `INSERT … ON CONFLICT (source_table, source_id) DO NOTHING` | same as #1 | Atomic single-statement insert. **This is the only path that writes scored rows for the live `ct-signature-watcher` race domain.** |
| 3 | `ct_rescore_flow_since` (ct_sweeps loop) | `supabase/migrations/20260424000038_scorer_context_columns.sql:825-845` | `UPDATE public.ct_scored_flow SET … WHERE id = r.scored_id` | `score`, `raw_score`, `score_breakdown`, `penalty_breakdown`, all context cols, `scored_at` | Pure update of pre-existing row. Score never goes from non-null → null. |
| 4 | `ct_rescore_flow_since` (ct_flow_alerts loop) | `supabase/migrations/20260424000038_scorer_context_columns.sql:899-919` | `UPDATE public.ct_scored_flow SET … WHERE id = r.scored_id` | same as #3 | Pure update. |

**Total live writers: 4 SQL paths inside 2 RPCs.** Both RPCs ship in the same migration. There are no other live writers in code or migrations.

**Saturday-night "10 functions" claim — clarified.** That number was 10 *edge functions referencing the table*, not 10 *writers*. Today's grep returns 11 edge functions referencing `ct_scored_flow`, and **all 11 are read-only** (or invoke the RPCs above by name). See Phase B.

### Superseded writer paths (NOT live — kept for archeology)

These earlier `CREATE OR REPLACE` definitions exist in migration history but were overwritten by `20260424000038`. They share the same `INSERT ... ON CONFLICT DO NOTHING` shape with fewer columns:

- `supabase/migrations/20260423000027_v2_flow_scoring.sql:509`, `:564` (original v2 scorer)
- `supabase/migrations/20260424000003_v2_score_flow_alerts_fix.sql:55`, `:132` (added ct_flow_alerts loop)
- `supabase/migrations/20260424000010_classifier_respect_all_opening.sql:294`, `:352` (classifier fix)
- `supabase/migrations/20260424000024_scorer_regime_context.sql:402`, `:479`, `:555`, `:621` (regime cols)
- `supabase/migrations/20260424000022_rescore_recent.sql:54`, `:118` (added rescore RPC)

These do not contribute to the live race surface. Listing for completeness only.

### NOT writers to `ct_scored_flow.score` (called out because they appeared in grep)

- `supabase/migrations/20260428145000_signature_watcher_score_first.sql` — `UPDATE ct_flags … FROM ct_scored_flow` and `UPDATE ct_signature_alarm_log … FROM ct_scored_flow`. Reads ct_scored_flow.score, writes the OTHER tables. Not a ct_scored_flow writer.
- `supabase/migrations/20260428162000_backfill_zero_score_flags_post_inference_fix.sql` — same shape. Backfill of ct_flags.
- `supabase/migrations/20260428190000_backfill_afternoon_zero_flags.sql` — same shape. Backfill of ct_flags.
- `supabase/migrations/20260424000023_regime_columns.sql` — `ALTER TABLE`. Schema change, not a row-writer.
- `supabase/migrations/20260424000038_scorer_context_columns.sql:46-71` — `ALTER TABLE` adding context cols. Schema change.

## Phase B — Per-site classification

### Writers (Phase A)

| # | Writer | Classification | Proof |
|---|---|---|---|
| 1 | `ct_score_existing_flow` ct_sweeps loop | **score-first guaranteed** | The `INSERT INTO public.ct_scored_flow` at `migrations/20260424000038_scorer_context_columns.sql:652-682` writes `score` as one of the named columns in a single `INSERT ... VALUES` statement. There is no window where the row exists without `score`. `ON CONFLICT (source_table, source_id) DO NOTHING` makes the operation idempotent; a duplicate insert is a no-op, never a partial update. |
| 2 | `ct_score_existing_flow` ct_flow_alerts loop | **score-first guaranteed** | Same shape as #1. Insert at `migrations/20260424000038_scorer_context_columns.sql:739-771`. `score` populated atomically in `VALUES (... (j->>'score')::numeric ...)`. **This is the row that ct-signature-watcher reads.** |
| 3 | `ct_rescore_flow_since` ct_sweeps update | **score-first guaranteed** (by precondition) | The `UPDATE` at `migrations/20260424000038_scorer_context_columns.sql:825-845` matches `WHERE id = r.scored_id` — `r.scored_id` is the id of an already-existing scored_flow row from a `FROM ct_scored_flow sf JOIN ct_sweeps sw` (line 808) — meaning the row already had `score` written by writer #1 before this UPDATE runs. The UPDATE replaces an existing score with a recomputed one; it never creates a row with NULL score. |
| 4 | `ct_rescore_flow_since` ct_flow_alerts update | **score-first guaranteed** (by precondition) | Same shape as #3. Update at `migrations/20260424000038_scorer_context_columns.sql:899-919`. Joined `FROM ct_scored_flow sf JOIN ct_flow_alerts fa` (line 881) — row already has `score` from writer #2. |

### Score-readers — confirm "consumer only, no write" + race protection where relevant

11 edge functions reference `ct_scored_flow` in current code. Per-site classification:

| # | Reader | File:line | Reads what | Race-relevant? | Classification + proof |
|---|---|---|---|---|---|
| 1 | `ct-signature-watcher` | `supabase/functions/ct-signature-watcher/index.ts:480-498` | `score` per-alert via `loadScoreForAlert` | **YES — original race target** | **PROTECTED.** Layer 1 (cron-preflight) at `supabase/migrations/20260428145000_signature_watcher_score_first.sql:59-66` runs `ct_score_existing_flow(now()-15min)` ahead of the watcher invocation in one cron statement. Layer 2 (per-alert recovery) at `supabase/functions/ct-signature-watcher/index.ts:488-498` re-runs `ct_score_existing_flow(eventTs - 120s)` if `loadScoreForAlert` returns null. Plus the watcher itself runs an inline preflight at `ct-signature-watcher/index.ts:372-381` (5-min window) before the alert scan. **Three-layer defense in depth.** |
| 2 | `ct-specialist-dispatcher` | `ct-specialist-dispatcher/index.ts:63-71` | `id, ticker, score, event_ts` filtered by `score >= scoreTrigger` | NO — fail-safe | **N/A — race becomes missed-fire, not wrong-fire.** Filter `.gte('score', scoreTrigger)` returns zero rows when scorer hasn't caught up → dispatcher returns `triggered: []` → no specialist fires → no flag. Specialists re-cron every 6 min; scorer catches up; next pass fires correctly. Worst case: 6-minute fire delay on a single alert. The race writes a *correct flag a few minutes late*, never a wrong flag. Acceptable. |
| 3 | `_shared/specialistRunner.ts` `loadCandidateEvents` | `supabase/functions/_shared/specialistRunner.ts:565-588` | Same shape as dispatcher: `score >= wakeupThreshold` filter | NO — fail-safe | **N/A — same fail-safe shape as #2.** Filter strips unscored rows → specialist sees `no_events` → returns early without writing a flag. |
| 4 | `_shared/alarmTiering.ts` `loadScoreForAlert` / `loadScoresBulk` | `_shared/alarmTiering.ts:163-177`, `:184-209` | `score` per alert_id | YES (helper consumed by watcher) | **PROTECTED via caller.** This is a helper. Its only racy caller is `ct-signature-watcher` (Phase B #1), which wraps the helper in the inline-recovery pattern. No other live caller invokes it on the watcher's hot path. |
| 5 | `ct-tape-reader` | `ct-tape-reader/index.ts:240-243`, `:296-313` | Reads scored rows for narrative + ticker tape view | NO — read-only consumer | **consumer only.** Outputs to `ct_tape_reader_runs` and Slack; does not write `ct_flags`. A race here means the tape-reader reads a slightly older snapshot — which is what tape-reader is supposed to do anyway (narrative over time-window). |
| 6 | `ct-eod-summary` | `ct-eod-summary/index.ts:307` | Daily aggregate of scored flow | NO — runs after RTH | **consumer only.** EOD cron fires at 21:30 UTC, well after the last scorer pass of the day. By then there's no live race surface. Writes nothing back to ct_scored_flow. |
| 7 | `ct-eod-report` | `ct-eod-report/index.ts:630` | Daily aggregate (similar to eod-summary) | NO — runs after RTH | **consumer only.** Same justification as #6. |
| 8 | `ct-slack-digest` | `ct-slack-digest/index.ts:147` | Slack digest of scored flow | NO — read-only | **consumer only.** No flag write. |
| 9 | `ct-oi-snapshot` | `ct-oi-snapshot/index.ts:284` | Reads option_symbols from scored_flow to know what to OI-snapshot | NO — uses option_symbol, not score | **consumer only.** Doesn't read `score`; reads `option_symbol` to know which contracts to query UW for. Race-irrelevant — the contract is what we want to track, scored or not. Writes to `ct_oi_snapshots`, not `ct_scored_flow`. |
| 10 | `ct-oi-backfill-historical` | `ct-oi-backfill-historical/index.ts:215` | Same as #9 | NO | **consumer only.** Same as #9. |
| 11 | `ct-score-self-grade` | `ct-score-self-grade/index.ts:105` | Self-grading metric over scored_flow rows N days back | NO — calibration / read-only | **consumer only.** Calibration job. Reads scored rows, writes grade outputs to a different table. Race-irrelevant. |
| 12 | `ct-tape-backfill` | `ct-tape-backfill/index.ts:242` | INVOKES `ct_score_existing_flow(p_since=floor_ts)` | N/A — invokes writer, doesn't write directly | **invoker.** This calls the score-first writer (#1/#2 from Phase A). Is itself protected by the same atomicity that protects writer #1/#2. After this call returns, scored rows exist with `score` populated atomically. |

**Distribution: 4 score-first writers / 0 race-risk writers / 11 readers (1 protected + 10 N/A or consumer-only) / 1 invoker (calls the writer).**

## Phase C — Race risk findings

**Zero remaining race-risk writer sites.**

Structural proof:
1. **All 4 live writer sites are atomic.** The two `INSERT` paths (Phase A #1, #2) populate `score` as part of `INSERT ... VALUES (..., score, ...)` in a single statement; there is no `INSERT ... then UPDATE score` pattern anywhere. The two `UPDATE` paths (Phase A #3, #4) modify rows that already have `score` populated by the prior `INSERT` — they cannot transition `score` from non-null to null.
2. **The original race target (`ct-signature-watcher`) has triple-layer protection.** Cron preflight + edge-function preflight + per-alert inline recovery. All three layers verified at the file:line citations above.
3. **Specialist paths (dispatcher + runner) are fail-safe by filter shape.** A score-race becomes a missed wake-up, recovered on next 6-min cron — never a wrong flag with score=0.
4. **Detector portfolio paths (10 detectors) do not read `ct_scored_flow.score`.** Confirmed by absence in the grep result (`grep -rln "ct_scored_flow" supabase/functions/` returns 0 of the `ct-detector-*` directories — see Phase B table). Detectors read their own data sources.

**No theoretical race surfaces remain.** No logged occurrences of score-race-shaped failures since Apr 28 14:30 ET (per the playbook entry at line 906/914-915).

## Conclusion

**Score-race class is killed across the codebase. Zero remaining race-risk sites.** The two-layer kill shipped Apr 28 (`f5f2c4e` + `e88cc79`) covers the only race-vulnerable consumer (`ct-signature-watcher`); all other readers are either structurally fail-safe or read-only consumers that don't write flags.

P0 #3 archived. Future work: if a new flag-writing function is added that reads `ct_scored_flow.score` and consumes it on a hot path (sub-2-min cadence), the author MUST replicate the inline-producer pattern from `ct-signature-watcher:488-498`. Worth a single-line gotcha in `_shared/alarmTiering.ts` next to `loadScoreForAlert` — current doc-string already gestures at it but doesn't mandate the recovery pattern.

## Corrections to prior audit

- The prior audit (`2026-05-02-p0-3-score-race-coverage-audit.md`) read "10 score-writers" from Saturday-night and dismissed it as misread. **That dismissal was correct**, but the prior audit didn't enumerate the actual live writers explicitly. This final audit names the 4 writer sites at file:line.
- Prior audit claimed "10 detector functions" — actual count is 10 `ct-detector-*` functions (`ct-detector-flow-stack-v1`, `ct-detector-pair-qqq-iwm`, `ct-detector-scoreboard-update`, `ct-detector-scorer`, `ct-detector-small-cap-inverted-put`, `ct-detector-smart-money-repeat`, `ct-detector-unusual-oi`, `ct-detector-weekly-atm-voi`, `ct-detector-whale`, `ct-detector-zerodte-opening-call`, `ct-detector-zerodte-put-voi` = 11). Off by one — minor. None read `ct_scored_flow`, so the conclusion holds.
- Prior audit didn't list `ct-tape-backfill` as a score-RPC invoker. Added in Phase B #12 — it invokes `ct_score_existing_flow` directly, but as an explicit producer (not a race-prone consumer), so not a new risk.

## False premises surfaced from original P0 #3 framing

1. **"10 score-writers."** Saturday-night audit's grep counted 10 *edge functions referencing the table*, not 10 writers. Real writer count is 4 SQL paths inside 2 RPCs in 1 migration (`20260424000038`).
2. **"Score-write surfaces" ≠ "ct_scored_flow.score writers."** The Apr 28 backfill migrations (`20260428145000`, `20260428162000`, `20260428190000`) write `ct_flags.score` and `ct_signature_alarm_log.score` *from* `ct_scored_flow` — they read scored_flow, write the consumer tables. They are not ct_scored_flow writers.
3. **"Detector flag-writes might race."** They don't, because none of the 10–11 `ct-detector-*` functions read `ct_scored_flow.score`. Detectors read their own UW-sourced data and write their own flags. The score-race class doesn't reach them.

## Related

- Prior framing: [`docs/decisions/2026-05-02-p0-3-score-race-coverage-audit.md`](./2026-05-02-p0-3-score-race-coverage-audit.md)
- Saturday-night audit context: [`docs/decisions/2026-05-02-saturday-night-audit-results.md`](./2026-05-02-saturday-night-audit-results.md) item 7 (line 127-)
- System map row: `docs/system-map/tables.md:56` (`ct_scored_flow`)
- Playbook section: `docs/LINKJAC_COTRADER_PLAYBOOK.md:770` (`### 3. Per-alert score-race fix coverage audit`)
- Class-kill commits: `f5f2c4e` (cron preflight, Apr 28 morning), `e88cc79` (per-alert recovery, Apr 28 afternoon)
- Live scorer migration: `supabase/migrations/20260424000038_scorer_context_columns.sql`
- Live signature-watcher cron: `supabase/migrations/20260428145000_signature_watcher_score_first.sql`
- Memory: `feedback_signature_watcher_score_race.md`
