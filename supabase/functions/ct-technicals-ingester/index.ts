/**
 * ct-technicals-ingester — RSI(14), MACD, VWAP, ATR(14), BBANDS(20) per
 * watchlist ticker.
 *
 * Each indicator is a separate UW call per ticker. Paths verified 2026-04-18:
 *   /api/stock/{ticker}/technical-indicator/{FUNCTION}  (FUNCTION must be UPPERCASE)
 *
 * Interval enum: 1min | 5min | 15min | 30min | 60min | daily | weekly | monthly.
 * We use 5min for intraday cadence. VWAP is intraday-only.
 *
 * We store the latest observation as a scalar `value`, and dump the full row
 * into `raw`. Every 15 min during RTH weekdays.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getTechnicalIndicator, type TechnicalInterval } from '../_shared/uwClient.ts';
import { mcpCallToolAsData, isUwRateLimit } from '../_shared/uwMcpClient.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

type Row = {
  ticker: string;
  indicator_name: string;
  period: number | null;
  captured_at: string;
  value: number | null;
  raw: Record<string, unknown>;
};

// Names stored lowercase in DB (indicator_name column), wrapper upcases for
// the path. `period` is null when the indicator doesn't take one (MACD, VWAP).
//
// INTERVAL CHOICE: `daily` is the portable default — every indicator returns
// daily outside market hours. Intraday intervals (5min) frequently 422 or
// return empty series for lower-tier UW subscriptions. VWAP is intraday-only
// per UW spec, so it uses 5min explicitly; if the 5min call returns empty
// (e.g. outside RTH), we simply skip the upsert for that ticker/indicator.
const INDICATORS: Array<{ name: string; period: number | null; interval: TechnicalInterval }> = [
  { name: 'rsi',    period: 14,   interval: 'daily' },
  { name: 'macd',   period: null, interval: 'daily' },
  { name: 'vwap',   period: null, interval: '5min'  }, // intraday-only per UW spec
  { name: 'atr',    period: 14,   interval: 'daily' },
  { name: 'bbands', period: 20,   interval: 'daily' },
];

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function pickTimestamp(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v + 'T00:00:00Z';
  return null;
}

/**
 * UW's technical-indicator payload varies by function:
 *   - { data: [{timestamp, value}, ...] }           (most indicators)
 *   - { data: { "2026-04-18": { "RSI": "..." }, ... } }   (AlphaVantage-style
 *     date-keyed object; observed on live API)
 *   - { data: { values: [...] } }                   (defensive fallback)
 *
 * Normalize to Array<{timestamp, <fields>}>.
 */
function extractSeries(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const d = (raw as { data?: unknown }).data;
  if (Array.isArray(d)) return d as Array<Record<string, unknown>>;
  if (d && typeof d === 'object') {
    const asObj = d as Record<string, unknown>;
    // Nested array under common keys.
    for (const k of ['values', 'series', 'indicator', 'results']) {
      const v = asObj[k];
      if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
    }
    // Date-keyed object: { "2026-04-18": {...}, "2026-04-17": {...} }
    const entries = Object.entries(asObj);
    const dateShaped = entries.filter(([k, v]) =>
      /^\d{4}-\d{2}-\d{2}/.test(k) && v && typeof v === 'object'
    );
    if (dateShaped.length > 0) {
      return dateShaped.map(([k, v]) => ({ timestamp: k, ...(v as Record<string, unknown>) }));
    }
  }
  return [];
}

/**
 * Pull the "primary value" out of a UW indicator row. UW returns:
 *   { date, values: { RSI: "64.1753" }, ticker, indicator, ... }
 * so the real scalar lives at row.values.<INDICATOR_UPPERCASE>. BBANDS has
 * three bands (UPPER/MIDDLE/LOWER) — we pick MIDDLE. MACD has MACD/SIGNAL/
 * HIST — we pick MACD.
 */
