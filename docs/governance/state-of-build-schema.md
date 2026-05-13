# STATE_OF_BUILD.md — schema and protocol

## Purpose

Kill the **stale-state-brief drift class**: Cowork (or any authoring surface) writes a paste-ready brief asserting per-item state from a stale mental-model region; captain pastes it; engine-room executes against false premises; manual audit reconciles; next session repeats.

`STATE_OF_BUILD.md` is the canonical cross-surface ground-truth state file. Cowork reads it before drafting any brief that asserts state; engine-room verifies against it before executing any state-asserting brief; engine-room re-writes it after every ship-batch.

Two compounding layers:

1. **Cross-surface snapshot** (this file). Cowork reads at brief-write time. Closes the cross-process mental-model gap.
2. **Receive-time audit** (engine-room write-time checklist Phase A audit step 1). Even if (1) fails — file stale, Cowork forgets, brief slips through — the engine-room re-runs ground truth as step 1 before any Phase B execution.

## File location

`/Users/jameschellis/Documents/cowork-cotrader/STATE_OF_BUILD.md`

Cross-surface direct write. Engine-room (this repo) writes via `scripts/write_state_of_build.sh`. Cowork reads directly — no git-pull lag, no shared-repo coordination cost. Verified writable from engine-room session 2026-05-09 evening.

## Why cross-surface and not in-repo

Repo-side state files require Cowork to `git pull` to see fresh state. If Cowork's source/ clone is even one PR behind, the state file is stale at read-time even though the repo had a fresh write. Cross-surface direct write closes that gap — Cowork sees the same file the engine-room just wrote, with no synchronization protocol.

The 5/7-era concern about cross-process file visibility (worktree-spawned agents not seeing Cowork dir) does not apply to main engine-room sessions writing directly to `/Users/jameschellis/Documents/cowork-cotrader/`. Verified at write-test time (2026-05-09 evening).

## Schema

```markdown
# STATE OF BUILD — Co-Trader / JAC Agent OS

**Last regen:** <UTC timestamp>
**Commit on origin/main:** <SHA> — <subject>
**Regen source:** scripts/write_state_of_build.sh
**Stale if:** last regen > 4 hours OR commit on origin/main differs

> Reading rules — Cowork brief authors / engine-room receivers (see WORKFLOW.md / engine-room checklist).

## Open PRs
[one-line per PR — number, title, head ref, days open]

## In-flight branches without PR
[one-line per branch — name, ahead-count, last commit message]

## Merged since <SINCE_DATE>
[one-line per PR — number, title, merge timestamp]

## Active measurement windows
[per-window: name, start → end, verdict day, status, notes about what the window blocks]

## Active deferred captain decisions
[one-line per decision]

## Backend state pulse
- ct_invariants total
- Warden 24h totals (passing / failing / critical / errored)
- Currently failing invariants (severity, consecutive_fails count)
- ct_growth_crons manifest count
- Embedding backlog counts (ct_tape_commentary, ct_breaking_news)

## Regen integrity
- gh CLI: OK / FAIL
- Supabase REST: OK / FAIL
- Warden RPC: OK / FAIL
- git fetch origin: OK / FAIL
```

## What the schema deliberately omits

- **Full cron.job dump.** Too noisy, low diff signal. The manifest count is the proxy. If a definitive cron count becomes drift-relevant, ship a `get_cron_jobs()` RPC and add to the script.
- **Per-PR descriptions.** Keep the file scannable. One-liners only. The PR itself is the authoritative source.
- **Cascade catalog index.** Already indexed in `docs/methodology-patterns.md`. Don't duplicate.
- **Per-organ brain telemetry.** Synthesis-layer surface (`get_brain_health` RPC) is the right tool when needed.

## Regen triggers

`scripts/write_state_of_build.sh` runs in three contexts:

