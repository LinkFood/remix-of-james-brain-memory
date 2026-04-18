/**
 * ct-correlation-compute — daily pairwise correlation of the watchlist.
 *
 * Runs weekdays at 22:00 UTC (after the US EOD close at 21:00 UTC).
 *
 * Pipeline:
 *   1. Load the watchlist (tunable, usually 12 tickers) from ct_config.
 *   2. Pull the last LOOKBACK_DAYS (30) of daily closes per ticker:
 *        - Prefer ct_price_ticks — finer granularity, but only 7-day
 *          retention, so it can only supply the tail of a 30-day window.
 *        - Fall back to ct_heartbeats — 15-min resolution, longer history.
 *        - Strategy: for each session date, take the LAST tick/heartbeat
 *          of the session as that day's "close" sample. Two sources are
 *          merged per-date; tick source wins when both are available.
 *   3. Compute daily returns → Pearson correlation per pair.
 *   4. Also compute the last-20-day rolling correlation (subset of 30).
 *   5. Upsert one row per unordered pair (ticker_a <= ticker_b) plus
 *      the 12 diagonal rows at correlation = 1.0.
 *
 * GRACEFUL THIN-HISTORY:
 *   - If a ticker has < 7 paired daily returns we still emit rows for
 *     every pair it participates in, with sample_size < 7 and pearson
 *     either computed-or-NaN-as-null. The UI treats sample_size < 7 as
 *     "insufficient — warming up".
 *
 * COST: ~66 unique pair computations once per weekday. < 1 sec compute,
 * no external API calls. The only heavy read is the heartbeat fetch —
 * bounded by 30 days × ~30 heartbeats/day = 900 rows per ticker max.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import { pearson, rollingPearson, toReturns } from './correlation.ts';

const LOOKBACK_DAYS     = 30;
const ROLLING_WINDOW    = 20;
const MIN_SAMPLE        = 7;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface DailyClose {
  session_date: string; // YYYY-MM-DD (UTC date of the sample)
  price: number;
}

interface HeartbeatRow {
  created_at: string;
  current_reads: {
    _snapshot?: {
      per_ticker?: Record<string, { price?: number | null } | null>;
    };
  } | null;
}

interface CacheRow {
  ticker_a: string;
  ticker_b: string;
  correlation_pearson: number | null;
  correlation_rolling_20d: number | null;
  sample_size: number;
  lookback_days: number;
  computed_at: string;
}

// ---------------------------------------------------------------------------
// Date helpers (UTC calendar dates — we're aligning end-of-session samples)
// ---------------------------------------------------------------------------
function toDateKey(iso: string): string {
  // The US session closes at 21:00 UTC (16:00 ET during DST, 21:00 UTC).
  // We bucket every tick/heartbeat into the UTC calendar date of its
  // timestamp. This is safe because the cron fires at 22:00 UTC — well
  // past any stray late prints — and all samples for session D land on
  // date D in UTC.
  return iso.slice(0, 10);
}

// ---------------------------------------------------------------------------
// Price loaders
// ---------------------------------------------------------------------------
/**
 * Load daily closes for a ticker from ct_price_ticks (2-min resolution,
 * 7-day retention). Returns one sample per UTC date = the LATEST tick of
 * that date. Returns an empty array on error (caller falls back).
 */
async function loadClosesFromTicks(
  supabase: SupabaseClient,
  ticker: string,
  sinceIso: string,
): Promise<DailyClose[]> {
  try {
    const { data, error } = await supabase
      .from('ct_price_ticks')
      .select('tick_time, price')
      .eq('ticker', ticker)
      .gte('tick_time', sinceIso)
      .order('tick_time', { ascending: true });
    if (error) {
      console.warn(`[ct-correlation-compute] ticks read failed for ${ticker}:`, error.message);
      return [];
    }
    const byDate = new Map<string, DailyClose>();
    for (const row of (data ?? []) as Array<{ tick_time: string; price: number | string | null }>) {
      const price = Number(row.price);
      if (!Number.isFinite(price)) continue;
      const dateKey = toDateKey(row.tick_time);
      // LATEST wins because rows are sorted ascending — later rows overwrite.
      byDate.set(dateKey, { session_date: dateKey, price });
    }
    return [...byDate.values()].sort((a, b) => a.session_date.localeCompare(b.session_date));
  } catch (err) {
    console.warn(`[ct-correlation-compute] ticks read threw for ${ticker}:`, (err as Error).message);
    return [];
  }
}

