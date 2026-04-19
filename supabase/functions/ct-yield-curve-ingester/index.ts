/**
 * ct-yield-curve-ingester — U.S. Treasury yield curve snapshot via UW MCP.
 *
 * Wave N.2 — new signal stream. No legacy path; MCP direct from day 1.
 *
 * MCP tool: `get_yield_curve` — returns the latest curve snapshot. Shape
 * (observed & spec): { data: [{ date, <TENOR>: rate, ... }] } OR an object
 * keyed by date. We normalize to one row per capture_date with a tenors jsonb
 * blob, plus a derived `is_inverted` bool and 10y-2y spread for quick reads.
 *
 * Cron: daily 09:00 UTC.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { mcpCallToolAsData, UwMcpError } from '../_shared/uwMcpClient.ts';

// UW's MCP get_yield_curve uses `bc_<duration>` keys (verified 2026-04-18):
//   bc_1month, bc_2month, bc_3month, bc_6month, bc_1year, bc_2year,
//   bc_3year, bc_5year, bc_7year, bc_10year, bc_20year, bc_30year.
// We also accept FRED-style variants in case a different server version
// ships them.
const TENOR_KEYS: Array<{ label: string; matches: RegExp }> = [
  { label: '1M',  matches: /^(bc_1month|1m|1_m|m1|one_month)$/i },
  { label: '2M',  matches: /^(bc_2month|2m)$/i },
  { label: '3M',  matches: /^(bc_3month|3m|3_m|m3|three_month)$/i },
  { label: '6M',  matches: /^(bc_6month|6m|6_m|m6|six_month)$/i },
  { label: '1Y',  matches: /^(bc_1year|1y|1_y|y1|one_year)$/i },
  { label: '2Y',  matches: /^(bc_2year|2y|2_y|y2|two_year)$/i },
  { label: '3Y',  matches: /^(bc_3year|3y|3_y|y3|three_year)$/i },
  { label: '5Y',  matches: /^(bc_5year|5y|5_y|y5|five_year)$/i },
  { label: '7Y',  matches: /^(bc_7year|7y|7_y|y7|seven_year)$/i },
  { label: '10Y', matches: /^(bc_10year|10y|10_y|y10|ten_year)$/i },
  { label: '20Y', matches: /^(bc_20year|20y|20_y|y20|twenty_year)$/i },
  { label: '30Y', matches: /^(bc_30year|30y|30_y|y30|thirty_year)$/i },
];

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

/** Flatten any MCP payload shape into a single (date, tenors) snapshot. */
function normalizeSnapshot(raw: unknown): { capture_date: string; tenors: Record<string, number> } | null {
  // Shape A: { data: [{ date, 2Y, 10Y, ... }] }
  const data = (raw && typeof raw === 'object') ? (raw as { data?: unknown }).data : raw;
  let record: Record<string, unknown> | null = null;
  if (Array.isArray(data) && data.length > 0) {
    record = data[0] as Record<string, unknown>;
  } else if (data && typeof data === 'object' && !Array.isArray(data)) {
    record = data as Record<string, unknown>;
  }
  if (!record) return null;

  const capture_date = pickDate(record.new_date ?? record.date ?? record.as_of ?? record.capture_date ?? record.market_date) ?? new Date().toISOString().slice(0, 10);
  const tenors: Record<string, number> = {};
  for (const [k, v] of Object.entries(record)) {
    for (const { label, matches } of TENOR_KEYS) {
      if (matches.test(k)) {
        const n = numOrNull(v);
        if (n !== null) tenors[label] = n;
      }
    }
  }
  if (Object.keys(tenors).length === 0) return null;
  return { capture_date, tenors };
}

async function restUpsert(row: Record<string, unknown>): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_yield_curve?on_conflict=capture_date`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': serviceKey,
          'Authorization': `Bearer ${serviceKey}`,
          'Prefer': 'resolution=merge-duplicates,return=minimal,count=exact',
        },
        body: JSON.stringify([row]),
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
    let raw: unknown = null;
    try {
      raw = await mcpCallToolAsData('get_yield_curve', {});
    } catch (e) {
      errors.push(`mcp: ${e instanceof UwMcpError ? e.message : (e instanceof Error ? e.message : String(e))}`);
    }

    const snap = normalizeSnapshot(raw);
    if (!snap) {
      return new Response(JSON.stringify({
        success: false,
        inserted: 0,
        errors: errors.length ? errors : ['no tenor data in MCP payload'],
        duration_ms: Date.now() - startedAt,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const two = snap.tenors['2Y'] ?? null;
    const ten = snap.tenors['10Y'] ?? null;
    const spread_10y_2y = (ten !== null && two !== null) ? ten - two : null;
    const is_inverted = spread_10y_2y !== null ? spread_10y_2y < 0 : null;

    const row = {
      capture_date: snap.capture_date,
      tenors: snap.tenors,
      is_inverted,
      spread_10y_2y,
      ingested_at: new Date().toISOString(),
    };

    const result = await restUpsert(row);
    if (!result.ok) errors.push(`upsert: ${result.error}`);

    return new Response(JSON.stringify({
      success: true,
      capture_date: snap.capture_date,
      tenor_count: Object.keys(snap.tenors).length,
      spread_10y_2y,
      is_inverted,
      inserted: result.count,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-yield-curve-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
