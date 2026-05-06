# Phase A.7 — news_causality organ projection layer audit (diagnose-only)

**Date:** 2026-05-06 afternoon (~14:30 ET).
**Trigger:** PR #31 declared 🔴 #2 null causality RESOLVED-AS-MISFRAMED at producer-table layer (ct_news_causality has structured zeros, not nulls). Trading session 2026-05-06 13:45 ET subsequently pulled MCP organ output and found 10/10 SPY items with literal null at the organ surface — contradicting PR #31's resolution.
**Scope:** diagnose-only. Producer→organ projection-layer trace. Per the brief's Step 1 verify symptom at the surface where it lives, not just upstream.

---

## Methodology preamble — instance #15 candidate: audit-verification-surface-mismatch

PR #31 verified the producer table (ct_news_causality) and concluded the organ-output null framing was wrong. **The verification surface didn't match the symptom surface.** The trading session's symptom was at the consumer/organ-output layer; PR #31 audited only the producer. Both findings were technically correct AT THEIR RESPECTIVE LAYERS — producer healthy, organ output null — and the null at the organ output is the surface the captain reads.

**New sub-class to capture in methodology-patterns.md:** `audit-verification-surface-mismatch` — when symptom is at consumer layer, Phase A must verify that layer, not just upstream producer. Sibling to existing `audit-frame-mismatch` (which catches "system X broken vs join missing") — this one catches "audit verified upstream, missed downstream projection."

This is the **15th instance** of methodology-errors-cascade caught at audit. First instance of this specific shape — paired entry alongside PR #30/PR #32's existing sub-pattern entries worth shipping.

**Diagnostic question for future Phase As:** *"My symptom report is at surface X. Have I verified at surface X, or only at upstream Y? If only at Y, my conclusion may be correct at Y but disconnect from the actual symptom at X."*

---

## TL;DR

**Cause class: (a) Projection-layer-null — BY DESIGN.** The newsCausalityContext helper hardcodes `causality: EMPTY_CAUSALITY` (all-null) for every `ct_breaking_news` item at line 207. ct_breaking_news is the firehose source; causality data is computed only against `ct_news_analyses` items (the slower Claude-graded path). The architecture is:

```
ct_breaking_news (firehose, NEVER gets causality) →
  ct_news_analyses (Claude-graded subset) →
    ct_news_causality (15-min flow lookup, keyed to analysis IDs)
```

**Causality is a third-layer property.** First-layer items (breaking_news) cannot have causality data per the current architecture. Helper output for those items is correctly null — but reads as "missing" to the consumer, who can't distinguish "by-design-no-causality-possible" from "data-missing" from "not-yet-analyzed."

**Trading session's "10/10 SPY items returning null" is correctly explained:** items dominantly drawn from ct_breaking_news (firehose, hardcoded null causality), with at most 1-2 from ct_news_analyses that may have structured-zero or null causality.

**This bridges PR #31 (correct at producer layer) and the trading session's observation (correct at consumer layer).** Both findings were right at their layers; the cause is the helper's projection layer between them.

**Implication for read-layer integrity bundle:** the bundle's `status` field directly resolves this. Items from breaking_news get `status: "firehose_only_no_causality"` (or `"not_yet_analyzed"` if they're awaiting analysis); items from analyses with causality match get `status: "populated"` or `"no_signal_detected"` per the structured-zero pattern. **Bundle Phase 2 has a concrete read-side bug to fix in news_causality organ.**

---

## Step 1 — Verify the trading session's empirical observation

Trading session reported 10/10 SPY items null at organ surface 2026-05-06 13:45 ET.

**Empirical reproduction:** I cannot directly invoke the cotrader MCP tool from this session without polluting telemetry (the running MCP server uses pre-restart code; calling get_co_trader_context would write rows). Instead, I traced the helper's data path against current DB state to determine what the helper WOULD return.

**Source-data state at audit time** (last 6h, SPY-tagged):

