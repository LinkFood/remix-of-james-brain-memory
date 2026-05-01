# Synthesis Layer — Operational Reference

**Read this first** when working on anything that touches Co-Trader Claude consumers, brain organs, or `claudeReadSurface.ts`. This is the canonical operational doc for the synthesis layer. For design rationale and decision history see `docs/SYNTHESIS_LAYER_ARCHITECTURE.md`. For the audit that drove Phase 0 see `docs/SYNTHESIS_LAYER_AUDIT.md`.

---

## Mission

The Synthesis Layer is the single read API for every Co-Trader Claude-facing surface. Every cron consumer, chat surface, slash command, future voice surface, and terminal-Claude analysis session reads context through one orchestrator (`buildClaudeContext` in `supabase/functions/_shared/claudeReadSurface.ts`) that fans out across 9 brain organs. UW MCP is write-path only — ingester crons land data in our DB; consumers never call UW at runtime.

---

## The 9 Organs

Each lives at `supabase/functions/_shared/<name>Context.ts` and conforms to `ContextHelper<T>` (see `_shared/contextHelper.ts`).

| name | source table(s) | purpose | audience filter | default cap | refresh (s) | cache (s) |
|---|---|---|---|---|---|---|
| `flow_heatmap` | `ct_flow_alerts` (via `ct_flow_heatmap_*` RPCs) | Top-N expiry-week stacks per ticker, sorted by abs(value), with bull/bear leans | all | 3 | 60 | 60 |
| `pulse` | `ct_flow_pulse_ticks` + `ct_ticker_snapshots` | Per-ticker Pulse state at `atTime`: net premium level, slope, regime tag | all | 1 | 30 | 30 |
| `specialist` | `ct_specialist_reads` | Latest specialist read per watchlist ticker: prose, lean, conviction, flagged | all | 10 | 60 | none |
| `detector` | `ct_flags` + `ct_detectors` | Recent detector flags last 24h, top 20 by recency, with pulse-at-fire and score breakdown | all | 20 | 60 | none |
| `tape` | `ct_tape_commentary` | Latest tape narrative paragraph + N prior rows for continuity | all | 3 | 300 | none |
| `james_flags` | `ct_flags` WHERE `source='james_star'` | Per-ticker recent James hand-labeled flags, newest first (legacy `ct_james_flags` was unified into `ct_flags` on 2026-04-27) | **cotrader, analyst** | 5 | 300 | none |
| `news_causality` | `ct_breaking_news` + `ct_news_analyses` + `ct_news_causality` | Severity-ranked recent news with optional causality (flow/dp 15-min hits + price moved) | all | 10 | 60 | none |
| `event_recency` | `ct_events` + `ct_earnings_moves` + `ct_central_bank_state` + breaking news | Three temporal buckets: just_happened (72h), happening_today, upcoming (14d). Source for `preamble.whatJustHappened`. Structurally kills "watching for Powell speech today" hallucination class | all | 5 | 300 | none |
| `analogs` | `ct_session_embeddings` + RPC `search_ct_session_analogs` (cosine over Voyage 512-dim session signatures, EOD outcomes joined) | Top-N most-similar past Co-Trader sessions to today, with their realized EOD return — recall layer | all | 3 | 300 | 300 |

**Audience filter `cotrader,analyst` on `james_flags`** preserves the `paper_claude` isolation contract — paper-Claude never sees James's hand-labeled signals.

---

## Consumers

Every consumer reads through `buildClaudeContext({ audience, consumerName, organs?, tickerFocus? })`. As of Phase 4 completion, no consumer touches UW MCP at runtime; no consumer queries the source tables directly for context already covered by an organ.

