/**
 * ct-insider-ingester — form-4 insider transactions for watchlist tickers.
 *
 * Pulls UW `/api/insider/transactions`, filters to the active watchlist, upserts
 * deduped on transaction_id. Daily 07:00 UTC (pre-open) — insider filings are
 * low-cadence, no reason to poll faster.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getInsiderTransactions } from '../_shared/uwClient.ts';
import { mcpCallToolAsData, isUwRateLimit } from '../_shared/uwMcpClient.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

type Row = {
  transaction_id: string;
  filing_date: string | null;
  trade_date: string | null;
  ticker: string;
  insider_name: string | null;
  insider_title: string | null;
  transaction_type: string | null;
  shares: number | null;
  price: number | null;
  value_usd: number | null;
  ownership_type: string | null;
  raw: Record<string, unknown>;
};

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
  return Array.isArray(d) ? (d as Array<Record<string, unknown>>) : [];
}

function buildId(r: Record<string, unknown>): string | null {
  // Prefer UW-supplied id; else fabricate one from stable fields.
  const id = r.transaction_id ?? r.id ?? r.filing_id;
  if (typeof id === 'string' && id.length > 0) return id;
  const ticker = strOrNull(r.ticker ?? r.symbol) ?? 'UNK';
  const date = pickDate(r.filing_date) ?? pickDate(r.trade_date) ?? pickDate(r.reported_at) ?? '';
  const who = strOrNull(r.insider_name ?? r.reporting_name) ?? '';
  const shares = r.shares ?? r.quantity ?? '';
  if (!date || !who) return null;
  return `${ticker}|${date}|${who}|${shares}`;
}

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_insider_trades?on_conflict=transaction_id`,
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
  const errors: string[] = [];

  try {
    const watchlist = new Set((await getWatchlist(supabase)).map((t) => t.toUpperCase()));

    // Wave N.2 — prefer UW MCP (`get_insider_trades`). Fall back to legacy
    // REST on any MCP failure. Legacy path deletes 7 days after MCP proves
    // itself in production.
    let raw: unknown = null;
    let path: 'mcp' | 'legacy' = 'mcp';
    try {
      raw = await mcpCallToolAsData('get_insider_trades', { limit: 500 });
    } catch (mcpErr) {
      if (isUwRateLimit(mcpErr)) {
        // Shared bucket — don't burn a legacy REST call on a saturated bucket.
        errors.push(`mcp_rate_limited`);
        path = 'legacy';
        raw = null;
      } else {
        const msg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
        await recordDecision(supabase, {
          decision_type: 'stress_check',
          model_tier: 'none',
          reasoning: `MCP fallback on ct-insider-ingester: ${msg.slice(0, 400)}`,
        });
        path = 'legacy';
        try {
          raw = await getInsiderTransactions();
        } catch (e) {
          errors.push(`uw: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const data = extractData(raw);

    const rows: Row[] = [];
    const seenIds = new Set<string>();
    for (const r of data) {
      const ticker = strOrNull(r.ticker ?? r.symbol);
      if (!ticker || !watchlist.has(ticker.toUpperCase())) continue;
      const id = buildId(r);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      rows.push({
        transaction_id: id,
        filing_date: pickDate(r.filing_date ?? r.reported_at),
        trade_date: pickDate(r.trade_date ?? r.transaction_date ?? r.date),
        ticker: ticker.toUpperCase(),
        insider_name: strOrNull(r.insider_name ?? r.reporting_name ?? r.name),
        insider_title: strOrNull(r.insider_title ?? r.title ?? r.reporting_title),
        transaction_type: strOrNull(r.transaction_type ?? r.transaction_code ?? r.type),
        shares: numOrNull(r.shares ?? r.quantity),
        price: numOrNull(r.price ?? r.transaction_price),
        value_usd: numOrNull(r.value_usd ?? r.transaction_value ?? r.value),
        ownership_type: strOrNull(r.ownership_type ?? r.ownership),
        raw: r,
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
      path,
      seen: data.length,
      watchlist_filtered: rows.length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-insider-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
