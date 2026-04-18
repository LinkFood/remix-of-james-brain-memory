/**
 * ct-session-analog — "find past sessions most similar to today's tape"
 *
 * Two modes (body-driven):
 *
 *   { mode: 'build',  session_date?, through? }
 *       Build today's (or a specified date's) session snapshot and persist
 *       it to ct_session_embeddings. Idempotent upsert.
 *
 *   { mode: 'search', session_date?, through?, limit?, threshold? }
 *       Build today's snapshot (NOT persisted), embed it as a query, and
 *       semantic-search past persisted sessions via the search_ct_session_analogs
 *       RPC. Returns top-N matches + their EOD outcomes + an aggregate.
 *
 * Default mode is 'build' (so the nightly cron can fire with `{}`).
 * Default through is the current UTC timestamp.
 *
 * Cross-facet bridge: when we have fewer than 20 past Co-Trader embeddings,
 * we additionally query DCD's hunt_knowledge via the wave-21 helper for
 * brain-narrative entries tagged 'market' — thin-sample augmentation only.
 * See the Report in the final response for details.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import {
  buildSessionSnapshot,
  embedSessionSnapshot,
  type SessionSnapshot,
} from '../_shared/sessionEmbedding.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';
import { queryDcdBrain, type CrossFacetHit } from '../_shared/crossFacetMemory.ts';

// ---------- Defaults ----------
const DEFAULT_LIMIT = 5;
const DEFAULT_THRESHOLD = 0.35;
const THIN_SAMPLE_THRESHOLD = 20;   // below this, augment with DCD cross-facet
const CORPUS_COUNT_SOFT_MIN = 3;    // below this, UI shows "warming up"

// ---------- Input parsing ----------
interface RequestBody {
  mode?: 'build' | 'search';
  session_date?: string;        // 'YYYY-MM-DD'
  through?: string;             // 'HH:MM' (UTC) or full ISO; default = now
  limit?: number;               // search mode
  threshold?: number;           // search mode
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function resolveThrough(sessionDate: string, through?: string): string {
  if (!through || through.trim() === '') return new Date().toISOString();
  // "HH:MM" shorthand
  if (/^\d{2}:\d{2}$/.test(through)) return `${sessionDate}T${through}:00Z`;
  // already ISO — let Date parse decide
  const d = new Date(through);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// ---------- Match shape returned to the client ----------
interface AnalogMatch {
  session_date: string;
  through_utc: string;
  similarity: number;
  state_features: Record<string, unknown>;
  state_summary_excerpt: string;
  eod_return_pct: number | null;
  eod_summary: string | null;
  lessons_applicable: string[];   // filled in via a lightweight ct_lessons query per match
}

// Match shape for search_ct_session_analogs RPC rows
interface RpcAnalogRow {
  id: string;
  session_date: string;
  through_utc: string;
  state_summary: string;
  state_features: Record<string, unknown> | null;
  eod_return_pct: number | null;
  eod_summary: string | null;
  similarity: number;
}

// ---------- Lessons lookup: fetch up to 3 active ct_lessons whose instruments
// overlap "SPY" or are universal (null instruments). This is intentionally
// cheap — no semantic match on the snapshot; just "which of Claude's recent
// market-wide lessons might apply". ----------
async function applicableLessons(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from('ct_lessons')
    .select('lesson, instruments, active')
    .eq('active', true)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) {
    console.warn('[ct-session-analog] lessons fetch failed:', error.message);
    return [];
  }
  const rows = (data ?? []) as Array<{ lesson: string; instruments: string[] | null }>;
  const hits = rows.filter(r => {
    if (!r.instruments || r.instruments.length === 0) return true; // universal
    return r.instruments.some(i => ['SPY', 'SPX', 'QQQ', 'IWM'].includes(i));
  });
  return hits.slice(0, 3).map(r => r.lesson);
}

// ---------- Corpus count — gate for thin-sample branch ----------
async function countCorpus(supabase: SupabaseClient): Promise<number> {
  const { count, error } = await supabase
    .from('ct_session_embeddings')
    .select('id', { count: 'estimated', head: true });
  if (error) {
    console.warn('[ct-session-analog] corpus count failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

// ---------- Build ----------
async function handleBuild(
  supabase: SupabaseClient,
  sessionDate: string,
  through: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const startedAt = Date.now();
  const res = await embedSessionSnapshot(supabase, sessionDate, through);
  return new Response(
    JSON.stringify({
      success: res.ok,
      mode: 'build',
      session_date: sessionDate,
      through_utc: through,
      query_summary: res.snapshot?.state_summary ?? null,
      state_features: res.snapshot?.state_features ?? null,
      error: res.error ?? null,
      duration_ms: Date.now() - startedAt,
    }),
    { status: res.ok ? 200 : 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// ---------- Search ----------
async function handleSearch(
  supabase: SupabaseClient,
  sessionDate: string,
  through: string,
  limit: number,
  threshold: number,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  const startedAt = Date.now();

  // 1) Build today's snapshot (not persisted). This is the query.
  let snapshot: SessionSnapshot;
  try {
    snapshot = await buildSessionSnapshot(supabase, sessionDate, through);
  } catch (e) {
    return new Response(
      JSON.stringify({
        success: false,
        mode: 'search',
        error: e instanceof Error ? e.message : String(e),
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // 2) Corpus gate — if we have too few rows, return the warming-up signal
  //    plus (thin-sample) cross-facet augmentation.
  const corpusCount = await countCorpus(supabase);
  const warmingUp = corpusCount < CORPUS_COUNT_SOFT_MIN;
  const thinSample = corpusCount < THIN_SAMPLE_THRESHOLD;

  // 3) Embed the snapshot as a `query`-type embedding (Voyage distinguishes
  //    storage vs retrieval — match DCD and ct_embeddings conventions).
  let queryEmb: number[];
  try {
    queryEmb = await voyageEmbed(snapshot.state_summary, 'query');
  } catch (e) {
    return new Response(
      JSON.stringify({
        success: false,
        mode: 'search',
        error: `voyage_embed_failed: ${e instanceof Error ? e.message : String(e)}`,
        query_summary: snapshot.state_summary,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  // 4) RPC against persisted past sessions (excluding the current session_date).
  const matches: AnalogMatch[] = [];
  if (corpusCount > 0) {
    const { data, error } = await supabase.rpc('search_ct_session_analogs', {
      query_embedding: queryEmb as unknown as string,
      match_threshold: threshold,
      match_count: limit,
      exclude_date: sessionDate,
    });
    if (error) {
      console.warn('[ct-session-analog] RPC failed:', error.message);
    } else {
      const lessons = await applicableLessons(supabase);
      const rows = (data ?? []) as RpcAnalogRow[];
      for (const r of rows) {
        matches.push({
          session_date: r.session_date,
          through_utc: r.through_utc,
          similarity: Number((r.similarity ?? 0).toFixed(4)),
          state_features: r.state_features ?? {},
          state_summary_excerpt: String(r.state_summary ?? '').slice(0, 240),
          eod_return_pct: r.eod_return_pct,
          eod_summary: r.eod_summary,
          lessons_applicable: lessons,
        });
      }
    }
  }

  // 5) Aggregate outcome of top-N matches — the directional forecast line.
  const withReturns = matches.filter(m => m.eod_return_pct !== null);
  const aggregate_eod_return_pct: number | null =
    withReturns.length > 0
      ? withReturns.reduce((s, m) => s + (m.eod_return_pct ?? 0), 0) / withReturns.length
      : null;
  const bullish_count = withReturns.filter(m => (m.eod_return_pct ?? 0) > 0.1).length;
  const bearish_count = withReturns.filter(m => (m.eod_return_pct ?? 0) < -0.1).length;

  // 6) Cross-facet bridge (stretch) — thin-sample augmentation only.
  //    Only query DCD when our own corpus is thin; language-space narratives
  //    from DCD's brain-narrative / compound-risk layer can provide structural
  //    analogs across the "environmental systems" domain. The crossFacetMemory
  //    helper already scrubs duck/bird/weather-specific language.
  let cross_facet: {
    queried: boolean;
    reason: string | null;
    hits: CrossFacetHit[];
  } = { queried: false, reason: 'not_thin_sample', hits: [] };
  if (thinSample) {
    const dcd = await queryDcdBrain(supabase, snapshot.state_summary, {
      limit: 3,
      threshold: 0.30,
      // Only the BRIDGE/narrative types (default), not raw EXTERNAL data
    });
    cross_facet = {
      queried: true,
      reason: dcd.reason,
      hits: dcd.hits,
    };
  }

  return new Response(
    JSON.stringify({
      success: true,
      mode: 'search',
      session_date: sessionDate,
      through_utc: through,
      corpus_count: corpusCount,
      warming_up: warmingUp,
      thin_sample: thinSample,
      query_summary: snapshot.state_summary,
      state_features: snapshot.state_features,
      matches,
      aggregate: {
        count: withReturns.length,
        avg_eod_return_pct: aggregate_eod_return_pct !== null
          ? Number(aggregate_eod_return_pct.toFixed(3))
          : null,
        bullish_count,
        bearish_count,
      },
      cross_facet,
      duration_ms: Date.now() - startedAt,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// ---------- Entry ----------
serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  let body: RequestBody = {};
  try {
    const raw = await req.text();
    if (raw) body = JSON.parse(raw) as RequestBody;
  } catch (_e) {
    // tolerate empty / malformed body — cron fires with `{}`
    body = {};
  }

  const mode: 'build' | 'search' = body.mode === 'search' ? 'search' : 'build';

  // Auth model:
  //  - 'build'  → write path, cron-only. REQUIRE service role. Matches the
  //               plan's "service-role auth" intent and prevents any frontend
  //               user from inflating the corpus.
  //  - 'search' → read-only path, safe to expose to authenticated UI. The
  //               RPC is SECURITY DEFINER and only returns ct_session_embeddings
  //               rows which already have an authenticated-read RLS policy.
  //
  // We always create the service-role client — search needs it to call the
  // DCD cross-facet helper (which must bypass RLS on hunt_knowledge).
  if (mode === 'build' && !isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized (build mode requires service role)' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const sessionDate = body.session_date && /^\d{4}-\d{2}-\d{2}$/.test(body.session_date)
    ? body.session_date
    : todayUtc();
  const through = resolveThrough(sessionDate, body.through);

  if (mode === 'build') {
    return handleBuild(supabase, sessionDate, through, corsHeaders);
  }

  const limit = Math.min(Math.max(1, body.limit ?? DEFAULT_LIMIT), 10);
  const threshold = typeof body.threshold === 'number'
    ? Math.min(Math.max(0, body.threshold), 1)
    : DEFAULT_THRESHOLD;

  return handleSearch(supabase, sessionDate, through, limit, threshold, corsHeaders);
});
