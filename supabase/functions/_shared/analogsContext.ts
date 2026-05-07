/**
 * analogsContext — historical session analogs as a brain organ.
 *
 * Phase 6 of the synthesis layer. Pattern-matches against the embedded
 * Co-Trader session corpus via `search_ct_session_analogs` (vector RPC over
 * ct_session_embeddings, populated by the ct-session-analog `build` mode).
 *
 * For each invocation:
 *   1. Find today's persisted session_embedding (if `ct-session-analog` has
 *      fired in `build` mode for today's session_date).
 *   2. Use that embedding as the query against `search_ct_session_analogs`
 *      to retrieve top-N similar past sessions WITH their EOD outcomes.
 *   3. Return the top-N as `RecencyAnalog[]`.
 *
 * Defensive fall-through (NEVER throws):
 *   - No embedding for today yet → return empty `analogs[]` + warning
 *     'no_current_embedding' so consumers know to pre-fire the build mode.
 *   - RPC error / table missing → empty + warning 'rpc_error:<msg>'.
 *   - 0 matches above similarity threshold → empty + warning 'no_matches'.
 *
 * Per architecture D4 (read/write separation), this helper does NOT write
 * to ct_session_embeddings or call Voyage AI directly. Building today's
 * embedding is the responsibility of the ct-session-analog edge function
 * (write path). This helper only reads.
 *
 * Per architecture D6 (caching), opts-in cacheTtlSeconds=300. Same session
 * + same threshold + same count = same answer for 5 minutes.
 *
 * @see supabase/migrations/20260420000016_session_analogs.sql for the RPC
 * @see supabase/functions/ct-session-analog/index.ts for the build path
 * @see docs/SYNTHESIS_LAYER_ARCHITECTURE.md Phase 6 for the recall vision
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  ContextHelper,
  HelperFetchContext,
  HelperOpts,
  HelperResult,
  HelperDescription,
  OrganMetadata,
  OrganStatus,
} from './contextHelper.ts';

const HELPER_NAME = 'analogs';
const HELPER_VERSION = 'v1';

// Defaults — tuned conservatively. Phase 8 will surface in ct_config.
const DEFAULT_CAP = 3;
const MAX_CAP = 10;
const DEFAULT_THRESHOLD = 0.55; // cosine similarity floor

// ---------------------------------------------------------------------------
// Types — exported for consumers
// ---------------------------------------------------------------------------

export interface SessionAnalog {
  id: string;
  session_date: string;            // YYYY-MM-DD (the analog session, not today)
  through_utc: string;             // ISO timestamp of the analog snapshot
  state_summary: string;           // human-readable state at that time
  state_features: Record<string, unknown> | null;
  eod_return_pct: number | null;   // outcome — what the underlying did
  eod_summary: string | null;
  similarity: number;              // cosine similarity 0-1, higher = more alike
}

export interface AnalogsResult {
  /** Top-N similar past sessions, ordered by similarity DESC. */
  analogs: SessionAnalog[];
  /**
   * Aggregate outcome across the analogs — quick read for narrative
   * consumers ("the 3 most-similar sessions averaged +0.42% EOD").
   * Null when analogs is empty.
   */
  aggregate: {
    count: number;
    avg_eod_return_pct: number | null;
    bullish_count: number;          // analogs where eod_return_pct > 0
    bearish_count: number;
    flat_count: number;
  } | null;
  /** ISO timestamp the helper was invoked. */
  generated_at: string;
  /** Did we have a current embedding to query against? */
  has_current_embedding: boolean;
}

// ---------------------------------------------------------------------------
// Internal — fetch today's persisted embedding (if any)
// ---------------------------------------------------------------------------

interface EmbeddingRow {
  id: string;
  session_date: string;
  embedding: unknown;            // pgvector serializes as string by default
  through_utc: string;
}

async function fetchCurrentEmbedding(
  supabase: SupabaseClient,
  sessionDate: string,
): Promise<EmbeddingRow | null> {
  // Most recent build for today, if any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase.from('ct_session_embeddings' as never) as any)
    .select('id, session_date, embedding, through_utc')
    .eq('session_date', sessionDate)
    .order('through_utc', { ascending: false })
    .limit(1);
  if (error) return null;
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0] as EmbeddingRow;
}

// ---------------------------------------------------------------------------
// Empty-result helper (defensive)
// ---------------------------------------------------------------------------

function buildOrganMetadata(asOf: string, status: OrganStatus): OrganMetadata {
  return {
    as_of: asOf,
    source: '_shared/analogsContext.ts / search_ct_session_analogs(ct_session_embeddings)',
    window: 'today\'s session embedding vs full corpus, top-N by cosine similarity',
    status,
  };
}

