/**
 * ct-chat — conversational interface for James to talk to Claude about
 * the tape. Called from the frontend ChatBox with user JWT auth.
 *
 * Input:
 *   { message: string, history: Array<{role: 'user'|'assistant', content: string}> }
 *
 * Pulls: latest heartbeat (condensed state), all theses, recent events
 * (last 10 obs/flags/alerts), and hands it all to Claude along with
 * chat history + new message.
 *
 * Output: { response: string, duration_ms: number }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { extractUserId, isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { CT_CHAT_SYSTEM } from '../_shared/chatPromptV1.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Semantic recall over ct_embeddings for the user's current message.
 * Returns up to 5 hits older than 30 min so we don't echo back the current cycle.
 * Best-effort — returns [] on any failure (never throws).
 */
async function recentSemanticHits(
  supabase: ReturnType<typeof createClient>,
  message: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const queryEmb = await voyageEmbed(message, 'query');
    const olderThan = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    // Pull a bounded set of recent-ish embeddings across recall-worthy types.
    const { data: embRows } = await supabase.from('ct_embeddings')
      .select('item_type, item_id, metadata, embedding, created_at')
      .in('item_type', ['observation', 'flag', 'alert', 'news', 'james_view', 'report'])
      .lt('created_at', olderThan)
      .order('created_at', { ascending: false })
      .limit(400);

    if (!embRows || embRows.length === 0) return [];

    const scored: Array<{ type: string; id: string; distance: number; metadata: Record<string, unknown> }> = [];
    for (const r of embRows as Array<Record<string, unknown>>) {
      const emb = typeof r.embedding === 'string' ? JSON.parse(r.embedding) as number[] : r.embedding as number[];
      if (!Array.isArray(emb) || emb.length !== queryEmb.length) continue;
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < emb.length; i++) { dot += emb[i] * queryEmb[i]; na += emb[i] * emb[i]; nb += queryEmb[i] * queryEmb[i]; }
      scored.push({
        type: r.item_type as string,
        id: r.item_id as string,
        distance: 1 - (dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)),
        metadata: (r.metadata as Record<string, unknown>) ?? {},
      });
    }
    scored.sort((a, b) => a.distance - b.distance);
    const top = scored.slice(0, 5);
    if (top.length === 0) return [];

    // Per-type fetch for source rows.
    const byType: Record<string, string[]> = {};
    for (const r of top) (byType[r.type] ??= []).push(r.id);

    const hits = new Map<string, Record<string, unknown>>();
    await Promise.all(Object.entries(byType).map(async ([type, ids]) => {
      if (type === 'observation') {
        const { data } = await supabase.from('ct_observations').select('id, instruments, direction, glance, created_at').in('id', ids);
        for (const r of (data ?? []) as Array<Record<string, unknown>>) hits.set(`observation:${r.id}`, { type: 'observation', ...r });
      } else if (type === 'flag' || type === 'alert') {
        const table = type === 'flag' ? 'ct_flags' : 'ct_alerts';
        const { data } = await supabase.from(table).select('id, instruments, direction, conviction, horizon, glance, grade_id, created_at').in('id', ids);
        for (const r of (data ?? []) as Array<Record<string, unknown>>) hits.set(`${type}:${r.id}`, { type, ...r });
      } else if (type === 'james_view') {
        const { data } = await supabase.from('ct_james_views').select('id, instrument, direction, conviction, horizon, rationale, grade_id, created_at').in('id', ids);
        for (const r of (data ?? []) as Array<Record<string, unknown>>) hits.set(`james_view:${r.id}`, { type: 'james_view', ...r });
      } else if (type === 'news') {
        const { data } = await supabase.from('ct_news_analyses').select('id, instrument, news_headline, impact, significance, claude_take, created_at').in('id', ids);
        for (const r of (data ?? []) as Array<Record<string, unknown>>) hits.set(`news:${r.id}`, { type: 'news', ...r });
      } else if (type === 'report') {
        const { data } = await supabase.from('ct_reports').select('id, report_type, summary, period_start, period_end, created_at').in('id', ids);
        for (const r of (data ?? []) as Array<Record<string, unknown>>) hits.set(`report:${r.id}`, { type: 'report', ...r });
      }
    }));

    // Attach grades for flag/alert/james_view.
    const gradeIds = [...hits.values()].map(h => h.grade_id).filter((x): x is string => !!x);
    const gradesById = new Map<string, { verdict: string; actual_return_pct: number | null }>();
    if (gradeIds.length > 0) {
      const { data } = await supabase.from('ct_grades').select('id, verdict, actual_return_pct').in('id', gradeIds);
      for (const g of (data ?? []) as Array<Record<string, unknown>>) {
        gradesById.set(g.id as string, { verdict: g.verdict as string, actual_return_pct: (g.actual_return_pct as number) ?? null });
      }
    }

    // Also subject-lookup in case grade_id isn't set.
    const subjectLookup: Array<{ type: string; id: string }> = [];
    for (const h of hits.values()) {
      if (!h.grade_id && (h.type === 'flag' || h.type === 'alert' || h.type === 'james_view')) {
        subjectLookup.push({ type: h.type as string, id: h.id as string });
      }
    }
    const gradesBySubject = new Map<string, { verdict: string; actual_return_pct: number | null }>();
    if (subjectLookup.length > 0) {
      const byT: Record<string, string[]> = {};
      for (const r of subjectLookup) (byT[r.type] ??= []).push(r.id);
      await Promise.all(Object.entries(byT).map(async ([type, ids]) => {
        const { data } = await supabase.from('ct_grades').select('subject_type, subject_id, verdict, actual_return_pct').eq('subject_type', type).in('subject_id', ids);
        for (const g of (data ?? []) as Array<Record<string, unknown>>) {
          gradesBySubject.set(`${g.subject_type}:${g.subject_id}`, { verdict: g.verdict as string, actual_return_pct: (g.actual_return_pct as number) ?? null });
        }
      }));
    }

    // Assemble ordered output.
    return top.map(r => {
      const raw = hits.get(`${r.type}:${r.id}`);
      if (!raw) return null;
      const grade =
        (raw.grade_id && gradesById.get(raw.grade_id as string)) ||
        gradesBySubject.get(`${r.type}:${r.id}`) ||
        null;
      return {
        type: r.type,
        id: r.id,
        distance: Number(r.distance.toFixed(4)),
        timestamp: raw.created_at,
        instruments: raw.instruments ?? (raw.instrument ? [raw.instrument] : []),
        direction: raw.direction ?? raw.impact ?? null,
        conviction: raw.conviction ?? raw.significance ?? null,
        glance: raw.glance ?? (raw.news_headline ? [raw.news_headline, String(raw.claude_take ?? '').slice(0, 200)] : raw.rationale ? [raw.rationale] : null),
        grade,
      };
    }).filter((x): x is Record<string, unknown> => !!x);
  } catch (e) {
    console.warn('[ct-chat] recentSemanticHits failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

async function buildContext(supabase: ReturnType<typeof createClient>) {
  const flowCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const [heartbeat, theses, obs, flags, alerts, flow, dp, news] = await Promise.all([
    supabase.from('ct_heartbeats').select('status_line, current_reads, watching, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_theses').select('instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at'),
    supabase.from('ct_observations').select('id, instruments, direction, glance, created_at').order('created_at', { ascending: false }).limit(6),
    supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, glance, created_at').order('created_at', { ascending: false }).limit(6),
    supabase.from('ct_alerts').select('id, instruments, direction, conviction, horizon, alert_trigger, glance, created_at').order('created_at', { ascending: false }).limit(3),
    supabase.from('ct_flow_alerts').select('ticker, side, strike, expiry, is_otm, is_ask, size, premium, size_gt_oi, executed_at').gte('ingested_at', flowCutoff).order('premium', { ascending: false }).limit(25),
    supabase.from('ct_dark_pool_prints').select('ticker, size, price, notional_value, executed_at').gte('ingested_at', flowCutoff).order('notional_value', { ascending: false }).limit(25),
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take, created_at').gte('significance', 3).order('created_at', { ascending: false }).limit(10),
  ]);

  // Condense heartbeat current_reads — only send the _snapshot (condensed state),
  // not the _macro blob with raw per-strike Greek vectors.
  const hb = heartbeat.data as { status_line?: string; current_reads?: Record<string, unknown>; created_at?: string } | null;
  const snapshot = hb?.current_reads?._snapshot ?? null;

  return {
    latest_status: hb?.status_line ?? null,
    latest_pulse_at: hb?.created_at ?? null,
    market_state: snapshot,
    theses: theses.data ?? [],
    recent_observations: obs.data ?? [],
    recent_flags: flags.data ?? [],
    recent_alerts: alerts.data ?? [],
    recent_flow_alerts_30min: flow.data ?? [],
    recent_dark_pool_prints_30min: dp.data ?? [],
    recent_significant_news: news.data ?? [],
  };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  // Accept either authenticated user JWT or service role (for testing).
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

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const startedAt = Date.now();

  try {
    const body = await req.json().catch(() => ({}));
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const history = Array.isArray(body?.history) ? (body.history as ChatMessage[]).slice(-10) : [];

    if (!message) {
      return new Response(JSON.stringify({ error: 'message required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const [context, semanticHits] = await Promise.all([
      buildContext(supabase),
      recentSemanticHits(supabase, message),
    ]);
    (context as Record<string, unknown>).recent_semantic_hits = semanticHits;

    // Prepend a context block as the first user turn so Claude sees live state
    // before any conversation history. Then real conversation, then new message.
    const contextBlock = `[LIVE STATE — injected by system, not a user message]\n${JSON.stringify(context, null, 2)}\n\n[END LIVE STATE]`;

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: contextBlock },
      { role: 'assistant', content: 'Got it. I have the current state loaded. What do you want to talk about?' },
      ...history,
      { role: 'user', content: message },
    ];

    let responseText = '';
    try {
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,   // better conversational reasoning than Haiku
        system: CT_CHAT_SYSTEM,
        messages,
        max_tokens: 1500,
        temperature: 0.4,
      });
      responseText = parseTextContent(res).trim();
    } catch (e) {
      const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
      console.error('[ct-chat] Claude failed:', detail);
      return new Response(JSON.stringify({ error: 'Claude call failed', detail }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      response: responseText || '(empty response)',
      duration_ms: Date.now() - startedAt,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ct-chat] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'chat failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
