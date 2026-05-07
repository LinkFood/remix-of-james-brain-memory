# Authoring `ct_invariants.query_sql` — what to avoid

**Companion to:** `docs/audit/2026-05-08-pr54-path-b-vs-c.md` (Path C decision)
**Why this exists:** the warden's `run_invariant_query` validates submitted SQL with
string-pattern matching (LIKE + `position()`), not a real parser. Patterns that look
fine to a human but resemble multi-statement SQL trip the guard. PR #46 hotfix removed
the comment-induced semicolons in B-4; the parser remains naive.

## Patterns to avoid in `query_sql`

| Pattern | Why it fails |
|---|---|
| Inline comments (`-- ...` mid-statement) | Comment text containing `;` defeats "single statement" guard; even comment-induced whitespace can mislead future tightening. |
| Block comments (`/* ... */`) inside the body | Same class — guard does not skip comment bodies. |
| String literals containing `;` or `--` | Guard looks for `;` and forbidden keywords by substring; literal contents are scanned. |
| Double-quoted identifiers containing `--` or `;` | Same substring-scan issue; identifier quoting is not honored. |
| Anything but a single `SELECT` (or `WITH ... SELECT`) | Guard requires query to start with `select` / `with` after `btrim(lower())` and forbids non-trailing `;`. |

## Safe template

```sql
SELECT
  count(*)::numeric AS metric_value,
  format('%s rows in last hour', count(*)) AS message
FROM public.some_table
WHERE created_at > now() - interval '1 hour';
```

Single SELECT. No comments. Optional terminal `;`. Always returns one row with
`(metric_value numeric, message text)`.

## Optional pre-commit hook — deferred

A regex check on staged `ct_invariants` migration files (~30 LOC) was scoped, but the
repo has no husky/lefthook/`.git/hooks/pre-commit` infra today. Per YAGNI, hook is
deferred — adding hook infra to enforce a <1/month failure mode is heavier than the
failure it prevents. Reintroduce alongside Path B if the trigger criteria below activate.

## Re-open Path B (real state-machine parser) if any of these become true

Verbatim from `docs/audit/2026-05-08-pr54-path-b-vs-c.md` § "What would change the decision":

- **Firing frequency rises above 1 event/month** in steady state — parser rejections
  occurring on invariants that have *previously run cleanly*, indicating a query-pattern
  not covered by author discipline.
- **`ct_invariants` count exceeds ~100** — author-discipline breaks down at scale, and
  the vulnerability surface grows linearly.
- **Warden gains a SQL feature that requires comments in queries** (e.g. dialect-specific
  hint pragmas, dynamic SQL templates with `--noqa`-style markers).
- **A single parser rejection ships an invariant warn-stuck for >24h** — current
  self-heal loop is <1h; if the loop ever lengthens, structural enforcement becomes
  worth Path B's cost.

Empirical anchor: 14 parser rejections / 7,715 runs / 5 warden-days / **0 steady-state
fires post-hotfix**. Re-run the audit after another 30 days.
