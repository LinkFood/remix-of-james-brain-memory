/**
 * ct-butterfly-grader — fills forward-window outcomes on cross events.
 *
 * Per PR #64 design pass § C.3. Two windows:
 *   - intraday_eod: 20:30 UTC weekday (post-RTH +30min). Fills 5/15/30/60min
 *     and EOD outcomes for crosses with cross_at on today's session_date.
 *   - nextclose: same cron tick, fills NextClose for crosses from prior
 *     trading day(s) where graded_at is null but next_close_at would be
 *     today's RTH close (now settled).
 *
 * Source: ct_price_bars (1m close per ticker) is the authoritative price
 * lookup. We pull bars in a single batch covering the relevant time range
 * for each ticker, then look up per-cross offsets in-memory.
 *
 * Computes hit_5min..hit_nextclose: TRUE if (price_target - price_at_cross)
 * sign matches direction (bullish → expect price up; bearish → expect down).
 *
 * Auth: service_role only.
 *
 * Returns: { ok, window, events_processed, events_graded, duration_ms, errors }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

type GraderWindow = 'intraday_eod' | 'nextclose';

interface CrossEventRow {
  id: string;
  ticker: string;
  session_date: string;
  cross_at: string;
  direction: 'bullish' | 'bearish';
  graded_at: string | null;
  hit_nextclose: boolean | null;
}

interface PriceBar {
  bar_ts: string;
  close: number;
}

function nyDateKey(iso: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value ?? '0000';
  const m = parts.find((p) => p.type === 'month')?.value ?? '00';
  const day = parts.find((p) => p.type === 'day')?.value ?? '00';
  return `${y}-${m}-${day}`;
}

function todayNyKey(): string {
  return nyDateKey(new Date().toISOString());
}

function eodMsForSession(sessionDate: string): number {
  // RTH close at 20:00 UTC during EDT — same caveat as detector.
  return Date.parse(`${sessionDate}T20:00:00Z`);
}

/** Find first weekday strictly after sessionDate (skip Sat/Sun). */
function nextWeekdayKey(sessionDate: string): string {
  const [y, m, d] = sessionDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  // step forward at least one day, then skip weekends
  for (let i = 0; i < 5; i++) {
    dt.setUTCDate(dt.getUTCDate() + 1);
    const wd = dt.getUTCDay();
    if (wd >= 1 && wd <= 5) {
      const yy = dt.getUTCFullYear();
      const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(dt.getUTCDate()).padStart(2, '0');
      return `${yy}-${mm}-${dd}`;
    }
  }
  return sessionDate;
}

async function loadUngraded(
  supabase: SupabaseClient,
  window: GraderWindow,
): Promise<CrossEventRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const today = todayNyKey();

  if (window === 'intraday_eod') {
    // Today's crosses, not yet graded for intraday windows. (graded_at can be
    // null only here — once intraday lands graded_at is set; nextclose
    // fills in a separate later UPDATE.)
    const { data, error } = await sb.from('ct_butterfly_cross_events')
      .select('id, ticker, session_date, cross_at, direction, graded_at, hit_nextclose')
      .eq('session_date', today)
      .is('graded_at', null)
      .order('cross_at', { ascending: true })
      .limit(2000);
    if (error) {
      console.warn('[ct-butterfly-grader] intraday load error:', error.message);
      return [];
    }
    return (data ?? []) as CrossEventRow[];
  }

  // nextclose: any row that has graded_at NOT null but hit_nextclose IS null,
  // AND whose session_date is today's prior weekday. (NextClose is the close
  // of the trading day AFTER the cross's session_date — we settle that the
  // moment that next session closes, which is now since we fire at 20:30 UTC.)
  const { data, error } = await sb.from('ct_butterfly_cross_events')
    .select('id, ticker, session_date, cross_at, direction, graded_at, hit_nextclose')
    .not('graded_at', 'is', null)
    .is('hit_nextclose', null)
    .order('cross_at', { ascending: true })
    .limit(2000);
  if (error) {
    console.warn('[ct-butterfly-grader] nextclose load error:', error.message);
    return [];
  }
  // Filter to events whose next-trading-day session_date is today.
  const rows = (data ?? []) as CrossEventRow[];
  return rows.filter((r) => nextWeekdayKey(r.session_date) === today);
}

async function loadPriceBarsForTicker(
  supabase: SupabaseClient,
  ticker: string,
  fromIso: string,
  toIso: string,
): Promise<PriceBar[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const { data, error } = await sb.from('ct_price_bars')
    .select('ts, close')
    .eq('ticker', ticker)
    .eq('timeframe', '1m')
    .gte('ts', fromIso)
    .lte('ts', toIso)
    .order('ts', { ascending: true })
    .limit(2000);
  if (error || !Array.isArray(data)) return [];
  return (data as Array<{ ts: string; close: number | string }>).map((r) => ({
    bar_ts: r.ts,
    close: typeof r.close === 'number' ? r.close : Number(r.close),
  }));
}

