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

// UW enum (verified via shape-probe 2026-04-23):
//   indicators allowed: sma, ema, atr, atr_levels, rsi, macd, bollinger,
//                       vwap, stochastic, williams_r, adx_di, supertrend,
//                       donchian, obv, cmf
//   range allowed:      1m, 5m, 10m, 15m, 30m, 1h, 4h
//                       (NOTE: no daily/1d — use REST path for daily.)
//   interval lookback:  1d, 5d, 2w, 1m, 3m, 1y, ytd
//   end_interval:       0d, 1d, 5d, ...
//
// Intraday-only MCP path. Daily indicators covered by the legacy REST
// ingester (if still wired) — kept out of scope here.
const INDICATOR_BUNDLE: Array<{
  indicators: string[]; range: string; interval: string; end_interval: string; label_prefix: string;
}> = [
  // Longer lookback gives RSI(14) / MACD(26+9) enough warmup bars to compute.
  { indicators: ['rsi','macd','bollinger','atr','sma','vwap'], range: '1h',  interval: '1m', end_interval: '0d', label_prefix: '1h'  },
  { indicators: ['rsi','vwap'],                                range: '15m', interval: '5d', end_interval: '0d', label_prefix: '15m' },
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
    // UW shape: each row has OHLC + indicator_values nested object.
    //   { close, start, start_time, indicator_values: { rsi: 64.2, macd: { line, signal, histogram }, ... } }
    for (const r of rowsArr) {
      if (!r || typeof r !== 'object') continue;
      const obj = r as Record<string, unknown>;
      const ts = parseTs(obj.start_time ?? obj.start ?? obj.timestamp ?? obj.t ?? obj.time ?? obj.date);
      if (!ts) continue;

      const indValues = obj.indicator_values;
      const iv = (indValues && typeof indValues === 'object' && !Array.isArray(indValues))
        ? indValues as Record<string, unknown>
        : null;

      for (const ind of indicators) {
        const lower = ind.toLowerCase();
        // Try nested indicator_values first, then flat row
        const nested = iv ? iv[lower] : undefined;
        let v: number | null = null;
        let extras: Record<string, unknown> | null = null;

        if (nested != null) {
          if (typeof nested === 'object' && !Array.isArray(nested)) {
            // Multi-value indicator (macd, bollinger): extract primary scalar
            const o = nested as Record<string, unknown>;
            if (lower === 'macd') {
              v = parseNum(o.line ?? o.macd ?? o.value);
              extras = { signal: parseNum(o.signal), histogram: parseNum(o.histogram) };
            } else if (lower === 'bollinger') {
              v = parseNum(o.middle ?? o.ma ?? o.basis ?? o.value);
              extras = { upper: parseNum(o.upper), lower: parseNum(o.lower) };
            } else {
              v = parseNum(o.value) ?? parseNum(o.line);
              extras = o as Record<string, unknown>;
            }
          } else {
            v = parseNum(nested);
          }
        } else {
          v = parseNum(obj[lower]) ?? parseNum(obj[ind]);
        }

        if (v == null) continue;

        out.push({
          ticker,
          indicator: lower === 'sma' ? 'sma50' : lower === 'bollinger' ? 'bb' : lower,
          timeframe: labelPrefix,
          ts, value: v,
          extras,
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

// Daily indicators via get_av_technical_indicator (AlphaVantage-style).
// Response shape (verified 2026-04-23):
//   { data: [{ date, values: { RSI: "73.59" }, ticker, interval, indicator,
//              series_type, time_period }, ...] }
async function fetchAvIndicator(ticker: string, fn: string): Promise<Row[]> {
  let raw: unknown = null;
  try {
    raw = await mcpCallToolAsData('get_av_technical_indicator', {
      ticker, function: fn, interval: 'daily',
      ...(fn === 'RSI' || fn === 'ATR' ? { time_period: 14 } : {}),
      ...(fn === 'SMA' ? { time_period: 50 } : {}),
      ...(fn === 'BBANDS' ? { time_period: 20 } : {}),
    });
  } catch (e) {
    console.warn(`[ct-technicals:av] ${ticker}/${fn}:`, e instanceof Error ? e.message : e);
    return [];
  }
  const arr: unknown[] = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data))
      ? (raw as { data: unknown[] }).data
      : [];

  const out: Row[] = [];
  const canonical = fn === 'BBANDS' ? 'bb' : fn === 'SMA' ? 'sma50' : fn.toLowerCase();
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const obj = r as Record<string, unknown>;
    const ts = parseTs(obj.date ?? obj.timestamp);
    if (!ts) continue;
    const vals = (obj.values && typeof obj.values === 'object' && !Array.isArray(obj.values))
      ? obj.values as Record<string, unknown>
      : null;

    let value: number | null = null;
    let extras: Record<string, unknown> | null = null;
    if (vals) {
      if (fn === 'MACD') {
        value = parseNum(vals.MACD ?? vals.macd);
        extras = { signal: parseNum(vals.MACD_Signal ?? vals.signal), histogram: parseNum(vals.MACD_Hist ?? vals.histogram) };
      } else if (fn === 'BBANDS') {
        value = parseNum(vals.Real_Middle_Band ?? vals.MIDDLE ?? vals.MA);
        extras = { upper: parseNum(vals.Real_Upper_Band ?? vals.UPPER), lower: parseNum(vals.Real_Lower_Band ?? vals.LOWER) };
      } else {
        value = parseNum(vals[fn]) ?? parseNum(vals[fn.toUpperCase()]) ?? parseNum(vals[canonical]);
      }
    }
    if (value == null) value = parseNum(obj.value);
    if (value == null) continue;

    out.push({
      ticker,
      indicator: canonical,
      timeframe: '1d',
      ts, value,
      extras,
      raw: obj,
    });
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

  // 12 tickers × 2 bundles intraday = 24 MCP calls. Pace 500ms.
  for (const ticker of watchlist) {
    let inserted = 0;
    for (const b of INDICATOR_BUNDLE) {
      const rows = await fetchBundle(
        ticker, b.indicators, b.range, b.interval, b.end_interval, b.label_prefix,
      );
      inserted += await upsert(supabase, rows);
      await new Promise((r) => setTimeout(r, 500));
    }
    // Daily bundle via get_av_technical_indicator — separate tool, uppercase
    // FUNCTION names, returns { date, values: { RSI: "73.5972" } }.
    for (const fn of ['RSI','MACD','ATR','VWAP','BBANDS']) {
      const rows = await fetchAvIndicator(ticker, fn);
      inserted += await upsert(supabase, rows);
      await new Promise((r) => setTimeout(r, 400));
    }
    per[ticker] = inserted;
    grand += inserted;
  }

  return new Response(JSON.stringify({
    ok: true, rows_inserted: grand, elapsed_ms: Date.now() - started, per_ticker: per,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
