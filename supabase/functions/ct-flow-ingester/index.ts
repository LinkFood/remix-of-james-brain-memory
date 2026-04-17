/**
 * ct-flow-ingester — the product-defining data we missed.
 *
 * Pulls market-wide unusual options flow + dark pool prints + (optionally)
 * per-ticker net premium ticks. Deduplicates via alert_id / print_id to
 * avoid re-ingesting the same event across polls.
 *
 * Cron: every 3 min during market hours (aggressive cadence — flow is
 * event-driven, freshness is the point).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getFlowAlerts, getDarkPoolRecent, getDarkPool, getNetPremiumTicks, WATCHLIST } from '../_shared/uwClient.ts';

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return null;
}

async function ingestFlowAlerts(supabase: SupabaseClient): Promise<{ seen: number; inserted: number }> {
  try {
    const raw = await getFlowAlerts({ limit: 100 });
    const data = (raw && typeof raw === 'object') ? (raw as { data?: unknown }).data : null;
    if (!Array.isArray(data) || data.length === 0) return { seen: 0, inserted: 0 };

    const rows = (data as Array<Record<string, unknown>>).map((r) => ({
      alert_id: (r.id as string | undefined) ?? (r.alert_id as string | undefined) ?? `${r.ticker_symbol}-${r.executed_at ?? r.timestamp ?? ''}-${r.option_symbol ?? ''}`,
      ticker: (r.ticker_symbol as string | undefined) ?? (r.ticker as string | undefined) ?? 'UNKNOWN',
      option_symbol: (r.option_symbol as string | undefined) ?? null,
      strike: numOrNull(r.strike),
      expiry: (r.expiry as string | undefined) ?? (r.expiration as string | undefined) ?? null,
      side: (r.type as string | undefined) ?? (r.side as string | undefined) ?? null,
      is_ask: boolOrNull(r.is_ask_side ?? r.is_ask),
      is_bid: boolOrNull(r.is_bid_side ?? r.is_bid),
      is_otm: boolOrNull(r.is_otm),
      size: numOrNull(r.size ?? r.total_size),
      volume: numOrNull(r.volume ?? r.total_volume),
      open_interest: numOrNull(r.open_interest),
      size_gt_oi: boolOrNull(r.size_greater_oi ?? r.size_gt_oi),
      premium: numOrNull(r.premium ?? r.total_premium),
      price: numOrNull(r.price),
      underlying_price: numOrNull(r.underlying_price),
      executed_at: (r.executed_at as string | undefined) ?? (r.timestamp as string | undefined) ?? null,
      alert_type: (r.alert_type as string | undefined) ?? (r.type as string | undefined) ?? null,
      raw: r,
    }));

    const { error, count } = await supabase
      .from('ct_flow_alerts')
      .upsert(rows, { onConflict: 'alert_id', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn('[ct-flow] flow upsert failed:', error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn('[ct-flow] flow-alerts pull failed:', e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

async function ingestDarkPool(
  supabase: SupabaseClient,
  ticker: string | null,
): Promise<{ seen: number; inserted: number }> {
  try {
    const raw = ticker ? await getDarkPool(ticker) : await getDarkPoolRecent();
    const data = (raw && typeof raw === 'object') ? (raw as { data?: unknown }).data : null;
    if (!Array.isArray(data) || data.length === 0) return { seen: 0, inserted: 0 };

    const rows = (data as Array<Record<string, unknown>>).map((r) => ({
      print_id: (r.id as string | undefined) ?? (r.tracking_id as string | undefined) ?? `${r.ticker ?? ticker}-${r.executed_at ?? r.timestamp ?? ''}-${r.size ?? ''}-${r.price ?? ''}`,
      ticker: (r.ticker as string | undefined) ?? ticker ?? 'UNKNOWN',
      size: numOrNull(r.size) ?? 0,
      price: numOrNull(r.price) ?? 0,
      volume: numOrNull(r.volume),
      sale_code: (r.sale_code as string | undefined) ?? null,
      exchange: (r.exchange as string | undefined) ?? null,
      market_center: (r.market_center as string | undefined) ?? null,
      executed_at: (r.executed_at as string | undefined) ?? (r.timestamp as string | undefined) ?? null,
      raw: r,
    }));

    const { error, count } = await supabase
      .from('ct_dark_pool_prints')
      .upsert(rows, { onConflict: 'print_id', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn(`[ct-flow] dark-pool upsert failed (${ticker ?? 'recent'}):`, error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn(`[ct-flow] dark-pool pull failed (${ticker ?? 'recent'}):`, e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

async function ingestNetPremiumTicks(
  supabase: SupabaseClient,
  ticker: string,
): Promise<{ seen: number; inserted: number }> {
  try {
    const raw = await getNetPremiumTicks(ticker);
    const data = (raw && typeof raw === 'object') ? (raw as { data?: unknown }).data : null;
    if (!Array.isArray(data) || data.length === 0) return { seen: 0, inserted: 0 };

    // UW returns tick-level — take recent tail only to keep ingest tight
    const tail = (data as Array<Record<string, unknown>>).slice(-50);

    const rows = tail.map((r) => ({
      ticker,
      tick_timestamp: (r.timestamp as string | undefined) ?? (r.tick_timestamp as string | undefined) ?? new Date().toISOString(),
      net_call_premium: numOrNull(r.net_call_premium),
      net_put_premium: numOrNull(r.net_put_premium),
      net_call_volume: numOrNull(r.net_call_volume),
      net_put_volume: numOrNull(r.net_put_volume),
      underlying_price: numOrNull(r.underlying_price ?? r.price),
      raw: r,
    })).filter(r => r.tick_timestamp);

    const { error, count } = await supabase
      .from('ct_net_premium_ticks')
      .upsert(rows, { onConflict: 'ticker,tick_timestamp', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn(`[ct-flow] net-prem-ticks upsert failed (${ticker}):`, error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn(`[ct-flow] net-prem-ticks pull failed (${ticker}):`, e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedAt = Date.now();

  try {
    // Market-wide
    const flow = await ingestFlowAlerts(supabase);
    const dpRecent = await ingestDarkPool(supabase, null);

    // Per-ticker dark pool + net premium (every invocation — 24 calls)
    const perTicker: Record<string, { dp: { seen: number; inserted: number }; npt: { seen: number; inserted: number } }> = {};
    for (const ticker of WATCHLIST) {
      perTicker[ticker] = {
        dp: await ingestDarkPool(supabase, ticker),
        npt: await ingestNetPremiumTicks(supabase, ticker),
      };
    }

    const totalDpNew = dpRecent.inserted + Object.values(perTicker).reduce((s, t) => s + t.dp.inserted, 0);
    const totalNptNew = Object.values(perTicker).reduce((s, t) => s + t.npt.inserted, 0);

    return new Response(JSON.stringify({
      success: true,
      flow_alerts: { seen: flow.seen, inserted: flow.inserted },
      dark_pool: { recent_inserted: dpRecent.inserted, per_ticker_inserted: totalDpNew - dpRecent.inserted, total_inserted: totalDpNew },
      net_premium_ticks: { total_inserted: totalNptNew },
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[ct-flow-ingester] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
