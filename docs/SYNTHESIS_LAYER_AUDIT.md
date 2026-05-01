# Synthesis Layer — Phase 0 Audit

**Performed**: 2026-04-30 evening, post-architectural-commit.
**Method**: mechanical grep across `supabase/functions/` + table inventory cross-reference.
**Companion to**: `SYNTHESIS_LAYER_ARCHITECTURE.md` (the design), `_shared/contextHelper.ts` (the contract).

This is the spec Phase 1 helper agents read as input. Every "missing organ" entry below becomes a helper file. Every "inline-context consumer" becomes a Phase 4 migration.

---

## 1. Wired-correctly path (`buildClaudeContext` consumers)

Only **3 of ~17 Claude consumers** in Co-Trader use the central nervous system today:

```
supabase/functions/ct-daily-brief/index.ts
supabase/functions/ct-hypothesis-health-check/index.ts
supabase/functions/ct-hypothesis-proposer/index.ts
```

**Implication**: even after Phase 3, these 3 will see the richer brain transparently (their existing call returns more organs). The other 14+ consumers each have an inline context build that has to be migrated in Phase 4.

---

## 2. Inline-context Co-Trader consumers (Phase 4 migration scope)

The following Co-Trader Claude callers do NOT use `buildClaudeContext` and assemble their own context via direct `supabase.from(...)` queries. Each is a Phase 4 migration target.

| # | Consumer | Audience | Output | Priority |
|---|---|---|---|---|
| 1 | `_shared/specialistRunner.ts` (drives 10 specialists) | cotrader | Claude prose (per-ticker reads) | **P0** — single migration reaches 10 |
| 2 | `ct-chat` | cotrader | Claude prose (chat response) — **VIOLATES READ/WRITE SEPARATION (calls UW MCP at runtime)** | **P0** — read-path violation fix |
| 3 | `ct-tape-reader` | cotrader | Haiku prose (tape narrative) | P1 |
| 4 | `ct-trade-idea-generator` | cotrader | Sonnet+Haiku tool-use (idea JSON) | P1 — high call volume |
| 5 | `ct-eod-summary` | cotrader | Sonnet prose (day journal) | P1 |
| 6 | `ct-eod-report` | cotrader | Sonnet tool-use (forward-looking handoff) | P1 |
| 7 | `ct-watcher` | cotrader | Mixed (heartbeat updates) | P2 |
| 8 | `ct-self-grader` | cotrader | Sonnet prose (outcome grading) | P2 |
| 9 | `ct-curiosity` | cotrader | Sonnet prose (research questions) | P2 |
| 10 | `ct-news-sweep` | cotrader | Tavily + Claude (news classification) | P2 |
| 11 | `ct-trade-advisories` | cotrader | Sonnet (trade lifecycle commentary) | P2 |
| 12 | `ct-debate-outcome-scorer` | cotrader | Sonnet (debate grading) | P3 |
| 13 | `ct-alert-post-mortem` | cotrader | Sonnet (alarm review) | P3 |
| 14 | `ct-lessons-curator` | cotrader | Sonnet (principle curation) | P3 |
| 15 | `ct-playbook-curator` | cotrader | Sonnet (playbook curation) | P3 |
| 16 | `ct-replay` | analyst (terminal-Claude bridge) | Mixed | P3 |
| 17 | `ct-tavily-news-watcher` | agent_internal | Tavily + Claude routing | P3 |
| 18 | `ct-mcp-verify` | agent_internal | utility | skip (utility, not context-needing) |
| 19 | `ct-news-sentiment-backfill` | agent_internal | utility | skip (utility, not context-needing) |
| 20 | `ct-reflect-to-jac` | cross-facet bridge | Sonnet prose to JAC | P4 (cross-facet — separate concern) |

Out of scope (JAC-side, not Co-Trader): `jac-dispatcher`, `jac-research-agent`, `jac-code-agent`, `jac-morning-brief`, `jac-reflect`, `jac-heartbeat`, `jac-dashboard-query`, `brain-insights`, `calculate-importance`, `classify-content`, `distill-principles`, `enrich-entry`, `extract-entities`, `generate-brain-report`. These have their own context surface (or none) and are not part of this synthesis effort.

---

## 3. Read-path violators (must migrate in Phase 4)

Per D4 of the architecture (read/write separation), no consumer should call UW MCP at runtime. Today the violators are:

### `ct-chat` — confirmed UW MCP caller

```ts
// supabase/functions/ct-chat/index.ts
url: 'https://api.unusualwhales.com/api/mcp',
```

