# Incident retrospective — PR #25 ReferenceError + false key-rotation diagnosis

**Date:** 2026-05-06 (Wed, RTH).
**Severity:** P0 — captain dark on /tape during active RTH.
**Outage window:** 12:14Z (PR #25 redeploys land) → ~15:00Z (hotfix PR #26 redeploys land). ~2h45m.
**Forensic gap:** ct_tape_commentary, ct_brain_telemetry, and 18 brain-consumer outputs have a 2h45m hole. Per directive: NO backfill. The hole IS the forensic record.
**Hotfix:** PR #26, commit on main 2026-05-06T15:13Z.

This retrospective threads two lessons because they're a paired class kill: the bug is preventable at build time, the false diagnosis is preventable at audit time. Both layers are worth instrumenting separately.

---

## Lesson 1 — the bug itself: use-before-declaration ReferenceError

### What happened

PR #25 (commit `7c7a4aa`) added per-consumer config-resolution to the flow_heatmap helper. To thread `consumerName` from `buildClaudeContext` into `helperOpts`, the edit added one line at `supabase/functions/_shared/claudeReadSurface.ts:1983`:

```typescript
const helperOpts: HelperOpts = {
  ...(tickerFocus ? { tickerFocus } : {}),
  ...(consumerName ? { consumerName } : {}),  // ← added in PR #25
  ...(perOrganOpts[name] ?? {}),
};
```

The variable `consumerName` was **not declared in the surrounding scope.** It is declared at line 2011 — but inside an inner async telemetry block, after this code path has already executed. In Deno's strict ES modules, line 1983 throws `ReferenceError: consumerName is not defined`.

### Why it shipped

- `npm run build` (Vite + tsc against `src/`) does not type-check `supabase/functions/`. Deno files are outside the TS compilation graph (`tsconfig.app.json` only includes `src/`).
- CI's only TypeScript gate is the Vite build. There is no Deno-side type check, no `deno lint`, no `deno check supabase/functions/_shared/*.ts` step.
- The reviewer (me) didn't notice the bare-identifier reference because the surrounding code uses `tickerFocus` and `perOrganOpts` as local consts in the same scope — `consumerName` looks parallel and reads as if it should be in scope. The author's eye and the reviewer's eye were the same eye.

### Why it was silent

- The `helperOpts` construction is OUTSIDE the inner `try/catch` (line 1986 wraps only `h.fetch`). The ReferenceError fires before `h.fetch`, propagates out of the async lambda, rejects the `Promise.all`, and `buildClaudeContext` throws.
- Calling functions that wrap `buildClaudeContext` invocations in their own try/catch swallow the exception. The function returns 200 (or 500 — irrelevant once the inner work is dead) but never reaches its row-write.
- pg_cron records `last_run_status: succeeded` because `net.http_post` succeeded — it doesn't reflect the function's response code or its row-write outcome. Silent-success-zero-row class.

### Detection

James opened the /tape page and noticed it was reading yesterday's close. The frontend hook (`useTapeReader`) was healthy — it queried `ct_tape_commentary` correctly, but the latest row was `id=1019` from 2026-05-05T21:01:31Z. **Frontend correctly surfaced the absence; the absence was on the backend write side.**

The warden's own `cron_zero_row_upsert_silent_failure_class` invariant **did fire at 13:00Z** with `last_value=4`. I dismissed it as a pre-RTH boundary condition — wrong. The growing list at 13:00Z included `ct-flow-ingester-perticker-rth` (a real RTH cron with no rows yet) but the count of 4 implied 3 OTHER crons were also silent. I looked at the topmost item, saw the pre-RTH explanation, and stopped. **The probe worked. The reviewer did not.**

### Class kill candidates (queued for separate per-PR approval)

#### A. Deno-strict CI gate

Add a CI step that runs `deno check supabase/functions/**/*.ts` on every PR touching `supabase/functions/`. This catches use-before-declaration at PR review time, before merge. Estimated cost: <5 minutes/run, no production write surface.

#### B. Pre-deploy probe

After every `supabase functions deploy` of an audience-`cotrader` brain consumer, fire a synthetic invocation against the deployed endpoint with the cron's vault key. Verify:
- HTTP 200 (auth path good)
- A telemetry row landed (`ct_brain_telemetry` row with `consumer_name=<deployed_fn>` written within last 30s)

If either fails, the deploy is rolled back automatically. Catches the silent-success-zero-row class at deploy time, not 2h45m later when the captain notices.

#### C. Strengthen the warden's silent-failure invariant

The current `cron_zero_row_upsert_silent_failure_class` has `last_value=4` but the invariant query returned `1` shortly after (the count was decaying toward bell). Today's incident shows the count meaningfully increased post-12:14Z — but the rolling window's noise hid the signal. Candidate: add a per-cron-jobname instance of the invariant so each silent jobname is its own row instead of a count, and the message string carries the jobname list. Drives operator attention to each jobname rather than a count.

**Decision-ritual gate:** A is the cheapest class kill (CI-time check, no runtime cost). B is the most thorough but adds deploy-time cost. C is complementary observability. Recommend A immediately, then B, then C if budget allows. None ship in this round.

---

## Lesson 2 — the diagnosis itself: false-cause inference cascading toward a non-fix write

### What happened

When James reported "/tape is on yesterday close," I cycled through the following diagnoses in sequence:

1. **First hypothesis (correct shape, wrong target):** RTH ingestion is broken. Pulled latest `ct_flow_alerts` rows. They were fresh (TSLA 14:20:05Z, 3 min before the query). **Refuted.**

2. **Second hypothesis (incorrect):** the warden's pre-RTH `cron_zero_row_upsert_silent_failure_class` warn at 13:00Z (which I'd dismissed earlier) was the actual signal. Pulled the underlying RPC. It returned 1 row pointing at `ct-flow-ingester-perticker-rth` with no rows yet. **I declared this a pre-RTH boundary condition based on the topmost row alone — without examining what `last_value=4` meant if the RPC returned 1.** That was the first methodological error: the warden's own framing was suspect, and I did not run Path 1 (verify-the-warden's-own-framing) on it.