1. **Post-every-ship-batch** (engine-room write-time checklist post-ship-batch section). Default. After any PR cluster merges, regen before declaring ship complete.
2. **On-demand** (captain trigger — "regen state" / engine-room session start / Phase A receive-time check). The script accepts no arguments for default behavior; pass `--since YYYY-MM-DD` to widen the merged-since window.
3. **Side-effect of any Phase A audit on a state-asserting brief.** The audit IS the regen. After the audit, the state file reflects the audit's findings and any subsequent reader gets ground truth.

**NOT cron-driven.** Cron creates its own silent-failure surface — a cron failing leaves the state file stale-but-fresh-looking. Discipline-driven regen with explicit failure modes keeps drift visible.

## Failure modes and their surfaces

The script `set -euo pipefail`s on data-source errors. Each integrity check writes OK / FAIL into the file's `## Regen integrity` section. Read-side discipline:

- If any integrity is FAIL → treat the entire file as stale. Re-run the script and check stderr.
- If `Last regen` is > 4 hours old → stale. Re-run.
- If `Commit on origin/main` differs from current `git rev-parse origin/main` (post-fetch) → stale. Re-run.

The file does not silently mask staleness. The freshness header + integrity section make it deterministic.

## Parallel-session coordination

`STATE_OF_BUILD.md` is last-writer-wins. Two engine-room sessions running the writer at near-identical times converge on correct content modulo timing — both read the same upstream (gh + Supabase REST), so the writes either match or the later write supersedes with marginally fresher data.

The file is **separate from** `~/.claude-coord.md` (which is the parallel-session active-claim coord). Different purpose: coord = transient session claims; state file = durable ground-truth ship snapshot. Don't conflate.

## Reading protocol — Cowork side

See `/Users/jameschellis/Documents/cowork-cotrader/WORKFLOW.md` Step 0 (drafted by engine-room, applied by Cowork-Claude).

- Step 0 of any paste-ready brief that asserts per-item state: read `STATE_OF_BUILD.md` first. If stale per the freshness rule, request a regen before drafting.
- Cross-check every state assertion in the brief against the file before sending.

## Receive-time protocol — engine-room side

See `docs/governance/engine-room-write-time-checklist.md` Phase A audit step 1.

- Step 1 of any state-asserting brief from captain: open the state file, check freshness, regen if stale, cross-check every assertion.
- Report any drift to captain before Phase B execution.

## Maintenance

- **When a measurement window opens or closes:** update `ACTIVE_WINDOWS` in `scripts/write_state_of_build.sh` (the heredoc near the top).
- **When a captain decision lands or a new one queues:** update `DEFERRED_DECISIONS` in the same script.
- **When a new substrate becomes load-bearing for drift detection** (e.g., a new measurement table, new cron registry surface): extend the script with a new query block and a new schema section.
- **When the schema itself evolves:** update this file FIRST, then update the script to match. Run the regen and verify the new section renders correctly.

## Sibling artifacts

- `docs/governance/engine-room-write-time-checklist.md` — engine-room write-time + receive-time disciplines (this file's read-side counterpart).
- `/Users/jameschellis/Documents/cowork-cotrader/memory/cowork-write-time-checklist.md` — Cowork write-time + read-state-file-first disciplines (this file's authoring-side counterpart).
- `/Users/jameschellis/Documents/cowork-cotrader/WORKFLOW.md` — Cowork-side process doc, Step 0 = read STATE_OF_BUILD.md.
- `docs/methodology-patterns.md` `## state-asserting-briefs-need-cross-surface-snapshot-plus-receive-time-audit` — methodology entry codifying the structural prevention pattern.
- `~/.claude-coord.md` — parallel-session coord (separate purpose).

## Why this file is itself subject to write-time discipline

If this schema doc drifts from what the script actually produces, future sessions read a wrong contract and the file becomes a different drift surface. When updating the script, update this file in the same PR. When updating this file, run the script to verify the schema matches.