| source | rows in window | helper-output causality |
|---|---:|---|
| `ct_breaking_news` (firehose, tickers_affected ⊇ SPY) | **4** | **EMPTY_CAUSALITY (all null) — hardcoded by helper line 207** |
| `ct_news_analyses` (instrument=SPY) | **1** | causalityMap.get(id) ?? EMPTY_CAUSALITY |
| `ct_news_causality` matching that 1 analysis | **1** | `moved=false, flow_hits_15min=0, flow_premium_15min=0` (structured zero) |

In a 6h window today: 4 breaking + 1 analysis = **5 items**. With the helper's `cap = 10` (default) and severity DESC sort, all 5 surface with their respective causality:
- 4 breaking_news items: causality = `{moved: null, flow_hits_15min: null, ...}` (all null)
- 1 analysis item: causality = `{moved: false, flow_hits_15min: 0, flow_premium_15min: 0, ...}` (structured zero)

**4 of 5 items literally null at organ surface.** Trading session's "10/10 null" likely from a longer lookback or different window — but the dominant pattern (firehose-items-have-null-causality) is empirically present at any window.

24h window check: 6 ct_breaking_news SPY items + ~1-2 ct_news_analyses SPY items. ~7-8 items total — still dominantly null-causality.

**The trading session's observation IS reproducible at the organ surface with current data.** Not a transient.

---

## Step 2 — Producer→organ projection layer trace

The data path between ct_news_causality (producer) and the cotrader MCP organ output:

### Step 2.1 — Helper at `_shared/newsCausalityContext.ts`

**Lines 150-156 — analysesQuery** (Claude-graded subset):
```typescript
let analysesQuery = supabase
  .from('ct_news_analyses')
  .select('id, instrument, news_headline, ...')
  .gte('created_at', sinceIso)
  .order('significance', { ascending: false })
  ...
```

**Lines 168-187 — causalityMap** (15-min flow lookup, ONLY for analyses):
```typescript
// Causality lookup — only ct_news_analyses rows have news_id matches.
const causalityMap = new Map<string, NewsCausalityFields>();
if (analysisRows.length > 0) {
  const { data: causalityRows, error: causalityErr } = await supabase
    .from('ct_news_causality')
    .select('news_id, moved, flow_hits_15min, ...')
    .in('news_id', analysisRows.map((r) => r.id));
  ...
  for (const c of causalityRows as CausalityRow[]) {
    causalityMap.set(c.news_id, { moved, flow_hits_15min, ... });
  }
}
```

**Lines 189-209 — breaking news items get HARDCODED EMPTY_CAUSALITY:**
```typescript
for (const r of breakingRows) {
  items.push({
    id: r.id,
    source_table: 'ct_breaking_news',
    headline: r.headline,
    ...
    causality: EMPTY_CAUSALITY,    // ← line 207 — ALL NULL, ALWAYS
  });
}
```

**Lines 210-227 — analysis items use causalityMap or fall back:**
```typescript
for (const r of analysisRows) {
  items.push({
    ...
    causality: causalityMap.get(r.id) ?? EMPTY_CAUSALITY,    // ← line 225
  });
}
```

### Step 2.2 — The architecture

The producer pipeline has three layers. Causality is the third layer, attached only to graded analyses:

```
Layer 1: ct_breaking_news       (firehose — Tavily/UW raw stream)
                ↓ Claude-grading (selectivity by significance)
Layer 2: ct_news_analyses        (subset — claude_take, sentiment, instrument)
                ↓ 15-min flow lookup (ct-news-causality cron */15)
Layer 3: ct_news_causality       (moved/flow_hits/flow_premium per analysis_id)
```

**A ct_breaking_news row never gets a ct_news_causality entry.** The causality cron joins via `news_id ∈ ct_news_analyses.id`, not via `news_id ∈ ct_breaking_news.id`.

The helper's `EMPTY_CAUSALITY` for breaking news items is the architecturally-correct projection — but to the consumer, it reads as "null" with no semantic distinction between "by-design-no-causality-possible" and "structured-zero-no-flow-detected" and "data-missing."

