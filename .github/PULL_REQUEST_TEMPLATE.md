## Summary

<!-- One paragraph: what this PR does and why. Link to brief/Phase A doc/incident retro if applicable. -->

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
