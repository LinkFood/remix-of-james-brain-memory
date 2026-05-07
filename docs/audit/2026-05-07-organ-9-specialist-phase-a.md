# Specialist organ #9 Phase A audit

**Date:** 2026-05-07. **Status:** Phase A read-only complete; implementation deferred to post-RTH (≥20:00 UTC) per D2.2 passive-window scheduling rule.

**Scoping doc:** `scope/2026-05-07-bundle-phase2-organ-9-specialist.md` (Option C hybrid: organ-level status + per-ticker `ticker_status`).

## Verification points — results

### 1. Storage layer back-anchorability (instance #29 watch) — ✅ CLEAN

`ct_specialist_reads` columns: `id, ticker, updated_at, direction_lean, conviction, read_text, flagged, flag_id, source_flow_ids`.

7-day window: 267 rows across all 10 watchlist tickers. **Append-only confirmed**, multi-row per ticker. NOT single-row-overwritten. No instance #29 risk.

Per-ticker row count over 7d (NB: matches Stream 3 D3 sample-window-mismatch finding from instance #26 — empirical N is far above what 7d projection would imply): IWM=30, SPY=40, META=25, AMZN=29, GOOGL=25, TSLA=36, QQQ=32, AAPL=25, MSFT=13, NVDA=12.

### 2. Audience-gating (single vs per-audience) — ✅ CLEAN

`specialistContext.ts:172` — `audienceFilter intentionally omitted — all audiences see specialist reads`. Single composition; same organMetadata across audiences. No instance #33-style per-audience composition needed.

### 3. Per-ticker state mapping completeness — ⚠️ FINDING #34

**Doc spec**: `{populated, no_signal_detected, pending_analysis, error}` — 4 cases.

**Empirical finding**: Only **2 cases are structurally reachable** today.

Producer behavior (`specialistRunner.ts:511, 546-550, 1619, 1769`):
- Success path writes `read_text: text.slice(0, 2000)` (always non-null after trim)
- Parse-fail paths write sentinel: `read_text: \`[parse_fail: ${...}] ${responseText.slice(0,400)}\`` — also non-null
- **No code path writes `read_text=NULL`**

Empirical confirmation: `SELECT COUNT(*) FROM ct_specialist_reads WHERE read_text IS NULL` → **0 rows in entire history**. The defensive skip at `specialistContext.ts:120` (`if (!row.read_text) continue;`) is dead code.

Reachable per-ticker states under current producer:

| Spec case | Producer signal | Reachable today? |
|---|---|---|
| `populated` | Row exists, read_text non-null | ✅ Yes (always) |
| `no_signal_detected` | "Claude returned empty" | ❌ Producer always writes a sentinel even on parse-fail; "empty" not distinguishable from "populated" |
| `pending_analysis` | No row in window | ✅ Yes (when cron hasn't fired) |
| `error` | "Inference errored" per-ticker | ❌ Errors fold into parse-fail sentinel string with `read_text` populated |

**Resolution per scoping doc instructions** ("resolve to existing case with reasoning"): implement as 2-state per-ticker (populated / pending_analysis). The doc-spec `no_signal_detected` and `error` per-ticker cases stay in the OrganStatus enum as theoretical; producer-instrumentation work is needed before they're reachable. NO new enum case (per the doc's "no new case unless genuine semantic gap" rule — this is the opposite: existing cases being unreachable, not new ones surfacing).

**New methodology sub-class candidate (#34): `producer-instrumentation-gates-consumer-precision`**. Bundle contract precision is bounded by what the producer surfaces structurally. Spec mappings that assume richer producer state than exists silently mask cases via the available surface. Family-related to instance #29 (back-anchorability) — both are "producer-shape determines consumer-shape" findings.

### 4. Organ-level aggregate logic (race conditions) — ✅ CLEAN

10 ct-specialist-* edge functions write independently to `ct_specialist_reads`. The helper reads with single PostgREST query (`.in('ticker', tickers).order('updated_at', desc).limit(overPull)`) — deterministic snapshot. No async aggregation across the 10 producers; the snapshot reflects whatever's committed at read-time. No race-condition risk on organ-level read.

## Implementation shape (locked, post-RTH ship)

### Organ-level `organMetadata.status`

| Status | Trigger | Reachable today |
|---|---|---|
| `populated` | ≥1 of 10 tickers has populated row in window | ✅ |
| `pending_analysis` | 0 of 10 tickers have rows in window | ✅ (off-hours / pre-RTH) |
| `no_signal_detected` | 0 populated, but rows exist with null read_text | ❌ Dead branch (producer doesn't surface) |
| `error` | DB error / exception | ✅ |

### Per-ticker `ticker_status`

Array enumerates **all 10 watchlist tickers** (behavior change — currently the array filters to tickers with rows; new shape includes pending tickers with null content fields).

| Status | Trigger | Reachable today |
|---|---|---|
| `populated` | Ticker has row with read_text in window | ✅ |
| `pending_analysis` | Ticker has no row in window | ✅ |
| `no_signal_detected` / `error` | (Producer-instrumentation-gated; dead today) | ❌ |

### Backwards-compat consideration (post-RTH check)

Behavior change: per_ticker array shape goes from "tickers with rows only" → "all 10 watchlist tickers, some with null content". Downstream consumers reading `result.data.per_ticker` may need updates if they assume populated-only. Audit consumers at implementation time (`grep -rn 'specialistContext\\|getSpecialistContext'` for callers).

## Schedule

- **Today (5/7) ≥20:00 UTC** — implement, deploy, verify end-to-end via fresh-Deno
- **Defer to 5/14** if post-RTH window doesn't open cleanly (D2.2 verdict 5/13)

## Files implementation will touch

- `supabase/functions/_shared/specialistContext.ts` — add `organMetadata` + `ticker_status` per-result; enumerate all watchlist tickers
- `docs/system-map/organ-metadata-schema.md` — Phase 2 progress 8/10 → 9/10
- (No new migration; warden auto-cover via `organ_metadata_completeness_specialist` from `20260508010000_organ_metadata_completeness_invariants.sql`)
