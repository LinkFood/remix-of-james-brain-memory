/**
 * contextHelper — the single contract every brain organ implements.
 *
 * See `docs/SYNTHESIS_LAYER_ARCHITECTURE.md` for the full architectural rationale.
 *
 * Principle: every dimension of the world (flow heatmap, specialist reads, Pulse,
 * detector flags, tape narrative, James's flags, news causality, event recency,
 * analogs, ...) is exposed via a uniform `ContextHelper<T>` shape. The orchestrator
 * (`buildClaudeContext` in `claudeReadSurface.ts`) composes them via Promise.all
 * with audience filtering, dependency resolution, caching, and telemetry.
 *
 * New organ = new file in `_shared/<name>Context.ts` exporting a default
 * `ContextHelper<T>` instance + a `get<Name>Context()` convenience function. No
 * orchestrator code change for additions.
 *
 * Read/write separation rule (D4 in the architecture doc): consumers of this
 * contract never call UW MCP. UW is write-path only (ingestion crons). Helpers
 * read from our DB only. The brain is the firewall between UW and consumers.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

// ---------------------------------------------------------------------------
// Audience modes (D3) — first-class enum, expandable
// ---------------------------------------------------------------------------

/**
 * Each consumer declares an audience. Each helper declares which audiences
 * see its output via `audienceFilter`. The orchestrator gates per-organ.
 *
 * - `cotrader` — operational amplifier for James. Sees ct_james_flags, ct_notes.
 * - `paper_claude` — research-layer firewall. Original isolation contract.
 *   Does NOT see James's hand-labeled signals; preserves paper-Claude's
 *   independence from James's behavior for the generational experiment.
 * - `analyst` — terminal-Claude analysis sessions. Full breadth, no per-organ
 *   caps unless explicitly set.
 * - `voice` — ElevenLabs voice surface. Brevity-optimized; helpers should
 *   compress output (top-1 instead of top-3, no JSON arrays in narration).
 * - `slack` — Slack response context. Slash commands, conversational.
 * - `agent_internal` — one Co-Trader subsystem talking to another. No
 *   user-facing language constraints.
 */
export type AudienceMode =
  | 'cotrader'
  | 'paper_claude'
  | 'analyst'
  | 'voice'
  | 'slack'
  | 'agent_internal';

// ---------------------------------------------------------------------------
// Helper invocation context + opts
// ---------------------------------------------------------------------------

/**
 * Per-invocation context the orchestrator passes to every helper. Helpers
 * MUST NOT cache the SupabaseClient across invocations — the orchestrator
 * may pass a different client per audience or per consumer in future.
 */
export interface HelperFetchContext {
  supabase: SupabaseClient;
  audience: AudienceMode;
  /** YYYY-MM-DD anchor in America/New_York. Same as temporalContext. */
  sessionDate: string;
  /** The full watchlist for this consumer's view of the world. */
  watchlist: readonly string[];
  /** For telemetry — which consumer triggered this fetch. */
  consumerName: string;
}

/**
 * Per-call options that override helper defaults. All fields optional.
 * Helpers ignore unknown keys (additive over time).
 */