/** Find the price bar at-or-after a target ms; null if no bar in range. */
function priceAtOrAfter(bars: readonly PriceBar[], targetMs: number): number | null {
  for (const b of bars) {
    if (Date.parse(b.bar_ts) >= targetMs) {
      return Number.isFinite(b.close) ? b.close : null;
    }
  }
  return null;
}

/** Find the price bar at-or-before a target ms; null if no bar in range. */
function priceAtOrBefore(bars: readonly PriceBar[], targetMs: number): number | null {
  let chosen: number | null = null;
  for (const b of bars) {
    if (Date.parse(b.bar_ts) <= targetMs) {
      const v = Number.isFinite(b.close) ? b.close : null;
      if (v !== null) chosen = v;
    } else {
      break;
    }
  }
  return chosen;
}

function computeHit(
  direction: 'bullish' | 'bearish',
  priceAtCross: number | null,
  priceTarget: number | null,
): boolean | null {
  if (priceAtCross === null || priceTarget === null) return null;
  const delta = priceTarget - priceAtCross;
  if (direction === 'bullish') return delta > 0;
  return delta < 0;
}

interface IntradayGrade {
  id: string;
  price_at_cross: number | null;
  price_5min: number | null;
  price_15min: number | null;
  price_30min: number | null;
  price_60min: number | null;
  price_eod: number | null;
  hit_5min: boolean | null;
  hit_15min: boolean | null;
  hit_30min: boolean | null;
  hit_60min: boolean | null;
  hit_eod: boolean | null;
}

async function gradeIntradayForTicker(
  supabase: SupabaseClient,
  ticker: string,
  events: readonly CrossEventRow[],
): Promise<IntradayGrade[]> {
  if (events.length === 0) return [];
  // Pull bars from earliest cross_at minus 1m through EOD.
  const earliestMs = Math.min(...events.map((e) => Date.parse(e.cross_at)));
  const sessionDate = events[0].session_date;
  const eodMs = eodMsForSession(sessionDate);
  const bars = await loadPriceBarsForTicker(
    supabase,
    ticker,
    new Date(earliestMs - 60_000).toISOString(),
    new Date(eodMs + 60_000).toISOString(),
  );

  return events.map((e) => {
    const crossMs = Date.parse(e.cross_at);
    const priceAtCross = priceAtOrAfter(bars, crossMs);
    const p5 = priceAtOrAfter(bars, crossMs + 5 * 60_000);
    const p15 = priceAtOrAfter(bars, crossMs + 15 * 60_000);
    const p30 = priceAtOrAfter(bars, crossMs + 30 * 60_000);
    const p60 = priceAtOrAfter(bars, crossMs + 60 * 60_000);
    const pEod = priceAtOrBefore(bars, eodMs);
    return {
      id: e.id,
      price_at_cross: priceAtCross,
      price_5min: p5,
      price_15min: p15,
      price_30min: p30,
      price_60min: p60,
      price_eod: pEod,
      hit_5min: computeHit(e.direction, priceAtCross, p5),
      hit_15min: computeHit(e.direction, priceAtCross, p15),
      hit_30min: computeHit(e.direction, priceAtCross, p30),
      hit_60min: computeHit(e.direction, priceAtCross, p60),
      hit_eod: computeHit(e.direction, priceAtCross, pEod),
    };
  });
}

interface NextCloseGrade {
  id: string;
  price_nextclose: number | null;
  next_close_at: string;
  hit_nextclose: boolean | null;
}

async function gradeNextCloseForTicker(
  supabase: SupabaseClient,
  ticker: string,
  events: readonly CrossEventRow[],
): Promise<NextCloseGrade[]> {
  if (events.length === 0) return [];
  // For each event, NextClose target = close of session AFTER session_date.
  // All events here share the property next_session = today (we filtered).
  const today = todayNyKey();
  const eodMs = eodMsForSession(today);
  // Pull a wide window covering all events' cross_ats up through today's EOD.
  const earliestMs = Math.min(...events.map((e) => Date.parse(e.cross_at)));
  const bars = await loadPriceBarsForTicker(
    supabase,
    ticker,
    new Date(earliestMs - 60_000).toISOString(),
    new Date(eodMs + 60_000).toISOString(),
  );

  // We need price_at_cross for the original cross_at (already saved as
  // price_at_cross in DB during intraday grade — re-load it).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const ids = events.map((e) => e.id);
  const { data: priceRows } = await sb.from('ct_butterfly_cross_events')
    .select('id, price_at_cross')
    .in('id', ids);
  const priceMap = new Map<string, number | null>();
  if (Array.isArray(priceRows)) {
    for (const r of priceRows as Array<{ id: string; price_at_cross: number | string | null }>) {
      const v = r.price_at_cross == null ? null : Number(r.price_at_cross);
      priceMap.set(r.id, Number.isFinite(v) ? v : null);
    }
  }

  const pNextClose = priceAtOrBefore(bars, eodMs);
  const nextCloseAt = new Date(eodMs).toISOString();
  return events.map((e) => ({
    id: e.id,
    price_nextclose: pNextClose,
    next_close_at: nextCloseAt,
    hit_nextclose: computeHit(e.direction, priceMap.get(e.id) ?? null, pNextClose),
  }));
}

