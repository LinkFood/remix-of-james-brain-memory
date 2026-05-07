# Organ Metadata Schema — Read-Layer Integrity Bundle Phase 1

**Date:** 2026-05-06.
**Phase:** 1 (schema design + ContextHelper contract). Phase 2 (per-organ producer updates) ships incrementally over weeks.
**Source brief:** `/Users/jameschellis/Documents/cowork-cotrader/scope/2026-05-06-read-layer-integrity-bundle-scoping.md` (Cowork-side scope doc).
**Implementation:** `supabase/functions/_shared/contextHelper.ts:OrganMetadata + OrganStatus + HelperResult.organMetadata`.

---

## TL;DR

Every organ's `HelperResult<T>` now carries an optional `organMetadata` block alongside `data` + `meta`. The metadata declares **as_of** (when the data was computed), **source** (which producer generated it), **window** (what time-scope semantics apply), and **status** (semantic state via `OrganStatus` enum).

**Single structural ship resolves four punchlist items:**

| punchlist | resolved by field |
|---|---|
| 🔴#1 SPY drift across organs | `window` — captain reads "close-to-close 5/05" vs "intraday open-to-close 5/05" and immediately knows the values measure different things |
| 🔴#2 null causality structured-zero-vs-null | `status` — distinguishes `no_signal_detected` from `data_missing` from `pending_analysis` |
| 🟡#5 observed_patterns(SPY) empty | `status` — likely `no_signal_detected` (similar pattern to #2) |
| 🟡#6 per-organ as_of meta-fix | `as_of` — original scope, directly resolved |

**Phase 1 ships type-only**. No helper populates `organMetadata` yet. Phase 2 lands per-organ population over weeks.

---

## Schema design

### `OrganStatus` enum

8 cases covering observed semantic states:

```typescript
type OrganStatus =
  | 'populated'                              // real signal present
  | 'no_signal_detected'                     // producer ran, found nothing
  | 'balanced_flow_no_directional_signal'    // volume but no directional read
  | 'firehose_only_no_causality'             // breaking_news items lack analysis-keyed data
  | 'pending_analysis'                       // producer hasn't run for this row yet
  | 'data_missing'                           // expected data missing — investigation candidate
  | 'error'                                  // producer fired but errored
  | 'stale';                                 // data older than freshness threshold for this organ
```

**Origin of each case:**

- `populated` — baseline. Real data, signal-bearing.
- `no_signal_detected` — codified via PR #32's structured-zero-misread-as-null. Producer wrote `0`/`false` to indicate detected-absence.
- `balanced_flow_no_directional_signal` — codified via PR #41's IWM Phase A (instance #18). Volume present but calls/puts cancel under decay; signed magnitude < threshold; bucket correctly hidden.
- `firehose_only_no_causality` — codified via PR #34's Phase A.7 (instance #15). `ct_breaking_news` items lack `news_id` matches in `ct_news_causality` by architecture; helper hardcodes `EMPTY_CAUSALITY` for them. Status field disambiguates "by-design no causality possible" from "data missing."
- `pending_analysis` — `ct_news_analyses` rows that haven't yet been processed by the 15-min `ct-news-causality` cron.
- `data_missing` — actual gap. Investigation candidate. Different from the above three by mechanism: not by-design, not no-signal, not no-flow — actually broken.
- `error` — producer fired but errored. Surface to consumer with classification.
- `stale` — data older than freshness threshold for this organ. Threshold per-organ-configured.

### `OrganMetadata` interface

```typescript
interface OrganMetadata {
  as_of: string;        // ISO 8601 timestamp of when data was computed
  source: string;       // Producer identifier (table / cron / function name)
  window: string;       // Time window — "close-to-close 2026-05-05", etc.
  status: OrganStatus;  // Semantic state per enum
}
```

### Phase A finding (2026-05-06 verification)

Initial scope-doc framing referred to four "organs": morning_brief, eod_summary, news_causality, flow_heatmap. **Empirical verification at 2026-05-06 found this is partially miscategorized**:

| Name | Is it an organ? | Where it lives |
|---|---|---|
| `news_causality` | ✅ yes | `_shared/newsCausalityContext.ts` — HelperResult, in `buildClaudeContext` |
| `flow_heatmap` | ✅ yes | `_shared/flowHeatmapContext.ts` — HelperResult, in `buildClaudeContext` |
| `morning_brief` | ❌ no — **consumer** | `jac-morning-brief` edge function writes composed report to `brain_reports` |
| `eod_summary` | ❌ no — **consumer** | `ct-eod-summary` cron writes composed report to `brain_reports` |

The 🔴#1 SPY drift is between two *consumer-written reports*, not between two organs. This **refines the schema's intended layering**:

