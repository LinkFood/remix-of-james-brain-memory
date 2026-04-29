/**
 * ct-prediction-markets-ingester — prediction-market activity via UW MCP.
 *
 * Wave N.2 — new signal stream. Combines four MCP tools:
 *   - get_prediction_smart_money   (profitable traders)
 *   - get_prediction_whales         (large traders)
 *   - get_prediction_insiders       (likely-informed activity)
 *   - get_prediction_unusual_markets (anomalous markets)
 *
 * Each call returns markets with different framings; we key by market_id and
 * merge flags. If the same market is flagged by whales + smart_money + insiders
 * we store all three positions plus an `unusual_flag` bool.
 *
 * Cron: daily 09:00 UTC (pre-market).
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

function extractData(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const d = (raw as { data?: unknown }).data;
  if (Array.isArray(d)) return d as Array<Record<string, unknown>>;
  if (d && typeof d === 'object') {
    for (const k of ['markets', 'results', 'items']) {
      const v = (d as Record<string, unknown>)[k];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

/** Pull a market id out of a row. Prediction markets tend to carry asset_id or market_id. */
function pickMarketId(r: Record<string, unknown>): string | null {
  return strOrNull(r.market_id ?? r.asset_id ?? r.id ?? r.token_id ?? r.slug);
}

function pickTicker(r: Record<string, unknown>): string | null {
  // Prediction markets don't always map to an equity ticker. Use when present.
  const t = r.ticker ?? r.related_ticker ?? r.underlying;
  return typeof t === 'string' && t.length > 0 ? t.toUpperCase() : null;
}

function pickQuestion(r: Record<string, unknown>): string | null {
  return strOrNull(r.question ?? r.title ?? r.name ?? r.market_title);
}

type AggRow = {
  market_id: string;
  ticker: string | null;
  question: string | null;
  smart_money_position: number | null;
  whale_position: number | null;
  insider_position: number | null;
  unusual_flag: boolean;
  liquidity: number | null;
  captured_at: string;
  raw: Record<string, unknown>;
};

async function restUpsert(rows: AggRow[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_prediction_markets?on_conflict=market_id,captured_at`,
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
  setMcpCaller('ct-prediction-markets-ingester');

  const startedAt = Date.now();
  const errors: string[] = [];
  const captured_at = new Date().toISOString();

  async function pull(tool: string, args: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
    try {
      const raw = await mcpCallToolAsData(tool, args);
      return extractData(raw);
    } catch (e) {
      errors.push(`${tool}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  try {
    const [smart, whales, insiders, unusual] = await Promise.all([
      pull('get_prediction_smart_money'),
      pull('get_prediction_whales'),
      pull('get_prediction_insiders'),
      pull('get_prediction_unusual_markets', { limit: 50 }),
    ]);

    const agg = new Map<string, AggRow>();
    function upsert(row: Record<string, unknown>, facet: 'smart' | 'whale' | 'insider' | 'unusual'): void {
      const id = pickMarketId(row);
      if (!id) return;
      const cur = agg.get(id) ?? {
        market_id: id,
        ticker: pickTicker(row),
        question: pickQuestion(row),
        smart_money_position: null,
        whale_position: null,
        insider_position: null,
        unusual_flag: false,
        liquidity: numOrNull(row.liquidity ?? row.total_liquidity ?? row.volume),
        captured_at,
        raw: {},
      };
      // Preserve best-available ticker/question/liquidity across facets.
      if (!cur.ticker) cur.ticker = pickTicker(row);
      if (!cur.question) cur.question = pickQuestion(row);
      if (cur.liquidity === null) cur.liquidity = numOrNull(row.liquidity ?? row.total_liquidity ?? row.volume);
      const pos = numOrNull(row.position ?? row.size ?? row.usd ?? row.net_position);
      if (facet === 'smart') cur.smart_money_position = pos;
      if (facet === 'whale') cur.whale_position = pos;
      if (facet === 'insider') cur.insider_position = pos;
      if (facet === 'unusual') cur.unusual_flag = true;
      (cur.raw as Record<string, unknown>)[facet] = row;
      agg.set(id, cur);
    }

    for (const r of smart) upsert(r, 'smart');
    for (const r of whales) upsert(r, 'whale');
    for (const r of insiders) upsert(r, 'insider');
    for (const r of unusual) upsert(r, 'unusual');

    const rows = Array.from(agg.values());
    let inserted = 0;
    if (rows.length > 0) {
      const result = await restUpsert(rows);
      if (!result.ok) errors.push(`upsert: ${result.error}`);
      else inserted = result.count;
    }

    return new Response(JSON.stringify({
      success: true,
      smart_money: smart.length,
      whales: whales.length,
      insiders: insiders.length,
      unusual: unusual.length,
      merged_markets: rows.length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-prediction-markets-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
