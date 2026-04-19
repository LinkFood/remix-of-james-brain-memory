/**
 * ct-sector-tide-ingester — sector-level net call/put premium (5-min cadence).
 *
 * UW's sector tide is per-sector, not market-wide. `getSectorTide()` loops
 * the 11 UW sectors against `/api/market/{sector}/sector-tide` and returns
 * { per_sector: { [sector]: raw }, errors: [...] }. We flatten the time series
 * rows and upsert on (sector, captured_at). Runs every 5 min during RTH
 * weekdays.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getSectorTide } from '../_shared/uwClient.ts';

type Row = {
  sector: string;
  captured_at: string;
  net_call_premium: number | null;
  net_put_premium: number | null;
  net_delta: number | null;
  net_vega: number | null;
  raw: Record<string, unknown>;
};

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pickTimestamp(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  // ISO timestamp (second or higher precision) — accept as-is.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + 'T00:00:00Z';
  return null;
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
      `${supabaseUrl}/rest/v1/ct_sector_tide?on_conflict=sector,captured_at`,
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

  const startedAt = Date.now();
  const errors: string[] = [];

  try {
    let bundle: { per_sector: Record<string, unknown>; errors: Array<{ sector: string; error: string }> } = { per_sector: {}, errors: [] };
    try {
      bundle = await getSectorTide();
    } catch (e) {
      errors.push(`uw: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const { sector, error } of bundle.errors) {
      errors.push(`${sector}: ${error}`);
    }

    // Flatten {sector -> raw} into rows. Each raw is a Daily Market Tide shape:
    // { data: [{ timestamp, net_call_premium, net_put_premium, ... }] }.
    const rows: Row[] = [];
    const seen = new Set<string>();
    let totalSeen = 0;
    for (const [sector, raw] of Object.entries(bundle.per_sector)) {
      const data = extractData(raw);
      totalSeen += data.length;
      for (const r of data) {
        const captured_at = pickTimestamp(r.timestamp ?? r.captured_at ?? r.time ?? r.date);
        if (!captured_at) continue;
        const key = `${sector}|${captured_at}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          sector,
          captured_at,
          net_call_premium: numOrNull(r.net_call_premium ?? r.call_premium ?? r.net_calls),
          net_put_premium: numOrNull(r.net_put_premium ?? r.put_premium ?? r.net_puts),
          net_delta: numOrNull(r.net_delta ?? r.delta),
          net_vega: numOrNull(r.net_vega ?? r.vega),
          raw: r,
        });
      }
    }

    let inserted = 0;
    if (rows.length > 0) {
      const result = await restUpsert(rows);
      if (!result.ok) errors.push(`upsert: ${result.error}`);
      else inserted = result.count;
    }

    return new Response(JSON.stringify({
      success: true,
      sectors: Object.keys(bundle.per_sector).length,
      seen: totalSeen,
      rows: rows.length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-sector-tide-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
