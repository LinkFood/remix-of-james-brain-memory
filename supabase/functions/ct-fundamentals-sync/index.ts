/**
 * ct-fundamentals-sync — weekly pull of fundamental metrics for the 12
 * watchlist tickers into ct_fundamentals_cache.
 *
 * Runs Sunday 22:00 UTC. Per ticker, up to THREE UW calls:
 *   1. getFinancials(ticker)        — pe_ratio, market_cap, eps_ttm, revenue_ttm
 *   2. getIncomeStatements(ticker)  — revenue_yoy_growth_pct (latest Q vs Q-4)
 *   3. getEarnings(ticker)          — last_earnings_actual_eps / est / surprise_pct
 *
 * 12 tickers × 3 calls/week = 36 UW calls/week. Trivial.
 *
 * SHAPE VARIANCE:
 *   - Equities (NVDA, AAPL, …) return full financials + income statements.
 *   - ETFs (USO, GLD) typically return empty or NULL-heavy financials. We
 *     still INSERT the row — every numeric column is nullable, so downstream
 *     UI just hides the missing fields. No special-casing per ticker.
 *   - UW shape varies across account tiers and over time, so every field is
 *     extracted defensively (multiple field-name fallbacks).
 *
 * 7-DAY TTL:
 *   - Before calling UW, check if ct_fundamentals_cache already has a row
 *     for this ticker with as_of_date within the last 7 days. If so, skip.
 *   - Avoids wasted UW calls if the cron fires twice (e.g. manual kick-off).
 *
 * GRACEFUL ERRORS:
 *   - Each ticker is wrapped in try/catch. A failed fetch or parse for one
 *     ticker logs a warning and skips — never crashes the batch.
 *   - UW 4xx / 5xx / network errors all funnel through the same 'error'
 *     action; summary reports count per outcome.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getFinancials, getIncomeStatements, getEarnings } from '../_shared/uwClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

const TTL_DAYS = 7;

interface FundamentalsRow {
  ticker: string;
  as_of_date: string;
  eps_ttm: number | null;
  revenue_ttm: number | null;
  pe_ratio: number | null;
  market_cap: number | null;
  last_earnings_actual_eps: number | null;
  last_earnings_est_eps: number | null;
  last_earnings_surprise_pct: number | null;
  revenue_yoy_growth_pct: number | null;
}

interface SyncResult {
  ticker: string;
  action: 'upserted' | 'skipped_fresh' | 'error';
  error?: string;
  fields_populated?: number;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Unwrap UW responses: { data: {...} } | { data: [...] } | raw object | raw array. */
function unwrap(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const maybe = (raw as { data?: unknown }).data;
  return maybe !== undefined ? maybe : raw;
}

/**
 * Extract fundamentals from the financials endpoint. Shape examples from UW:
 *   { pe_ratio: 28.5, market_cap: 3100000000000, eps_ttm: 4.12, revenue_ttm: 2.1e11 }
 * But field names vary; we check common aliases.
 */
function parseFinancials(raw: unknown): Pick<FundamentalsRow, 'eps_ttm' | 'revenue_ttm' | 'pe_ratio' | 'market_cap'> {
  const u = unwrap(raw);
  const obj = Array.isArray(u) ? (u[0] as Record<string, unknown> | undefined) ?? {} : (u as Record<string, unknown>) ?? {};
  return {
    eps_ttm:     numOrNull(obj.eps_ttm ?? obj.eps ?? obj.trailing_eps ?? obj.ttm_eps),
    revenue_ttm: numOrNull(obj.revenue_ttm ?? obj.ttm_revenue ?? obj.revenue),
    pe_ratio:    numOrNull(obj.pe_ratio ?? obj.pe ?? obj.trailing_pe ?? obj.price_to_earnings),
    market_cap:  numOrNull(obj.market_cap ?? obj.marketcap ?? obj.market_capitalization),
  };
}

/**
 * Extract YoY revenue growth from the income statements endpoint. UW returns
 * a list of quarterly/annual rows. We want:
 *   latest_quarter.revenue vs same_quarter_prior_year.revenue → pct change
 *
 * Strategy: find the most recent quarterly row, then find a prior-year row
 * (~365 days earlier by report date). Fall back to null if either missing.
 */
