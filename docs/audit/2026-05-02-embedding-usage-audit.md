# 2026-05-02 — Voyage embedding usage audit (CT vs JAC)

**Question:** Is the Voyage embedding layer (voyage-3-lite, 512-dim) actually being used by Co-Trader for the recall steps that depend on it semantically, or is CT growing up *next to* the embedding layer instead of *through* it?

**Verdict: PARTIALLY WIRED — load-bearing organ is chronological, not semantic.**

- Embedding generation IS alive on CT (4 ct_* tables populated, 838 polymorphic rows in ct_embeddings, 544/544 ct_observations embedded).
- Three CT helpers ARE designed for semantic recall (`regimeContext.ts`, `analogsContext.ts`, `memoryRecall.ts`).
- **But:** the most load-bearing recall organ — `specialistRecallContext.ts`, the per-ticker recall property that landed 2026-05-01 — is **purely chronological**: `.order('updated_at', { ascending: false }).limit(5)`. No embedding query. No similarity. No `<=>` operator. No `voyageEmbed` call. The C1 hit-rate experiment that runs through 2026-05-15 is measuring a recall layer that is filter-by-time, not similarity-by-embedding.
- **And:** the `regime` brain organ has 0 telemetry rows in 7 days — built but never invoked. The `analogs` helper has 440 invocations / 0 successes — `ct_session_embeddings` has exactly 1 row.
- **And:** the forensic platform we just shipped (`ct_observed_patterns` + `ct_flag_analysis_corpus`) has no semantic axis. `ct_observed_patterns` has no embedding column at all. `ct_flag_analysis_corpus` projects `flag_embedding` but only ~1% of rows have one and no helper RPC uses it.

CT did grow up next to the embedding layer. Voyage runs every day on CT, but the connections that would make recall *semantic* (the specialist's per-ticker organ, the forensic-platform's "find me past patterns like this current setup") are wired chronologically or as plain SQL.

---

## Pre-step verification — model + dim are current

`supabase/functions/_shared/ctEmbed.ts:15-17`:

```ts
const VOYAGE_API_URL = 'https://api.voyageai.com/v1/embeddings';
const VOYAGE_MODEL = 'voyage-3-lite';
const VOYAGE_DIM = 512;
```

Live call signature confirmed. CLAUDE.md claim matches code. Length-validated at line 67-69. ✓

---

## Item 1 — ct_* embedding columns: schema + population

| table | column | total rows | populated | population % | notes |
|--|--|--:|--:|--:|--|
| `ct_embeddings` (polymorphic) | `embedding` | **838** | 838 | **100%** | central catalog: observation 462 / news 267 / flag 52 / alert 34 / report 16 / lesson 7 / **thesis 0 / james_view 0** |
| `ct_observations` | `embedding vector(512) NOT NULL` | 544 | 544 (NOT NULL constraint) | 100% | every observation embedded — write-time hook works |
| `ct_session_embeddings` | `embedding` | **1** | 1 | 100% | ct-session-analog `build` mode fired exactly once (2026-05-01 21:30 UTC). Source for analogs helper — effectively empty. |
| `ct_regime_history` | `embedded_state vector(512)` | 33 | 33 | 100% | Pulse v2 just shipped 2026-05-02; 33 manual fires seeded; first auto-fire Mon 2026-05-04. |
| `ct_observed_patterns` | (none) | 11 | n/a | — | **No embedding column at all.** Pattern signatures use jsonb only. |
| `ct_flag_analysis_corpus` (MV) | `flag_embedding` (projected) | 5,255 | ~52 | **~1%** | Embedding projected from `ct_embeddings WHERE item_type='flag'`. Sparse — only specialist-source flags from one window were ever embedded as `item_type='flag'`. |

**Two structural finds:**
- `CtItemType` declares `'thesis'` and `'james_view'` but neither has ever been written. Either dead enum members or unfinished pipelines.
- `ct_flag_analysis_corpus.flag_embedding` is the right idea but unused at 1% coverage — see Item 5.

