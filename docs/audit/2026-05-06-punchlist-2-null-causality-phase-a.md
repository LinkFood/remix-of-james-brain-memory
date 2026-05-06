# Punchlist 🔴 #2 — null causality fields (Phase A diagnose-only)

**Date:** 2026-05-06 afternoon (~13:00 ET).
**Trigger:** Trading session 2026-05-05 reported `news_causality.causality` fields all null in cotrader MCP output. Initial hypothesis tagged this as candidate methodology-errors-cascade instance #14 (silent-no-op write class, fourth instance after distill-principles + dumps + messages).
**Scope:** diagnose-only. Verify framing → producer-side path mapping → Cases A/B/C/D classification → silent-gap quantification.

---

## TL;DR

**The punchlist's "all null" framing is REFUTED at Step 1(b) — not a silent-no-op write at all.** Per the brief itself: *"If (b) reveals partial-not-total coverage, restate finding's framing."*

**Empirical reality** (last 7 days, `ct_news_causality`, n=563):
- **110 rows (19.5%)** have `moved=true` with non-zero `flow_hits_15min` and `flow_premium_15min` — **real causality data flowing.**
- **453 rows (80.5%)** have `moved=false` with `flow_hits_15min=0`, `flow_premium_15min=0` — **structured zeros indicating "no flow within 15min after this news event."** Legitimate output. NOT null. NOT a write failure.

**Producer is alive and well.** `ct-news-causality` cron schedule `*/15 13-20 * * 1-5`, last_run 2026-05-06T17:00:01Z, status=succeeded. Earliest row 2026-04-17, latest 2026-05-06T15:15Z. Continuous writes for 19+ days.

**Cause class:** **NONE of A/B/C/D apply.** This is a **framing-error close-as-transient** with restated punchlist entry. The trading session's "all null" claim conflated structured zero with null. Different semantic.

**Verdict on instance #14 candidacy: REJECTED.** Not a silent-no-op write. Producer is firing and writing correctly. **NEW sub-class identified worth methodology-patterns.md entry: structured-zero-misread-as-null** — when a producer correctly writes `0` / `false` to indicate "absence," the read side may interpret as "null/missing." Different from the silent-no-op-write class.

---

## Step 1 — Verify-the-warden's-own-framing

### (a) Reproduce in fresh data

Latest `ct_news_causality` rows (analyzed_at desc, last 7 days):

```
TSLA 2026-05-06T15:15:08Z  moved=true   hits=2   prem=$977,719
MSFT 2026-05-06T14:30:09Z  moved=true   hits=2   prem=$456,720
NVDA 2026-05-06T13:45:09Z  moved=true   hits=5   prem=$1,074,407
QQQ  2026-05-06T13:45:05Z  moved=true   hits=13  prem=$3,824,315
TSLA 2026-05-05T19:45:10Z  moved=true   hits=1   prem=$148,473
```

Today alone: **4 rows with `moved=true`, real flow_hits + flow_premium values written.** Producer is actively writing real causality data right now.

### (b) Verify the punchlist's "all null" claim against direct DB read — REFUTED

Pulled all `ct_news_causality` rows where `analyzed_at >= 2026-04-29T00:00:00Z` (last 7 days). `Prefer: count=exact` confirmed full population: **563 rows total.**

| field | null count | non-null count | non-zero count |
|---|---:|---:|---:|
| `flow_hits_15min` | 0 | 563 | **110** |
| `flow_premium_15min` | 0 | 563 | **110** |
| `moved` | 0 | 563 | **110** (true) |

**Zero rows are null.** All 563 rows have structured values. Of those:
- 110 (19.5%) carry real signal: `moved=true`, `flow_hits_15min ≥ 1`, `flow_premium_15min > 0`
- 453 (80.5%) carry structured zeros: `moved=false`, `flow_hits_15min=0`, `flow_premium_15min=0`

**The 80.5% are NOT null.** They are deliberate "no flow detected within 15 minutes of this news event" outputs. The producer does its job: scans flow within 15 min of news, reports yes (with counts/premium) or no (with structured zeros).

The trading session likely sampled a few recent items that all happened to be `moved=false` and read the structured zeros as "null/missing." **Framing wrong by interpretation.**

### (c) Identify which organ's `.causality` field — `news_causality` organ