3. **Third hypothesis (incorrect, almost shipped):** my redeployed functions are silently failing because the service-role key rotated between the cron's vault entry and my redeployed function envs. Built this on:
   - The 401 response from manual curl invocations of redeployed functions.
   - The morning's adjacent memory entry `feedback_service_role_key_rotation.md`, which described an exactly-this-shape class.
   - The temporal coincidence (specialists deployed 2026-05-05, redeploys deployed 2026-05-06; rotation could have happened in the gap).

   I escalated this to James as the diagnosis with a Path 1 → Path 3 recovery plan. James APPROVED Path 3 conditional on Path 1 confirming key divergence.

4. **Path 1 execution (correct):** read CLI service_role key, compared to function envs by invoking ct-flow-ingester (NOT redeployed, currently working) and ct-specialist-nvda (NOT redeployed, currently working). **Both returned 401 to my CLI key.** This was the first piece of evidence inconsistent with the key-divergence hypothesis: if the key were the issue, ct-flow-ingester (which produces rows every 5 min via cron) should have authenticated my CLI key. It didn't. **Pivot point.**

5. **Re-grep:** I went back to my own PR #25 diff and read the modified lines on `claudeReadSurface.ts`. Found the bare `consumerName` identifier at line 1983. The fix was a one-line declaration.

6. **Re-escalation:** told James the diagnosis was wrong, the bug was a ReferenceError I'd introduced, and asked for fresh approval for the corrected fix. James approved the one-liner. Hotfix merged at 15:13Z.

### What I did wrong

**The third hypothesis was a false-cause inference from an adjacent-shape memory entry.** The methodology-errors-cascade pattern includes "brief-author-premise-error" as a documented family. I had the morning's `feedback_service_role_key_rotation.md` memory loaded. The shape "redeployed functions return 401" + the memory entry "service-role-key rotation has bitten before" produced a hypothesis-shaped-as-conclusion before I empirically verified.

The verification step that would have caught this: invoke a NON-redeployed function (e.g., ct-flow-ingester or ct-specialist-nvda) with my CLI key BEFORE concluding key divergence. If non-redeployed functions ALSO 401, the issue isn't deploy-time key rotation — it's something else. I skipped this step in the original escalation. James's gating of Path 3 on Path 1 forced me to do it.