function parseRevenueYoY(raw: unknown): number | null {
  const u = unwrap(raw);
  const list: Array<Record<string, unknown>> = Array.isArray(u) ? (u as Array<Record<string, unknown>>) : [];
  if (list.length === 0) return null;

  // Normalize each row to { date, revenue }.
  const rows: Array<{ date: string; revenue: number }> = [];
  for (const r of list) {
    const d = r.report_date ?? r.date ?? r.period_end ?? r.fiscal_period_end;
    const rev = numOrNull(r.revenue ?? r.total_revenue ?? r.net_revenue ?? r.sales);
    if (typeof d !== 'string' || rev === null) continue;
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    rows.push({ date: m[1], revenue: rev });
  }
  if (rows.length < 2) return null;

  rows.sort((a, b) => b.date.localeCompare(a.date));
  const latest = rows[0];
  // Find a row ~365d prior (±45d tolerance handles fiscal calendar drift).
  const latestMs = Date.parse(latest.date);
  const targetMs = latestMs - 365 * 24 * 60 * 60 * 1000;
  const tolMs = 45 * 24 * 60 * 60 * 1000;
  const priorYear = rows
    .slice(1)
    .map((r) => ({ r, diff: Math.abs(Date.parse(r.date) - targetMs) }))
    .filter((x) => x.diff <= tolMs)
    .sort((a, b) => a.diff - b.diff)[0]?.r;
  if (!priorYear || priorYear.revenue === 0) return null;
  return ((latest.revenue - priorYear.revenue) / Math.abs(priorYear.revenue)) * 100;
}

/**
 * Extract last earnings actual/est from getEarnings. Find the most recent
 * row with a report_date <= today AND a populated actual.
 */
function parseLastEarnings(raw: unknown, todayIso: string): Pick<FundamentalsRow, 'last_earnings_actual_eps' | 'last_earnings_est_eps' | 'last_earnings_surprise_pct'> {
  const u = unwrap(raw);
  const list: Array<Record<string, unknown>> = Array.isArray(u) ? (u as Array<Record<string, unknown>>) : [];
  const prior: Array<{ date: string; actual: number | null; est: number | null }> = [];
  for (const r of list) {
    const d = r.report_date ?? r.date ?? r.earnings_date ?? r.announce_date;
    if (typeof d !== 'string') continue;
    const m = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    if (m[1] >= todayIso) continue;
    prior.push({
      date: m[1],
      actual: numOrNull(r.eps_actual ?? r.actual ?? r.reported_eps),
      est:    numOrNull(r.eps_estimate ?? r.estimate ?? r.consensus_eps),
    });
  }
  prior.sort((a, b) => b.date.localeCompare(a.date));
  const latest = prior.find((p) => p.actual !== null);
  if (!latest) {
    return { last_earnings_actual_eps: null, last_earnings_est_eps: null, last_earnings_surprise_pct: null };
  }
  const actual = latest.actual;
  const est = latest.est;
  const surprise =
    actual !== null && est !== null && est !== 0
      ? ((actual - est) / Math.abs(est)) * 100
      : null;
  return {
    last_earnings_actual_eps: actual,
    last_earnings_est_eps: est,
    last_earnings_surprise_pct: surprise,
  };
}

function countPopulated(row: FundamentalsRow): number {
  const keys: (keyof FundamentalsRow)[] = [
    'eps_ttm', 'revenue_ttm', 'pe_ratio', 'market_cap',
    'last_earnings_actual_eps', 'last_earnings_est_eps',
    'last_earnings_surprise_pct', 'revenue_yoy_growth_pct',
  ];
  return keys.filter((k) => row[k] !== null).length;
}

async function isFresh(supabase: SupabaseClient, ticker: string, todayIso: string): Promise<boolean> {
  try {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - TTL_DAYS);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('ct_fundamentals_cache')
      .select('as_of_date')
      .eq('ticker', ticker)
      .gte('as_of_date', cutoffIso)
      .order('as_of_date', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn(`[ct-fundamentals-sync] fresh-check failed for ${ticker}:`, error.message);
      return false; // safer to refetch than to skip on an error
    }
    return !!data && typeof data.as_of_date === 'string' && data.as_of_date <= todayIso;
  } catch (err) {
    console.warn(`[ct-fundamentals-sync] fresh-check threw for ${ticker}:`, (err as Error).message);
    return false;
  }
}

