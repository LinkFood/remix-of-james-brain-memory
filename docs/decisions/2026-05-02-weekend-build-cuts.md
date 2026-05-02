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

## P0 #2 — REMOVED from punch list (2026-05-02 dedicated push)

**Item:** "Per-option-symbol track dedup (print-grader). Diagnostic ran
previously; gap confirmed. Ship the fix."

**Status: REMOVED. No current gap visible.**

**Evidence:** Audited 3,000 of 3,465 WORKING tracks (87% of population)
on 2026-05-02 ~01:30 UTC. Zero duplicate `option_symbol` values across
the sample. The `ct_contract_tracks_option_symbol_working_uniq` partial
UNIQUE INDEX (shipped 2026-04-28, memory `project_co_trader_per_symbol_dedup_2026_04_28.md`)
is enforced and holding.

**Most likely explanation:** The Apr 28 UNIQUE index closed the dedup
gap. The punch-list item was authored before that fix landed (or
contemporaneously) and was never updated to reflect "shipped."

**Don't ship a fix for a non-problem.** Re-add to the punch list if a
future audit surfaces actual duplicates. Tonight's discipline:
class-kill check first, ship only if a problem exists.

**Adjacent observation worth flagging:** REALIZED + EXPIRED status row
counts are zero. Every track is WORKING. Either the track-state
machine doesn't transition tracks out of WORKING (separate bug), or
the design is intentionally WORKING-only. Worth a separate audit but
out of scope for tonight.

## Auxiliary findings → next session

### ~~TOP P0 NEXT SESSION: track-state machine doesn't transition~~ — **RETRACTED 2026-05-02**

**This was a self-inflicted methodology error. NO BUG EXISTS.**

The original "3,465 WORKING / 0 REALIZED / 0 EXPIRED" finding came
from filtering on enum values that don't exist for `ct_contract_tracks`.
Print-grader uses `REALIZED`/`EXPIRED` for `ct_print_tracks`, but
**contract-tracks uses a different enum entirely**:
`WORKING / WIN / LOSS / EXPIRED_WIN / EXPIRED_LOSS / EXPIRED_FLAT / STALE`.

Re-queried with correct enum values (Track A audit, ~02:30 UTC):

| Status | Count |
|---|---|
| WORKING | 3,465 |
| WIN | 350 |
| LOSS | 534 |
| EXPIRED_WIN | 739 |
| EXPIRED_LOSS | 1,221 |
| EXPIRED_FLAT | 2,039 |
| STALE | 443 |
| **Total** | **8,791** |

**5,326 of 8,791 tracks (61%) are in terminal/post-WORKING states.**
The state machine transitions normally via `ct-contract-poller`
(line 282-328: terminal-status logic for EXPIRED_* + WIN/LOSS flips).

**Implications for P0 #1 Option D shipped earlier tonight:**
The peak_contract_pct distribution caveat I added was unfounded.
Peak% IS reflective of actual contract performance — tracks get
terminated, terminal states are reached. The Option D decision to
use strict-win-rate as anchor was still correct (binary label is
the cleanest metric), but the framing "peak distribution is
poisoned" was wrong. **The P0 #1 ship stands as-is — only the
auxiliary caveat was wrong, not the calibration.**

### Audit-first applies to MY OWN claims too

Same class lesson, scaled up: when I assert a structural finding
(here: "state machine doesn't transition"), the audit-first
discipline says VERIFY before elevating to "TOP P0 next session."
I confidently filed a non-existent bug into the planning queue
based on a 30-second wrong-enum query. Track A's Phase A audit
caught the error within 5 minutes of actually reading the code.

**Future-Claude rule:** before claiming a bug at the architectural
level (state machine broken / writer path missing / class violation),
read the relevant source file's enum/type declarations FIRST. Don't
trust intuition built from filter-counts on unverified enums.

### Audit-first caught a wrong fix — class lesson

Original P0 #1 framing was "DTE-bucketed underlying-axis (specialist)
target_threshold_pct." Phase B investigation (forced by audit-first
discipline) revealed three false premises:

1. **Underlying-axis corpus too thin** — 12 grades total, calibration
   impossible. The "DTE buckets" change would have applied to <1% of
   grades.
2. **Wrong axis** — 99% of corpus is contract-axis (signature_alarm +
   detector_alarm). Underlying-axis was the wrong target.
3. **C1 contamination risk** — original framing would have changed
   specialist grading during the active C1 hit-rate measurement
   window. Redirecting to contract-axis kept underlying-axis untouched
   and zeroed the contamination.

Without the audit, the wrong fix would have shipped on a wrong premise
— affecting 1% of grades while polluting the recall property's
falsifiability.

