/**
 * ct-earnings-moves-sync — weekly backfill of per-ticker historical day-after
 * earnings moves into ct_earnings_moves.
 *
 * Runs Sunday 22:15 UTC (right after ct-fundamentals-sync at 22:00). For each
 * watchlist ticker:
 *   1. Pull up to 8 past quarters from ct_events
 *      WHERE event_type='earnings' AND event_date < today
 *      ORDER BY event_date DESC LIMIT 8
 *   2. Derive pre/post session marks:
 *        BMO     → pre = prior_trading_day close, post = report_date close
 *        AMC     → pre = report_date close,       post = next_trading_day close
 *        intraday/null → treated as AMC (conservative — the market close on
 *                        report_date has "seen" the print for intraday reports)
 *   3. Resolve each close from the thin price pipeline in priority order:
 *        a. ct_spy_daily (SPY only, authoritative daily close)
 *        b. ct_price_ticks — if a tick exists at or after 15:55 ET on the
 *           target date, use the latest one (≈ close). 7-day retention so
 *           this only helps the most recent quarter.
 *        c. ct_heartbeats.current_reads — scan heartbeats whose created_at
 *           falls within ±30 min of 20:00 UTC on the target date; extract
 *           current_reads[ticker].price.
 *      If no source produced a price, the column stays null and
 *      `reason` is set to 'no_pre_source' / 'no_post_source' / 'both_missing'.
 *   4. Compute move_pct + move_direction. Pull beat_miss + surprise_pct from
 *      ct_fundamentals_cache (its last_earnings_surprise_pct is the most
 *      recent quarter only; older quarters carry null surprise — honest).
 *   5. Upsert into ct_earnings_moves on (ticker, report_date).
 *
 * Every ticker is wrapped in try/catch — one failure never kills the batch.
 *
 * BUDGET
 *   DB-only. No UW calls. 12 × 8 × (a handful of pg reads) — cheap.
 *
 * THIN-HISTORY EXPECTATION
 *   On first run we expect the bulk of the 96 target rows to insert with
 *   null prices (+ reason='both_missing') because ct_spy_daily is SPY-only
 *   and ct_price_ticks only retains 7 days. Only the 1-2 most-recent
 *   quarters — and only for tickers where heartbeats/ticks covered the
 *   relevant sessions — will have filled prices. That's OK. The table
 *   exists so coverage accumulates forward, not backward.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

const QUARTERS_PER_TICKER = 8;

// ─── helpers ────────────────────────────────────────────────────────────

function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map((n) => parseInt(n, 10));
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Previous/next weekday skipping Sat/Sun. Holidays ignored — best-effort. */
function adjacentTradingDay(iso: string, direction: 'prev' | 'next'): string {
  const step = direction === 'prev' ? -1 : 1;
  let candidate = addDaysISO(iso, step);
  for (let i = 0; i < 5; i++) {
    const [y, m, d] = candidate.split('-').map((n) => parseInt(n, 10));
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) return candidate;
    candidate = addDaysISO(candidate, step);
  }
  return candidate; // fallback — shouldn't ever reach
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─── price resolvers ────────────────────────────────────────────────────

async function closeFromSpyDaily(
  supabase: SupabaseClient,
  ticker: string,
  dateIso: string,
): Promise<number | null> {
  if (ticker !== 'SPY') return null;
  const { data, error } = await supabase
    .from('ct_spy_daily')
    .select('close')
    .eq('date', dateIso)
    .maybeSingle();
  if (error || !data) return null;
  return numOrNull((data as { close: unknown }).close);
}

