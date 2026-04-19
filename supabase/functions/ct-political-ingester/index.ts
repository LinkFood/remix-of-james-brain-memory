/**
 * ct-political-ingester — congress / senate STOCK-Act disclosures.
 *
 * Pulls UW `/api/congress/recent-trades`, upserts on disclosure_id. No watchlist
 * filter — Pelosi picks anywhere are worth knowing. Daily 07:00 UTC.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getCongressTrades } from '../_shared/uwClient.ts';
import { mcpCallToolAsData, isUwRateLimit } from '../_shared/uwMcpClient.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';

type Row = {
  disclosure_id: string;
  traded_at: string | null;
  reported_at: string | null;
  trader_name: string | null;
  chamber: string | null;
  party: string | null;
  ticker: string | null;
  side: string | null;
  amount_band_usd: string | null;
  raw: Record<string, unknown>;
};

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
  const id = r.disclosure_id ?? r.id ?? r.filing_id;
  if (typeof id === 'string' && id.length > 0) return id;
  const who = strOrNull(r.reporter ?? r.trader_name ?? r.name) ?? '';
  const traded = pickDate(r.transaction_date ?? r.traded_at ?? r.trade_date) ?? '';
  const ticker = strOrNull(r.ticker ?? r.symbol) ?? 'UNK';
  const side = strOrNull(r.txn_type ?? r.transaction ?? r.side) ?? '';
  const amt = strOrNull(r.amounts ?? r.amount) ?? '';
  if (!who || !traded) return null;
  return `${who}|${traded}|${ticker}|${side}|${amt}`;
}

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_political_trades?on_conflict=disclosure_id`,
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
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  try {
    // Wave N.2 — prefer UW MCP (`get_congress_trades`). Fall back to legacy
    // REST on any MCP failure.
    let raw: unknown = null;
    let path: 'mcp' | 'legacy' = 'mcp';
    try {
      raw = await mcpCallToolAsData('get_congress_trades', { limit: 500 });
    } catch (mcpErr) {
      if (isUwRateLimit(mcpErr)) {
        errors.push(`mcp_rate_limited`);
        path = 'legacy';
        raw = null;
      } else {
        const msg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
        await recordDecision(supabase, {
          decision_type: 'stress_check',
          model_tier: 'none',
          reasoning: `MCP fallback on ct-political-ingester: ${msg.slice(0, 400)}`,
        });
        path = 'legacy';
        try {
          raw = await getCongressTrades();
        } catch (e) {
          errors.push(`uw: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    const data = extractData(raw);

    const rows: Row[] = [];
    const seenIds = new Set<string>();
    for (const r of data) {
      const id = buildId(r);
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      const ticker = strOrNull(r.ticker ?? r.symbol);
      rows.push({
        disclosure_id: id,
        traded_at: pickDate(r.transaction_date ?? r.traded_at ?? r.trade_date),
        reported_at: pickDate(r.reported_at ?? r.disclosure_date ?? r.filing_date),
        trader_name: strOrNull(r.reporter ?? r.trader_name ?? r.name),
        chamber: strOrNull(r.chamber),
        party: strOrNull(r.party),
        ticker: ticker ? ticker.toUpperCase() : null,
        side: strOrNull(r.txn_type ?? r.transaction ?? r.side),
        amount_band_usd: strOrNull(r.amounts ?? r.amount ?? r.amount_range),
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
      rows: rows.length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-political-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