- **Layer A — organs (HelperResult):** `OrganMetadata` declares per-helper as_of/source/window/status. Phase 2 lands per-organ population.
- **Layer B — consumers (brain_reports):** When a consumer composes organ data and writes a report, it records its own window of consumption + which organ versions it consumed. The `brain_reports.metadata` JSONB block (already exists) is where the consumer-level metadata lands. Phase 3 ships consumer updates that surface the composed metadata into brain_reports.

This two-layer approach actually resolves 🔴#1 cleanly: morning_brief reads SPY at close-to-close window from one organ source; eod_summary reads SPY at intraday window from another. **Each consumer records its window in brain_reports.metadata.** Captain reads both reports, sees window differs, understands the +0.80 vs +0.17 isn't drift but two correct measurements at two different scales.

### Worked examples (Phase 2 target shape — organ layer)

**flow_heatmap organ post-Phase-2** (already has `meta.warning='empty_result'` today; status field formalizes):

```typescript
{
  data: { per_ticker: { NVDA: {...}, IWM: {...}, ... } },
  meta: { /* internal telemetry */ },
  organMetadata: {
    as_of: "2026-05-06T13:30:00-04:00",
    source: "_shared/flowHeatmapContext.ts / ct_flow_heatmap_live",
    window: "trailing decayed flow per_ticker per_expiry_bucket",
    status: "populated"  // or 'no_signal_detected' if every per_ticker rowCount=0
  }
}
```

**news_causality organ post-Phase-2** (already has multiple return paths today — empty / OK / error):

```typescript
{
  data: {
    items: [
      { id: "...", source_table: "ct_breaking_news", causality: { moved: null, ... } },
      { id: "...", source_table: "ct_news_analyses", causality: { moved: false, flow_hits_15min: 0 } },
    ],
    ...
  },
  meta: { /* telemetry */ },
  organMetadata: {
    as_of: "2026-05-06T13:30:00-04:00",
    source: "_shared/newsCausalityContext.ts / ct_news_causality + ct_breaking_news",
    window: "trailing 15min items keyed to causality (13:15-13:30 ET)",
    status: "populated"
    // Per-item status (heterogeneous-source-organ refinement): each item
    // independently labeled 'firehose_only_no_causality' for breaking_news
    // rows vs 'populated' for analyses rows. Phase 2 design.
  }
}
```

### Worked example — consumer layer (Phase 3, brain_reports.metadata)

```typescript
// brain_reports row written by jac-morning-brief
{
  kind: 'morning_brief',
  body: '...narrative...',
  metadata: {
    composed_at: '2026-05-06T08:30:00-04:00',
    consumer_window: 'close-to-close 2026-05-04 → 2026-05-05',
    consumed_organs: {
      flow_heatmap:    { as_of: '2026-05-06T08:29:30Z', window: 'trailing decayed flow' },
      pulse:           { as_of: '2026-05-06T08:29:00Z', window: 'last 1h' },
      // ... other organs at as_of/window each surfaced
    }
  }
}

// brain_reports row written by ct-eod-summary
{
  kind: 'eod_summary',
  body: '...narrative...',
  metadata: {
    composed_at: '2026-05-05T16:05:00-04:00',
    consumer_window: 'intraday open-to-close 2026-05-05 (09:30-16:00 ET)',
    consumed_organs: { /* organ metadata at that consumer's as_of */ }
  }
}
```

Captain reads both reports, sees `consumer_window` differs, **immediately understands the +0.80 vs +0.17 isn't drift** — it's two different correct measurements of two different windows. 🔴#1 framing dissolved at metadata-display layer without changing the underlying numbers.

**news_causality organ low-event window post-Phase-2:**

```typescript
{
  data: {
    items: [
      { id: "...", source_table: "ct_breaking_news", causality: { moved: null, ... } },
      { id: "...", source_table: "ct_news_analyses", causality: { moved: false, flow_hits_15min: 0 } },
    ],
    ...
  },
  meta: { /* telemetry */ },
  organMetadata: {
    as_of: "2026-05-06T13:30:00-04:00",
    source: "ct-news-causality cron */15 13-20 RTH",
    window: "trailing 15min (13:15-13:30 ET)",
    status: "populated"
    // Note: per-item status field also planned (heterogeneous-source-organ
    // case from PR #34 A.7) — see Phase 2 design refinement below.
  }
}
```

---

## Phase A audit-first applied to schema design

Per Section 1 of PR #52 runbook, verify schema holds against actual organ output shapes before locking.

### Verified empirically (2026-05-06)

Pulled actual organ helper return shapes for `news_causality` (`_shared/newsCausalityContext.ts:105-280`) and `flow_heatmap` (`_shared/flowHeatmapContext.ts:234-280`):