async function closeFromPriceTicks(
  supabase: SupabaseClient,
  ticker: string,
  dateIso: string,
): Promise<number | null> {
  // "Close" ≈ last tick captured on that calendar date in UTC. ct_price_ticks
  // has 7-day retention, so this only helps the most recent quarter.
  const dayStart = `${dateIso}T00:00:00.000Z`;
  const dayEnd = `${dateIso}T23:59:59.999Z`;
  const { data, error } = await supabase
    .from('ct_price_ticks')
    .select('price, tick_time')
    .eq('ticker', ticker)
    .gte('tick_time', dayStart)
    .lte('tick_time', dayEnd)
    .order('tick_time', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return numOrNull((data as { price: unknown }).price);
}

async function closeFromHeartbeats(
  supabase: SupabaseClient,
  ticker: string,
  dateIso: string,
): Promise<number | null> {
  // Heartbeats around the US cash close (≈20:00–21:00 UTC). Scan a wider
  // window and pick the latest heartbeat whose current_reads[ticker].price
  // is usable. This is best-effort — heartbeats are the only multi-week
  // per-ticker price source we have today.
  const winStart = `${dateIso}T19:00:00.000Z`;
  const winEnd = `${dateIso}T23:59:59.999Z`;
  const { data, error } = await supabase
    .from('ct_heartbeats')
    .select('current_reads, created_at')
    .gte('created_at', winStart)
    .lte('created_at', winEnd)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error || !data) return null;

  for (const row of data as Array<{ current_reads: unknown }>) {
    const reads = row.current_reads;
    if (!reads || typeof reads !== 'object') continue;
    const perTicker = (reads as Record<string, unknown>)[ticker];
    if (!perTicker || typeof perTicker !== 'object') continue;
    const px = (perTicker as Record<string, unknown>).price;
    const n = numOrNull(px);
    if (n !== null && n > 0) return n;
  }
  return null;
}

async function resolveClose(
  supabase: SupabaseClient,
  ticker: string,
  dateIso: string,
): Promise<number | null> {
  // Priority: SPY daily > price ticks > heartbeats. Each resolver returns
  // null cheaply when it can't help, so this short-circuits fast.
  const viaSpy = await closeFromSpyDaily(supabase, ticker, dateIso);
  if (viaSpy !== null) return viaSpy;
  const viaTicks = await closeFromPriceTicks(supabase, ticker, dateIso);
  if (viaTicks !== null) return viaTicks;
  const viaHb = await closeFromHeartbeats(supabase, ticker, dateIso);
  return viaHb;
}

// ─── beat/miss classification ───────────────────────────────────────────

function classifySurprise(surprise_pct: number | null): 'beat' | 'miss' | 'inline' | null {
  if (surprise_pct === null || !Number.isFinite(surprise_pct)) return null;
  // ±1% band is "inline" — below 1%, markets typically don't react to the
  // consensus beat/miss. Tunable; mirrors street convention.
  if (surprise_pct > 1) return 'beat';
  if (surprise_pct < -1) return 'miss';
  return 'inline';
}

// ─── per-ticker sync ────────────────────────────────────────────────────

interface EarningsRow {
  ticker: string;
  event_date: string;
  report_time: string | null;
}

interface SyncOutcome {
  ticker: string;
  report_date: string;
  action: 'upserted' | 'error';
  filled: boolean;
  reason: string | null;
  error?: string;
}

async function fetchPastEarnings(
  supabase: SupabaseClient,
  ticker: string,
  todayIso: string,
): Promise<EarningsRow[]> {
  const { data, error } = await supabase
    .from('ct_events')
    .select('ticker, event_date, report_time')
    .eq('event_type', 'earnings')
    .eq('ticker', ticker)
    .lt('event_date', todayIso)
    .order('event_date', { ascending: false })
    .limit(QUARTERS_PER_TICKER);
  if (error) {
    console.warn(`[ct-earnings-moves-sync] fetch past earnings failed for ${ticker}:`, error.message);
    return [];
  }
  return (data ?? []) as EarningsRow[];
}

