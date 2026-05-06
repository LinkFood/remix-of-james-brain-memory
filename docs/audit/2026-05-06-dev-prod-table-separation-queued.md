# Queued audit — local dev MCP writes into prod tables

**Status:** queued, no action this round.
**Source:** §3 sub-finding from `2026-05-06-brain-telemetry-real-errors-phase-a.md`.
**Filed:** 2026-05-06.

## What was observed

The first `cache_hit:fresh_0s` row in `ct_brain_telemetry` (2026-05-05T19:59:54.827577Z) was written **1m37s before** the commit timestamp of `b185f98` (2026-05-05T20:01:31Z), the commit that introduced the cache-hit telemetry path.

**Mechanism:** the cotrader-mcp v1.1 dev/test loop runs the MCP server locally with the prod service-role key. Local smoke tests, ad-hoc developer invocations, and any pre-merge debugging therefore write directly into prod `ct_brain_telemetry` (and now also `ct_mcp_tool_calls`).

## Why this matters

1. **Telemetry pollution.** Pre-merge experiments inflate prod row counts that warden invariants threshold against. Even when the writes are benign (success rows), p50/p95 latency baselines drift.

2. **Audit trail confusion.** Future timestamp-vs-commit forensics (like §3 of today's audit) become harder when "first occurrence" predates the commit.

3. **Class scope.** This isn't MCP-specific. Any `_shared/` helper invoked from a local Deno script with the service-role key can write to prod. The MCP just made it visible because the writes were tagged with a fresh consumer name. Past local-only test runs of any consumer have likely silently inflated prod telemetry too.

4. **Decision-ritual gate.** *"Does this class of failure become impossible going forward?"* Currently no — the prod service-role key is the only key in `~/.config/supabase` for this project. Any local Deno run picks it up.

## Candidate class kills (no decision yet)

- **A.** Stand up a separate dev/staging Supabase project. Local MCP server reads `SUPABASE_DEV_URL` + `SUPABASE_DEV_SERVICE_KEY` from a different env path; prod URL is only set in the deployed surface. Migration and config burden non-trivial; might not be worth it for a single-user system.
- **B.** Add a `dev_mode: boolean` to telemetry inserts at the helper boundary, sourced from an env var. When true, writes go to a `*_dev` shadow table or are dropped. Cheaper than full project separation; preserves single-DB simplicity. Risk: developer forgets to flip the env var.
- **C.** Refuse to write telemetry when an `IS_LOCAL_DEV=true` env var is set. Local MCP runs are silent. Loses smoke-test visibility of telemetry pipeline; fine if smoke tests don't depend on telemetry side-effects.
- **D.** Out-of-loop monitoring: a warden invariant that fires when `consumer_name` writes a row with `latency_ms = 0` for a non-cache_hit organ — a heuristic for "this didn't actually run, it's a smoke test placeholder." Defense-in-depth, not a class kill.

## When to revisit

- After v2 Tier 2 ships and we have a few sessions of empirical "how often do dev writes leak in prod?" data.
- Or: next time a forensic audit gets confused by a pre-commit timestamp.
- Not before James has used cotrader-mcp v1.1 in a real RTH session (per the v1.1 deferral discipline).

## Out of scope for this round

No code changes. No env changes. No new tables.
