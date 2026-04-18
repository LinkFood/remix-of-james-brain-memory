/**
 * ct-technicals-ingester — RSI(14), MACD, VWAP, ATR(14), BBANDS(20) per
 * watchlist ticker.
 *
 * Each indicator is a separate UW call per ticker. We store the latest
 * observation as a scalar `value`, and dump the full series into `raw` for
 * downstream analysis (MACD histograms, BBANDS bands, etc). Every 15 min
 * during RTH weekdays.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getTechnicalIndicator } from '../_shared/uwClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

type Row = {
  ticker: string;
  indicator_name: string;
  period: number | null;
  captured_at: string;
  value: number | null;
  raw: Record<string, unknown>;
};

const INDICATORS: Array<{ name: string; period: number | null }> = [
  { name: 'rsi', period: 14 },
  { name: 'macd', period: null },
  { name: 'vwap', period: null },
  { name: 'atr', period: 14 },
  { name: 'bbands', period: 20 },
];

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pickTimestamp(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + 'T00:00:00Z';
  return null;
}

function extractSeries(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const d = (raw as { data?: unknown }).data;
  if (Array.isArray(d)) return d as Array<Record<string, unknown>>;
  return [];
}

/**
 * Pull the "primary value" out of a UW indicator row. Most indicators expose
 * `value`; MACD uses `macd`, BBANDS uses `middle` (mid-band), etc.
 */
function pickPrimary(indicator: string, row: Record<string, unknown>): number | null {
  const direct = numOrNull(row.value);
  if (direct !== null) return direct;
  switch (indicator) {
    case 'macd': return numOrNull(row.macd ?? row.macd_line);
    case 'bbands': return numOrNull(row.middle ?? row.middle_band ?? row.ma);
    case 'vwap': return numOrNull(row.vwap ?? row.value);
    case 'atr': return numOrNull(row.atr ?? row.value);
    case 'rsi': return numOrNull(row.rsi ?? row.value);
    default: return null;
  }
}

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_technical_indicators?on_conflict=ticker,indicator_name,period,captured_at`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Prefer': 'resolution=ignore-duplicates,return=minimal,count=exact',
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
  const errors: Array<{ ticker: string; indicator: string; error: string }> = [];

  try {
    const watchlist = await getWatchlist(supabase);
    const rows: Row[] = [];

    for (const ticker of watchlist) {
      const upper = ticker.toUpperCase();
      for (const { name, period } of INDICATORS) {
        let raw: unknown = null;
        try {
          const params: Record<string, string | number | boolean> = { interval: '5m' };
          if (period !== null) params.time_period = period;
          raw = await getTechnicalIndicator(upper, name, params);
        } catch (e) {
          errors.push({ ticker: upper, indicator: name, error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        const series = extractSeries(raw);
        if (series.length === 0) continue;
        // Take the last (most recent) observation.
        const latest = series[series.length - 1];
        const captured_at = pickTimestamp(latest.timestamp ?? latest.time ?? latest.date) ?? new Date().toISOString();
        const value = pickPrimary(name, latest);
        rows.push({
          ticker: upper,
          indicator_name: name,
          period,
          captured_at,
          value,
          raw: latest,
        });
      }
    }

    let inserted = 0;
    if (rows.length > 0) {
      const result = await restUpsert(rows);
      if (!result.ok) errors.push({ ticker: 'BATCH', indicator: 'upsert', error: result.error ?? 'unknown' });
      else inserted = result.count;
    }

    return new Response(JSON.stringify({
      success: true,
      rows: rows.length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-technicals-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