---

## Item 2 — CT-side embedding generation calls

| function | role | mode |
|--|--|--|
| `_shared/ctEmbed.ts` | central helper (`voyageEmbed`, `embedCtItem`) | utility |
| `_shared/sessionEmbedding.ts` | session-state vector builder | utility |
| `ct-regime-capture/index.ts` | embeds regime rich_text on every fire | write-time hook |
| `ct-session-analog/index.ts` | builds + persists daily session embedding | scheduled (build mode) |
| `ct-recall/index.ts` | embeds queries for ad-hoc recall | query-time |
| `ct-chat/index.ts` | embeds user message for context retrieval | query-time |
| `ct-playbook-curator/index.ts` | embeds curated playbook items | write-time |
| `ct-reflect-to-jac/index.ts` | embeds CT reflections to feed JAC | bridge (cross-facet) |

**JAC parallel (for comparison):**
- `jac-reflect`, `jac-dispatcher`, `jac-heartbeat`, `distill-principles`, `extract-entities`, `smart-save`, `search-memory`, `generate-embedding`, `backfill-embeddings`, `find-related-entries` — embeds on every save + reflection + entity extraction.

CT generates ≈8 distinct embedding-write paths; JAC generates ≈10. Volume rough-comparable; semantic *write* layer is not the gap.

---

## Item 3 — CT-side semantic recall: per-consumer mode

This is the load-bearing table. For every CT recall call site, what mode is it actually in?