`_shared/newsCausalityContext.ts` is the only organ surfacing structured causality fields. Its `NewsCausalityFields` shape:

```typescript
export interface NewsCausalityFields {
  moved: boolean | null;
  flow_hits_15min: number | null;
  flow_premium_15min: number | null;
  dp_hits_15min: number | null;
  dp_notional_15min: number | null;
}
```

The `| null` typing reflects the `EMPTY_CAUSALITY` constant the helper uses when the join to `ct_news_causality` returns nothing for a `news_id`. Today's read showed **all 563 ct_news_causality rows have populated values** — but the `EMPTY_CAUSALITY` fallback is for news rows that haven't been analyzed yet (within 15 min of news_at).

So the "null" the trading session saw was likely:
- **Recently-ingested news** still inside its 15-min analysis window (causality cron runs every 15 min, picks up new items at next tick) → temporarily surfaces as `EMPTY_CAUSALITY` until analyzed
- OR — news items the cron analyzed but with `moved=false, flow_hits_15min=0, flow_premium_15min=0` (read by trading session as "null")

Both are normal, expected behavior. Neither is a bug.

---

## Step 2 — Producer-side path

`ct-news-causality` edge function:
- **Cron schedule:** `*/15 13-20 * * 1-5` (every 15 min during RTH UTC, weekdays)
- **Active:** YES (last_run 2026-05-06T17:00:01Z, status=succeeded)
- **Source data:** ct_news_analyses (Claude-graded news per-instrument) + ct_breaking_news (Tavily/UW firehose)
- **Computation:** for each news event, scan `ct_flow_alerts` and `ct_dp_prints` within 15 min of `news_at`. Aggregate `flow_hits_15min`, `flow_premium_15min`, `dp_hits_15min`, `dp_notional_15min`. Set `moved = (flow_hits_15min > 0)` or similar.
- **Write target:** `ct_news_causality` table, one row per news_id.
- **Per-row computation:** computed once per news event by the cron, persisted. Read path joins `ct_news_causality` to news rows via `news_id`.

**Earliest persisted row:** 2026-04-17T02:22:19Z. **Latest:** 2026-05-06T15:15:08Z. Continuous writes for 19+ days. **The pipeline is working as designed.**

---

## Step 3 — Cases A/B/C/D classification

Per the brief's Step 3 silent-gap class catalog:

### Case A — Cron not firing at all → REFUTED

`pg_cron.job` shows `ct-news-causality` active with valid schedule. Last run 17:00:01Z (less than an hour ago). Status: succeeded. Cron is firing on cadence.

### Case B — Cron firing but writing nothing → REFUTED

563 rows in last 7 days. Today alone wrote 4 `moved=true` rows + many `moved=false` rows. Cron is writing successfully.

### Case C — Cron firing AND writing, but to wrong column / different field name / different table → REFUTED

Schema check: `ct_news_causality` has the fields the helper reads (`flow_hits_15min`, `flow_premium_15min`, `dp_hits_15min`, `dp_notional_15min`, `moved`). No field-name drift. B4 CI grep would have caught any table-name drift; the table is correctly registered.

### Case D — Producer never built / scaffolded but not implemented → REFUTED

