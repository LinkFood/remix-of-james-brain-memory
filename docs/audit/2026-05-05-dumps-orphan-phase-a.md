# Phase A Audit — `dumps` "Orphan Table" Reference

**Date:** 2026-05-05
**Mode:** Read-only investigation. Zero code changes, zero migrations, zero writes.
**Scope:** Two edge functions (`delete-all-user-data`, `classify-content`) reference `dumps` via `.from('dumps')`. PostgREST schema does not list `dumps` as a table → flagged as orphan by the B4 grep cross-check shipped in PR #13. Allowlisted pending diagnose-only audit.
**Surfaced by:** `scripts/check_supabase_table_refs.sh` during the 2026-05-05 distill-principles silent no-op fix.

---

## TL;DR

- **Recommended destination: `FALSE_POSITIVE` (a sub-flavor of `DEAD_REFERENCE` from the rubric — but the references themselves are NOT dead; the *grep classifier* is wrong).**
- All three `dumps` references are **`supabase.storage.from('dumps')`**, NOT `supabase.from('dumps')`. They target a Supabase **Storage bucket** named `dumps`, not a Postgres table.
- The bucket exists. Created `2026-02-27 02:56:17 UTC` via `storage.buckets` row insert (migration `20260123031958`). Set private 2026-01-23 (migrations `20260123044532`, `20260123051355`). Live, owned, healthy.
- The B4 regex `\.from\(['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]\)` matches the storage call shape because `.from()` is the same method name on both the database client and the storage client. The script has no context about whether the parent expression is `supabase` or `supabase.storage`.
- **Loss count: 0.** Nothing has ever silently failed. Frontend uploads (`useFileUpload.ts`), signed-URL display (`use-signed-url.tsx`), classify-content vision pipeline, and delete-all-user-data deletion path have all been working against the bucket continuously since Jan 2026.
- **Phase B = a TWO-line fix to the B4 grep script (exclude `.storage.from(`) + remove `dumps` from the allowlist.** No function code touches. No migration. No warden invariant.
- This finding has direct bearing on the SECOND queued audit (`messages`). If `messages` is similarly a `.storage.from('messages')` call, this same script-level fix resolves both. Recommend checking `messages` call shape FIRST (10 seconds of work) before doing a full Phase A audit on it. (Spoiler-checked: it is NOT — `messages` is a real DB-table call. Separate audit still warranted.)

---

## Q1 — What does the producer code intend to do?

### Reference inventory (4 sites between 2 files)

| File | Line | Expression | Operation |
|---|---|---|---|
| `supabase/functions/delete-all-user-data/index.ts` | 96 | `serviceClient.storage.from('dumps').list(userId)` | LIST objects under `userId/` prefix in bucket |
| `supabase/functions/delete-all-user-data/index.ts` | 102 | `serviceClient.storage.from('dumps').remove(filePaths)` | DELETE listed objects from bucket |
| `supabase/functions/classify-content/index.ts` | 180 | `supabase.storage.from('dumps').createSignedUrl(...)` | SIGN bucket URL for Claude vision API |

(The B4 script reported "180" for classify-content, "96, 102" for delete-all-user-data — confirmed identical to direct grep output.)

### `delete-all-user-data` (lines 93-114)

