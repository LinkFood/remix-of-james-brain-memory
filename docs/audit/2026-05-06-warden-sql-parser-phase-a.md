# Phase A — Warden SQL Parser Comment-Aware Semicolon Check

**Status:** Queued (paste-ready). Diagnose-only Phase A. Phase B (structural fix) ships only with explicit per-PR approval per audit-first-discipline-default.

**Trigger:** PR #44 B-4 brain_consumer_freshness_rth invariant errored on first warden run because `query_sql` contained inline-comment semicolons (`-- periodic; some gaps OK`). PR #46 hotfixed by stripping semicolons from comments — instance-level patch. The class-level fix is to make `run_invariant_query` comment-aware before the mid-query-semicolon check.

**Class:** silent-failure-from-overly-narrow-parser. Same shape as the original SELECT-only-guard whitespace bug (caught at warden first run; codified in `20260501061000_warden_seed_fixups.sql` line 6-13). Sibling instance.

---

## Phase A scope (diagnose-only)

### Step 1 — Verify-the-warden's-own-framing

a) **Confirm the parser bug class is empirically real.** Read `supabase/migrations/20260501061000_warden_seed_fixups.sql:29-61` (`run_invariant_query`). Confirm:
   - Line 44 normalizes whitespace via `regexp_replace`
   - Line 51 does `v_normalized LIKE '%;%'` semicolon-position check
   - **No comment-stripping step between**

b) **Reproduce the failure mode.** Synthesize a minimal invariant SQL:
   ```sql
   SELECT 1::numeric AS metric_value, 'comment ; here' AS message
   -- comment with ; semicolon
   ```
   Pass to `run_invariant_query`. Verify it raises `invariant queries must be a single statement (no mid-query semicolon)` even though the semicolon is in a comment.

c) **Confirm impact scope.** Query `ct_invariants` for any rows whose `query_sql` contains both `--` (or `/*`) and `;` patterns. Count affected rows. Verify whether any are currently in error state due to this class.

### Step 2 — Decompose comment-aware fix shape

Three implementation paths to evaluate:

**Path A — Pre-strip comments.** Before line 44 normalization, run two regex strips:
```sql
-- Strip line comments: -- to end of line
v_stripped := regexp_replace(p_sql, '--[^\n]*', '', 'g');
-- Strip block comments: /* ... */ (non-greedy, multi-line)
v_stripped := regexp_replace(v_stripped, '/\*.*?\*/', '', 'gs');
```
Then proceed with `v_normalized := regexp_replace(lower(btrim(v_stripped)), '\s+', ' ', 'g')`.

**Pros:** Targeted. Doesn't change SELECT-only guard or DML-keyword check semantics. Transparent.
**Cons:** If a query author embeds `--` inside a string literal, the regex strips it. Trade-off: rare in invariant queries (string literals usually don't contain `--`).

**Path B — Smart parser with string-literal awareness.** Use a state-machine that tracks `'...'` and `$$...$$` and `"..."` regions to skip comment patterns inside literals.

**Pros:** Strictly correct.
**Cons:** Substantially more code in plpgsql; harder to maintain; overkill for the read-only invariant query surface.

**Path C — Document the limitation, keep the simple parser.** Update `query_sql` author guidance to "no semicolons in comments" — i.e. continue PR #46's pattern as policy.

**Pros:** Zero code change.
**Cons:** Class-level repeat risk. Future invariant author hits the same wall.

### Step 3 — Decision criteria for Path selection

- **Frequency of comment-with-semicolon authoring:** if rare (1 in 27 today), Path C is acceptable. If common, Path A or B.
- **Cost of false-positive parser rejection:** invariant goes into error state, warden Slacks, Phase A burns ~30 min. Path A pays this off after ~3 instances.
- **String-literal collision risk:** invariant SQL almost never embeds `--` in literals. Path A's edge case is theoretical, not empirical.

**Recommendation pre-Phase B:** Path A. Lowest-friction class-kill. Path B is over-engineering for a read-only single-statement query surface.

---

## Phase B (structural fix, requires per-PR approval per audit-first-discipline-default)

If Phase A clears with Path A picked:

1. New migration `20260506XXXXXX_warden_sql_comment_aware_parser.sql` adding pre-strip step to `run_invariant_query` via `CREATE OR REPLACE FUNCTION` (per `feedback_create_or_replace_overload_orphan.md` — signature unchanged so no overload-orphan risk).
2. Test: synthesize the comment-with-semicolon invariant from Step 1b, call `run_invariant_query`, verify it executes (not raises).
3. Test: synthesize a real mid-query semicolon (`SELECT 1::numeric, 'foo'; SELECT 2`), verify it still raises.
4. Pair-ship: revert PR #46's comment-stripping in B-4 invariant (no longer needed). Re-stamp the comment with semicolons. Verify warden still passes.

**Acceptance:** B-4 invariant survives one warden cycle with original (pre-#46) comment text restored.

---

## Constraints

- **PR-only on `supabase/migrations/`** for Phase B
- **Diagnose-only Phase A** — Phase B requires per-PR approval per `feedback_audit_first_discipline_default.md`
- **CREATE OR REPLACE same signature** to avoid overload-orphan class (per `feedback_create_or_replace_overload_orphan.md`)
- **No destructive schema changes.** Function body change only.

---

## Cross-references

- Sibling instance: `20260501061000_warden_seed_fixups.sql` (whitespace-narrow SELECT guard)
- Today's hotfix: PR #46 (comment-semicolon strip on B-4 invariant only)
- Class-kill discipline: `feedback_warden_threshold_calibration.md` (related warden parser class)
- Methodology pattern: `docs/methodology-patterns.md` runbook (post-class-kill-D) — Phase A applies
