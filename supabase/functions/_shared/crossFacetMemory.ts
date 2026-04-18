/**
 * crossFacetMemory — OS-native cross-facet brain access.
 *
 * This is the first true cross-facet wire: Co-Trader reaching into Duck
 * Countdown's 7M-entry vector brain (`hunt_knowledge`) when the trading
 * question reaches outside Co-Trader's own young corpus.
 *
 * Both facets share the SAME Supabase project (rvhyotvklfowklzjahdd) and
 * the SAME 512-dim embedding space (Voyage voyage-3-lite), so we can embed
 * a query with Co-Trader's existing Voyage pipeline and call DCD's vector
 * RPC directly. No bridge service, no cross-project auth — RLS bypass via
 * the service role client the caller already has.
 *
 * Guardrails:
 *   - Dimension:     DCD `hunt_knowledge.embedding` is vector(512) → matches
 *                    Co-Trader's voyage-3-lite exactly. Verified at build.
 *   - Type filter:   Only DCD's BRIDGE narrative types are returned. Raw
 *                    weather / bird / water data is EXPLICITLY excluded so
 *                    duck migration counts don't leak into a trading prompt.
 *   - Graceful:      If `hunt_knowledge` doesn't exist (non-shared deploys),
 *                    the helper returns `[]` and records `reason: 'no_dcd'`.
 *                    Never throws.
 *   - Budget:        Returns top 5 hits max. Embedding cost is one Voyage
 *                    query call (~$0.00002). RPC cost is one index lookup.
 *
 * Future wave (not this PR): cross-facet for watcher regime analogs. Keeping
 * the shape identical so the watcher can call it as-is when we're ready.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { voyageEmbed } from './ctEmbed.ts';

/**
 * DCD content types that are "narrative / synthesis" — the BRIDGE layer.
 * These are language-space translations of the underlying data (compound
 * risk narratives, cross-domain correlations, narrator output). They are
 * the ONLY DCD types Co-Trader should see.
 *
 * Intentionally excluded:
 *   - EXTERNAL types (weather, birds, water, tide, etc.) — raw domain data,
 *     absurd to inject into a trading context.
 *   - INTERNAL types (grades, scores, calibration) — DCD's own bookkeeping,
 *     not useful cross-facet.
 *   - Anything with 'du_' / 'bird' / 'migration' / 'duck' prefixes explicitly
 *     filtered below (defense-in-depth even if new types leak into BRIDGE).
 */
const DCD_BRIDGE_TYPES = [
  'bio-environmental-correlation',
  'correlation-discovery',
  'brain-narrative',
  'compound-risk-alert',
] as const;

/**
 * Defense-in-depth: even if one of the BRIDGE types surfaces a duck-flavored
 * narrative, this regex scrub drops the result. Trading chat should never
 * see wings / mallard / migration / flyway / eBird language.
 */
const DOMAIN_LEAK_RX = /\b(duck|mallard|teal|wigeon|goose|geese|waterfowl|hunting|hunter|migrat(?:ion|ory)|flyway|ebird|birdcast|wildfowl|turkey|deer)\b/i;

export interface CrossFacetHit {
  /** Short narrative snippet (first ~400 chars of content). */
  snippet: string;
  /** Full title of the DCD entry (e.g. "VA compound-risk 2025-09-19"). */
  title: string;
  /** DCD content_type (always one of DCD_BRIDGE_TYPES). */
  type: string;
  /** Cosine similarity 0..1 from DCD's vector RPC. */
  score: number;
  /** When the DCD event was effective (may be null). */
  effective_date: string | null;
  /** Any metadata DCD attached (state, tags, etc). Always defined. */
  metadata: Record<string, unknown>;
}

export interface QueryDcdResult {
  hits: CrossFacetHit[];
  /** Whether DCD was reachable on this Supabase instance. */
  reachable: boolean;
  /** Human-readable reason when we return early (no_dcd, embed_fail, rpc_fail). */
  reason: string | null;
  /** Wall-clock ms for the query — useful for cost/latency logging. */
  duration_ms: number;
}

/** Cached DCD reachability check — checked once per isolate. */
let _dcdReachable: boolean | null = null;

async function checkDcdReachable(supabase: SupabaseClient): Promise<boolean> {
  if (_dcdReachable !== null) return _dcdReachable;
  try {
    // Lightweight HEAD via estimated count — never touches rows. If DCD
    // isn't on this Supabase instance, this errors with a table-not-found
    // Postgrest code and we flip the flag.
    const { error } = await supabase
      .from('hunt_knowledge')
      .select('id', { count: 'estimated', head: true })
      .limit(1);
    _dcdReachable = !error;
    if (error) {
      console.warn('[crossFacetMemory] DCD not reachable:', error.message);
    }
    return _dcdReachable;
  } catch (e) {
    console.warn('[crossFacetMemory] reachability check failed:', e);
    _dcdReachable = false;
    return false;
  }
}

