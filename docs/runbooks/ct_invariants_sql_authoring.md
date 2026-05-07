# Authoring `ct_invariants.query_sql` — what to avoid

**Companion to:** `docs/audit/2026-05-08-pr54-path-b-vs-c.md` (Path C decision)
**Cross-ref memory:** `feedback_warden_parser_semicolon_blind.md` (cascade catalog instance #41)
**Why this exists:** the warden's `run_invariant_query` validates submitted SQL with
string-pattern matching (LIKE + `position()`), not a real parser. Patterns that look
fine to a human but resemble multi-statement SQL trip the guard. PR #46 hotfix removed
the comment-induced semicolons in B-4; the parser remains naive.

## TL;DR — the one rule that bites repeatedly

**Zero `;` characters anywhere in `query_sql`, including inside string literals,
identifier quotes, and comment bodies.** The parser is byte-level — it doesn't
distinguish a syntactic statement-terminator from a literal character inside `'...'`
or `"..."`. If your `message` text needs a semicolon for readability, use
` — `, `,`, ` - `, or `chr(59)` instead.

This rule has bitten on shipped invariants. See "Real failure modes" below.

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

## Real failure modes — concrete examples

### Example #1 (instance #41, 2026-05-07): semicolon in message string literal

**What broke:** Two `consumer_freshness_*_24x7` invariants
(`tape_reader`, `watcher`) errored on first warden tick with
`invariant queries must be a single statement (no mid-query semicolon)`.

**Why:** the message body had a semicolon between two info fragments:

```sql
'[ct-tape-reader] phase=' || phase.p || ' pass; last_write=' || COALESCE(...)
                                              ^
                                       this `;` tripped the guard
```

The author (me) had read the table above mentally as "no `;` in SQL syntax,"
not as "no `;` *byte* in the entire query string." The other 7 invariants
in the same migration used ` — ` separators in their messages and ran clean.

**Hotfix:** commit `c9c4bc4` — replaced `;` → ` —`:

```sql
'[ct-tape-reader] phase=' || phase.p || ' pass — last_write=' || COALESCE(...)
```

**Lesson:** treat the rule as byte-level. Grep your `query_sql` literal
for `;` after composing — it should match either zero times or exactly
once at the very end (the optional terminal semicolon). Anything else
will trip the guard.

**Detection latency:** caught on first warden tick post-deploy (~30 min).
Acceptable; could be earlier with the deferred pre-commit hook.

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

Empirical anchor: 14 parser rejections / 7,715 runs / 5 warden-days at PR #54 close /
**0 steady-state fires post-hotfix** through 2026-05-07.

**Update 2026-05-07:** +2 rejections during Class-kill C Phase B ship
(`consumer_freshness_tape_reader_24x7`, `consumer_freshness_watcher_24x7`) — both on
*newly-authored* invariants, not previously-running ones. Per the trigger criteria,
this is **author-discipline scope**, not parser scope: the rule was already documented
on line 15's table; the failure was authoring-time miss, not coverage gap. Does not
trigger Path B re-open. Cumulative: 16 rejections / ~10 warden-days / 54 invariants —
still well below the 1/month-on-stable-invariants and 100-invariants triggers.

Re-run the audit after another 30 days. If a third 2026-05-Q2 ship surfaces a
literal-semicolon miss, consider whether the rule needs a structural enforcement
(pre-commit hook or migration-time CI lint regex) rather than further runbook
prominence.
