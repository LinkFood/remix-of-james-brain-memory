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

  // Try 3 MCP tool paths in priority order:
  //   1. get_ticker_ohlc_latest_or_date(ticker='VIX') — purpose-built per-ticker
  //   2. get_market_state — market-wide snapshot may embed VIX
  //   3. get_futures_indices with a dozen plausible category values
  let found: { level: number; change_pct: number | null; raw: unknown; via: string } | null = null;
  const errors: string[] = [];

  // Attempt 1: direct VIX OHLC
  try {
    const result = await mcpCallTool('get_ticker_ohlc_latest_or_date', { ticker: 'VIX' });
    const data = (result && typeof result === 'object' && 'data' in (result as Record<string, unknown>))
      ? (result as { data: unknown }).data
      : result;
    const row = Array.isArray(data) ? data[0] : data;
    if (row && typeof row === 'object') {
      const r = row as IndexRow;
      const level = parseNum(r.close ?? r.last_price ?? r.price ?? r.level);
      if (level && level > 0) {
        const change = parseNum(r.change_pct) ?? parseNum(r.percent_change);
        found = { level, change_pct: change, raw: r, via: 'get_ticker_ohlc_latest_or_date' };
      }
    }
  } catch (e) {
    errors.push(`ohlc: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
  }

  // Attempt 2: market_state aggregate
  if (!found) {
    try {
      const result = await mcpCallTool('get_market_state', {});
      const data = (result && typeof result === 'object' && 'data' in (result as Record<string, unknown>))
        ? (result as { data: unknown }).data
        : result;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        const r = data as Record<string, unknown>;
        const level = parseNum(r.vix) ?? parseNum(r.vix_level) ?? parseNum(r.vix_close);
        if (level && level > 0) {
          found = { level, change_pct: parseNum(r.vix_change_pct), raw: r, via: 'get_market_state' };
        }
      }
    } catch (e) {
      errors.push(`market_state: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
    }
  }

  // Attempt 3: wide sweep of get_futures_indices categories
  if (!found) {
    const categoriesToTry = [
      'indices', 'index', 'global_indices', 'us_indices', 'volatility',
      'vix', 'futures', 'index_futures', 'all', 'global', 'commodities',
      'equity_indices', 'equities',
    ];
    for (const cat of categoriesToTry) {
      try {
        const result = await mcpCallTool('get_futures_indices', { type: cat });
        const data = (result && typeof result === 'object' && 'data' in (result as Record<string, unknown>))
          ? (result as { data: unknown }).data
          : result;
        const v = findVix(data);
        if (v) { found = { ...v, via: `get_futures_indices[${cat}]` }; break; }
      } catch (e) {
        errors.push(`fi[${cat}]: ${e instanceof Error ? e.message : String(e)}`.slice(0, 100));
      }
    }
  }

  if (!found) {
    console.error('[ct-vix-capture] VIX unavailable via any path. Errors:', errors);
    return new Response(JSON.stringify({
      error: 'VIX unavailable',
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
      endpoint: `mcp:${found.via}`,
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
