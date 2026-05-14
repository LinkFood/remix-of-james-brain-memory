# Squash-merge dependency resolution runbook

**Cascade #46 class-kill operational reference.** When a PR depending on another open PR's branch becomes CONFLICTING/DIRTY after the dependency merges via squash, this runbook is the resolution pattern. Two empirical instances on 2026-05-13 (PR #115 + PR #91); resolution procedure identical in both cases.

## When this runbook applies

You see `mergeStateStatus: DIRTY` / `mergeable: CONFLICTING` on PR B after PR A merged via squash. Pre-merge both were `MERGEABLE/CLEAN` and PR B's branch was branched from PR A's branch (or contained PR A's commits in its history) to avoid pre-merge conflicts on shared files.

This is **NOT** a real semantic conflict in your code. It's a workflow-state-drift artifact:

- Squash flattens N commits in PR A into 1 commit with a different SHA.
- PR B's branch still carries A's original commits + B's own commits.
- GitHub's per-file merge driver sees "main has content X (via squash) and PR B's branch has content X (via the original commits) plus B's additions" and can't reconcile the duplicate-content patch context.

The working trees agree semantically. The merge metadata doesn't.

## Resolution (≤ 5 min wall)

```bash
# 1. Sync local main to the post-squash state
git checkout main
git pull --ff-only origin main

# 2. Branch from clean main
git checkout -b <pr-b-branch-name>-rebase origin/main

# 3. Cherry-pick PR B's unique commits (NOT including PR A's now-squashed
#    commits — those are already in main as the single squash commit)
git log --oneline <pr-b-original-branch> ^origin/main
# Identify PR B's UNIQUE commit hashes
git cherry-pick <pr-b-unique-commit-1> [<pr-b-unique-commit-2> ...]

# 4. Resolve any drift conflicts. Common shapes:
#    - additive content in shared files (iteration logs, methodology
#      catalogs, schema docs) — accept both sides
#    - PR B references something PR A added that got renamed during
#      squash review — update reference to post-squash name
#    - imports/exports updated in PR A between branching and squash — re-add

# 5. Run local build/test to confirm semantic correctness
npm run build  # or whatever applies
deno task verify  # for MCP changes

# 6. Force-push the rebased branch onto PR B's branch name
git push --force-with-lease origin <pr-b-branch-name>-rebase:<pr-b-branch-name>

# 7. CI re-runs against the new linear history; GitHub re-marks PR B
#    as MERGEABLE/CLEAN within ~10-20 seconds.

# 8. Merge PR B via squash (gh pr merge <N> --squash --delete-branch).
```

## Empirical instances on 2026-05-13

### Instance 1 — PR #115 ATLAS_OF_BUILD after PR #114 STATE_OF_BUILD squash-merged

- PR #114 squash-merged at 17:36:34Z as commit `dc15bfe`
- PR #115 flipped CLEAN → CONFLICTING ~17:37Z
- Conflicts: `docs/methodology-patterns.md` + `docs/governance/engine-room-write-time-checklist.md` (additive content in both — PR #114 added State-of-Build sections, PR #115 added Atlas-of-Build sections)
- Resolution: reset + cherry-pick `05a6852` (PR #115's unique commit) + force-push
- PR #115 merged at 17:45:53Z as commit `6b5b3fd`
- Total wall: ~9 min

### Instance 2 — PR #91 Regime Flip Journal merged late (5 days after squash of dependency)

- PR #91 opened 2026-05-09 against then-current main
- Today's Bundle 1-3 ships moved main forward 8 commits + 3 squash-merged PRs (#114, #115, #116, #117, #118)
- When merge attempted at 00:09Z (2026-05-14), PR #91 was DIRTY/CONFLICTING
- Conflicts: `src/pages/Alpha.tsx` (iter #2.6 removed the placeholder slot PR #91 expected) + `docs/audit/tape-v2-iteration-log.md` (additive — phases 1-5 entries landed via #86-#90 + Bundle 1-3 entries)
- Resolution: reset + cherry-pick `d62bc96` (PR #91's unique commit) + manual conflict resolution (drop retired placeholder imports; slot RegimeFlipJournal directly after NewsCausalityMatrix per current /alpha layout) + force-push
- PR #91 merged at 00:10:09Z as commit `889ace2`
- Total wall: ~7 min

## Why declare dependencies up front

The PR template's `## Dependencies` section (see `.github/PULL_REQUEST_TEMPLATE.md`) asks PR authors to declare squash-merge dependencies at PR-author time. The earlier this is named, the cheaper the resolution:

- **Named pre-dependency-merge:** reviewer knows to merge dependent PR B immediately after PR A, before any rebase friction accumulates. Resolution is auto-merge clean.
- **Named at merge time but not pre:** dependent PR B requires reset-cherry-pick-force per this runbook. ~5-10 min wall.
- **Not named until conflict surfaces:** same as above, plus the author/reviewer mental-model gap of "wait, why is this PR conflicting?" Adds debugging time.

## Tooling note — `--force-with-lease` vs `--force`

`--force-with-lease` is the safer variant: it refuses the push if the remote branch advanced since your last fetch. If a collaborator pushed to the same PR branch between your reset and your push, `--force-with-lease` aborts; `--force` would silently overwrite their work. Use `--force-with-lease` by default.

## Cross-references

- Methodology pattern: `docs/methodology-patterns.md` `## squash-merge-of-dependent-PR-stack-causes-false-CONFLICT-on-follower` (cascade #46)
- PR template: `.github/PULL_REQUEST_TEMPLATE.md` `## Dependencies` section
- Sibling cascade pattern: `## docs-PR-merge-doesnt-imply-migration-applied` (cascade #43; same family of workflow-state-drift around merge mechanics)
- Cross-catalog parity entry: `/Users/jameschellis/Documents/cowork-cotrader/memory/patterns.md` cascade #46 instance #2 (PR #91)

## Diagnostic question for future class fires of this shape

*"Is this PR's branch based on another open PR's branch? If yes, did the dependency merge via squash? If yes, has this PR been rebased onto post-squash main since the dependency merged?"* — three-question check. Any "no" on the third question signals the runbook applies.
