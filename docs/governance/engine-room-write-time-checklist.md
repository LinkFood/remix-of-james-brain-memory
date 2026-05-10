# Engine-Room Write-Time Enforcement Checklist

## Purpose

Prevent discipline drift at the artifact-creation layer. Run before opening any PR description, ship report, runbook, audit doc, methodology-patterns entry, or canonical memory file (pickup, MEMORY.md North Star).

## When to run

Every PR description draft. Every memory-file append. Every report-back to captain that asserts state.

## Why

Disciplines locked at the methodology layer catch drift via post-hoc audit, but don't prevent the writing of artifacts that violate them. Write-time check = prevention. Same shape as Tenet 13 (structural prevention beats validators) applied to methodology discipline itself.

**Pattern reference:** `docs/methodology-patterns.md` `## disciplines-need-write-time-enforcement-not-just-post-hoc-audit` — empirical motivation: 2026-05-09 evening sync surfaced two drifts (calendar-anchor + cross-catalog gap) that fired on artifacts written within 30 min of their respective disciplines being locked.

## The 5-check pre-paste audit

### Check 1 — State-vs-intent (cascade #37 catalog)

Does the artifact ASSERT current state, or assert design INTENT?

- **State assertions** = empirical claims that drift between mental model and reality. Examples: *"PR #N targets substrate X," "table Y has Z rows," "tool A is at version B," "the threshold is currently K," "this will require ~M LOC."*
- **Intent assertions** = design goals, scope boundaries, branch criteria. Examples: *"Goal: extend X to cover Y," "Phase A: locate current implementation," "Ship: based on Phase A findings, do [thing that closes goal]."*

If the artifact contains state assertions → either verify each via tool (read PR diff, query DB, grep) OR rephrase as intent ("ship X" not "PR #N already targets X") + Phase A discovery.

**Canonical state-verification surface:** `/Users/jameschellis/Documents/cowork-cotrader/STATE_OF_BUILD.md`. Regenerable via `scripts/write_state_of_build.sh`. If the file is older than 4 hours OR its commit SHA differs from current `origin/main`, regen first, then verify against the fresh file. See `docs/governance/state-of-build-schema.md` for the full design.

**Engine-room write surfaces this catches:** PR descriptions, ship reports, pickup files, methodology entries, runbook updates.

