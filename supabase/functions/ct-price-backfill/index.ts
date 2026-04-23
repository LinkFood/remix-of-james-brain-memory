/**
 * ct-price-backfill — append recent OHLC bars to ct_price_bars for the
 * 12-ticker watchlist + SPY baseline.
 *
 * Primary source: UW MCP get_ticker_candles_by_range (native, same vendor
 * as all our other signals, no extra dependency, session filtering).
 * Fallback: Yahoo chart API (free, kept as insurance if UW MCP fails).
 *
 * Scheduled nightly via pg_cron at 22:30 UTC (post-close). Also callable
 * ad-hoc via service role. Upserts on (ticker, ts, timeframe).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { mcpCallToolAsData } from '../_shared/uwMcpClient.ts';

const TICKERS = ['SPY','QQQ','IWM','AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','GLD','USO'];

interface PriceBarRow {
  ticker: string;
  ts: string;
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  source: string;
}

function parseNum(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }

// ---------------------------------------------------------------------------
// UW MCP fetch — primary
// ---------------------------------------------------------------------------

async function fetchUwCandles(
  ticker: string,
  intervalMinutes: number,
  lookbackAnchor: string,       // UW's relative start anchor: '1d','5d','1w','ytd'
): Promise<PriceBarRow[]> {
  const range = intervalMinutes < 60
    ? `${intervalMinutes}m`
    : intervalMinutes === 60 ? '1h' : `${intervalMinutes / 60}h`;
  let raw: unknown;
  try {
    raw = await mcpCallToolAsData('get_ticker_candles_by_range', {
      ticker,
      range,
      interval:     lookbackAnchor,
      end_interval: '0d',
      session:      'regular',
    });
  } catch (e) {
    console.warn(`[ct-price-backfill] UW MCP ${ticker} ${range}/${lookbackAnchor}:`, e instanceof Error ? e.message : e);
    return [];
  }
  const arr: unknown[] = Array.isArray(raw) ? raw
    : (raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data))
      ? (raw as { data: unknown[] }).data
      : [];
  const out: PriceBarRow[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    const open  = parseNum(o.open  ?? o.o);
    const high  = parseNum(o.high  ?? o.h);
    const low   = parseNum(o.low   ?? o.l);
    const close = parseNum(o.close ?? o.c);
    if (open == null || high == null || low == null || close == null) continue;
    const tsRaw = o.timestamp ?? o.t ?? o.time ?? o.start_time ?? o.date;
    let ts: string | null = null;
    if (typeof tsRaw === 'number') ts = new Date(tsRaw * (tsRaw > 1e12 ? 1 : 1000)).toISOString();
    else if (typeof tsRaw === 'string') {
      const d = new Date(tsRaw);
      if (!Number.isNaN(d.getTime())) ts = d.toISOString();
    }
    if (!ts) continue;
    const vol = parseNum(o.volume ?? o.v);
    out.push({
      ticker, ts, timeframe: range,
      open: round4(open), high: round4(high), low: round4(low), close: round4(close),
      volume: vol != null ? Math.round(vol) : null,
      source: 'uw_mcp_candles',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Yahoo fallback — kept for resilience
// ---------------------------------------------------------------------------

async function fetchYahooBars(
  ticker: string,
  intervalMinutes: number,
  lookbackDays: number,
): Promise<PriceBarRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - lookbackDays * 86400;
  const intervalStr = intervalMinutes === 1 ? '1m' : `${intervalMinutes}m`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${start}&period2=${now}&interval=${intervalStr}&includePrePost=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ct-price-backfill/2.0)' } });
  if (!res.ok) return [];
  const json = await res.json() as {
    chart: {
      result: Array<{ timestamp?: number[]; indicators: { quote: Array<{
        open: (number|null)[]; high: (number|null)[]; low: (number|null)[];
        close: (number|null)[]; volume: (number|null)[]; }> } }> | null;
    };
  };
  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp) return [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];
  const rows: PriceBarRow[] = [];
  for (let i = 0; i < result.timestamp.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue;
    rows.push({
      ticker,
      ts: new Date(result.timestamp[i] * 1000).toISOString(),
      timeframe: intervalStr,
      open: round4(o), high: round4(h), low: round4(l), close: round4(c),
      volume: q.volume[i] ?? null,
      source: 'yahoo_chart_fallback',
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const body = await req.json().catch(() => ({})) as { lookback_days?: number; include_5m?: boolean };
  const lookbackDays1m = Math.min(Math.max(body.lookback_days ?? 3, 1), 7);
  const include5m = body.include_5m ?? false;
  const uwLookback1m = lookbackDays1m <= 1 ? '1d' : lookbackDays1m <= 5 ? '5d' : '1w';

  const started = Date.now();
  const per: Record<string, { m1: number; m5: number; source: string }> = {};
  let grand = 0;

  for (const t of TICKERS) {
    // Primary: UW MCP 1-min
    let m1 = await fetchUwCandles(t, 1, uwLookback1m);
    let sourceTag = 'uw_mcp_candles';
    if (m1.length === 0) {
      m1 = await fetchYahooBars(t, 1, lookbackDays1m);
      sourceTag = 'yahoo_chart_fallback';
    }

    let m5: PriceBarRow[] = [];
    if (include5m) {
      m5 = await fetchUwCandles(t, 5, '1m');
      if (m5.length === 0) m5 = await fetchYahooBars(t, 5, 30);
    }

    const all = [...m1, ...m5];
    if (all.length > 0) {
      const chunk = 500;
      for (let i = 0; i < all.length; i += chunk) {
        const batch = all.slice(i, i + chunk);
        const { error } = await supabase
          .from('ct_price_bars')
          .upsert(batch, { onConflict: 'ticker,ts,timeframe', ignoreDuplicates: true });
        if (error) console.warn(`[ct-price-backfill] ${t}:`, error.message);
      }
    }
    per[t] = { m1: m1.length, m5: m5.length, source: sourceTag };
    grand += all.length;
    await new Promise((r) => setTimeout(r, 250));
  }

  return new Response(JSON.stringify({
    ok: true, rows_seen: grand, elapsed_ms: Date.now() - started,
    lookback_days_1m: lookbackDays1m, include_5m: include5m,
    uw_lookback: uwLookback1m, per_ticker: per,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