async function persistIntradayGrades(
  supabase: SupabaseClient,
  grades: readonly IntradayGrade[],
): Promise<number> {
  if (grades.length === 0) return 0;
  let updated = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  const gradedAt = new Date().toISOString();
  // PostgREST UPDATE-by-id is per-row; chunk the updates.
  for (const g of grades) {
    const { error } = await sb.from('ct_butterfly_cross_events')
      .update({
        price_at_cross: g.price_at_cross,
        price_5min: g.price_5min,
        price_15min: g.price_15min,
        price_30min: g.price_30min,
        price_60min: g.price_60min,
        price_eod: g.price_eod,
        hit_5min: g.hit_5min,
        hit_15min: g.hit_15min,
        hit_30min: g.hit_30min,
        hit_60min: g.hit_60min,
        hit_eod: g.hit_eod,
        graded_at: gradedAt,
        price_source: 'ct_price_bars:1m',
      })
      .eq('id', g.id);
    if (!error) updated += 1;
  }
  return updated;
}

async function persistNextCloseGrades(
  supabase: SupabaseClient,
  grades: readonly NextCloseGrade[],
): Promise<number> {
  if (grades.length === 0) return 0;
  let updated = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;
  for (const g of grades) {
    const { error } = await sb.from('ct_butterfly_cross_events')
      .update({
        price_nextclose: g.price_nextclose,
        next_close_at: g.next_close_at,
        hit_nextclose: g.hit_nextclose,
      })
      .eq('id', g.id);
    if (!error) updated += 1;
  }
  return updated;
}

interface GraderStats {
  ok: boolean;
  window: GraderWindow;
  events_processed: number;
  events_graded: number;
  duration_ms: number;
  errors: string[];
}

serve(async (request: Request): Promise<Response> => {
  const corsResponse = handleCors(request);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(request);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  if (!isServiceRoleRequest(request)) {
    return new Response(
      JSON.stringify({ ok: false, error: 'unauthorized' }),
      { status: 401, headers: jsonHeaders },
    );
  }

  const startedAt = Date.now();
  const errors: string[] = [];

  let body: { window?: GraderWindow } = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const window: GraderWindow = body.window === 'nextclose' ? 'nextclose' : 'intraday_eod';

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const events = await loadUngraded(supabase, window);
    if (events.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          window,
          events_processed: 0,
          events_graded: 0,
          duration_ms: Date.now() - startedAt,
          errors: [],
        } satisfies GraderStats),
        { status: 200, headers: jsonHeaders },
      );
    }

    // Group events by ticker — bars load per ticker.
    const byTicker = new Map<string, CrossEventRow[]>();
    for (const e of events) {
      const arr = byTicker.get(e.ticker) ?? [];
      arr.push(e);
      byTicker.set(e.ticker, arr);
    }

    let totalGraded = 0;
    for (const [ticker, group] of byTicker.entries()) {
      try {
        if (window === 'intraday_eod') {
          const grades = await gradeIntradayForTicker(supabase, ticker, group);
          totalGraded += await persistIntradayGrades(supabase, grades);
        } else {
          const grades = await gradeNextCloseForTicker(supabase, ticker, group);
          totalGraded += await persistNextCloseGrades(supabase, grades);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown_error';
        errors.push(`${ticker}: ${msg}`);
      }
    }

    const stats: GraderStats = {
      ok: true,
      window,
      events_processed: events.length,
      events_graded: totalGraded,
      duration_ms: Date.now() - startedAt,
      errors,
    };

    return new Response(JSON.stringify(stats), { status: 200, headers: jsonHeaders });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown_error';
    return new Response(
      JSON.stringify({
        ok: false,
        window,
        error: msg,
        duration_ms: Date.now() - startedAt,
      }),
      { status: 500, headers: jsonHeaders },
    );
  }
});