**Path 1 saved a wrong write.** This is the first real-time (not retrospective) instance of the methodology-errors-cascade pattern preventing a non-fix from shipping. Previously this pattern was caught only AFTER the wrong fix had landed and the audit re-traced the cause. Today the discipline operated as intended at the right moment.

### Class kill candidates (queued for separate per-PR approval)

#### D. Verify-the-warden's-own-framing as standard Phase A step

Today's failure mode of dismissing the 13:00Z warn shows that "audit the warden's own framing" needs to be the **first** action when a warden invariant fires, not the last. Update the warden runbook (`docs/SYSTEM_INDEX.md` and individual `runbook_path` targets) to require that as the opening question on any failure investigation. Ties to the `feedback_warden_filter_completeness_class.md` and `feedback_audit_query_hidden_row_caps.md` lessons from this morning — same forcing function applied to a warden warning instead of an audit query.

#### E. False-cause inference forcing function

When a hypothesis is shape-matched against an adjacent memory entry (e.g., `feedback_*` files cited as the diagnosis), require **at least one orthogonal verification step** before treating the hypothesis as a premise. Today's case: the ct-flow-ingester / ct-specialist-nvda invocations would have refuted the key-divergence hypothesis in <5 min. They were skipped because the memory-entry shape-match felt sufficient.

#### F. methodology-patterns.md entry for instance #11

Capture this as the first **real-time-not-retrospective** instance of the cascade. Future readers see that the discipline operated correctly today — Path 1 caught the false diagnosis before the write. The catalog grows with the negative example as well as the positive ones.

**Decision-ritual gate:** D is the lowest-cost change (runbook edit). E is harder to operationalize without becoming a process drag, but the principle is the right one. F is straightforward. Recommend D + F now; E gets thought before shipping.

---

## Forensic record (preserved per directive)

The following gaps are preserved as evidence — no backfill:

| stream | last write before incident | first write after incident | gap |
|---|---|---|---|
| `ct_tape_commentary` | id=1019, 2026-05-05T21:01:31Z (yesterday's close, flag_interrupt) | id=1022, 2026-05-06T15:01:28Z (15:01Z post-deploy flag_interrupt) | 17h59m calendar / 1h31m RTH (since bell at 13:30Z) |
| `ct_brain_telemetry` (consumer in 18-redeploy set) | various pre-12:14Z | various post-15:00Z | ~2h45m |
| `ct_watcher_*`, `ct_eod_summaries`, `ct_trade_advisories`, etc. | their respective pre-12:14Z writes | will appear as their crons fire on cadence post-15:00Z | varies by cron |

The 13:00Z warden warn `cron_zero_row_upsert_silent_failure_class=4` stands as the structural detection that fired on time and was dismissed by the operator. **The probe worked. The reviewer did not.** That distinction is the framing this retro preserves.

---

## Methodology-patterns.md entry (proposed text, ships in separate PR)

> **Instance #11 — false-cause inference cascading toward a non-fix write (real-time, not retrospective).** 2026-05-06 RTH. PR #25 introduced a `ReferenceError` on `consumerName` (use-before-declaration in `claudeReadSurface.ts:1983`). When 18 redeployed functions silently failed, I pattern-matched the 401 symptom against the adjacent memory entry `feedback_service_role_key_rotation.md` and proposed a Path 3 (service-role-key rotation) fix. James's gating of Path 3 on Path 1 (verify-the-warden's-own-framing, applied here as verify-the-key-divergence) forced an empirical check that refuted the hypothesis in <5 min. The actual bug was traced and fixed in another <10 min. **First real-time-not-retrospective instance of the cascade pattern: discipline directly prevented shipping a non-fix.** Forcing function: any hypothesis shape-matched to an adjacent memory entry requires at least one orthogonal verification step before treating it as premise.

---

## Action queue (all post-D2, all per-PR)

1. **Hotfix PR #26 merged.** ✓
2. **This retro doc.** PR-only on docs/, this PR.
3. **Class-kill candidate A** (Deno-strict CI gate) — separate PR.
4. **Class-kill candidate D** (verify-warden's-framing as standard Phase A step) — runbook update PR.
5. **Class-kill candidate F** (methodology-patterns.md instance #11) — separate PR.
6. **GOOGL/AMZN/META Phase A** (queued earlier today) — still pending D2 acceptance signal from James.
