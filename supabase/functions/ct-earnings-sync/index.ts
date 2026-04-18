/**
 * ct-earnings-sync — weekly pull of earnings calendar for the 12 watchlist
 * tickers + upsert into ct_events.
 *
 * Runs Sunday 12:00 UTC (pre-week). Per ticker:
 *   1. getEarnings(ticker) — UW's per-stock earnings history + upcoming row
 *   2. Pick the NEXT upcoming report within the next 30 days
 *   3. Snapshot current iv_rank from ct_iv_rank_daily (most recent row)
 *   4. Upsert into ct_events on (event_type='earnings', ticker, event_date, title)
 *      carrying report_time / eps_estimate / prev_actual / iv_rank_at_capture
 *
 * 12 tickers × 1 UW call/week = 12 calls/week. Trivial.
 *
 * Does NOT duplicate or conflict with ct-event-calendar-ingester:
 *   - ingester writes pre/afterhours bulk calendars with title shape
 *     "<company> earnings (premarket|afterhours)" (exact date match wins).
 *   - sync writes per-ticker title "<TICKER> earnings" — a distinct row
 *     under the UNIQUE (event_type, ticker, event_date, title) key, carrying
 *     the richer fields the pre-event-check consumes.
 *
 * If sync finds the same (ticker, event_date) the ingester already wrote,
 * we UPDATE the existing row to layer on eps_estimate / prev_actual /
 * iv_rank_at_capture / report_time without changing event_type/date/title.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getEarnings } from '../_shared/uwClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

const LOOKAHEAD_DAYS = 30;

type ReportTime = 'bmo' | 'amc' | 'intraday';

interface EarningsRow {
  ticker: string;
  report_date: string;            // YYYY-MM-DD
  report_time: ReportTime | null; // 'bmo' = before open, 'amc' = after close, 'intraday' = during session
  eps_estimate: number | null;
  prev_actual: number | null;
}

interface SyncResult {
  ticker: string;
  found: boolean;
  report_date: string | null;
  report_time: ReportTime | null;
  iv_rank: number | null;
  action: 'inserted' | 'updated' | 'none' | 'error';
  error?: string;
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * UW's earnings endpoint returns a list of historical + upcoming quarters.
 * The shape varies slightly across endpoints, so we match defensively:
 *   - report_date | date | earnings_date : any ISO YYYY-MM-DD
 *   - eps_estimate | estimate | consensus_eps
 *   - eps_actual | actual | reported_eps
 *   - time | report_time | session : 'bmo' | 'amc' | 'pre' | 'post' | 'intraday' | time-of-day
 */
function pickNextEarnings(raw: unknown, ticker: string, todayIso: string, horizonIso: string): EarningsRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const list: Array<Record<string, unknown>> = Array.isArray((raw as { data?: unknown }).data)
    ? ((raw as { data: Array<Record<string, unknown>> }).data)
    : Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];

  // Find all upcoming rows with a parseable date, then pick the soonest.
  const upcoming: Array<{ date: string; row: Record<string, unknown> }> = [];
  for (const r of list) {
    const dateRaw = (r.report_date ?? r.date ?? r.earnings_date ?? r.announce_date) as string | undefined;
    if (typeof dateRaw !== 'string') continue;
    const m = dateRaw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    const dateStr = m[1];
    if (dateStr < todayIso || dateStr > horizonIso) continue;
    upcoming.push({ date: dateStr, row: r });
  }
  if (upcoming.length === 0) return null;
  upcoming.sort((a, b) => a.date.localeCompare(b.date));
  const { date, row } = upcoming[0];

  // Find the most recent PRIOR actual (for prev_actual).
  let prevActual: number | null = null;
  const prior: Array<{ date: string; actual: number | null }> = [];
  for (const r of list) {
    const d = (r.report_date ?? r.date ?? r.earnings_date) as string | undefined;
    if (typeof d !== 'string') continue;
    const mm = d.match(/^(\d{4}-\d{2}-\d{2})/);
    if (!mm) continue;
    if (mm[1] >= todayIso) continue;
    prior.push({ date: mm[1], actual: numOrNull(r.eps_actual ?? r.actual ?? r.reported_eps) });
  }
  prior.sort((a, b) => b.date.localeCompare(a.date));
  prevActual = prior.find((p) => p.actual !== null)?.actual ?? null;

  // report_time normalization
  let reportTime: ReportTime | null = null;
  const rawT = (row.time ?? row.report_time ?? row.session) as string | undefined;
  if (typeof rawT === 'string') {
    const tLower = rawT.toLowerCase().trim();
    if (tLower === 'bmo' || tLower === 'pre' || tLower === 'premarket' || tLower === 'before open') reportTime = 'bmo';
    else if (tLower === 'amc' || tLower === 'post' || tLower === 'afterhours' || tLower === 'after close') reportTime = 'amc';
    else if (tLower === 'intraday' || tLower === 'during' || tLower === 'mid') reportTime = 'intraday';
    // UW sometimes returns HH:MM:SS — map early to bmo, late to amc, middle to intraday.
    const hm = tLower.match(/^(\d{1,2}):/);
    if (!reportTime && hm) {
      const h = parseInt(hm[1], 10);
      if (h < 9) reportTime = 'bmo';
      else if (h >= 16) reportTime = 'amc';
      else reportTime = 'intraday';
    }
  }

  return {
    ticker,
    report_date: date,
    report_time: reportTime,
    eps_estimate: numOrNull(row.eps_estimate ?? row.estimate ?? row.consensus_eps),
    prev_actual: prevActual,
  };
}

