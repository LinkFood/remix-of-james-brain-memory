/**
 * ct-skew-ingester — 25-delta risk-reversal skew per watchlist ticker.
 *
 * UW `/api/stock/{ticker}/historical-risk-reversal-skew` returns a series of
 * (expiry, 25d-call-IV, 25d-put-IV). We snapshot today's capture and store
 * per (ticker, capture_date, expiry). Daily 09:30 UTC — pre-open, after
 * overnight vol resets.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getRiskReversalSkew, setUwCaller } from '../_shared/uwClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

type Row = {
  ticker: string;
  capture_date: string;
  expiry: string | null;
  delta_25_call_iv: number | null;
  delta_25_put_iv: number | null;
  skew_25d: number | null;
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
  return Array.isArray(d) ? (d as Array<Record<string, unknown>>) : [];
}

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_risk_reversal_skew?on_conflict=ticker,capture_date,expiry`,
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

  setUwCaller('ct-skew-ingester');

  const supabase: SupabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();
  const errors: Array<{ ticker: string; error: string }> = [];
  const capture_date = new Date().toISOString().slice(0, 10);

  try {
    const watchlist = await getWatchlist(supabase);
    const rows: Row[] = [];

    for (const ticker of watchlist) {
      const upper = ticker.toUpperCase();
      let raw: unknown = null;
      try {
        raw = await getRiskReversalSkew(upper);
      } catch (e) {
        errors.push({ ticker: upper, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const data = extractData(raw);

      // UW may ship the latest capture; keep only the most recent date-per-expiry.
      const byExpiry = new Map<string, Record<string, unknown>>();
      for (const r of data) {
        const expiry = pickDate(r.expiry ?? r.expiration);
        const key = expiry ?? 'NULL_EXPIRY';
        const existing = byExpiry.get(key);
        const rDate = pickDate(r.date ?? r.capture_date ?? r.time) ?? '';
        const existingDate = existing ? pickDate(existing.date ?? existing.capture_date ?? existing.time) ?? '' : '';
        if (!existing || rDate > existingDate) byExpiry.set(key, r);
      }

      for (const [key, r] of byExpiry.entries()) {
        const callIv = numOrNull(r.delta_25_call_iv ?? r.call_iv ?? r.iv_call);
        const putIv = numOrNull(r.delta_25_put_iv ?? r.put_iv ?? r.iv_put);
        const skew = numOrNull(r.skew_25d ?? r.skew ?? r.risk_reversal) ?? (callIv !== null && putIv !== null ? callIv - putIv : null);
        rows.push({
          ticker: upper,
          capture_date,
          expiry: key === 'NULL_EXPIRY' ? null : key,
          delta_25_call_iv: callIv,
          delta_25_put_iv: putIv,
          skew_25d: skew,
          raw: r,
        });
      }
    }

    let inserted = 0;
    if (rows.length > 0) {
      const result = await restUpsert(rows);
      if (!result.ok) errors.push({ ticker: 'BATCH', error: result.error ?? 'unknown' });
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
    console.error('[ct-skew-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