function emptyResult(
  startedAt: number,
  warning?: string,
  hasCurrentEmbedding = false,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<AnalogsResult> {
  const asOf = new Date().toISOString();
  return {
    data: {
      analogs: [],
      aggregate: null,
      generated_at: asOf,
      has_current_embedding: hasCurrentEmbedding,
    },
    meta: {
      helperName: HELPER_NAME,
      helperVersion: HELPER_VERSION,
      fetchedAt: asOf,
      rowCount: 0,
      cacheHit: false,
      latencyMs: Date.now() - startedAt,
      truncated: false,
      ...(warning ? { warning } : {}),
    },
    organMetadata: buildOrganMetadata(asOf, status),
  };
}

// ---------------------------------------------------------------------------
// Convenience function
// ---------------------------------------------------------------------------

export async function getAnalogsContext(
  supabase: SupabaseClient,
  sessionDate: string,
  opts: HelperOpts = {},
): Promise<HelperResult<AnalogsResult>> {
  const startedAt = Date.now();
  const requestedCap = typeof opts.cap === 'number' ? opts.cap : DEFAULT_CAP;
  const cap = Math.max(1, Math.min(MAX_CAP, requestedCap));
  const threshold = typeof opts.threshold === 'number'
    ? Math.max(0, Math.min(1, opts.threshold))
    : DEFAULT_THRESHOLD;

  try {
    // 1. Find today's persisted embedding.
    const current = await fetchCurrentEmbedding(supabase, sessionDate);
    if (!current) {
      // Producer cron ct-session-analog hasn't fired for today — pending,
      // not absent. Maps to OrganStatus.pending_analysis.
      return emptyResult(startedAt, 'no_current_embedding', false, 'pending_analysis');
    }

    // 2. Vector search against past sessions, excluding today.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc('search_ct_session_analogs', {
      query_embedding: current.embedding,
      match_threshold: threshold,
      match_count: cap,
      exclude_date: sessionDate,
    });
    if (error) {
      return emptyResult(startedAt, `rpc_error:${error.message}`, true, 'error');
    }
    if (!Array.isArray(data) || data.length === 0) {
      return emptyResult(startedAt, 'no_matches', true, 'no_signal_detected');
    }

    // 3. Shape + aggregate.
    const analogs: SessionAnalog[] = (data as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      session_date: String(r.session_date),
      through_utc: String(r.through_utc),
      state_summary: String(r.state_summary ?? ''),
      state_features: (r.state_features as Record<string, unknown> | null) ?? null,
      eod_return_pct: r.eod_return_pct == null ? null : Number(r.eod_return_pct),
      eod_summary: r.eod_summary == null ? null : String(r.eod_summary),
      similarity: r.similarity == null ? 0 : Number(r.similarity),
    }));

    const withReturns = analogs.filter((a) => a.eod_return_pct != null);
    const aggregate = analogs.length > 0
      ? {
          count: analogs.length,
          avg_eod_return_pct: withReturns.length > 0
            ? withReturns.reduce((s, a) => s + (a.eod_return_pct ?? 0), 0) / withReturns.length
            : null,
          bullish_count: analogs.filter((a) => (a.eod_return_pct ?? 0) > 0).length,
          bearish_count: analogs.filter((a) => (a.eod_return_pct ?? 0) < 0).length,
          flat_count: analogs.filter((a) => a.eod_return_pct === 0).length,
        }
      : null;

    const asOf = new Date().toISOString();
    return {
      data: {
        analogs,
        aggregate,
        generated_at: asOf,
        has_current_embedding: true,
      },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: asOf,
        rowCount: analogs.length,
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        truncated: requestedCap > MAX_CAP,
      },
      organMetadata: buildOrganMetadata(asOf, 'populated'),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return emptyResult(startedAt, `fetch_error:${msg}`, false, 'error');
  }
}

// ---------------------------------------------------------------------------
// ContextHelper instance — default export
// ---------------------------------------------------------------------------

const analogsHelper: ContextHelper<AnalogsResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: DEFAULT_CAP,
  isExpensive: false,           // pure DB read, no UW, no Voyage at runtime
  minRefreshSeconds: 300,       // analogs change slowly during a session
  dependencies: [],             // depends on ct-session-analog WRITE path
                                // — but that's an out-of-band cron, not a
                                // helper dependency.
  audienceFilter: undefined,    // all audiences benefit from pattern recall
  cacheTtlSeconds: 300,         // 5-min cache — same session = same answer

  async fetch(
    ctx: HelperFetchContext,
    opts: HelperOpts,
  ): Promise<HelperResult<AnalogsResult>> {
    return getAnalogsContext(ctx.supabase, ctx.sessionDate, opts);
  },

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: DEFAULT_CAP,
      expensive: false,
      minRefreshSeconds: 300,
      dependencies: [],
      audienceFilter: undefined,
      outputShape:
        'Top-N most-similar past Co-Trader sessions to today (by embedded ' +
        'state_summary cosine similarity), with their EOD outcome returns and ' +
        'a quick aggregate (avg return, bullish/bearish/flat counts). Empty ' +
        'with `warning: "no_current_embedding"` when ct-session-analog has ' +
        'not yet fired in `build` mode for today.',
      exampleResult: {
        analogs: [{
          id: 'uuid',
          session_date: '2026-03-15',
          through_utc: '2026-03-15T20:00:00Z',
          state_summary: 'SPX +0.7%, VIX 14.5, Mag7 dispersion...',
          state_features: { vix: 14.5, spx_pct: 0.7 },
          eod_return_pct: 0.42,
          eod_summary: 'Quiet drift higher into close',
          similarity: 0.78,
        }],
        aggregate: { count: 3, avg_eod_return_pct: 0.31, bullish_count: 2, bearish_count: 1, flat_count: 0 },
        generated_at: '2026-04-30T23:00:00Z',
        has_current_embedding: true,
      },
    };
  },
};

export default analogsHelper;
