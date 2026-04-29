/**
 * ct-eod-positioning — daily EOD positioning snapshot.
 *
 * For each watchlist ticker (+ SPX macro):
 *   1) getMaxPain(ticker) — per-expiry max pain strikes. Upsert one row per
 *      expiry into ct_max_pain_daily, keyed on (ticker, date, expiry).
 *   2) getIvRank(ticker) — IV rank time series. Take the latest row, upsert
 *      one row into ct_iv_rank_daily keyed on (ticker, date).
 *
 * Defensive about UW response shape: per-row normalization, per-ticker errors
 * collected and returned. Sequential (26 calls total — well inside 120/min).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getMaxPain, getIvRank, WATCHLIST, MARKET_BANNER_SYMBOL, setUwCaller } from '../_shared/uwClient.ts';

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function dateOrNull(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = v.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** Pull out an array of rows from any of the common UW response shapes. */
function extractRows(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  if (!raw || typeof raw !== 'object') return [];
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.data)) return r.data as Array<Record<string, unknown>>;
  // max-pain sometimes comes back as an object keyed by expiry → { "2026-04-17": { max_pain: 580, ... } }
  if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
    const entries = Object.entries(r.data as Record<string, unknown>);
    return entries.map(([k, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        return { expiry: k, ...(v as Record<string, unknown>) };
      }
      // scalar value → treat as max-pain strike for that expiry
      return { expiry: k, max_pain: v };
    });
  }
  return [];
}

// ---------- Max Pain ----------

type MaxPainRow = {
  ticker: string;
  date: string;
  expiry: string | null;
  max_pain_strike: number | null;
  raw: Record<string, unknown>;
};

function normalizeMaxPain(ticker: string, date: string, raw: unknown): MaxPainRow[] {
  const rows = extractRows(raw);
  const out: MaxPainRow[] = [];
  for (const r of rows) {
    const expiry = dateOrNull(r.expiry ?? r.expiration ?? r.expiry_date ?? r.date);
    const strike = numOrNull(r.max_pain ?? r.max_pain_strike ?? r.strike ?? r.value);
    // skip entirely empty rows, but allow null strike if expiry is present (visible gap)
    if (!expiry && strike === null) continue;
    out.push({
      ticker,
      date,
      expiry,
      max_pain_strike: strike,
      raw: r,
    });
  }
  // If UW returned nothing recognizable but a response was received, persist a single null row
  // so we have a grave marker that the call ran on this date.
  if (out.length === 0 && rows.length === 0 && raw && typeof raw === 'object') {
    out.push({ ticker, date, expiry: null, max_pain_strike: null, raw: raw as Record<string, unknown> });
  }
  return out;
}

async function ingestMaxPain(
  supabase: SupabaseClient,
  ticker: string,
  date: string,
): Promise<{ inserted: number; error?: string }> {
  try {
    const raw = await getMaxPain(ticker);
    const rows = normalizeMaxPain(ticker, date, raw);
    if (rows.length === 0) return { inserted: 0 };
    const { error, count } = await supabase
      .from('ct_max_pain_daily')
      .upsert(rows, { onConflict: 'ticker,date,expiry', count: 'exact' });
    if (error) return { inserted: 0, error: error.message };
    return { inserted: count ?? rows.length };
  } catch (e) {
    return { inserted: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- IV Rank ----------

type IvRankRow = {
  ticker: string;
  date: string;
  iv_rank: number | null;
  iv_30d: number | null;
  iv_percentile: number | null;
  raw: Record<string, unknown>;
};

/** Pick the latest entry from whatever shape UW returned for iv-rank. */
function pickLatestIvRow(raw: unknown): Record<string, unknown> | null {
  const rows = extractRows(raw);
  if (rows.length === 0) return null;
  // UW timeseries typically has a date/tape_time field per row. Pick max.
  let best: Record<string, unknown> | null = null;
  let bestDate = '';
  for (const r of rows) {
    const d = (r.date ?? r.tape_time ?? r.timestamp ?? r.asof ?? r.asof_date);
    const s = typeof d === 'string' ? d : '';
    if (s >= bestDate) {
      bestDate = s;
      best = r;
    }
  }
  return best ?? rows[rows.length - 1] ?? null;
}

function normalizeIvRank(ticker: string, date: string, raw: unknown): IvRankRow | null {
  const row = pickLatestIvRow(raw);
  if (!row) return null;
  // UW shape: { date, close, iv_rank_1y, volatility, updated_at }
  // Fallbacks cover older/variant shapes.
  const iv_rank = numOrNull(row.iv_rank_1y ?? row.iv_rank ?? row.rank ?? row.iv_rank_30d);
  // volatility is 30d IV as a decimal (0.1489 = 14.89%). Store as-is.
  const iv_30d = numOrNull(row.volatility ?? row.iv_30d ?? row.implied_volatility_30d ?? row.iv);
  const iv_percentile = numOrNull(row.iv_percentile ?? row.percentile);
  return {
    ticker,
    date,
    iv_rank,
    iv_30d,
    iv_percentile,
    raw: row,
  };
}

async function ingestIvRank(
  supabase: SupabaseClient,
  ticker: string,
  date: string,
): Promise<{ inserted: number; error?: string }> {
  try {
    const raw = await getIvRank(ticker);
    const row = normalizeIvRank(ticker, date, raw);
    if (!row) return { inserted: 0 };
    const { error, count } = await supabase
      .from('ct_iv_rank_daily')
      .upsert([row], { onConflict: 'ticker,date', count: 'exact' });
    if (error) return { inserted: 0, error: error.message };
    return { inserted: count ?? 1 };
  } catch (e) {
    return { inserted: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- Entry point ----------

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  setUwCaller('ct-eod-positioning');

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedAt = Date.now();
  const date = new Date().toISOString().slice(0, 10);
  const tickers = [...WATCHLIST, MARKET_BANNER_SYMBOL];

  let max_pain_rows_inserted = 0;
  let iv_rank_rows_inserted = 0;
  const errors: Array<{ ticker: string; endpoint: string; error: string }> = [];

  for (const ticker of tickers) {
    const mp = await ingestMaxPain(supabase, ticker, date);
    max_pain_rows_inserted += mp.inserted;
    if (mp.error) errors.push({ ticker, endpoint: 'max-pain', error: mp.error });

    const iv = await ingestIvRank(supabase, ticker, date);
    iv_rank_rows_inserted += iv.inserted;
    if (iv.error) errors.push({ ticker, endpoint: 'iv-rank', error: iv.error });
  }

  return new Response(JSON.stringify({
    success: true,
    date,
    tickers_processed: tickers.length,
    max_pain_rows_inserted,
    iv_rank_rows_inserted,
    errors,
    duration_ms: Date.now() - startedAt,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
