/**
 * ct-analyst-ingester — analyst rating changes via UW screener endpoint.
 *
 * Pulls `/api/screener/analyst-rating` market-wide, then filters in-memory to
 * the watchlist. Dedup key is action_id (firm + ticker + date + action_type
 * if UW doesn't ship one). Every 2h, 12-22 UTC, weekdays.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getAnalystRatings } from '../_shared/uwClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

type Row = {
  action_id: string;
  action_date: string | null;
  ticker: string;
  analyst_firm: string | null;
  action_type: string | null;
  from_rating: string | null;
  to_rating: string | null;
  price_target: number | null;
  prior_price_target: number | null;
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
  const id = r.action_id ?? r.id;
  if (typeof id === 'string' && id.length > 0) return id;
  const ticker = strOrNull(r.ticker ?? r.symbol);
  const firm = strOrNull(r.analyst_firm ?? r.firm ?? r.analyst);
  const date = pickDate(r.action_date ?? r.date ?? r.notification_date);
  const action = strOrNull(r.action ?? r.action_type ?? r.recommendation);
  const target = strOrNull(String(r.price_target ?? r.target ?? ''));
  if (!ticker || !firm || !date) return null;
  return `${ticker}|${firm}|${date}|${action ?? ''}|${target ?? ''}`;
}

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_analyst_actions?on_conflict=action_id`,
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

    let raw: unknown = null;
    try {
      raw = await getAnalystRatings({ limit: 200 });
    } catch (e) {
      errors.push(`uw: ${e instanceof Error ? e.message : String(e)}`);
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
        action_id: id,
        action_date: pickDate(r.action_date ?? r.date ?? r.notification_date),
        ticker: ticker.toUpperCase(),
        analyst_firm: strOrNull(r.analyst_firm ?? r.firm ?? r.analyst),
        action_type: strOrNull(r.action ?? r.action_type ?? r.recommendation),
        from_rating: strOrNull(r.from_rating ?? r.rating_prior ?? r.prev_rating),
        to_rating: strOrNull(r.to_rating ?? r.rating_current ?? r.rating),
        price_target: numOrNull(r.price_target ?? r.target),
        prior_price_target: numOrNull(r.prior_price_target ?? r.target_prior ?? r.prev_target),
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
      seen: data.length,
      watchlist_filtered: rows.length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-analyst-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