/**
 * Load daily closes from ct_heartbeats._snapshot.per_ticker[T].price.
 * Heartbeats cover a longer window than ticks (no 7-day retention),
 * so this is the primary loader for a 30-day lookback.
 *
 * We fetch every heartbeat in the window ONCE (one query, all tickers)
 * and fan out to per-ticker results in memory — much cheaper than 12
 * separate per-ticker heartbeat scans.
 */
async function loadAllClosesFromHeartbeats(
  supabase: SupabaseClient,
  tickers: string[],
  sinceIso: string,
): Promise<Map<string, DailyClose[]>> {
  const out = new Map<string, DailyClose[]>();
  for (const t of tickers) out.set(t, []);

  try {
    const { data, error } = await supabase
      .from('ct_heartbeats')
      .select('created_at, current_reads')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: true });
    if (error) {
      console.warn(`[ct-correlation-compute] heartbeats read failed:`, error.message);
      return out;
    }

    // Per-ticker map<date, price> — later iterations overwrite earlier
    // same-date entries so we end up with the latest-of-day.
    const perTickerByDate = new Map<string, Map<string, number>>();
    for (const t of tickers) perTickerByDate.set(t, new Map());

    for (const hb of (data ?? []) as HeartbeatRow[]) {
      const snap = hb?.current_reads?._snapshot?.per_ticker;
      if (!snap || typeof snap !== 'object') continue;
      const dateKey = toDateKey(hb.created_at);
      for (const t of tickers) {
        const cell = snap[t];
        const raw = cell && typeof cell === 'object' ? cell.price : null;
        const price = raw == null ? NaN : Number(raw);
        if (!Number.isFinite(price)) continue;
        perTickerByDate.get(t)!.set(dateKey, price);
      }
    }

    for (const t of tickers) {
      const dateMap = perTickerByDate.get(t)!;
      const closes = [...dateMap.entries()]
        .map(([session_date, price]) => ({ session_date, price }))
        .sort((a, b) => a.session_date.localeCompare(b.session_date));
      out.set(t, closes);
    }
  } catch (err) {
    console.warn(`[ct-correlation-compute] heartbeats read threw:`, (err as Error).message);
  }
  return out;
}

/**
 * Merge ticks-derived closes with heartbeats-derived closes. Tick source
 * wins on dates where both exist (finer granularity = closer to true
 * EOD close). Returns a sorted-by-date list.
 */
function mergeClosesByDate(primary: DailyClose[], fallback: DailyClose[]): DailyClose[] {
  const byDate = new Map<string, number>();
  for (const c of fallback) byDate.set(c.session_date, c.price);
  for (const c of primary) byDate.set(c.session_date, c.price); // wins on collision
  return [...byDate.entries()]
    .map(([session_date, price]) => ({ session_date, price }))
    .sort((a, b) => a.session_date.localeCompare(b.session_date));
}

// ---------------------------------------------------------------------------
// Pair computation
// ---------------------------------------------------------------------------
/**
 * Align two series on common session dates, produce paired return vectors.
 * This is the only correct way to correlate — you can't pair Monday's SPY
 * with Wednesday's QQQ just because one series has gaps.
 */
function alignReturns(
  a: DailyClose[],
  b: DailyClose[],
): { xs: number[]; ys: number[]; n: number } {
  const bByDate = new Map(b.map((c) => [c.session_date, c.price]));
  const alignedA: number[] = [];
  const alignedB: number[] = [];
  for (const ca of a) {
    const pb = bByDate.get(ca.session_date);
    if (pb == null) continue;
    alignedA.push(ca.price);
    alignedB.push(pb);
  }
  // toReturns drops the first element — daily simple returns = N−1 observations.
  const xs = toReturns(alignedA);
  const ys = toReturns(alignedB);
  // They should always be the same length since we aligned by date first.
  return { xs, ys, n: Math.min(xs.length, ys.length) };
}

