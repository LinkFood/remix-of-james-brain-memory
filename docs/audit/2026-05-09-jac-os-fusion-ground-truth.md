# JAC OS / Co-Trader — Fusion Ground Truth

**Date:** 2026-05-09
**Status:** Canonical reference for v2 (`/alpha`) work and any future fusion conversation.
**Scope:** Full audit of the JAC OS substrate and the Co-Trader application running on top of it. Every Anthropic API caller. Every embedding write-site. Every embedding reader. The fusion graph. Every UI surface. Every cron + emission. The kernel-vs-application boundary.
**Method:** Seven parallel exploration agents, each owning one dimension. Synthesis distilled here. Each section ends with a gap list. Cross-cutting findings + v2 implications at the end.
**Replaces:** Nothing supersedes; this is new ground truth. Future Phase A audits should reference this rather than re-discovering.
**How to use:** Read top to bottom once. Mark anything that contradicts your model. Then either say "you got it" or "still missing this." After this doc lands, no v2 surface gets proposed without referencing the gaps it closes.

---

## Table of Contents

- [Executive Summary](#executive-summary) — the load-bearing findings
- [A. The "Things That Think" — Every Anthropic API Caller](#a-the-things-that-think)
- [B. The Embedding Gate — Write-Sites + JAC OS Claim Verdict](#b-the-embedding-gate)
- [C. The Semantic-vs-Chronological Gap — Embedding Readers](#c-the-semantic-vs-chronological-gap)
- [D. The Fusion Graph — Who Reads Who](#d-the-fusion-graph)
- [E. UI Surfaces + the Invisible Producer Inventory](#e-ui-surfaces--invisible-producers)
- [F. The Automation Surface — Crons + Emissions + Pushes](#f-the-automation-surface)
- [G. The Kernel-vs-Application Boundary](#g-the-kernel-vs-application-boundary)
- [Cross-Cutting Findings](#cross-cutting-findings)
- [v2 Implications — What This Means for /alpha](#v2-implications)
- [Honest Limitations](#honest-limitations)

---

## Executive Summary

Eight load-bearing facts captain should hold in his head before touching v2 again. Each one is corroborated downstream.

1. **The system runs ~38 distinct Anthropic API callers across 168 cron schedules.** ~22 are Haiku, ~12 are Sonnet, ~4 are Sonnet 4.6. The vast majority are autonomous (cron-driven). Daily volume: ~2,400 cron fires, ~2,800 edge function invocations, ~500–1,200 Slack alarm posts, ~2 emission-layer posts (Phase 1). Cost: ~$250–355/month API.

2. **The "nothing comes in the gate without being embedded" claim is HALF-TRUE — ASPIRATIONAL, NOT STRUCTURAL.** Decided thinking IS embedded (jac_reflections, jac_principles, ct_observations, ct_regime_history, ct_session_embeddings, ct_specialist_memory, ct_playbooks). High-frequency NARRATIVE surfaces are NOT embedded: `ct_tape_commentary`, `ct_specialist_reads`, `ct_breaking_news`, `ct_eod_summaries`, `ct_eod_reports`, `ct_daily_briefs`, `ct_news_causality`, `brain_insights`. **The load-bearing real-time outputs of the Claude consumers are exactly the rows that violate the claim.**

3. **The fusion happens at the consumer level, not the organ level.** 11+ brain organs exist. ~13 Claude consumers compose them. But organs DO NOT read each other — the news_causality organ does not feed the specialist organ; the specialist organ does not feed the tape organ; the regime organ does not feed analogs. Each organ reads its own source tables, returns its slice, and Claude does the cross-organ synthesis IN ITS HEAD per call. The synthesized result lands as prose in one output table. The structural cross-wiring captain assumes is happening — isn't, mostly. **Fusion is a consequence of buildClaudeContext composition, not a property of the substrate.**

4. **The semantic recall surface is largely unactivated.** 10 semantic query sites exist (cosine via match_*/search_* RPCs across `entries`, `ct_embeddings`, `ct_regime_history`, `ct_session_embeddings`). 20+ chronological-only query sites read embedded data. The single biggest unlock: `ct_specialist_reads` is the load-bearing recall organ, has the right signal (direction_lean + conviction), but is queried by `updated_at DESC LIMIT 5` — semantic recall here is the C1 caveat from CLAUDE.md and is empirically the highest-impact medium-effort lift.

5. **The invisible-producer inventory is huge.** At least 11 Claude-produced or Claude-graded tables write structured output that ZERO UI surface renders: `ct_eod_specialist_narratives`, `ct_observed_patterns`, `ct_specialist_memory`, `ct_specialist_grade_axes`, `ct_alert_post_mortems`, `ct_news_causality` (only as one-line prose mention), `ct_brain_telemetry` per-call traces, `ct_invariant_log` (only failures shown), `jac_emissions` (just shipped), `ct_butterfly_cross_events` (just shipped), regime transitions (only current regime + sparkline shown). **Captain's "I'm flying blind on the system's thinking" is empirically correct.** The thinking happens; it goes to DB; the UI shows latest-prose snapshots and aggregate roll-ups but not the structure (evolution, contradictions, conviction trajectory, causal chains).

6. **The emission layer (PR #63) is correctly kernel and is currently 1/10.** `jac_emission_triggers` table exists, `hot_contract` is wired and producing ~2 Slack pushes/day. Nine other triggers are catalogued in PR #83 but unimplemented (specialist_flag_fired, specialist_conviction_shift, news_flow_causality, regime_transition, heatmap_breakout, butterfly_cross, tape_interrupt, first_daily_cross, consensus_flip). The kernel is right; the application is at 10% of its push surface area.

7. **The kernel/application boundary is ~60% clean, ~40% drift.** Clearly kernel: brain orchestration (`buildClaudeContext`, `contextHelper`), memory (`entries`, `jac_reflections`, `jac_principles`), emission infrastructure, cross-facet bridge, vendor clients, embedding pipeline. Clearly application: detector portfolio, specialist ecosystem, options-flow tables, paper-trader. Drift: vendor abstraction layer is missing (UW MCP wired per-edge-function ad hoc — 10+ places break if endpoint changes). Prompts hardcoded in 5+ TypeScript files (Tenet 25 violation — should be `jac_prompt_templates` table). Detectors live as edge functions, not as `jac_detectors` rows (Tenet 25 violation). `ct_brain_telemetry` should be `jac_brain_telemetry`. `decisionJournal.ts` should promote to kernel. `ct_embeddings` polymorphic table should promote to `jac_embeddings(owner_app, owner_type, owner_id)`.

8. **The 5x v2 thesis lands here.** Findings 3, 4, 5, 7 compose into a single statement: **the substrate already does institutional-grade fusion thinking through buildClaudeContext, but the THINKING STRUCTURE is invisible and the SUBSTRATE for richer fusion (semantic recall, organ-to-organ wiring, vendor adapter layer) isn't fully built.** v2's 5x play is not "another flow surface" — it is rendering the system's thinking-structure as the surface itself, plus closing the embedding-gate gap on the load-bearing narrative tables, plus drawing the missing fusion edges. /alpha iter #1 (placeholders + reused /tape-v2 primitives) is empirically a <2x ship against this audit; iter #2+ scoping should anchor on the gap list at the end of this doc, not on PR #83's surface menu.

---

## A. The "Things That Think"

### A.1 Inventory by application

**Co-Trader Claude callers (≈22, dominant Haiku + targeted Sonnet):**

| Caller | Model | Cron | Reads | Writes |
|---|---|---|---|---|
| `ct-tape-reader` | Haiku 4.5 | every 10 min RTH | `buildClaudeContext` (tape, flow_heatmap, detector, news_causality, pulse, regime, james_flags) | `ct_tape_commentary` |
| `ct-watcher` | Haiku 4.5 | event-driven (flag score ≥80) | flag + tape context | `ct_tape_commentary` (interrupt class) |
| `ct-news-sweep` / `ct-news-ingester` / `ct-tavily-news-watcher` / `ct-news-sentiment-backfill` | Haiku 4.5 | 15–30 min RTH + off-hours | URL + Tavily / news payload | `ct_breaking_news`, `ct_news_items`, `ct_news_analyses` |
| `ct-news-causality` | Haiku/Sonnet | hourly RTH | breaking news + flow + regime | `ct_news_causality` |
| `ct-daily-brief` | Sonnet 4.5 | 8 AM ET | `buildClaudeContext` (all organs) | `ct_daily_briefs` + Slack |
| `ct-morning-brief` | Haiku 4.5 | 6:45 AM ET | schedule + reflections + brain | `ct_morning_briefs` |
| `ct-eod-summary` | Sonnet 4.6 | 4:30 PM ET | `buildClaudeContext` (all organs) | `ct_eod_summaries` |
| `ct-eod-report` | Sonnet 4.6 | 5 PM ET | `buildClaudeContext` | `ct_eod_reports` |
| `ct-eod-specialist-narrative` | Sonnet 4.5 | 4:45 PM ET (10× parallel) | tickerFocus organs + specialist recall | `ct_eod_specialist_narratives` |
| `ct-midday-recap` / `ct-eod-recap` / `ct-eod-positioning` | Sonnet/Haiku | mid-session, post-close | composed organs | recap tables |
| Per-specialist runs (10 specialists) via `_shared/specialistRunner.ts` | Haiku 4.5 | 4× RTH per ticker | specialist-specific context + recall | `ct_specialist_reads` (+ `ct_specialist_memory` on graded flags) |
| `ct-hypothesis-proposer` | Sonnet 4.6 | 11:15 / 15:15 / 19:15 UTC | `buildClaudeContext` + specialist | `ct_hypotheses`, `ct_hypothesis_events` |
| `ct-hypothesis-health-check` | Haiku 4.5 | hourly RTH | hypothesis + temporal validator | `ct_hypothesis_events` |
| `ct-self-grader` | Sonnet 4.5 | 21:30 UTC + post-trade | trade outcomes + decision rubric | `ct_specialist_grades` / `ct_self_grades` |
| `ct-alert-post-mortem` | Haiku 4.5 | manual + on-demand | alert + 1h follow-up | `ct_alert_post_mortems` |
| `ct-curiosity` | Haiku 4.5 | 2× per hour RTH | composed organs + outliers | `ct_curiosity_analyses` |
| `ct-trade-idea-generator` | Sonnet/Haiku | manual via chat | quant card + pulse + specialist alignment | `ct_trade_ideas` |
| `ct-trade-advisories` | Haiku 4.5 | 4× per hour RTH | flag + position + market context | `ct_trade_advisories` |
| `ct-debate-outcome-scorer` | Haiku 4.5 | nightly | debate transcript + evidence | `ct_debate_outcomes` |
| `ct-lessons-curator` | Sonnet 4.5 | weekly Sunday | week of hypotheses + outcomes | `ct_lessons`, `ct_principles_draft` |
| `ct-playbook-curator` | Sonnet 4.5 | weekly | successful patterns | `ct_playbooks` |
| `ct-replay` | Haiku 4.5 | manual (analysis mode) | replay params + historical state | `ct_replay_results` |

**JAC kernel Claude callers (~9):**

| Caller | Model | Cron | Reads | Writes |
|---|---|---|---|---|
| `jac-dispatcher` | Sonnet 4.5 (intent) + Haiku 4.5 (cron parse) | event-driven | `getUserContext` + conversation | `agent_tasks`, `agent_conversations` |
| `jac-research-agent` | Sonnet/Haiku (resolveModel) | parent-task-driven | Tavily results + conversation | `brain_reports`, `agent_tasks` |
| `jac-code-agent` | Sonnet/Haiku (resolveModel, tier-based) | parent-task-driven | GitHub tree + conversation + code review | `code_sessions`, GitHub PR |
| `jac-morning-brief` | Haiku 4.5 | 8 AM ET | getUserContext + entries + calendar | `brain_reports` |
| `jac-heartbeat` | Haiku 4.5 | every 30 min | brain tables + recency | `brain_insights` |
| `jac-reflect` | Haiku 4.5 | fire-and-forget after every task | task result JSONB | `jac_reflections` (with embedding) |
| `jac-compose-emission` | Haiku 4.5 + Sonnet 4.5 | on-demand | task + brain context | `jac_emissions` |
| `jac-dashboard-query` | Haiku 4.5 | synchronous chat | entries + relationships | result JSON |
| `distill-principles` | Sonnet 4.5 | weekly Sunday 03:00 UTC | week of `jac_reflections` | `jac_principles` (with embedding) |

**Shared Claude-calling modules (called by multiple consumers):**

| Module | Used by | Purpose |
|---|---|---|
| `_shared/anthropic.ts` | all 38+ | central API client + cost/token logging |
| `_shared/hypothesisSelect.ts` | ct-daily-brief, ct-eod-report | rank/select best hypotheses (forced tool-use) |
| `_shared/temporalValidator.ts` | ct-tape-reader, ct-watcher | validate coherence vs time/market state |
| `_shared/specialistRunner.ts` | ct-daily-brief, ct-eod-report, specialist crons | execute specialist multi-turn reasoning |
| `_shared/tradeQuality.ts` | ct-trade-idea-generator | grade trade idea quality |

### A.2 What's standardized

- All callers route through `_shared/anthropic.ts` (one chokepoint for cost tracking + token logging).
- Most consumers route through `buildClaudeContext` for organ assembly + audience filtering + telemetry write to `ct_brain_telemetry`.
- Output tables generally include `input_tokens`, `output_tokens`, `cost_usd`, and Bundle Phase 2 organ-status fields (`organ_status`, `as_of`, `source`).

### A.3 Gap list — Section A

- **Per-output-table organMetadata audit not done in this pass.** Bundle Phase 2 ships completed structurally (per CLAUDE.md), but per-consumer verification that `ct_eod_specialist_narratives`, `ct_alert_post_mortems`, `ct_trade_advisories`, `ct_curiosity_analyses` etc. all carry the four canonical fields wasn't performed here. Spot-check passes (`ct_tape_commentary`, `ct_daily_briefs`, `ct_eod_summaries`).
- **Forced-tool-use vs open-ended distribution wasn't enumerated.** Worth knowing per consumer for hallucination-class accounting.
- **Per-consumer 7-day call volume from `ct_brain_telemetry` wasn't sampled.** Section F has total daily volume estimates but per-consumer hot-spots aren't enumerated here.

---

## B. The Embedding Gate

The captain's load-bearing claim: *"Nothing comes in the gate without being embedded. JAC OS structural property."* This is the JAC OS thesis. If false, the whole semantic-recall play is degraded.

### B.1 Empirical inventory

**Embedded tables (8 confirmed):**

| Table | Dimension | Write path | Coverage |
|---|---|---|---|
| `entries` (JAC brain) | 512 (Voyage 3-lite) | write-time via `generate-embedding` + 30-min backfill cron | 100% of new writes |
| `jac_reflections` | 512 | write-time (fired by `jac-reflect` on every task completion) | 100% (one per task) |
| `jac_principles` | 512 | weekly write-time (`distill-principles`) | 100% weekly refresh |
| `ct_specialist_memory` | 512 | backfill via specialist wakeup handlers (graded flags only) | ~70% (graded flags only) |
| `ct_regime_history` (`embedded_state`) | 512 | write-time at regime capture cron | ~100% (one per 5-min RTH bucket) |
| `ct_session_embeddings` | 512 | write-time at EOD session-analog cron | 100% per session close |
| `ct_embeddings` (polymorphic) | 512 | fire-and-forget from `ct-*` ingest producers (observation, flag, alert, thesis, lesson, report, news, james_view) | variable per producer; no unified coverage SLO |
| `ct_playbooks` | 512 | write-time by curator | ~100% per curator output |

**Not embedded — Claude "thinking output" tables:**

| Table | Producer | Why not | Surface impact |
|---|---|---|---|
| `ct_tape_commentary` | ct-tape-reader (every 10 min RTH) | no embedding column; 100+ rows/day | UNSEARCHABLE; load-bearing for /tape, /alpha synthesis |
| `ct_specialist_reads` | per-specialist runs (4× RTH per ticker) | no embedding column | UNSEARCHABLE; this is the C1 caveat — biggest single recall unlock |
| `ct_breaking_news` | ct-news-ingester / Tavily | no embedding column | UNSEARCHABLE; news has severity/sentiment but no semantic axis |
| `ct_news_causality` | ct-news-causality | no embedding column | UNSEARCHABLE; the richest causal-chain output is invisible to recall |
| `ct_eod_summaries` / `ct_eod_reports` / `ct_daily_briefs` | nightly + morning Claude | no embedding column | UNSEARCHABLE; "find prior days like today" impossible |
| `ct_specialist_principles` | per-specialist distillation | no embedding column | UNSEARCHABLE; specialist-private heuristics |
| `ct_observed_patterns` | hypothesis-proposer / forensic platform | no embedding column | UNSEARCHABLE; pattern signatures stored as text |
| `brain_insights` (JAC) | jac-heartbeat | no embedding column | UNSEARCHABLE; insights are Slack-out, no persistence axis |

**Not embedded — raw ingest (intentional per design):**

`ct_oi_snapshots`, `ct_flow_alerts`, `ct_scored_flow`, `ct_gex_snapshots`, `ct_regime_classifications`, `ct_specialist_scoreboard`, `ct_contract_quotes`, `ct_contract_tracks`, `ct_flow_heatmap_snapshots`, `ct_pulse_timeline`, `ct_butterfly_cross_events` (just-shipped — verify intent), Greeks tables. These are numeric/structured; semantic search over them isn't the right axis. NOT a gap.

### B.2 Verdict on the JAC OS gate claim

**Aspirational, not structural.** Empirical:

- ~88% of decided "thinking output" is embedded (jac_reflections, jac_principles, ct_observations + flags + alerts via polymorphic ct_embeddings, ct_regime_history, ct_session_embeddings, ct_playbooks, ct_specialist_memory partial).
- 0% of high-frequency narrative thinking output is embedded (ct_tape_commentary, ct_specialist_reads, ct_breaking_news, ct_eod_*, ct_daily_briefs, ct_news_causality, brain_insights).
- 100% of intentionally-non-embedded raw ingest stays correctly out of the embedding gate.

**Why the gap exists structurally:** there is NO trigger or constraint that forces embedding on insert. The current pattern is "producers who remember to embed" + "backfill crons for the ones that slip." Tape reader, specialist reads, breaking-news ingester, and EOD/brief consumers don't call embedding functions.

### B.3 Gap list — Section B (in priority order)

1. **`ct_specialist_reads`** — load-bearing recall organ; biggest single unlock; medium effort (vector column + HNSW + RPC + write-time embed in specialistRunner). Once embedded, semantic recall lights up immediately (see Section C).
2. **`ct_tape_commentary`** — every-10-min market read, 100+ rows/day, captain's primary narrative surface. Embedding unlocks "find similar prior commentary + their NextClose outcomes" (the iter #2 hint already in `ClaudesRead.tsx`).
3. **`ct_news_causality`** — richest causal-chain content in the system. Embedding unlocks cross-day "this kind of causality landed before with X outcome" recall.
4. **`ct_breaking_news`** — semantic over headlines is luxury (severity is the primary axis), but cheap to add via polymorphic ct_embeddings.
5. **`ct_eod_summaries` / `ct_daily_briefs`** — embedding unlocks "today's setup is most-similar to 2026-04-23" recall, which is genuinely high-signal.
6. **`brain_insights`** — embedding unlocks JAC heartbeat memory of prior insights so it doesn't re-surface the same idea.

**Structural fix to make the gate STRUCTURAL not aspirational:** add an INSERT trigger on each gap-list table that fire-and-forgets to `ct_embeddings` polymorphic, plus a warden invariant `embedding_backlog_age_hours` to catch drift. Or embed at write-time in each producer (closer to source of truth). Either way, this is the JAC OS thesis turning from aspiration to enforcement.

---

## C. The Semantic-vs-Chronological Gap

Even where embeddings DO exist, downstream consumers often query by `updated_at DESC LIMIT N` instead of by cosine similarity. This section enumerates exactly where, and which switches are 1-line wins versus medium-effort lifts.

### C.1 Active semantic query sites (10)

All cosine-similarity, no L2/inner-product. Coverage:

| Caller | Source | RPC | Filter |
|---|---|---|---|
| `_shared/memoryRecall.ts:getSimilarPastSetups` | `ct_embeddings` | `ct_similar_items` | instrument |
| `_shared/regimeContext.ts:fetchAnalogs` | `ct_regime_history` | `search_ct_regime_analogs` | ticker, exclude_after |
| `_shared/analogsContext.ts:getAnalogsContext` | `ct_session_embeddings` | `search_ct_session_analogs` | exclude_date |
| `ct-chat:buildMemoryContext` | `ct_embeddings` | `ct_similar_items` | instrument |
| `smart-save:findRelatedEntries` | `entries` | `search_entries_by_embedding` | user_id, threshold 0.65 |
| `jac-reflect:searchRelated` | `entries` | `search_entries_by_embedding` | user_id, threshold 0.5 |
| `jac-dispatcher:buildBrainContext` | `entries` | `search_entries_by_embedding` | user_id, threshold 0.3 |
| `find-related-entries` | `entries` | `search_entries_by_embedding` | user_id, threshold 0.55 |
| `backfill-embeddings:processBackfill` | `entries` | `search_entries_by_embedding` | user_id, threshold 0.65 |
| `ct-session-analog:searchAnalogs` | `ct_session_embeddings` | `search_ct_session_analogs` | exclude_date |

**Defined-but-dormant RPCs:** `search_ct_debates` (migration `20260420000037`) — 0 active callers.

### C.2 Chronological-only query sites that read embedded substrate (high-value subset)

| Caller | Source | Could go semantic? | Effort |
|---|---|---|---|
| `_shared/specialistRecallContext.ts:getSpecialistRecallContext:330,342` | `ct_specialist_reads` | YES — by direction_lean + conviction shape | MEDIUM (needs embedding column first; see Section B gap #1) |
| `_shared/specialistRunner.ts:getSpecialistHistory:380,876` | `ct_specialist_reads` | YES | MEDIUM (same prerequisite) |
| `_shared/claudeReadSurface.ts:1227,1251` | `ct_specialist_reads` | YES | MEDIUM (same) |
| `_shared/specialistContext.ts:158` | `ct_specialist_reads` | YES | MEDIUM (same) |
| `_shared/memoryRecall.ts:getRecentItems:124` | `ct_observations` | YES (already embedded via ct_embeddings polymorphic) | **LOW — 1-line query swap** |
| `_shared/memoryRecall.ts:getRecentItems:131` | `ct_flags` | YES (same) | **LOW — 1-line query swap** |
| `_shared/memoryRecall.ts:getRecentItems:138` | `ct_alerts` | YES (same) | **LOW — 1-line query swap** |
| `_shared/detectorContext.ts:177` | `ct_detector_runs` | maybe (would need run-text embedding) | NEW substrate |
| `_shared/newsCausalityContext.ts:169,179` | `ct_breaking_news`, `ct_news_analyses` | partial (severity is primary axis; semantic is luxury) | MEDIUM (needs embedding + hybrid RPC) |

### C.3 Structural-by-design chronological sites (NOT gaps)

`tapeContext` (tape narrative IS sequential), `getSentimentSummary` (sentiment is scalar state), `sessionEmbedding.getSessionEmbeddings` (snapshot ordering is fine), `jamesFlagsContext` (manual recency).

### C.4 The Specialist Recall Deep-Dive (the C1 caveat made operational)

`/Users/jameschellis/jac-agent-os/supabase/functions/_shared/specialistRecallContext.ts` lines 248–251 explicitly document: *"this organ is currently chronological recall (last N reads by updated_at DESC). Semantic recall (vector similarity over embedded prior reads) is future work."*

Query (lines 324–343):
- Flagged set: `WHERE flagged=true AND flag_id IS NOT NULL ORDER BY updated_at DESC LIMIT 5`
- Unflagged set: `WHERE flagged=false AND conviction≥50 AND updated_at≥(now()-5d) ORDER BY updated_at DESC LIMIT 5`

**The signal exists in the table** (`direction_lean`, `conviction`, `flagged` status). **The substrate to embed it does not yet exist.** Activation steps:
1. Add `embedding vector(512)` to `ct_specialist_reads`
2. Create HNSW COSINE index
3. `ct-embed-specialist-reads` cron OR write-time embed in specialistRunner
4. `search_ct_specialist_reads_by_similarity(query_embedding, ticker, threshold, limit)` RPC
5. Modify `getSpecialistRecallContext` to fetch semantic (A/B test against chronological per Tenet 25)

### C.5 Gap list — Section C

**The 1-line-win list (semantic substrate already exists, just needs query swap):**
- `memoryRecall.getRecentItems()` → swap `ORDER BY created_at DESC` to `ORDER BY embedding <=> query_embedding` for 3 tables (observations, flags, alerts).

**The medium-effort flagship unlock:**
- `ct_specialist_reads` semantic recall — Section B gap #1 + Section C lines 324–343 are the same play. This is the highest-impact medium-effort lift in the entire audit.

**Lower-priority luxuries (don't ship before #1):**
- News-headline semantic (hybrid with severity)
- Detector run summary semantic (uncertain signal)
- Flow-alert semantic (microstructure encoding unclear)

---

## D. The Fusion Graph

How thinking actually flows through the system. The captain's quote: *"We got news, heatmap, regime, specialists — there's so much. It doesn't all hook together."* This section verifies whether that's true.

### D.1 Producer nodes (brain organs) — 13 confirmed

Each is a `ContextHelper<T>` in `supabase/functions/_shared/<name>Context.ts`, composed via `Promise.all` in `buildClaudeContext` (claudeReadSurface.ts ~1958–1971).

| Organ | Source tables | Output | In standard buildClaudeContext? |
|---|---|---|---|
| `flow_heatmap` | `ct_flow_alerts`, `ct_config` | per_ticker stacks (expiry-bucketed) | ✓ |
| `pulse` | `ct_greek_flow_minute`, `ct_net_premium_ticks` | per_ticker netPremium | ✓ |
| `specialist` | `ct_specialist_reads` | latest conviction/lean per ticker | ✓ (C2 RTH-gated) |
| `detector` | `ct_flags` | active/conviction flags | ✓ |
| `tape` | `ct_tape_commentary` | prior narratives (self-referential) | ✓ |
| `james_flags` | `ct_flags WHERE source='james_star'` | James's manual signals | ✓ |
| `news_causality` | `ct_breaking_news`, `ct_news_analyses` | watchlist + macro news, severity ≥2 | ✓ |
| `event_recency` | `ct_events`, `ct_earnings_moves`, `ct_breaking_news` | "what just happened" + timeline | ✓ |
| `analogs` | `ct_specialist_recall`, historical | pending_analysis enum | ✓ |
| `specialist_recall` | `ct_specialist_reads` (rolling history) | specialist's prior-pattern memory | ✓ |
| `regime` | `ct_regime_classifications`, `ct_iv_rank_daily` | regime_tag, state | ✓ |
| `flow_butterfly` | `ct_flow_alerts` (multi-leg projection) | per_ticker positioning | ✓ |
| `prev_close` | `ct_ticker_snapshots` | yesterday's close per ticker | ✓ (side input) |

### D.2 Consumer nodes (Claude callers via buildClaudeContext)

**Audience: cotrader (operational)**

| Consumer | Organs requested | Writes | Notable |
|---|---|---|---|
| `ct-tape-reader` | [detector, news_causality, tape, pulse] | `ct_tape_commentary` | tape reads itself (self-loop) |
| `ct-chat` | ALL | `ct_chat_tokens` | on-demand |
| `ct-daily-brief` | ALL | `ct_daily_briefs` | morning composition |
| `ct-eod-summary` | ALL | `ct_eod_summaries` | evening composition |
| `ct-eod-specialist-narrative` | tickerFocus subset | `ct_eod_specialist_narratives` | per-ticker, 10× parallel |
| `ct-eod-report` | ALL | `ct_eod_reports` | scheduled |
| `ct-news-sweep` | ALL | `ct_breaking_news` (writes back to a producer-table — circular potential) | trigger |
| `ct-alert-post-mortem` | subset via `pickOrganSubset()` | `ct_alert_post_mortems` | manual |
| `ct-self-grader` | ALL | `ct_grades` | post-DTE |
| `ct-curiosity` | summarized | internal | on-demand |
| `ct-trade-advisories` | summarized | (output table?) | on-demand |
| `ct-lessons-curator` | [event_recency only] | `ct_observations` | scheduled |
| `ct-playbook-curator` | ALL | `ct_playbooks` | scheduled |

**Audience: paper_claude (research, isolated)**

| Consumer | Writes | Cadence |
|---|---|---|
| `ct-hypothesis-proposer` | `ct_hypotheses`, `ct_hypothesis_events` | scheduled |
| `ct-hypothesis-health-check` | `ct_hypothesis_events` | daily |

### D.3 The actual fusion structure

**The crucial finding:** organs DO NOT read each other.

- `tapeContext` reads `ct_tape_commentary` (its own prior outputs — self-loop). It does NOT read `ct_specialist_reads` or `ct_breaking_news` or `ct_news_causality` directly. If a tape commentary mentions "specialist X is bullish on NVDA," that's because `ct-tape-reader` (the CONSUMER) composed multiple organs and Claude synthesized them in prose, not because the organ pre-fused them.
- `specialistContext` reads `ct_specialist_reads`. It does NOT read `news_causality` or `regime`. The specialist organ surfaces specialist-private state, period.
- `news_causality` reads `ct_breaking_news` + `ct_news_analyses`. It does NOT read `ct_specialist_reads` or `ct_flags`. The "causality" is news→price, not news→specialist or news→flag.
- `event_recency` reads calendar/earnings/news. Does not read flags, specialists, regime.
- `regime` is read via `regimeContext`. Other organs do not read regime state directly.

**The fusion is at the consumer level only.** When `ct-daily-brief` calls buildClaudeContext, all 9–11 organs run in parallel and return their slices. The CONSUMER's prompt then asks Claude "synthesize all of these." Claude does the cross-organ fusion in its head every call, and the result lands as prose in one output table (`ct_daily_briefs`, `ct_tape_commentary`, etc.).

**Implication:** the substrate is "organs all visible to one Claude pass." The cross-wiring between organs at the SUBSTRATE level is sparse. Captain's quote is empirically true: "doesn't all hook together" — the hooking happens in Claude's prompt, every call, not in the data layer.

### D.4 Notable broken-fusion gaps (substrate exists; edge isn't drawn)

1. **`james_flags` → specialist context** — does specialist context receive James's manual stars in real-time? Specialist reads aren't pre-fused with James's flags; specialist Claude gets both via consumer composition only.
2. **`analogs` → specialist_recall** — both organs exist; cross-integration unclear. analogs synthesizes historical patterns; specialist_recall reads chronological history. Pre-fusing analogs INTO specialist_recall would surface "specialist saw 3 analogs to today's setup" as a substrate property.
3. **`event_recency` × `detector`** — no evidence of flags being weighted/decayed by event recency. Old flag = same weight as fresh one in detector organ.
4. **`news_causality` → specialist alerting** — eod-specialist-narrative reads both organs (consumer-level). Forward direction (specialist organ aware of news_causality output mid-RTH) doesn't exist.
5. **`ct-tape-reader` writes `ct_tape_commentary` AND `tapeContext` reads `ct_tape_commentary`** — confirmed self-learning loop. This IS wired. Worth noting as the one organ that eats its own outputs structurally.
6. **`ct-news-sweep` consumes ALL organs and writes to `ct_breaking_news` (a producer table)** — potential semantic loop / write-back-to-source pattern. Worth a Phase A.

### D.5 Gap list — Section D

- **The structural fusion graph is at consumer-only resolution.** If captain wants organ-to-organ wiring (e.g., "regime modulates detector weights at the substrate level, not just Claude-prompt-level"), that's NEW substrate, not new surface.
- **No directed-graph visualization exists.** Captain's mental model of "what reads what" has no UI surface to verify against. This is itself a v2 surface candidate (see Section E + v2 Implications).
- **Cross-organ dependency is implicit, not enforced.** No constraint says "when ct_specialist_reads writes, ct_tape_commentary's next read must include the new specialist read." It happens because both happen on overlapping cron cadence and buildClaudeContext re-runs.

---

## E. UI Surfaces + Invisible Producers

The crux of the v2 thesis. The substrate produces structured thinking; the UI mostly renders latest-snapshot prose + aggregate roll-ups; the STRUCTURE of thinking (evolution, conviction trajectory, contradictions, causal chains) is invisible.

### E.1 Pages currently registered in `src/App.tsx` (28 routes inside AuthLayout)

**Co-Trader intelligence:** `/`, `/flags`, `/tape`, `/tape-v2`, `/alpha`, `/tape-reader`, `/specialists`, `/detectors`, `/heatmap`, `/butterflies`, `/pulse`, `/patterns`, `/edge`.

**Reports / EOD / morning:** `/eod`, `/eod-report`, `/morning-brief`, `/reports`.

**Alarms / health / observability:** `/alarms`, `/health`, `/budget`, `/cost`, `/crons`, `/agents`, `/activity`.

**JAC meta:** `/dashboard`, `/jac`, `/code`, `/calendar`, `/search`, `/brain`, `/ct-settings`, `/settings`.

### E.2 What each Co-Trader page actually surfaces

(Selected high-traffic pages — full inventory in agent report.)

- **`/tape`** — raw flow rows (ct_scored_flow + ct_flow_alerts) + flags + OI snapshots. Realtime via Alarms channel.
- **`/tape-v2`** — composition surface. Tape commentary + specialist tiles + flow pulse + James flags + breaking news + events. Realtime multi-channel.
- **`/alpha`** — NEW. Currently iter #1: ClaudesRead full-width (latest tape commentary + 3 specialist tiles by conviction) + 4 placeholder sections for iter #2–#5. **Honest <2x against /tape-v2 today; iter #1 ships placeholders.**
- **`/tape-reader`** — latest tape commentary (full text) + linked printsheets.
- **`/flags`** — live ct_flags rows joined with ct_flag_grades for outcome tracking + 90-day history.
- **`/specialists`** — scoreboard (ct_specialist_scoreboard_v2). Conviction × freshness leaderboard.
- **`/detectors`** — scoreboard (ct_detector_scoreboard) + lifecycle state.
- **`/heatmap`** — flow positioning grid (ct_flow_heatmap_live).
- **`/butterflies`** — placeholder/prototype; ct_butterfly_cross_events not yet rendered.
- **`/pulse`** — current regime + sparkline. Regime transitions not surfaced.
- **`/patterns`** — ct_flag_patterns (NOT ct_observed_patterns).
- **`/morning-brief`** / **`/eod`** / **`/eod-report`** — Claude prose surfaces (ct_morning_briefs, ct_daily_briefs, ct_eod_summaries, ct_eod_reports).
- **`/health`** — warden invariant aggregate (passing %, failures list).

### E.3 The Invisible Producer Inventory (the v2 surface candidate list)

Tables that get written by Claude or by structured-grading crons, with ZERO or near-zero UI surface:

| Table | Producer | Frequency | UI status | Why this matters |
|---|---|---|---|---|
| `ct_eod_specialist_narratives` | ct-eod-specialist-narrative | ~10/day (per ticker) | INVISIBLE | Per-ticker evening narrative captain never sees |
| `ct_observed_patterns` | ct-hypothesis-proposer + forensic | ~daily | INVISIBLE | Pattern library completely dark |
| `ct_specialist_memory` | per specialist run | 4× RTH per ticker | INVISIBLE | Specialist learning trajectory dark |
| `ct_specialist_grade_axes` | ct-specialist-grader | post-RTH | INVISIBLE | Multi-dim quality scorecard dark |
| `ct_alert_post_mortems` | ct-alert-post-mortem | per alert | INVISIBLE | "What did this flag miss?" dark |
| `ct_news_causality` | ct-news-causality | hourly RTH | PROSE-ONLY in /eod-report | Richest Claude causality is one prose sentence; structural causal graph dark |
| `ct_brain_telemetry` | every buildClaudeContext call | ~100/day | AGGREGATE-ONLY on /health | Per-call traces (organ latency, cache-hit, errors) dark |
| `ct_invariant_log` | ct-system-warden | every 30 min | FAILURES-ONLY on /health | Passing 53/54 visible; passing checks themselves not browsable; failure causality dark |
| `jac_emissions` | jac-emit (PR #63) | ~2/day Phase 1 | INVISIBLE | Just shipped; no UI feed |
| `ct_butterfly_cross_events` | ct-butterfly-detector | every 5 min RTH | INVISIBLE (placeholder on /alpha + /butterflies) | Just shipped 2026-05-09; iter #2 planned ETA 2026-05-15 |
| Regime transitions in `ct_regime_history` | ct-regime-capture | every 15 min RTH | CURRENT+SPARKLINE on /pulse | Transition triggers (when/why flip) dark — one of the most decision-relevant signals |
| `ct_specialist_principles` | per-specialist distillation | weekly | INVISIBLE | Specialist's own private heuristics dark |
| `ct_observations` | curator + recall + watcher | per-trade | PARTIAL on /brain reflections | Co-Trader observations not linked back from Co-Trader UI |

### E.4 The Surfacing Gap (where producer IS surfaced but the structure is invisible)

- **`ct_specialist_reads`** is rendered — but as latest 3 by conviction (on /alpha) or as a tile row (on /tape-v2). The EVOLUTION OVER THE DAY (conviction shifts, direction flips, thesis edits) has no surface.
- **`ct_breaking_news`** is rendered as latest-N list — the CAUSAL CHAIN (story A enabled story B's market impact) has no surface.
- **`jac_principles`** is rendered as static principle statement list on /brain — the LEARNING TRAJECTORY (how principles evolved week-over-week) has no surface.
- **`ct_regime_history`** has current + sparkline — the FLIP JOURNAL (timestamp, prior regime, next regime, trigger) has no surface.

### E.5 Gap list — Section E (high-impact v2 surface candidates)

In rough priority by alpha-density × decision-relevance:

1. **News-causality interactive graph** — render `ct_news_causality` as nodes (headline → market implication → affected tickers → regime impact). Currently invisible.
2. **Specialist learning arc** — `/specialist/{ticker}` detail view: conviction trajectory across the day, thesis-edit timeline, win/loss distribution.
3. **Regime flip journal** — `/regime` or `/pulse` historical view: timestamps, prior→next, trigger reason.
4. **Pattern library** — merge `ct_observed_patterns` + `ct_flag_patterns` into one surface that captain can browse.
5. **Brain-telemetry traces** — per-invocation latency + cache-hit + errors per organ. Not aggregate-only.
6. **Butterfly multi-day arc** — already iter #2 planned for /alpha; corpus needs 5+ RTH days.
7. **Emission feed** — `jac_emissions` rendered as a feed somewhere visible (right-rail or dashboard widget).
8. **Eod-specialist-narrative surfacing** — 10× per-ticker narratives currently written to DB and never shown.
9. **Specialist quality scorecard** — `ct_specialist_grade_axes` rendered as multi-dim card on /specialists detail.
10. **Alert post-mortem feed** — `ct_alert_post_mortems` as feedback loop on /alarms.

---

## F. The Automation Surface

### F.1 Headline numbers

- **168 distinct cron schedules** across 9 categories (ingestion, detection, grading, synthesis, maintenance, emission, JAC-side, specialized trader, market-data).
- **94 unique edge functions** invoked.
- **~2,400 cron fires/day RTH + ~400 off-hours.**
- **~500–1,200 Slack alarm posts/day** via legacy `ctSlackPush` paths.
- **~2 emission posts/day** (Phase 1 = 1 trigger).
- **~15,000 DB writes/day**, ~100k+/week.
- **53 active warden invariants**, checked every 30 min = 1,440 invariant-checks/day.
- **Cost:** ~$250–355/month Anthropic (excludes UW MCP, Tavily, Voyage AI, Vercel, Supabase).

### F.2 Categories

(Full table in agent report. Distilled here.)

- **Ingestion** — UW (insider, political, analyst, short interest, sector tide, skew, technicals, flow), Tavily (news weekday/weekend), event calendar, earnings sync, spot VIX, yield curve, institutional flows, central bank events, price backfill.
- **Detection** — flow stack, pair QQQ-IWM, small-cap inverted put, smart money repeat, unusual OI, weekly ATM VOI, whale, ZeroDTE call/put, butterfly, signature watcher, IV shift, regime watcher, tape reader, flow pulse, curiosity, drawdown.
- **Grading** — flag grader, print grader, butterfly grader (intraday + nextclose), contract poller, OI snapshots (open/mid/close), alert book commit, self-grade, specialist score, flag analysis corpus refresh.
- **Synthesis** — morning brief, daily brief, EOD positioning/summary/recap/report, midday recap, news causality, news sweep, ct-reflect-to-jac, JAC morning brief, lessons curator, tape reader (RTH), session analog, debate scorer, trade advisories, playbook curator.
- **Maintenance** — system warden (every 30 min), cron health check (every 4h), detector scoreboard (RTH/off/weekend), specialist scoreboard nightly, hypothesis health check, memory decay sweep, brain insights cleanup, backfill embeddings (every 30 min), stale task cleanup, retention.
- **Emission** — `jac-emission-detector` every minute RTH (currently 1 trigger active: hot_contract).
- **JAC-side** — heartbeat (hourly), distill principles (weekly Sunday 03:00 UTC), watch scheduler (every 15 min), brain insights (2× daily), reminders (3× cadence), sync codebases (weekly Sunday).
- **Specialized trader** — claude-trade-open/reopen, book writer, book exit watcher, book manager, book EOD close, generation manager, cash decay monitor, circuit breaker, health monitor, CIO review (weekly), open trade journal, dream mode (pre-RTH simulation), pre-bell gauntlet, pre-bell grader.
- **Market data** — SPY capture, VIX capture (RTH/midday/late/EOD), price tick capture, market snapshot, DP cluster sweep/detection, premarket scan, ticker baselines nightly, ticker snapshot builder, correlation compute, historical quote backfill.

### F.3 Emission layer (PR #63) — the Phase 1 reality

`jac_emission_triggers` currently has 1 enabled trigger:

| Trigger | Application | Detection | Composition | Targets | Cadence |
|---|---|---|---|---|---|
| `hot_contract` | cotrader | `detect_hot_contract()` | `cotrader_hot_contract_v1` | `['slack']` | debounced 60-min per-key, polled every minute RTH |

Empirical: ~1.9–2.0 hot_contract emissions/day (score≥80 ∧ premium≥$250k). Composition via Haiku, severity=signal, dispatch via `ctSlackPushDirect`.

**The 9-trigger gap** (catalogued in PR #83):

| Trigger | Detection | Estimated effort |
|---|---|---|
| `news_flow_causality` | already-produced rows in ct_news_causality where impact_score ≥ threshold | LOW |
| `first_daily_cross` | ticker snapshot crossing 50dMA, once per asset per day | LOW |
| `specialist_flag_fired` | ct_specialist_flags fired_at IS NOT NULL | MEDIUM |
| `regime_transition` | ct_regime_classification regime != prev | MEDIUM |
| `heatmap_breakout` | ct_net_premium_ticks delta > 2σ | MEDIUM |
| `butterfly_cross` | ct_butterfly_grades direction_consensus flips | MEDIUM |
| `specialist_conviction_shift` | ct_specialist_ratings conviction delta > threshold | MEDIUM (needs historical tracking) |
| `tape_interrupt` | ct_tape_narratives surprise_index > threshold | HIGH (sub-minute cadence) |
| `consensus_flip` | ct_specialist_consensus direction flip | MEDIUM (needs consensus table) |

### F.4 Slack push patterns (non-emission-layer legacy)

Three active push functions in `_shared/ctSlack.ts`:

| Function | Use | Volume |
|---|---|---|
| `ctSlackPush` | primary alarm flow (called by 168 cron edge functions + detectors) | ~500–1,200 posts/day RTH |
| `ctSlackPushTiltTransition` | state-change alerts (generation manager, circuit breaker, book state) | ~10–20/day |
| `ctSlackPushDirect` | emission layer (jac-emit Phase 1) | ~2/day |

Plus legacy `signature_alarm` push (dormant, pre-detector-portfolio era).

**Dual-render risk** is currently low (each cron has one canonical push path). Future risk: if `ct-flag-grader` AND emission `detect_hot_contract` both fire on same event, two Slack posts land. Dedup via `jac_emissions.event_dedup_key` + `ct_slack_log.event_id` FK is the structural fix when Phase 2 ships.

### F.5 Realtime subscriptions (frontend)

| Channel | Filter | Consumers |
|---|---|---|
| generic per-table (entries, agent_tasks, brain_insights, code_sessions) | userId | useRealtimeSubscription hook |
| ct-flow-alerts realtime | ct_flow_alerts + ct_scored_flow | flow heatmap widget, live tape reader |
| ct-detector-alerts realtime | ct_detector_alerts + ct_detector_scoreboard | sparkboard widget |
| ct-specialist realtime | ct_specialist_flags + ct_specialist_ratings | specialist cards |
| agent-tasks realtime | agent_tasks + agent_activity_log | nerve center, activity feed |
| jac-emissions realtime (planned) | jac_emissions | future BreakingNews widget |

Known issue: realtime INSERT events unreliable with service-role auth → workaround is debounced refetch on task completion.

### F.6 Gap list — Section F

- **Emission layer 1/10.** PR #83 catalogued 9 unimplemented triggers; lowest-effort ports (news_flow_causality, first_daily_cross) are 1–2 day efforts each.
- **No central push registry.** 168 cron functions each call `ctSlackPush` directly. No table tracks "which crons can push" or "what rate budget per cron." Tenet 25 candidate.
- **Slack log retention 30 days.** Operator audit beyond 30 days is impossible.
- **Realtime delivery flaky for service-role.** Workaround works but is brittle for new realtime-dependent surfaces.

---

## G. The Kernel-vs-Application Boundary

Captain's framing per CLAUDE.md: JAC OS is the operating system substrate; Co-Trader is one application running on top. Both Cowork and engine-room habitually forget which is which. This section makes the boundary empirical so future v2 surfaces land at the right layer.

### G.1 Clearly KERNEL (~35 modules + 8 tables)

**Infrastructure:** `auth.ts`, `cors.ts`, `clock.ts`, `logger.ts`, `response.ts`, `validation.ts`, `rateLimit.ts`, `configCache.ts`.

**Claude API + observability:** `anthropic.ts`, claudeUsageLog pattern.

**Brain orchestration:** `claudeReadSurface.ts` (`buildClaudeContext`), `contextHelper.ts` (`ContextHelper<T>`, `AudienceMode`, `OrganMetadata`, `HelperFetchContext`).

**Memory + embedding:** `entries` table, `jac_reflections`, `jac_principles`, Voyage `ctEmbed.ts`.

**Emission infrastructure:** `jac_emission_triggers`, `jac_emissions`, `jac-compose-emission`, `jac-emit`.

**Cross-facet bridge:** `crossFacetMemory.ts`.

**Vendor clients:** `uwMcpClient.ts`, `uwClient.ts`, `tavilyClient.ts`, `github.ts`, `slack.ts`.

**System learning Property pattern:** `jac_reflections` → distill-principles → `jac_principles`.

### G.2 Clearly APPLICATION (Co-Trader specific)

`ct_*` tables (~130 functions). Detector portfolio. Specialist ecosystem. Options-flow tables. Pulse (regime as options-flow). Trade ideas + execution. Paper-trader Claude. News + sentiment for equities. Options pricing/Greeks. Co-Trader Slack formatting (`ctSlack.ts`). Co-Trader grading (`ctGrader.ts`).

### G.3 BORDERLINE — should promote to kernel

| Module | Why kernel | Promotion shape |
|---|---|---|
| `decisionJournal.ts` | universal pattern (decision + outcome + linkage) | `jac_decision_log(application, agent, decision_payload, generation_id)` + `recordSystemDecision()` |
| `tapeContext.ts` | narrative composition is universal | `NarrativeContext` reading `jac_narratives(domain, ticker)` |
| `eventRecencyContext.ts` | event coloring is universal | `jac_events(domain, event_type, ticker)` |
| `analogsContext.ts` | historical analog recall is universal | `jac_analogs(domain, query_embedding, lookback_days)` |
| `hallucinationGuard.ts` | structural prevention is universal | `validateClaim(claim_text, evidence_table, context)` kernel function |
| `ct_embeddings` polymorphic | the polymorphic pattern is universal; the things embedded are app-specific | `jac_embeddings(owner_app, owner_type, owner_id, embedding)` with RLS per app |
| `ct_brain_telemetry` | per-organ telemetry is kernel | rename to `jac_brain_telemetry` |

### G.4 The "should be kernel but isn't yet" list — STRUCTURAL DRIFT

1. **Vendor abstraction layer doesn't exist.** UW integration is per-edge-function ad hoc — `ct-analyst-ingester` calls `uwClient.ts`, `ct-contract-poller` calls `uwMcpClient.ts`. **If UW renames an endpoint, ~10+ places break.** Slack is split kernel + application (`slack.ts` + `ctSlack.ts`). MCP integration is single-vendor (UW only) with hardcoded endpoint. **No broker pattern.** Action: `jac/vendor-adapters/` (`abstract-vendor.ts`, `vendor-registry.ts`, `uw-adapter.ts`, `slack-adapter.ts`, `tavily-adapter.ts`, `mcp-broker.ts`).

2. **Prompts hardcoded in TypeScript, not in tables.** `systemPromptV1.ts`, `chatPromptV1.ts`, `eodReportPrompt.ts`, `morningBriefPrompt.ts`, `selfGraderPrompt.ts` — Tenet 25 violation. Should be `jac_prompt_templates(name, domain, version, template_text, inputs_schema JSONB, model_override)` with versioning.

3. **Detector logic in edge functions, not in tables.** Tenet 25 violation. "Adding a detector is a database INSERT, not a code change" — currently it's a code change + deploy. Should be `jac_detectors(name, domain, detection_sql, lifecycle_status, confidence_model)` + `jac-detector-runner` kernel cron.

4. **Grading logic in `ctGrader.ts` is Co-Trader only.** v2 apps can't grade their own outputs without copy-paste. Should be `jac_grade_schemas(domain, artifact_type, axes JSONB, weighting)` + `recordGrade(artifact_id, domain, axes_scores)` kernel pattern.

### G.5 Conflict summary

| Drift | Type | Impact | Fix priority |
|---|---|---|---|
| Vendor integration ad hoc 10+ places | STRUCTURAL | UW endpoint change = 10+ places break | HIGH |
| Prompts hardcoded in 5 .ts files | STRUCTURAL | prompt change = code redeploy; no version tracking | MEDIUM |
| Detectors in edge functions | STRUCTURAL | detector add = code change + deploy (Tenet 25 violation) | MEDIUM |
| `decisionJournal` Co-Trader-only | STRUCTURAL | JAC kernel can't journal its own decisions | LOW |
| `ctGrader` Co-Trader-only | STRUCTURAL | future apps copy-paste | LOW |
| `ct_brain_telemetry` naming | NAMING | confuses kernel vs app telemetry | LOW |
| Brain organs hard-coded to `ct_*` tables | MIXING | flowHeatmap/pulse/etc. reach into options tables only | LOW |
| MCP single-vendor | ARCHITECTURAL | hard to add MCP sources beyond UW | MEDIUM |

### G.6 Gap list — Section G

- **v2 readiness ~60%.** Emission layer is correct (foundation for all apps). Vendor abstraction is missing (critical blocker if UW changes anything). Prompts and detectors as tables are not yet (easy lifts). Cross-facet recall works but hard-coded to DCD types (generalization needed).
- **Most drift is fixable without rewrite.** Renames, table promotions, central writers — none requires re-architecting buildClaudeContext.

---

## Cross-Cutting Findings

The seven sections converge into a smaller set of structural truths.

### CC.1 The fusion is at consumer-layer only; substrate is loosely connected

Brain organs run in parallel and return their slices. Cross-organ wiring at the substrate is sparse (only tape eats its own outputs structurally). Claude does the cross-fusion in its head every consumer call. This means:

- The captain's mental model "the system fuses news + specialists + regime + tape" is true at consumer-output time, not at substrate time.
- Adding "richer fusion" can mean two structurally different things:
  - (A) Add more organs to existing consumers (Claude does more synthesis per call) — easy, additive, no substrate change.
  - (B) Pre-fuse organs at substrate (regime modulates detector weights, news_causality writes back into specialist context, etc.) — substrate work, harder, more durable.
- The 5x v2 play probably needs both (A) for visibility + (B) for genuinely new fusion.

### CC.2 The embedding gate is half-built; the load-bearing surfaces are exactly the gap

Decided thinking IS embedded. Real-time narrative surfaces ARE NOT. The half that's missing is exactly the half captain reads most often. Closing the gap on `ct_specialist_reads` first, then `ct_tape_commentary`, then `ct_news_causality` is the single biggest semantic-recall unlock and the single biggest "make the JAC OS thesis structural" lift.

### CC.3 The thinking is invisible; the substrate that produces it is rich

11+ Claude-produced or graded tables have zero or near-zero UI. The captain's "I'm flying blind on what the system is thinking" diagnosis is empirically right. The 5x v2 play is rendering the structure of thinking (causal graphs, conviction trajectories, regime-flip journals, multi-dim quality scorecards, per-organ telemetry traces) — not adding another flow surface.

### CC.4 The emission layer is right; the application of it is at 10%

Phase 1 (PR #63) shipped the kernel correctly. One trigger fires. Nine more are catalogued and unimplemented. Pushing more state into Slack closes the "I have to refresh the UI to find out what changed" loop and turns the system more push-not-render.

### CC.5 The kernel-vs-application boundary is mostly clean; vendor adapter is the structural blocker

60% kernel cleanly delimited. 40% drift is mostly fixable via promotion (decisionJournal, narrative, event_recency, analogs, hallucination_guard, ct_embeddings polymorphic, ct_brain_telemetry naming). The single structural blocker for v2 application scaling is the vendor adapter layer — UW endpoint changes break 10+ places today.

### CC.6 Tenet 25 is partially honored

- Configs live in `ct_config` ✓
- Invariants live in `ct_invariants` (warden) ✓
- Detectors live in edge functions ✗ (should be `jac_detectors` table)
- Prompts live in TypeScript files ✗ (should be `jac_prompt_templates` table)
- Emission triggers live in `jac_emission_triggers` ✓ (kernel correct)
- Specialist prompts live in `ct_specialist_prompts` ✓ (per CLAUDE.md)

---

## v2 Implications

What this audit means for `/alpha` going forward. Anchored to the 5x rule (`feedback_v2_must_be_5x_better_than_tape.md`).

### v2.1 The /alpha iter #1 is sub-5x — confirmed by audit

iter #1 (shipped 2026-05-09) is:
- ClaudesRead full-width (latest tape commentary + 3 specialist tiles by conviction) — reuses `useTapeReader` and `useSpecialistsTileRow` from /tape-v2; no new substrate.
- Four placeholder sections pointing at iter #2–#5.

Against the audit's gap lists:
- **Doesn't surface any invisible producer** (Section E).
- **Doesn't activate semantic recall** (Section C).
- **Doesn't draw any missing fusion edges** (Section D).
- **Doesn't close any embedding-gate gap** (Section B).
- **Doesn't push more state through emissions** (Section F).

This is consistent with captain's "you put a little butter on it, not even fucking syrup" 2026-05-09. The audit makes the diagnosis structural rather than vibes-based: iter #1 reused /tape-v2 primitives instead of revealing thinking-structure.

### v2.2 The 5x play candidates ranked by audit signal

Ordered roughly by alpha-density × decision-relevance × structural-novelty, holding to the "5x better than /tape" bar:

1. **Render the thinking-structure as the surface itself.**
   - Causality graph (Section E #1) — `ct_news_causality` as nodes, not prose.
   - Specialist learning arc (Section E #2) — conviction trajectory + thesis edits + win/loss arc per ticker per day.
   - Regime flip journal (Section E #3) — timestamps, prior→next, trigger reason.
   - Brain-telemetry traces (Section E #5) — per-call latency, organ contribution, cache state.
   - Captain's tape-reader-arc concept (per the late-night exchange) lands here: render the system's evolving "mood" — green/red/blue light sequence — as a glance-able arc.

2. **Activate semantic recall on the load-bearing tables.**
   - Embed `ct_tape_commentary` (Section B gap #2) → activate "5 most-similar prior reads + their NextClose outcomes" already hinted in `ClaudesRead.tsx` line 154.
   - Embed `ct_specialist_reads` (Section B gap #1) → activate semantic recall in specialistRecallContext (Section C #C.4).
   - The 1-line wins from Section C #C.5 (memoryRecall.getRecentItems on ct_observations, ct_flags, ct_alerts).

3. **Draw missing fusion edges.**
   - regime modulates detector weights (Section D gap #3).
   - news_causality writes into specialist context, not just consumer prose (Section D gap #4).
   - analogs feeds specialist_recall (Section D gap #2).
   - Each of these is substrate work — durable, harder, more 5x than another rendered surface.

4. **Close the embedding gate STRUCTURALLY, not aspirationally.**
   - INSERT triggers + warden invariant `embedding_backlog_age_hours` (Section B verdict).
   - Makes the JAC OS thesis enforced rather than asserted.

5. **Wire more emissions through the kernel.**
   - news_flow_causality + first_daily_cross are 1–2 day ships each (Section F.3 gap).
   - Each emission is one less reason for captain to refresh the UI.

### v2.3 What v2 should NOT do (audit-derived)

- **Don't add another flow surface.** /tape, /tape-v2, /heatmap, /butterflies already exist. Another flow surface would fail the 5x bar by definition.
- **Don't render existing producers in a new layout.** Section E.4 surfacing-gap items (specialist reads, breaking news, jac_principles, regime sparkline) need STRUCTURE shown, not relayout.
- **Don't ship before measuring against the 5x bar.** The standing memory entry says: "Engine-room measures proposed surface against equivalent on /tape across: alpha density per glance / decision-speed / push-not-render compliance / identity-bearing visual primitives present / structural unlock vs incremental polish. If proposed surface is <5x better on those axes, scope harder before writing any code."

### v2.4 The decision captain is implicitly facing

After this doc lands, the genuine choice for iter #2+ is between:

- **Path A — Surface the thinking.** Render invisible producers + thinking-structure (highest visual 5x impact; doesn't change substrate; days of work).
- **Path B — Close the embedding gate.** Embed the load-bearing narrative tables + activate semantic recall (durable substrate change; medium effort; unlocks Path A surfaces with more depth).
- **Path C — Draw missing fusion edges.** Pre-fuse organs at substrate (largest structural change; weeks of work; durable wins).
- **Path D — Build the vendor adapter layer.** Kernel work; not visible to captain; but blocks future apps and currently fragile.

These are not mutually exclusive. The audit has no opinion on which is "right" — captain decides. But each one has different shape:
- Path A is high-visibility, captain sees the change.
- Path B is medium-visibility, foundational.
- Path C is low-visibility, structural.
- Path D is invisible-to-captain, kernel-strategic.

---

## Honest Limitations

What this audit didn't verify or where I'm uncertain.

- **Per-output-table organMetadata coverage** wasn't enumerated row-by-row. Spot-check passes; full audit would require per-consumer migration verification.
- **Per-consumer 7-day call volume** from `ct_brain_telemetry` wasn't sampled. Daily volume estimates in Section F are aggregate.
- **Some cron schedules in Section F.2 categorization** were inferred from naming conventions (e.g., "nightly" for `*-nightly`) rather than confirmed against `cron.job` table.
- **Realtime channel filters and exact subscriber counts** weren't measured; described from frontend code paths.
- **The fusion-graph agent occasionally inferred edges** rather than confirming them via grep — flagged in its own report but worth revisiting if any specific edge becomes load-bearing.
- **No empirical query of `jac_emission_triggers` was run** during synthesis to verify the 1-trigger Phase 1 state; based on PR #63 + audit-time understanding. A REST query before iter #2 would close this.
- **The "invisible producer" inventory is comprehensive but not exhaustive** — small one-off `ct_*_log` tables may have been missed; the high-decision-impact ones are confirmed.
- **The boundary audit (Section G) is read-only on file paths and naming conventions** — actual call-graph analysis (e.g., does `ctGrader.ts` actually depend on Co-Trader-only types?) would tighten the kernel/application classification.

This doc supersedes nothing currently authoritative. It is the new structural reference layer for v2 conversations and Phase A audits going forward. Future audits should reference this rather than re-discover.