| consumer / helper | recall mode | code site | evidence |
|--|--|--|--|
| **`specialistRecallContext.ts`** (per-ticker recall organ — C1 measurement) | **chronological** ❌ | `_shared/specialistRecallContext.ts:293-312` | `.from('ct_specialist_reads').eq('ticker', ticker).order('updated_at', { ascending: false }).limit(FLAGGED_CAP)` for flagged set; same shape for unflagged-conv≥50 set. **No `voyageEmbed`. No `<=>`. No similarity RPC.** Pulls last N reads by time, full stop. |
| `regimeContext.ts` (Pulse v2 analogs) | **semantic** ✅ | `_shared/regimeContext.ts:243-305` | `cachedEmbed(richText)` → `supabase.rpc('search_ct_regime_analogs', { query_embedding, match_threshold, match_count, ticker_filter, exclude_after_ts })`. Returns analogs by cosine. |
| `analogsContext.ts` (session analogs) | semantic ✅ but DORMANT | `_shared/analogsContext.ts:147-178` | `supabase.rpc('search_ct_session_analogs', { query_embedding, match_threshold, match_count, exclude_date })`. **But:** ct_session_embeddings has 1 row — analog query has nothing to find. Helper fires 440×/wk, succeeds 0× (see Item 4). |
| `memoryRecall.ts → getSimilarPastSetups` (ct-watcher's "similar past setups") | **semantic** ✅ | `_shared/memoryRecall.ts:163-195` | `voyageEmbed(queryText, 'query')` → `supabase.rpc('ct_similar_items', { p_instrument, p_query_embedding, p_limit })`. Pre-gated on `count >= 3` to skip when corpus empty. |
| `memoryRecall.ts → getRecentItems` ("recent observations/flags/alerts") | chronological | `_shared/memoryRecall.ts:111-155` | Plain `.order('created_at', desc).limit(N)` per type. Filter-by-time, not by similarity. |
| `memoryRecall.ts → getRelevantLessons` | filter-based | `_shared/memoryRecall.ts:267-284` | `.eq('active', true).or('instruments.cs.{...},instruments.is.null').order('created_at', desc)`. No embedding. |
| `memoryRecall.ts → getActiveBiases` | filter-based | `_shared/memoryRecall.ts:245-261` | `.eq('active', true).order('severity', desc)`. |
| `memoryRecall.ts → getRecentSelfCorrections` | chronological | `_shared/memoryRecall.ts:214-230` | `.gte('regraded_at', cutoff).order(..., desc).limit(5)`. |
| `crossFacetMemory.ts` (CT pulling from JAC's brain) | **semantic** ✅ | imports `voyageEmbed` (from grep), uses `<=>` operator | bridge between CT and JAC's pgvector brain |
| `claudeReadSurface.ts → buildClaudeContext` | orchestrator | reads via the helpers above | doesn't touch embeddings directly; just composes helpers |
| `corpus_baseline / slice_by / find_anomalies` (forensic platform) | **SQL group-by only** | `supabase/migrations/20260502070000_corpus_unified_verdict.sql` | Pure GROUP BY on whitelisted dimension columns. No vector op. No similarity threshold. |

**The wiring gap is not "no semantic recall on CT."** The wiring gap is **"the load-bearing per-ticker organ pulls by time."** Specialist recall — the most-fired CT recall path, audience-locked to cotrader, the C1 measurement target — does not use embeddings. By design (per the comment block on lines 75-79 of `specialistRecallContext.ts`): "Last 5 flagged reads + Last 5 conviction-≥50 reads, by `updated_at`."

This is not the comment claiming semantic recall and the code doing chronological. The doc-comment on line 4-15 *does* describe what it does correctly (chronological). But the *design intent* — at the top of `END_STATE_VISION.md`'s "captain remembers the last storm" line — implies similarity-based recall, and that's what the user expected.

---

## Item 4 — call-volume comparison (past 7 days)

Source: `ct_brain_telemetry` via `get_brain_health(window_hours => 168)`.

### Helpers ranked by invocations

| helper | invocations | success | skipped | warnings | p50 ms | embedding-driven? |
|--|--:|--:|--:|--:|--:|--|
| tape | 440 | 388 | 52 | 0 | 144 | no |
| detector | 440 | 388 | 52 | 0 | 199 | no |
| event_recency | 440 | 388 | 52 | 0 | 201 | no |
| flow_heatmap | 440 | 388 | 52 | 0 | 493 | no |
| james_flags | 440 | 0 | 89 | 351 | 129 | no |
| news_causality | 440 | 388 | 52 | 0 | 215 | no |
| pulse | 440 | 388 | 52 | 0 | 201 | no (V1 pulse, not v2 regime) |
| specialist | 440 | 388 | 52 | 0 | 147 | no |
| **analogs** | **440** | **0** | **104** | **336** | **141** | **YES — but dormant** |
| **specialist_recall** | **241** | **55** | **67** | **119** | **0** | **NO — chronological** |
| **regime** | **0** (no rows in `ct_brain_telemetry`) | — | — | — | — | YES — but **never invoked** |

**The two embedding-driven helpers are the worst-performing rows in the table.** `analogs` runs 440 times, succeeds 0 times. `regime` is registered in code but has zero telemetry — it isn't being orchestrated by any consumer in the past 7 days. `specialist_recall` is chronological by implementation.

### Top consumers (past 7d, all helpers combined)

| consumer | invocations |
|--|--:|
| ct-trade-idea-generator | 908 |
| ct-tape-reader | 828 |
| ct-watcher | 387 |
| ct-hypothesis-health-check | 311 |
| ct-news-sweep | 153 |
| ct-curiosity | 153 |
| ct-alert-post-mortem | 144 |
| ct-eod-report | 80 |
| ct-specialist-{qqq, spy, iwm, tsla, ...} | 30-70 each |
| ct-self-grader | 46 |
| ct-daily-brief | 38 |
| ct-eod-specialist-narrative | 30 |
| (24 more) | <30 each |

**Specialist consumers (10 specialists × peers split = 20 named consumers) generate 30-70 calls each per week.** Each call hits `specialist_recall` — chronological. Specialist recall is the highest-fan-in CT consumer of recall, and it's not using embeddings.

JAC equivalent (rough): jac-reflect, search-memory, jac-dispatcher all use semantic recall on every invocation. JAC's load-bearing recall = embedding-driven. CT's load-bearing recall = time-ordered.

---

## Item 5 — the unmistakable signal: forensic platform is fully SQL

**`ct_observed_patterns`** (shipped 2026-05-02 night, 11 rows now):

- Schema: `id bigserial PK, pattern_signature jsonb, description text, n_observed int, hit_rate_blended numeric, hit_rate_per_axis jsonb, baseline_delta numeric, regime_conditional bool, recommended_action text, status text, captured_at timestamptz, last_validated_at, captured_by, notes`.
- **No embedding column.** No `vector(512)`. No GIN index for similarity. The GIN on `pattern_signature` is for jsonb containment (`@>` operator), not similarity.
- **Implication:** if a specialist fires a flag and we want to ask "does this current setup look semantically like any of our 11 captured patterns?", the answer is "we cannot ask that." We can only ask "does this setup match the exact dimension values in any pattern's `pattern_signature`?"

**`ct_flag_analysis_corpus`** (the wide MV):

- Projects `flag_embedding` and `flag_embedding_metadata` from `ct_embeddings WHERE item_type='flag'` — a deliberate join I wrote into the migration (`20260502060000_ct_flag_analysis_corpus.sql:295-296`).
- Population: ~52 of 5,255 = **1%**. Only flags that were embedded at write-time (a sliver of the corpus from a window when flag-embedding ran) are queryable.
- **None of the helper RPCs use it:** `corpus_baseline`, `slice_by`, `find_anomalies` are pure SQL GROUP BY on whitelisted dimension columns. Zero `<=>`, zero `vector()`, zero similarity threshold.

The forensic platform was designed and shipped without an embedding axis. The "deferred Phase 5 pattern feedback loop" design doc (`docs/decisions/2026-05-02-pattern-feedback-loop-design.md`) proposed jsonb-containment matching (`pattern_signature @>`), not similarity matching. Even the deferred plan doesn't use embeddings.

---

## Wiring gaps — places where the design implies semantic but the code is chronological / SQL-only

| where | file:line | current mode | gap |
|--|--|--|--|
| Specialist recall organ (per-ticker history) | `_shared/specialistRecallContext.ts:293-312` | `.order('updated_at', desc).limit(N)` | **Chronological.** Pulls "last N flagged reads on ticker" — not "N most semantically similar past reads." The C1 hit-rate experiment is measuring filter-by-time. |
| Regime brain organ orchestration | `_shared/regimeContext.ts` exists, code path correct | helper has **0 invocations in 7 days** | Built but no consumer requests `organs.regime`. Either not in any consumer's `helpers` list passed to `buildClaudeContext`, or every consumer is running `paper_claude` audience and the audienceFilter is excluding it. Worth grepping `claudeReadSurface.ts` consumers for who passes the regime helper through. |
| Session analogs | `_shared/analogsContext.ts:147-178` correct | **0 successes / 440 invocations** | Source data empty. `ct_session_embeddings` has 1 row. The `ct-session-analog` build mode hasn't been firing on cron — needs verification. |
| ct_observed_patterns matching | (no code) | jsonb @> only | No embedding column, no similarity path. The deferred Phase 5 design also stays jsonb-only. |
| Forensic helper RPCs | `supabase/migrations/20260502070000_corpus_unified_verdict.sql` | SQL GROUP BY | `find_anomalies` doesn't have a "find N most similar past flags to this current setup" axis. The corpus has the embedding column projected; it's just unused. |
| `getRecentItems` (memoryRecall) | `_shared/memoryRecall.ts:111-155` | `.order('created_at', desc).limit(4)` per type | "Recent observations/flags/alerts" pulled chronologically, not by similarity to current state. Lessons same. |
| `CtItemType` declares `'thesis'` and `'james_view'` | `_shared/ctEmbed.ts:19-27` | 0 rows of either type ever written | Either dead enum members or unfinished pipelines — embedding layer can't recall what was never written. |

---

## What works (so the verdict isn't unfairly negative)

- **All 544 ct_observations rows are embedded** (NOT NULL column). Write-time hook is solid.
- **Pulse v2 regime organ embeds rich_text on every capture** — 33/33 embedded, ready for similarity queries the moment a consumer asks.
- **Cross-facet memory bridge (`crossFacetMemory.ts`) is semantic.** When CT pulls JAC's reflections, it's by similarity.
- **`memoryRecall.getSimilarPastSetups`** correctly uses `voyageEmbed` + `ct_similar_items` RPC — when called by ct-watcher, semantic recall on past setups works.
- **No model/dim drift:** voyage-3-lite, 512-dim, both verified live in code.

---

## Recommendation framing (no fixes proposed — this is audit-only)

The user's framing was right: "is the embedding-layer foundation actually being used by the limb that needs it most." The answer:

- **Foundation is alive.** Embeddings are being generated on CT every day. The infrastructure is in place.
- **Some limbs use it.** Pulse v2 regime analogs, session analogs (when the source isn't empty), cross-facet bridge, ct-watcher's memoryRecall — these are wired correctly.
- **The most load-bearing limb does not.** Specialist recall — the per-ticker organ that fires every ~6 minutes during RTH for 10 specialists — is filter-by-time. The C1 hit-rate experiment running through 2026-05-15 is measuring a chronological recall layer, not a semantic one.
- **The newest limb (forensic platform) doesn't either.** ct_observed_patterns + ct_flag_analysis_corpus are pure SQL. Pattern matching is jsonb-containment.

CT did grow up next to the embedding layer. The embedding layer feeds Pulse v2 and crosses to JAC — but the per-ticker recall and the forensic platform are separate plumbing.

---

## C1 verification window note

**Per the user's brief: do NOT attempt to fix specialist recall during the window.** Audit confirms a wiring gap there but the fix is post-2026-05-15. The current chronological behavior IS what the C1 experiment is measuring; perturbing it now invalidates the falsifiability.

The other gaps (analogs source population, regime helper consumption, forensic embedding axis) are unrelated to C1 and could be addressed independently — but those decisions are the user's, not this audit's.

---

## Appendix — files inspected

- `supabase/functions/_shared/ctEmbed.ts` (utility)
- `supabase/functions/_shared/specialistRecallContext.ts` (chronological)
- `supabase/functions/_shared/memoryRecall.ts` (mixed: semantic similarPastSetups + chronological recents/lessons)
- `supabase/functions/_shared/regimeContext.ts` (semantic, dormant)
- `supabase/functions/_shared/analogsContext.ts` (semantic, source-empty)
- `supabase/functions/_shared/sessionEmbedding.ts` (utility)
- `supabase/functions/_shared/crossFacetMemory.ts` (semantic, bridge)
- `supabase/functions/_shared/chatPromptV1.ts` (mentions analogs warning, no recall logic)
- `supabase/migrations/20260416000001_ct_schema.sql` (ct_observations.embedding NOT NULL)
- `supabase/migrations/20260420000016_session_analogs.sql` (search_ct_session_analogs RPC)
- `supabase/migrations/20260502040400_search_ct_regime_analogs.sql` (search_ct_regime_analogs RPC)
- `supabase/migrations/20260502060000_ct_flag_analysis_corpus.sql` (forensic MV — embedding projected, unused)
- `supabase/migrations/20260502060200_ct_observed_patterns.sql` (no embedding column)
- `supabase/migrations/20260502070000_corpus_unified_verdict.sql` (helper RPCs — pure SQL)

Live DB probes against rvhyotvklfowklzjahdd.supabase.co — read-only via PostgREST + RPCs.
