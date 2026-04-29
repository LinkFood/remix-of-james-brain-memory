/**
 * ct-correlations-ingester — pair correlations across the watchlist via UW MCP.
 *
 * Wave N.2 — new signal stream. MCP tool: `get_correlations`. For each seed
 * ticker on the watchlist we ask UW for its most-correlated peers at 20d and
 * 60d windows. We then upsert each (ticker_a, ticker_b, window) row for the
 * current date.
 *
 * Cron: daily 09:00 UTC.
 *
 * NOTE: UW may cap results per seed. We request liberally (top 25) and let
 * the DB dedupe on (as_of_date, ticker_a, ticker_b, window_days).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { mcpCallToolAsData, setMcpCaller } from '../_shared/uwMcpClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

// UW's get_correlations does NOT accept a window_days param (verified via
// MCP probe 2026-04-18 — allowed_params: ["limit","order_direction","sectors","tickers"]).
// We store window_days=0 as a sentinel meaning "UW default lookback" so
// the composite unique key still works.
const UW_DEFAULT_WINDOW_SENTINEL = 0;

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function extractData(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const d = (raw as { data?: unknown }).data;
  if (Array.isArray(d)) return d as Array<Record<string, unknown>>;
  if (d && typeof d === 'object') {
    for (const k of ['pairs', 'correlations', 'results']) {
      const v = (d as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

type Row = {
  as_of_date: string;
  ticker_a: string;
  ticker_b: string;
  window_days: number;
  correlation: number | null;
  ingested_at: string;
  raw: Record<string, unknown>;
};

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_correlations?on_conflict=as_of_date,ticker_a,ticker_b,window_days`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal,count=exact',
        },
        body: JSON.stringify(rows),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, count: 0, error: `${res.status} ${body.slice(0, 200)}` };
    }
    const range = res.headers.get('content-range') ?? '';
    const m = range.match(/\/(\d+)$/);
    return { ok: true, count: m ? parseInt(m[1], 10) : 0 };
  } catch (e) {
    return { ok: false, count: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  setMcpCaller('ct-correlations-ingester');

  const supabase: SupabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();
  const errors: Array<{ ticker: string; window: number; error: string }> = [];
  const as_of_date = new Date().toISOString().slice(0, 10);

  try {
    const watchlist = await getWatchlist(supabase);
    const allRows: Row[] = [];
    const ingested_at = new Date().toISOString();

    for (const seed of watchlist) {
      const upper = seed.toUpperCase();
      let raw: unknown = null;
      try {
        // UW expects `tickers: [ticker]` (array). No window_days param — UW's
        // default lookback is used.
        // UW expects `tickers` as a comma-separated string (verified via MCP
        // probe 2026-04-18 — passing a JSON array returns
        // "no function clause matching in String.split/3"). Single seed =
        // bare ticker; multiple seeds would be "SPY,QQQ,AAPL".
        raw = await mcpCallToolAsData('get_correlations', {
          tickers: upper,
          limit: 25,
        });
      } catch (e) {
        errors.push({ ticker: upper, window: UW_DEFAULT_WINDOW_SENTINEL, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const data = extractData(raw);
      for (const r of data) {
        // UW returns { ticker_fst, ticker_snd, score, info_fst, info_snd } —
        // verified via ct-mcp-shape-probe 2026-04-19. We also tolerate the
        // older shapes (ticker, ticker_b, symbol, peer / correlation, corr,
        // value) in case UW ships a schema change — tolerance is cheap.
        const fst = strOrNull(r.ticker_fst);
        const snd = strOrNull(r.ticker_snd);
        // If UW gave us (fst, snd) use them directly; fst is the seed we
        // queried with, snd is the peer. Otherwise fall back to the single-
        // ticker shapes.
        let other: string | null;
        if (fst && snd) {
          other = fst.toUpperCase() === upper ? snd : fst;
        } else {
          other = strOrNull(r.ticker ?? r.ticker_b ?? r.symbol ?? r.peer);
        }
        if (!other) continue;
        const otherUpper = other.toUpperCase();
        if (otherUpper === upper) continue;
        // Canonicalize pair so (A,B) and (B,A) dedupe to one row.
        const [a, b] = upper < otherUpper ? [upper, otherUpper] : [otherUpper, upper];
        allRows.push({
          as_of_date,
          ticker_a: a,
          ticker_b: b,
          window_days: UW_DEFAULT_WINDOW_SENTINEL,
          correlation: numOrNull(r.score ?? r.correlation ?? r.corr ?? r.value),
          ingested_at,
          raw: r,
        });
      }
    }

    // Dedupe in-memory (A,B,window) to avoid upsert conflicts within the batch.
    const seen = new Set<string>();
    const deduped: Row[] = [];
    for (const r of allRows) {
      const key = `${r.ticker_a}|${r.ticker_b}|${r.window_days}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }

    let inserted = 0;
    if (deduped.length > 0) {
      const result = await restUpsert(deduped);
      if (!result.ok) errors.push({ ticker: 'BATCH', window: -1, error: result.error ?? 'unknown' });
      else inserted = result.count;
    }

    return new Response(JSON.stringify({
      success: true,
      as_of_date,
      seeds: watchlist.length,
      raw_pairs: allRows.length,
      deduped: deduped.length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-correlations-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