/** Round numeric r to 4 decimals for DB storage; preserve null for NaN. */
function r4(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
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
  const computedAt = new Date().toISOString();
  // Pull a couple extra days of history so the 30-day daily-return window
  // is guaranteed to have 30 paired returns (N+1 closes needed for N returns).
  const sinceMs = Date.now() - (LOOKBACK_DAYS + 3) * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(sinceMs).toISOString();

  let watchlist: string[];
  try {
    watchlist = await getWatchlist(supabase);
  } catch (err) {
    console.warn(`[ct-correlation-compute] watchlist load threw:`, (err as Error).message);
    return new Response(JSON.stringify({ error: 'watchlist_unavailable' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ---- Load closes ---------------------------------------------------------
  // Parallel: ticks are per-ticker queries (12 in flight); heartbeats are
  // one big query. Both bounded, all run at once.
  const [tickResults, heartbeatMap] = await Promise.all([
    Promise.all(watchlist.map((t) => loadClosesFromTicks(supabase, t, sinceIso))),
    loadAllClosesFromHeartbeats(supabase, watchlist, sinceIso),
  ]);

  const closesByTicker = new Map<string, DailyClose[]>();
  watchlist.forEach((ticker, i) => {
    const merged = mergeClosesByDate(tickResults[i], heartbeatMap.get(ticker) ?? []);
    closesByTicker.set(ticker, merged);
  });

  // ---- Build rows ----------------------------------------------------------
  const rows: CacheRow[] = [];

  // Diagonals — always 1.0. Sample size = that ticker's own close-count.
  for (const t of watchlist) {
    const closes = closesByTicker.get(t) ?? [];
    rows.push({
      ticker_a: t,
      ticker_b: t,
      correlation_pearson: 1,
      correlation_rolling_20d: 1,
      sample_size: Math.max(0, closes.length - 1), // matches returns length
      lookback_days: LOOKBACK_DAYS,
      computed_at: computedAt,
    });
  }

  // Unordered pairs — canonicalize ticker_a < ticker_b (alphabetical).
  let insufficient = 0;
  for (let i = 0; i < watchlist.length; i++) {
    for (let j = i + 1; j < watchlist.length; j++) {
      const [ta, tb] =
        watchlist[i] < watchlist[j] ? [watchlist[i], watchlist[j]] : [watchlist[j], watchlist[i]];
      const { xs, ys, n } = alignReturns(
        closesByTicker.get(ta) ?? [],
        closesByTicker.get(tb) ?? [],
      );
      const r30 = pearson(xs, ys);
      const r20 = rollingPearson(xs, ys, ROLLING_WINDOW);
      if (n < MIN_SAMPLE) insufficient++;
      rows.push({
        ticker_a: ta,
        ticker_b: tb,
        correlation_pearson: r4(r30),
        correlation_rolling_20d: r4(r20),
        sample_size: n,
        lookback_days: LOOKBACK_DAYS,
        computed_at: computedAt,
      });
    }
  }

  // ---- Upsert --------------------------------------------------------------
  const { error: upsertErr } = await supabase
    .from('ct_ticker_correlation_cache')
    .upsert(rows, { onConflict: 'ticker_a,ticker_b,lookback_days' });

  if (upsertErr) {
    console.warn(`[ct-correlation-compute] upsert failed:`, upsertErr.message);
    return new Response(JSON.stringify({
      success: false,
      error: upsertErr.message,
      duration_ms: Date.now() - startedAt,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    success: true,
    watchlist_size: watchlist.length,
    pairs_computed: rows.length,
    insufficient_pairs: insufficient,
    lookback_days: LOOKBACK_DAYS,
    rolling_window: ROLLING_WINDOW,
    duration_ms: Date.now() - startedAt,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