**Catalog reference:** `docs/methodology-patterns.md` `## brief-author-premise-error` (and the cascade #37 instance family Cowork-side at `/Users/jameschellis/Documents/cowork-cotrader/memory/discipline-brief-author-intent-over-state.md`). Sub-classes include `brief-asserts-merged-when-only-on-branch`, `brief-asserts-PR-substrate-target-incorrectly`.

### Check 2 — Calendar-anchor on forward work

Search the artifact for: `Sunday`, `Monday`, `tonight`, `tomorrow`, `this morning`, `next session`, `EOD`, `by Friday`, `weekend`.

- If found AND used as a deferral or scheduling anchor for forward work → REPHRASE as content-gate (*"when X capacity opens" / "when validation surfaces issue" / "when measurement window closes" / "when corpus reaches N rows"*).
- If found AND used as historical reference (what HAPPENED on Sunday) → fine.

**Engine-room write surfaces this catches:** runbooks, audit docs, pickup files, scope docs, ship reports.

**Catalog reference:** `docs/methodology-patterns.md` `## calendar-anchor-becomes-deferral — when discipline evolves past the framing`. Sub-class of date-gating-vs-content-gating rule.

### Check 3 — Cross-catalog parity (Cowork ↔ engine-room)

If the artifact codifies a NEW methodology pattern, discipline, or top-level cascade entry in `docs/methodology-patterns.md`:

- Does the corresponding entry need to land in Cowork-side `/Users/jameschellis/Documents/cowork-cotrader/memory/patterns.md` AND/OR engine-room `docs/methodology-patterns.md`?
- **Engine-room execution path:** draft the parallel Cowork-side entry as paste-ready text in the PR description so captain can paste to Cowork's `memory/patterns.md`. Cowork-side files are not in the engine-room repo, so this is the bridge mechanism.
- If a cascade catalog instance is being assigned a number, verify numbering is consistent across both catalogs (Cowork-side instance #N may differ from engine-room's; cross-reference by NAME, not number).

**Engine-room write surfaces this catches:** any new top-level entry in `docs/methodology-patterns.md`.

**Catalog reference:** Cowork↔engine-room cross-catalog rule (locked 2026-05-07 evening). Pattern: when crossing surfaces, briefs/entries verify TARGET surface's reality, not authoring surface's. Cross-references resolve by name in BOTH catalogs.

### Check 4 — Substrate-target verification (sub-check of Check 1)

If the artifact references the substrate target of an open PR by number, the contents of an open scope doc, or the shape of a not-yet-applied migration:

- READ the PR diff / scope doc / migration before asserting.
- If unverified, rephrase: *"PR #N reportedly targets X — Phase A verifies"* OR phrase the goal abstractly + let Phase A discover what's actually in the artifact.
- Migration timestamps: verify against `git ls-tree origin/main supabase/migrations/` immediately before staging (cascade `docs-PR-merge-doesnt-imply-migration-applied`).

**Engine-room write surfaces this catches:** PR descriptions, ship reports, pickup files, audit docs that cite open PRs or migrations.

**Catalog reference:** `docs/methodology-patterns.md` `## substrate-on-table-vs-sibling-table-discrimination` (cascade #43) + `## docs-PR-merge-doesnt-imply-migration-applied` (cascade for migration timestamps).

### Check 5 — Page-multiplication (UX-layer no-silos)

If the artifact proposes a NEW surface (page, route, dedicated dashboard):

- Does the brief explicitly answer the consolidation question? *"Does this consolidate existing surfaces, or add a new one? If new, what's the consolidation plan?"*
- If no consolidation plan → either add one OR scope harder before shipping. Surface count is a metric to watch.

**Engine-room write surfaces this catches:** scope docs proposing new routes, PR descriptions for surface PRs, audit docs flagging UX gaps.

**Catalog reference:** `docs/methodology-patterns.md` `## page-multiplication-violates-no-silos-at-UX-layer` (codified 2026-05-09 alignment PR). Tenet 24 enforced at substrate but not at UX; new surfaces = silos from captain's perspective even when backend unified.

## How to use

1. **Before opening a PR** — run all 5 checks against the PR description + diff content. Fix violations before push.
2. **Before appending to canonical docs** (`methodology-patterns.md`, runbooks, audit docs, governance docs) — run all 5 checks against the new content. Fix before commit.
3. **Before reporting back to captain** — run all 5 checks against the report. Fix before sending.
4. **Periodic self-audit** — every ~5 PRs/edits, retroactively run checks on recent output. Catches drift if it slipped past write-time.

If a check fires DURING write-time and gets fixed before the artifact lands → that's the rule working. Log nothing; the discipline did its job.

If a check fires AFTER an artifact has landed → log as a discipline fire in the appropriate catalog (`docs/methodology-patterns.md` instance entry under the relevant pattern). Then refactor the artifact.

## Phase A audit step 1 — receive-time check on state-asserting briefs

**When this fires:** any captain brief or paste-from-Cowork brief that asserts per-item state — PR open/merged/closed, decision shipped/pending, count, threshold value, table-row count, branch existence.

**The class to kill:** Cowork (or any other authoring surface) writes a paste-ready brief from a stale mental-model region. Captain pastes it. Engine-room executes the brief's Phase B against false premises. Manual audit later reconciles. Class repeats.

**Discipline:** before any Phase B execution on a state-asserting OR architecture-decision brief, run ground-truth audit as Phase A step 1, regardless of how confident the brief sounds.

**For state-asserting briefs (per-PR claims — open/merged/closed, decision pending, count, branch existence):**

1. Open `/Users/jameschellis/Documents/cowork-cotrader/STATE_OF_BUILD.md` and read the freshness header.
2. If older than 4 hours OR its `origin/main` SHA differs from current → run `scripts/write_state_of_build.sh` to regen.
3. Cross-check every state assertion in the brief against the regenerated state file.
4. If drift surfaces → report drift findings to captain BEFORE executing Phase B. Captain decides whether to proceed, re-scope, or hold.

**For architecture-decision briefs (consolidation, scope-pick, retire-surface, organ-lifecycle, table-orphan):**

1. Open `/Users/jameschellis/Documents/cowork-cotrader/ATLAS_OF_BUILD.md` and read the freshness header.
2. If older than 7 days OR a referenced section (routes / organs / debt) doesn't match current empirical state via spot-check → regen the atlas before proceeding.
3. Cross-check the brief's enumerations (e.g., "3 tape-class surfaces") against atlas Section 1 / 2 / 4. Surface drift on any enumeration the brief asserts.
4. If drift surfaces → report findings to captain BEFORE executing Phase B.

This is the second layer of cross-surface drift prevention. State file + atlas (Cowork's read surfaces) close the gap between authoring sessions; this check closes the residual gap when a brief slips through stale anyway.

**Catalog references:**
- `docs/methodology-patterns.md` `## state-asserting-briefs-need-cross-surface-snapshot-plus-receive-time-audit` — per-PR sync layer counterpart.
- `docs/methodology-patterns.md` `## system-atlas-as-orientation-layer-distinct-from-per-pr-state-layer` — per-system orientation layer counterpart.
- Sibling family: `## brief-author-premise-error`, `## disciplines-need-write-time-enforcement-not-just-post-hoc-audit`.

## Post-ship-batch — regen STATE_OF_BUILD.md

**When this fires:** after merging any cluster of PRs (a "ship batch" — typically 2+ PRs landed in proximity, or any single PR that touches user-facing state, schema, or measurement-window posture).

**Discipline:** run `scripts/write_state_of_build.sh` from the repo root before declaring the ship-batch complete. The script regenerates `/Users/jameschellis/Documents/cowork-cotrader/STATE_OF_BUILD.md` so Cowork (or any future authoring session) reads fresh state on the next brief draft.

This is the prevention-layer counterpart to the receive-time audit above. If post-ship regen fires reliably, the receive-time audit becomes the residual safety net rather than the primary catch.

**Trigger surfaces (any of these = run the regen):**

- Final PR in a multi-PR phase chain merges.
- A captain decision lands (page consolidation pick, deferred-list item closes, etc.).
- A measurement window opens or closes (D2.2, D3, future windows).
- A new in-flight branch gets pushed or an old one gets cleaned up.
- Captain explicitly asks for state-of-build report.

## Maintenance

This file evolves. When a new discipline is locked, add it as Check N. When a discipline gets retired or merged, remove or consolidate. The file is itself subject to the 5 checks — when adding a check, run the same 5 against the addition.

## Sibling artifact (Cowork-side)

Cowork-side write-time enforcement at `/Users/jameschellis/Documents/cowork-cotrader/memory/cowork-write-time-checklist.md` — same 5-check shape adapted to Cowork's brief-drafting + memory-writing surfaces. Both checklists evolve together; cross-catalog parity rule applies to the checklists themselves.

Last updated: 2026-05-09 evening — initial five checks codified after Step 5 of the systematic alignment merge sequence. Mirrors Cowork-side checklist (codified 2026-05-09 evening alongside the meta-pattern entry).