export interface HelperOpts {
  /** Single-ticker focus — null/undefined means full watchlist. */
  tickerFocus?: string;
  /** Override `defaultCap`. Always upper-bounded by helper-internal max. */
  cap?: number;
  /** Override `minRefreshSeconds` for staleness checks. */
  freshnessSeconds?: number;
  /**
   * Consumer identity for per-consumer config overrides. When set, helpers
   * may look up `<helper>.consumer.<consumerName>.*` keys in `ct_config`
   * before falling back to global `<helper>.*` defaults. Used by
   * flowHeatmapHelper as of 2026-05-06; other helpers may adopt the same
   * pattern.
   */
  consumerName?: string;
  /** Helper-specific overrides. Keys are documented per helper. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helper output shape
// ---------------------------------------------------------------------------

/**
 * Read-Layer Integrity Bundle Phase 1 (2026-05-06) — consumer-facing organ
 * metadata. Distinct from `HelperResult.meta` which is internal telemetry
 * (latencyMs, cacheHit, etc.) for orchestrator persistence to
 * ct_brain_telemetry. `OrganMetadata` is what the captain (or any consumer)
 * reads to disambiguate organ output: when was this data computed
 * (as_of), where did it come from (source), what time window does it
 * cover (window), and what semantic state is the data in (status).
 *
 * Phase 1 ships type-only — helpers don't populate organMetadata yet.
 * Phase 2 (per-organ producer updates, weeks of work) populates per
 * helper's domain. Backward compat: consumers reading
 * `result.organMetadata` see undefined until Phase 2 ships.
 *
 * Schema design rationale: see `docs/system-map/organ-metadata-schema.md`.
 *
 * Resolves four punchlist items in one structural ship:
 *   - 🔴#1 SPY drift (window-semantics-drift) → window field
 *   - 🔴#2 null causality (structured-zero-vs-null) → status field
 *   - 🟡#5 observed_patterns(SPY) empty → likely status field
 *   - 🟡#6 per-organ as_of meta-fix → as_of field
 */
export type OrganStatus =
  | 'populated'                         // real signal present
  | 'no_signal_detected'                // producer ran, found nothing
  | 'balanced_flow_no_directional_signal' // volume but no directional read (IWM Phase A)
  | 'firehose_only_no_causality'        // breaking_news items lack analysis-keyed data (PR #34 A.7)
  | 'pending_analysis'                  // producer hasn't run for this row yet
  | 'data_missing'                      // expected data missing — investigation candidate
  | 'error'                             // producer fired but errored
  | 'stale';                            // data older than freshness threshold for this organ

export interface OrganMetadata {
  /**
   * ISO 8601 timestamp of when this organ's data was fetched/computed.
   * Resolves 🟡#6 freshness ambiguity. Captain reads "as_of=2026-05-05T21:01Z"
   * and immediately knows the organ output is stale, vs intraday.
   */
  as_of: string;
  /**
   * Identifier for the producer: table name, cron name, edge function
   * name, or compound. Resolves the partial-source-divergence cause from
   * 🔴#1 (Finnhub vs internal flow computation for SPY return).
   */
  source: string;
  /**
   * Time window this data covers — "close-to-close YYYY-MM-DD",
   * "intraday open-to-close YYYY-MM-DD", "trailing Nh decayed",
   * "trailing 15min", etc. Resolves the dominant cause of 🔴#1 (window
   * semantics drift between morning_brief and eod_summary).
   */
  window: string;
  /** Semantic state per OrganStatus enum. Resolves 🔴#2 + 🟡#5. */
  status: OrganStatus;
}

/**
 * Every helper returns this shape. `data` is the typed payload; `meta`
 * carries telemetry the orchestrator persists to ct_brain_telemetry.
 * Helpers populate meta themselves so the orchestrator only does aggregation.
 *
 * `organMetadata` (Phase 1 of read-layer integrity bundle, 2026-05-06)
 * is OPTIONAL during Phase 1 — helpers don't populate it yet. Phase 2
 * per-organ updates land it incrementally. Consumers reading
 * `result.organMetadata` should treat undefined as "metadata not yet
 * provided by this organ" and fall back to current behavior.
 */
export interface HelperResult<TResult> {
  data: TResult;
  meta: {
    helperName: string;
    helperVersion: string;
    /** ISO 8601 timestamp the data was fetched. */
    fetchedAt: string;
    /** Number of rows / items returned in `data`. */
    rowCount: number;
    /** True if served from cache (helper sets this when it consults cache). */
    cacheHit: boolean;
    /** Wall-clock ms inside the helper's `fetch()`. */
    latencyMs: number;
    /** True if `cap` cut off rows that would otherwise be returned. */
    truncated: boolean;
    /** Optional warning string (e.g., 'rate_limit_partial', 'stale_data'). */
    warning?: string;
  };
  /**
   * Read-Layer Integrity Bundle Phase 1 (2026-05-06). Optional during
   * transition; populated by helpers in Phase 2 (per-organ updates).
   * Consumers default to current behavior when undefined.
   */
  organMetadata?: OrganMetadata;
}

// ---------------------------------------------------------------------------
// Helper self-description (for capability discovery + docs gen)
// ---------------------------------------------------------------------------

export interface HelperDescription {
  name: string;
  version: string;
  defaultCap: number;
  expensive: boolean;
  minRefreshSeconds: number;
  dependencies: readonly string[];
  audienceFilter?: readonly AudienceMode[];
  /** One-paragraph human-readable summary of what this helper returns. */
  outputShape: string;
  /** Optional example return value, useful for docs and replay fixtures. */
  exampleResult?: unknown;
}

// ---------------------------------------------------------------------------
// THE CONTRACT
// ---------------------------------------------------------------------------

/**
 * Every brain organ implements this. New organ = new file in `_shared/`
 * exporting a `ContextHelper<TResult>` + a `get<Name>Context(...)` thin
 * convenience function over `helper.fetch(...)`.
 *
 * Authoring rules:
 *   1. NEVER throw. Failures return defensive empty `data` with `meta.warning`.
 *      Pattern in `flowHeatmapContext.ts`.
 *   2. Caps respected. `opts.cap ?? defaultCap` is the upper bound on rows.
 *   3. PURE READ. No DB writes. No side effects beyond optional logging.
 *   4. Single file ≤ 300 lines. If bigger, split into submodules.
 *   5. Typed interfaces exported alongside the implementation.
 *   6. `describe()` returns enough metadata that the orchestrator could
 *      compose this helper without prior knowledge.
 *   7. NEVER call UW MCP. Read from our DB only (D4 — read/write separation).
 */
export interface ContextHelper<TResult> {
  /** Stable identifier. snake_case. Used as ClaudeContext.organs key. */
  readonly name: string;