**The captain decision (Option D)** redirected the work to contract-axis
DTE bucketing using strict-win-rate as anchor (since peak_contract_pct
distribution is suspect — see track-state-machine bug above). Phase D
verify confirmed 88 of 1394 grades (6.3%) shift under new thresholds
— sane shifts, no catastrophic flips. Strict win-rate flattens from
12.9-29.3% spread to 27.7-33.8% across all 5 DTE buckets.

Class lesson: **audit-first applies to brief-level too.** When data
shape contradicts the brief's premise, surface it BEFORE writing code,
not after. The brief itself is a hypothesis to be tested.

## Pending — Q4 bias inventory (7 active rows)

Full row contents persisted here so they survive session boundaries.
Schema correction from earlier (no `last_triggered_at` column exists
on `ct_biases`; the meaningful time field is `last_confirmed`). Per-bias
decisions awaited from James.

- **Bias 1** (`78ad909c-67b2-4499-8ebc-4fc2b296c622`) — *"I overweight
  single-moment convergence signals in flow oscillation regimes"* —
  voice: Claude (1st-person); severity: 5; instruments: SPY/QQQ/IWM;
  observed_count: 3; first_seen: 2026-04-19T22:00; **last_confirmed:
  2026-04-24T18:30 (RE-CONFIRMED 5d after first_seen)**; superseded_by:
  null. Evidence: "8 of 10 high-conviction alerts (conviction 4-5) were
  triggered by mechanical convergence rules during flow oscillation
  periods, all invalidated within 2-8min. See regrades fb16b4c9,
  6300cc91, eb318d23."

- **Bias 2** (`0f294004-a616-43d8-a15e-8d0807618936`) — *"Averages
  down losers"* — voice: James (2nd-person trader bias); severity: 5;
  instruments: null; observed_count: 9; first_seen: 2026-04-18T14:51;
  **last_confirmed: 2026-04-18T14:51 (= first_seen, never re-confirmed)**;
  superseded_by: null. Evidence: "When the first entry is graded wrong,
  follow-on size tends to increase on the same direction 58% of the
  time. Scaling into a losing thesis instead of cutting and re-evaluating."

- **Bias 3** (`89986224-75cb-486f-a548-5a31857c53ae`) — *"I assign
  maximum conviction to bullish setups while underweighting oscillation
  risk"* — voice: Claude (1st-person); severity: 4; instruments:
  SPY/QQQ/IWM; observed_count: 1; first_seen: 2026-04-19T22:00;
  **last_confirmed: 2026-04-19T22:00 (= first_seen, never re-confirmed)**;
  superseded_by: null. Evidence: "Multiple conviction 5 bullish alerts
  (fb16b4c9, 6300cc91, eb318d23) during established flow oscillation
  pattern. Prior bias noted 72% long skew, but real issue is conviction
  level - I give conviction…"

- **Bias 4** (`3bbf4fef-6c82-4d65-b6c5-e29118e8e7df`) — *"Over-trades
  on Fed days"* — voice: James (2nd-person trader bias); severity: 4;
  instruments: SPY/QQQ; observed_count: 6; first_seen: 2026-04-18T14:51;
  **last_confirmed: 2026-04-18T14:51 (= first_seen, never re-confirmed)**;
  superseded_by: null. Evidence: "Fed-decision sessions show 3x normal
  alert volume with post-decision calibration_delta averaging -24pp. Too
  many calls during macro windows where dispersion is mechanical, not
  informative."

- **Bias 5** (`dff5c9b0-af84-460a-bc9e-fde933670327`) — *"I treat delta
  flow reversals as regime shifts when they're retail whipsaw"* — voice:
  Claude (1st-person); severity: 4; instruments: SPY/QQQ; observed_count:
  4; first_seen: 2026-04-19T22:00; **last_confirmed: 2026-04-24T14:00
  (RE-CONFIRMED 5d after first_seen)**; superseded_by: null. Evidence:
  "Flow oscillation dominated entire session (10+ directional alerts
  in 70min, 9 invalidated) yet I repeatedly called single delta flow
  ticks 'regime reversals' or 'sustained positioning.'"

- **Bias 6** (`6590174b-d310-49ce-8801-7835a961d390`) — *"Overweights
  put flow in low-VIX tape"* — voice: James (2nd-person trader bias);
  severity: 3; instruments: SPY; observed_count: 8; first_seen:
  2026-04-18T14:51; **last_confirmed: 2026-04-18T14:51 (= first_seen,
  never re-confirmed)**; superseded_by: null. Evidence: "When VIX < 14,
  large put prints are read as bearish signal 81% of the time despite
  realized delta staying positive. Put flow in suppressed-vol regimes
  is usually hedging, not directional."

