/**
 * ct-interval-flow-ingester — pull UW MCP get_interval_flow for each watchlist
 * ticker, write to ct_interval_flow. Minute-by-minute options activity.
 *
 * Defensive parser: UW payload shapes vary. We accept multiple field names
 * and store the raw row in jsonb so downstream queries can adapt without
 * an ingester rewrite.
 *
 * Scheduled every 15 min during RTH.
 * Auth: service role.
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
  const n = parseNum(v);
  return n == null ? null : Math.round(n);
}

function normalizeSide(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).toLowerCase();
  if (s.startsWith('c')) return 'call';
  if (s.startsWith('p')) return 'put';
  return null;
}

function parseTs(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return null;
}

interface IntervalRow {
  ticker: string;
  interval_start: string;
  side: string | null;
  premium: number | null;
  volume: number | null;
  ask_side_volume: number | null;
  bid_side_volume: number | null;
  ask_side_perc: number | null;
  bid_side_perc: number | null;
  raw: Record<string, unknown>;
}

async function fetchIntervalFlow(ticker: string): Promise<IntervalRow[]> {
  let raw: unknown;
  try {
    raw = await mcpCallToolAsData('get_interval_flow', {
      ticker_symbol: ticker,
      limit: 60,
    });
  } catch (e) {
    console.warn(`[ct-interval-flow] ${ticker} mcp error:`, e instanceof Error ? e.message : e);
    return [];
  }

  const rows: unknown[] = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data))
      ? (raw as { data: unknown[] }).data
      : [];

  const out: IntervalRow[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const obj = r as Record<string, unknown>;

    const ts = parseTs(
      obj.interval_start ??
      obj.start ??
      obj.timestamp ??
      obj.bucket_start ??
      obj.minute ??
      obj.time
    );
    if (!ts) continue;

    const side = normalizeSide(obj.side ?? obj.type ?? obj.option_side);
    const ask  = parseInt64(obj.ask_side_volume ?? obj.ask_volume);
    const bid  = parseInt64(obj.bid_side_volume ?? obj.bid_volume);

    // Prefer UW's perc if provided, else compute from volumes
    let askPerc = parseNum(obj.ask_side_perc ?? obj.ask_perc);
    let bidPerc = parseNum(obj.bid_side_perc ?? obj.bid_perc);
    if (askPerc == null && ask != null && bid != null && (ask + bid) > 0) {
      askPerc = ask / (ask + bid);
    }
    if (bidPerc == null && ask != null && bid != null && (ask + bid) > 0) {
      bidPerc = bid / (ask + bid);
    }

    out.push({
      ticker,
      interval_start: ts,
      side,
      premium:         parseNum(obj.premium ?? obj.total_premium),
      volume:          parseInt64(obj.volume ?? obj.total_volume),
      ask_side_volume: ask,
      bid_side_volume: bid,
      ask_side_perc:   askPerc,
      bid_side_perc:   bidPerc,
      raw: obj,
    });
  }
  return out;
}

async function upsert(supabase: SupabaseClient, rows: IntervalRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { error, count } = await supabase
    .from('ct_interval_flow')
    .upsert(rows, { onConflict: 'ticker,interval_start,side', ignoreDuplicates: true, count: 'exact' });
  if (error) {
    console.warn('[ct-interval-flow] upsert failed:', error.message);
    return 0;
  }
  return count ?? rows.length;
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
    return killSwitchSkipResponse(supabase, 'ct-interval-flow-ingester', corsHeaders);
  }

  const startedAt = Date.now();
  const watchlist = await getWatchlist(supabase);
  const perTicker: Record<string, { seen: number; inserted: number }> = {};
  let grand = 0;

  for (const t of watchlist) {
    const rows = await fetchIntervalFlow(t);
    const inserted = await upsert(supabase, rows);
    perTicker[t] = { seen: rows.length, inserted };
    grand += inserted;
    // Polite pause — UW MCP at 120/min; 12 tickers × 1 call = 12 calls/run
    await new Promise((r) => setTimeout(r, 200));
  }

  return new Response(JSON.stringify({
    ok: true, rows_inserted: grand, elapsed_ms: Date.now() - startedAt, per_ticker: perTicker,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
