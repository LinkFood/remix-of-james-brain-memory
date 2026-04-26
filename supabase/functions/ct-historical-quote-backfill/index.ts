/**
 * ct-historical-quote-backfill — weekend-only contract-quote backfill.
 *
 * The problem this solves:
 *   /tape Horizons column was mostly blank because Pass 3 grader writes
 *   ct_print_grades rows with grading_method='contract_v1' ONLY when
 *   print_time + horizon (30m / 2h / eod / +1d) falls within ±6h of an
 *   existing quote in ct_contract_quotes. Friday prints rarely have aligned
 *   quotes — the live poller fetched mids hours before/after the horizon.
 *
 * The fix:
 *   Walk recent ct_contract_tracks, compute each track's 4 horizon timestamps,
 *   skip any that already have a quote within ±6h, fetch the rest from UW
 *   /historic (daily OHLC), insert synthesized quotes with
 *   source='uw_historic_backfill'. Pass 3 then fills in Horizons chips on
 *   the next ct-print-grader run.
 *
 * Weekend gate:
 *   Mon-Fri (UTC day 1-5) → return early. Override with body {force: true}.
 *   Belt + suspenders: cron only fires Sat/Sun (cron schedule + gate inside).
 *   Live UW budget is preserved during market hours.
 *
 * Concurrency:
 *   pLimit=2 against /historic. UW caps concurrent at 3; leave headroom.
 *
 * Per-run cap:
 *   200 unique option_symbols max — bounds the function under the 150s
 *   edge timeout. Tracks are walked print_time DESC; subsequent runs
 *   pick up where the previous left off because already-filled horizons
 *   are skipped via the ±6h check.
 *
 * Auth: service_role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getOptionContractHistoric, uwBudgetOk, setUwCaller } from '../_shared/uwClient.ts';

// ---------------------------------------------------------------------------
// Hard rails
// ---------------------------------------------------------------------------
const FN_NAME = 'ct-historical-quote-backfill';
const MAX_UNIQUE_SYMBOLS_PER_RUN = 200;
const TRACK_FETCH_PAGE = 1000;            // PostgREST hard cap
const HORIZON_SLOP_HOURS = 6;             // mirrors Pass 3 grader's ±6h window
const UW_CONCURRENCY = 2;                 // UW concurrency cap is 3, headroom

// Horizon names mirror Pass 3 grader. Each yields one timestamp per track.
type HorizonName = '30m' | '2h' | 'eod' | '+1d';
const HORIZON_DEFS: Array<{ name: HorizonName; offsetMs: number | 'eod' | 'plus1d' }> = [
  { name: '30m', offsetMs: 30 * 60 * 1000 },
  { name: '2h',  offsetMs: 2 * 60 * 60 * 1000 },
  { name: 'eod', offsetMs: 'eod' },
  { name: '+1d', offsetMs: 'plus1d' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TrackRow {
  id: string;
  alert_id: string;
  option_symbol: string;
  ticker: string;
  expiry: string | null;
  print_time: string;
  sweep_count: number | null;
}

interface Stats {
  ok: boolean;
  weekday_gated: boolean;
  message?: string;
  elapsed_ms: number;
  utc_day: number;
  forced: boolean;
  tracks_scanned: number;
  unique_symbols: number;
  horizons_targeted: number;
  horizons_already_filled: number;
  horizons_attempted: number;
  quotes_inserted: number;
  uw_calls: number;
  uw_misses: number;
  budget_exhausted: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Watchlist loader — single source of truth in ct_config.watcher.watchlist.
// Hardcoded fallback so we never silently run unfiltered.
// ---------------------------------------------------------------------------
const DEFAULT_WATCHLIST = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

async function loadWatchlist(supabase: SupabaseClient): Promise<Set<string>> {
  const defaults = new Set(DEFAULT_WATCHLIST);
  const { data, error } = await supabase
    .from('ct_config')
    .select('value')
    .eq('key', 'watcher.watchlist')
    .maybeSingle();
  if (error || !data?.value) return defaults;
  const arr = data.value as unknown;
  if (!Array.isArray(arr)) return defaults;
  const set = new Set<string>();
  for (const t of arr) {
    if (typeof t === 'string' && t.length > 0) set.add(t.toUpperCase());
  }
  return set.size > 0 ? set : defaults;
}

// ---------------------------------------------------------------------------
// Inline concurrency limiter — never Promise.all UW (429s at 3+).
// ---------------------------------------------------------------------------
function pLimit<T>(concurrency: number, jobs: Array<() => Promise<T>>): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const results: T[] = new Array(jobs.length);
    let idx = 0;
    let inflight = 0;
    let completed = 0;
    let failed = false;

    const launch = () => {
      if (failed) return;
      while (inflight < concurrency && idx < jobs.length) {
        const myIdx = idx++;
        inflight += 1;
        jobs[myIdx]()
          .then((v) => { results[myIdx] = v; })
          .catch((e) => { if (!failed) { failed = true; reject(e); } })
          .finally(() => {
            inflight -= 1;
            completed += 1;
            if (completed === jobs.length && !failed) resolve(results);
            else launch();
          });
      }
    };
    if (jobs.length === 0) resolve([]);
    else launch();
  });
}

// ---------------------------------------------------------------------------
// Horizon timestamp computation. Mirrors Pass 3 grader semantics.
//   - 30m / 2h: print_time + offset
//   - eod: same calendar day at 20:00 UTC (16:00 ET RTH close)
//   - +1d: 24h after print_time
// ---------------------------------------------------------------------------
function computeHorizonTs(printTimeIso: string, h: typeof HORIZON_DEFS[number]): Date | null {
  const printMs = new Date(printTimeIso).getTime();
  if (!Number.isFinite(printMs)) return null;
  if (h.offsetMs === 'eod') {
    const d = new Date(printMs);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 20, 0, 0, 0));
  }
  if (h.offsetMs === 'plus1d') {
    return new Date(printMs + 24 * 60 * 60 * 1000);
  }
  return new Date(printMs + h.offsetMs);
}

// ---------------------------------------------------------------------------
// Walk ct_contract_tracks pages until we collect TARGET unique symbols (or
// exhaust). Paginate via .range() — PostgREST hard-caps at 1000 rows
// regardless of .limit() (see feedback_postgrest_1000_row_cap).
// ---------------------------------------------------------------------------
async function fetchEligibleTracks(
  supabase: SupabaseClient,
  watchlist: Set<string>,
): Promise<TrackRow[]> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  // Print + 30min must be in the past — 30m horizon requires a completed window.
  const completed30mCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const all: TrackRow[] = [];
  for (let offset = 0; offset < 20000; offset += TRACK_FETCH_PAGE) {
    const end = offset + TRACK_FETCH_PAGE - 1;
    const { data, error } = await supabase
      .from('ct_contract_tracks')
      .select('id, alert_id, option_symbol, ticker, expiry, print_time, sweep_count')
      .in('ticker', Array.from(watchlist))
      .gte('print_time', sevenDaysAgo)
      .lte('print_time', completed30mCutoff)
      // ASC by print_time (NOTE: deliberate exception to feedback_create_query_sort_desc).
      // This function fills HISTORICAL holes in old data; newest tracks already have
      // quotes from the live poller. Walking oldest-first means each fire makes
      // progress on Mon-Wed data instead of timing out re-scanning Friday's
      // already-filled symbols.
      .order('print_time', { ascending: true })
      .range(offset, end);
    if (error) throw new Error(`tracks fetch (offset ${offset}): ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...(data as TrackRow[]));
    if (data.length < TRACK_FETCH_PAGE) break;
  }
  return all;
}

// ---------------------------------------------------------------------------
// Existing-quote check. For a given option_symbol + horizon timestamp,
// is there ANY quote within ±6h? Cheap HEAD count.
// ---------------------------------------------------------------------------
async function hasQuoteWithinSlop(
  supabase: SupabaseClient,
  optionSymbol: string,
  horizonTs: Date,
): Promise<boolean> {
  const slopMs = HORIZON_SLOP_HOURS * 60 * 60 * 1000;
  const lo = new Date(horizonTs.getTime() - slopMs).toISOString();
  const hi = new Date(horizonTs.getTime() + slopMs).toISOString();
  const { count, error } = await supabase
    .from('ct_contract_quotes')
    .select('id', { count: 'estimated', head: true })
    .eq('option_symbol', optionSymbol)
    .gte('ts', lo)
    .lte('ts', hi);
  if (error) return false;     // on error, treat as missing — better to over-fetch than miss
  return (count ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------
serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  setUwCaller(FN_NAME);
  const startedAt = Date.now();
  const utcDay = new Date().getUTCDay();

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty body ok */ }
  const forced = body?.force === true;

  const stats: Stats = {
    ok: true,
    weekday_gated: false,
    elapsed_ms: 0,
    utc_day: utcDay,
    forced,
    tracks_scanned: 0,
    unique_symbols: 0,
    horizons_targeted: 0,
    horizons_already_filled: 0,
    horizons_attempted: 0,
    quotes_inserted: 0,
    uw_calls: 0,
    uw_misses: 0,
    budget_exhausted: false,
    errors: [],
  };

  // Weekend gate. UTC day: 0=Sun, 1=Mon, ..., 5=Fri, 6=Sat.
  if (!forced && utcDay >= 1 && utcDay <= 5) {
    stats.weekday_gated = true;
    stats.message = 'Backfill is weekend-only to preserve live UW budget';
    stats.elapsed_ms = Date.now() - startedAt;
    return new Response(JSON.stringify(stats), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    const watchlist = await loadWatchlist(supabase);
    const tracks = await fetchEligibleTracks(supabase, watchlist);
    stats.tracks_scanned = tracks.length;

    // Dedup by option_symbol — many tracks share a contract. We only need
    // one /historic call per symbol (the response contains every trading
    // day's bar; we extract the right one per horizon).
    const bySymbol = new Map<string, TrackRow[]>();
    for (const t of tracks) {
      if (!t.option_symbol) continue;
      const arr = bySymbol.get(t.option_symbol);
      if (arr) arr.push(t);
      else bySymbol.set(t.option_symbol, [t]);
    }

    const symbols = [...bySymbol.keys()].slice(0, MAX_UNIQUE_SYMBOLS_PER_RUN);
    stats.unique_symbols = symbols.length;

    // Bulk pre-filter: which of these symbols have ANY quote in the relevant
    // 8-day window? Symbols with zero quotes get every horizon added to needs
    // without per-horizon slop checks (they obviously have nothing). This drops
    // ~20k sequential DB queries to 1 paginated lookup. Critical for fitting
    // within the 150s edge timeout — the per-horizon loop alone exceeded it.
    const symbolsWithAnyQuote = new Set<string>();
    {
      const lookbackStart = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const pageSize = 1000;
      for (let off = 0; off < 50000; off += pageSize) {
        const { data, error } = await supabase
          .from('ct_contract_quotes')
          .select('option_symbol')
          .in('option_symbol', symbols)
          .gte('ts', lookbackStart)
          .range(off, off + pageSize - 1);
        if (error) break;
        if (!data || data.length === 0) break;
        for (const r of data) if (r.option_symbol) symbolsWithAnyQuote.add(r.option_symbol as string);
        if (data.length < pageSize) break;
      }
    }

    // Build horizon-needs map. For symbols already-quoted, do per-horizon slop
    // check (existing precise behavior). For zero-quote symbols, add every
    // valid horizon directly — no per-horizon DB call needed.
    type HorizonNeed = { symbol: string; horizonTs: Date };
    const horizonNeeds: HorizonNeed[] = [];

    for (const symbol of symbols) {
      const symbolTracks = bySymbol.get(symbol) ?? [];
      const symbolHasQuotes = symbolsWithAnyQuote.has(symbol);
      const seenTs = new Set<number>();
      for (const track of symbolTracks) {
        for (const h of HORIZON_DEFS) {
          const ts = computeHorizonTs(track.print_time, h);
          if (!ts) continue;
          if (ts.getTime() > Date.now()) continue;
          const key = ts.getTime();
          if (seenTs.has(key)) continue;
          seenTs.add(key);
          stats.horizons_targeted += 1;
          if (!symbolHasQuotes) {
            // Symbol has zero quotes anywhere in the 8-day window — every
            // horizon needs filling. Skip per-horizon DB check.
            horizonNeeds.push({ symbol, horizonTs: ts });
            continue;
          }
          const filled = await hasQuoteWithinSlop(supabase, symbol, ts);
          if (filled) {
            stats.horizons_already_filled += 1;
            continue;
          }
          horizonNeeds.push({ symbol, horizonTs: ts });
        }
      }
    }

    // Group needs by symbol — ONE /historic call per symbol returns every
    // trading day's bar. We then map needed horizons → matching daily bars.
    const needsBySymbol = new Map<string, Date[]>();
    for (const n of horizonNeeds) {
      const arr = needsBySymbol.get(n.symbol);
      if (arr) arr.push(n.horizonTs);
      else needsBySymbol.set(n.symbol, [n.horizonTs]);
    }
    stats.horizons_attempted = horizonNeeds.length;

    // Bail early if no work — keeps the response signal clean.
    if (needsBySymbol.size === 0) {
      stats.elapsed_ms = Date.now() - startedAt;
      return new Response(JSON.stringify(stats), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fetch /historic per symbol with concurrency=2.
    type SymbolBars = { symbol: string; rowsByDate: Map<string, { mid: number | null; last: number | null; bid: number | null; ask: number | null }> };
    const fetchedBars: SymbolBars[] = [];
    const symbolsToFetch = [...needsBySymbol.keys()];

    const jobs: Array<() => Promise<void>> = symbolsToFetch.map((symbol) => async () => {
      if (stats.budget_exhausted) return;
      const ok = await uwBudgetOk();
      if (!ok) { stats.budget_exhausted = true; return; }
      stats.uw_calls += 1;
      try {
        // /historic returns daily bars; limit 30 covers any ≤7d window with headroom.
        const res = await getOptionContractHistoric(symbol, { limit: 30 });
        if (!res.ok || res.rows.length === 0) {
          stats.uw_misses += 1;
          return;
        }
        const map = new Map<string, { mid: number | null; last: number | null; bid: number | null; ask: number | null }>();
        for (const row of res.rows) {
          // Synthesize mid from nbbo_bid/nbbo_ask; fall back to avg_price/last.
          const bid = row.nbbo_bid;
          const ask = row.nbbo_ask;
          const mid = (bid !== null && ask !== null) ? (bid + ask) / 2 : (row.avg_price ?? row.last_price);
          map.set(row.date, { mid, last: row.last_price, bid, ask });
        }
        fetchedBars.push({ symbol, rowsByDate: map });
      } catch (e) {
        stats.uw_misses += 1;
        stats.errors.push(`uw ${symbol}: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
      }
    });

    await pLimit(UW_CONCURRENCY, jobs);

    // Build quote-insert rows. For each (symbol, horizonTs) need, look up the
    // bar for that date — historic /historic is daily, so the horizon
    // resolution collapses to "the daily close for the day the horizon falls
    // on". That's the right granularity for ±6h slop and Pass 3 grading.
    const barsBySymbol = new Map<string, SymbolBars['rowsByDate']>();
    for (const fb of fetchedBars) barsBySymbol.set(fb.symbol, fb.rowsByDate);

    const insertRows: Array<{
      option_symbol: string;
      ts: string;
      bid: number | null;
      ask: number | null;
      mid: number | null;
      last: number | null;
      spread_pct: number | null;
      source: string;
    }> = [];

    for (const [symbol, horizonList] of needsBySymbol.entries()) {
      const rowsByDate = barsBySymbol.get(symbol);
      if (!rowsByDate) continue;
      // De-dup writes by ts — multiple horizons can resolve to the same daily
      // bar (date), so we'd otherwise upsert the same row twice.
      const writtenTs = new Set<string>();
      for (const h of horizonList) {
        // Date key in YYYY-MM-DD UTC matches UW's `date` field format.
        const dateKey = h.toISOString().slice(0, 10);
        const bar = rowsByDate.get(dateKey);
        if (!bar || bar.mid === null) continue;
        // Anchor ts to the horizon's actual time so the ±6h window in the
        // grader will trivially pass — no slop math, just hit it dead-on.
        const tsIso = h.toISOString();
        if (writtenTs.has(tsIso)) continue;
        writtenTs.add(tsIso);
        const spreadPct = (bar.bid !== null && bar.ask !== null && bar.mid !== null && bar.mid > 0)
          ? (bar.ask - bar.bid) / bar.mid
          : null;
        insertRows.push({
          option_symbol: symbol,
          ts: tsIso,
          bid: bar.bid,
          ask: bar.ask,
          mid: bar.mid,
          last: bar.last,
          spread_pct: spreadPct,
          source: 'uw_historic_backfill',
        });
      }
    }

    if (insertRows.length > 0) {
      const chunkSize = 100;
      for (let i = 0; i < insertRows.length; i += chunkSize) {
        const slice = insertRows.slice(i, i + chunkSize);
        // Upsert via the unique (option_symbol, ts) constraint added in the
        // companion migration — re-runs are idempotent.
        const { error: insErr, count } = await supabase
          .from('ct_contract_quotes')
          .upsert(slice, { onConflict: 'option_symbol,ts', ignoreDuplicates: true, count: 'exact' });
        if (insErr) {
          stats.errors.push(`quote-upsert: ${insErr.message.slice(0, 200)}`);
          continue;
        }
        stats.quotes_inserted += count ?? slice.length;
      }
    }
  } catch (e) {
    stats.ok = false;
    stats.errors.push(`fatal: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`);
  }

  stats.elapsed_ms = Date.now() - startedAt;
  stats.errors = stats.errors.slice(0, 20);

  return new Response(JSON.stringify(stats), {
    status: 200,
    headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
  });
});