- **Bias 7** (`cf61296f-6627-4a70-abf3-93725e509a3d`) — *"I underweight
  0DTE expiry pin gravity vs flow signals"* — voice: Claude
  (1st-person); severity: 3; instruments: SPY/QQQ; observed_count: 2;
  first_seen: 2026-04-19T22:00; **last_confirmed: 2026-04-21T14:30
  (RE-CONFIRMED 2d after first_seen)**; superseded_by: null. Evidence:
  "Multiple alerts assigned conviction 3-5 to directional flow within
  1h of 0DTE expiry when max-pain pin gravity (SPY 696, QQQ 631) was
  the dominant structural force. Market pinned exactly as predicted…"

**Cohort split:** 3 of 7 are Claude/specialist-side (1st-person, Apr 19
batch — biases 1, 3, 5, 7) and 4 of 7 are James-side trader biases
(2nd-person, Apr 18 batch — biases 2, 4, 6 — plus the 4th in cohort 1
total mixing 7 → wait, count: 1/3/5/7 = 4 Claude-side, 2/4/6 = 3
James-side. Re-state: 4 Claude-side (Apr 19) + 3 James-side (Apr 18)).
**3 of 7 re-confirmed within 11 days** (1, 5, 7 — all Claude-side).
**4 of 7 never re-confirmed** since creation (2, 3, 4, 6).

**Decisions awaited:** keep all / retire stale / merge cohorts? Whether
the regrade pipeline that confirms Claude-side biases also covers
James-side biases (the absence of re-confirmation on James-side may
reflect "no consumer re-confirms them" rather than "they've stopped
applying").

## Pending — P2 #10 gap-shape candidates

Counts last 7d: 1,151 alarms in `ct_signature_alarm_log` vs 1,399
flags with `source='signature_alarm'`. Net diff: +248 flags above
alarm count. James to disambiguate which shape is real.

The three possible gap shapes:

- **Shape A — 1 alarm → many flags** (alarm fired, multiple flags written
  from it). Diagnostic clue: count of flags per `alert_id` in
  `source_flow_ids`. If most alerts are referenced by ≥2 flags, this
  is the shape. Fix: dedupe at flag-write site or document as intended
  multi-flag-per-alarm.

- **Shape B — N alarms missing flag-write** (alarm logged but flag never
  created). Diagnostic clue: `alert_id` rows in `ct_signature_alarm_log`
  with no corresponding row in `ct_flags.source_flow_ids`. If
  significant, points to a write-path bug in `ct-signature-watcher`
  where the alarm-log INSERT succeeds but the flag-write fails or is
  skipped. Fix: investigate the alarm → flag transition; likely a
  conditional that filters some alarms out of flag creation.

- **Shape C — Flags written by non-alarm path that share
  `source='signature_alarm'`** (different writer also tagging signature_alarm).
  Diagnostic clue: search for INSERT statements into `ct_flags` that
  hardcode `source: 'signature_alarm'` outside of `ct-signature-watcher`.
  If found, multiple writers contributing to the same source label
  inflates the flag count without alarm-log entries. Fix: either route
  all writers through alarm-log first, or distinguish the source labels.

**Diagnostic the next session can run** (PostgREST array literal
syntax for source_flow_ids array — earlier curl attempt failed array
literal parsing; correct form may need `cs={uuid}` with explicit braces):

```
SELECT
  COUNT(*) FILTER (WHERE source_flow_ids @> ARRAY[al.alert_id]) AS flags_with_alarm,
  COUNT(*) FILTER (WHERE source_flow_ids IS NULL OR NOT (source_flow_ids @> ARRAY[al.alert_id])) AS flags_without_alarm
FROM ct_signature_alarm_log al
LEFT JOIN ct_flags f ON f.source_flow_ids @> ARRAY[al.alert_id]::uuid[]
WHERE al.fired_at >= '2026-04-25'
  AND f.created_at >= '2026-04-25';
```

(SQL above is sketch — actual query needs validation against the
actual array element type. `ct_flags.source_flow_ids` may be `uuid[]`
or `text[]` — check schema before running.)

**Skip-the-investigation option:** if the gap is non-load-bearing
(both numbers are healthy fire rates), James can mark P2 #10 stale
and remove from the punch list rather than disambiguate.

## References
- `docs/LINKJAC_COTRADER_PLAYBOOK.md` — current operational scoreboard
- `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_pickup_2026_05_01_session_watch.md` — pickup state, including ct_specialist_memory deprecation
- `~/.claude/projects/-Users-jameschellis/memory/project_co_trader_flag_grader_silent_exit_kill_2026_05_01.md` — the 4 root causes that motivated the grader fix
- Commit c951c59 — grader silent-exit fix (introduced regression)
- Commit (forthcoming) — grader writer-path revert + this decisions doc