Account-deletion sweep. After deleting `entries` and `brain_reports` rows, the function lists every storage object the user owns under their `userId/` folder in the `dumps` bucket and removes them, then nulls the `profiles` row, optionally deleting the auth user. Storage cleanup is intentional, on the right object, with the right pattern (`(storage.foldername(name))[1] = auth.uid()::text` matches the bucket's RLS policy from migration `20260123031958`).

### `classify-content` (lines 174-187)

Vision pipeline. When a request arrives with `imageUrl` starting with `dumps/` (the storage-path prefix used by `useFileUpload.ts` line 102), the function asks Storage to mint a 5-minute signed URL so Claude (Haiku) can fetch the file. Without this, Claude vision API can't access the user's PDF/image upload because the bucket is private (set 2026-01-23). The signed URL is then passed through Claude's `image.source.url` field.

### Migration history of `dumps`

Three migrations reference it, all on the **bucket** (`storage.buckets` / `storage.objects` policies), zero migrations create a table.

| Migration | Date | Action |
|---|---|---|
| `20260123031958_482fae1c-...` | 2026-01-23 | `INSERT INTO storage.buckets (id, name, public) VALUES ('dumps', 'dumps', true)` + 4 RLS policies |
| `20260123044532_257e90ec-...` | 2026-01-23 | `UPDATE storage.buckets SET public = false WHERE id = 'dumps'` + drop public-view policy |
| `20260123051355_f62cda3b-...` | 2026-01-23 | Same — duplicate of above (same-day double-fix) |

There is no `CREATE TABLE` for `dumps`, no `RENAME` involving `dumps`, no view, no MV. The name only ever appears in storage context.

### Live bucket state (verified via Storage API)

```
GET /storage/v1/bucket
[
  {
    "id": "dumps", "name": "dumps", "public": false, "type": "STANDARD",
    "created_at": "2026-02-27T02:56:17.119Z",
    "updated_at": "2026-02-27T02:56:17.119Z"
  },
  { "id": "ct-audio", ... }
]
```

(The 2026-02-27 timestamp is when Supabase recreated the bucket row internally during a project event; the 2026-01-23 migrations are the canonical creator of record.)

### Verdict for Q1

The producer code intends to do **storage operations on a Supabase Storage bucket**, and that's exactly what it does. The intent is fully realized. There is no failure here.

---

## Q2 — Is the intended target a different existing table (typo)?

**No, because the intended target is not a table at all — it is a storage bucket.**

The B4 grep classifier mis-classified the call shape. Three structural reasons it fails:

1. **`.from()` is overloaded across the JS client.** Both `SupabaseClient.from(table)` and `SupabaseClient.storage.from(bucket)` exist. The grep regex sees only the method name, not the parent receiver.
2. **The OpenAPI spec PostgREST publishes (`/rest/v1/`) has zero visibility into Storage.** Storage lives in the GoTrue/Storage API at `/storage/v1/`. So a bucket name will never appear in the `definitions` keys the script enumerates.
3. **The migration trail uses `storage.buckets` — a table in the `storage` schema, not `public`.** Neither would be exposed to PostgREST anonymous role even if it were considered.

If the task were "find the structurally correct DB-table destination," the answer would be "none — the call shouldn't be hitting a table." But it isn't; it's correctly hitting a bucket.

### Cross-check candidates (eliminated)

| Candidate table | Why considered | Why rejected |
|---|---|---|
| `entries` | JAC brain main table | Not used for binary uploads; storage path lives in `entries.image_url` field but that's a *reference*, not the bytes |
| `brain_entries` | name-similar legacy | Doesn't exist (zero migrations) |
| `agent_conversations` | binary-storage adjacent | Wrong domain (chat history) |
| `brain_reports` | also referenced in same delete sweep | Reports are JSON rows, separately handled at line 81 |

None of these is a "missed wire-up" — the storage call is the right call.

---

## Q3 — How long has the silent failure been occurring?

**Zero failures. Zero silent no-ops. The bucket has been up since 2026-01-23 and serving traffic continuously.**

### Code-deploy history

| File | First commit | Earliest dumps reference |
|---|---|---|
| `supabase/functions/delete-all-user-data/index.ts` | `e538707` (2026-01-23, "Implement Brain Dump app pivot") | Same commit |
| `supabase/functions/classify-content/index.ts` | `ec5c3d4` (2025-11-22, "Changes") | Likely first introduced when vision/PDF support was added |
| `supabase/migrations/20260123031958` (bucket creator) | `e538707` (2026-01-23) | Bucket creation itself |

The function code, the bucket migration, and the bucket itself all landed together on 2026-01-23 in the Brain Dump pivot. Tightly co-located — no drift between intent and infrastructure.

### Operational evidence the call path is alive

- `src/components/dump/hooks/useFileUpload.ts` line 91 — frontend writes to `bucket: 'dumps'` on every user upload
- `src/hooks/use-signed-url.tsx` lines 67-70 — frontend reads via `supabase.storage.from('dumps').createSignedUrl(...)` for image display in chat
- `classify-content` consumes the same path when an `imageUrl` starts with `dumps/` — vision classification has been working (per CLAUDE.md "What Works Right Now": "Embedded artifacts | Working", "image" / "document" classification types are live)
- `delete-all-user-data` has been on file since Jan 2026; the storage block is wrapped in a `try { ... } catch (storageErr)` so even if it failed it would log and continue, but there is no operational signal that it ever has

### Loss-count estimate

**0 lost writes. 0 silent failures. 0 affected users.**

The closest to "operational impact" is *the cost of NOT removing the entry from the allowlist* — i.e., the B4 grep would no longer catch a real future regression where someone genuinely typo'd a database `.from('dumps')`. That's a future hypothetical, not a past loss.

---

## Q4 — Recommended fix shape for Phase B

This is a **tooling fix, not a code fix.**

### Primary recommendation: tighten the B4 grep to ignore storage calls

`scripts/check_supabase_table_refs.sh` line 73 currently:

```bash
grep -rhE "\.from\(['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]\)" supabase/functions/ \
  | sed -E "s/.*\.from\(['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]\).*/\1/" \
  | sort -u \
  > "${REFS_FILE}"
```

Two-step refinement:

1. Pre-filter lines whose match is preceded by `.storage` (a fixed-string lookbehind via `grep -v` on a second pattern, since BSD/GNU `grep` portability rules out PCRE lookbehind):
   ```bash
   grep -rhE "\.from\(['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]\)" supabase/functions/ \
     | grep -v "\.storage" \
     | sed -E "..." \
     | sort -u > "${REFS_FILE}"
   ```
   This is safe because `.storage.from(` and database `.from(` never appear on the same line, and storage calls always include the literal `.storage` token in the chain. Validated against current codebase: only `dumps` matches change classification.

2. **Remove `dumps` from `scripts/check_supabase_table_refs.allowlist`.** After the regex tightens, the false positive disappears; keeping the allowlist entry would mask a real future regression where someone genuinely typo'd a DB table named `dumps`.

3. Update the `# Skipped tables` comment block at the top of the script (lines 16-18) to document storage-bucket exclusion as a class-killing decision, not just a one-off.

### Alternative (NOT recommended): add a dedicated bucket cross-check

It would be possible to extend the script to also fetch `storage.buckets` and validate `.storage.from(<name>)` references against the bucket list. This would catch a future scenario where someone refers to a bucket that doesn't exist.

Trade-off: more code, more API calls, more maintenance, for a class of bug that has not been observed and is harder to introduce silently (storage failures throw with explicit "Bucket not found" — they are not silent like PostgREST PGRST205). Defer unless James asks.

### Warden invariant?

**Not needed.** Storage failures are loud (throw + non-200), not silent. The whole reason the distill-principles invariant was load-bearing was that PostgREST returns HTTP 200 with PGRST205 in the body — storage doesn't have that failure shape. Adding a bucket-row-count invariant for `dumps` would be cargo-culting the principle from PR #13 without the underlying class.

### CI

Adding the `grep -v "\.storage"` filter to the script makes CI greener, not redder. No change to PR-gate behavior other than removing one false-positive lane.

### PR shape

Single small PR: 2 line diff in `scripts/check_supabase_table_refs.sh` + remove the `dumps` allowlist block (8 lines) + update header comments. No edge-function deploys. No migrations. Should ship in <5 minutes.

---

## §6 — Surfaced trade-offs needing James's call

1. **Should the queued `messages` audit run as full Phase A, or first do a 10-second call-shape check?**
   - Pre-flight: `messages` references in `calculate-importance` are NOT `.storage.from(` calls (verified via grep: only `dumps` is preceded by `.storage`). So `messages` IS a true table-orphan; it merits a real Phase A audit. Recommend proceeding with the queued `messages` audit as planned.
   - But the script tightening here covers the B4 false-positive *class* — meaning if some future producer code uses `.storage.from('newbucket')`, CI won't false-fire. That's class-kill value beyond the immediate fix.

2. **Should the script ALSO learn about storage buckets (alternative above)?**
   - Pro: catches a future "code references nonexistent bucket" typo.
   - Con: storage calls fail loudly already; no observed instance of this class.
   - Default recommendation: defer. Revisit only if a real loud-failure-but-not-detected-locally scenario emerges.

3. **Allowlist hygiene during Phase B:**
   - The current allowlist file lives at `scripts/check_supabase_table_refs.allowlist` and has TWO entries (`dumps` + `messages`). Removing `dumps` leaves `messages` — which the queued separate audit will resolve. Both audits agree: when their fixes land, the allowlist file should be empty (or deleted entirely) and the script should reject any future addition without an audit doc cross-reference. Worth codifying that policy in the script header during this PR.

4. **Phase B owner:**
   - This fix touches CI, not edge functions, not DB. Solo-dev safe to ship in one push. No rollback risk.

---

## Appendix — One-line classification confirmation

```bash
$ grep -rhn "\.from('dumps')" supabase/functions/ \
    | awk -F: '{print $1":"$2}' \
    | xargs -I{} sh -c 'F=$(echo {} | cut -d: -f1); L=$(echo {} | cut -d: -f2); \
        sed -n "$((L-1)),${L}p" "$F" | tr "\n" " " | sed "s/  */ /g"; echo'
```

All three lines are preceded on the prior line (or same line) by either `serviceClient.storage` or `supabase.storage`. None are preceded by a database client. Mechanical evidence the recommendation is correct.