| Field | news_causality empirical fit | flow_heatmap empirical fit |
|---|---|---|
| `as_of` | ✅ Already populates `meta.fetchedAt` at line 111, 252, 279 — direct mirror | ✅ Already populates `meta.fetchedAt` from `data.generated_at` at line 259 |
| `source` | ✅ Helper name + table refs are deterministic; surfaceable from helperName | ✅ Same |
| `window` | ✅ Helper-internal: trailing N min keyed to causality | ✅ Helper-internal: trailing decayed flow per ticker × expiry bucket |
| `status` | ✅ Existing empty-path returns at line 247 (rowCount=0) map to `no_signal_detected`; error-path at 279 maps to `error` | ✅ Existing `meta.warning='empty_result'` at line 264 maps to `no_signal_detected` |

**Schema covers observed cases:** 11 instances of methodology-errors-cascade caught today (instances #9-#20 minus #14) all map to read-layer-integrity gaps that this schema's `status` enum addresses:

- Instance #10 heatmap "5/8 missing" → `window` + `status='balanced_flow_no_directional_signal'` (IWM specifically)
- Instance #15 audit-verification-surface-mismatch (news_causality projection) → `status='firehose_only_no_causality'` for breaking_news items
- Today's 🔴#1 SPY drift → `window` (consumer-layer; see Phase A finding above)
- Today's 🔴#2 null causality → `status='no_signal_detected'` for structured-zero rows

**Phase A finding feeds back to scope:** original Cowork scope doc named four "organs" but two (morning_brief, eod_summary) are consumers, not organs. Two-layer schema (organ-layer + consumer-layer) added to the design. Cowork scope doc should be cross-referenced with this finding for Phase 3 planning.

**No additional enum cases needed at Phase 1 ship.** Phase 2 implementation may surface edge cases requiring enum extensions; the schema is additive (new OrganStatus values can be added without breaking consumers that handle existing cases).

### Pre-flagged for Phase 2 design refinement

- **Per-item status for heterogeneous-source organs** (per PR #34 A.7 finding): `news_causality` items come from two source tables (breaking_news + analyses). Each item's status may differ. Phase 2 design should add `OrganStatus` per-item alongside the organ-level metadata.
- **`confidence_floor` or `data_volume_per_window` field** (pre-flagged in scope doc): if Phase 2 acceptance reveals captain still has trust gaps after as_of/source/window/status, additional fields scoped.
- **Cross-organ analytical workflows** (per scope doc Coupling 2): downstream consumers that combine multiple organs (e.g., specialist read at as_of=t1 vs pulse at as_of=t2) become cleaner once organs self-declare their windows. Pre-flag for Phase 3 consumer updates.

---

## Backward compatibility

- **Phase 1 ships type-only.** Helpers don't populate `organMetadata` yet. Consumers reading `result.organMetadata` see `undefined`.
- **Existing helpers unchanged.** No code change required to ship Phase 1 — only new types in `contextHelper.ts`.
- **Existing consumers unchanged.** `result.organMetadata` access pattern is `result.organMetadata?.as_of` (optional chain) — falls back gracefully when undefined.
- **buildClaudeContext composer** passes through `organMetadata` if helpers populate it; doesn't synthesize on behalf of helpers.

**Deprecation window:** indefinite. Phase 2 ships incrementally — one organ per PR. Phase 3 ships consumer updates per consumer. No coordinated cut-over.

---

## Phase 2 plan (per-organ producer updates)

10 organs × 1 PR each = ~10 PRs over weeks. Each organ's PR shape:

1. Update organ helper's `fetch()` return to populate `organMetadata`.
2. Schema-pass-through verified (helper return shape includes new field).
3. Pair-ship warden invariant on `metadata-completeness for that organ`:
   - "if helper fires N times in window, all N HelperResult.organMetadata should be defined" (defense-in-depth — invariant catches if a producer ships but forgets metadata).
4. Backward-compat: existing consumers keep working (organMetadata is additive).

**Recommended Phase 2 first-organ pick:** `news_causality` — has the heterogeneous-source-organ design refinement need; building it first shapes the per-item status pattern for other organs.

### Phase 2 progress marker

| # | Organ | Producer write | Per-item status | Warden invariant | Shipped |
|---|---|---|---|---|---|
| 1 | `news_causality` | ✅ | ✅ (firehose_only_no_causality / populated / pending_analysis) | ✅ active | 2026-05-07 |
| 2 | `flow_heatmap` | ✅ | n/a (homogeneous-source) | ✅ active | 2026-05-08 |
| 3 | `pulse` | ✅ | n/a (regime field already encodes per-ticker state) | ✅ active | 2026-05-09 |
| 4 | `tape` | ✅ | n/a (homogeneous-source — `ct_tape_commentary` single shape) | ✅ active | 2026-05-10 |
| 5 | `detector` | ✅ | n/a (`source` field is domain metadata, not data-quality status) | ✅ active | 2026-05-07 |
| 6 | `event_recency` | ✅ | n/a (4-source union normalizes to single `RecencyEvent` shape) | ✅ active | 2026-05-07 |
| 7 | `james_flags` | ✅ | n/a (homogeneous post-2026-04-27 unification) | ✅ active | 2026-05-07 |
| 8 | `analogs` | ✅ | n/a (first organ to use `pending_analysis` enum case — producer cron `ct-session-analog build` hasn't fired) | ✅ active | 2026-05-07 |
| 9 | `specialist` | pending | tbd | dormant (auto-engages on producer ship) | — |
| 10 | `specialist_recall` | pending | tbd | dormant (auto-engages on producer ship) | — |

**ct_brain_telemetry.organ_status column shipped 2026-05-08** (migration `20260507000000_brain_telemetry_organ_status.sql`). claudeReadSurface.ts populates `organ_status` from `result.organMetadata?.status` on every brain read.

**Per-organ metadata-completeness warden invariants pair-shipped 2026-05-09** (migration `20260508010000_organ_metadata_completeness_invariants.sql`). 10 invariants in `organ_metadata` warden category, one per organ. Each gated on an EXISTS guard: dormant (returns metric_value=0) until the organ produces at least one row with organ_status set in last 24h, then auto-engages. After today's ship, **every Bundle Phase 2 organ ship is auto-covered by warden enforcement** — defense net effectively gains a 6th layer for organ-metadata integrity.

**End-to-end Phase 2 acceptance verified each ship** via fresh-Deno orchestrator invocation pattern (`/tmp/verify_pulse_phase2.ts`, `/tmp/verify_phase2_organ_status.ts`). Acceptance criterion: `consumer_name='phase2-<organ>-verify'` row in `ct_brain_telemetry` shows `organ_status='populated'` for the target organ; companion organs unaffected.

---

## Phase 3 plan (consumer reads — opt-in per consumer)

Each consumer (cotrader MCP, UI heatmap pages, EOD summary consumers, jac dispatcher's brain context, etc.) updates to consume metadata when it ships.

- **cotrader MCP:** include metadata in tool response so trading session can disambiguate window/status/source/as_of.
- **UI pages:** show metadata in tooltips or side panels (not prominently — captain doesn't need to read it on every glance, but accessible for debugging).
- **jac dispatcher:** log metadata in dispatch context for forensic trail.

Per-consumer updates ship in parallel; each is independent.

---

## Phase 4 plan (multi-day acceptance per PR #30 single-sample-acceptance-window discipline)

- Verify all 10 organs surface metadata correctly on every fire over the acceptance window.
- Verify consumers display/use metadata as designed.
- Verify warden invariants on metadata-completeness pass for all organs.
- Captain operational verification: trading session uses metadata in real RTH decisions; no regression on per-ticker view trust.
- Acceptance window: 5 trading days minimum. End-of-window verdict on whether the bundle has resolved the 4 punchlist items.

---

## Acceptance criteria (Phase 1)

This Phase 1 PR ships when:

1. ✅ `OrganMetadata` + `OrganStatus` types added to `contextHelper.ts`
2. ✅ `HelperResult<T>.organMetadata` optional field added with backward-compat semantics
3. ✅ This schema design doc lands at `docs/system-map/organ-metadata-schema.md`
4. ✅ `npm run build` passes (TS check covers new types)
5. ✅ PR #33 deno check CI gate validates supabase/functions surface
6. PR description includes Phase A self-check + cross-references to PR #34 / #41 / IWM finding for the new OrganStatus enum cases

**No multi-day acceptance for Phase 1** — type-only ship, no production behavior change. Phase 2 acceptance applies per organ as it ships.

---

## Cross-references

- **Cowork scope:** `/Users/jameschellis/Documents/cowork-cotrader/scope/2026-05-06-read-layer-integrity-bundle-scoping.md`
- **Sub-pattern entries that motivated each enum case:**
  - PR #32: `structured-zero-misread-as-null` — motivated `no_signal_detected`
  - PR #34 A.7: `audit-verification-surface-mismatch` — motivated `firehose_only_no_causality`
  - PR #41 IWM Phase A: instance #18 brief-framed-wrong-computational-layer — motivated `balanced_flow_no_directional_signal`
- **Phase 2 first-organ candidate:** `_shared/newsCausalityContext.ts` (heterogeneous-source-organ shape)
- **D3 coupling considerations:** `/Users/jameschellis/Documents/cowork-cotrader/scope/2026-05-06-read-layer-integrity-bundle-scoping.md` § Cross-cutting with D3
- **Captain trajectory:** post-bundle (end of next week), 4 punchlist items closed in single ship; trading session reads metadata directly without cross-MCP queries
