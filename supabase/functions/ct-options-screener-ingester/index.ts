/**
 * ct-options-screener-ingester — UW MCP get_options_screener.
 *
 * Two slices per run:
 *   1. watchlist_focused — comma-separated watchlist, limit 100
 *   2. market_wide — all tickers, volume>oi filter, limit 50 — catches
 *      unusual non-watchlist setups so /edge can learn what UW's screener
 *      thinks is hot
 *
 * Writes unusual contracts to ct_options_screener_hits. Each row tagged
 * with run_id so we can diff across runs.
 *
 * Scheduled every 30 min during RTH.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { mcpCallToolAsData } from '../_shared/uwMcpClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseInt64(v: unknown): number | null {
  const n = parseNum(v); return n == null ? null : Math.round(n);
}
function parseDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

interface Row {
  run_id: string;
  run_ts: string;
  ticker: string | null;
  option_symbol: string | null;
  type: string | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  volume: number | null;
  open_interest: number | null;
  vol_oi_ratio: number | null;
  premium: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  ask_side_perc: number | null;
  bid_side_perc: number | null;
  sweep_vol_ratio: number | null;
  preset: string | null;
  filter_slice: string;
  raw: Record<string, unknown>;
}

function normalizeRow(
  obj: Record<string, unknown>,
  runId: string,
  runTs: string,
  slice: string,
): Row | null {
  const option_symbol = (obj.option_symbol ?? obj.symbol) as string | undefined;
  const ticker = (obj.ticker_symbol ?? obj.ticker ?? obj.underlying ?? null) as string | null;
  if (!option_symbol && !ticker) return null;

  const vol = parseInt64(obj.volume ?? obj.total_volume);
  const oi  = parseInt64(obj.open_interest);
  const ratio = parseNum(obj.volume_oi_ratio ?? obj.vol_oi_ratio)
    ?? (vol != null && oi != null && oi > 0 ? vol / oi : null);

  return {
    run_id: runId,
    run_ts: runTs,
    ticker: ticker ? String(ticker).toUpperCase() : null,
    option_symbol: option_symbol ?? null,
    type: (obj.type ?? obj.option_type ?? null) as string | null,
    strike: parseNum(obj.strike),
    expiry: parseDate(obj.expiry ?? obj.expiration),
    dte: parseInt64(obj.dte ?? obj.days_to_expiry),
    volume: vol,
    open_interest: oi,
    vol_oi_ratio: ratio,
    premium: parseNum(obj.premium ?? obj.total_premium),
    iv: parseNum(obj.iv ?? obj.implied_volatility),
    delta: parseNum(obj.delta),
    gamma: parseNum(obj.gamma),
    theta: parseNum(obj.theta),
    vega: parseNum(obj.vega),
    ask_side_perc: parseNum(obj.ask_side_perc),
    bid_side_perc: parseNum(obj.bid_side_perc),
    sweep_vol_ratio: parseNum(obj.sweep_volume_ratio ?? obj.sweep_vol_ratio),
    preset: (obj.preset ?? null) as string | null,
    filter_slice: slice,
    raw: obj,
  };
}

async function runScreener(
  args: Record<string, unknown>,
  runId: string,
  runTs: string,
  slice: string,
): Promise<Row[]> {
  let raw: unknown = null;
  try {
    raw = await mcpCallToolAsData('get_options_screener', args);
  } catch (e) {
    console.warn(`[ct-options-screener] ${slice} mcp error:`, e instanceof Error ? e.message : e);
    return [];
  }
  const arr: unknown[] = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data))
      ? (raw as { data: unknown[] }).data
      : [];
  const out: Row[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const row = normalizeRow(r as Record<string, unknown>, runId, runTs, slice);
    if (row) out.push(row);
  }
  return out;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
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
    return killSwitchSkipResponse(supabase, 'ct-options-screener-ingester', corsHeaders);
  }

  const startedAt = Date.now();
  const runId = crypto.randomUUID();
  const runTs = new Date().toISOString();
  const watchlist = await getWatchlist(supabase);

  // Slice 1: watchlist-focused
  const watchlistArg = watchlist.join(',');
  const watchlistHits = await runScreener(
    { ticker_symbol: watchlistArg, vol_greater_oi: true, limit: 100 },
    runId, runTs, 'watchlist_focused',
  );

  // Slice 2: market-wide unusual (volume > OI, min $100k premium)
  const marketHits = await runScreener(
    { vol_greater_oi: true, min_premium: '100000', limit: 50, hide_index_etf: false },
    runId, runTs, 'market_wide',
  );

  const all = [...watchlistHits, ...marketHits];
  let inserted = 0;
  if (all.length > 0) {
    const chunk = 500;
    for (let i = 0; i < all.length; i += chunk) {
      const batch = all.slice(i, i + chunk);
      const { error } = await supabase
        .from('ct_options_screener_hits')
        .upsert(batch, { onConflict: 'run_id,option_symbol', ignoreDuplicates: true });
      if (error) {
        console.warn('[ct-options-screener] upsert:', error.message);
      } else {
        inserted += batch.length;
      }
    }
  }

  return new Response(JSON.stringify({
    ok: true, run_id: runId,
    watchlist_hits: watchlistHits.length,
    market_hits: marketHits.length,
    inserted,
    elapsed_ms: Date.now() - startedAt,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
