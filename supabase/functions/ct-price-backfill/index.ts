/**
 * ct-price-backfill — append last N days of 1m OHLC bars to ct_price_bars for
 * the 12-ticker watchlist + SPY baseline.
 *
 * Uses Yahoo Finance's chart API (same upstream yfinance wraps). Free, no key.
 *
 * Scheduled nightly via pg_cron at 22:30 UTC (post-close). Also callable ad-hoc
 * via service role. Upserts on (ticker, ts, timeframe) — rerunning is idempotent.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

const TICKERS = ['SPY','QQQ','IWM','AAPL','MSFT','NVDA','META','GOOGL','AMZN','TSLA','GLD','USO'];

interface YahooChartBar {
  timestamp: number[];
  indicators: {
    quote: Array<{
      open: (number | null)[];
      high: (number | null)[];
      low: (number | null)[];
      close: (number | null)[];
      volume: (number | null)[];
    }>;
  };
}

interface YahooChartResponse {
  chart: {
    result: Array<{
      meta: Record<string, unknown>;
      timestamp?: number[];
      indicators: YahooChartBar['indicators'];
    }> | null;
    error: { code?: string; description?: string } | null;
  };
}

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

async function fetchYahooBars(
  ticker: string,
  intervalMinutes: number,
  lookbackDays: number,
): Promise<PriceBarRow[]> {
  const now = Math.floor(Date.now() / 1000);
  const start = now - lookbackDays * 86400;
  const intervalStr = intervalMinutes === 1 ? '1m' : `${intervalMinutes}m`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?period1=${start}&period2=${now}&interval=${intervalStr}&includePrePost=false`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ct-price-backfill/1.0)' },
  });
  if (!res.ok) {
    console.warn(`[ct-price-backfill] ${ticker} ${intervalStr}: http ${res.status}`);
    return [];
  }
  const json = (await res.json()) as YahooChartResponse;
  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp) {
    if (json.chart?.error) {
      console.warn(`[ct-price-backfill] ${ticker} ${intervalStr}: yahoo error`, json.chart.error);
    }
    return [];
  }
  const timestamps = result.timestamp;
  const q = result.indicators?.quote?.[0];
  if (!q) return [];
  const rows: PriceBarRow[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || h == null || l == null || c == null) continue; // skip half-formed bars
    rows.push({
      ticker,
      ts: new Date(timestamps[i] * 1000).toISOString(),
      timeframe: intervalStr,
      open:  Math.round(o * 10000) / 10000,
      high:  Math.round(h * 10000) / 10000,
      low:   Math.round(l * 10000) / 10000,
      close: Math.round(c * 10000) / 10000,
      volume: q.volume[i] ?? null,
      source: 'yahoo_chart',
    });
  }
  return rows;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const body = await req.json().catch(() => ({})) as { lookback_days?: number; include_5m?: boolean };
  const lookbackDays1m = Math.min(Math.max(body.lookback_days ?? 3, 1), 7);
  const include5m = body.include_5m ?? false;

  const startedAt = Date.now();
  const summary: Record<string, { m1: number; m5: number }> = {};
  let grand = 0;

  for (const t of TICKERS) {
    const m1Rows = await fetchYahooBars(t, 1, lookbackDays1m);
    let m5Rows: PriceBarRow[] = [];
    if (include5m) m5Rows = await fetchYahooBars(t, 5, 30);

    const all = [...m1Rows, ...m5Rows];
    if (all.length > 0) {
      // Chunk to respect PostgREST payload caps
      const chunk = 500;
      for (let i = 0; i < all.length; i += chunk) {
        const batch = all.slice(i, i + chunk);
        const { error } = await supabase
          .from('ct_price_bars')
          .upsert(batch, { onConflict: 'ticker,ts,timeframe', ignoreDuplicates: true });
        if (error) {
          console.warn(`[ct-price-backfill] ${t} upsert: ${error.message}`);
        }
      }
    }
    summary[t] = { m1: m1Rows.length, m5: m5Rows.length };
    grand += all.length;
    // Polite pause — Yahoo will rate-limit if we hammer
    await new Promise((r) => setTimeout(r, 250));
  }

  const elapsedMs = Date.now() - startedAt;
  return new Response(
    JSON.stringify({
      ok: true,
      rows_seen: grand,
      elapsed_ms: elapsedMs,
      lookback_days_1m: lookbackDays1m,
      include_5m: include5m,
      per_ticker: summary,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