export interface QueryDcdOpts {
  /** Max hits to return. Default 5, capped at 10. */
  limit?: number;
  /** Minimum cosine similarity. Default 0.35. */
  threshold?: number;
  /** Optional content-type subset; defaults to ALL DCD_BRIDGE_TYPES. */
  types?: readonly string[];
}

/**
 * Query the DCD brain by semantic similarity.
 *
 * @param supabase  Service-role client (RLS bypass needed for cross-facet).
 * @param query     Natural-language question from the user or Claude.
 * @param opts      Optional limit / threshold / type override.
 * @returns         Top hits + reachability info. Never throws.
 */
export async function queryDcdBrain(
  supabase: SupabaseClient,
  query: string,
  opts: QueryDcdOpts = {},
): Promise<QueryDcdResult> {
  const startedAt = Date.now();
  const limit = Math.min(Math.max(1, opts.limit ?? 5), 10);
  const threshold = opts.threshold ?? 0.35;
  const types = opts.types ?? DCD_BRIDGE_TYPES;

  // Step 1: is DCD even on this Supabase instance? One-shot check.
  const reachable = await checkDcdReachable(supabase);
  if (!reachable) {
    return { hits: [], reachable: false, reason: 'no_dcd', duration_ms: Date.now() - startedAt };
  }

  // Step 2: embed the query via Voyage. Uses the same 512-dim model that
  // wrote the rows we're searching against.
  let queryEmb: number[];
  try {
    queryEmb = await voyageEmbed(query, 'query');
  } catch (e) {
    console.warn('[crossFacetMemory] voyageEmbed failed:', e instanceof Error ? e.message : e);
    return { hits: [], reachable: true, reason: 'embed_fail', duration_ms: Date.now() - startedAt };
  }

  // Step 3: call DCD's vector RPC. `search_hunt_knowledge_v2` supports
  // filter_content_types natively — no second pass needed for the happy path.
  const { data, error } = await supabase.rpc('search_hunt_knowledge_v2', {
    query_embedding: queryEmb as unknown as string,
    match_threshold: threshold,
    match_count: limit * 2, // fetch extra for scrub pass, truncate after
    filter_content_types: types as unknown as string[],
  });

  if (error) {
    console.warn('[crossFacetMemory] search_hunt_knowledge_v2 failed:', error.message);
    return { hits: [], reachable: true, reason: 'rpc_fail', duration_ms: Date.now() - startedAt };
  }

  // Step 4: scrub domain-leak terms and shape output.
  const rows = (data ?? []) as Array<{
    id: string;
    title: string;
    content: string;
    content_type: string;
    state_abbr: string | null;
    effective_date: string | null;
    metadata: Record<string, unknown> | null;
    similarity: number;
    tags: string[] | null;
  }>;

  const hits: CrossFacetHit[] = [];
  for (const row of rows) {
    if (hits.length >= limit) break;
    const text = `${row.title}\n${row.content}`;
    if (DOMAIN_LEAK_RX.test(text)) continue;
    hits.push({
      snippet: row.content.slice(0, 400),
      title: row.title,
      type: row.content_type,
      score: Number((row.similarity ?? 0).toFixed(4)),
      effective_date: row.effective_date,
      metadata: {
        ...(row.metadata ?? {}),
        state_abbr: row.state_abbr,
        tags: row.tags ?? [],
      },
    });
  }

  return {
    hits,
    reachable: true,
    reason: null,
    duration_ms: Date.now() - startedAt,
  };
}

/**
 * Heuristic — does this chat message read like it's asking for historical
 * depth that Co-Trader's own corpus can't answer? We only want to pay the
 * cross-facet query when it's plausibly useful.
 *
 * Positive signals: "historical", "precedent", "years ago", "in 20XX",
 * "pattern across time", "ever seen", "generally", "past decade", etc.
 *
 * This is a KEYWORD heuristic by design — cheap, no extra LLM call. Claude
 * will still ignore irrelevant hits; we're just gating the cost.
 */
const CROSS_FACET_TRIGGERS: RegExp[] = [
  /\bhistorical(?:ly)?\b/i,
  /\bprecedent\b/i,
  /\bever\s+(?:happened|seen)\b/i,
  /\bnever\s+seen\b/i,
  /\bin\s+20\d{2}\b/i,
  /\bback\s+in\s+(?:20\d{2}|the\s+\d{2}s)\b/i,
  /\b(?:\d+\s+)?years?\s+ago\b/i,
  /\bacross\s+time\b/i,
  /\bover\s+(?:the\s+)?years\b/i,
  /\bpast\s+decade\b/i,
  /\blast\s+decade\b/i,
  /\bgenerally\s+(?:speaking)?\b/i,
  /\bregime\s+analog\b/i,
  /\bsimilar\s+setup\s+in\s+history\b/i,
  /\blong[-\s]term\s+pattern\b/i,
  /\bpattern\s+across\s+time\b/i,
];

export function shouldQueryDcdBrain(message: string): boolean {
  return CROSS_FACET_TRIGGERS.some((rx) => rx.test(message));
}
