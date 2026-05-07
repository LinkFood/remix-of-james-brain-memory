# Specialist_recall organ #10 Phase A audit

**Date:** 2026-05-07. **Status:** Phase A read-only complete; implementation deferred to post-RTH (≥20:00 UTC) per D2.2 passive-window scheduling rule. **Verdict: clean enough to authorize post-RTH ship with one shape adjustment from the doc's "mirror #9" framing.**

**Scoping doc:** `scope/2026-05-07-bundle-phase2-organ-10-specialist-recall.md` (Cowork-side, summarized in brief).

## Verification points — results

### 1. Storage layer (instance #29/#34/#35 watches) — ✅ CLEAN with rescope

**Instance #35 finding (table-name verification before locking design):**

Cowork's hint was "ct_specialist_recall_* or similar" — **wrong-shape assumption**. Phase A confirmed the recall organ has **NO dedicated table**. It composes from existing tables:
- `ct_specialist_reads` (primary — same source as organ #9; 315+ rows over 7d, 10 tickers, append-only)
- `ct_flags` (joined for flag metadata: option_symbol, strike, expiry, side)
- `ct_flag_grades` (joined for outcomes: win/loss/partial)
- `ct_specialist_scoreboard_v2` (v2 enrichment via `fetchV2Enrichment`)
- `ct_specialist_prompt_lifecycle` (live prompt version)

`ct_specialist_memory` exists but is **dead-on-arrival** (2 rows; writer path gates on `flag.source === 'specialist'` which v2 never produces). Helper deliberately reads from live `ct_specialist_reads` per the 2026-05-01 audit rationale documented at `specialistRecallContext.ts:42-46`.

**Append-only confirmed.** ✅ Back-anchorability not a concern (read-side organ; not historical reconstruction surface).

### 2. Audience-gating — ✅ CLEAN, no rescope

`specialistRecallContext.ts:80` declares:
```ts
const AUDIENCE_FILTER: ReadonlyArray<AudienceMode> = ['cotrader'];
```

Applied at line 461 via the `ContextHelper.audienceFilter` interface — orchestrator gates per-organ at composition layer (the orchestrator skips this organ entirely when audience !== 'cotrader'). Different from james_flags's pattern (which uses helper-level audienceFilter too, not composition-layer post-filter). **Both are equivalent at the orchestrator boundary.**

Single composition: only one audience ever reads the organ output, so no per-audience metadata variation needed. organMetadata stays single per fire.

### 3. Per-ticker state mapping (instance #34) — ⚠️ DESIGN MISMATCH WITH DOC; resolved

**The doc's "MIRROR ORGAN #9 DESIGN" framing has a structural mismatch with this organ's actual output shape.**

Organ #9 (`specialist`):
- Returns `per_ticker: SpecialistRead[]` — array enumerating all 10 watchlist tickers
- Hybrid Option C (organ-level status + per-ticker `ticker_status` field) makes sense

Organ #10 (`specialist_recall`):
- Returns `ticker: string` (single, derived from `opts.tickerFocus`) + `reads: RecallEntry[]` (flagged + unflagged for that one ticker) + `stats: RecallStats`
- **No per-ticker array** — the organ is already per-ticker via `tickerFocus`. Per-ticker granularity collapses to organ-level.
- Hybrid Option C is **structurally inapplicable** — there's nothing for `ticker_status` to attach to.

**Resolution:** organ-level metadata only. NO per-ticker `ticker_status` field. The doc's framing assumed organ #10 mirrored #9's multi-ticker shape; it doesn't. This is a doc-author's mental-model miss, not a producer-instrumentation gap. **Cascade catalog instance #38 candidate:** `mirror-design-pattern-must-respect-organ-output-shape` — when scoping doc says "mirror organ X," verify the new organ has the same output cardinality (multi-entity vs single-entity). Mirror at the wrong cardinality forces inapplicable design choices.

### 4. Organ-level aggregate logic — ✅ CLEAN

Single deterministic snapshot via `Promise.all` over 4 parallel queries (flagged, unflagged, flags lookup, grades lookup) + v2 enrichment in parallel via `fetchV2Enrichment`. PostgREST snapshot semantics — no async aggregation, no race conditions at organ-read time.

### 5. Chronological-vs-semantic boundary — ✅ CONFIRMED chronological

Current implementation is **purely chronological** by `updated_at DESC`:
- Last 5 flagged reads ordered by `updated_at DESC` (line 299)
- Last 5 unflagged-conviction-≥50 reads ordered by `updated_at DESC` within 5d window (line 311)
- v2 enrichment (multi_axis_stats, regime_conditional, calibration curve, lifecycle) is statistical aggregation, not semantic

**No semantic search / vector similarity.** Embeddings exist on some related tables (e.g., `jac_principles.embedding`) but `ct_specialist_reads` is read by direct timestamp filter, not by vector match.

**Bundle contract boundary:** the metadata-completeness invariant covers what's currently shipped (chronological recall). Semantic recall (vector similarity over embedded prior reads) is a separate post-bundle effort. Implementation comment must document this boundary so a future semantic-recall PR doesn't accidentally trip the chronological-shape invariant.

## Reachable per-organ status (instance #34 mapping)

Doc's 4-case enum: `{populated, no_signal_detected, pending_analysis, error}`.

Empirical reachability under current producer:

| Status | Trigger | Reachable today |
|---|---|---|
| `populated` | ≥1 row in either flagged or unflagged-conviction-≥50 set | ✅ Yes |
| `no_signal_detected` | 0 rows in either set (specialist fired but no signal-bearing reads in window OR specialist hasn't fired enough yet) | ✅ Yes — single empty-state branch (`no_history` warning) maps here |
| `pending_analysis` | Producer truly absent for this ticker | ❌ Conflated with `no_signal_detected` — distinguishing would require an extra query "does ticker have ANY reads in window regardless of conviction floor." Per organ #9 finding, producer always writes per fire; absence means specialist hasn't fired enough yet. The B-4 brain_consumer_freshness_rth invariant covers producer-down case at a different layer. **Resolution per #34: conflate with `no_signal_detected`; document the conflation; specialist freshness invariant is the orthogonal signal for producer absence.** |
| `error` | DB query error / exception in helper | ✅ Yes — `flagged_query_error`, `unflagged_query_error`, `fetch_error` paths |

Plus configuration violation: `no_ticker_focus` (caller didn't pass `tickerFocus`) → maps to `error` (contract violation, not data-state).

**No new OrganStatus enum case.** Existing 4-case enum sufficient. Conflation of pending_analysis into no_signal_detected is honest under current producer instrumentation.

## Field-mapping (no doc-spec interface to compare; using existing helper output)

The helper already returns a structured `SpecialistRecallResult` shape (lines 143-150). Bundle Phase 2 adds `organMetadata` alongside existing `data` + `meta`, no rename of existing fields.

## Implementation shape locked for post-RTH ship

### Imports
Add `OrganMetadata, OrganStatus` to the `contextHelper.ts` type imports.

### Helper function
```ts
function buildOrganMetadata(
  asOf: string,
  ticker: string | null,
  lookbackHours: number,  // derived from UNFLAGGED_LOOKBACK_DAYS * 24
  status: OrganStatus,
): OrganMetadata {
  return {
    as_of: asOf,
    source: '_shared/specialistRecallContext.ts / ct_specialist_reads + ct_flags + ct_flag_grades + ct_specialist_scoreboard_v2 (chronological recall — semantic recall not yet shipped; cotrader audience only)',
    window: ticker
      ? `last ${FLAGGED_CAP} flagged + last ${UNFLAGGED_CAP} unflagged-conviction-≥${UNFLAGGED_CONVICTION_FLOOR} within ${UNFLAGGED_LOOKBACK_DAYS}d for ${ticker}`
      : 'no ticker focus (recall is per-entity)',
    status,
  };
}
```

### emptyResult signature change
```ts
function emptyResult(
  startedAt: number,
  ticker: string | null,
  warning?: string,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<SpecialistRecallResult>
```
Each call site supplies the right status:
- `no_ticker_focus` → `'error'` (contract violation)
- `flagged_query_error` / `unflagged_query_error` / `fetch_error` → `'error'`
- `no_history` → `'no_signal_detected'`

### Success path
At return statement (line 420), add `organMetadata: buildOrganMetadata(asOf, ticker, ..., 'populated')` alongside `data` and `meta`. Use the same `asOf` ISO string for `data.generated_at`, `meta.fetchedAt`, and `organMetadata.as_of`.

### Per-ticker `ticker_status` field
**NOT ADDED.** Single-ticker output makes per-ticker granularity inapplicable. Implementation comment in `RecallEntry` interface documenting this design choice (so future readers don't ask "where's ticker_status?" and add it incorrectly).

### Schema doc + Phase 2 marker
`docs/system-map/organ-metadata-schema.md` Phase 2 progress 8/10 → 9/10 → 10/10 (organ #9 + organ #10 pair-shipping post-RTH).

### Warden auto-cover
`organ_metadata_completeness_specialist_recall` invariant from `20260508010000` migration auto-engages on first populated organ-level write via the EXISTS guard pattern.

## Acceptance criteria for post-RTH ship

- [ ] organMetadata populated on success / 4 empty paths
- [ ] Status mapping: populated for non-empty result; no_signal_detected for empty-recall; error for query/exception/no-ticker-focus
- [ ] No `ticker_status` field added (single-ticker organ; design mismatch with doc resolved)
- [ ] Implementation comment documents chronological-vs-semantic boundary
- [ ] End-to-end via fresh-Deno orchestrator: `audience='cotrader'`, `tickerFocus='SPY'` → `organ_status='populated'`
- [ ] paper_claude audience excludes the organ entirely (existing audienceFilter behavior); no organMetadata to validate for that audience
- [ ] `organ_metadata_completeness_specialist_recall` warden invariant auto-engages clean on next 30-min tick
- [ ] Schema doc Phase 2 marker advances 9/10 → 10/10 (assuming organ #9 ships first or alongside)

## New cascade catalog instances surfaced

- **#38 candidate** — `mirror-design-pattern-must-respect-organ-output-shape`: when a scoping doc says "mirror organ X's design pattern," verify the new organ has the same output cardinality (multi-entity vs single-entity, array vs scalar). Doc author's mental model assumed organ #10 had organ #9's multi-ticker shape; it doesn't. Mirroring at the wrong cardinality forces structurally-inapplicable design choices (here: per-ticker `ticker_status` on a single-ticker organ).

## Verdict

**Clean enough to authorize post-RTH ship.** One shape adjustment from doc's "mirror organ #9" framing — drop the per-ticker `ticker_status` field (single-ticker organ, doesn't apply). Otherwise, all 5 verification points cleared:

1. ✅ Storage table verified (no dedicated recall table; composes from `ct_specialist_reads + flags + grades + v2 enrichment`)
2. ✅ Audience-gating already in place at helper level
3. ✅ State mapping resolved per #34 discipline (4-case enum, conflate pending_analysis into no_signal_detected, document)
4. ✅ No race conditions (deterministic Promise.all snapshot)
5. ✅ Chronological boundary confirmed; semantic recall remains future work

**No rescope blocker.** Post-RTH session ships organ #9 (per `fa4c154`) + organ #10 (per this audit) → Bundle Phase 2 closes at 10/10.
