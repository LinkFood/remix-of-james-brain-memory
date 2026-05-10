# ATLAS_OF_BUILD.md — schema and protocol

## Purpose

Kill the **architecture-decision-from-stale-mental-model drift class**: captain (or any authoring surface) makes consolidation / scope / retire decisions from a partial enumeration of system shape. Empirical motivation 2026-05-09 evening: scope doc `cowork-cotrader/scope/2026-05-09-page-consolidation-paths.md` enumerated 3 tape-class surfaces (`/tape`, `/tape-v2`, `/alpha`); atlas Phase A surfaced 5 (also `/butterflies`, `/tape-reader`). Same class as the per-PR drift `STATE_OF_BUILD.md` kills, fired at architecture-decision layer instead of brief layer.

`ATLAS_OF_BUILD.md` is the canonical per-system orientation surface. Captain reads at session start; engine-room regenerates on-demand or after major arc closeouts.

## Composition with `STATE_OF_BUILD.md`

Two orientation surfaces compose without overlap:

| File | Layer | Answers | Refresh cadence |
|---|---|---|---|
| `STATE_OF_BUILD.md` | per-PR sync | "What's the current moving inventory of work?" | post-every-ship-batch + on-demand + Phase A audit side-effect |
| `ATLAS_OF_BUILD.md` | per-system orientation | "What's the current shape of the system?" | on-demand or after major arc closeouts |

State file = high-frequency, narrow scope (open PRs, merged-since, branches, windows, decisions, pulse). Atlas = low-frequency, broad scope (routes, organs, warden categories, substrate, debt, drill paths, slate-cleaning).

The atlas explicitly **defers** to the state file for in-flight/deferred sections. State file does not duplicate atlas content. Together they answer the two distinct orientation questions captains need.

## File location

`/Users/jameschellis/Documents/cowork-cotrader/ATLAS_OF_BUILD.md`

Cross-surface direct write (same surface as `STATE_OF_BUILD.md`). Engine-room writes; Cowork reads. No git-pull lag.

## Schema sections

1. **Routes — top-nav surfaces.** Path · component · purpose · class · status. Tape-class surfaces explicitly flagged. Orphans (no inbound nav) called out.
2. **Brain organs — synthesis layer.** Organ · purpose · UI consumers · status. Organs without UI consumers flagged.
3. **Warden invariants.** Total / passing / failing / critical / errored. Per-category breakdown. Currently failing list with severity + consecutive-fails + shape (recurring-known vs new).
4. **Substrate tables — load-bearing `ct_*`.** Grouped by arc (flow / tape / specialist / GEX-pulse-regime / synthesis-warden-config). Writers · readers · embedding gate · status. Drift findings from atlas Phase A.
5. **Recent feature clusters.** PRs grouped by arc; intactness verified.
6. **In-flight / deferred.** Cross-references `STATE_OF_BUILD.md`. Blocked-by-window items flagged with content gate.
7. **Known debt.** UX layer (page multiplication) · substrate layer (gates, half-built drills) · methodology (cascade catalog open items) · local-clone hygiene · warden anomalies.
8. **Captain-visible drill-down gaps.** Per-route drill path × status × what's broken.

Plus appended sections:

- **Slate Cleaning (Phase C).** Merge / Close / Defer / Retire / Document buckets, plus captain-decision-pending vs autonomous-merge-eligible split.
- **Phase D — composition.** Verification that atlas does not duplicate state file content; explicit cross-reference rules.

## Regen triggers

Atlas regenerates **less frequently** than state file. Triggers:

1. **On-demand** — captain explicit request, engine-room session start when atlas freshness header > 7 days.
2. **After major arc closeouts** — phase chains (e.g., 5/9 audit-driven Phase 1-5), large refactors, version bumps.
3. **Pre-architectural-decision** — before any brief that proposes consolidation, scope-pick, or retire-surface decisions, Phase A audit step 1 includes atlas regen.

**NOT cron-driven.** Same reasoning as state file: cron creates silent-failure surface. Atlas v1 is manual; writer script ships in v2 once grain stabilizes.

## Drift detection at receive-time

Same shape as state file's receive-time audit. Engine-room write-time checklist Phase A audit step 1 extends to:

- **State-asserting briefs** → check `STATE_OF_BUILD.md` (existing rule).
- **Architecture-decision briefs** (consolidation, scope-pick, retire) → check `ATLAS_OF_BUILD.md` (new rule).

If atlas freshness > 7 days OR a referenced section (routes, organs, debt) doesn't match current empirical state via spot-check, regen first.

## Failure modes

- **Section ages drift independently.** Routes change less often than warden state; debt list changes less often than feature clusters. Manual regen for v1 means each section may be stale at different rates. Captain should treat the freshness header as "everything LIKELY accurate as-of" and spot-verify if a section becomes load-bearing for a decision.
- **Cascade-catalog references rot.** Cascade numbers in Section 7 reference `docs/methodology-patterns.md`. If that file evolves (entries added, instances updated), atlas references may stale. Cross-check at regen time.
- **Manual maintenance burden.** v1 has no writer script. Risk: atlas itself drifts. Mitigation: keep cadence rare (after major arcs); cap section size to maintain regen feasibility; ship writer script in v2.

## Maintenance

- **When a new route ships:** add to Section 1 at next regen.
- **When a brain organ ships or retires:** update Section 2.
- **When the cascade catalog gains an entry that a debt section references:** update Section 7.
- **When a major feature cluster closes:** update Section 5; consider whether Slate Cleaning recommendations need update.
- **When the atlas itself drifts:** the atlas is subject to the same Phase A audit discipline as any state-asserting artifact. Engine-room regenerates pre-decision; reports drift in the regen output.

## Sibling artifacts

- `docs/governance/state-of-build-schema.md` — per-PR sync surface schema (this file's high-frequency counterpart).
- `docs/governance/engine-room-write-time-checklist.md` — Phase A audit step 1 + post-ship-batch regen disciplines.
- `docs/methodology-patterns.md` `## system-atlas-as-orientation-layer-distinct-from-per-pr-state-layer` — methodology codification.
- `docs/methodology-patterns.md` `## state-asserting-briefs-need-cross-surface-snapshot-plus-receive-time-audit` — per-PR-state drift class (parent).
- Cowork-side parity entry at `cowork-cotrader/memory/patterns.md` — drafted by engine-room, applied by Cowork-Claude.

## Why two orientation surfaces, not one

A single combined file would force tradeoffs: regen too frequently and the architectural sections churn unnecessarily; regen too infrequently and the per-PR sections go stale. Splitting by cadence isolates the failure modes. State file fails by going stale on per-PR diffs (low-cost regen kills it). Atlas fails by going stale on system-shape drift (regen at major-arc cadence is sufficient). Compounding the two = full coverage, no overlap.

## Future v2 considerations

- Writer script (`scripts/write_atlas_of_build.sh`) once schema stabilizes. Sections 1, 2, 3, 4 can be partially auto-generated (route enumeration via grep, organ list via orchestrator import, warden state via RPC, table list via migration scan). Sections 5, 6, 7, 8 + Slate Cleaning remain manual narrative.
- Cross-surface freshness check: a one-liner CI gate that flags PRs touching schema-relevant files (routes, organs, migrations) when atlas hasn't been regenerated since the prior touch.
- Diff mode: regen produces a delta against prior atlas, surfacing what changed. Captain reads the delta instead of the full atlas on subsequent regens.