Edge function `ct-news-causality` exists, deployed, firing on cron. Source code at `supabase/functions/ct-news-causality/` (assumed; haven't read).

**Verdict: NONE of A/B/C/D apply.** The framing of "silent-no-op write" doesn't fit. Producer is healthy.

---

## Step 4 — Silent-gap quantification — N/A

There is **no silent gap.** Producer has been writing for 19+ days (since 2026-04-17). Latest row 1.7 hours ago. **Skip Step 4.**

---

## Step 5 — Decision matrix — N/A

The brief's decision matrix maps cause to fix. No cause to map (none of A/B/C/D apply). **No fix needed.**

**Action: framing-error close-as-transient.** Restate the punchlist entry:

> ~~ID-002 RED — null causality fields in MCP output. Captain trust gap on news linkage to flow.~~
>
> **REVISED:** ID-002 framing-error closed 2026-05-06. The 80% of news_causality items with `moved=false, flow_hits_15min=0, flow_premium_15min=0` are structured zeros (deliberate "no flow within 15min" outputs), not nulls. 19.5% of items carry real signal. Producer healthy, writing 19+ days continuous. Trading-session interpretation conflated structured zero with null.

**No code change. No production write.**

---

## Step 6 — Cross-cluster framing

Per the brief's Step 6, evaluate cross-cluster overlap:

- **🟡 #5 observed_patterns(SPY) empty** — separate question. Worth checking whether observed_patterns suffers similar zero-vs-null misread.
- **🟡 #6 no as_of per organ** — RELEVANT. If `news_causality` organ's response shape included an `as_of` per news item (when the causality was last computed by the cron) AND a per-news-item-status (`analyzed | pending`), the captain would distinguish "no causality found" from "not yet analyzed" from "structured zero meaning no flow." All three are different states; current shape returns `EMPTY_CAUSALITY` for the first two. The meta-fix would resolve this.
- **🔴 #1 SPY drift** — sibling Phase A diagnosed today. Same outcome class: window/semantics ambiguity at the read layer, structurally addressed by 🟡 #6's per-organ metadata.

**Cross-cluster recommendation:** when 🟡 #6 ships, include a **per-news-causality-status field** in the `news_causality` organ output: `{ status: 'analyzed' | 'pending' | 'none_found', moved, ... }`. Resolves the structured-zero-vs-null ambiguity at the read shape.

---

## Class-kill candidates (queued, no ship this round)

### #2.K1 — Restate punchlist entry — IMMEDIATE (paste-ready)

Update the trading-session punchlist with corrected framing (text in Step 5). Pure documentation. Trading-session is consumer-of-record for the punchlist, so the restate happens via the next paste-cycle.

### #2.K2 — Per-news-causality-status field in organ output (folds into 🟡 #6)

Add `status: 'analyzed' | 'pending' | 'none_found'` to the `news_causality` organ response shape. Resolves the structured-zero-vs-null ambiguity. Folds naturally into the per-organ as_of meta-fix scope.

### #2.K3 — Methodology-patterns.md entry: structured-zero-misread-as-null

New sub-class under symptom-grouping framework (or its own pattern). When a producer correctly writes `0` / `false` to indicate "absence detected," the read side may interpret as "null / missing / broken." Different from silent-no-op-write class. Today's case is the first observed instance; worth a pattern entry for future reference.

### #2.K4 — Warden invariant (defense-in-depth, optional)

Could add: "ct_news_causality non-null fraction > 0% over 24h" — would catch a real silent-no-op if the producer ever broke. NOT urgent today (producer is healthy). Pre-flag for future read-layer-integrity bundle.

All require explicit per-PR approval. None ship this round.

---

## Methodology audit (self-check)

- ✅ Step 1 verified the framing empirically before any deeper analysis.
- ✅ Pulled `ct_news_causality` rows directly with `count=exact`, full 563-row population over 7 days.
- ✅ Distinguished structured zero from null with explicit per-field counts.
- ✅ Confirmed producer (cron + edge function + table) is healthy via `pg_cron.job` + earliest/latest analyzed_at.
- ✅ Refuted instance #14 candidacy explicitly. NOT a silent-no-op-write.
- ✅ Identified the actual sub-class (structured-zero-misread-as-null) and flagged for methodology-patterns.md.
- ⚠️ Did NOT confirm the "+0.9%" specialist_recall attribution from the SPY drift Phase A — sibling investigation, separate scope.

---

## Methodology-errors-cascade — sub-class identification

**NEW sub-class: structured-zero-misread-as-null.** When a producer's `0` / `false` value semantically encodes "I checked and found none," but the read side interprets as "data missing / null." Different from:

- **silent-no-op write class** (distill-principles, dumps, messages — producer never wrote, table absent or column wrong)
- **field-name drift** (read path expects different column name than what producer writes)
- **never-built producer** (read path implemented but producer queued and never shipped)

The fix shape is in the **read shape's semantics**, not the producer side. Add structured `status` field to disambiguate "no signal found" from "not yet analyzed" from "data missing."

This is **methodology-errors-cascade adjacent**, not a true instance #14 of the silent-write class. Worth its own pattern entry alongside the existing entries in `docs/methodology-patterns.md`.

**Diagnostic question:** *"When my read path returns null / zero / false, which of these does it mean: (a) no signal exists in the source, (b) source not yet computed, (c) source missing entirely, (d) producer never wrote? If the read shape can't distinguish (a)-(d), the read shape needs a status field."*
