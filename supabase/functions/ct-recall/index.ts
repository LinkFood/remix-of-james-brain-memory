/**
 * ct-recall — historical recall endpoint for the co-trader.
 *
 * Accepts user JWT or service-role auth. Two modes (combinable):
 *   - time lookup:   `at` (ISO8601) + optional `window_hours` (default 1)
 *   - semantic:      `query` string → voyageEmbed → nearest ct_embeddings
 *
 * Optional filters:
 *   - `instrument`: scope to a single ticker (e.g. "NVDA")
 *   - `kind`:       'observation' | 'flag' | 'alert' | 'report' | 'news' | 'any'
 *                    default 'any'
 *
 * Returns up to 20 hits, grade-joined where applicable.
 *
 * Input:
 *   {
 *     query?:        string,
 *     instrument?:   string,
 *     at?:           ISO8601,
 *     window_hours?: number (default 1),
 *     kind?:         'observation'|'flag'|'alert'|'report'|'news'|'any'
 *   }
 *
 * Output:
 *   {
 *     hits: Array<{
 *       type, id, timestamp, instruments, direction, conviction,
 *       glance, grade?, distance?
 *     }>,
 *     duration_ms: number,
 *     mode: 'time' | 'semantic' | 'hybrid'
 *   }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { extractUserId, isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';

type Kind = 'observation' | 'flag' | 'alert' | 'report' | 'news' | 'any';

interface RecallInput {
  query?: string;
  instrument?: string;
  at?: string;
  window_hours?: number;
  kind?: Kind;
}

interface RecallHit {
  type: string;
  id: string;
  timestamp: string | null;
  instruments: string[];
  direction: string | null;
  conviction: number | null;
  glance: string[] | null;
  grade?: { verdict: string; actual_return_pct: number | null } | null;
  distance?: number;
}

const MAX_HITS = 20;
const KIND_TO_TABLE: Record<Exclude<Kind, 'any'>, string> = {
  observation: 'ct_observations',
  flag:        'ct_flags',
  alert:       'ct_alerts',
  report:      'ct_reports',
  news:        'ct_news_analyses',
};

function normalizeKinds(kind: Kind | undefined): Array<Exclude<Kind, 'any'>> {
  if (!kind || kind === 'any') {
    return ['observation', 'flag', 'alert', 'report', 'news'];
  }
  return [kind];
}

/**
 * Time-windowed fetch from a single source table.
 * Returns normalized RecallHits.
 */
async function fetchByTime(
  supabase: ReturnType<typeof createClient>,
  kind: Exclude<Kind, 'any'>,
  instrument: string | undefined,
  atStart: string,
  atEnd: string,
  limit: number,
): Promise<RecallHit[]> {
  const table = KIND_TO_TABLE[kind];

  if (kind === 'observation') {
    let q = supabase.from(table)
      .select('id, instruments, direction, glance, created_at')
      .gte('created_at', atStart).lte('created_at', atEnd)
      .order('created_at', { ascending: false }).limit(limit);
    if (instrument) q = q.contains('instruments', [instrument]);
    const { data } = await q;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      type: 'observation',
      id: r.id as string,
      timestamp: (r.created_at as string) ?? null,
      instruments: (r.instruments as string[]) ?? [],
      direction: (r.direction as string) ?? null,
      conviction: null,
      glance: (r.glance as string[]) ?? null,
    }));
  }

  if (kind === 'flag' || kind === 'alert') {
    let q = supabase.from(table)
      .select('id, instruments, direction, conviction, horizon, glance, grade_id, created_at')
      .gte('created_at', atStart).lte('created_at', atEnd)
      .order('created_at', { ascending: false }).limit(limit);
    if (instrument) q = q.contains('instruments', [instrument]);
    const { data } = await q;
    return (data ?? []).map((r: Record<string, unknown>) => ({
      type: kind,
      id: r.id as string,
      timestamp: (r.created_at as string) ?? null,
      instruments: (r.instruments as string[]) ?? [],
      direction: (r.direction as string) ?? null,
      conviction: (r.conviction as number) ?? null,
      glance: (r.glance as string[]) ?? null,
      _grade_id: (r.grade_id as string) ?? null,
    } as RecallHit & { _grade_id: string | null }));
  }

  if (kind === 'report') {
    // ct_reports is not instrument-scoped; ignore instrument filter.
    const { data } = await supabase.from(table)
      .select('id, report_type, summary, period_start, period_end, created_at')
      .gte('created_at', atStart).lte('created_at', atEnd)
      .order('created_at', { ascending: false }).limit(limit);
    return (data ?? []).map((r: Record<string, unknown>) => ({
      type: 'report',
      id: r.id as string,
      timestamp: (r.created_at as string) ?? null,
      instruments: [],
      direction: null,
      conviction: null,
      glance: [(r.report_type as string) ?? 'report', String(r.summary ?? '').slice(0, 200)],
    }));
  }

  // news
  let q = supabase.from(table)
    .select('id, instrument, news_headline, impact, significance, claude_take, created_at')
    .gte('created_at', atStart).lte('created_at', atEnd)
    .order('created_at', { ascending: false }).limit(limit);
  if (instrument) q = q.eq('instrument', instrument);
  const { data } = await q;
  return (data ?? []).map((r: Record<string, unknown>) => ({
    type: 'news',
    id: r.id as string,
    timestamp: (r.created_at as string) ?? null,
    instruments: r.instrument ? [r.instrument as string] : [],
    direction: (r.impact as string) ?? null,
    conviction: (r.significance as number) ?? null,
    glance: [String(r.news_headline ?? ''), String(r.claude_take ?? '').slice(0, 200)],
  }));
}

