# Phase A — `brain_telemetry_real_errors_24h` warden critical, diagnose-only

**Date:** 2026-05-06 (Wed, ~07:00 ET pre-bell, T-2:30 to RTH open)
**Trigger:** Warden critical `brain_telemetry_real_errors_24h = 52`, 30 consecutive fails, last_run_at 10:30 UTC.
**Scope discipline:** Phase A diagnose-only. No fixes, no patches, no schema changes inside this round. Class-kill candidates flagged for explicit per-PR approval before Phase B.
**Time budget:** target findings before 9:00 ET (13:00 UTC) for pre-bell buffer.

---

## TL;DR

The warden's own query is **correct on its face** — it precisely returns what its description says. But the 52 rows it surfaces are **not genuine errors**. They are intentional `cache_hit:fresh_<sec>s` annotations that cotrader-mcp v1.1 (PR #10, merged 2026-05-05T21:30Z, code at `mcp/cotrader/tools/get_co_trader_context.ts:133` and `mcp/cotrader/lib/organ_cache.ts:21`) writes into the `error` column of `ct_brain_telemetry` to keep cache activity visible to the warden + `get_brain_health`. The warden filter excludes `warning:%` and `skipped:%` prefixes but **not** `cache_hit:%`, so every cache hit increments the "real errors" count.

**Class:** same family as LB8 timezone-bucketing and Pulse DORMANT-via-grep — query is internally correct; the underlying truth (what the field semantically means) is what shifted out from under it. **Audit-can-have-false-premises** verified: the warden was mid-correct and signaling on a state-change, but the state change is benign.