| function | audience | typical organs |
|---|---|---|
| `ct-watcher` | cotrader | all (cron, full breadth) |
| `ct-tape-reader` | cotrader | all |
| `ct-trade-idea-generator` | cotrader | all |
| `ct-eod-summary` | cotrader | all |
| `ct-eod-report` | cotrader | all |
| `ct-self-grader` | cotrader | all |
| `ct-curiosity` | cotrader | all |
| `ct-news-sweep` | cotrader | all |
| `ct-trade-advisories` | cotrader | all |
| `ct-debate-outcome-scorer` | cotrader | all |
| `ct-alert-post-mortem` | cotrader | all |
| `ct-lessons-curator` | cotrader | all |
| `ct-playbook-curator` | cotrader | all |
| `ct-daily-brief` | cotrader | all |
| `ct-hypothesis-proposer` | paper_claude | all (research isolation) |
| `ct-hypothesis-health-check` | paper_claude | all |
| `ct-chat` | cotrader | targeted: `flow_heatmap, specialist, detector, news_causality, event_recency, pulse, james_flags` per query |
| Specialist runner (drives 10 per-ticker specialists via `_shared/specialistRunner.ts`) | cotrader | all, with `tickerFocus` per specialist |

---

## Read/Write Separation (D4)

This is the load-bearing rule of the architecture. Violating it is grounds for an immediate revert.

**Write path** — ingester crons call UW MCP and write to DB tables:
- `ct-flow-ingester` → `ct_flow_alerts`
- `ct-oi-snapshot` → `ct_oi_snapshots`
- `ct-news-ingester` → `ct_news_analyses` / `ct_breaking_news`
- `ct-pulse-capture` → `ct_flow_pulse_ticks`
- `ct-vix-ingester`, `ct-greek-flow-ingester`, etc.

**Read path** — every consumer goes through `buildClaudeContext`:
- No `from('ct_flow_alerts')` in consumer files for context-assembly purposes
- No `mcp.unusualWhales.flow....()` in consumer files
- No HTTP calls to UW from consumer code

If a new dimension of the world isn't in an organ yet, **add an organ**, don't bypass the brain.

---

## The Hallucination-Class Kill

Three pieces compose to make temporal hallucinations structurally hard:

1. **`temporalContext.ts`** — pre-tags every timestamp surfaced into prompts with `tagIsoTimestamp()` and prepends `temporalAnchorPreamble` ("Today is YYYY-MM-DD, day NAME, NOW=...").
2. **`event_recency` organ** — pulls the actual outcomes (FOMC decisions, earnings beats/misses, CPI prints) into the 72h `just_happened` bucket. The orchestrator formats this as `preamble.whatJustHappened` — every Claude-facing prompt opens with the literal facts of the last three days.
3. **`temporalValidator` + `eventCoherenceValidator`** — post-Claude validators in the chain (`_shared/temporalValidator.ts`, `_shared/eventCoherenceValidator.ts`). They scan output text for "Powell speech today" or "earnings tomorrow" claims and check against the organs that fed the prompt. Warnings persist to the row Claude wrote (JSONB catch-all) and surface in `/health`.

The bug class this kills: yesterday's news being framed as today's. Pattern documented in agent-memory `temporal_anchor_pattern.md`.

---

## How to Add a New Organ (5 steps)

1. **Source table.** Decide which existing DB table the organ reads. If the table doesn't exist, write the migration first.
2. **Helper file.** Create `supabase/functions/_shared/<name>Context.ts`. Export a default `ContextHelper<TResult>` instance + a `get<Name>Context(...)` thin convenience function. Follow authoring rules in `_shared/contextHelper.ts`:
   - NEVER throw; return defensive empty data + `meta.warning`
   - Respect `opts.cap ?? defaultCap`
   - Pure read; no side effects
   - File ≤ 300 lines (split submodules if larger)
3. **Register in orchestrator.** Add the import + push into the `helpers` array in `claudeReadSurface.ts`'s orchestrator block.
4. **HelperName union.** Add the snake_case name to the `HelperName` type union in `_shared/contextHelper.ts`.
5. **Describe.** Implement `describe()` returning `outputShape` and an `exampleResult`. This is what future helpers use for capability discovery.

Then redeploy every consumer that reads through the brain — the shared module change is bundled per-function.

---

## How to Add a New Consumer (3 steps)

1. **Wire the brain call.** At the top of the handler:
   ```ts
   const ctx = await buildClaudeContext(supabase, {
     audience: 'cotrader',
     consumerName: 'ct-my-new-consumer',
     organs: ['flow_heatmap', 'specialist'], // or 'all'
     tickerFocus: 'NVDA', // optional
   });
   ```