async function syncTicker(supabase: SupabaseClient, ticker: string, todayIso: string): Promise<SyncResult> {
  try {
    if (await isFresh(supabase, ticker, todayIso)) {
      return { ticker, action: 'skipped_fresh' };
    }

    // Fetch all three endpoints. Any individual failure → that section stays
    // null; we still upsert the partial row so the UI has SOMETHING.
    const [finRaw, incRaw, earnRaw] = await Promise.allSettled([
      getFinancials(ticker),
      getIncomeStatements(ticker),
      getEarnings(ticker),
    ]);

    const fin = finRaw.status === 'fulfilled'
      ? parseFinancials(finRaw.value)
      : { eps_ttm: null, revenue_ttm: null, pe_ratio: null, market_cap: null };
    const revYoY = incRaw.status === 'fulfilled' ? parseRevenueYoY(incRaw.value) : null;
    const lastEarn = earnRaw.status === 'fulfilled'
      ? parseLastEarnings(earnRaw.value, todayIso)
      : { last_earnings_actual_eps: null, last_earnings_est_eps: null, last_earnings_surprise_pct: null };

    if (finRaw.status === 'rejected')  console.warn(`[ct-fundamentals-sync] ${ticker} financials failed:`, (finRaw.reason as Error)?.message);
    if (incRaw.status === 'rejected')  console.warn(`[ct-fundamentals-sync] ${ticker} income-statements failed:`, (incRaw.reason as Error)?.message);
    if (earnRaw.status === 'rejected') console.warn(`[ct-fundamentals-sync] ${ticker} earnings failed:`, (earnRaw.reason as Error)?.message);

    const row: FundamentalsRow = {
      ticker,
      as_of_date: todayIso,
      eps_ttm: fin.eps_ttm,
      revenue_ttm: fin.revenue_ttm,
      pe_ratio: fin.pe_ratio,
      market_cap: fin.market_cap,
      last_earnings_actual_eps: lastEarn.last_earnings_actual_eps,
      last_earnings_est_eps: lastEarn.last_earnings_est_eps,
      last_earnings_surprise_pct: lastEarn.last_earnings_surprise_pct,
      revenue_yoy_growth_pct: revYoY,
    };

    const populated = countPopulated(row);
    // If every numeric field came back null, treat as an error so the summary
    // surfaces the dead-ticker condition. Still log + skip, don't crash.
    if (populated === 0) {
      console.warn(`[ct-fundamentals-sync] ${ticker} returned zero populated fields — not upserting.`);
      return { ticker, action: 'error', error: 'no_data', fields_populated: 0 };
    }

    const { error } = await supabase
      .from('ct_fundamentals_cache')
      .upsert(
        { ...row, fetched_at: new Date().toISOString() },
        { onConflict: 'ticker,as_of_date' },
      );
    if (error) {
      console.warn(`[ct-fundamentals-sync] upsert failed for ${ticker}:`, error.message);
      return { ticker, action: 'error', error: error.message };
    }
    return { ticker, action: 'upserted', fields_populated: populated };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[ct-fundamentals-sync] ${ticker} threw:`, msg);
    return { ticker, action: 'error', error: msg };
  }
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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const startedAt = Date.now();
  const todayIso = new Date().toISOString().slice(0, 10);

  const watchlist = await getWatchlist(supabase);
  const results: SyncResult[] = [];
  // Serial: UW per-stock endpoints are not rate-sensitive here (36 calls/week
  // spread over ~30s), and serial keeps the log output coherent.
  for (const ticker of watchlist) {
    results.push(await syncTicker(supabase, ticker, todayIso));
  }

  const summary = {
    upserted:      results.filter((r) => r.action === 'upserted').length,
    skipped_fresh: results.filter((r) => r.action === 'skipped_fresh').length,
    errors:        results.filter((r) => r.action === 'error').length,
  };

  return new Response(JSON.stringify({
    success: true,
    ttl_days: TTL_DAYS,
    as_of: todayIso,
    summary,
    results,
    duration_ms: Date.now() - startedAt,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
