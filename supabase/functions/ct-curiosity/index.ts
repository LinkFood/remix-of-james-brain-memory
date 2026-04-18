/**
 * ct-curiosity — Proactive Claude cron.
 *
 * Runs at :07 and :37 past every weekday market hour (13:00-20:00 UTC),
 * offset 7 min from the reactive watcher so the two don't stampede the MCP
 * budget. Each run asks Claude ONE question: given the last 30 min of tape
 * state, is there anything the scheduled watcher MIGHT HAVE MISSED that's
 * worth a deeper look?
 *
 * Pipeline:
 *   1. Pull 30-min context: 5 latest heartbeats, 5 latest observations,
 *      top-3 ct_attention_stream rows, full ct_theses snapshot.
 *   2. Call Claude Haiku with UW MCP attached. Budget: 2 calls max.
 *   3. Parse { skip: true, reason } OR the full finding JSON.
 *   4. If non-skip: insert into ct_curiosity_findings, embed via Voyage,
 *      Slack push when attention_score >= 60.
 *   5. Always log MCP calls to ct_mcp_calls + warn on budget breach.
 *
 * Auth: service role only.
 * Model: Haiku — self-queries don't warrant Sonnet cost.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { CURIOSITY_SYSTEM } from '../_shared/ctPrompts.ts';
import { logMcpCalls } from '../_shared/mcpLog.ts';
import { embedCtItem } from '../_shared/ctEmbed.ts';
import { ctSlackPush } from '../_shared/ctSlack.ts';

const MCP_BUDGET = 2;
const PROMPT_VERSION = 'v1';
// Haiku 4.5 rates per CLAUDE_RATES ($0.80/M in, $4/M out).
const HAIKU_IN_PER_MTOK  = 0.80;
const HAIKU_OUT_PER_MTOK = 4.0;

type AttentionRow = {
  kind: 'observation' | 'flag' | 'alert' | 'heartbeat';
  id: string;
  created_at: string;
  attention_score: number | null;
  summary: string | null;
};

interface Finding {
  skip: false;
  question: string;
  finding: string;
  attention_score: number;
  actionable: boolean;
  related_instruments: string[];
  mcp_calls: number;
}

interface SkipResult {
  skip: true;
  reason: string;
}

type ParsedResult = Finding | SkipResult;

// ---------------------------------------------------------------------------
// Context pull — last 30 min
// ---------------------------------------------------------------------------
async function buildContext(supabase: SupabaseClient) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const [heartbeats, observations, attention, theses] = await Promise.all([
    supabase.from('ct_heartbeats')
      .select('status_line, watching, created_at, attention_score')
      .order('created_at', { ascending: false })
      .limit(5),
    supabase.from('ct_observations')
      .select('id, instruments, direction, glance, created_at, attention_score')
      .order('created_at', { ascending: false })
      .limit(5),
    supabase.from('ct_attention_stream')
      .select('kind, id, created_at, attention_score, summary')
      .gte('created_at', cutoff)
      .order('attention_score', { ascending: false, nullsFirst: false })
      .limit(3),
    supabase.from('ct_theses')
      .select('instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at'),
  ]);

  // Observations: just keep glance[0] per request.
  const obs = (observations.data ?? []).map((o) => {
    const r = o as Record<string, unknown>;
    const glance = Array.isArray(r.glance) ? (r.glance as string[]) : [];
    return {
      id: r.id as string,
      instruments: r.instruments ?? [],
      direction: r.direction ?? null,
      glance_0: glance[0] ?? null,
      attention_score: r.attention_score ?? null,
      created_at: r.created_at,
    };
  });

  const hb = (heartbeats.data ?? []).map((h) => {
    const r = h as Record<string, unknown>;
    return {
      status_line: r.status_line ?? null,
      watching: r.watching ?? null,
      attention_score: r.attention_score ?? null,
      created_at: r.created_at,
    };
  });

  return {
    window: '30min',
    now: new Date().toISOString(),
    recent_heartbeats: hb,
    recent_observations: obs,
    top_attention_last_30min: (attention.data ?? []) as AttentionRow[],
    current_theses: theses.data ?? [],
  };
}

// ---------------------------------------------------------------------------
// Parse Claude JSON — either a skip or a finding.
// ---------------------------------------------------------------------------
function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function parseClaudeJson(raw: string): ParsedResult | { error: string } {
  const body = stripFences(raw).trim();
  if (!body) return { error: 'empty response' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Sometimes Haiku wraps JSON in a single-object paragraph — try to extract.
    const match = body.match(/\{[\s\S]*\}/);
    if (!match) return { error: 'no JSON found' };
    try { parsed = JSON.parse(match[0]); }
    catch { return { error: 'JSON parse failed' }; }
  }

  const p = parsed as Record<string, unknown>;
  if (p.skip === true) {
    return { skip: true, reason: String(p.reason ?? '').slice(0, 500) };
  }

  const instruments = Array.isArray(p.related_instruments)
    ? (p.related_instruments as unknown[]).map((x) => String(x).toUpperCase()).slice(0, 10)
    : [];
  const score = Number(p.attention_score ?? 0);

  if (typeof p.question !== 'string' || typeof p.finding !== 'string') {
    return { error: 'missing question or finding' };
  }

  return {
    skip: false,
    question: (p.question as string).trim().slice(0, 2000),
    finding: (p.finding as string).trim().slice(0, 6000),
    attention_score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    actionable: Boolean(p.actionable),
    related_instruments: instruments,
    mcp_calls: Number.isFinite(Number(p.mcp_calls)) ? Number(p.mcp_calls) : 0,
  };
}

// ---------------------------------------------------------------------------
// Count mcp_tool_use blocks in a Claude response.
// ---------------------------------------------------------------------------
function countMcpCalls(res: unknown): number {
  const blocks = (res as { content?: unknown[] }).content ?? [];
  if (!Array.isArray(blocks)) return 0;
  return blocks.filter((b) => (b as { type?: string }).type === 'mcp_tool_use').length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'service role required' }), {
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
    // Single-user: fetch James's profile id (same pattern as ct-watcher).
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    const context = await buildContext(supabase);

    const userPayload = `[TAPE STATE — last 30 min]\n${JSON.stringify(context, null, 2)}\n\n[END STATE]\n\nGiven this, pick ONE specific investigation worth a deeper look — or skip cleanly if nothing warrants it. Budget: ${MCP_BUDGET} UW MCP calls max. Return the JSON shape specified in the system prompt.`;

    const uwKey = Deno.env.get('UW_API_KEY');
    if (!uwKey) {
      console.warn('[ct-curiosity] UW_API_KEY missing — running with no MCP access');
    }

    let claudeRes: unknown;
    let responseText = '';
    const claudeCallStart = Date.now();
    try {
      claudeRes = await callClaude({
        model: CLAUDE_MODELS.haiku, // Haiku only — self-queries don't warrant Sonnet cost
        system: CURIOSITY_SYSTEM,
        messages: [{ role: 'user', content: userPayload }],
        max_tokens: 2000,
        temperature: 0.3,
        mcp_servers: uwKey ? [{
          type: 'url',
          url: 'https://api.unusualwhales.com/api/mcp',
          name: 'unusual-whales',
          authorization_token: uwKey,
        }] : undefined,
        beta: uwKey ? ['mcp-client-2025-04-04'] : undefined,
      });
      responseText = parseTextContent(claudeRes as Parameters<typeof parseTextContent>[0]).trim();
    } catch (e) {
      const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
      console.error('[ct-curiosity] Claude call failed:', detail);
      return new Response(JSON.stringify({ ran: false, error: 'claude_failed', detail, duration_ms: Date.now() - startedAt }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ALWAYS log MCP calls — audit trail is non-negotiable.
    const actualMcpCalls = countMcpCalls(claudeRes);
    logMcpCalls(supabase, 'curiosity', claudeRes as { content?: unknown }, { user_id: userId })
      .catch((e) => console.warn('[ct-curiosity] mcpLog failed:', e));

    // Budget enforcement — warn loudly if Claude cited more than MCP_BUDGET.
    if (actualMcpCalls > MCP_BUDGET) {
      console.warn(`[ct-curiosity] BUDGET BREACH: Claude made ${actualMcpCalls} MCP calls (budget ${MCP_BUDGET})`);
    }

    const usage = (claudeRes as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
    const inTok = usage?.input_tokens ?? 0;
    const outTok = usage?.output_tokens ?? 0;
    const costUsd = Number(((inTok / 1_000_000) * HAIKU_IN_PER_MTOK + (outTok / 1_000_000) * HAIKU_OUT_PER_MTOK).toFixed(6));

    // Unified Claude cost log — curiosity keeps its per-row tokens in
    // ct_curiosity_findings for finding-level audit, but cost aggregation
    // flows through ct_claude_usage.
    logClaudeUsage(supabase, {
      source: 'ct-curiosity',
      model: CLAUDE_MODELS.haiku,
      usage: usage ?? null,
      duration_ms: Date.now() - claudeCallStart,
      mcp_calls: actualMcpCalls,
      metadata: { user_id: userId },
    });

    const parsed = parseClaudeJson(responseText);

    if ('error' in parsed) {
      console.warn('[ct-curiosity] parse error:', parsed.error, 'raw:', responseText.slice(0, 400));
      return new Response(JSON.stringify({
        ran: false,
        error: 'parse_failed',
        detail: parsed.error,
        raw: responseText.slice(0, 400),
        duration_ms: Date.now() - startedAt,
        cost_usd: costUsd,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (parsed.skip) {
      return new Response(JSON.stringify({
        ran: false,
        skip_reason: parsed.reason,
        duration_ms: Date.now() - startedAt,
        cost_usd: costUsd,
        mcp_calls: actualMcpCalls,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Non-skip path: insert, embed, maybe-Slack.
    const { data: inserted, error: insErr } = await supabase
      .from('ct_curiosity_findings')
      .insert({
        user_id: userId,
        question: parsed.question,
        finding: parsed.finding,
        attention_score: parsed.attention_score,
        mcp_calls: actualMcpCalls,
        tokens_in: inTok,
        tokens_out: outTok,
        cost_usd: costUsd,
        actionable: parsed.actionable,
        related_instruments: parsed.related_instruments,
        prompt_version: PROMPT_VERSION,
      })
      .select('id')
      .single();

    if (insErr || !inserted) {
      console.error('[ct-curiosity] insert failed:', insErr);
      return new Response(JSON.stringify({ ran: false, error: 'insert_failed', detail: insErr?.message, duration_ms: Date.now() - startedAt }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const findingId = inserted.id as string;

    // Embed — per THE EMBEDDING LAW. Rich text: question + finding + instruments.
    // item_type uses the closest legal value on the ct_embeddings enum. "observation"
    // is the best fit for a self-directed investigation report (narrative + instruments).
    embedCtItem(supabase, {
      item_type: 'observation',
      item_id: findingId,
      text: `CURIOSITY | ${parsed.related_instruments.join('+')} | attn${parsed.attention_score}\nQ: ${parsed.question}\nA: ${parsed.finding}`,
      metadata: {
        source: 'ct-curiosity',
        kind: 'curiosity',
        instruments: parsed.related_instruments,
        attention_score: parsed.attention_score,
        actionable: parsed.actionable,
        prompt_version: PROMPT_VERSION,
      },
    }).catch((e) => console.warn('[ct-curiosity] embed failed:', e));

    // Slack — only if attention_score >= 60 AND we have a userId.
    if (parsed.attention_score >= 60 && userId) {
      // ctSlackPush union is { FLAG | ALERT | RECAP | DISAGREEMENT }. No CURIOSITY
      // member yet — use FLAG to keep the push going out without widening the type.
      // The header text names it clearly so there's no confusion on the Slack side.
      const truncated = parsed.finding.length > 280
        ? parsed.finding.slice(0, 277) + '…'
        : parsed.finding;
      ctSlackPush(supabase, userId, {
        state: 'FLAG',
        instruments: parsed.related_instruments.length > 0 ? parsed.related_instruments : ['CURIOSITY'],
        direction: parsed.actionable ? 'volatility' : 'neutral',
        conviction: Math.round(parsed.attention_score / 20), // 0..5 map
        glance: [
          `CURIOSITY (attn ${parsed.attention_score}): ${parsed.question}`,
          truncated,
        ],
      }).catch((e) => console.warn('[ct-curiosity] slack push failed:', e));
    }

    return new Response(JSON.stringify({
      ran: true,
      finding_id: findingId,
      attention_score: parsed.attention_score,
      actionable: parsed.actionable,
      related_instruments: parsed.related_instruments,
      mcp_calls: actualMcpCalls,
      budget_breach: actualMcpCalls > MCP_BUDGET,
      duration_ms: Date.now() - startedAt,
      cost_usd: costUsd,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-curiosity] fatal:', error);
    return new Response(JSON.stringify({
      ran: false,
      error: error instanceof Error ? error.message : 'curiosity failed',
      duration_ms: Date.now() - startedAt,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