2. **Read from `ctx.organs`.** Guard for presence: `ctx.organs.flow_heatmap?.data`. Use `ctx.preamble.temporalAnchor` and `ctx.preamble.whatJustHappened` at the top of every Claude prompt.
3. **Add the validator chain on the output.** Run `temporalValidator` + `eventCoherenceValidator` post-generation; persist warnings to a JSONB catch-all column on the row Claude wrote.

---

## Telemetry — Where to Look

Every helper invocation in the orchestrator logs to `ct_brain_telemetry`:

| column | meaning |
|---|---|
| `helper_name` | snake_case organ name |
| `helper_version` | helper-internal semver |
| `audience` | `cotrader` / `paper_claude` / `analyst` / `voice` / `slack` / `agent_internal` |
| `ticker_focus` | NULL on full-watchlist calls |
| `consumer_name` | `BrainOpts.consumerName` |
| `latency_ms` | helper's own `meta.latencyMs` |
| `output_size_bytes` | `JSON.stringify(data).length` |
| `cache_hit` | `meta.cacheHit` |
| `error` | NULL on success; `warning:<text>` if helper returned `meta.warning`; `skipped:<reason>` for orchestrator skips; freeform string for orchestrator-caught throws |
| `created_at` | wall clock |

Bucketing for `/health`:
- `error IS NULL` → success
- `error LIKE 'warning:%'` → success-with-warning (no rows, no embedding — benign)
- `error LIKE 'skipped:%'` → skipped (audience filter, organ filter, helper threw)
- else → real error

Telemetry inserts are **fire-and-forget** in `claudeReadSurface.ts`. They never block the read path. If the insert throws (e.g., DB rejected), the consumer never sees it.

### `/health` RPC

```sql
SELECT public.get_brain_health(window_hours => 24);
```

Returns JSON with three sections:
- `totals` — total_invocations, total_errors, total_warnings, total_cache_hits, distinct_helpers, distinct_consumers
- `helpers[]` — per-helper invocations, successes, warnings, errors, skipped, error_rate, cache_hit_rate, p50_latency_ms, p95_latency_ms, avg_output_bytes
- `consumers[]` — per-consumer invocations, errors, warnings

Frontend `/health` dashboard wiring is a future phase — terminal-me + the RPC are enough today.

Quick query patterns:
```bash
# 24h rolling health
KEY=$(npx supabase projects api-keys --project-ref rvhyotvklfowklzjahdd | grep service_role | awk '{print $NF}')
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/rpc/get_brain_health" \
  -H "Authorization: Bearer $KEY" -H "apikey: $KEY" \
  -H "Content-Type: application/json" -d '{"window_hours": 24}' | jq

# raw rows for a single consumer over the last hour
curl -s "https://rvhyotvklfowklzjahdd.supabase.co/rest/v1/ct_brain_telemetry?select=*&consumer_name=eq.ct-watcher&order=created_at.desc&limit=50" \
  -H "Authorization: Bearer $KEY" -H "apikey: $KEY" | jq
```

---

## Operational Gotchas

Accumulated tonight (Phase 0–8) plus relevant standing rules.

- **Shared module change → redeploy every consumer.** `_shared/claudeReadSurface.ts` is bundled per-function at deploy time. Editing it does not propagate; every consumer that imports it must be redeployed. Same goes for any organ helper.

- **Service-role key rotation.** The CLI service-role JWT (`npx supabase projects api-keys`) does not always match runtime `SUPABASE_SERVICE_ROLE_KEY` env. To trigger an edge function from terminal-me, use the vault-stored `service_role_key` via a one-shot `pg_net.http_post` from a SQL migration. Pattern: see commit history for any `*_smoke_*.sql` (terminal-only, repaired-as-reverted after use).

- **Smoke-test migrations are temp files.** Use `npx supabase migration repair --status reverted <ts>` after applying a one-shot DO-block migration so the local repo doesn't carry it. The DO block has no leftover state — repair is purely housekeeping.

- **Don't trust tsc alone.** `npx tsc --noEmit` passes on JSX-in-`.ts` and some esbuild-rejected import shapes. Always run `npm run build` (Vite) before committing frontend or shared-module changes. Per global memory `feedback_tsc_not_sufficient.md`.

