# Phase A Audit — `messages` Orphan Reference

**Date:** 2026-05-05
**Mode:** Read-only investigation. Zero code changes, zero migrations, zero writes.
**Scope:** `calculate-importance` edge function references the `messages` table at 2 call sites; the table was dropped on 2026-01-23 and never re-created.
**Surfaced by:** B4 CI grep `scripts/check_supabase_table_refs.sh` (born from PR #13's distill-principles audit). Allowlisted pending this audit. Sibling to the `dumps` audit (PR #19/#20) which turned out FALSE_POSITIVE; this one is the real shape.

---

## TL;DR

**Verdict: `DEAD_REFERENCE`** — both `from('messages')` blocks are unreachable in practice and the table they target was deleted 3.5 months ago.

- `supabase/functions/calculate-importance/index.ts` references `messages` at lines 75 (SELECT) and 135 (UPDATE). Both are gated by `if (messageId)` — only fire if the caller passes a `messageId` field in the request body.
- `messages` was created 2025-11-22 (migration `20251122051423`), then **explicitly DROPPED 2026-01-23** in migration `20260123024012` with the comment *"Drop deprecated tables from the old multi-provider chat architecture — These tables are no longer used after the Brain Dump pivot."*
- PostgREST live response: `PGRST205` with hint *"Perhaps you meant the table 'public.entries'"*. No `messages`-shaped table exists in any exposed schema.
- **No live caller passes `messageId`.** Both production callers (`smart-save` lines 218 and 496) pass only `{ content, role: 'user' }`. The `if (messageId)` branches are dead code.
- The function's actual production behavior is intact: it returns the importance score, and `smart-save` writes it to `entries.importance_score` directly (line 509). `entries` (481 rows) has the column and live data confirms scores are landing.
- Sibling shape to the `distill-principles` audit, but inverted: that case had a writer with no target table; **this case has a writer with no caller exercising the dead branch.** No silent failure has actually occurred — only a latent landmine.

---

## Q1 — Producer side: code paths writing/reading `messages`

### Call site inventory

```
supabase/functions/calculate-importance/index.ts:75   .from('messages').select('content, role').eq('id', messageId).single()      // READ
supabase/functions/calculate-importance/index.ts:135  .from('messages').update({ importance_score: importanceScore }).eq('id', ...)  // WRITE
```

**Total: 2 references in 1 file.** Both are inside `calculate-importance/index.ts`. No other file in the repo references `from('messages')` or `from("messages")`.

### Characterization

| Line | Op | Columns | Business intent |
|---|---|---|---|
| 75 | SELECT | `content, role` | Hydrate message body when caller passes only `messageId` (no inline content) |
| 135 | UPDATE | `importance_score` (1 col) | Persist computed importance score back to the message row |

Both blocks are gated by `if (messageId)` (lines 70, 133). The function has a parallel inline-content path that doesn't touch `messages` at all and is the path every live caller actually uses.

### Last-modified history

Function was created 2025-11-22 by gpt-engineer-app[bot] (commit `2e40c45` "Changes"). The `from('messages')` references were present from the **first commit** — the function and the (then-existing) `messages` table were authored together. Subsequent commits (`87f4748` 2026-01-23, `e5c6b32` 2026-01-25, `9a366d0` 2026-02-22) were unrelated refactors (CORS, response shape, rate-limiting, validation helpers) — none touched the `from('messages')` blocks. The dead-code class was created on 2026-01-23 when the table was dropped in commit `ce13a1f` but the function was not updated in the same commit.

### Live caller analysis (the load-bearing finding)

Two callers in production:

```
supabase/functions/smart-save/index.ts:218    body: JSON.stringify({ content, role: 'user' })       // AI-path classify-and-score
supabase/functions/smart-save/index.ts:496    body: JSON.stringify({ content, role: 'user' })       // Fast-path deferred score
```

**Neither caller ever passes `messageId`.** The function falls into the inline-content branch (line 67) every time, computes the score, and returns it. `smart-save` then writes the score back to `entries.importance_score` itself (line 509) — the function's internal `messages` UPDATE is bypassed entirely.

Grep across `src/` and all other `supabase/functions/`: zero other invokers of `calculate-importance`. The only frontend reference is `src/components/ActivityTrackingProvider.tsx:93` (telemetry tag, not a caller).

`messageId` appears nowhere else in the codebase as a field passed to this function — confirmed by full grep. The `if (messageId)` branches in the function have been **structurally unreachable since 2026-01-23**.

---

## Q2 — Schema side: does `messages` exist anywhere PostgREST exposes?

### Direct PostgREST query (service-role, 2026-05-05)

```
GET /rest/v1/messages?select=*&limit=1
→ 404
{
  "code":    "PGRST205",
  "details": null,
  "hint":    "Perhaps you meant the table 'public.entries'",
  "message": "Could not find the table 'public.messages' in the schema cache"
}
```

PostgREST's hint is **not** the structurally intended target — it's a Levenshtein guess. `entries` is JAC's brain table (note dump store), not a chat-message store. Distinct domain. Hint is a coincidence.

### OpenAPI spec — any `*message*` table

```
GET /rest/v1/  →  filter definitions for 'message|chat|conversation|msg'
→ hunt_conversations
  agent_conversations
  ct_chat_tokens
  ct_chat_tokens_today
```

Zero tables with `message` in the name across all PostgREST-exposed schemas. The closest cousin is `agent_conversations` (JAC's chat-history table), but its schema is task-conversation-shaped (per-user agent dialogue), not the original `messages` shape (per-conversation row with role/content/embedding).

### Migration archeology

The `messages` table had a complete lifecycle:

| Migration | Date | Op |
|---|---|---|
| `20251122000000_bootstrap_profiles.sql` | 2025-11-22 | CREATE TYPE `message_role` AS ENUM |
| `20251122051423_2f79ce4f-...sql` | 2025-11-22 | **CREATE TABLE public.messages** (id, conversation_id, user_id, role, content, embedding vector(768), topic, created_at) + RLS + indexes |
| `20251122055625_c7958615-...sql` | 2025-11-22 | Add `embedding` column (idempotent re-add) + HNSW index + `search_messages_by_embedding()` RPC |
| `20251122065732_f27056b9-...sql` | 2025-11-22 | Add `importance_score` column + index |
| `20251122125035_bec78cd3-...sql` | 2025-11-22 | Add 4 query-optimization indexes (user_created, user_importance, user_conversation, embedding_hnsw, vault_query) |
| `20251122125910_e4610063-...sql` | 2025-11-22 | Add `starred`, `pinned`, `deleted_at` columns + RLS update/delete policies |
| **`20260123024012_8af6c983-...sql`** | **2026-01-23** | **DROP TABLE IF EXISTS messages CASCADE** + DROP TABLE conversations + DROP TABLE user_api_keys |

The drop migration's comment is unambiguous:

```sql
-- Drop deprecated tables from the old multi-provider chat architecture
-- These tables are no longer used after the Brain Dump pivot
DROP TABLE IF EXISTS messages CASCADE;
DROP TABLE IF EXISTS conversations CASCADE;
DROP TABLE IF EXISTS user_api_keys CASCADE;
```

This is **not** a deferred migration or a schema-cache stale issue. The table was deleted intentionally as part of the 2026-01-23 architecture pivot from multi-provider chat to brain-dump. No subsequent migration re-creates it.

> **Allowlist comment was wrong.** `scripts/check_supabase_table_refs.allowlist:15-19` says *"Possibly RLS-filtered or schema-cache stale."* Neither — the table was actively dropped. Update the allowlist comment when removing the entry in Phase B.

### Was a `*messages*` table created elsewhere as the new home?

No. The 2026-01-23 commit replaces `messages` (chat history) with `entries` (brain dump store). They are not equivalents:

| `messages` (dropped) | `entries` (live) |
|---|---|
| conversation_id FK | no conversation grouping |
| `role` ENUM (user/assistant/system) | no role concept |
| 768-dim embedding (Lovable-era) | 512-dim embedding (Voyage) |
| chat-history shape (every utterance) | knowledge-store shape (curated content_type='note'/'idea'/'event'/etc) |

`entries` is the structural successor for *importance scoring as a concept*, but the per-row UPDATE-by-message-id semantic of `messages` doesn't carry over: `smart-save` already writes scores back to `entries.importance_score` directly. The `messages` UPDATE branch in `calculate-importance` is functionally orphaned.

---

## Q3 — Intended target / typo class

### Was a similarly-named table created as the new home?

Confirmed via OpenAPI spec — **no**. The closest names exposed:

- `agent_conversations` — wrong shape (no per-message rows; stores task conversation history)
- `hunt_conversations` — Duck Countdown side; out of scope
- `ct_chat_tokens` — Co-Trader chat token telemetry; not a message store

None match the `messages` shape (id + content + role + importance_score on a per-utterance row).

### Verdict

**Not a typo class.** The function and table were correctly paired at birth (2025-11-22). The table was deliberately removed 2 months later in an architecture pivot, and the function was not pruned in the same commit. Two months and ~5 commits to the function passed without anyone noticing the dead reference because **the live caller never exercised the dead branch.**

This is a **DEAD_REFERENCE** — the codebase carries a vestigial code path that targets a removed table. The class (writer pointed at non-existent table) is the same as the `distill-principles` case, but with two crucial differences:

| | distill-principles | calculate-importance |
|---|---|---|
| Table existence | never created | created then dropped |
| Caller exercises dead path? | **yes — every Sunday cron fired into the void** | **no — `messageId` never passed in production** |
| Functional impact | 10 weeks of empty principles output | zero — score still flows to `entries` via `smart-save` |
| Recovery path | redirect writer to `jac_principles` | delete the dead branch entirely |

The B4 CI grep correctly flagged this — it's a real orphan. But the operational severity is much lower than `distill-principles` because no function output has been silently lost.

---

## Q4 — Operational impact

### How many invocations have hit `from('messages')` since the drop?

**Zero of operational consequence.** Walkthrough:

- Both `from('messages')` blocks live inside `if (messageId)` guards.
- All 2 production call sites (`smart-save` lines 218 and 496) pass `{ content, role: 'user' }` — no `messageId`.
- Grep across the entire codebase for callers passing `messageId` to `calculate-importance`: none.
- Therefore: from 2026-01-23 (table dropped) through 2026-05-05 (today, ~103 days), the SELECT at line 75 has fired **0 times in production**, and the UPDATE at line 135 has fired **0 times in production.**

If a caller *had* passed `messageId`:

- The SELECT at line 75 would have hit `PGRST205` → `fetchError` truthy → `errorResponse(req, 'Message not found', 404)` → caller would get an HTTP 404. Visible failure mode.
- The UPDATE at line 135 would have hit `PGRST205` → `updateError` truthy → `console.error('Error updating message:', updateError)` → silent continue. Classic silent failure.

The dead WRITE path (line 134-141) is the more dangerous one — it follows the same pattern that bit `distill-principles` for 10 weeks. But again: nobody is exercising it.

### Functional behavior loss

**None.** `smart-save` continues to:

1. Call `calculate-importance` with inline content
2. Receive the score back in the response
3. Write the score to `entries.importance_score` itself

Live evidence: `entries` table (481 rows) has populated `importance_score` values (sample row returned `importance_score: 3`). The scoring pipeline is intact end-to-end.

### Latent landmine

The risk is forward, not backward: if anyone ever extends `calculate-importance` (or copies its pattern) and starts passing `messageId` again — perhaps wiring it to a future per-utterance store — they'll get the silent-write failure class for free. The dead branch makes the API *look* like it supports a `messageId` path that has been broken for 3.5 months.

---

## Q5 — Phase B recommendation shape

### Recommended path: `DEAD_REFERENCE` cleanup (B1 + B2)

#### B1 — Remove the dead branches

Edit `supabase/functions/calculate-importance/index.ts`:

- Delete the `messageId?: string` field from `ImportanceRequest` (line 16).
- Delete the `messageId` destructure (line 61) and adjust the validation guard at lines 63-65 to require `content`.
- Delete the entire `if (messageId) { … }` block at lines 70-85 (SELECT + hydrate).
- Delete the entire `if (messageId) { … }` block at lines 133-141 (UPDATE).
- Optionally rename `messageContent` → `content` and `messageRole` → `role` since the dual-source shape is gone.

Resulting function: takes `{ content, role? }`, returns `{ importance_score, reasoning, success }`. Drops ~30 lines, no behavior change to live callers.

Redeploy: `npx supabase functions deploy calculate-importance --no-verify-jwt`.

**Verification:** invoke with `{ content: "hello world", role: "user" }` from `smart-save` → confirm score returned + `entries.importance_score` updated. Smoke-test path: save a note via /jac → check that the entry's `importance_score` is non-default within ~5s.

#### B2 — Remove from CI allowlist

Edit `scripts/check_supabase_table_refs.allowlist`:

- Delete the `messages` entry (line 20) and its 4-line comment block (lines 15-19).
- Update with a tombstone comment matching the dumps removal style:

```
# [removed 2026-05-05 messages Phase B] `messages` was a dropped table from
# the pre-2026-01-23 multi-provider chat architecture. Phase A audit confirmed
# the writer (`calculate-importance`) had two unreachable `from('messages')`
# branches gated by `if (messageId)` — no live caller ever passed messageId.
# B1 removed the dead branches; allowlist entry removed (not perma-suppressed).
# See `docs/audit/2026-05-05-messages-orphan-phase-a.md`.
```

CI grep will now see zero `from('messages')` references and pass clean.

#### Class-kill check (Tenet 15)

> *"Does this make the class ('writer aimed at non-existent table') impossible going forward?"*

**Partial.** The B4 CI grep already structurally kills this class for any future writer (it now blocks PRs introducing `from('<orphan>')` references). What B1+B2 close is the *legacy debt* from before the CI grep existed. The class itself is killed by the script that flagged this — Phase A is paying down the backlog the script generated.

Two structural concerns to surface (NOT bundle):

1. **Dropping a table should grep its code references.** The 2026-01-23 commit dropped `messages` without grepping callers. A migration-time lint (`scripts/check_drop_table_orphan_callers.sh`?) would have caught this in the same PR. Out of scope; flag for separate proposal.
2. **`if (someInputField) { dead-table-call }` patterns are invisible to the existing CI grep IF the input field is never set.** The B4 script catches the literal `from('orphan')` regardless of guard, so it caught this case — but a more sophisticated dead-branch detector (call-graph aware) would surface unreachable code generally. Lower priority; the grep already handles the high-value case.

### Alternative paths (rejected)

- **TYPO_FOR_<TABLE>:** Rejected. No similarly named live table is the structural successor. `entries` is shape-incompatible (no per-utterance row + role); `agent_conversations` stores task dialogue not utterances. Cannot redirect.
- **WAS_MEANT_TO_EXIST:** Rejected. The table *did* exist; it was deliberately deleted in an architecture pivot. Re-creating it would resurrect a dead schema for code that no live caller exercises. Net architectural regression.
- **RLS_LOCKED_OR_OTHER:** Rejected. PostgREST query with service-role key returned PGRST205 — this is true table absence, not an RLS-filtering artifact. Service-role bypasses RLS; if the table existed, service-role would see it.

---

## §6 Phase B Proposal (no shipping)

Two discrete steps, both safe and tightly scoped:

### B1 — Delete dead `messages` branches in `calculate-importance`

Single-file edit (calculate-importance/index.ts), ~30 lines removed, zero behavior change for any live caller. Redeploy via `npx supabase functions deploy calculate-importance --no-verify-jwt`. Verify by invoking through `smart-save` and confirming `entries.importance_score` lands.

### B2 — Remove `messages` from CI allowlist

Single-file edit (`scripts/check_supabase_table_refs.allowlist`), tombstone comment matching dumps removal style. CI grep passes clean post-B1.

**No warden invariant required.** Unlike `distill-principles` (where the writer's output was load-bearing for system intelligence), `calculate-importance`'s `messages` UPDATE was never the canonical write path — `entries.importance_score` is, and that is already write-monitored implicitly via `entries` row growth. Adding a new invariant here would be cargo-cult discipline.

**Do NOT bundle a class-kill structural fix.** Two concerns surfaced (drop-table-orphan-caller lint; dead-branch-aware grep) should be proposed as separate PRs with explicit James approval per the audit constraints.

---

## §7 Trade-offs needing James's call

1. **Delete vs. fix-up the messageId branch.**
   Recommendation: delete. The original `messages`-based path (fetch message by id, score it, write the score back) belonged to the multi-provider chat architecture that was pivoted away from on 2026-01-23. There is no current product surface that needs a "score this stored utterance by id" capability — `smart-save` (the only caller) already has the content in hand. Keeping the branch alive against a hypothetical future is YAGNI.

2. **Re-create `messages` vs. delete the references.**
   Recommendation: delete the references. Re-creating a table that was explicitly dropped in an architecture pivot would resurrect a dead schema with no consumers. The drop migration's comment ("These tables are no longer used after the Brain Dump pivot") is the design statement; honor it.

3. **Should the function be deprecated entirely?**
   No. `calculate-importance` is actively used (live callers in `smart-save` lines 218 and 496) and its inline-content path works correctly. It's a legitimate Haiku-scoring helper. Only the `messages`-coupled paths are dead.

4. **Tenet 15 framing — class-kill vs. instance-kill.**
   The CI grep (B4 from the distill-principles audit) is the class-kill — it makes future writer-points-at-orphan-table impossible. This audit's B1+B2 are an *instance* kill (paying down legacy debt that pre-dates the CI grep). That's acceptable here because the class is already structurally killed; we're just cleaning the residue. Not a Tenet-15 violation.

5. **Allowlist comment quality.**
   The original allowlist comment (lines 15-19 of `check_supabase_table_refs.allowlist`) misdiagnosed this as "Possibly RLS-filtered or schema-cache stale." Phase A confirmed it was a deliberately-dropped table. The Phase B tombstone comment should make the actual cause clear, mirroring the dumps removal style. This is a small process refinement: future allowlist additions should include a "candidate hypothesis" not a "confident misdiagnosis" — but that's editorial, not structural.

---

## Backfill viability

**Not applicable.** No data was lost (the dead branch never executed in production). Live importance-scoring data on `entries` is intact (481 rows, scores landing correctly). Nothing to backfill.

---

## Structural concerns to pause Phase B

**None blocking.** Two soft notes for separate proposals:

1. **Drop-table commits should grep code references in the same PR.** The 2026-01-23 commit that dropped `messages` did not check whether any function still wrote to it. A migration-time lint that runs `grep -rn "from('<table>')" supabase/functions/` against every `DROP TABLE` in a migration would have caught this 3.5 months ago. Recommend a separate proposal: `scripts/check_drop_table_orphan_callers.sh` invoked from CI on migration files.

2. **`docs/system-map/tables.md:100` is stale.** It lists `messages` as `DORMANT (empty, has producer)`. The table doesn't exist; it's not dormant. Phase B should update this table-map line as part of B1's housekeeping, OR (cleaner) defer to a separate doc-drift sweep. Single-line edit.

---

## File references (absolute paths)

- `/Users/jameschellis/jac-agent-os/supabase/functions/calculate-importance/index.ts` — the writer (lines 75, 135 are the dead `from('messages')` calls; lines 70 and 133 are the `if (messageId)` guards)
- `/Users/jameschellis/jac-agent-os/supabase/functions/smart-save/index.ts` — the only live caller (lines 218, 496 — neither passes `messageId`)
- `/Users/jameschellis/jac-agent-os/supabase/migrations/20251122051423_2f79ce4f-655a-49a1-993a-2ae696cd9a60.sql` — original CREATE TABLE messages
- `/Users/jameschellis/jac-agent-os/supabase/migrations/20260123024012_8af6c983-41da-49e7-a948-e31b48d4f4ae.sql` — DROP TABLE messages CASCADE (architecture-pivot statement)
- `/Users/jameschellis/jac-agent-os/supabase/migrations/20251122000000_bootstrap_profiles.sql` — `message_role` ENUM definition (still extant; harmless orphan type)
- `/Users/jameschellis/jac-agent-os/scripts/check_supabase_table_refs.sh` — the B4 CI grep that surfaced this
- `/Users/jameschellis/jac-agent-os/scripts/check_supabase_table_refs.allowlist` — current allowlist (lines 15-20 = the entry to remove in B2)
- `/Users/jameschellis/jac-agent-os/docs/audit/2026-05-05-distill-principles-silent-noop-phase-a.md` — sibling audit, structural template
- `/Users/jameschellis/jac-agent-os/docs/system-map/tables.md` (line 100) — stale entry to update
- `/Users/jameschellis/jac-agent-os/docs/system-map/edge-functions.md` (line 27) — stale "writes: messages" entry to update
- `/Users/jameschellis/jac-agent-os/CLAUDE.md` (lines 388, 487) — references to `calculate-importance` (no edits needed; descriptions remain accurate post-B1)
