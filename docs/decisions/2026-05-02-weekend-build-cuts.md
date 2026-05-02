# 2026-05-02 — Weekend Build Cuts + Phase A Audit

**Decision date:** 2026-05-02 ~00:15 UTC (Friday night → Saturday early morning ET)
**Author:** James + Claude (audit-first discipline)
**Audit scope:** weekend punch list, Phase A only. Phase B for Tier 2 items extends Mon-Tue.

## Context

This decisions doc was created during a Phase A audit of a "75%-shipped"
weekend brief. Brief used Tier 1 / Tier 2 framing that was internal to the
brief itself, NOT documented in `docs/LINKJAC_COTRADER_PLAYBOOK.md`. The audit
recalibrated the remaining work downward — substantially more was DONE or
OBSOLETE than the brief implied.

This doc captures:

1. The Tier mapping the brief used (so future sessions can verify)
2. The cut adopted for the 48-hour weekend
3. A Tenet 13 moment — a build-layer architectural regression caught by the
   Warden, fixed inside the same session that introduced it

## Tier mapping (internal to the prior brief — not anchored to playbook)

The prior brief used numbered Tier 2 items 9, 10, 11. They map to:

- **#9 — Detector lifecycle automation.** Substrate: `ct_detectors` table
  (14 rows: 10 shadow / 3 live / 1 trial), `_shared/detectorRegistry.ts`
  with state-based filtering (shadow / trial / live / decay / retired).
  Phase A: substrate is healthy, schema supports lifecycle promotion.
  Phase B (writing the auto-promote/demote logic) is 2-3 days, will not
  finish in Mon-Tue alone — propose continuing care into Wed.
- **#10 — Per-detector docs** (`docs/detectors/<name>.md`, one per row).
  Phase A this Sunday: list rows, identify each detector's source file,
  scope what each doc page would contain. Phase B (writing 14 pages)
  extends Mon-Tue.
- **#11 — `docs/DOMAIN_GLOSSARY.md`.** Doc-only this weekend. **Do NOT
  wire into `buildClaudeContext` preamble until after the Specialist
  Recall C1 hit-rate measurement window closes (2026-05-15).** The wire
  is a separate structural change with its own measurement window.

The numbering was internal to the prior brief. The playbook's organizing
scheme is `LB1..LB8 / P0 / P1 / P2`. Future sessions: trust the playbook
sections; treat this Tier mapping as a one-shot reference for items the
prior brief enumerated.

## Recalibration of "75% shipped"

The audit confirmed 5 items DONE or OBSOLETE that the prior brief did not
fully account for:

| Item | State | Evidence |
|---|---|---|
| EOD flow recap | DONE | commits f74da86, 2c36b15. Live in browser. |
| Morning brief `**` markdown asterisks | DONE | 476deb5. |
| Flag grader Tier 2 silent-exit kill | DONE w/ regression (fixed) | c951c59 + tonight's revert. 1407 grades produced. |
| Tape-reader continuity + truncation | OBSOLETE | Already shipped pre-session. priorRows wired at line 511; max_tokens=600. |
| Scorer context wiring | OBSOLETE | Already shipped Apr 24 (migration 20260424000038). Stacking + regime cols populated, boost/penalty math live. |

Remaining work is materially smaller than the prior brief implied. The cut
below reflects the reduced scope.

## The cut adopted

### Tonight (~30 min) — DONE
- ✅ Fix flag-grader regression (writeSpecialistMemorySafe → ct_specialist_memory).
  Warden flipped from fail → pass at 2026-05-02 00:14:21 UTC. See Tenet 13
  section below.
- ✅ Create `docs/decisions/` + this canonical entry.

### Saturday (~3 hr focused build, rest soak)
- LB1 audit — read-only. The current `usePreflightChecks.ts` runs 9 checks
  (crons, cron_failures_6h, morning_brief, uw_usage, heartbeat, biases,
  weekend_news, config, kill_switch). **No `book` check exists in current
  code** — prior "do not remove the book check" instruction is moot.
  Read-only scope: identify which 3 are red right now, report findings,
  await per-check decisions from James. No mutations during audit.
- Run the C1 prompt-diff query on `ct_claude_decisions.context_snapshot`
  for `[YOUR LAST READS ON <TICKER>]` substring. Identify the
  `decision_type` filter that specialists actually emit. Report.
- Write `docs/DOMAIN_GLOSSARY.md` — doc-only, no preamble wire.
- Soak the flag-grader cron. ~3500 active backlog drains naturally on the
  `*/30` cadence.

### Sunday
- Phase A on #9 (detector lifecycle) — write the report scoping what
  Phase B automation would actually require.