- **Pin `@supabase/supabase-js@2.84.0`.** Unpinned `npm:@supabase/supabase-js@2` crashes Deno isolates. Per `~/CLAUDE.md` gotchas. The orchestrator and all helpers already pin.

- **Telemetry must never bubble.** The fire-and-forget IIFE in `claudeReadSurface.ts` is wrapped in try/catch + `.catch()` tail. If you ever modify it, preserve both — D8 telemetry blocking the read path defeats the entire point.

- **Helpers never throw.** If a helper crashes, the orchestrator catches it and records `skipped:error:<msg>`. But the contract is: helpers handle their own errors and return defensive empty data with `meta.warning` set. Use `meta.warning` for "no rows" / "no embedding" / "stale data" — these are NOT errors.

- **Audience filter is per-helper.** `james_flags` excludes `paper_claude` to preserve the original isolation contract. When adding a new organ, default `audienceFilter: undefined` (all audiences) unless there's a real reason to gate.

- **`organs: 'all'` vs explicit list.** Cron consumers (full breadth) use `'all'`. Chat / slash commands / drill panels declare a specific list to keep prompt size bounded. Organ filter is the cheapest token-budget control.

- **`tickerFocus` is per-call, not per-helper.** Pass via `BrainOpts.tickerFocus`. Helpers that ignore it (e.g., `event_recency` for market-wide events) pass through harmlessly.

- **Cache-hit rate of 0 is normal at first call.** Only `flow_heatmap`, `pulse`, and `analogs` opt into caching. Live-data organs (specialist, detector, tape, james_flags, news_causality, event_recency) deliberately skip the cache so consumers see fresh data.

- **The 1922-line `claudeReadSurface.ts` is the orchestrator.** It still carries the original inline data fetches (heartbeats, hypotheses, claude trades, principles, biases, etc.) for the three Phase 0 consumers. Phase 4 migrated 17+ consumers to read through `organs` instead. Future cleanup: convert remaining inline fetches into helpers, slim the orchestrator to ~300 lines.

- **`ct-session-analog` was 404 in production from launch through 2026-04-30 evening.** The cron at `30 21 * * 1-5` was firing into a non-existent function (pg_cron's "succeeded" status reflects the SQL command, not the HTTP response). Deployed 2026-04-30 night. First real `ct_session_embeddings` row builds at the next 21:30 UTC fire (Friday 2026-05-01). Until then, `analogs` returns `meta.warning='no_current_embedding'`. Verify after Friday's close: `SELECT count(*) FROM ct_session_embeddings`.

---

## Files Map

```
supabase/functions/_shared/
├── contextHelper.ts            — the contract (do not modify lightly)
├── claudeReadSurface.ts        — orchestrator + Phase 0 inline fetches
├── flowHeatmapContext.ts       — organ
├── pulseContext.ts             — organ
├── specialistContext.ts        — organ
├── detectorContext.ts          — organ
├── tapeContext.ts              — organ
├── jamesFlagsContext.ts        — organ (audience-gated)
├── newsCausalityContext.ts     — organ
├── eventRecencyContext.ts      — organ (sources whatJustHappened)
├── analogsContext.ts           — organ (Phase 6 recall)
├── temporalContext.ts          — anchor preamble
├── temporalValidator.ts        — validator chain entry
├── eventCoherenceValidator.ts  — validator chain entry
└── chatPromptV1.ts             — chat read contract (UW MCP language removed)

supabase/migrations/
├── 20260501000000_ct_brain_telemetry.sql              — D8 table + RPC
└── 20260501010000_get_brain_health_warning_bucket.sql — RPC follow-up: warning bucket

src/hooks/  (Phase 5 — frontend mirrors of organs)
├── useFlowHeatmap.ts
├── useFlowPulse.ts
├── useSpecialistReads.ts
├── useDetectorFlags.ts
├── useTapeContext.ts
├── useJamesFlags.ts
├── useNewsCausality.ts
└── useCellAnalogs.ts

docs/
├── SYNTHESIS_LAYER_ARCHITECTURE.md  — design rationale, decision log, roadmap
├── SYNTHESIS_LAYER_AUDIT.md         — Phase 0 audit
└── SYNTHESIS_LAYER.md               — this file (operational reference)
```