  /** Helper-internal semver. Bumps on output shape change. */
  readonly version: string;

  /** Default rows / depth returned. `opts.cap` overrides. */
  readonly defaultCap: number;

  /**
   * If true, orchestrator skips this helper when `BrainOpts.budgetMode === true`
   * (used by chat surfaces or any latency-sensitive caller).
   */
  readonly isExpensive: boolean;

  /**
   * How fresh the underlying data should be before re-querying. Helpers may
   * use this to short-circuit if `meta.fetchedAt` is recent enough.
   */
  readonly minRefreshSeconds: number;

  /**
   * Names of other helpers this one needs. Orchestrator resolves the DAG at
   * registration. Cycles fail at deploy. Empty array = standalone.
   */
  readonly dependencies: readonly string[];

  /**
   * If set, this helper only runs when `audience` is in this list. Default
   * (undefined) = all audiences see this helper.
   */
  readonly audienceFilter?: readonly AudienceMode[];

  /**
   * Opt-in caching TTL. Live-data helpers (flow alerts, pulse ticks) leave
   * unset (no caching). Computed/aggregated helpers (heatmap stacks, news
   * digest) opt in. Default is no caching.
   */
  readonly cacheTtlSeconds?: number;

  /**
   * The actual fetch. Receives orchestrator context + per-call opts, returns
   * the typed result. Defensive on errors (never throws).
   */
  fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<TResult>>;

  /** Capability metadata for orchestrator + docs + replay. */
  describe(): HelperDescription;
}

// ---------------------------------------------------------------------------
// Brain-level types (used by the orchestrator)
// ---------------------------------------------------------------------------

/**
 * Snake_case helper identifiers. The orchestrator uses these as keys in
 * `ClaudeContext.organs`. New organs append to this string union.
 */
export type HelperName =
  | 'flow_heatmap'
  | 'pulse'
  | 'specialist'
  | 'detector'
  | 'tape'
  | 'james_flags'
  | 'news_causality'
  | 'event_recency'
  | 'principles'
  | 'biases'
  | 'hypotheses'
  | 'claude_trades'
  | 'analogs'
  | 'specialist_recall'
  | 'regime'
  | 'flow_butterfly';

/**
 * Top-level brain options. Consumers pass this to `buildClaudeContext`.
 */
export interface BrainOpts {
  /** Required — every consumer declares its audience. */
  audience: AudienceMode;

  /** For telemetry — which consumer is invoking the brain. */
  consumerName: string;

