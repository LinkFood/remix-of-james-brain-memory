# PR-only on `docs/`

## TL;DR

**Every file under `docs/` ships via PR. No direct-push to `main`.** This applies to runbooks, audits, scopes, governance docs, queue notes, scratch-style triage docs — anything inside `docs/`. Mixed code+docs commits also need PRs (the docs portion alone triggers the rule). Enforced by `.github/workflows/docs-pr-discipline.yml` — the workflow fails red on any direct-to-main push touching `docs/**` that isn't associated with a PR.

## Why this rule exists

Docs become the substrate future Cowork sessions read for context. If a framing lands on `main` without a verification gate, future sessions inherit it as ground truth. The audit-first discipline that protects code (Phase A → review → ship) applies equally to the artifacts that justify code decisions. **Nested-audit-first applied at the docs layer.**

The rule was first articulated 2026-05-06 after an unreviewed `docs/audit/...-queued.md` push (`b98dd18`) demonstrated how easily framing slips in without a PR gate.

## How to apply

1. Any `Write` or `Edit` to a path under `docs/` → branch + PR + CI + merge. Even a single-file queue note. Even a typo fix.
2. PR description states **why** the doc is being added/changed and what future-session impact it carries (so the review gate has the same shape as the code-review gate).
3. If a doc is genuinely scratch-only (notes-to-self that should not be inherited as ground truth), put it **outside `docs/`** — e.g., a sibling `~/scratch/` directory or a gitignored path. Don't smuggle scratch into `docs/` to dodge the PR.
4. Direct-push to `main` is reserved for paths outside `docs/`. Mechanical, uncontroversial code changes can ship directly per `CLAUDE.md` ship-it discipline. Docs cannot.
5. **Mixed code+docs commits also need PRs.** Even if the primary content is a migration or fn change, if the same commit touches `docs/`, the entire commit goes via PR. Either branch the docs out into a separate commit (and ship one direct-push code commit + one PR docs commit), or branch the whole thing.

## Enforcement

- **Server-side detection:** `.github/workflows/docs-pr-discipline.yml` runs on every push to `main`, diffs the push range, and verifies any commit touching `docs/**` has an associated PR via `gh api repos/.../commits/SHA/pulls`. Direct pushes touching `docs/` fail the workflow with a red ❌.
- **Detection, not blocking.** The push has already landed when CI runs; the red ❌ is the deterrent. Resolution path documented in the workflow's failure message: revert + branch + PR + merge.
- **No client-side hook.** Pre-commit hooks were YAGNI-deferred 2026-05-06 (`eaf04dd`); server-side detection has lower infra cost and higher visibility.
- **No branch protection** on `main` currently. If violation rate persists despite the CI gate, escalate to GitHub branch protection rule requiring PR for `docs/**` paths via CODEOWNERS.

## Today's motivating examples — 2026-05-07

Three direct-to-main commits this week motivated the structural enforcement:

| Commit | Files | Type |
|---|---|---|
| `16aaeb3` | `docs/audit/2026-05-07-class-kill-c-phase-b-rescope.md` + `supabase/migrations/...` | Mixed code+docs |
| `eaf04dd` | `docs/runbooks/ct_invariants_sql_authoring.md` | Pure docs |
| `da7d224` | `docs/runbooks/ct_invariants_sql_authoring.md` | Pure docs |

All three would have failed the workflow added in this PR. The CI gate catches all three failure shapes (pure-docs direct push, mixed code+docs direct push, repeat docs edit on the same file).

## Companion: `feedback_pr_only_for_docs.md`

The rule's first articulation lives in `~/.claude/projects/-Users-jameschellis/memory/feedback_pr_only_for_docs.md` (personal memory). That file is the historical record + Claude-side context. **This in-repo doc is the canonical reference** for anyone working in the repo — the failure message in the CI workflow points here.

## Cross-references

- Workflow: `.github/workflows/docs-pr-discipline.yml`
- First articulation: incident `b98dd18` (2026-05-06)
- Memory file: `feedback_pr_only_for_docs.md`
- Sibling discipline: `feedback_audit_first_discipline_default.md` — Phase A diagnose-only is the default for code; the same default applies to docs.
