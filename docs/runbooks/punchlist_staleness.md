# Runbook — Punchlist Staleness Audits

## The pattern lesson

> **"Items aging >3 days without explicit gating reason force a relevance audit. Most archive as superseded by intervening architectural work. The few that survive are genuinely load-bearing."**

## Why this happens

Co-Trader's architecture evolves *in structure*, not just within structure (Tenet 25). Detectors land as DB rows. Specialist prompts get rewritten. Grading axes get added. The system that exists on Friday afternoon is structurally different from the one that existed Monday morning.

Punchlist items are inherently **theory at insertion time** — "we think this fix will resolve that symptom under those assumptions." When the assumptions change because new architecture lands, the item often:

- Becomes redundant with a structural change (SUPERSEDED)
- Resolves itself because a side-effect of other work fixed it (RESOLVED)
- Stops being a coherent diagnostic because the underlying observation has moved (STALE)

This is healthy. It's the cost of evolutionary architecture (Tenets 14, 25). The risk is *not noticing* — keeping items on a list that drives decisions long after the underlying premise has shifted, then "fixing" something that's no longer broken or "fixing" the wrong thing because the diagnostic context has moved.

## When to trigger an audit

- **Items aging >3 days** on the punchlist without explicit gating reason (e.g., "blocked on UW budget" or "deferred to weekend"). 3 days is roughly the cadence at which Co-Trader ships major architectural changes.
- **Major architecture lands.** Specialist Scoreboard v2, detector lifecycle K=4, a new validator class — anything structural — should trigger a re-check of the open punchlist before the architecture is even fully bedded in.
- **Diagnostic numbers update.** If a Saturday audit produces different numbers from a Wednesday note, the related punchlist item is suspect by definition.
- **Before any "let's clear the punchlist" sprint.** Don't fix items; first audit which ones are still real.

## How to audit each item

For every open item, ask three questions in order. The first one to answer "no" determines the archive class.

### 1. Does the underlying need still exist?

If no → archive as **RESOLVED**.

Examples:
- An item about a column being null when the column has since been dropped.
- A symptom that was real on Day 1 but the side effect of unrelated work in Day 4 fixed it.
- A diagnostic count that, on re-running today, no longer reproduces.

Document: what the original need was, what made it stop being a need, link to the change that resolved it.

### 2. Does new architecture handle this need?

If yes → archive as **SUPERSEDED**.

Examples:
- A one-shot calibration replaced by a continuous lifecycle process.
- A per-instance threshold replaced by a multi-axis grading system.
- A diagnostic table replaced by a structural invariant or unique index.

Document: the original framing, the new component that handles it, what to do *if the underlying need re-surfaces* (the new component should still be the right answer; if it isn't, that's a real gap).

### 3. Is the original diagnostic still valid?

If no → archive as **STALE**.

Examples:
- A count that disagreed with a later count, in direction or magnitude.
- A "fix path" written under assumptions about which code path was at fault, where the assumption hasn't been verified and the original observation is unreproducible.
- An item where the only context is "we noticed a gap, didn't dig further" and the person who noticed it can't recall the specifics.

Document: the original framing, the conflicting evidence, what would re-trigger investigation, what archeology would be needed before any fix lands. Tag `[needs-archeology]` if it returns.

## The load-bearing minority

Items that survive **3+ relevance audits** without superseding architecture are usually genuine bottlenecks worth working — they're not on the list because we forgot, they're on the list because nothing has come along to make them moot.

When an item survives an audit, tag it explicitly with `[load-bearing]`. This:
- Makes future audits cheaper (you can skim past `[load-bearing]` items)
- Makes it obvious when an item *should* have been archived (load-bearing items that suddenly have new architecture nearby — re-audit)
- Forces honesty about which items are real bottlenecks vs. which are clutter

## Format expectations for archived items

Each archived item gets a section in a dated decision doc (`docs/decisions/YYYY-MM-DD-punchlist-staleness-archive.md`) covering:

1. **Status** — `ARCHIVED — RESOLVED / SUPERSEDED / STALE`
2. **Original framing** — what was on the punchlist, verbatim or close to it
3. **Why obsolete** — concrete pointer (commit, table, RPC, audit result) to what makes it stop being relevant
4. **Architecturally what handles this need now** — name the component that has the responsibility now, or "nothing — but the diagnostic isn't valid"
5. **What to do if the underlying need re-surfaces** — the cheapest path back to investigating it correctly

Then strike or remove the item from the playbook with a one-liner pointer back to the decision doc.

---

## Worked examples — 2026-05-02 archive

The first four archives under this pattern. Full context in `docs/decisions/2026-05-02-punchlist-staleness-archive.md`.

### Example A — SUPERSEDED

**Item:** P0 #0. Re-poll canonical week + diff signature corpus (~5–15K UW calls).

**Why archived:** Detector lifecycle (K=4 stability gate, `ct_detector_lifecycle_state`, continuous scoreboard) shipped 2026-05-02. Detectors now earn lifecycle status empirically over rolling windows. One-shot canonical-week tuning is redundant with continuous grading.

**If the need re-surfaces:** Adjust `ct_config` thresholds for the suspect detector. The lifecycle cron re-evaluates over the next 4 nights.

### Example B — SUPERSEDED

**Item:** P0 #1. DTE-bucketed win threshold (grader).

**Why archived:** Specialist Scoreboard v2 (commits `4bc606a`, `65d8996`, `f36da46`, 2026-05-02) made DTE-relative timing structural via `ct_specialist_grade_axes` + 4h/1d/3d underlying-axis windows + `blended_verdict`. DTE is in *which window resolves*, not in a per-DTE percentage threshold.

**If the need re-surfaces:** Add `dte_bucket_at_fire` to `ct_specialist_grade_axes` and slice scoreboard by it.

### Example C — RESOLVED

**Item:** P0 #2. Per-option-symbol track dedup (print-grader).

**Why archived:** 2026-04-28 partial UNIQUE INDEX `ct_contract_tracks_option_symbol_working_uniq` makes duplicate WORKING tracks structurally impossible. Saturday-night audit (2026-05-02 ~01:30 UTC) sampled 3,000 of 3,465 WORKING tracks — zero duplicates.

**If the need re-surfaces:** The index would have to be missing or bypassed somewhere. Investigate **why** before patching.

### Example D — STALE

**Item:** P2 #10. `ct_signature_alarm_log → ct_flags` 1:1 fix.

**Why archived:** 2026-04-28 diagnostic claimed 733 flags vs 610 alarms (gap = "missing alarm logs"). 2026-05-02 audit found 1,151 alarms vs 1,399 flags — gap is in the *opposite direction*. At least three possible gap shapes; no current diagnostic distinguishes between them. Original context isn't in playbook or `ct_heartbeats`.

**If the need re-surfaces:** Re-run counts fresh. Query alarm-to-flag join with the actual key the system uses. Identify which of the three gap shapes is real. *Then* fix the specific path. Tag `[needs-archeology]` until then.

---

## When in doubt

Default action: archive. The cost of archiving an item that turns out to still be real is small (it comes back on the list, with fresh diagnostic context). The cost of working an item whose premise has shifted is *much* larger — you ship a fix on top of a misunderstood system, and Tenet 15 ("does this class become impossible going forward?") gets answered "no" because the class wasn't real in the first place.