  /**
   * Which organs to fetch. `'all'` (default) runs every registered helper
   * gated by audienceFilter. A list runs only the named helpers.
   *
   * Bulk consumers (cron jobs that need full context): omit or use 'all'.
   * Targeted consumers (chat, slash commands, drill panels): list specific
   * organs to keep prompt size bounded.
   */
  organs?: readonly HelperName[] | 'all';

  /**
   * Single-ticker focus passed to every helper that supports it. Helpers
   * that ignore tickerFocus (e.g., principles, biases) simply pass through.
   */
  tickerFocus?: string;

  /**
   * If true, orchestrator skips helpers where `isExpensive === true`.
   * Used by chat surfaces and any latency-sensitive caller.
   */
  budgetMode?: boolean;

  /**
   * Per-organ override of caps, freshness, helper-specific opts. Empty
   * default. Most callers leave this empty.
   */
  perOrganOpts?: Partial<Record<HelperName, HelperOpts>>;
}

/**
 * The shape every Claude consumer reads. Sparse — only requested organs
 * appear. Consumers can guard on presence: `ctx.organs.flow_heatmap?.data`.
 */
export interface ClaudeContext {
  /** Bumps on breaking changes to this interface. v1 is launch. */
  version: 'v1';

  meta: {
    audience: AudienceMode;
    consumerName: string;
    sessionDate: string;
    sessionDayName: string;
    nowEt: string;
    nowUtc: string;
    generatedAt: string;
    /** Names of helpers that ran successfully. */
    helpersInvoked: string[];
    /**
     * Helpers skipped by the orchestrator (budget mode, audience filter,
     * dependency failure). Each entry has a reason for telemetry/debugging.
     */
    helpersSkipped: { name: string; reason: string }[];
    totalLatencyMs: number;
  };

  /** Sparse map. Only requested organs appear. */
  organs: Partial<Record<HelperName, HelperResult<unknown>>>;

  /** Pre-formatted strings ready to drop into prompts. */
  preamble: {
    /** From `temporalContext`. The session-date anchor every consumer prepends. */
    temporalAnchor: string;
    /**
     * Sourced from `event_recency.just_happened`. Bullet list of material
     * events in the last 72h with outcomes (FOMC decisions, earnings beats/misses,
     * macro prints, geopolitical). Structural prevention of "Powell speech today"
     * style hallucinations on prior-day events.
     */
    whatJustHappened: string;
    /**
     * Optional cross-organ summary written by the orchestrator. Populated when
     * helpers' outputs strongly agree or disagree. Empty by default.
     */
    convergentView?: string;
  };
}

// ---------------------------------------------------------------------------
// Validator chain (D10) — composable post-Claude-call safety net
// ---------------------------------------------------------------------------

export interface ValidatorWarning {
  validator: string;
  severity: 'critical' | 'warning';
  quote?: string;
  issue: string;
}

export interface ValidatorResult {
  ok: boolean;
  warnings: ValidatorWarning[];
}

/**
 * Each validator runs post-generation. Receives the Claude output text + the
 * context it was given. Returns warnings for the consumer to persist alongside
 * the row Claude wrote.
 *
 * Today's chain: temporalValidator. Phase 1 add: eventCoherenceValidator.
 * Future: convergenceValidator, factualityValidator, regulatoryValidator.
 */
export interface ContextValidator {
  readonly name: string;
  readonly version: string;
  validate(
    outputText: string,
    context: ClaudeContext,
  ): Promise<ValidatorResult>;
}

// ---------------------------------------------------------------------------
// Helper registration (used by the orchestrator)
// ---------------------------------------------------------------------------

/**
 * Stub for Phase 3. The orchestrator will accept registered helpers and
 * resolve their dependency DAG at startup.
 */
export interface HelperRegistry {
  register<T>(helper: ContextHelper<T>): void;
  get(name: HelperName): ContextHelper<unknown> | undefined;
  list(): readonly HelperDescription[];
  /** Topological sort of helpers respecting `dependencies`. */
  resolveDag(requested: readonly HelperName[]): readonly HelperName[];
}
