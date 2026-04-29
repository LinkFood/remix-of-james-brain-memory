/**
 * ct-mcp-shape-probe — diagnostic. Calls a single MCP tool and dumps its
 * raw result to the response + ct_heartbeats so we can see what UW actually
 * returned. Temporary — delete after Wave N.2 shape issues are resolved.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { mcpCallTool, mcpCallToolAsData, setMcpCaller } from '../_shared/uwMcpClient.ts';

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  setMcpCaller('ct-mcp-shape-probe');

  const body = await req.json().catch(() => ({})) as { tool?: string; args?: Record<string, unknown> };
  const tool = body.tool;
  const args = body.args ?? {};
  if (!tool) return new Response(JSON.stringify({ error: 'pass { tool: "get_...", args: {...} }' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const out: Record<string, unknown> = { tool, args };
  try {
    const raw = await mcpCallTool(tool, args);
    out.raw_preview = JSON.stringify(raw).slice(0, 4000);
  } catch (e) {
    out.raw_err = e instanceof Error ? e.message : String(e);
  }
  try {
    const parsed = await mcpCallToolAsData(tool, args);
    out.parsed_preview = JSON.stringify(parsed).slice(0, 4000);
    out.parsed_keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.keys(parsed as Record<string, unknown>).slice(0, 20)
      : Array.isArray(parsed) ? '<array>' : typeof parsed;
  } catch (e) {
    out.parsed_err = e instanceof Error ? e.message : String(e);
  }

  try {
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    await supabase.from('ct_heartbeats').insert({
      status_line: `[mcp-shape-probe] tool=${tool}`,
      watching: ['mcp-shape-probe'],
      current_reads: out,
      prompt_version: 'mcp-shape-probe',
    });
  } catch { /* ignore */ }

  return new Response(JSON.stringify(out, null, 2), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