**D2 acceptance gate (#4):** **NOT confounded.** Zero rows in the error population come from real specialist edge functions. D2's 10:30 ET measurement is clean to proceed.

**GOOGL/AMZN/META silence (#5):** **No information here.** Population is 100% NVDA. These 52 rows tell us nothing about the queued GOOGL/AMZN/META audit.

---

## §1 — Verify the warden's own framing

Pulled `ct_invariants` row directly:

```sql
SELECT count(*)::numeric AS metric_value
FROM ct_brain_telemetry
WHERE created_at > now() - interval '24 hours'
  AND error IS NOT NULL
  AND error NOT LIKE 'warning:%'
  AND error NOT LIKE 'skipped:%'
```

`expected_max: 5`, `severity: critical`, `runbook_path: docs/SYNTHESIS_LAYER.md`.

Replicated against PostgREST:
- `error IS NOT NULL` last 24h → **1807 rows** (Range header)
- adding `NOT LIKE 'warning:%' AND NOT LIKE 'skipped:%'` → **52 rows** (Range header)

The 52 count **is real** under the warden's stated semantics. No methodology artifact. No timezone bug. No 1000-row PostgREST cap interference (count=exact returned 52 on the filtered query directly).

**The framing problem is one layer up.** The warden invariant treats "error column non-null and not prefixed warning:/skipped:" as "real error." That equivalence held at deploy time. It no longer holds: cotrader-mcp v1.1 introduced a third intentional non-error use of the column.

**Class:** **brief-author-premise-error / methodology-errors-cascade** — the warden's premise ("error column carries only error or warning/skipped") was true when the invariant was authored and stopped being true when v1.1 shipped without updating the filter. Same shape as the prior 8 instances in this pattern catalog.

---

## §2 — Bucketing the 52 errors

Pulled all 52 rows with full fields. Sources: `/tmp/real_errs.json` (size 52, no truncation — `count=exact` confirms 52).

### Axis 1 — `consumer_name`

| count | consumer_name |
|---:|---|
| 52 | `cotrader-mcp` |

**100% from the new MCP.** No other consumer contributes.

### Axis 2 — `helper_name` (organ)

| count | organ |
|---:|---|
| 16 | `specialist_recall` |
| 12 | `regime` |
| 8 | `analogs` |
| 8 | `james_flags` |
| 8 | `event_recency` |

These are exactly the 5 organs marked `STABLE_ORGANS` in `mcp/cotrader/lib/organ_cache.ts:28-34`. No volatile-organ rows (flow_heatmap, pulse, detector, tape, news_causality, specialist) appear — by design (volatiles are never cached, so never emit a cache-hit row).

### Axis 3 — `audience`

| count | audience |
|---:|---|
| 52 | `cotrader` |

Hardcoded in `get_co_trader_context.ts:127`. No variation possible from this code path.

### Axis 4 — `ticker_focus`

| count | ticker |
|---:|---|
| 52 | `NVDA` |

100% NVDA. Whoever was using the MCP yesterday was testing/querying NVDA exclusively.

### Axis 5 — error class (full string distribution)

| count | error string |
|---:|---|
| 52 | `cache_hit:fresh_0s` |

**100% identical string.** Every emission is `0s` because the cache TTL is 5 min and consecutive same-tool calls keep the entry warm — `ageSec` from the cache helper rounds to 0 when calls are within ~500ms.

This is **not** a timeout, null deref, schema error, missing-row, RPC fail, or any genuine error class. It is a **cache-hit notification miscategorized into the error column**.

### Cross-axis breakdown

`(consumer, organ, ticker)`:

| count | consumer | organ | ticker |
|---:|---|---|---|
| 16 | cotrader-mcp | specialist_recall | NVDA |
| 12 | cotrader-mcp | regime | NVDA |
| 8 | cotrader-mcp | analogs | NVDA |
| 8 | cotrader-mcp | james_flags | NVDA |
| 8 | cotrader-mcp | event_recency | NVDA |

### First-occurrence + temporal distribution

```
2026-05-05T19:50  n=13   (first row 19:59:54Z)
2026-05-05T21:40  n=26
2026-05-05T22:00  n=13   (last row 22:08:35Z)
```

**Window: 2026-05-05T19:59:54Z → 2026-05-05T22:08:35Z (~2h08m).** No new rows today. The count stays at 52 because the rolling 24h window still contains all yesterday's rows; it will start decaying past 19:59Z today.

### `cache_hit` BOOLEAN column cross-check

All 52 rows have `cache_hit = true`. The structured boolean column **already** marks these as cache hits. The string in `error` is redundant with the column. (See §3 — the design rationale is to keep the warden surfacing them; without the string, the warden's helpers wouldn't notice cache activity. The warden, however, was never updated to read `cache_hit = true` either.)

---

## §3 — Temporal correlation against yesterday's late-RTH ship window

`gh pr list` for merges since 2026-05-05T18:00Z, sorted ascending:

| PR | merged (UTC) | title |
|---:|---|---|
| #10 | 21:30:51 | feat(mcp): cotrader v1.1 — three additive levers (8.4× faster cold path) |
| #11 | 22:24:23 | feat(mcp): cotrader v2 Tier 1 — 5 new read-only tools (44/44 smoke) |
| #12 | 22:26:01 | audit: distill-principles silent no-op |
| #13 | 22:26:04 | fix(jac): distill-principles silent no-op — redirect to jac_principles + class-kill CI |
| #14 | 22:26:26 | audit: NVDA no_events upstream cause — regime drift not bug |
| #15 | 23:29:10 | audit: D1 NVDA no_events class kill — WRONG_FRAME |
| #16 | 23:46:48 | audit: D2 Phase A — regime threshold recalibration |
| #17 | 23:56:14 | feat(specialist): D2 Phase B — regime threshold recalibration + warden class kill |

**The temporal correlation is with PR #10 (cotrader-mcp v1.1) — confirmed, not coincidental.**

Specific commit: **`b185f98`** — "feat(mcp): cotrader v1.1 — three additive levers (8.4× faster)". Authored 2026-05-05T20:01:31Z. The first cache_hit row at 19:59:54Z is **1m37s before the commit timestamp** — explainable by a local smoke run during dev (the MCP, run locally with the service-role key, writes into prod `ct_brain_telemetry`). The 21:40 and 22:00 buckets line up with post-merge usage.

**The B4 jac_principles rename / distill-principles fix (#12, #13) is NOT a contributor.** That code path does not write to `ct_brain_telemetry`. It is coincident in the merge window only — pre-flagged correctly as hypothesis-to-verify; verification result is **negative**.

**D2 Phase B (#17) is NOT a contributor either.** Merged 23:56Z; first cache_hit row preceded it by 4 hours.

### The actual code path

`mcp/cotrader/tools/get_co_trader_context.ts:117-138`:

```typescript
async function emitCacheHitTelemetry(
  supabase: SupabaseClient,
  args: { organ: string; ticker: string; ageSec: number; ttlSec: number },
): Promise<void> {
  // Same shape as the rows buildClaudeContext writes per organ outcome.
  // The `error` field carries the cache_hit signal — warden + get_brain_health
  // can filter on it. Option A per James 2026-05-05.
  try {
    await supabase.from('ct_brain_telemetry').insert({
      helper_name: args.organ,
      audience: 'cotrader',
      ticker_focus: args.ticker,
      consumer_name: CONSUMER_NAME,
      latency_ms: 0,
      output_size_bytes: 0,
      cache_hit: true,
      error: `cache_hit:fresh_${args.ageSec}s`,
    });
  } catch (_e) { }
}
```

`mcp/cotrader/lib/organ_cache.ts:20-22` documents the design intent:

```
On cache hit, the MCP emits a telemetry row tagged
`error='cache_hit:fresh_<sec>s'` so the warden + get_brain_health stay
populated (Option A per James 2026-05-05). Preserves supervisor visibility.
```

The "Option A" decision picked the trade *visibility-via-string-tag*. The complementary half — **updating the warden filter to exclude the new prefix** — was not executed in v1.1.

---

## §4 — D2 acceptance gate: are specialists in the error population?

**Answer: NO. D2 is NOT confounded.**

- Population is 100% `cotrader-mcp` consumer.
- Real specialist edge functions write under consumer names `ct-specialist-<ticker>` and `ct-specialist-<ticker>/peers`. **Zero of these appear in the 52-row error population.**
- Independent triangulation: the broader 24h telemetry sample (1000-row PostgREST page) shows real specialist consumers firing nominally — `ct-specialist-{iwm,qqq,spy,tsla,meta,amzn}` each at 11 rows in the visible window, peers variants symmetric. None of those rows carry `error IS NOT NULL` filtered by the warden's predicate (or they'd be in the 52).
- The `helper_name = 'specialist_recall'` rows in the 52 are calls to the **specialist-recall organ** from cotrader-mcp's `buildClaudeContext` invocation. They do **not** represent specialist edge functions firing — they represent the synthesis layer reading specialist memory for a terminal-Claude session.

**D2 verification at 10:30 ET (14:30 UTC) can proceed unaffected.**

---

## §5 — GOOGL/AMZN/META silence cross-check

**Answer: No information in this population. Hypothesis neither confirmed nor refuted here.**

- All 52 rows have `ticker_focus = NVDA`. **0/52 GOOGL, 0/52 AMZN, 0/52 META.**
- The 52 rows are cache-hit annotations from one session of NVDA-focused MCP usage. They are silent on every other ticker, by construction.
- Incidentally observed in the 1000-row 24h sample: `ct-specialist-{amzn, meta}` are firing (11 rows each, peers variants symmetric). `ct-specialist-googl` is **absent** from the visible page; `ct-specialist-{aapl, msft, nvda}` are also absent. This is a different question than the original GOOGL/AMZN/META silence framing — and out-of-scope for this round. Pre-flag for the next per-ticker silence audit.

The hypothesis "MCP cache_hit emissions correlate with no_events rates" has **no support** in this data. Discard until a different population produces evidence.

---

## Class-kill candidates (require explicit per-PR approval before Phase B)

These are the structural fixes the diagnosis surfaces. **None ship in this round** without per-PR approval.

### Candidate A — extend warden filter to exclude `cache_hit:%`

**Shape:** one-line UPDATE on the `ct_invariants` row for `brain_telemetry_real_errors_24h`. Adds `AND error NOT LIKE 'cache_hit:%'` to the query.

**Pros:** matches existing pattern (warden already excludes `warning:%` and `skipped:%`); zero migration; reversible.

**Cons:** patches the symptom, not the root. Next time someone introduces a fourth annotation prefix (`info:`, `cache_set:`, etc.), the same class returns. **Decision-ritual gate: this is a patch, not a class kill.**

### Candidate B — stop writing cache annotations to the `error` column

**Shape:** drop the `error: \`cache_hit:fresh_${ageSec}s\`` line in `emitCacheHitTelemetry`. The structured `cache_hit: true` column already carries the boolean. If we want the age-in-seconds, add a dedicated nullable column `cache_age_sec INT` or write to a JSONB `meta` column.

**Pros:** **structural class kill.** The `error` column regains its semantic purity — null or genuine failure prefix only. Future warden/health probes that read `error` won't be polluted again.

**Cons:** requires a migration if we want to preserve cache_age visibility (or accept losing the age info — the boolean alone may suffice given the synthesis layer + `get_brain_health` already break out by `cache_hit`). Coordinated change to `get_brain_health` RPC if it currently grep's the string. Need to read `supabase/functions/_shared/claudeReadSurface.ts:2039,2055,2239,2254` (other call sites that already write `cache_hit` boolean correctly without the string) to confirm consistency.

**Decision-ritual gate: this is the class-kill.** "Does this make the failure class structurally impossible going forward?" — yes. The error column carries only errors. Annotations live in their own structured fields.

### Candidate C — new warden invariant on per-organ error rate

Out-of-scope for this audit; pre-flag if the team wants tighter observability after Candidate B lands.

---

## Recommendations for Phase B (per-PR review queue)

1. **First, decide A vs B** — patch the filter or kill the class. My read: **B**. The filter-extension is exactly the pattern that produced the bug in the first place (one-off prefix exclusions accreting), and `ct_brain_telemetry` already has the `cache_hit` boolean column doing the structured job.

2. **If B**: write the migration to add `cache_age_sec INT NULL`, drop the `error: 'cache_hit:...'` line, add a once-off `UPDATE ct_brain_telemetry SET error=NULL, cache_age_sec=...` to clean the historical 52 rows. Update `get_brain_health` RPC if it reads the string (verify first). Re-deploy any function importing `_shared/claudeReadSurface.ts` per the always-redeploy rule. Smoke test the MCP: cache hit no longer increments the warden critical.

3. **If A**: single ct_invariants UPDATE; warden goes green within 30 min. Document the pattern explicitly so future annotation prefixes get caught early.

4. **Independent of A/B**: queue a follow-up audit for the missing `ct-specialist-{aapl, msft, googl, nvda}` consumers in the 1000-row 24h sample — separate population, separate cause, requires its own Phase A.

---

## Methodology audit (self-check)

- ✅ Pulled raw rows directly, did not trust the warden's count alone.
- ✅ Cross-checked Range header on both filtered and unfiltered queries — confirms 1807 → 52 with no PostgREST cap interference.
- ✅ Verified the `error` string distribution is monolithic (52/52 identical) — not a mixed bag where some are real and some are cache_hit.
- ✅ Triangulated against actual code (read `get_co_trader_context.ts` and `organ_cache.ts`) rather than inferring intent from the data alone.
- ✅ Verified temporal claim against `git log` and `gh pr list` directly — temporal correlation with v1.1 ship is confirmed, NOT coincidental, NOT correlated with the B4/distill-principles batch.
- ✅ Stated explicitly when this population says nothing about adjacent questions (#5).
- ⚠️ Did NOT re-run the warden invariant SQL through a second path (e.g., a direct Supabase SQL editor query) — relied on PostgREST replication. PostgREST translates `not.like.warning:*` into the same `NOT LIKE 'warning:%'` predicate, so this is low risk, but flagging the methodological trade-off.

No empirical-cause claims made beyond what the data + code support. Hypothesis-to-verify items (B4 batch, GOOGL/AMZN/META) explicitly resolved with a yes/no rather than left ambiguous.