- Phase A on #10 (per-detector docs) — list `ct_detectors` rows, identify
  each detector's source file, scope what each doc page would contain.
- **No Phase B builds this weekend.**

### Monday-Tuesday (out of weekend scope)
- EOD per-specialist daily grade narrative — now unblocked by the grader
  fix. ~3-4 hr build.
- #9 (detector lifecycle) Phase B with continuing care into Wed if needed.

### Explicitly deferred per C1 measurement window discipline
The Specialist Recall C1 hit-rate experiment runs through 2026-05-15. Any
structural change to the prompt context specialists see during that window
confounds the measurement. Items deferred:
- Specialist prompt rewrite (balanced framing + bias audit)
- Captain framing into runtime preamble
- Any structural change to the `specialist_recall` organ
- DOMAIN_GLOSSARY → preamble wire (the doc itself is fine)

The discipline applies to >1 item — the recall property is the load-bearing
experiment for the next two weeks; protect its falsifiability.

### Explicitly NOT this weekend (separate reasons)
- FlowPulse Phase 2 sparkline UI — UI polish, not weekend-critical
- OvernightPositioning layout redesign — same
- Half-day close `temporalContext.ts` — deadline 2026-07-03; next weekend
- MFE re-calibration after scorer wiring — UW-budget-sensitive

## Tenet 13 moment — the Warden caught a build-layer regression

**Tenet 13: "Hallucination is inevitable; structural prevention is the
answer."** Restated for build-layer regressions: "Architectural drift is
inevitable; structural prevention is the answer."

### What happened

During Saturday early-AM session, ct-flag-grader was being repaired for an
unrelated silent-exit class kill (commit c951c59). The function as-written
called `writeSpecialistMemorySafe()` on every graded specialist flag,
inserting into `ct_specialist_memory`.

That table is **dead-by-design in the v2 architecture**. The Specialist
Recall organ sources from `ct_specialist_reads` + `ct_flag_grades`, NOT
from `ct_specialist_memory`. The dead writer path was left in the function
from v1 (~2-3 weeks earlier).

When the grader was deployed and ran (1300+ flags drained), it inserted
~11 rows into `ct_specialist_memory`. The deploying engineer (Claude) did
not catch this — the v1→v2 transition was invisible at the diff level.

### What caught it

**The Warden.** The invariant `specialist_memory_table_dead` exists
specifically to flag if anyone reactivates the dead writer path. It fired
at 23:30 UTC, consecutive_count=2.

The Warden was added 2026-05-01 night for exactly this kind of "silent
wrongness" class — a counter that froze, a row count that flatlined, a
view returning the wrong column, a writer reactivated against an
architectural decision documented elsewhere but not in the function itself.

### Why this is the canonical example

Three classes of failure the Warden catches:

1. **Operational** — pipeline broken, data missing, cron stale.
2. **Build-layer architectural drift** — code path violates a documented
   architectural decision the function itself doesn't reference. **This
   is the new class today's regression demonstrates.** No exception, no
   visible error, no test that would have caught it. Just a
   warden-invariant query that knew what was supposed to be true.
3. **Subtle hallucination class re-emergence** — see synthesis-layer
   ticker coherence validator for the Claude-side analog.

The Warden is the answer to: "How does the system protect itself from a
future engineer (human or AI) who's working on the function and doesn't
know about a decision made elsewhere?" The answer is: the decision is
encoded as a SELECT-only invariant query. The next time it gets violated,
Slack fires.

### The fix
- Removed `writeSpecialistMemorySafe()` from `ct-flag-grader/index.ts`
  entirely (Tenet: delete dead code, no `// removed` comments).
- Deleted the 11 rows inserted since 22:00 UTC.
- Manually fired ct-system-warden to re-evaluate; flipped to pass at
  00:14:21 UTC.
- Added a comment at the call site explaining WHY the writer was removed
  + naming the invariant. Future engineers reading the function see the
  decision in-line.

### Repeatable pattern for next time
- When fixing a dead-code-adjacent function, audit the call sites for
  references to dead-by-design tables before deploying.
- If the Warden has an invariant naming a table dead, treat that as
  authoritative. The invariant is the "in-codebase pointer to the
  architectural decision."
- Time-budget the fix: caught and reverted within ~45 min from regression
  → green. The Warden's value is proportional to fix latency. Faster
  catch = lower blast radius.

### Brief audit-first discipline
Per the same audit-first principle applied to briefs: this regression
illustrates that briefs themselves should be audited before building. The
prior brief did not flag the v1 writer-path liability — it was caught by
the audit only because the Warden was already armed. **The brief's audit
budget should include a grep for "dead path" / "dead writer" /
"deprecated" before building functions in the same area.**