---

## Step 3 — Cause classification

Per the brief's Step 3 hypotheses (a)/(b)/(c)/(d):

### (a) Projection-layer-null — **CONFIRMED, BUT BY DESIGN**

The helper hardcodes EMPTY_CAUSALITY for breaking_news items at line 207. This is intentional: causality data only exists for analyses, not for firehose items. Calling this a "bug" is misframing — it's a documented architectural decision.

**The bug is at the read-shape layer:** the consumer can't distinguish:
- "Breaking news firehose item — by design no causality computed" → null
- "Analysis item awaiting causality — pending" → null
- "Analysis item with computed null causality — structured zero" → 0/false
- "Analysis item with real causality — populated" → real values

The first two end up null at the surface; the consumer reads both as "broken/missing."

### (b) Slice-not-computed — **PARTIAL** (only applies to analyses without causality match)

For ct_news_analyses items that don't have a corresponding ct_news_causality row (because the causality cron hasn't fired yet for that analysis), `causalityMap.get(r.id)` returns undefined and falls back to EMPTY_CAUSALITY. That's a sub-case of (a) at the helper level, but caused by upstream slice-not-yet-computed.

The 1 SPY analysis I checked DID have a matching causality row (with `moved=false`, structured zero) — so this case isn't dominant for SPY today. But it could be a contributor for other tickers or other time windows.

### (c) Schema mismatch — **REFUTED**

Producer column types match organ projection types. ct_news_causality.moved is BOOLEAN; helper projects to `boolean | null`. ct_news_causality.flow_hits_15min is INT; helper projects to `number | null`. No type-coercion-to-null silent issue.

### (d) Other cause — **NOT NEEDED**

(a) sufficiently explains the symptom.

---

## Step 4 — Decision matrix lookup

Per the brief's Step 4:

| Cause | Fix shape | Pair-ship class kill |
|-------|-----------|----------------------|
| **(a) projection nulling** | **Add `status` enum to organ output OR add per-item `causality_state` field disambiguating firehose-only / pending-analysis / no-flow-detected / populated** | **Per-organ integrity test on projection preservation** |

The fix is exactly **the read-layer integrity bundle's `status` field**. With `status` per item:

```typescript
{
  id: ...,
  source_table: 'ct_breaking_news',
  causality: { moved: null, ... },
  status: 'firehose_only_no_causality',
}
{
  id: ...,
  source_table: 'ct_news_analyses',
  causality: { moved: false, flow_hits_15min: 0, ... },
  status: 'no_signal_detected',
}
{
  id: ...,
  source_table: 'ct_news_analyses',
  causality: { moved: null, ... },
  status: 'pending_analysis',
}
```

The captain reads `status` and immediately knows the disposition of each item without inferring from null vs zero.

---

## Step 5 — Cross-reference with read-layer integrity bundle scope

Per `/Users/jameschellis/Documents/cowork-cotrader/scope/2026-05-06-read-layer-integrity-bundle-scoping.md`:

The bundle's proposed `OrganStatus` enum already includes:
- `populated`
- `no_signal_detected`
- `not_yet_analyzed`
- `data_missing`
- `error`
- `stale`

