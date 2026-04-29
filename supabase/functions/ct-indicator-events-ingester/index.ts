/**
 * ct-indicator-events-ingester — technical-indicator events per watchlist
 * ticker via UW MCP.
 *
 * Wave N.2 — new signal stream. MCP tool: `get_ticker_indicator_events`.
 * Pulls counted event occurrences (MA bounce, MA crossover, breakout retest,
 * indicator touch, breach-then-reclaim) rather than full indicator series.
 *
 * Cron: every 30min during RTH (13-20 UTC, weekdays).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { mcpCallToolAsData, setMcpCaller } from '../_shared/uwMcpClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

const EVENT_TYPES = [
  'ma_bounce',
  'ma_crossover',
  'breakout_retest',
  'indicator_touch',
  'indicator_breach_reclaim',
] as const;

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function pickTimestamp(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + 'T00:00:00Z';
  return null;
}

function extractData(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  // UW shape (verified 2026-04-18):
  //   { data: { count, events: [...], range, ticker, event_type, ... } }
  // or the helper may already have unwrapped to { count, events: [...] }.
  // Check both levels.
  const root = raw as Record<string, unknown>;
  const checkObj = (o: unknown): Array<Record<string, unknown>> | null => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    const rec = o as Record<string, unknown>;
    for (const k of ['events', 'results', 'items', 'data']) {
      const v = rec[k];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
    return null;
  };

  const nested = checkObj(root.data) ?? checkObj(root);
  if (nested) return nested;
  if (Array.isArray(root.data)) return root.data as Array<Record<string, unknown>>;
  return [];
}

type Row = {
  ticker: string;
  event_type: string;
  event_date: string;
  indicator_name: string | null;
  value: number | null;
  ingested_at: string;
  raw: Record<string, unknown>;
};

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_indicator_events?on_conflict=ticker,event_type,event_date,indicator_name`,
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
  setMcpCaller('ct-indicator-events-ingester');

  const supabase: SupabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();
  const errors: Array<{ ticker: string; event_type: string; error: string }> = [];
  const ingested_at = new Date().toISOString();

  try {
    const watchlist = await getWatchlist(supabase);
    const rows: Row[] = [];

    for (const ticker of watchlist) {
      const upper = ticker.toUpperCase();
      for (const event_type of EVENT_TYPES) {
        let raw: unknown = null;
        try {
          // UW required params (verified 2026-04-18):
          //   ticker, event_type, interval (window anchor like '5d'),
          //   end_interval (upper bound like '1d'),
          //   range (candle size enum: '1m'|'5m'|'10m'|'15m'|'30m'|'1h'|'4h').
          // Earlier confusion: `range` is the bar size, `interval` is the
          // lookback window. Use 1h bars over the last 5 days capped at
          // yesterday so intraday bounces show up without overwhelming the
          // response.
          raw = await mcpCallToolAsData('get_ticker_indicator_events', {
            ticker: upper,
            event_type,
            interval: '5d',
            end_interval: '1d',
            range: '1h',
          });
        } catch (e) {
          errors.push({ ticker: upper, event_type, error: e instanceof Error ? e.message : String(e) });
          continue;
        }
        const data = extractData(raw);
        for (const r of data) {
          // UW indicator-events row fields (verified): start_time, type,
          // close, low, ma, index. We use start_time as the event timestamp.
          const event_date = pickTimestamp(r.start_time ?? r.timestamp ?? r.event_date ?? r.date ?? r.time);
          if (!event_date) continue;
          rows.push({
            ticker: upper,
            event_type,
            event_date,
            // `type` on the row mirrors our event_type query; more useful to
            // store the actual indicator key UW fell on (MA for ma_bounce,
            // etc). We stamp the subtype as indicator_name so two events at
            // the same timestamp from different indicators don't collide.
            indicator_name: strOrNull(r.indicator ?? r.indicator_name ?? r.type) ?? event_type,
            value: numOrNull(r.value ?? r.close ?? r.price),
            ingested_at,
            raw: r,
          });
        }
      }
    }

    // In-batch dedupe — an intra-payload conflict on the unique key would
    // abort the whole upsert.
    const seen = new Set<string>();
    const deduped: Row[] = [];
    for (const r of rows) {
      const key = `${r.ticker}|${r.event_type}|${r.event_date}|${r.indicator_name ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }

    let inserted = 0;
    if (deduped.length > 0) {
      const result = await restUpsert(deduped);
      if (!result.ok) errors.push({ ticker: 'BATCH', event_type: '*', error: result.error ?? 'unknown' });
      else inserted = result.count;
    }

    return new Response(JSON.stringify({
      success: true,
      watchlist: watchlist.length,
      rows_raw: rows.length,
      rows: deduped.length,
      inserted,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-indicator-events-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