## Saturday morning audit results (2026-05-02 ~00:30 UTC)

### LB1 — preflight 9-check audit (read-only) → 6 green / 1 yellow / 2 red

The "5 green / 2 yellow / 3 red" snapshot in the playbook (line 197) was
from 2026-04-30, before the `book` check was removed. Current state:

| Check | Status | Diagnosis |
|---|---|---|
| crons | green | 120 ct-* crons, 0 broken/stale (false-reds in audit parser were weekly schedules; real hook returns green) |
| cron_failures_6h | green | 0 unresolved |
| morning_brief | **🔴 RED → fixed (commit b5f4c05)** | Was querying `ct_reports.report_type='morning_brief'` — wrong table. Co-Trader morning brief writes to `ct_daily_briefs`. Re-pointed query. |
| uw_usage | **🔴 RED → fixed (commit b5f4c05)** | Threshold `>50%` ignored time-of-week, fired red every weekend on routine Friday-end usage. Gated on `dangerWindow = weekday && (preBell || marketActive)`. |
| heartbeat | green | last beat 1h17m ago (off-hours threshold 18h) |
| biases | 🟡 yellow | 7 active (target 2-6). 3 James-side trader biases (Apr 18 batch, 2nd-person voice) + 4 Claude-side specialist biases (Apr 19 batch, 1st-person voice). All have `last_triggered_at = NULL`. **Pending James per-bias decision.** |
| weekend_news | green | 30 rows since Fri 22:00 UTC |
| config | green | 199 ct_config rows, 0 numeric bound violations |
| kill_switch | green | disarmed, last update Apr 18 |

Both reds were stale-assumption bugs in the check itself, not in
underlying systems. Underlying systems (today's morning brief, today's
UW usage) were healthy. **Class lesson:** when a preflight check goes
red, audit the check's query logic first — the underlying signal often
fired correctly elsewhere.

### C1 prompt-diff substring query — structural verification gap

The query as designed (substring match on `ct_claude_decisions.context_snapshot`
for `[YOUR LAST READS ON <TICKER>]`) **structurally cannot return hits**.

`recordDecision` writes metadata only (`events_considered`,
`brain_organs_invoked`, `temporal_validator_warnings`, etc.) — NOT the
rendered prompt body. The rendered prompt is constructed in
`specialistRunner.ts` and passed to Claude, but never persisted. So the
substring isn't there to find.

**Indirect verification was adequate for C1:** 52 `helper_name='specialist_recall'`
fires post 13:00 UTC across all 10 specialists with `error=null`,
distributed in proportion to events_considered (TSLA/SPY/IWM/QQQ each 7
fires; MSFT 2). Combined with code review (organ output → concat into
prompt at line 1132 of specialistRunner) = the recall block IS reaching
the prompt.

**Mon backlog item — sampled prompt-debug logging path.** Future
structural changes (Captain framing → preamble wire, analogs rendering,
eventual DOMAIN_GLOSSARY → preamble wire) need runtime-falsifiable
verification, not just trust-the-code. Design a minimal "sample the
rendered prompt for the next N specialist fires into a debug column"
mechanism. Don't build it now — capture the gap. Estimated scope: ~1-2
hr Mon (one new column on ct_claude_decisions, opt-in flag in
recordDecision call sites, retention cap).

### Tenet 13 language expansion (deferred)

Should the warden's purpose statement in CLAUDE.md / SYSTEM_INDEX.md be
expanded to explicitly enumerate the three classes of failure it
catches (operational / build-layer architectural drift / Claude
hallucination re-emergence)? Current language is "silent wrongness"
which covers all three semantically but doesn't separate them. The
build-layer drift class was implicit until tonight. Consider for next
docs pass.

## Open questions for next session

- Per-check decisions on the LB1 fixes — landed; Mon morning's preflight
  re-test will confirm dangerWindow path triggers correctly.
- Per-bias decisions on the 7 active biases — keep all / retire stale /
  merge cohorts? `last_triggered_at` NULL across all suggests no
  consumer is reading them (or readers don't update the field).
- Mon backlog: prompt-debug logging path scope.
- #9 / #10 Phase A reports land later tonight (per James's pull-forward).

## References
- `docs/LINKJAC_COTRADER_PLAYBOOK.md` — current operational scoreboard
- `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_pickup_2026_05_01_session_watch.md` — pickup state, including ct_specialist_memory deprecation
- `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_flag_grader_silent_exit_kill_2026_05_01.md` — the 4 root causes that motivated the grader fix
- Commit c951c59 — grader silent-exit fix (introduced regression)
- Commit (forthcoming) — grader writer-path revert + this decisions doc