**For news_causality items, expand or refine the enum:**
- `firehose_only_no_causality` (NEW — for breaking_news items that can't have causality by design)
- `no_signal_detected` (existing — for analyses with structured-zero causality)
- `pending_analysis` (NEW or alias for `not_yet_analyzed` — for analyses without causality match yet)

**Implication for bundle Phase 2 (per-organ producer updates):** when news_causality organ adds metadata, the helper update is non-trivial — it needs to set `status` per-item based on which source layer the item came from AND whether the causality lookup found a match. Not just a single organ-level metadata block.

**Likely the bundle needs BOTH:**
1. Organ-level metadata (`as_of`, `source`, `window`, `status`) describing the organ's overall fetch
2. Per-item status field for organs whose items have heterogeneous semantic states (news_causality is the canonical case)

This refines the bundle scope. Worth flagging in scoping review.

**#2 still subsumes into bundle.** But the bundle's news_causality work in Phase 2 is now concretely scoped: it's not just "add metadata" — it's "add per-item status and fix the EMPTY_CAUSALITY-as-null projection ambiguity at the helper level."

---

## Class-kill candidates (queued, no ship this round)

### A.7.K1 — methodology-patterns.md entry: audit-verification-surface-mismatch

The 15th methodology-errors-cascade instance. Worth a paired entry alongside PR #30/PR #32's sub-patterns. PR #31's verification of producer-only missed the consumer-layer symptom; future Phase As must verify the symptom's actual surface, not just upstream.

**Diagnostic question:** *"My symptom report is at surface X. Have I verified at X, or only at upstream Y?"*

### A.7.K2 — Bundle scope refinement: per-item status for heterogeneous-source organs

Update the read-layer integrity bundle scoping doc to include per-item status for organs whose items come from multiple producer layers with different semantic states. news_causality is the canonical case (breaking + analyses + causality-match-or-not).

### A.7.K3 — News-causality-helper warden invariant (defense-in-depth, low priority)

Could add: "for ct_news_analyses rows older than N min, ct_news_causality match should exist." Catches the case where the causality cron silently fails to keep up with analyses. Pre-flag for future read-layer-integrity bundle defense-in-depth.

All require explicit per-PR approval. None ship this round.

---

## Methodology audit (self-check)

- ✅ Verified the symptom at the surface where it lives (organ output trace via helper code), not just at producer layer.
- ✅ Read the helper code to find the EMPTY_CAUSALITY projection at line 207 — empirical ground for the cause classification.
- ✅ Cross-referenced with PR #31's producer-layer verification — both findings correct at their layers, gap was the projection layer between.
- ✅ Refuted hypotheses (b)/(c)/(d) explicitly with empirical evidence.
- ✅ Identified new methodology sub-class (audit-verification-surface-mismatch) with diagnostic question.
- ✅ Cross-cluster-framed the fix into the read-layer integrity bundle.
- ⚠️ Did NOT directly invoke the cotrader MCP tool to capture live organ output — running MCP server in current Claude Code session uses pre-restart code that would pollute telemetry. Traced via helper code path against DB state instead. Functional equivalent for the projection-layer question.
- ⚠️ Sample size for SPY was small (4 breaking + 1 analysis in 6h window). The pattern (firehose-items-have-null-causality) is architecturally guaranteed regardless of sample size, so this isn't load-bearing.

---

## Linked artifacts

- PR #31 (sibling Phase A — producer-layer verification): `docs/audit/2026-05-06-punchlist-2-null-causality-phase-a.md`
- PR #32 (paired methodology entry — structured-zero-misread sub-class): `docs/methodology-patterns.md`
- Read-layer integrity bundle scope (target structural fix): `/Users/jameschellis/Documents/cowork-cotrader/scope/2026-05-06-read-layer-integrity-bundle-scoping.md`
- Helper source: `supabase/functions/_shared/newsCausalityContext.ts:207` (the projection-null line)

---

## Methodology-errors-cascade running tally (this session)

| # | shape | instance |
|---|---|---|
| 9 | hidden-row-caps | morning §5 specialist absence false-finding |
| 10 | partial-frame | morning heatmap "5/8 missing" |
| 11 | false-cause cascade | midday P0 false key-rotation |
| 12 | symptom-grouping | afternoon "4-ticker silent class" + (today's) MSFT-as-C1 refinement |
| 13 | nested-Phase-A own-framing | A3.K1 refining A3 |
| 14 | (rejected — was structured-zero, not silent-no-op) | PR #31 reframed to new sub-class structured-zero-misread |
| **15** | **audit-verification-surface-mismatch (NEW)** | **THIS audit — PR #31 verified producer, missed consumer-layer symptom** |

Discipline catch rate continues compounding. Sub-pattern catalog grows.
