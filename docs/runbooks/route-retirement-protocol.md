# Route Retirement Protocol

**Status:** Active · Codified 2026-05-14 as part of Ship 6 (Phase 1 close arc, Bundle 1).

When a route is superseded by a newer surface, dead code drift starts the
moment you forget to delete the old one. /dashboard sat as a sandbox
wrapper long after /tape-v2 became the command center; /eod sat as the
legacy narrative summary long after /eod-report became the structured
view. Each one was a 30-second decision waiting to be made, but the
decision required *enough context to be confident*. This runbook is that
context, paste-ready, so future captains retire vestigial routes
deliberately and never silently.

This is the structural prevention layer (Tenet 13). The runbook IS the
prevention. Any future vestigial-page sweep follows these five steps in
order — no skipping, no improvising, no "I'll just delete it and see what
breaks."

---

## When to invoke this protocol

Trigger any time a route meets **all three** of:

1. A newer surface covers the same user need (or a strict superset of it).
2. The legacy route has had no captain-driven changes in ≥30 days.
3. The legacy route is not load-bearing for auth, billing, or a
   compliance/regulatory surface.

If any of those is false, the route stays. Retirement is a structural act,
not a cleanup chore.

---

## The 5-step protocol

### Step 1 — Verify no inbound MCP / edge function / cron references

```bash
# Run from repo root. Replace ROUTE with the path under retirement (no leading slash).
grep -rln -E "(/ROUTE)" supabase/functions/ mcp/ 2>/dev/null
```

False positives to discard manually:

- Edge function **names** that contain the route slug as a substring
  (e.g. searching `/eod` hits `ct-eod-report`, `ct-eod-summary`,
  `jac-morning-brief`). These are function names, not route refs.
- Comments / docstrings in TypeScript that mention the route by name.
  Those are documentation; they get updated in Step 5, not blocked here.

Any **real** inbound ref (an edge function that fetches the route URL, a
cron that opens the page, an MCP tool that emits a deeplink) is a hard
stop. Resolve the dependency before continuing.

### Step 2 — Verify no captain-recent-visit telemetry signal

If the route has any user-visit telemetry, confirm the captain hasn't
opened it recently (≥30 days). Sources to check, in order of authority:

1. `ct_brain_telemetry` filtered by route / consumer_name (Co-Trader paths).
2. `agent_activity_log` filtered by route (JAC paths).
3. Browser history / muscle memory (the captain's own recall).

A "recent" visit means the route still has unmet user demand; retirement
becomes a research project, not a sweep. If the surface is genuinely
deprecated, captain shouldn't have visited.

### Step 3 — Phase A on the route's substrate dependencies

Read the page file end-to-end. Catalog:

- Which hooks does it own that no other page uses?
- Which RPCs, tables, or edge functions does it call?
- Which components does it import that no other page imports?

If any of those have only one consumer (the retiring route), they're
candidates for the same retirement bundle. Don't retire the page and leave
its substrate orphaned — that's the "we'll clean it up later" anti-pattern
that ages into next year's tech debt.

**Output of Phase A:** a list of "kill alongside the route" and "keep,
shared with X." This list goes in the commit body.

### Step 4 — Docs codification via PR (PR-only on docs/)

The discipline doc is `docs/governance/pr-only-on-docs.md`. The CI gate is
`.github/workflows/docs-pr-discipline.yml`. Both still apply. Specifically:

- Code changes (App.tsx Routes, TopNav.tsx links, page deletions,
  redirect insertions) → commit + push to main directly.
- Any `docs/**` change (new runbook, retro note, methodology entry tied
  to the retirement) → separate PR. Mixed commits also need a PR (the
  entire commit, code parts included, goes via PR if it also touches
  `docs/`).

The retirement commit body **mentions** the runbook as a docs follow-up
when applicable. The runbook PR lands second; reviewers see the
retirement context already on main.

### Step 5 — Tombstone redirect to successor or 404 with explicit message

Every retired route gets one of two endings — never silent absence.

**Option A (preferred when a clear successor exists):**

```tsx
<Route path="/OLD_ROUTE" element={<Navigate to="/SUCCESSOR" replace />} />
```

`replace` is required so the retired URL doesn't sit in browser history.
Add an inline comment above the route citing the ship number + this
runbook, so the next grepper finds the reasoning:

```tsx
{/* Ship N — /OLD_ROUTE retired, redirect to /SUCCESSOR. See docs/runbooks/route-retirement-protocol.md */}
```

**Option B (when no successor exists):**

Return a `<NotFound>` component (or a route-specific tombstone page) that
states the retirement explicitly and points at the closest active surface:

> /OLD_ROUTE was retired in Ship N. Closest active surface: /CLOSEST.
> See docs/runbooks/route-retirement-protocol.md for the full reasoning.

Silent absence (the route simply not registering, falling through to the
default NotFound) is **not acceptable**. The captain's muscle memory + any
external bookmarks (Slack links, browser favorites, email links) deserve
a coherent landing, not a generic 404.

---

## Reference application — Ship 6 (2026-05-14)

Three routes retired in one bundle:

| Retired route | Successor | LOC reclaimed | Notes |
|---|---|---|---|
| `/dashboard` | `/tape-v2` | 66 (Dashboard.tsx) | JAC-era widget sandbox, no Co-Trader integration |
| `/eod`       | `/eod-report` | 287 (Eod.tsx)   | Legacy narrative summary; /eod-report is the 1202 LOC structured version |
| `/settings` (stripped, not retired) | `/settings` | 261 (delta) | Removed delete-all-user-data foot-gun + JAC entries-coupled tooling |

Total LOC reclaimed: **614** in a single commit. The asymmetry of "tiny
incremental scope, large structural payoff" is the shape Phase 1 close
arcs should produce. If a route-retirement commit reclaims <50 LOC, the
route was probably already pulling its weight — re-audit.

Phase A grep result for Ship 6 (Step 1):

```
$ grep -rln -E "(/dashboard|/eod[^-])" supabase/functions/ mcp/
supabase/functions/ct-eod-report/index.ts       # ← false positive, fn name
supabase/functions/ct-eod-summary/index.ts      # ← false positive, fn name
supabase/functions/ct-edge-miner/index.ts       # ← false positive, fn name
supabase/functions/jac-morning-brief/index.ts   # ← false positive, fn name
```

Zero real inbound refs. Cleared Step 1.

Post-retirement App.tsx redirect block:

```tsx
{/* Ship 6 — /eod retired, redirect to successor /eod-report. See docs/runbooks/route-retirement-protocol.md */}
<Route path="/eod" element={<Navigate to="/eod-report" replace />} />

{/* Ship 6 — /dashboard retired, redirect to successor /tape-v2 (the Co-Trader command center). See docs/runbooks/route-retirement-protocol.md */}
<Route path="/dashboard" element={<Navigate to="/tape-v2" replace />} />
```

---

## Class-kill anchoring

This protocol exists because three same-week instances of "did we
remember to remove the old route?" became three different conversations
(2026-05-08 tape redesign push, 2026-05-13 Ship 5 reconciliation, Ship 6
itself). The class is:

> A vestigial route stays alive because nobody has the 30-second context
> to be confident it can die.

The runbook is the 30 seconds, written down once. Codified as a sibling
to other Phase 1 prevention layers:

- `docs/governance/pr-only-on-docs.md` — PR discipline for docs
- `docs/governance/engine-room-write-time-checklist.md` — pre-paste audit
- `docs/methodology-patterns.md` — cascade catalog

Every future vestigial-page sweep cites this file in its commit body.
That citation IS the prevention layer — the next captain can't sweep
without the discipline checklist landing in their commit message.
