/**
 * ct-vix-capture — capture current VIX into ct_vix_history.
 *
 * REWRITE 2026-04-23: The prior version used getSpotGexByStrike('VIX')
 * + VIXY fallback via the REST spot-exposures endpoint. UW 4xx'd both
 * and the table stayed empty since the endpoint stopped resolving the
 * index. Now we use UW MCP's get_futures_indices tool (category =
 * 'indices') which returns a list of global indices including VIX.
 *
 * Scheduled daily at 21:05 UTC (post-close). Also fires mid-session at
 * 15:00 and 18:30 UTC for intraday capture — not just close-of-day —
 * so Claude can see VIX regime shifts during the session.
 *
 * Auth: service role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { mcpCallTool } from '../_shared/uwMcpClient.ts';

interface IndexRow {
  symbol?: string;
  ticker?: string;
  name?: string;
  price?: number | string;
  last_price?: number | string;
  level?: number | string;
  change_pct?: number | string;
  percent_change?: number | string;
  [key: string]: unknown;
}

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function findVix(rows: unknown): { level: number; change_pct: number | null; raw: unknown } | null {
  if (!Array.isArray(rows)) return null;
  for (const r of rows as IndexRow[]) {
    const sym = String(r.symbol ?? r.ticker ?? r.name ?? '').toUpperCase();
    if (sym === 'VIX' || sym.startsWith('VIX ') || sym === '^VIX' || sym === 'CBOE:VIX') {
      const level = parseNum(r.price) ?? parseNum(r.last_price) ?? parseNum(r.level);
      if (level == null || level <= 0) continue;
      const change = parseNum(r.change_pct) ?? parseNum(r.percent_change);
      return { level, change_pct: change, raw: r };
    }
  }
  return null;
}

serve(async (req) => {
  const corsResponse = handleCors(req); if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-vix-capture', corsHeaders);
  }

  // Try categories likely to include VIX. UW's `type` param isn't
  // strictly documented in the schema, so we try 'indices' first and
  // fall through on empty/error.
  const categoriesToTry = ['indices', 'index', 'global indices', 'global-indices'];
  let found: { level: number; change_pct: number | null; raw: unknown; category: string } | null = null;
  const errors: string[] = [];

  for (const cat of categoriesToTry) {
    try {
      const result = await mcpCallTool('get_futures_indices', { type: cat });
      const data = (result && typeof result === 'object' && 'data' in (result as Record<string, unknown>))
        ? (result as { data: unknown }).data
        : result;
      const v = findVix(data);
      if (v) { found = { ...v, category: cat }; break; }
    } catch (e) {
      errors.push(`${cat}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
    }
  }

  if (!found) {
    console.error('[ct-vix-capture] VIX not found in get_futures_indices. Errors:', errors);
    return new Response(JSON.stringify({
      error: 'VIX unavailable via get_futures_indices',
      categories_tried: categoriesToTry,
      errors,
    }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const nowIso = new Date().toISOString();
  const today  = nowIso.slice(0, 10);

  const { data: prior } = await supabase
    .from('ct_vix_history')
    .select('date, level')
    .lt('date', today)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  const prevClose = (prior as { level?: number } | null)?.level ?? null;

  const { error: upsertErr } = await supabase
    .from('ct_vix_history')
    .upsert({
      date: today,
      level: +found.level.toFixed(4),
      prev_close: prevClose != null ? +Number(prevClose).toFixed(4) : null,
      source: 'VIX',
      endpoint: `mcp:get_futures_indices[${found.category}]`,
    }, { onConflict: 'date' });

  if (upsertErr) {
    console.error('[ct-vix-capture] upsert failed:', upsertErr.message);
    return new Response(JSON.stringify({ error: upsertErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    ok: true, date: today, level: found.level, change_pct: found.change_pct,
    prev_close: prevClose, category: found.category,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