function pickPrimary(indicator: string, row: Record<string, unknown>): number | null {
  const vals = row.values;
  const valuesObj = (vals && typeof vals === 'object' && !Array.isArray(vals))
    ? (vals as Record<string, unknown>)
    : null;
  const upper = indicator.toUpperCase();

  if (valuesObj) {
    switch (indicator) {
      case 'bbands': {
        const mid = valuesObj.MIDDLE ?? valuesObj.MIDDLE_BAND ?? valuesObj.BBANDS_MIDDLE ?? valuesObj.MA;
        const n = numOrNull(mid);
        if (n !== null) return n;
        break;
      }
      case 'macd': {
        const n = numOrNull(valuesObj.MACD ?? valuesObj.MACD_LINE);
        if (n !== null) return n;
        break;
      }
      default: {
        const n = numOrNull(valuesObj[upper]);
        if (n !== null) return n;
      }
    }
  }

  // Legacy fallbacks (for when UW returns value at root).
  const direct = numOrNull(row.value);
  if (direct !== null) return direct;
  switch (indicator) {
    case 'macd': return numOrNull(row.macd ?? row.macd_line);
    case 'bbands': return numOrNull(row.middle ?? row.middle_band ?? row.ma);
    case 'vwap': return numOrNull(row.vwap ?? row.value);
    case 'atr': return numOrNull(row.atr ?? row.value);
    case 'rsi': return numOrNull(row.rsi ?? row.value);
    default: return null;
  }
}

async function restUpsert(rows: Row[]): Promise<{ ok: boolean; count: number; error?: string }> {
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceKey) return { ok: false, count: 0, error: 'missing env' };
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/ct_technical_indicators?on_conflict=ticker,indicator_name,period,captured_at`,
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
  const errors: Array<{ ticker: string; indicator: string; error: string }> = [];
  let mcpCalls = 0;
  let legacyCalls = 0;

  try {
    const watchlist = await getWatchlist(supabase);
    const rows: Row[] = [];

    for (const ticker of watchlist) {
      const upper = ticker.toUpperCase();
      for (const { name, period, interval } of INDICATORS) {
        let raw: unknown = null;

        // Wave N.2 — prefer UW MCP `get_av_technical_indicator` (Alpha Vantage
        // tech indicator set — same shape UW's legacy REST already proxied).
        // Fall back to legacy on per-indicator failure. One stress_check row
        // per failing MCP call — noisy first day, drops to zero as MCP proves.
        const mcpArgs: Record<string, unknown> = {
          ticker: upper,
          function: name.toUpperCase(),
          interval,
        };
        if (period !== null) mcpArgs.time_period = period;

        let source: 'mcp' | 'legacy' = 'mcp';
        try {
          raw = await mcpCallToolAsData('get_av_technical_indicator', mcpArgs);
          mcpCalls++;
        } catch (mcpErr) {
          if (isUwRateLimit(mcpErr)) {
            // Shared bucket — falling back to legacy REST just burns a second
            // request on the same saturated 120/min limit. Skip this indicator
            // this cycle; next cron tick will backfill.
            errors.push({ ticker: upper, indicator: name, error: 'mcp_rate_limited' });
            continue;
          }
          const msg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
          await recordDecision(supabase, {
            decision_type: 'stress_check',
            model_tier: 'none',
            reasoning: `MCP fallback on ct-technicals-ingester ${upper}/${name}: ${msg.slice(0, 300)}`,
          });
          source = 'legacy';
          try {
            const params: { interval: TechnicalInterval; time_period?: number } = { interval };
            if (period !== null) params.time_period = period;
            raw = await getTechnicalIndicator(upper, name, params);
            legacyCalls++;
          } catch (e) {
            errors.push({ ticker: upper, indicator: name, error: e instanceof Error ? e.message : String(e) });
            continue;
          }
        }
        void source; // used for read-flow clarity; accounted in mcpCalls/legacyCalls
        const series = extractSeries(raw);
        if (series.length === 0) continue;
        // UW returns the series in descending date order — most recent first.
        // Fall back to last element if first lacks a date (defensive).
        const firstWithDate = series.find((r) => pickTimestamp(r.timestamp ?? r.time ?? r.date) !== null) ?? series[0];
        const latest = firstWithDate;
        const captured_at = pickTimestamp(latest.timestamp ?? latest.time ?? latest.date) ?? new Date().toISOString();
        const value = pickPrimary(name, latest);
        rows.push({
          ticker: upper,
          indicator_name: name,
          period,
          captured_at,
          value,
          raw: latest,
        });
      }
    }

    let inserted = 0;
    if (rows.length > 0) {
      const result = await restUpsert(rows);
      if (!result.ok) errors.push({ ticker: 'BATCH', indicator: 'upsert', error: result.error ?? 'unknown' });
      else inserted = result.count;
    }

    return new Response(JSON.stringify({
      success: true,
      rows: rows.length,
      inserted,
      mcp_calls: mcpCalls,
      legacy_calls: legacyCalls,
      errors,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    console.error('[ct-technicals-ingester] fatal:', e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : 'failed', errors }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
