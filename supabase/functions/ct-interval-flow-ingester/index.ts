/**
 * ct-interval-flow-ingester — UW MCP get_interval_flow per watchlist ticker.
 *
 * UW returns per-option-contract flow rows (NOT minute-bucketed as the tool
 * description suggested). Each row is a contract that saw activity, with
 * fields like option_symbol, strike, volume, bid_side_volume,
 * total_ask_side_volume, avg_price, high/low.
 *
 * We snapshot each MCP response with a run_ts and store all rows — each
 * row is one contract's state at call time.
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
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function parseInt64(v: unknown): number | null {
  const n = parseNum(v);
  return n == null ? null : Math.round(n);
}
function parseDate(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// OCC option symbol: ROOT+YYMMDD+C/P+strikeX1000 (8 digits)
function parseOcc(symbol: string | null | undefined): { side: 'call'|'put'|null; strike: number|null; expiry: string|null } {
  if (!symbol) return { side: null, strike: null, expiry: null };
  const m = symbol.match(/^([A-Z0-9]+?)(\d{6})([CP])(\d{8})$/);
  if (!m) return { side: null, strike: null, expiry: null };
  const [, , exp, cp, strikeStr] = m;
  return {
    side: cp === 'C' ? 'call' : 'put',
    strike: parseInt(strikeStr, 10) / 1000,
    expiry: `20${exp.slice(0,2)}-${exp.slice(2,4)}-${exp.slice(4,6)}`,
  };
}

interface Row {
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

async function fetchForTicker(ticker: string, runTs: string): Promise<Row[]> {
  let raw: unknown = null;
  try {
    raw = await mcpCallToolAsData('get_interval_flow', {
      ticker_symbol: ticker,
      limit: 50,
    });
  } catch (e) {
    console.warn(`[ct-interval-flow] ${ticker}:`, e instanceof Error ? e.message : e);
    return [];
  }

  const arr: unknown[] = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data))
      ? (raw as { data: unknown[] }).data
      : [];

  const out: Row[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const obj = r as Record<string, unknown>;
    const sym = (obj.option_symbol ?? obj.symbol) as string | undefined;
    const { side } = parseOcc(sym);
    const ask = parseInt64(obj.total_ask_side_volume ?? obj.ask_side_volume ?? obj.ask_volume);
    const bid = parseInt64(obj.total_bid_side_volume ?? obj.bid_side_volume ?? obj.bid_volume);
    const askPerc = (ask != null && bid != null && (ask + bid) > 0) ? ask / (ask + bid) : null;
    const bidPerc = (ask != null && bid != null && (ask + bid) > 0) ? bid / (ask + bid) : null;

    // Use runTs as interval_start (UW doesn't provide per-row timestamps).
    // To preserve per-contract granularity within a run, we set side to the
    // option's side (call/put) and let the unique constraint permit both
    // sides per contract per run — but since we have one side per symbol,
    // the unique (ticker, interval_start, side) constraint lets one call and
    // one put per run through. To capture MULTIPLE contracts per side in
    // one run, we'd need a schema change. For now, aggregate by side below.
    out.push({
      ticker,
      interval_start: runTs,
      side,
      premium: parseNum(obj.total_premium ?? obj.premium),
      volume: parseInt64(obj.volume),
      ask_side_volume: ask,
      bid_side_volume: bid,
      ask_side_perc: askPerc,
      bid_side_perc: bidPerc,
      raw: obj,
    });
  }
  return out;
}

/**
 * Aggregate per-contract rows into per-side totals for the run. Unique key
 * is (ticker, interval_start, side) so one row per side per run. We stash
 * the top 5 contracts by premium per side inside `raw.top_contracts` so
 * Claude can cite specific strikes without needing a separate per-contract
 * table.
 */
function aggregateBySide(ticker: string, runTs: string, rows: Row[]): Row[] {
  const buckets = new Map<string, { premium: number; volume: number; ask: number; bid: number; rawSamples: Row[] }>();
  for (const r of rows) {
    const key = r.side ?? 'other';
    const b = buckets.get(key) ?? { premium: 0, volume: 0, ask: 0, bid: 0, rawSamples: [] };
    b.premium += r.premium ?? 0;
    b.volume  += r.volume  ?? 0;
    b.ask     += r.ask_side_volume ?? 0;
    b.bid     += r.bid_side_volume ?? 0;
    b.rawSamples.push(r);
    buckets.set(key, b);
  }
  const out: Row[] = [];
  for (const [side, b] of buckets) {
    const askPerc = (b.ask + b.bid) > 0 ? b.ask / (b.ask + b.bid) : null;
    // Top 5 by premium
    const topByPremium = [...b.rawSamples]
      .filter(s => (s.premium ?? 0) > 0)
      .sort((x, y) => (y.premium ?? 0) - (x.premium ?? 0))
      .slice(0, 5)
      .map(s => {
        const raw = s.raw as Record<string, unknown>;
        const sym = raw.option_symbol ?? raw.symbol;
        const m = sym && typeof sym === 'string' ? sym.match(/^([A-Z0-9]+?)(\d{6})([CP])(\d{8})$/) : null;
        return {
          option_symbol: sym,
          strike: m ? parseInt(m[4], 10) / 1000 : null,
          expiry: m ? `20${m[2].slice(0,2)}-${m[2].slice(2,4)}-${m[2].slice(4,6)}` : null,
          premium: s.premium,
          volume: s.volume,
          ask_side_volume: s.ask_side_volume,
          bid_side_volume: s.bid_side_volume,
        };
      });
    out.push({
      ticker,
      interval_start: runTs,
      side: side === 'other' ? null : side,
      premium: b.premium,
      volume: b.volume,
      ask_side_volume: b.ask,
      bid_side_volume: b.bid,
      ask_side_perc: askPerc,
      bid_side_perc: askPerc != null ? 1 - askPerc : null,
      raw: { contract_count: b.rawSamples.length, top_contracts: topByPremium },
    });
  }
  return out;
}

async function upsert(supabase: SupabaseClient, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { error, count } = await supabase
    .from('ct_interval_flow')
    .upsert(rows, { onConflict: 'ticker,interval_start,side', ignoreDuplicates: true, count: 'exact' });
  if (error) {
    console.warn('[ct-interval-flow] upsert:', error.message);
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

  const started = Date.now();
  const runTs = new Date().toISOString();
  const watchlist = await getWatchlist(supabase);
  const per: Record<string, { contracts: number; rows_inserted: number }> = {};
  let grand = 0;

  for (const t of watchlist) {
    const perContract = await fetchForTicker(t, runTs);
    const aggregated  = aggregateBySide(t, runTs, perContract);
    const inserted    = await upsert(supabase, aggregated);
    per[t] = { contracts: perContract.length, rows_inserted: inserted };
    grand += inserted;
    await new Promise((r) => setTimeout(r, 300));
  }

  return new Response(JSON.stringify({
    ok: true, run_ts: runTs, rows_inserted: grand, elapsed_ms: Date.now() - started, per_ticker: per,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
