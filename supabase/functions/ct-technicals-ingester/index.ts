/**
 * ct-technicals-ingester — pull indicator time series from UW MCP
 * get_ticker_indicator_series per watchlist ticker, write to ct_technicals.
 *
 * Params verified via shape-probe 2026-04-23:
 *   indicators: array (NOT 'indicator' singular)
 *   range:      bar size — '1m','5m','15m','30m','1h','1d'
 *   interval:   lookback start anchor — '1d','5d','ytd'
 *   end_interval: lookback end anchor — '0d'
 *
 * Two calls per ticker: a daily bundle (RSI, MACD, BB, ATR, SMA, VWAP over
 * 3 months) and an hourly bundle (RSI, VWAP over 5 days).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { mcpCallToolAsData } from '../_shared/uwMcpClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

const INDICATOR_BUNDLE: Array<{
  indicators: string[]; range: string; interval: string; end_interval: string; label_prefix: string;
}> = [
  { indicators: ['RSI','MACD','BBANDS','ATR','SMA','VWAP'], range: '1d', interval: '3m', end_interval: '0d', label_prefix: '1d' },
  { indicators: ['RSI','VWAP'],                              range: '1h', interval: '5d', end_interval: '0d', label_prefix: '1h' },
];

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function parseTs(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'number') return new Date(v * (v > 1e12 ? 1 : 1000)).toISOString();
  const s = String(v);
  const d = new Date(s);
  return !Number.isNaN(d.getTime()) ? d.toISOString() : null;
}

interface Row {
  ticker: string;
  indicator: string;
  timeframe: string;
  ts: string;
  value: number | null;
  extras: Record<string, unknown> | null;
  raw: Record<string, unknown>;
}

async function fetchBundle(
  ticker: string,
  indicators: string[],
  range: string,
  interval: string,
  end_interval: string,
  labelPrefix: string,
): Promise<Row[]> {
  let raw: unknown = null;
  try {
    raw = await mcpCallToolAsData('get_ticker_indicator_series', {
      ticker, indicators, range, interval, end_interval,
    });
  } catch (e) {
    console.warn(`[ct-technicals] ${ticker} ${range}/${interval}:`, e instanceof Error ? e.message : e);
    return [];
  }
  if (!raw) return [];

  // UW's series response: typically { data: [{ timestamp, <ind>: val, ... }] }
  // or { data: { <indicator>: [{ timestamp, value }, ...] } }
  const rowsArr: unknown[] = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data))
      ? (raw as { data: unknown[] }).data
      : [];

  const out: Row[] = [];

  if (rowsArr.length > 0) {
    // Flat shape: each row has timestamp + indicator values
    for (const r of rowsArr) {
      if (!r || typeof r !== 'object') continue;
      const obj = r as Record<string, unknown>;
      const ts = parseTs(obj.timestamp ?? obj.t ?? obj.time ?? obj.date ?? obj.ts ?? obj.start_time);
      if (!ts) continue;
      for (const ind of indicators) {
        const lower = ind.toLowerCase();
        const v = parseNum(obj[lower]) ?? parseNum(obj[ind]);
        if (v == null) continue;
        const extras: Record<string, unknown> = {};
        const prefix = `${lower}_`;
        for (const [k, val] of Object.entries(obj)) {
          if (k.startsWith(prefix) && (typeof val === 'number' || typeof val === 'string')) {
            extras[k.slice(prefix.length)] = val;
          }
        }
        out.push({
          ticker,
          indicator: lower === 'sma' ? 'sma50' : lower === 'bbands' ? 'bb' : lower,
          timeframe: labelPrefix,
          ts, value: v,
          extras: Object.keys(extras).length ? extras : null,
          raw: obj,
        });
      }
    }
  } else if (raw && typeof raw === 'object' && typeof (raw as { data?: unknown }).data === 'object') {
    // Nested shape: { data: { RSI: [{ timestamp, value }], ... } }
    const byIndicator = (raw as { data: Record<string, unknown> }).data;
    for (const [indKey, arr] of Object.entries(byIndicator)) {
      if (!Array.isArray(arr)) continue;
      const lower = indKey.toLowerCase();
      for (const r of arr) {
        if (!r || typeof r !== 'object') continue;
        const obj = r as Record<string, unknown>;
        const ts = parseTs(obj.timestamp ?? obj.t ?? obj.time ?? obj.date);
        if (!ts) continue;
        const v = parseNum(obj.value ?? obj[lower] ?? obj[indKey]);
        if (v == null) continue;
        out.push({
          ticker,
          indicator: lower === 'sma' ? 'sma50' : lower === 'bbands' ? 'bb' : lower,
          timeframe: labelPrefix,
          ts, value: v,
          extras: null,
          raw: obj,
        });
      }
    }
  }

  return out;
}

async function upsert(supabase: SupabaseClient, rows: Row[]): Promise<number> {
  if (rows.length === 0) return 0;
  const { error, count } = await supabase
    .from('ct_technicals')
    .upsert(rows, { onConflict: 'ticker,indicator,timeframe,ts', ignoreDuplicates: true, count: 'exact' });
  if (error) {
    console.warn('[ct-technicals] upsert failed:', error.message);
    return 0;
  }
  return count ?? rows.length;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-technicals-ingester', corsHeaders);
  }

  const started = Date.now();
  const watchlist = await getWatchlist(supabase);
  const per: Record<string, number> = {};
  let grand = 0;

  // 12 tickers × 2 bundles = 24 MCP calls. Pace 500ms.
  for (const ticker of watchlist) {
    let inserted = 0;
    for (const b of INDICATOR_BUNDLE) {
      const rows = await fetchBundle(
        ticker, b.indicators, b.range, b.interval, b.end_interval, b.label_prefix,
      );
      inserted += await upsert(supabase, rows);
      await new Promise((r) => setTimeout(r, 500));
    }
    per[ticker] = inserted;
    grand += inserted;
  }

  return new Response(JSON.stringify({
    ok: true, rows_inserted: grand, elapsed_ms: Date.now() - started, per_ticker: per,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