async function fetchLatestSurprise(
  supabase: SupabaseClient,
  ticker: string,
): Promise<{ date: string | null; surprise_pct: number | null }> {
  // ct_fundamentals_cache.last_earnings_surprise_pct is whatever the most
  // recent getEarnings pull saw as latest. We only tag the MOST RECENT row
  // of the 8 with this — older rows carry null surprise (honest).
  const { data, error } = await supabase
    .from('ct_fundamentals_cache')
    .select('as_of_date, last_earnings_surprise_pct')
    .eq('ticker', ticker)
    .order('as_of_date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return { date: null, surprise_pct: null };
  return {
    date: (data as { as_of_date?: string }).as_of_date ?? null,
    surprise_pct: numOrNull((data as { last_earnings_surprise_pct?: unknown }).last_earnings_surprise_pct),
  };
}

async function syncOneQuarter(
  supabase: SupabaseClient,
  row: EarningsRow,
  latestSurprise: number | null,
  isMostRecent: boolean,
): Promise<SyncOutcome> {
  const { ticker, event_date, report_time } = row;
  try {
    const rt = (report_time ?? '').toLowerCase();
    const isBMO = rt === 'bmo';
    // BMO: pre = prior trading day, post = report_date
    // AMC / intraday / null: pre = report_date, post = next trading day
    const preDate = isBMO ? adjacentTradingDay(event_date, 'prev') : event_date;
    const postDate = isBMO ? event_date : adjacentTradingDay(event_date, 'next');

    const [pre, post] = await Promise.all([
      resolveClose(supabase, ticker, preDate),
      resolveClose(supabase, ticker, postDate),
    ]);

    let move_pct: number | null = null;
    let move_direction: 'up' | 'down' | 'flat' | null = null;
    if (pre !== null && post !== null && pre !== 0) {
      move_pct = ((post - pre) / pre) * 100;
      move_direction = move_pct > 0.05 ? 'up' : move_pct < -0.05 ? 'down' : 'flat';
    }

    // Only the most-recent row gets surprise_pct from fundamentals_cache —
    // older quarters have no per-quarter surprise source in this project.
    const surprise = isMostRecent ? latestSurprise : null;
    const beat_miss = classifySurprise(surprise);

    let reason: string;
    if (pre !== null && post !== null) reason = 'filled';
    else if (pre === null && post === null) reason = 'both_missing';
    else if (pre === null) reason = 'no_pre_source';
    else reason = 'no_post_source';

    const record = {
      ticker,
      report_date: event_date,
      report_time: report_time ?? null,
      pre_earnings_close: pre,
      post_earnings_close: post,
      move_pct,
      move_direction,
      beat_miss,
      surprise_pct: surprise,
      reason,
      captured_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from('ct_earnings_moves')
      .upsert(record, { onConflict: 'ticker,report_date' });
    if (error) {
      console.warn(`[ct-earnings-moves-sync] upsert failed ${ticker} ${event_date}:`, error.message);
      return {
        ticker, report_date: event_date, action: 'error',
        filled: pre !== null && post !== null, reason, error: error.message,
      };
    }
    return {
      ticker, report_date: event_date, action: 'upserted',
      filled: pre !== null && post !== null, reason,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[ct-earnings-moves-sync] ${ticker} ${event_date} threw:`, msg);
    return {
      ticker, report_date: event_date, action: 'error',
      filled: false, reason: null, error: msg,
    };
  }
}

async function syncTicker(
  supabase: SupabaseClient,
  ticker: string,
  todayIso: string,
): Promise<SyncOutcome[]> {
  const past = await fetchPastEarnings(supabase, ticker, todayIso);
  if (past.length === 0) return [];

  const surprise = await fetchLatestSurprise(supabase, ticker);
  // Tag the row whose event_date matches the fundamentals_cache "latest" hit
  // as the surprise-bearing one. If the dates don't line up (unlikely but
  // possible) we fall back to tagging past[0] — the most recent report.
  const taggedIdx = (() => {
    if (!surprise.date) return 0;
    const match = past.findIndex((r) => r.event_date === surprise.date);
    return match >= 0 ? match : 0;
  })();

  const outcomes: SyncOutcome[] = [];
  for (let i = 0; i < past.length; i++) {
    outcomes.push(
      await syncOneQuarter(supabase, past[i], surprise.surprise_pct, i === taggedIdx),
    );
  }
  return outcomes;
}

// ─── handler ────────────────────────────────────────────────────────────

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

  const allOutcomes: SyncOutcome[] = [];
  for (const ticker of watchlist) {
    try {
      const out = await syncTicker(supabase, ticker, todayIso);
      allOutcomes.push(...out);
    } catch (e) {
      console.warn(`[ct-earnings-moves-sync] ${ticker} top-level threw:`, e instanceof Error ? e.message : String(e));
    }
  }

  const summary = {
    rows_processed: allOutcomes.length,
    upserted:       allOutcomes.filter((o) => o.action === 'upserted').length,
    errors:         allOutcomes.filter((o) => o.action === 'error').length,
    filled:         allOutcomes.filter((o) => o.filled).length,
    missing_prices: allOutcomes.filter((o) => !o.filled && o.action === 'upserted').length,
  };

  return new Response(JSON.stringify({
    success: true,
    as_of: todayIso,
    quarters_per_ticker: QUARTERS_PER_TICKER,
    summary,
    outcomes: allOutcomes,
    duration_ms: Date.now() - startedAt,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
