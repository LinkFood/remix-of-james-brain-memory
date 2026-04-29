/**
 * ct-institutional-ingester — 13F institutional holdings per watchlist ticker.
 *
 * Wave N.2 — new signal stream. MCP tool: `get_institutions` (who owns
 * this ticker) then `get_institution_holdings` (per-institution ticker list
 * with shares / value / QoQ change).
 *
 * Cron: weekly Sunday 22:00 UTC. 13Fs file quarterly but we ingest weekly
 * to catch amendments.
 *
 * Strategy: for each watchlist ticker, call `get_institutions` with the
 * ticker to pull the top-N holders. That tool returns (institution,
 * shares, value, pct_of_holdings, change_qoq, filing_date) in one shot,
 * which is exactly what we need — no need for the second detail call in
 * the hot path.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { mcpCallToolAsData, setMcpCaller } from '../_shared/uwMcpClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

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
    for (const k of ['institutions', 'holders', 'results', 'items']) {
      const v = (d as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

type Row = {
  ticker: string;
  institution_name: string | null;
  institution_id: string;
  shares_held: number | null;
  value_usd: number | null;
  pct_of_holdings: number | null;
  change_qoq: number | null;
  filing_date: string | null;
  ingested_at: string;
  raw: Record<string, unknown>;
};

function buildInstitutionId(r: Record<string, unknown>): string | null {
  // UW's get_institutions returns CIK strings like "0000102909". Prefer it.
  const id = r.cik ?? r.institution_id ?? r.id;
  if (typeof id === 'string' && id.length > 0) return id;
  if (typeof id === 'number') return String(id);
  const name = strOrNull(r.institution_name ?? r.name ?? r.institution ?? r.short_name);
  if (!name) return null;
  // Deterministic synthetic id when UW doesn't ship one.
  return `name:${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_institutional_holdings?on_conflict=ticker,institution_id,filing_date`,
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
  setMcpCaller('ct-institutional-ingester');

  const supabase: SupabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();
  const errors: Array<{ ticker: string; error: string }> = [];
  const ingested_at = new Date().toISOString();

  try {
    const watchlist = await getWatchlist(supabase);
    const rows: Row[] = [];

    for (const ticker of watchlist) {
      const upper = ticker.toUpperCase();
      let raw: unknown = null;
      try {
        raw = await mcpCallToolAsData('get_institutions', { ticker: upper, limit: 50 });
      } catch (e) {
        errors.push({ ticker: upper, error: e instanceof Error ? e.message : String(e) });
        continue;
      }
      const data = extractData(raw);
      const seen = new Set<string>();
      for (const r of data) {
        const institution_id = buildInstitutionId(r);
        if (!institution_id) continue;
        // UW sometimes returns multiple filings per institution — take the
        // latest. Dedupe by (institution_id + filing_date) within this ticker's
        // batch to avoid intra-payload conflicts on upsert.
        const filing_date = pickDate(r.filing_date ?? r.as_of ?? r.report_date);
        const dedupeKey = `${institution_id}|${filing_date ?? ''}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        // UW get_institutions field map (verified 2026-04-18):
        //   name → institution_name, short_name
        //   cik → institution_id
        //   units → shares_held (integer)
        //   value → value_usd (dollars)
        //   units_changed → change_qoq (signed share delta)
        //   filing_date, report_date
        // pct_of_holdings comes from inst_value / inst_share_value ratio when
        // UW doesn't ship it directly; we fall back to those fields.
        const units = numOrNull(r.units ?? r.shares_held ?? r.shares ?? r.total_shares);
        const value = numOrNull(r.value ?? r.value_usd ?? r.market_value);
        let pct = numOrNull(r.pct_of_holdings ?? r.portfolio_weight ?? r.pct);
        if (pct === null) {
          const instValue = numOrNull(r.inst_value);
          const instShare = numOrNull(r.inst_share_value);
          if (value !== null && instValue !== null && instValue > 0) pct = (value / instValue) * 100;
          else if (units !== null && instShare !== null && instShare > 0) pct = (units / instShare) * 100;
        }
        rows.push({
          ticker: upper,
          institution_name: strOrNull(r.name ?? r.institution_name ?? r.institution ?? r.short_name),
          institution_id,
          shares_held: units,
          value_usd: value,
          pct_of_holdings: pct,
          change_qoq: numOrNull(r.units_changed ?? r.change_qoq ?? r.shares_change ?? r.change),
          filing_date,
          ingested_at,
          raw: r,
        });
      }
    }

    let inserted = 0;
    if (rows.length > 0) {
      // Filter out rows with null filing_date before upsert — the unique key
      // includes filing_date, and ignore-duplicates on NULL is unreliable in
      // PostgREST. We keep the row but require a date.
      const withDate = rows.filter(r => r.filing_date !== null);
      if (withDate.length > 0) {
        const result = await restUpsert(withDate);
        if (!result.ok) errors.push({ ticker: 'BATCH', error: result.error ?? 'unknown' });
        else inserted = result.count;
      }
    }

    return new Response(JSON.stringify({
      success: true,
      watchlist: watchlist.length,
      rows: rows.length,
      rows_with_filing_date: rows.filter(r => r.filing_date !== null).length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-institutional-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
