/**
 * ct-short-interest-ingester — per-watchlist short interest + short-volume
 * ratio.
 *
 * Two UW endpoints per ticker (verified 2026-04-18):
 *   - /api/shorts/{ticker}/interest-float/v2     — single row: SI, DTC, si_float, total_float, market_date
 *   - /api/shorts/{ticker}/volume-and-ratio      — daily time series: market_date, short_volume_ratio
 *
 * We pull the one interest row + the most recent volume observation. Dedup on
 * (ticker, report_date). Daily 08:00 UTC.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getShortInterestFloat, getShortVolumeRatio } from '../_shared/uwClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

type Row = {
  ticker: string;
  report_date: string;
  short_interest_shares: number | null;
  short_interest_pct_float: number | null;
  days_to_cover: number | null;
  short_volume_ratio_recent: number | null;
  raw: Record<string, unknown>;
};

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pickDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

function extractData(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const d = (raw as { data?: unknown }).data;
  if (Array.isArray(d)) return d as Array<Record<string, unknown>>;
  if (d && typeof d === 'object' && !Array.isArray(d)) return [d as Record<string, unknown>];
  return [];
}

function latestRow(rows: Array<Record<string, unknown>>): Record<string, unknown> | null {
  if (rows.length === 0) return null;
  // Sort by any date-ish field descending, return the first that has one.
  const withDate = rows
    .map((r) => ({ r, d: pickDate(r.report_date ?? r.date ?? r.settlement_date ?? r.as_of) }))
    .filter((x) => x.d !== null)
    .sort((a, b) => (b.d! > a.d! ? 1 : -1));
  return withDate[0]?.r ?? rows[0];
}

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_short_interest?on_conflict=ticker,report_date`,
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
  const errors: Array<{ ticker: string; endpoint: string; error: string }> = [];

  try {
    const watchlist = await getWatchlist(supabase);
    const rows: Row[] = [];

    for (const ticker of watchlist) {
      const upper = ticker.toUpperCase();
      let interestRaw: unknown = null;
      let volumeRaw: unknown = null;
      try { interestRaw = await getShortInterestFloat(upper); }
      catch (e) { errors.push({ ticker: upper, endpoint: 'interest-float/v2', error: e instanceof Error ? e.message : String(e) }); }
      try { volumeRaw = await getShortVolumeRatio(upper); }
      catch (e) { errors.push({ ticker: upper, endpoint: 'volume-and-ratio', error: e instanceof Error ? e.message : String(e) }); }

      // interest-float/v2 returns a single object in `data` (extractData
      // normalizes it to a 1-element array). volume-and-ratio returns a time
      // series — we take the most recent.
      const interest = extractData(interestRaw)[0] ?? null;
      const volume = latestRow(extractData(volumeRaw));
      if (!interest && !volume) continue;

      const report_date =
        pickDate(interest?.market_date ?? interest?.report_date ?? interest?.date ?? interest?.settlement_date ?? interest?.as_of)
        ?? pickDate(volume?.market_date ?? volume?.date ?? volume?.report_date)
        ?? new Date().toISOString().slice(0, 10);

      // UW v2 payload: short_interest (integer), si_float (string decimal as
      // FRACTION not percent — e.g. 0.017 = 1.7%), days_to_cover (string),
      // total_float (integer).
      const siFloatFrac = numOrNull(interest?.si_float);
      rows.push({
        ticker: upper,
        report_date,
        short_interest_shares: numOrNull(interest?.short_interest ?? interest?.shares_short ?? interest?.short_shares),
        short_interest_pct_float: siFloatFrac !== null ? siFloatFrac * 100 : null,
        days_to_cover: numOrNull(interest?.days_to_cover ?? interest?.dtc ?? interest?.short_ratio),
        short_volume_ratio_recent: numOrNull(volume?.short_volume_ratio ?? volume?.ratio ?? volume?.short_vol_ratio),
        raw: { interest: interest ?? null, volume: volume ?? null },
      });
    }

    let inserted = 0;
    if (rows.length > 0) {
      const result = await restUpsert(rows);
      if (!result.ok) errors.push({ ticker: 'BATCH', endpoint: 'upsert', error: result.error ?? 'unknown' });
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
    console.error('[ct-short-interest-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
