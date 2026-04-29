/**
 * ct-vix-capture — capture current VIX into ct_vix_history.
 *
 * REWRITE 2026-04-23: switched from spot-exposures REST to UW MCP.
 *
 * REWRITE 2026-04-29: schema is now intraday. PK is surrogate id, not date.
 * Multiple rows per day allowed (uniqueness on date + created_at). change_pct
 * and tier are no longer GENERATED — we compute them here. Captures every 10
 * min during RTH so /tape, FlowPulse, and Pulse get a real intraday curve.
 *
 * Decimal-precision fix: `get_ticker_ohlc_latest_or_date` rounds VIX
 * open/high/close to integers (only `low` keeps decimals — UW data quality
 * quirk). `get_ticker_indicator_series` returns intraday 5m bars with full
 * 2-decimal precision in `close`, so that's now the primary source.
 *
 * Probe results (2026-04-29):
 *   - get_ticker_indicator_series: close=18.81, high=18.82 → PRIMARY
 *   - get_ticker_ohlc_latest_or_date: close="18", low="17.81" → fallback (use low only)
 *   - get_market_state: no VIX field → unused
 *   - get_ticker_candles_by_range: returns empty for VIX → unused
 *   - get_futures_indices: returns no rows for VIX in any category → unused
 *
 * Auth: service role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { mcpCallToolAsData, setMcpCaller } from '../_shared/uwMcpClient.ts';

interface OhlcRow {
  open?: number | string;
  high?: number | string;
  low?: number | string;
  close?: number | string;
  last_price?: number | string;
  price?: number | string;
  level?: number | string;
  [key: string]: unknown;
}

interface SeriesBar {
  c?: number | string;
  close?: number | string;
  h?: number | string;
  l?: number | string;
  o?: number | string;
  start?: string;
  start_time?: string;
  end?: string;
  ticker?: string;
  [key: string]: unknown;
}

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function tierFor(level: number): string {
  if (level < 15) return 'low';
  if (level < 25) return 'mid';
  if (level < 40) return 'elevated';
  return 'stressed';
}

serve(async (req) => {
  const corsResponse = handleCors(req); if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  setMcpCaller('ct-vix-capture');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-vix-capture', corsHeaders);
  }

  let found: { level: number; raw: unknown; via: string } | null = null;
  const errors: string[] = [];

  // Primary: 5m indicator series. Last bar's `close` carries 2-decimal
  // precision (verified 2026-04-29). The `indicators` array isn't needed for
  // the price — we ask for `rsi` (cheapest) just to keep the response shape
  // happy.
  try {
    const result = await mcpCallToolAsData('get_ticker_indicator_series', {
      ticker: 'VIX', indicators: ['rsi'], range: '5m', interval: '1d', end_interval: '0d',
    });
    const data = (result && typeof result === 'object' && 'data' in (result as Record<string, unknown>))
      ? (result as { data: unknown }).data
      : result;
    const arr = Array.isArray(data) ? data : [];
    if (arr.length > 0) {
      const lastBar = arr[arr.length - 1] as SeriesBar;
      const level = parseNum(lastBar.close ?? lastBar.c);
      if (level && level > 0) {
        found = { level, raw: lastBar, via: 'get_ticker_indicator_series' };
      }
    }
  } catch (e) {
    errors.push(`series: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
  }

  // Fallback 1: OHLC. close is rounded to int but `low` keeps precision —
  // so prefer `low` over `close` here since that's the only precision-bearing
  // field on the OHLC tool. Better than nothing if the series tool 5xx's.
  if (!found) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const result = await mcpCallToolAsData('get_ticker_ohlc_latest_or_date', {
        ticker: 'VIX', date: today,
      });
      const data = (result && typeof result === 'object' && 'data' in (result as Record<string, unknown>))
        ? (result as { data: unknown }).data
        : result;
      const row = Array.isArray(data) ? data[0] : data;
      if (row && typeof row === 'object') {
        const r = row as OhlcRow;
        // `low` is the only field with decimal precision on this tool for
        // VIX; the other fields are rounded to ints. Better than `close`.
        const level = parseNum(r.low) ?? parseNum(r.close) ?? parseNum(r.last_price) ?? parseNum(r.price);
        if (level && level > 0) {
          found = { level, raw: r, via: 'get_ticker_ohlc_latest_or_date[low]' };
        }
      }
    } catch (e) {
      errors.push(`ohlc: ${e instanceof Error ? e.message : String(e)}`.slice(0, 120));
    }
  }

  if (!found) {
    console.error('[ct-vix-capture] VIX unavailable via any path. Errors:', errors);
    return new Response(JSON.stringify({
      error: 'VIX unavailable',
      errors,
    }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const nowIso = new Date().toISOString();
  const today  = nowIso.slice(0, 10);

  // prev_close = most recent ROW from a strictly-prior date. Intraday captures
  // share a date with each other, so `lt('date', today)` skips today's earlier
  // ticks and locks onto yesterday's last close — exactly what change_pct
  // wants for a session-vs-session delta.
  const { data: prior } = await supabase
    .from('ct_vix_history')
    .select('date, level, created_at')
    .lt('date', today)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const prevClose = (prior as { level?: number } | null)?.level ?? null;

  const level = +found.level.toFixed(4);
  const change_pct = (prevClose != null && prevClose !== 0)
    ? +(((level - Number(prevClose)) / Number(prevClose)) * 100).toFixed(4)
    : null;

  const { error: insertErr } = await supabase
    .from('ct_vix_history')
    .insert({
      date: today,
      level,
      prev_close: prevClose != null ? +Number(prevClose).toFixed(4) : null,
      change_pct,
      tier: tierFor(level),
      source: 'VIX',
      endpoint: `mcp:${found.via}`,
    });

  if (insertErr) {
    // Defensive: if two captures land in the same millisecond they collide on
    // the (date, created_at) unique idx. Surface the error but don't crash —
    // the next */10 fire is 10 min away, not catastrophic.
    console.error('[ct-vix-capture] insert failed:', insertErr.message);
    return new Response(JSON.stringify({ error: insertErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    ok: true, date: today, level, change_pct, tier: tierFor(level),
    prev_close: prevClose, via: found.via,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
