/**
 * ct-seasonality-ingester — monthly seasonality stats per watchlist ticker.
 *
 * Wave N.2 — new signal stream. MCP tool: `get_seasonality_month` returns
 * cross-sectional ranked seasonality rows for a specific month. We loop the
 * 12 months of the year and store (ticker, month_int, avg_return, win_rate,
 * sample_size).
 *
 * Cron: weekly Sunday 22:00 UTC — seasonality doesn't change fast.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { mcpCallToolAsData } from '../_shared/uwMcpClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
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
    for (const k of ['results', 'seasonality', 'items']) {
      const v = (d as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

type Row = {
  ticker: string;
  month_int: number;
  avg_return_pct: number | null;
  win_rate: number | null;
  sample_size: number | null;
  last_updated: string;
  raw: Record<string, unknown>;
};

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_seasonality?on_conflict=ticker,month_int`,
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

  const supabase: SupabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();
  const errors: Array<{ month: number; error: string }> = [];
  const last_updated = new Date().toISOString();

  try {
    const watchlist = (await getWatchlist(supabase)).map(t => t.toUpperCase());
    const rows: Row[] = [];

    // UW's get_seasonality_month allowed params (verified via MCP probe
    // 2026-04-18): month, ticker_symbol, sectors, watchlist_ids, order,
    // order_direction, has_options, min_years/max_years, min/max_*_change,
    // min/max_marketcap, min/max_positive_closes, min/max_positive_months_perc.
    // No `limit`. We loop month × ticker_symbol.
    for (let month = 1; month <= 12; month++) {
      for (const ticker of watchlist) {
        let raw: unknown = null;
        try {
          raw = await mcpCallToolAsData('get_seasonality_month', {
            month,
            ticker_symbol: ticker,
          });
        } catch (e) {
          errors.push({ month, error: `${ticker}: ${e instanceof Error ? e.message : String(e)}` });
          continue;
        }
        const data = extractData(raw);
        // Response may be a single row (per-ticker) or multiple. Take first
        // row that matches our ticker.
        for (const r of data) {
          const rt = strOrNull(r.ticker ?? r.ticker_symbol ?? r.symbol)?.toUpperCase();
          if (rt && rt !== ticker) continue;
          rows.push({
            ticker,
            month_int: month,
            avg_return_pct: numOrNull(r.avg_change ?? r.avg_return ?? r.avg_return_pct ?? r.average_return ?? r.mean_return ?? r.median_change),
            win_rate: numOrNull(r.positive_months_perc ?? r.positive_closes ?? r.win_rate ?? r.positive_rate ?? r.win_pct),
            sample_size: intOrNull(r.years ?? r.sample_size ?? r.count ?? r.n),
            last_updated,
            raw: r,
          });
          break; // one row per (ticker, month)
        }
      }
    }

    let inserted = 0;
    if (rows.length > 0) {
      const result = await restUpsert(rows);
      if (!result.ok) errors.push({ month: -1, error: result.error ?? 'unknown' });
      else inserted = result.count;
    }

    return new Response(JSON.stringify({
      success: true,
      watchlist_size: watchlist.size,
      rows: rows.length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-seasonality-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
