/**
 * ct-central-bank-ingester — global central-bank policy rates via UW MCP.
 *
 * Wave N.2 — new signal stream. MCP tool: `get_central_bank_rates`. Shape
 * returns a list of banks with latest rate + historical series.
 *
 * Cron: daily 09:00 UTC.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { mcpCallToolAsData, setMcpCaller } from '../_shared/uwMcpClient.ts';

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && v.length > 0 ? v : null;
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
  if (d && typeof d === 'object') {
    // Some servers ship { data: { banks: [...] } }
    for (const k of ['banks', 'rates', 'results']) {
      const v = (d as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/** Derive direction trend from recent history array (if present). */
function deriveTrend(history: unknown): string | null {
  if (!Array.isArray(history) || history.length < 2) return null;
  const arr = history as Array<Record<string, unknown>>;
  const sorted = arr
    .map(h => ({ date: pickDate(h.date ?? h.effective_date ?? h.as_of), rate: numOrNull(h.rate) }))
    .filter(h => h.date && h.rate !== null)
    .sort((a, b) => (a.date! > b.date! ? 1 : -1));
  if (sorted.length < 2) return null;
  const last = sorted[sorted.length - 1].rate!;
  const prev = sorted[sorted.length - 2].rate!;
  if (last > prev) return 'hiking';
  if (last < prev) return 'cutting';
  return 'hold';
}

async function restUpsert(rows: Array<Record<string, unknown>>): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_central_bank_rates?on_conflict=capture_date,country_code`,
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
  setMcpCaller('ct-central-bank-ingester');

  const startedAt = Date.now();
  const errors: string[] = [];
  const capture_date = new Date().toISOString().slice(0, 10);

  try {
    let raw: unknown = null;
    try {
      raw = await mcpCallToolAsData('get_central_bank_rates', {});
    } catch (e) {
      errors.push(`mcp: ${e instanceof Error ? e.message : String(e)}`);
    }
    const data = extractData(raw);

    // UW shape (verified 2026-04-18): { name, flag, symbol, interest_rates: [{date, rate}] }
    // We pick the latest rate from interest_rates (sorted desc by date), and
    // derive direction trend from the prev-vs-last delta.
    const rows: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const r of data) {
      const country_code = strOrNull(r.flag ?? r.country_code ?? r.code ?? r.country ?? r.symbol)?.toUpperCase()
        ?? strOrNull(r.bank ?? r.central_bank ?? r.name) ?? 'UNK';
      const key = country_code;
      if (seen.has(key)) continue;
      seen.add(key);

      // Extract latest rate from the interest_rates time series.
      const history = Array.isArray(r.interest_rates) ? r.interest_rates as Array<Record<string, unknown>> : [];
      let latestRate: number | null = null;
      if (history.length > 0) {
        // UW typically returns already-sorted (newest first). Pick the first
        // entry with a rate + date parsable as a number.
        for (const h of history) {
          const rate = numOrNull(h.rate);
          if (rate !== null) { latestRate = rate; break; }
        }
      }
      if (latestRate === null) {
        latestRate = numOrNull(r.rate ?? r.latest_rate ?? r.policy_rate);
      }

      rows.push({
        capture_date,
        country_code,
        rate: latestRate,
        direction_trend: strOrNull(r.direction ?? r.trend) ?? deriveTrend(history.length > 0 ? history : (r.history ?? r.historical)),
        next_meeting_date: pickDate(r.next_meeting_date ?? r.next_meeting),
        expected_move_bps: numOrNull(r.expected_move_bps ?? r.expected_bps),
        raw: r,
        ingested_at: new Date().toISOString(),
      });
    }

    let inserted = 0;
    if (rows.length > 0) {
      const result = await restUpsert(rows);
      if (!result.ok) errors.push(`upsert: ${result.error}`);
      else inserted = result.count;
    }

    return new Response(JSON.stringify({
      success: true,
      capture_date,
      banks_seen: data.length,
      rows: rows.length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-central-bank-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
