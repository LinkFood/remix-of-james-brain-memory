/**
 * ct-uw-mcp-scout — discovery + drift detection for UW's MCP server.
 *
 * Phase 2 Wave L.1. Tenet 12 ("Duplicate nothing UW maintains") says we should
 * stop hand-maintaining uwClient.ts + UW_ENDPOINT_REGISTRY the moment UW owns an
 * MCP server we can query. This function is the verified artifact that makes
 * the migration safe: it asks UW's MCP server what it advertises, freezes the
 * answer into ct_uw_mcp_tools / ct_uw_mcp_prompts, and flags anything missing
 * from previous runs as inactive (→ deprecation alert).
 *
 * No tool names are guessed. If the handshake fails or tools/list is empty, we
 * return an error and stop — the caller sees "inventory=0" and knows something
 * is wrong upstream, rather than silently shipping a bad whitelist.
 *
 * Schedule: daily 04:00 UTC (pre-market, ahead of the REST health-check).
 * Manual:   SELECT public.trigger_ct_uw_mcp_scout();
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import {
  mcpListTools,
  mcpListPrompts,
  setMcpCaller,
  UW_MCP_ENDPOINT,
  UW_MCP_PROTOCOL_VERSION,
  type McpTool,
  type McpPrompt,
} from '../_shared/uwMcpClient.ts';

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  setMcpCaller('ct-uw-mcp-scout');

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);
  const startedAt = Date.now();

  // 1. Discover.
  let tools: McpTool[] = [];
  let prompts: McpPrompt[] = [];
  try {
    tools = await mcpListTools();
  } catch (e) {
    return new Response(JSON.stringify({
      success: false,
      stage: 'tools/list',
      error: e instanceof Error ? e.message : String(e),
      endpoint: UW_MCP_ENDPOINT,
    }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  try {
    prompts = await mcpListPrompts();
  } catch (e) {
    // prompts/list is optional for some servers — log but don't bail.
    console.warn('[ct-uw-mcp-scout] prompts/list failed:', e instanceof Error ? e.message : e);
  }

  if (tools.length === 0) {
    return new Response(JSON.stringify({
      success: false,
      stage: 'tools/list',
      error: 'UW MCP server returned zero tools — refusing to write empty inventory',
      endpoint: UW_MCP_ENDPOINT,
    }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const nowIso = new Date().toISOString();

  // 2. Load existing inventory to drive drift detection.
  const { data: prevTools, error: loadToolsErr } = await supabase
    .from('ct_uw_mcp_tools')
    .select('name, active');
  if (loadToolsErr) {
    console.error('[ct-uw-mcp-scout] load tools failed:', loadToolsErr);
  }
  const { data: prevPrompts, error: loadPromptsErr } = await supabase
    .from('ct_uw_mcp_prompts')
    .select('name, active');
  if (loadPromptsErr) {
    console.error('[ct-uw-mcp-scout] load prompts failed:', loadPromptsErr);
  }

  const prevToolNames = new Set((prevTools ?? []).map(r => r.name as string));
  const prevPromptNames = new Set((prevPrompts ?? []).map(r => r.name as string));

  // 3. Upsert the current advertise-list. Postgres PK is `name`, so this is a
  //    clean merge by name.
  const toolRows = tools.map(t => ({
    name: t.name,
    description: t.description ?? null,
    input_schema: t.inputSchema ?? null,
    last_seen_at: nowIso,
    active: true,
  }));
  const { error: upsertToolsErr } = await supabase
    .from('ct_uw_mcp_tools')
    .upsert(toolRows, { onConflict: 'name' });
  if (upsertToolsErr) {
    console.error('[ct-uw-mcp-scout] upsert tools failed:', upsertToolsErr);
  }

  const promptRows = prompts.map(p => ({
    name: p.name,
    description: p.description ?? null,
    arguments: p.arguments ?? null,
    last_seen_at: nowIso,
    active: true,
  }));
  if (promptRows.length > 0) {
    const { error: upsertPromptsErr } = await supabase
      .from('ct_uw_mcp_prompts')
      .upsert(promptRows, { onConflict: 'name' });
    if (upsertPromptsErr) {
      console.error('[ct-uw-mcp-scout] upsert prompts failed:', upsertPromptsErr);
    }
  }

  // 4. Drift detection: previously-seen rows no longer in the advertise-list
  //    get flipped to active=false. Do NOT delete — the history is evidence.
  const currentToolNames = new Set(tools.map(t => t.name));
  const goneTools = [...prevToolNames].filter(n => !currentToolNames.has(n));
  if (goneTools.length > 0) {
    const { error: deprToolsErr } = await supabase
      .from('ct_uw_mcp_tools')
      .update({ active: false, last_seen_at: nowIso })
      .in('name', goneTools);
    if (deprToolsErr) {
      console.error('[ct-uw-mcp-scout] deprecate tools failed:', deprToolsErr);
    }
  }

  const currentPromptNames = new Set(prompts.map(p => p.name));
  const gonePrompts = [...prevPromptNames].filter(n => !currentPromptNames.has(n));
  if (gonePrompts.length > 0) {
    const { error: deprPromptsErr } = await supabase
      .from('ct_uw_mcp_prompts')
      .update({ active: false, last_seen_at: nowIso })
      .in('name', gonePrompts);
    if (deprPromptsErr) {
      console.error('[ct-uw-mcp-scout] deprecate prompts failed:', deprPromptsErr);
    }
  }

  // 5. Journal entry. stress_check is the correct decision_type per the check
  //    constraint on ct_claude_decisions — it is used across health probes.
  const newTools = tools.filter(t => !prevToolNames.has(t.name)).map(t => t.name);
  const newPrompts = prompts.filter(p => !prevPromptNames.has(p.name)).map(p => p.name);
  const reasoning =
    `UW MCP scout: ${tools.length} tools + ${prompts.length} prompts advertised by ${UW_MCP_ENDPOINT}. ` +
    `new_tools=${newTools.length} (${newTools.slice(0, 6).join(', ')}${newTools.length > 6 ? ', …' : ''}), ` +
    `new_prompts=${newPrompts.length} (${newPrompts.slice(0, 6).join(', ')}${newPrompts.length > 6 ? ', …' : ''}), ` +
    `deprecated_tools=${goneTools.length} (${goneTools.slice(0, 6).join(', ')}${goneTools.length > 6 ? ', …' : ''}), ` +
    `deprecated_prompts=${gonePrompts.length}.`;

  const { error: journalErr } = await supabase.from('ct_claude_decisions').insert({
    decision_type: 'stress_check',
    model_tier: 'none',
    reasoning,
    outcome: `uw_mcp_inventory: ${tools.length}t/${prompts.length}p`,
    tool_calls_summary: {
      endpoint: UW_MCP_ENDPOINT,
      protocol_version_requested: UW_MCP_PROTOCOL_VERSION,
      tool_count: tools.length,
      prompt_count: prompts.length,
      new_tools: newTools,
      deprecated_tools: goneTools,
      new_prompts: newPrompts,
      deprecated_prompts: gonePrompts,
    },
  });
  if (journalErr) {
    console.error('[ct-uw-mcp-scout] journal insert failed:', journalErr);
  }

  // 6. Return the full inventory so the manual-trigger caller can eyeball it.
  return new Response(JSON.stringify({
    success: true,
    endpoint: UW_MCP_ENDPOINT,
    summary: {
      tool_count: tools.length,
      prompt_count: prompts.length,
      new_tools: newTools.length,
      new_prompts: newPrompts.length,
      deprecated_tools: goneTools.length,
      deprecated_prompts: gonePrompts.length,
    },
    tools: tools.map(t => ({
      name: t.name,
      description: t.description ?? null,
      // Trim schema preview to keep response readable — full schema is in DB.
      input_schema_keys: t.inputSchema && typeof t.inputSchema === 'object'
        ? Object.keys((t.inputSchema as Record<string, unknown>).properties ?? {})
        : [],
    })),
    prompts: prompts.map(p => ({
      name: p.name,
      description: p.description ?? null,
      arguments: p.arguments ?? [],
    })),
    duration_ms: Date.now() - startedAt,
  }, null, 2), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