/**
 * Fetch source row details for a batch of (item_type, item_id) from ct_embeddings.
 * Returns a map keyed by "{type}:{id}" → RecallHit (pre-grade).
 */
async function fetchSourceRows(
  supabase: ReturnType<typeof createClient>,
  refs: Array<{ type: string; id: string; distance: number }>,
): Promise<Map<string, RecallHit & { _grade_id?: string | null }>> {
  const out = new Map<string, RecallHit & { _grade_id?: string | null }>();

  const byType: Record<string, string[]> = {};
  for (const r of refs) {
    (byType[r.type] ??= []).push(r.id);
  }

  const distanceById = new Map(refs.map(r => [`${r.type}:${r.id}`, r.distance]));

  await Promise.all(Object.entries(byType).map(async ([type, ids]) => {
    if (ids.length === 0) return;

    if (type === 'observation') {
      const { data } = await supabase.from('ct_observations')
        .select('id, instruments, direction, glance, created_at')
        .in('id', ids);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const key = `observation:${r.id}`;
        out.set(key, {
          type: 'observation',
          id: r.id as string,
          timestamp: (r.created_at as string) ?? null,
          instruments: (r.instruments as string[]) ?? [],
          direction: (r.direction as string) ?? null,
          conviction: null,
          glance: (r.glance as string[]) ?? null,
          distance: distanceById.get(key),
        });
      }
      return;
    }

    if (type === 'flag' || type === 'alert') {
      const table = type === 'flag' ? 'ct_flags' : 'ct_alerts';
      const { data } = await supabase.from(table)
        .select('id, instruments, direction, conviction, horizon, glance, grade_id, created_at')
        .in('id', ids);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const key = `${type}:${r.id}`;
        out.set(key, {
          type,
          id: r.id as string,
          timestamp: (r.created_at as string) ?? null,
          instruments: (r.instruments as string[]) ?? [],
          direction: (r.direction as string) ?? null,
          conviction: (r.conviction as number) ?? null,
          glance: (r.glance as string[]) ?? null,
          distance: distanceById.get(key),
          _grade_id: (r.grade_id as string) ?? null,
        });
      }
      return;
    }

    if (type === 'james_view') {
      const { data } = await supabase.from('ct_james_views')
        .select('id, instrument, direction, conviction, horizon, rationale, grade_id, created_at')
        .in('id', ids);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const key = `james_view:${r.id}`;
        out.set(key, {
          type: 'james_view',
          id: r.id as string,
          timestamp: (r.created_at as string) ?? null,
          instruments: r.instrument ? [r.instrument as string] : [],
          direction: (r.direction as string) ?? null,
          conviction: (r.conviction as number) ?? null,
          glance: r.rationale ? [String(r.rationale)] : null,
          distance: distanceById.get(key),
          _grade_id: (r.grade_id as string) ?? null,
        });
      }
      return;
    }

    if (type === 'report') {
      const { data } = await supabase.from('ct_reports')
        .select('id, report_type, summary, created_at')
        .in('id', ids);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const key = `report:${r.id}`;
        out.set(key, {
          type: 'report',
          id: r.id as string,
          timestamp: (r.created_at as string) ?? null,
          instruments: [],
          direction: null,
          conviction: null,
          glance: [(r.report_type as string) ?? 'report', String(r.summary ?? '').slice(0, 200)],
          distance: distanceById.get(key),
        });
      }
      return;
    }

    if (type === 'news') {
      const { data } = await supabase.from('ct_news_analyses')
        .select('id, instrument, news_headline, impact, significance, claude_take, created_at')
        .in('id', ids);
      for (const r of (data ?? []) as Array<Record<string, unknown>>) {
        const key = `news:${r.id}`;
        out.set(key, {
          type: 'news',
          id: r.id as string,
          timestamp: (r.created_at as string) ?? null,
          instruments: r.instrument ? [r.instrument as string] : [],
          direction: (r.impact as string) ?? null,
          conviction: (r.significance as number) ?? null,
          glance: [String(r.news_headline ?? ''), String(r.claude_take ?? '').slice(0, 200)],
          distance: distanceById.get(key),
        });
      }
      return;
    }

    // thesis / lesson → skip; they're less useful as recall hits.
  }));

  return out;
}

