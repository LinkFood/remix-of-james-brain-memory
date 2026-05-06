# Methodology patterns — Co-Trader

Index of methodology errors and audit lessons that have bitten this project. Append entries here when an audit conclusion turned out to be wrong because of *how* the audit was conducted, not because of bad data. Sub-sections by pattern; each instance dated and linked to source decisions/runbooks.

---

## audit-frame-mismatch — "this surface is broken" was actually "this join is missing"

When an audit produces a conclusion of the form *"system X is broken / under-graded / missing data,"* verify against ALL related upstream tables BEFORE accepting the conclusion. Auditing surface-level signals (a materialized view's row count, a UI page's chip number, a slice cell's settled_n) only tells you what made it through to that surface — it does NOT tell you whether the data exists upstream and was simply never joined or never queried.

**Why this matters:** the audit conclusion drives what gets built next. If the conclusion is "X is broken, build a fix for X," but the actual problem is "X is fine, the surface just didn't include it," the build is wasted effort *and* the real issue (the join gap) stays invisible.

### Instance — 2026-05-02 forensic post-op corpus thinness

**The audit conclusion (Phase 4 of forensic corpus build):** "98.3% of flags are ungraded — slice cells stay tiny — grader doesn't cover detector-fired flags. Track 1 priority: extend grader coverage."

**The actual fact (discovered during Track 1 Phase A archeology):** `ct_flag_grades` already had **1,407 graded rows** at the time of the original audit, including coverage of all sources (specialist + signature + detector_alarm + james_star). The grader had been writing them for weeks via `ct-flag-grader` (cron `*/30 13-20 * * 1-5`). The forensic corpus MV simply never joined to that table. It joined only to `ct_specialist_grade_axes` (90 rows, specialist-only).

**Conclusion that should have come out of the original audit:** "The MV is missing a join. Add LEFT JOIN ct_flag_grades and the corpus thinness self-resolves." That fix took 3 hours instead of 1-3 days.

**Sub-pattern — surface-vs-substrate confusion.** The audit looked at the surface (`ct_flag_analysis_corpus.blended_verdict IS NULL`) and concluded the substrate (the grader) was broken. The substrate was fine; the *projection* of the substrate into the surface was incomplete. Always check: when an audit says "X is missing," ask "missing from where?" — if the answer is "missing from this view / this UI / this slice," the next question is "is it missing from the source-of-truth tables too?"

**Class diagnostic question for future audits:** *"If the data exists somewhere in the database, would my current audit query find it?"* If the answer is "only if it's in the view I'm looking at" — your audit has a coverage gap. Run a parallel `count(*) from <upstream_table>` before concluding the system is broken.

**Linked artifacts:**
- Phase 4 audit conclusion: `docs/calibration/2026-05-02-corpus-baseline-and-first-slices.md` ("Bottleneck: grader only covers source='specialist'; 5,165 detector-fired flags ungraded.")
- Phase A archeology: `docs/decisions/2026-05-02-grader-coverage-extension-paths.md` ("Killer find — ct_flag_grades has 1,407 rows.")
- Path B execution: `supabase/migrations/20260502070000_corpus_unified_verdict.sql`
- Resolution: settled corpus rows 68 → 1,322 in 3 hours. 1 of 7 prior captured patterns survived; 6 were small-sample artifacts; 4 new robust patterns surfaced (puts -21pp on n=431 etc.).

---

## ET-vs-UTC-bucketing — caller-cadence vs budget-vs-cap mixed silently

See `docs/LINKJAC_COTRADER_PLAYBOOK.md` LB8 closure (2026-05-02) and `feedback_utc_vs_et_caller_cadence` memory entry. Convention: caller-cadence questions group by UTC clock-day; budget-vs-cap by ET session_date; never silently mix.

This sits here as a sibling pattern — both errors share the "auditor framed the question against a metric whose underlying bucketing wasn't what they assumed it was."

### Instance — 2026-05-02 LB8 16.3% claim refuted

`ct_uw_usage.session_date` is ET-bucketed. Caller-cadence audits naive-grouping on it misattribute UTC↔ET boundary spillover. `ct-historical-quote-backfill` was tagged "16.3% mid-week share" via that bucketing; under correct UTC-clock-day grouping the number was **0% mid-week, 4.31% Friday-share, 100% UTC↔ET spillover**.

Same class of error: a metric returned a number; the auditor read the number; the number was technically correct under the metric's actual bucketing but wrong for the question being asked.

---

## brief-author-premise-error — the brief specifies a fix that empirically doesn't address the cause

When a brief proposes a specific solution shape ("parallelize," "add a cache," "add a column"), the brief's author has implicitly performed a mental audit: they think they know the cause, and they've written the fix that addresses that supposed cause. **Phase A's job includes verifying the brief's premise, not just executing toward the brief's specified Phase B.** If Phase A surfaces that the brief's diagnosis was wrong, the right move is to reframe Phase B around the actual cause — even if that means shipping something the brief never mentioned.

**Why this matters:** the brief author is reasoning under uncertainty. When the audit produces empirical evidence that contradicts the brief's premise, executing the brief verbatim ships a non-fix while the real bottleneck stays open.

**Diagnostic question to ask in every Phase A:** *"Does my measurement support the brief's implicit causal model? Or am I about to build a fix for the wrong cause?"*

### Instance — 2026-05-05 MCP v1.1 brief proposed parallelization; the cause was a legacy serial block

**The brief premise:** "Parallelize organ fetches via Promise.all so wall-clock latency tracks the slowest single organ rather than the sum of all 11." Implicit causal model: organs run serially today and parallelization will sum→max-out the latency.

**Phase A measurement (per `docs/audit/2026-05-05-cotrader-mcp-v1-1-phase-a.md`):**
- single-organ call: 11.5–14s wall-clock
- all-11-organs call: 11.8–12.6s wall-clock
- delta between "one organ" and "all eleven": ~zero
- inner organ work via Promise.all: ~500ms aggregate (already parallel)

The empirical signature said: *fixed-cost prefix swamping variable-cost suffix.* The actual cause was the LEGACY flat-fields block at `claudeReadSurface.ts:835-1907` running ~50 sequential `await supabase.from(...)` queries unconditionally before the parallel organ work, regardless of `audience` / `tickerFocus` / `organs` whitelist.

**Conclusion that should have come out of the brief:** Phase B's primary lever is `BrainOpts.skipLegacyFlatFields = true` for MCP calls, NOT parallelization. Parallelization would have shipped a non-fix.

**What Phase A did right:** ran a per-organ timing harness instead of trusting the brief's diagnosis. The harness numbers immediately surfaced "single ≈ all" → fixed-cost prefix → not an organ-fan-out problem.

**Class diagnostic question for future audits:** *"Did I measure the thing the brief assumes is broken, or did I plan to fix it without confirming the cause?"* If you're about to write Phase B without an empirical measurement validating the brief's causal model, slow down.

**Linked artifacts:**
- Phase A audit: `docs/audit/2026-05-05-cotrader-mcp-v1-1-phase-a.md` (per-organ timing harness output, fixed-cost-prefix diagnosis, locked target 3000ms p95)
- Reframed Phase B build: this PR
- Sibling instance — `feedback_local_mcp_vs_in_region_latency_gap.md` correctly identified network RTT as a major contributor; Phase A here added the second component (legacy block)

---

## tooling-classifier-false-positive — a class-kill CI script misframes valid code as broken

A class-kill tool (CI grep, linter, schema-drift detector) classifies code into "OK" and "broken" by some discriminator. When the discriminator is over-broad — matches valid patterns the tool didn't anticipate — the tool produces false-positive "broken" labels. The naive response is to allowlist the false positives or "fix" the valid code. The right response is to **refine the discriminator** so the tool stops mis-classifying.

**Sibling but distinct from `brief-author-premise-error`:** that pattern is about a brief proposing the wrong fix. This pattern is about a tool flagging valid code as broken. Both are caught by audit-first ("verify the brief / verify the flag before acting"), but the class-kill is different — refine the discriminator instead of redesign the work.

**Diagnostic question:** *"When my classifier flags X as broken, is X actually broken — or did the classifier match a valid pattern it didn't anticipate?"*

### Instance — 2026-05-05 dumps "orphan table" CI grep false positive

**The flag (B4 CI grep, born from the distill-principles audit):** `scripts/check_supabase_table_refs.sh` greps every `.from('<TABLE>')` reference in `supabase/functions/`, cross-checks against the live PostgREST schema, fails the build on orphans. First run flagged `dumps` and `messages` as orphans — both allowlisted with rationale comments pending separate diagnose-then-fix audits.

**Phase A diagnosis on `dumps`:** all 3 references in `supabase/functions/` are `supabase.storage.from('dumps')` — calls against a Supabase **Storage bucket**, not a Postgres table. Bucket created 2026-01-23 via migrations `20260123031958` / `044532` / `051355`, serving uploads/signed-URLs/classify-content vision/delete-all-user-data deletion continuously since. **Zero silent failures.**

**The classifier's failure mode:** the regex `\.from\(['"][a-zA-Z_][a-zA-Z0-9_]*['"]\)` matches `.from('dumps')` regardless of what's chained before. The Supabase JS SDK exposes `.from()` on TWO different clients — the Postgres client (`supabase.from('table')`) and the Storage client (`supabase.storage.from('bucket')`). Same method name, completely different namespaces. The regex couldn't tell them apart.

**Class kill:** added `scripts/_extract_table_refs.awk` that tracks the previous line per-file. Skips the current `.from(...)` if either the same line contains `.storage.from` OR the previous line ends with `.storage` (the multi-line chained-call pattern that all 3 dumps references used). Allowlist trimmed from 2 entries to 1 (`messages` retained, since its references are NOT `.storage.from(...)` — different shape, different pending audit).

**Bonus payoff:** discriminator tightening is permanent — any future `.storage.from(<bucket>)` is correctly ignored without operator action. Allowlist stays small and focused on real false-positives (e.g., RLS-filtered tables) instead of accumulating discriminator-weakness exemptions.

**What audit-first prevented:** the naive "fix" path was either (a) leave `dumps` perma-allowlisted forever, or (b) delete the `from('dumps')` lines as dead code. Both would have either accumulated allowlist debt OR broken working storage operations. Phase A's diagnose-first surfaced the actual cause (Storage vs Postgres ambiguity) before any fix was attempted.

**Linked artifacts:**
- Phase A audit: `docs/audit/2026-05-05-dumps-orphan-phase-a.md`
- Phase B fix: this PR (`scripts/_extract_table_refs.awk` + `scripts/check_supabase_table_refs.sh` regex tightening + allowlist trim)
- Sibling pattern: `brief-author-premise-error` (above) — same audit-first discipline, different shape

**Class diagnostic question for future audits:** *"My CI / linter / schema check is flagging X as broken. Before I fix X or allowlist it, can I tighten the classifier so X stops being flagged at all?"* If yes — that's the structural fix; the allowlist becomes a small list of genuine special cases instead of a graveyard of classifier-weakness exemptions.

---

## How to add an entry

When a methodology error bites:

1. Identify whether it's an instance of an existing sub-section above. If so, add under that heading with a dated **Instance** subsection.
2. If it's a new class, add a new top-level `## name — short description` heading and write up the pattern, then add the instance.
3. Always link source artifacts (memos / decisions / migrations) so the reasoning chain stays traceable.
4. End each instance with the **diagnostic question** future-you should have asked earlier — that's the actionable lesson.
