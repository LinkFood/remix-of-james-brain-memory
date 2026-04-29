/**
 * ct-price-live-poll — Co-Trader live price feed.
 *
 * Yahoo Finance 1m chart poller. Runs every 2 min during RTH, fills
 * ct_price_bars with today's 1m bars and updates ct_ticker_snapshots.spot
 * to the latest close. Fixes the stale-spot / stale-chart problem where
 * ct-price-backfill-nightly only wrote end-of-day history and ct-price-tick-capture
 * wrote to a separate ct_price_ticks table (unused by the PriceChart surface).
 *
 * For each of the 10 WATCHLIST tickers:
 *   1. GET https://query1.finance.yahoo.com/v8/finance/chart/{T}?interval=1m&range=1d&includePrePost=true
 *   2. Parse chart.result[0].timestamp[] + indicators.quote[0].{open,high,low,close,volume}[]
 *   3. Filter to today's UTC date, skip null-close rows.
 *   4. Upsert into ct_price_bars ignoring duplicates (onConflict: ticker,ts,timeframe).
 *   5. Update ct_ticker_snapshots.spot with latest non-null close.
 *
 * Scope: single cron, single table, no pre/post coverage separation.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { WATCHLIST, setUwCaller } from '../_shared/uwClient.ts';

const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

interface BarRow {
  ticker: string;
  ts: string;
  timeframe: '1m';
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  source: string;
}

interface TickerResult {
  ticker: string;
  bars_upserted: number;
  spot_updated: number | null;
  error?: string;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function fetchYahooChart(ticker: string): Promise<{ rows: BarRow[]; error?: string }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        'User-Agent': YAHOO_UA,
        'Accept': 'application/json',
      },
    });
  } catch (e) {
    return { rows: [], error: `fetch_fail: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}` };
  }
  if (!resp.ok) {
    return { rows: [], error: `http_${resp.status}` };
  }
  let json: Record<string, unknown>;
  try {
    json = await resp.json();
  } catch (e) {
    return { rows: [], error: `json_fail: ${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}` };
  }

  const chart = (json.chart as Record<string, unknown> | undefined) ?? {};
  const result = Array.isArray(chart.result) ? chart.result[0] as Record<string, unknown> | undefined : undefined;
  if (!result) return { rows: [], error: 'no_result' };

  const timestamps = (result.timestamp as number[] | undefined) ?? [];
  const indicators = (result.indicators as Record<string, unknown> | undefined) ?? {};
  const quoteArr = Array.isArray(indicators.quote) ? indicators.quote[0] as Record<string, unknown> | undefined : undefined;
  if (!quoteArr) return { rows: [], error: 'no_quote' };

  const opens = (quoteArr.open as Array<number | null> | undefined) ?? [];
  const highs = (quoteArr.high as Array<number | null> | undefined) ?? [];
  const lows = (quoteArr.low as Array<number | null> | undefined) ?? [];
  const closes = (quoteArr.close as Array<number | null> | undefined) ?? [];
  const volumes = (quoteArr.volume as Array<number | null> | undefined) ?? [];

  const today = todayUtcDate();
  const rows: BarRow[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const close = numOrNull(closes[i]);
    if (close === null) continue;
    const open = numOrNull(opens[i]) ?? close;
    const high = numOrNull(highs[i]) ?? close;
    const low = numOrNull(lows[i]) ?? close;
    const volume = numOrNull(volumes[i]);
    const iso = new Date(ts * 1000).toISOString();
    if (iso.slice(0, 10) !== today) continue;
    rows.push({
      ticker,
      ts: iso,
      timeframe: '1m',
      open,
      high,
      low,
      close,
      volume: volume === null ? null : Math.round(volume),
      source: 'yahoo',
    });
  }
  return { rows };
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  setUwCaller('ct-price-live-poll');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();
  const perTicker: TickerResult[] = [];
  const errors: string[] = [];

  for (const ticker of WATCHLIST) {
    try {
      const { rows, error: fetchErr } = await fetchYahooChart(ticker);
      if (fetchErr) {
        perTicker.push({ ticker, bars_upserted: 0, spot_updated: null, error: fetchErr });
        errors.push(`${ticker}:${fetchErr}`);
        continue;
      }
      if (rows.length === 0) {
        perTicker.push({ ticker, bars_upserted: 0, spot_updated: null, error: 'no_rows_today' });
        continue;
      }

      // Upsert bars — ignore duplicates so overlapping 1m polls don't blow up.
      const { error: upsertErr } = await supabase
        .from('ct_price_bars')
        .upsert(rows, { onConflict: 'ticker,ts,timeframe', ignoreDuplicates: true });

      if (upsertErr) {
        perTicker.push({ ticker, bars_upserted: 0, spot_updated: null, error: `upsert: ${upsertErr.message.slice(0, 120)}` });
        errors.push(`${ticker}:upsert:${upsertErr.message.slice(0, 120)}`);
        continue;
      }

      // Latest close = last row in (time-ordered) array.
      const latestClose = rows[rows.length - 1].close;

      const { error: snapErr } = await supabase
        .from('ct_ticker_snapshots')
        .update({ spot: latestClose, snapshot_at: new Date().toISOString() })
        .eq('ticker', ticker);

      if (snapErr) {
        perTicker.push({ ticker, bars_upserted: rows.length, spot_updated: null, error: `snap: ${snapErr.message.slice(0, 120)}` });
        errors.push(`${ticker}:snap:${snapErr.message.slice(0, 120)}`);
        continue;
      }

      perTicker.push({ ticker, bars_upserted: rows.length, spot_updated: latestClose });
    } catch (e) {
      const msg = e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160);
      perTicker.push({ ticker, bars_upserted: 0, spot_updated: null, error: `fatal: ${msg}` });
      errors.push(`${ticker}:fatal:${msg}`);
    }
  }

  const ok = perTicker.some(r => r.bars_upserted > 0);

  return new Response(JSON.stringify({
    ok,
    tickers: WATCHLIST.length,
    per_ticker: perTicker,
    errors,
    duration_ms: Date.now() - startedAt,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
