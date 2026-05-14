## Summary

<!-- One paragraph: what this PR does and why. Link to brief/Phase A doc/incident retro if applicable. -->

## Dependencies

<!--
Cascade #46 class-kill (2026-05-13). If this PR is based on another open
PR's branch (i.e., you branched off PR #N to avoid pre-merge conflicts on
shared files), declare it here. If PR #N merges first via squash, GitHub
will mark this PR CONFLICTING/DIRTY even though the working trees agree
semantically — squash flattens N commits into one and the duplicate-content
patch context confuses the per-file merge driver.

Resolution: reset --hard origin/main + cherry-pick + push --force-with-lease.
See docs/runbooks/squash-merge-dependency-resolution.md for the runbook.

Two empirical fires on 2026-05-13: PR #115 (after #114 squash) and PR #91
(after Bundle 1-3 squash-merge accumulation).
-->

**Depends on:** <!-- e.g., "PR #N — branched from its feature branch to avoid pre-merge conflicts on docs/methodology-patterns.md" — OR "none / standalone" -->

**Squash-merge resolution plan (if dependent):** <!-- "Merge dependency first, then immediately squash this PR before main drifts further" OR "Will require reset-cherry-pick-force per docs/runbooks/squash-merge-dependency-resolution.md if dependency merges before this one" — OR "n/a" -->

## Diagnosis (required for fix PRs; mark "n/a" for refactor / docs-only / new feature)

<!--
Class kill E forcing function (2026-05-06). When a fix PR proposes a cause,
enumerate orthogonal evidence here. The forcing function exists because
today's P0 (instance #11 service-role-key false-cause) and instance #15
(audit-verification-surface-mismatch) were both caught manually by
"verify before acting." This template makes that step mechanical.

When a hypothesis matches the shape of an adjacent memory entry
(feedback_*.md), treat the match as a NARROWING heuristic, not a
confirmation. The matching shape biases toward premature conclusion —
verification step becomes MORE important, not less.
-->

**Hypothesis:** <!-- the proposed cause -->

**Supporting evidence:** <!-- what makes you believe this is the cause -->

**Adjacent memory matches (if any):** <!-- link to feedback_*.md / patterns.md / glossary.md entry that this hypothesis matches the shape of -->

**Orthogonal verification:** <!-- what evidence, separate from the symptom that triggered the hypothesis, confirms the cause? OR "not applicable — fix is structural and works regardless of cause" -->

**Orthogonal evidence collected:** <!-- the actual evidence — query results, logs, vault reads, etc. -->

## Test plan

<!-- - [ ] What you'll verify after merge -->

🤖 Generated with [Claude Code](https://claude.com/claude-code)
