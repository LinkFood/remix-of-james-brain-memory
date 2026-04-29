/**
 * ct-prediction-smart-money-ingester — leaderboards from UW MCP.
 *
 * Two MCP calls per run:
 *   get_prediction_whales       → category='whale'
 *   get_prediction_smart_money  → category='smart_money'
 *
 * Both are small leaderboards (< 50 rows each). Daily cron is enough.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { mcpCallToolAsData, setMcpCaller } from '../_shared/uwMcpClient.ts';

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseInt64(v: unknown): number | null {
  const n = parseNum(v); return n == null ? null : Math.round(n);
}

interface Row {
  snapshot_ts: string;
  category: 'whale' | 'smart_money';
  user_id_external: string | null;
  display_name: string | null;
  profit_usd: number | null;
  volume_usd: number | null;
  win_rate: number | null;
  trade_count: number | null;
  rank_position: number | null;
  categories: string[] | null;
  raw: Record<string, unknown>;
}

function normalizeRow(
  obj: Record<string, unknown>,
  category: 'whale' | 'smart_money',
  snapshot: string,
  idx: number,
): Row {
  // UW get_prediction_whales/smart_money returns MARKET POSITIONS, not user
  // profiles. Shape verified via shape-probe 2026-04-23:
  //   { amount, asset_id, avg_price, category, current_price, image, ... }
  // Map asset_id → user_id_external as the anchor (it identifies the position
  // in the unique constraint), stash actual market metrics in volume/profit.
  const assetId    = (obj.asset_id ?? obj.user_id ?? obj.id ?? obj.wallet_id ?? null) as string | null;
  const amount     = parseNum(obj.amount ?? obj.invested_usd ?? obj.size_usd);
  const avgPrice   = parseNum(obj.avg_price);
  const currPrice  = parseNum(obj.current_price);
  // Implied profit: (current - avg) / avg * amount (proxy when no explicit pnl field)
  const impliedProfit = (amount != null && avgPrice != null && currPrice != null && avgPrice > 0)
    ? ((currPrice - avgPrice) / avgPrice) * amount
    : parseNum(obj.profit ?? obj.pnl);

  const marketCategory = (obj.category ?? null) as string | null;
  const categories = marketCategory ? [marketCategory] : null;

  return {
    snapshot_ts: snapshot,
    category,
    user_id_external: assetId,  // asset_id used as the position anchor
    display_name: (obj.question ?? obj.market_name ?? obj.title ?? obj.display_name ?? null) as string | null,
    profit_usd: impliedProfit,
    volume_usd: amount,
    win_rate: null,
    trade_count: null,
    rank_position: idx + 1,
    categories,
    raw: obj,
  };
}

async function fetch(
  tool: string,
  category: 'whale' | 'smart_money',
  snapshot: string,
  args: Record<string, unknown> = {},
): Promise<Row[]> {
  let raw: unknown = null;
  try {
    raw = await mcpCallToolAsData(tool, args);
  } catch (e) {
    console.warn(`[ct-prediction-sm] ${tool} error:`, e instanceof Error ? e.message : e);
    return [];
  }
  const arr: unknown[] = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data))
      ? (raw as { data: unknown[] }).data
      : [];
  const out: Row[] = [];
  arr.forEach((r, i) => {
    if (!r || typeof r !== 'object') return;
    out.push(normalizeRow(r as Record<string, unknown>, category, snapshot, i));
  });
  return out;
}

async function upsert(supabase: SupabaseClient, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  const filtered = rows.filter(r => r.user_id_external); // skip rows with no anchor
  if (filtered.length === 0) return 0;
  const { error, count } = await supabase
    .from('ct_prediction_traders')
    .upsert(filtered, { onConflict: 'snapshot_ts,category,user_id_external', ignoreDuplicates: true, count: 'exact' });
  if (error) {
    console.warn('[ct-prediction-sm] upsert:', error.message);
    return 0;
  }
  return count ?? filtered.length;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  setMcpCaller('ct-prediction-smart-money-ingester');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-prediction-smart-money-ingester', corsHeaders);
  }

  const snapshot = new Date().toISOString();
  const whales = await fetch('get_prediction_whales', 'whale', snapshot);
  const sm     = await fetch('get_prediction_smart_money', 'smart_money', snapshot);
  const wIns = await upsert(supabase, whales);
  const sIns = await upsert(supabase, sm);

  return new Response(JSON.stringify({
    ok: true,
    snapshot,
    whales_seen: whales.length, whales_inserted: wIns,
    smart_money_seen: sm.length, smart_money_inserted: sIns,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
