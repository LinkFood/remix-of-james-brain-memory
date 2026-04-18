/**
 * ct-mcp-verify — one-shot test that calls Claude's Messages API with the
 * Unusual Whales MCP server attached, asks a question that can ONLY be
 * answered by hitting UW, and dumps the raw response.
 *
 * If this returns tool_use blocks citing UW data, the chat MCP wiring works.
 * If it returns plain text without tool use, or errors, we know to fix.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { CLAUDE_MODELS } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY');
  const uwKey = Deno.env.get('UW_API_KEY');

  if (!anthropicKey) return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY missing' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  if (!uwKey) return new Response(JSON.stringify({ error: 'UW_API_KEY missing' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    mcp_servers: [{
      type: 'url',
      url: 'https://api.unusualwhales.com/api/mcp',
      name: 'unusual-whales',
      authorization_token: uwKey,
    }],
    messages: [{
      role: 'user',
      content: 'Use the unusual-whales MCP tools to fetch the current spot GEX for NVDA. Report back what you pulled (summarize — don\'t dump raw JSON). If the tool call fails, tell me exactly what error you got.',
    }],
  };

  const claudeCallStart = Date.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'mcp-client-2025-04-04',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const status = res.status;
    const raw = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(raw); } catch { /* leave raw */ }

    const p = parsed as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown; server_name?: string }>; stop_reason?: string; error?: unknown; usage?: { input_tokens?: number; output_tokens?: number } } | null;

    // Summarize content blocks
    const blocks = (p?.content ?? []).map(b => {
      if (b.type === 'text') return { type: 'text', preview: (b.text ?? '').slice(0, 500) };
      if (b.type === 'mcp_tool_use') return { type: 'mcp_tool_use', server: b.server_name, name: b.name, input_preview: JSON.stringify(b.input ?? {}).slice(0, 200) };
      if (b.type === 'mcp_tool_result') return { type: 'mcp_tool_result', server: b.server_name, preview: JSON.stringify(b).slice(0, 300) };
      return { type: b.type, raw_preview: JSON.stringify(b).slice(0, 200) };
    });

    const summary = {
      http_status: status,
      stop_reason: p?.stop_reason ?? null,
      error: p?.error ?? null,
      usage: p?.usage ?? null,
      content_blocks: blocks,
      mcp_tool_used: blocks.some(b => b.type === 'mcp_tool_use'),
      raw_tail: raw.slice(-500),
    };

    // Write to ct_heartbeats with a [mcp-verify] marker AND log the MCP calls
    try {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      );
      await supabase.from('ct_heartbeats').insert({
        status_line: `[mcp-verify] http=${status} mcp_used=${summary.mcp_tool_used} stop=${p?.stop_reason ?? 'n/a'}`,
        watching: ['mcp-verify'],
        current_reads: { _mcp_verify: summary },
        prompt_version: 'mcp-verify',
      });
      // Log each MCP call to ct_mcp_calls so it shows up in the inspector
      const { logMcpCalls } = await import('../_shared/mcpLog.ts');
      await logMcpCalls(supabase, 'mcp-verify', parsed as unknown as { content?: unknown });
      // Log Claude cost — diagnostic function, usually James-invoked manually.
      const mcpToolUseCount = (p?.content ?? []).filter(b => b.type === 'mcp_tool_use').length;
      logClaudeUsage(supabase, {
        source: 'ct-mcp-verify',
        model: CLAUDE_MODELS.sonnet,
        usage: p?.usage ?? null,
        duration_ms: Date.now() - claudeCallStart,
        mcp_calls: mcpToolUseCount,
        metadata: { manual_invocation: true, http_status: status, stop_reason: p?.stop_reason ?? null },
      });
    } catch (_e) { /* ignore write errors */ }

    return new Response(JSON.stringify(summary, null, 2), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