async function fetchLatestIvRank(supabase: SupabaseClient, ticker: string): Promise<number | null> {
  try {
    const { data } = await supabase
      .from('ct_iv_rank_daily')
      .select('iv_rank')
      .eq('ticker', ticker)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();
    return (data?.iv_rank as number | undefined) ?? null;
  } catch {
    return null;
  }
}

async function upsertEarnings(
  supabase: SupabaseClient,
  row: EarningsRow,
  ivRank: number | null,
): Promise<'inserted' | 'updated' | 'none' | 'error'> {
  // First, look for ANY existing ct_events row for this (ticker, event_date, event_type=earnings)
  // regardless of title — ingester may have written a title-variant row already.
  const { data: existing, error: readErr } = await supabase
    .from('ct_events')
    .select('id,title')
    .eq('event_type', 'earnings')
    .eq('ticker', row.ticker)
    .eq('event_date', row.report_date)
    .limit(1);
  if (readErr) {
    console.warn(`[ct-earnings-sync] read ct_events failed for ${row.ticker}:`, readErr.message);
    return 'error';
  }

  const nowIso = new Date().toISOString();
  const payloadPatch: Record<string, unknown> = {
    report_time: row.report_time,
    eps_estimate: row.eps_estimate,
    prev_actual: row.prev_actual,
    iv_rank_at_capture: ivRank,
    updated_at: nowIso,
  };

  if (existing && existing.length > 0) {
    const id = existing[0].id as string;
    const { error } = await supabase.from('ct_events').update(payloadPatch).eq('id', id);
    if (error) {
      console.warn(`[ct-earnings-sync] update failed for ${row.ticker}:`, error.message);
      return 'error';
    }
    return 'updated';
  }

  // No existing row — insert a per-ticker canonical row.
  const { error } = await supabase.from('ct_events').insert({
    event_type: 'earnings',
    ticker: row.ticker,
    event_date: row.report_date,
    event_time: null,
    title: `${row.ticker} earnings`,
    importance: null,
    raw: { source: 'ct-earnings-sync' },
    report_time: row.report_time,
    eps_estimate: row.eps_estimate,
    prev_actual: row.prev_actual,
    iv_rank_at_capture: ivRank,
    updated_at: nowIso,
  });
  if (error) {
    // Unique constraint collision means a concurrent row was written — treat as updated.
    if (/duplicate|unique/i.test(error.message)) return 'updated';
    console.warn(`[ct-earnings-sync] insert failed for ${row.ticker}:`, error.message);
    return 'error';
  }
  return 'inserted';
}

async function syncTicker(supabase: SupabaseClient, ticker: string, todayIso: string, horizonIso: string): Promise<SyncResult> {
  try {
    const raw = await getEarnings(ticker);
    const next = pickNextEarnings(raw, ticker, todayIso, horizonIso);
    if (!next) {
      return { ticker, found: false, report_date: null, report_time: null, iv_rank: null, action: 'none' };
    }
    const ivRank = await fetchLatestIvRank(supabase, ticker);
    const action = await upsertEarnings(supabase, next, ivRank);
    return {
      ticker,
      found: true,
      report_date: next.report_date,
      report_time: next.report_time,
      iv_rank: ivRank,
      action,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[ct-earnings-sync] ${ticker} threw:`, msg);
    return { ticker, found: false, report_date: null, report_time: null, iv_rank: null, action: 'error', error: msg };
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
  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() + LOOKAHEAD_DAYS);
  const horizonIso = horizon.toISOString().slice(0, 10);

  const results: SyncResult[] = [];
  // Serial to stay gentle on UW's per-stock endpoint — N calls where N is
  // the configured watchlist size (default 12, max 16 per UW budget
  // discipline). One ct_config read resolves the list.
  const watchlist = await getWatchlist(supabase);
  for (const ticker of watchlist) {
    results.push(await syncTicker(supabase, ticker, todayIso, horizonIso));
  }

  const summary = {
    found: results.filter((r) => r.found).length,
    inserted: results.filter((r) => r.action === 'inserted').length,
    updated: results.filter((r) => r.action === 'updated').length,
    none: results.filter((r) => r.action === 'none').length,
    errors: results.filter((r) => r.action === 'error').length,
  };

  return new Response(JSON.stringify({
    success: true,
    horizon_days: LOOKAHEAD_DAYS,
    as_of: todayIso,
    summary,
    results,
    duration_ms: Date.now() - startedAt,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