/**
 * Attach grades to hits that have grade_ids. Mutates hits in place.
 */
async function attachGrades(
  supabase: ReturnType<typeof createClient>,
  hits: Array<RecallHit & { _grade_id?: string | null }>,
): Promise<void> {
  // For flags/alerts/james_views we have grade_id directly.
  const directGradeIds = hits.map(h => h._grade_id).filter((x): x is string => !!x);

  // Build a lookup by (subject_type, subject_id) for anything else.
  const lookupRefs = hits
    .filter(h => !h._grade_id && (h.type === 'flag' || h.type === 'alert' || h.type === 'james_view'))
    .map(h => ({ type: h.type, id: h.id }));

  const gradesById = new Map<string, { verdict: string; actual_return_pct: number | null }>();
  const gradesBySubject = new Map<string, { verdict: string; actual_return_pct: number | null }>();

  if (directGradeIds.length > 0) {
    const { data } = await supabase.from('ct_grades')
      .select('id, verdict, actual_return_pct')
      .in('id', directGradeIds);
    for (const g of (data ?? []) as Array<Record<string, unknown>>) {
      gradesById.set(g.id as string, {
        verdict: g.verdict as string,
        actual_return_pct: (g.actual_return_pct as number) ?? null,
      });
    }
  }

  if (lookupRefs.length > 0) {
    const byType: Record<string, string[]> = {};
    for (const r of lookupRefs) (byType[r.type] ??= []).push(r.id);
    await Promise.all(Object.entries(byType).map(async ([type, ids]) => {
      const { data } = await supabase.from('ct_grades')
        .select('subject_type, subject_id, verdict, actual_return_pct')
        .eq('subject_type', type).in('subject_id', ids);
      for (const g of (data ?? []) as Array<Record<string, unknown>>) {
        gradesBySubject.set(`${g.subject_type}:${g.subject_id}`, {
          verdict: g.verdict as string,
          actual_return_pct: (g.actual_return_pct as number) ?? null,
        });
      }
    }));
  }

  for (const h of hits) {
    if (h._grade_id && gradesById.has(h._grade_id)) {
      h.grade = gradesById.get(h._grade_id)!;
    } else {
      const subj = gradesBySubject.get(`${h.type}:${h.id}`);
      if (subj) h.grade = subj;
    }
    delete h._grade_id;
  }
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  // Accept either authenticated user JWT or service role.
  let authorized = false;
  if (isServiceRoleRequest(req)) {
    authorized = true;
  } else {
    const { userId } = await extractUserId(req);
    if (userId) authorized = true;
  }
  if (!authorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();

  try {
    const body = await req.json().catch(() => ({})) as RecallInput;
    const query       = typeof body?.query === 'string' ? body.query.trim() : '';
    const instrument  = typeof body?.instrument === 'string' ? body.instrument.trim().toUpperCase() || undefined : undefined;
    const at          = typeof body?.at === 'string' ? body.at : undefined;
    const windowHours = typeof body?.window_hours === 'number' && body.window_hours > 0 ? Math.min(body.window_hours, 168) : 1;
    const kind: Kind  = (body?.kind as Kind) ?? 'any';

    if (!query && !at) {
      return new Response(JSON.stringify({ error: 'query or at required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const kinds = normalizeKinds(kind);
    const mode: 'time' | 'semantic' | 'hybrid' = query && at ? 'hybrid' : at ? 'time' : 'semantic';

    let hits: Array<RecallHit & { _grade_id?: string | null }> = [];

    if (at) {
      // Pure or hybrid time window.
      const atDate = new Date(at);
      if (isNaN(atDate.getTime())) {
        return new Response(JSON.stringify({ error: 'invalid `at` timestamp' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const atStart = new Date(atDate.getTime() - windowHours * 3600_000).toISOString();
      const atEnd   = new Date(atDate.getTime() + windowHours * 3600_000).toISOString();

      const perTypeLimit = Math.max(5, Math.ceil(MAX_HITS / kinds.length));
      const batches = await Promise.all(kinds.map(k => fetchByTime(supabase, k, instrument, atStart, atEnd, perTypeLimit)));
      hits = batches.flat() as Array<RecallHit & { _grade_id?: string | null }>;

      // If hybrid: also embed the query, then rank hits by embedding distance
      // against the time-window set. (Do it cheaply — fetch embeddings for those ids.)
      if (query) {
        let queryEmb: number[] | null = null;
        try { queryEmb = await voyageEmbed(query, 'query'); }
        catch (e) { console.warn('[ct-recall] hybrid embed failed:', e instanceof Error ? e.message : e); }

        if (queryEmb && hits.length > 0) {
          // Pull embeddings for this exact set via metadata lookup.
          const { data: embRows } = await supabase.from('ct_embeddings')
            .select('item_type, item_id, embedding')
            .in('item_id', hits.map(h => h.id));
          if (embRows) {
            const byKey = new Map<string, number[]>();
            for (const r of embRows as Array<Record<string, unknown>>) {
              const emb = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
              byKey.set(`${r.item_type}:${r.item_id}`, emb as number[]);
            }
            // Cosine distance (1 - dot/|a||b|). Vectors come back as arrays.
            for (const h of hits) {
              const emb = byKey.get(`${h.type}:${h.id}`);
              if (emb && emb.length === queryEmb.length) {
                let dot = 0, na = 0, nb = 0;
                for (let i = 0; i < emb.length; i++) { dot += emb[i] * queryEmb[i]; na += emb[i] * emb[i]; nb += queryEmb[i] * queryEmb[i]; }
                h.distance = 1 - (dot / (Math.sqrt(na) * Math.sqrt(nb) || 1));
              }
            }
            hits.sort((a, b) => (a.distance ?? 1) - (b.distance ?? 1));
          }
        }
      }
    } else {
      // Pure semantic.
      const queryEmb = await voyageEmbed(query, 'query');

      // Fetch nearest ct_embeddings. Filter by metadata.instrument + item_type where possible.
      let q = supabase.from('ct_embeddings')
        .select('item_type, item_id, metadata, embedding');
      if (instrument) q = q.eq('metadata->>instrument', instrument);

      // Only pull item types we care about. For news/report there may not be
      // embeddings — we still allow the type filter.
      const allowedTypes = kinds as string[];
      q = q.in('item_type', allowedTypes);

      // Cap the initial fetch so we don't scan the whole table. Post-sort in JS.
      const FETCH_CAP = 500;
      const { data: embRows, error: embErr } = await q.order('created_at', { ascending: false }).limit(FETCH_CAP);
      if (embErr) throw new Error(`ct_embeddings fetch failed: ${embErr.message}`);

      const scored: Array<{ type: string; id: string; distance: number }> = [];
      for (const r of (embRows ?? []) as Array<Record<string, unknown>>) {
        const emb = typeof r.embedding === 'string' ? JSON.parse(r.embedding) as number[] : r.embedding as number[];
        if (!Array.isArray(emb) || emb.length !== queryEmb.length) continue;
        let dot = 0, na = 0, nb = 0;
        for (let i = 0; i < emb.length; i++) { dot += emb[i] * queryEmb[i]; na += emb[i] * emb[i]; nb += queryEmb[i] * queryEmb[i]; }
        const distance = 1 - (dot / (Math.sqrt(na) * Math.sqrt(nb) || 1));
        scored.push({ type: r.item_type as string, id: r.item_id as string, distance });
      }

      scored.sort((a, b) => a.distance - b.distance);
      const topRefs = scored.slice(0, MAX_HITS);

      const byKey = await fetchSourceRows(supabase, topRefs);
      hits = topRefs.map(r => byKey.get(`${r.type}:${r.id}`)).filter((h): h is RecallHit & { _grade_id?: string | null } => !!h);
    }

    await attachGrades(supabase, hits);
    hits = hits.slice(0, MAX_HITS);

    return new Response(JSON.stringify({
      hits,
      mode,
      duration_ms: Date.now() - startedAt,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ct-recall] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'recall failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