**Symptom**: chat is slow (MCP roundtrip) and burns UW budget on every conversation. James reports "I never use it" — likely partly because of the latency + because it's missing the structural context (specialist reads, heatmap, James flags) that the brain provides.

**Phase 4 P0 migration**: replace UW MCP runtime call with `buildClaudeContext({ audience: 'cotrader', organs: ['flow_heatmap', 'specialist', 'pulse', 'detector', 'tape', 'james_flags', 'news_causality', 'event_recency', 'analogs'], tickerFocus: <parsed from user message>, consumerName: 'ct-chat' })`. Result: subsecond chat, zero UW cost, full context.

### Other potential violators (TBD — flagged for review)

- Any frontend hook directly calling `unusualwhales.com` — none found in initial grep but worth a deeper sweep in Phase 4.
- `ct-mcp-verify` — utility, expected to call UW (it's verifying connectivity). Not a violation.

### Confirmed clean (write-path consumers — UW callers that ARE ingesters)

These all correctly call UW MCP because they're writing to our DB; they're the ingestion path:

```
ct-flow-ingester              ct-oi-snapshot
ct-interval-flow-ingester     ct-oi-backfill-historical
ct-news-ingester              ct-options-screener-ingester
ct-vix-capture                ct-political-ingester
ct-insider-ingester           ct-prediction-markets-ingester
ct-prediction-smart-money-ingester
ct-correlations-ingester      ct-yield-curve-ingester
ct-central-bank-ingester      ct-seasonality-ingester
ct-institutional-ingester     ct-technicals-ingester
ct-analyst-ingester           ct-indicator-events-ingester
ct-price-backfill             ct-mcp-shape-probe (utility)
```

These do NOT migrate. They're the write path D4 explicitly preserves.

---

## 4. Existing helpers in `_shared/`

What's already built that we adapt to the contract:

```
_shared/flowHeatmapContext.ts      — getFlowHeatmapContext (4/30 today)
_shared/pulseContext.ts            — pulseContext (4/25, predates this effort)
_shared/temporalContext.ts         — getTemporalContext (4/30 today)
_shared/temporalValidator.ts       — validateTemporalCoherence (4/30 today)
```

**Phase 1 task per helper**:
- `flowHeatmapContext.ts` — wrap existing `getFlowHeatmapContext` to conform to `ContextHelper<T>` interface. Add `describe()`, audienceFilter, telemetry meta. Export both a default `ContextHelper` AND keep the convenience `getFlowHeatmapContext` for backward compat.
- `pulseContext.ts` — same wrap. Existing API returns `PulseContext` directly; new wrapping returns `HelperResult<PulseContext>`.
- `temporalContext.ts` — keep as-is. It's a special case (provides preamble strings), not a regular organ. Orchestrator imports it directly.
- `temporalValidator.ts` — keep as-is. First validator in the chain.

---

## 5. Missing organs (Phase 1 build targets)

Each becomes a new file `_shared/<name>Context.ts` implementing `ContextHelper<TResult>`.

### 5a. `specialistContext.ts` (Phase 1)

| Field | Value |
|---|---|
| Source table | `ct_specialist_reads` |
| Returned shape | Per-ticker latest `read_text`, `direction_lean`, `conviction`, `flagged`, `flag_id`, `updated_at` |
| Default cap | 1 row per watchlist ticker (latest) |
| Audience filter | All audiences |
| Dependencies | None |
| Notes | The specialists currently fire and write; nobody reads their output back into context. This helper closes the loop. |

### 5b. `detectorContext.ts` (Phase 1)

| Field | Value |
|---|---|
| Source tables | `ct_flags` joined with `ct_detectors` for metadata |
| Returned shape | Recent flags by `(ticker, detector_id)`, last N hours; includes `score`, `direction`, `flag_metadata.heatmap_state_at_fire` |
| Default cap | Top 20 by recency, optionally per-ticker top 5 |
| Audience filter | All audiences |
| Dependencies | None |
| Notes | Pulse-pattern flags (commit `5141c31`) carry heatmap state at fire-time. Helper surfaces that for consumers reasoning about what the detector saw. |

### 5c. `tapeContext.ts` (Phase 1)

| Field | Value |
|---|---|
| Source table | `ct_tape_commentary` |
| Returned shape | Latest tape narrative + recent prior commentaries (for continuity) |
| Default cap | Latest 1 + prior 3 |
| Audience filter | All audiences |
| Dependencies | None |
| Notes | The tape reader narrates the live tape every 10 min. Helper surfaces the narrative back into other consumers' context (eod-summary, eod-report, specialists). |

### 5d. `jamesFlagsContext.ts` (Phase 1) — **AUDIENCE-GATED**

| Field | Value |
|---|---|
| Source table | `ct_james_flags` |
| **Addendum 2026-04-30** | source corrected from `ct_james_flags` (dropped) to `ct_flags WHERE source='james_star'` (unified per migration 20260427000010) |
| Returned shape | Per-ticker recent James flags with `note`, `direction_view`, `flagged_at` |
| Default cap | 5 most recent per ticker, last 24h |
| Audience filter | `['cotrader', 'analyst']` ONLY (excluded from `paper_claude` per D3 firewall preservation) |
| Dependencies | None |
| Notes | The whole point of the post-2026-04-25 thesis reset. James's hand-labeled signals become input to Co-Trader Claude consumers. Paper-Claude experiment retains independence. |

### 5e. `newsCausalityContext.ts` (Phase 1)

| Field | Value |
|---|---|
| Source tables | `ct_news_analyses`, `ct_breaking_news` |
| Returned shape | Per-ticker recent news with `severity`, `sentiment`, `category`, `tickers_affected`, causality fields if populated |
| Default cap | Top 10 by recency × severity, last 6h |
| Audience filter | All audiences |
| Dependencies | None |
| Notes | News data is rich but most consumers see it in raw form. Helper applies severity ranking + per-ticker filtering + dedup. |

### 5f. `eventRecencyContext.ts` (Phase 1) — **P0 STRUCTURAL FIX**

| Field | Value |
|---|---|
| Source tables | `ct_events`, `ct_earnings_moves`, `ct_breaking_news`, `ct_central_bank_state` |
| Returned shape | Three buckets: `just_happened` (last 72h with outcome data), `happening_today` (timestamps inside session_date), `upcoming` (next 14d). Per-ticker AND market-wide. |
| Default cap | Top 5 per bucket per ticker; top 10 market-wide per bucket |
| Audience filter | All audiences |
| Dependencies | None |
| Notes | **The structural complement to today's `temporalContext`. Together they kill the "Powell speech today" hallucination class.** The temporal anchor tells Claude what the date is; eventRecency tells Claude what events have already fired with what outcomes. |

### 5g. `eventCoherenceValidator.ts` (Phase 1, ships with `eventRecencyContext`)

| Field | Value |
|---|---|
| Type | `ContextValidator` (post-generation, chain) |
| Logic | Scan Claude's output for forward-leaning phrases ("watching for / waiting on / ahead of / setup into / will release / coming up") cross-referenced against `event_recency.just_happened`. Hits → `temporal_event_contradiction` warning. |
| Severity | Critical when explicit contradiction found |
| Notes | Defense in depth per Tenet 13. Structural prevention is `eventRecencyContext` (organ); validator is the safety net (chain). |

### 5h. `analogsContext.ts` (Phase 6 — deferred)

| Field | Value |
|---|---|
| Source | New RPC `ct_cell_analogs` over embedded `ct_flow_alerts` |
| Returned shape | Top N most-similar historical cells with similarity score + outcome window (1h/4h/1d/3d after) |
| Default cap | Top 3 |
| Audience filter | All audiences |
| Dependencies | New RPC must ship first (Phase 6 migration) |
| Notes | Recall layer. Pattern-matching against history. Phase 6 work, scoped now to reserve the helper name. |

---

## 6. Inline data already in `claudeReadSurface.ts` — refactor candidates

`claudeReadSurface.ts` is 1922 lines. Most of it is inline `supabase.from(...).select(...)` queries that should each become a helper. Phase 3 refactors these out into individual helper files.

Candidates (kept as-is during Phase 1; refactored during Phase 3):

```
ct_heartbeats              → heartbeatContext
ct_hypotheses              → hypothesesContext
ct_hypothesis_events       → (folded into hypothesesContext)
ct_trades (claude only)    → claudeTradesContext
ct_trade_ideas             → claudeTradesContext or armedIdeasContext
ct_grades                  → claudeGradesContext
ct_book (claude only)      → (claudeTradesContext) — paper trader is research-layer-only
ct_flow_alerts             → (already exposed via flowHeatmapContext)
ct_dark_pool_prints        → darkPoolContext (low priority — small consumer base)
ct_nope_minute             → (folded into pulseContext)
ct_net_premium_ticks       → (folded into pulseContext)
ct_greek_flow_minute       → greekFlowContext
ct_top_movers              → topMoversContext
ct_iv_rank_daily           → ivRankContext
ct_max_pain_daily          → maxPainContext
ct_news_analyses           → (already in newsCausalityContext)
ct_breaking_news           → (already in newsCausalityContext)
ct_events                  → (already in eventRecencyContext)
ct_earnings_moves          → (already in eventRecencyContext)
ct_fundamentals_cache      → fundamentalsContext
ct_vix_history             → vixContext
ct_principles              → principlesContext
ct_biases                  → biasesContext
ct_playbooks               → playbooksContext
ct_daily_briefs            → briefHistoryContext
insider trades             → insiderContext
political trades           → politicalContext
analyst actions            → analystContext
sector tide                → sectorTideContext
prediction markets         → predictionMarketsContext
yield curve                → yieldCurveContext
correlations               → correlationsContext
seasonality                → seasonalityContext
ct_central_bank_state      → (already in eventRecencyContext)
ct_indicator_events        → indicatorEventsContext
ct_weekly_review           → weeklyReviewContext
short interest             → shortInterestContext
risk reversal skew         → skewContext
technical indicators       → technicalContext
```

Phase 3 refactor reduces `claudeReadSurface.ts` from 1922 lines (orchestrator + 30+ inline queries) to ~300 lines (orchestrator only) + 30+ helper files each ≤ 300 lines.

---

## 7. Tables NOT covered by any current or planned helper

These tables exist in the schema but no helper composes them today. Phase 1 defers; Phase 4+ may add helpers as needs surface.

```
ct_alarms / ct_signature_alarm_log    — covered indirectly via ct_flags
ct_contract_tracks / ct_contract_quotes — drill-panel only, not regular context
ct_eod_summaries (historical)         — not currently read back as context
ct_eod_reports (historical)           — same
ct_specialist_scoreboard              — not currently read back
ct_disagreements                      — exists but consumer-less
```

If a consumer wants any of these, ship a helper. Don't read directly.

---

## 8. Per-consumer migration scope (Phase 4 spec)

Each Phase 4 PR follows this template per consumer:

1. **Read existing inline context build.** Note what fields it composes, what tables it queries, what prompt template references.
2. **Map to organs.** For each inline field, identify which helper now provides it. If a needed dimension has no helper, scope blocker; coordinate with Phase 1 to add it.
3. **Replace inline build.** Single call: `buildClaudeContext(supabase, { audience, consumerName, organs: [...], tickerFocus })`. Use `BrainOpts.budgetMode: true` for chat / latency-sensitive consumers.
4. **Update prompt template.** Field paths change from inline variable names to `ctx.organs.<name>.data.<field>`. Use `ctx.preamble.temporalAnchor` and `ctx.preamble.whatJustHappened` at top of system prompt.
5. **Add validators.** Wire `temporalValidator` + `eventCoherenceValidator` post-generation. Persist warnings to consumer's existing JSONB column.
6. **Replay test.** 3-5 representative cases per consumer. No regression on output quality vs baseline; measurable reduction in `temporal_validator_warnings`.
7. **Single commit per consumer.** Per CLAUDE.md tenet on small blast radius.

---

## 9. Ready-to-build deliverables (Phase 1 spec for agents)

When Phase 1 starts (Saturday morning), each helper agent receives:

- This audit doc
- The architecture doc
- The `_shared/contextHelper.ts` contract
- The pre-built `flowHeatmapContext.ts` as the reference implementation
- The specific organ's source-table + return-shape from §5 above

Each agent ships:
- New file `_shared/<name>Context.ts` implementing `ContextHelper<TResult>`
- Default-export the helper instance
- Named-export the convenience function `get<Name>Context(supabase, opts)` for backward compat
- Unit test fixture in `_shared/__tests__/` if testing pattern exists in repo

Verification per agent: `deno check` on the new file, manual fetch invocation against live DB returns expected shape, defensive empty-on-error path tested.

---

## 10. Decision log items NOT covered by Phase 1

These ship in later phases:

- **D6 cache layer (DB-backed warm cache)** — Phase 6 addition. Phase 1 helpers use in-process Map only.
- **D7 versioning machinery** — bake `version` field into helpers + ClaudeContext now; build migration tooling on first breaking change (deferred indefinitely).
- **D8 telemetry table** — Phase 3 (orchestrator) creates `ct_brain_telemetry`. Phase 1 helpers populate `meta` fields locally; orchestrator persists.
- **D9 dependency DAG resolver** — Phase 3 in orchestrator. Phase 1 helpers declare `dependencies: []` for now.
- **D10 validator chain** — Phase 1 ships `eventCoherenceValidator` alongside `eventRecencyContext`. Phase 8 extends with `convergenceValidator`, `factualityValidator`, `regulatoryValidator` as needs surface.
- **D11 capture path** — Phase 7 design only. Phase 1 helpers reserve namespace; no writes.

---

*End of audit. This file is the spec input for Phase 1.*
