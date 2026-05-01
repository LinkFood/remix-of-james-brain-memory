# Synthesis Layer — Architecture

**Status**: committed plan. Build starts 2026-04-30 evening with foundation (this doc, contract, audit). Phase 1 helpers + Phase 4 consumer migrations Saturday onward.
**Authoring**: 2026-04-30 evening, post-conversation between James and terminal-Claude.
**Supersedes**: `SYNTHESIS_LAYER_PROPOSAL` (the earlier scope conversation). Where they conflict, this doc wins.
**Governing tenets**: CLAUDE.md tenets 13 (structural prevention), 15 (kill the class), 24 (no silos), 25 (evolves in structure), 26 (three-mode architecture).

---

## 1. The Vision (One Brain Principle)

**One system. One brain. All consumers talk to each other through it. Built to grow for years.**

Every Claude-facing surface (cron consumers, chat, slash commands, future voice, terminal-Claude analysis) reads from a single composable context layer. Every dimension of the world (flow heatmap, specialist reads, Pulse, detector flags, tape narrative, James's flags, news causality, event recency, principles, biases, hypotheses, analogs) is exposed via a uniform helper contract. New dimensions are additions, not refactors.

The brain is the firewall between Unusual Whales (write path — ingestion only) and consumers (read path — through helpers only). UW is a data source, not a runtime API. Once flow data is ingested into our DB it is OURS — embedded, replayable, mineable. Consumers never re-query UW for read context.

---

## 2. Decision Log — 11 Architectural Commitments

These are the decisions that shape every helper, every consumer, every future addition. Locked unless rewritten with a documented rationale.

### D1 — Helper contract is uniform and extensible

Every organ implements `ContextHelper<TResult>` from `_shared/contextHelper.ts`. New dimension = drop in a new file + register. No orchestrator code change for additions.

```ts
interface ContextHelper<TResult> {
  readonly name: string;
  readonly version: string;          // helper-internal semver
  readonly defaultCap: number;
  readonly isExpensive: boolean;     // skipped on tight budget
  readonly minRefreshSeconds: number;// freshness expectation
  readonly dependencies: readonly string[];      // other helpers this needs
  readonly audienceFilter?: readonly AudienceMode[];
  fetch(ctx: HelperFetchContext, opts: HelperOpts): Promise<HelperResult<TResult>>;
  describe(): HelperDescription;     // capability discovery
}
```

**Why**: future-proof. Dropping in a 17th helper in 2026 should be the same shape as the 1st.

### D2 — ClaudeContext shape is sparse and consumer-declared

`ClaudeContext.organs` is `Record<HelperName, HelperResult>` — not a fixed struct. Consumers declare which organs they need via `BrainOpts.organs`. Default `'all'` for cron consumers; targeted lists for chat, slash commands, drill panels.

**Why**: token-budget control + sparse access. Bulk consumers ask for everything. Chat asks for `['flow_heatmap', 'specialist', 'news']` for one ticker. Same contract, different invocation.

### D3 — Audience modes are first-class, expandable

`AudienceMode` is an enum, not a boolean. Each helper declares which audiences see its output. Today: `'cotrader'` (operational amplifier — sees James's flags), `'paper_claude'` (research-only — firewalled per the original isolation contract).

Future audiences (committed contract surface): `'analyst'` (terminal-Claude, full breadth), `'voice'` (ElevenLabs, brevity-optimized), `'slack'` (response context, slash command answers), `'agent_internal'` (one Co-Trader subsystem talking to another).

**Why**: the post-2026-04-25 strategic reset is one of many audience reconfigurations to come. Treating audience as a parameter (not a hardcoded firewall) means future reshapes don't fork the brain.

### D4 — Read/write separation is a hard rule

**Write path**: UW MCP → ingester crons → DB tables (`ct_flow_alerts`, `ct_oi_snapshots`, `ct_news_analyses`, etc.). UW touches the system here and only here.

**Read path**: consumers → synthesis layer → helpers → DB tables. **Consumers never call UW MCP at runtime.** Period. Today's `ct-chat` violates this rule and is Phase 4 priority migration.

**Why**: this is the load-bearing principle of the entire architecture. Separation makes chat subsecond (no MCP roundtrip), zero UW cost for reads, makes the brain queryable from any surface (web, slack, voice, terminal), and means UW outages don't cascade into consumer outages.

### D5 — Composition is fan-out at request time, not bulk-precompute

`buildClaudeContext()` invokes selected helpers via `Promise.all`. Each helper is independent and stateless. No background pre-compute job assembles a "current brain snapshot." If a consumer needs fresher data they re-call.

**Why**: simplicity, freshness guarantees, no cache-coherence headaches. The cache layer (D6) handles latency.

### D6 — Caching is a separate concern, two-tiered

In-process Map cache (today's `uwClient.ts` pattern) for the same isolate's repeated calls. Future: DB-backed warm cache (`ct_brain_cache`) for cross-isolate reuse on hot organs. Each helper opts in via `cacheTtlSeconds`. Live-data organs (flow alerts, pulse ticks) opt OUT.

**Why**: lets us add the warm cache later without changing helper contracts. In-process is enough for v1.

### D7 — Versioning is built in, machinery is lazy

`ClaudeContext.version: 'v1'`. Helpers track their own internal `version` field. We bake in the field now; add migration machinery on the first breaking change.

**Why**: pre-emptive versioning machinery is over-engineering. The field is cheap insurance.

### D8 — Telemetry is auto, not opt-in

Every helper invocation logs to `ct_brain_telemetry`: `helper_name, helper_version, audience, ticker_focus, latency_ms, output_size_bytes, cache_hit, consumer_name, error`. Wired in the orchestrator, not in each helper. Feeds `/health` dashboard.

**Why**: visibility from day 1. Without this we can't see when a helper degrades or when a consumer is over-fetching, and we'd be flying blind on the "brain" we're committing to.

### D9 — Helper dependencies are static, resolved at registration

A helper declares `dependencies: ['flow_heatmap', 'specialist']` to express "I need these other organs already fetched." Orchestrator resolves the DAG at registration time. No runtime surprises, no cycles, deterministic ordering.

**Why**: keeps composition simple. Cycles fail at deploy, not at runtime.

### D10 — Validator chain is composable

Multiple validators run post-Claude-call as a chain. Each returns `{ok: boolean, warnings: ValidatorWarning[]}`. Today: `temporalValidator`. Phase 1 add: `eventCoherenceValidator` (the structural complement to `getEventRecencyContext`). Future: `convergenceValidator` (cross-organ contradiction), `factualityValidator`, `regulatoryValidator`.

**Why**: the bug class today's temporal validator catches has 5+ siblings we'll discover. Chain pattern lets us add without restructuring.

### D11 — Capture path anticipated, not specified

Phase 7 designs the write-back semantics (James's actions becoming a brain input). For now, the brain contract reserves space: `BrainWrites` namespace is sketched but not built. When Phase 7 specifies, the brain's read API doesn't have to change.

**Why**: writing prematurely paints us into a corner. Reserving space costs nothing.

---

## 3. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         WRITE PATH                              │
│  UW MCP → Ingester Crons → DB Tables                            │
│  (ct-flow-ingester, ct-oi-snapshot, ct-news-ingester, ...)      │
│  This is the ONLY place UW MCP is called at runtime.            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   DB (Postgres)  │
                    │  ct_flow_alerts, │
                    │  ct_oi_snapshots,│
                    │  ct_specialist_  │
                    │  reads, etc.     │
                    └──────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       SYNTHESIS LAYER                           │
│                                                                 │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │ ContextHelpers  │  │  Orchestrator   │  │ ValidatorChain  │  │
│  │ (organs)        │◄─┤  (composition)  ├──┤ (post-call)     │  │
│  ├─────────────────┤  ├─────────────────┤  ├─────────────────┤  │
│  │ flowHeatmap     │  │ buildContext    │  │ temporal        │  │
│  │ specialist      │  │ ├ audience gate │  │ eventCoherence  │  │
│  │ pulse           │  │ ├ dep resolve   │  │ convergence     │  │
│  │ detector        │  │ ├ Promise.all   │  │ factuality      │  │
│  │ tape            │  │ ├ caching       │  │ regulatory      │  │
│  │ jamesFlags      │  │ ├ telemetry     │  │ ...             │  │
│  │ newsCausality   │  │ └ assemble      │  │                 │  │
│  │ eventRecency    │  └─────────────────┘  └─────────────────┘  │
│  │ principles      │                                            │
│  │ biases          │                                            │
│  │ hypotheses      │                                            │
│  │ ... (extensible)│                                            │
│  └─────────────────┘                                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                          READ PATH                              │
│                                                                 │
│  Cron Consumers           Chat / Slash         UI Mirror Hooks  │
│  (specialists,            (ct-chat,            (useFlowHeatmap, │
│   tape-reader,            slack /ct-flow,      useSpecialist,   │
│   eod-summary,            terminal-claude)     useDetectorFlags)│
│   trade-idea-gen)                                               │
│  bulk fan-out             targeted query       sparse subscribe │
│                                                                 │
│  All read through buildClaudeContext(). NEVER call UW directly. │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Helper Contract — Full Specification

Lives in `supabase/functions/_shared/contextHelper.ts` (created tonight as foundation).

```ts
export type AudienceMode =
  | 'cotrader'       // operational amplifier for James — sees james flags
  | 'paper_claude'   // research-layer firewall — original isolation contract
  | 'analyst'        // terminal-Claude analysis — full breadth, no caps
  | 'voice'          // ElevenLabs — brevity-optimized
  | 'slack'          // Slack response — slash command answers
  | 'agent_internal';// one subsystem talking to another

export interface HelperFetchContext {
  supabase: SupabaseClient;
  audience: AudienceMode;
  sessionDate: string;          // 'YYYY-MM-DD' anchor
  watchlist: readonly string[];
  consumerName: string;          // for telemetry
}

export interface HelperOpts {
  tickerFocus?: string;          // null = full watchlist
  cap?: number;                  // override defaultCap
  freshnessSeconds?: number;     // override minRefreshSeconds
  // helper-specific opts via index access
  [key: string]: unknown;
}

export interface HelperResult<TResult> {
  data: TResult;
  meta: {
    helperName: string;
    helperVersion: string;
    fetchedAt: string;
    rowCount: number;
    cacheHit: boolean;
    latencyMs: number;
    truncated: boolean;          // hit cap?
  };
}

export interface HelperDescription {
  name: string;
  version: string;
  defaultCap: number;
  expensive: boolean;
  minRefreshSeconds: number;
  dependencies: readonly string[];
  audienceFilter?: readonly AudienceMode[];
  outputShape: string;            // human-readable summary
  exampleResult?: unknown;
}

export interface ContextHelper<TResult> {
  readonly name: string;
  readonly version: string;
  readonly defaultCap: number;
  readonly isExpensive: boolean;
  readonly minRefreshSeconds: number;
  readonly dependencies: readonly string[];
  readonly audienceFilter?: readonly AudienceMode[];
  readonly cacheTtlSeconds?: number;  // opt-in caching

  fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<TResult>>;

  describe(): HelperDescription;
}
```

### Helper authoring rules

1. **Never throws.** Failures return defensive empty `data` + warning in `meta`. Pattern in `flowHeatmapContext.ts`.
2. **Caps respected.** `opts.cap ?? defaultCap` is the upper bound on rows/depth returned.
3. **Pure read.** No DB writes. No side effects beyond telemetry (which the orchestrator handles).
4. **Single file ≤ 300 lines.** If bigger, split into submodules.
5. **Typed interface exported.** TypeScript surface is the contract; runtime is enforcement.
6. **Self-describable.** `describe()` returns enough metadata that the orchestrator could compose it without prior knowledge.

---

## 5. Orchestrator Design

`buildClaudeContext()` in `_shared/claudeReadSurface.ts` becomes the orchestrator. After Phase 3:

```ts
export interface BrainOpts {
  audience: AudienceMode;
  organs?: readonly HelperName[] | 'all';     // defaults to 'all'
  tickerFocus?: string;
  consumerName: string;
  perOrganOpts?: Partial<Record<HelperName, HelperOpts>>;
}

export async function buildClaudeContext(
  supabase: SupabaseClient,
  opts: BrainOpts,
): Promise<ClaudeContext> {
  // 1. Resolve which helpers to run from opts.organs + audience filter
  // 2. Resolve dependency DAG (D9)
  // 3. Fan out via Promise.all (D5) with per-helper cache check (D6)
  // 4. Audience-gate each result
  // 5. Build preamble strings (temporal anchor, what-just-happened, convergent view)
  // 6. Log telemetry per helper (D8)
  // 7. Return ClaudeContext
}

export interface ClaudeContext {
  version: 'v1';
  meta: {
    audience: AudienceMode;
    sessionDate: string;
    sessionDayName: string;
    nowEt: string;
    nowUtc: string;
    generatedAt: string;
    helpersInvoked: string[];
    helpersSkipped: { name: string; reason: string }[];
    totalLatencyMs: number;
    consumerName: string;
  };
  organs: Partial<Record<HelperName, HelperResult<unknown>>>;
  preamble: {
    temporalAnchor: string;       // existing
    whatJustHappened: string;     // NEW — sourced from eventRecency
    convergentView?: string;      // optional — cross-organ summary
  };
}
```

Existing inline-data callers in `claudeReadSurface.ts` (heartbeats, hypotheses, trades, news, indicators, sector tide, etc.) become helpers in their own files. The 1922-line monolith becomes a ~300-line orchestrator + 15 helpers each ≤ 300 lines.

---

## 6. Roadmap — Honest 8-12 Day Build

### Phase 0 — Foundation [TONIGHT]
- This architecture doc
- `_shared/contextHelper.ts` contract
- `docs/SYNTHESIS_LAYER_AUDIT.md`

**Outcome**: every subsequent phase has a concrete spec.

### Phase 1 — Helpers (Day 1-2: Saturday-Sunday)
8 organs as separate files, parallel agents:
- `getSpecialistContext` (ct_specialist_reads)
- `getPulseContext` — **already exists, validate against new contract**
- `getDetectorContext` (ct_flags + ct_detectors)
- `getTapeContext` (ct_tape_commentary)
- `getJamesFlagsContext` (ct_james_flags) — audience-gated
- `getNewsCausalityContext` (ct_news_analyses + ct_breaking_news)
- `getEventRecencyContext` (ct_events + ct_earnings_moves + ct_central_bank_state) — **P0**
- `eventCoherenceValidator` (Phase 8a-bis, ships with eventRecency)

**Outcome**: organs exist, follow contract, can be invoked individually.

### Phase 2 — Audience parameterization (Day 2: Sunday morning)
- `claudeReadSurface.ts` accepts `audience` mode
- Existing firewall becomes per-helper `audienceFilter`
- `paper_claude` audience preserves original isolation
- `cotrader` audience exposes James-side data

**Outcome**: same brain, different visibility per audience.

### Phase 3 — Orchestrator composition (Day 2-3: Sunday-Monday)
- Refactor existing inline queries in `claudeReadSurface.ts` into helpers
- Implement `buildClaudeContext` per spec above
- Add `helpersInvoked`/`helpersSkipped` telemetry
- Add `whatJustHappened` preamble sourced from eventRecency
- Existing 3 wired consumers (daily-brief, hypothesis-proposer, hypothesis-health-check) get richer brain transparently

**Outcome**: orchestrator works. 1922-line file becomes ~300-line orchestrator + helper files.

### Phase 4 — Consumer migration (Day 4-7: Monday-Thursday)
17+ Co-Trader Claude consumers migrate to `buildClaudeContext`:
- `_shared/specialistRunner.ts` (drives 10 specialists — single migration reaches all 10)
- `ct-chat` (THE chat consumer that today re-queries UW — read-path violation fix)
- `ct-tape-reader`
- `ct-trade-idea-generator`
- `ct-eod-summary`, `ct-eod-report`
- `ct-watcher`, `ct-self-grader`
- `ct-curiosity`, `ct-news-sweep`, `ct-trade-advisories`
- `ct-debate-outcome-scorer`, `ct-alert-post-mortem`
- `ct-lessons-curator`, `ct-playbook-curator`

**Per-consumer**: read existing inline build, replace with `buildClaudeContext({ organs: [...], audience, ticker_focus })`, update prompt template, replay test.

**Outcome**: zero `supabase.from(...)` direct table reads in any consumer for tables already covered by helpers. Final grep validates.

### Phase 5 — Heatmap UI as convergence (Day 7-8: Wednesday-Thursday)
- React hooks mirror helpers (`useSpecialistReads`, `useFlowPulse`, `useDetectorFlags`, `useJamesFlags`, etc.)
- Heatmap row chips: per-ticker specialist + Pulse + news state
- Cell markers: detector flags, James flags
- Drill panel "System State" section
- Heatmap-side fixes from earlier audit (history RPC rewrite, per-strike drill, lookback honor)

**Outcome**: `/heatmap` is the convergence terminus. Each row tells the full story per ticker.

### Phase 6 — Recall layer (Day 9-10: weekend after)
- New RPC `ct_cell_analogs` (semantic similarity over embedded ct_flow_alerts)
- `getAnalogsContext` helper
- Drill panel "Historical Analogs" section
- Stretch: James-flag-shape detector

**Outcome**: pattern-matching against history is first-class. "This looks like X past situation, which resolved Y."

### Phase 7 — Capture path (design only, then build)
- Design doc for write-back semantics
- One-button "I'm acting on this cell" or Slack `/ct-flag` command
- Decision: extend `ct_james_flags` vs new `ct_james_reads` table
- Build follows after design conversation with James

**Outcome**: human-in-the-loop closure starts.

### Phase 8 — Validation, monitoring, docs (Day 11-12)
- Validator chain extended (event coherence, convergence)
- Per-consumer hallucination-rate metric on `/health`
- Cron health entries for new wires
- `docs/SYNTHESIS_LAYER.md` finalized; CLAUDE.md updated

**Outcome**: brain is observable, regressions surface in /health not in production.

---

## 7. Risk Register

| Risk | Mitigation | Status |
|---|---|---|
| Helper contract too rigid | v1 contract is small; expand on first real friction | Live |
| ClaudeContext bloats prompts | Per-consumer organ subset declared via opts | Built into D2 |
| Latency from fan-out | In-process cache + isExpensive flag for budget mode | Built into D6 |
| Versioning machinery premature | Bake in field; build machinery on first breaking change | Built into D7 |
| Frontend hook drift | Telemetry catches when hook reads stale field | Built into D8 |
| Consumer migration risk | Replay harness on each migration; no merge without baseline match | Phase 4 process |
| Cache cold-start latency | DB-backed warm cache for hot organs (Phase 6 addition) | Future |
| Helper added without dependency declaration | Static DAG resolution at registration fails fast | Built into D9 |
| Audience parameterization breaks paper-claude experiment | `paper_claude` audience preserves original firewall | Built into D3 |
| `ct-chat` migration breaks the existing chat | Replay harness on chat conversation history before merge | Phase 4 |
| Helper count proliferation | `describe()` + telemetry surface what's worth keeping | Built into D8 |

---

## 8. Open Questions / Future Work

These are NOT blockers. Documented for the next person reading this cold.

- **Multi-user mode.** Today single-user. Audience modes anticipate multi-user. The actual user-isolation work is its own future project.
- **Cross-facet brain (DCD ↔ Co-Trader).** DCD shares Supabase. Future: helpers can pull from `hunt_*` tables when relevant. Cross-facet learning bridge already partially exists (`ct-reflect-to-jac`). Synthesis layer should not re-implement; should compose.
- **Subscription pattern.** Today's brain is request/response. Future: helpers publish change events, consumers subscribe ("tell me when AAPL specialist read changes"). Phase 6+ if real-time need surfaces.
- **Streaming responses.** Today's `callClaude` is non-streaming. Future: chat surface streams. Synthesis layer is independent of streaming choice.
- **Embeddings beyond flow alerts.** Today: `ct_flow_alerts` embedded via Voyage. Future: embed daily heatmap snapshots, EOD narratives, James's flags, specialist reads. Recall layer (Phase 6) can grow to all.
- **Prompt caching across consumers.** Many Claude consumers share preamble structure. Anthropic prompt caching (already in stack — see `feedback_sonnet_long_json_use_tool_use.md`) could share preamble cache across consumers. Phase 8 audit.

---

## 9. Naming Conventions

- Helper file: `_shared/<name>Context.ts` (e.g., `flowHeatmapContext.ts`)
- Helper function: `get<Name>Context` (e.g., `getFlowHeatmapContext`)
- Helper class export (if needed for testing): `<Name>Helper` (e.g., `FlowHeatmapHelper`)
- Helper telemetry name: snake_case (e.g., `'flow_heatmap'`)
- Frontend hook: `use<Name>` (e.g., `useFlowHeatmap`)
- ClaudeContext.organs key: snake_case (e.g., `organs.flow_heatmap`)
- Validator file: `_shared/<name>Validator.ts` (e.g., `temporalValidator.ts`, `eventCoherenceValidator.ts`)

---

## 10. Files This Doc Reserves

These paths are committed to the synthesis layer. New work should not collide:

```
supabase/functions/_shared/
  ├── contextHelper.ts            (v1 contract — Phase 0 tonight)
  ├── flowHeatmapContext.ts       (already exists — adapt to contract Phase 1)
  ├── pulseContext.ts             (already exists — adapt to contract Phase 1)
  ├── temporalContext.ts          (already exists — adapt or wrap)
  ├── temporalValidator.ts        (already exists — first validator in chain)
  ├── eventCoherenceValidator.ts  (Phase 1 P0 — ships with eventRecencyContext)
  ├── specialistContext.ts        (Phase 1)
  ├── detectorContext.ts          (Phase 1)
  ├── tapeContext.ts              (Phase 1)
  ├── jamesFlagsContext.ts        (Phase 1)
  ├── newsCausalityContext.ts     (Phase 1)
  ├── eventRecencyContext.ts      (Phase 1 P0)
  ├── analogsContext.ts           (Phase 6)
  └── claudeReadSurface.ts        (Phase 3 — orchestrator refactor)

src/hooks/
  ├── useFlowHeatmap.ts           (already exists)
  ├── useSpecialistReads.ts       (already exists — wire to heatmap row Phase 5)
  ├── useFlowPulse.ts             (already exists — wire to heatmap row Phase 5)
  ├── useDetectorFlags.ts         (Phase 5 — new)
  ├── useTapeContext.ts           (Phase 5 — new)
  ├── useJamesFlags.ts            (Phase 5 — new)
  ├── useNewsCausality.ts         (Phase 5 — new)
  └── useCellAnalogs.ts           (Phase 6 — new)

docs/
  ├── SYNTHESIS_LAYER_ARCHITECTURE.md  (this doc)
  ├── SYNTHESIS_LAYER_AUDIT.md         (Phase 0 audit, tonight)
  └── SYNTHESIS_LAYER.md               (final overview, Phase 8)

supabase/migrations/
  ├── <date>_ct_brain_telemetry_table.sql      (D8 — Phase 3)
  ├── <date>_ct_cell_analogs_rpc.sql            (Phase 6)
  └── <date>_ct_flow_heatmap_history_rewrite.sql (Phase 5 — heatmap-side fix)
```

---

## 11. The Decision That Locks This In

**The brain is the single read API for everything Co-Trader.** Cron consumers, chat, slash commands, future voice, terminal-Claude analysis — all read through `buildClaudeContext`. UW MCP is write-path only. Adding a new sense organ is a single new file. Adding a new audience is a new enum value + per-helper rule. Adding a new consumer is `buildClaudeContext({ organs: [...], audience, ticker_focus })` + a prompt.

This is the bones the system lives on for years.

---

*End of architecture document.*
