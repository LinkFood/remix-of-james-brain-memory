/**
 * ct-oi-backfill-historical — one-shot historical OI backfill for scored-flow contracts.
 *
 * PROBLEM: ct-oi-snapshot captures top-40 OI contracts per ticker per slot. Flow
 * events land on contracts that are MOSTLY NOT in the top-40, so the /tape
 * "OI Δ1D" column is blank on ~99% of rows because the (ticker, snap_date,
 * option_symbol) join against ct_oi_snapshots returns nothing.
 *
 * FIX: for every unique option_symbol in ct_scored_flow over the last 48h that
 * lacks a 2-day snapshot pair, pull historical OI from UW and insert rows for
 * today + yesterday so ct_compute_oi_deltas() can populate oi_delta_1d.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * UW ENDPOINT: get_historic_chains (via MCP)
 *
 *   Schema (from ct_uw_mcp_tools frozen inventory, 2026-04-24):
 *     required: option_symbol: string        — e.g. "NVDA260522C00205000"
 *     optional: limit: int (1..50, default 10)
 *
 *   Description: "Get daily historical time-series for a single option
 *   contract, including volume, open interest, OI deltas, OHLC price fields,
 *   and IV."
 *
 *   Why it wins: ONE call returns BOTH today + yesterday in the same payload,
 *   halving the MCP budget vs two single-day lookups. The UW MCP wrapper
 *   `mcpCallToolAsData` normalizes the payload to `{ data: [...] }` where each
 *   row is a daily bar. Field names observed across UW endpoints vary — we
 *   extract defensively for `date` + (`open_interest` | `oi`) and fall back
 *   if a field is missing.
 *
 *   Expected row shape (best-effort):
 *     { date: "YYYY-MM-DD", open_interest: int, volume: int,
 *       open, high, low, close, implied_volatility, oi_change, ... }
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Budget: up to 1500 unique symbols × 1 MCP call = 1500 calls (~7.5% of daily
 * UW budget). Bails at 2500 total mcp calls and reports which tickers remain.
 *
 * Rate-limit: on 429, sleep 5s + retry once. Second 429 → skip symbol.
 *
 * Body: optional { limit?: number, tickers?: string[] } to narrow scope.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { WATCHLIST } from '../_shared/uwClient.ts';
import { mcpCallToolAsData, isUwRateLimit, setMcpCaller } from '../_shared/uwMcpClient.ts';

const MCP_CALL_HARD_CAP = 2500;
const RATE_LIMIT_SLEEP_MS = 5_000;

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function intOrNull(v: unknown): number | null {
  const n = numOrNull(v);
  return n === null ? null : Math.round(n);
}

/**
 * Parse OCC-style option symbol: ROOT + YYMMDD + C/P + strike(8 digits, ×1000).
 * Example: AAPL250214C00180000 → { root: 'AAPL', expiry: '2025-02-14', side: 'C', strike: 180 }
 * Copied from ct-oi-snapshot/index.ts to keep this function self-contained.
 */
function parseOptionSymbol(sym: string | null | undefined): {
  root: string;
  expiry: string;
  side: 'C' | 'P';
  strike: number;
} | null {
  if (!sym) return null;
  const m = sym.match(/^([A-Z0-9]+?)(\d{6})([CP])(\d{8})$/);
  if (!m) return null;
  return {
    root: m[1],
    expiry: `20${m[2].slice(0, 2)}-${m[2].slice(2, 4)}-${m[2].slice(4, 6)}`,
    side: m[3] as 'C' | 'P',
    strike: parseInt(m[4], 10) / 1000,
  };
}

interface HistoricChainRow {
  date: string;           // YYYY-MM-DD
  open_interest: number;
  volume: number | null;
}

/**
 * Defensive extraction of daily bars from get_historic_chains response. UW
 * option endpoints vary in field naming — handle every observed variant.
 */
function extractHistoricRows(raw: unknown): HistoricChainRow[] {
  const root = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : null;
  let data: unknown = root?.data ?? root?.chains ?? root?.result ?? raw;
  if (!Array.isArray(data) && data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const nested = d.data ?? d.chains ?? d.rows ?? d.history;
    if (Array.isArray(nested)) data = nested;
  }
  if (!Array.isArray(data)) return [];

  const rows: HistoricChainRow[] = [];
  for (const r of data as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') continue;

    let dateStr = (r.date as string | undefined)
      ?? (r.trade_date as string | undefined)
      ?? (r.day as string | undefined)
      ?? (r.as_of as string | undefined)
      ?? null;
    if (dateStr && dateStr.length > 10) dateStr = dateStr.slice(0, 10);
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    const oi = intOrNull(r.open_interest ?? r.oi ?? r.openInterest);
    if (oi === null || oi <= 0) continue;  // skip 0/null — noise

    rows.push({
      date: dateStr,
      open_interest: oi,
      volume: intOrNull(r.volume ?? r.total_volume ?? r.vol),
    });
  }
  return rows;
}

/**
 * Pull historical OI for a single contract with one retry on 429.
 * Returns rows sorted newest-first, or null if skipped.
 */
async function pullContractHistory(
  optionSymbol: string,
): Promise<{ rows: HistoricChainRow[] | null; calls: number; rateLimited: boolean; error: string | null }> {
  let calls = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      calls++;
      const raw = await mcpCallToolAsData('get_historic_chains', {
        option_symbol: optionSymbol,
        limit: 10,
      });
      const rows = extractHistoricRows(raw);
      rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return { rows, calls, rateLimited: false, error: null };
    } catch (e) {
      if (isUwRateLimit(e)) {
        if (attempt === 0) {
          await new Promise(r => setTimeout(r, RATE_LIMIT_SLEEP_MS));
          continue;
        }
        return { rows: null, calls, rateLimited: true, error: 'rate_limit_second' };
      }
      return {
        rows: null,
        calls,
        rateLimited: false,
        error: e instanceof Error ? e.message.slice(0, 160) : String(e).slice(0, 160),
      };
    }
  }
  return { rows: null, calls, rateLimited: false, error: 'unknown' };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  setMcpCaller('ct-oi-backfill-historical');

  const supabase: SupabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  let body: { limit?: number; tickers?: string[] } = {};
  try { body = await req.json(); } catch { /* empty body fine */ }
  const tickerFilter = Array.isArray(body.tickers) && body.tickers.length > 0
    ? body.tickers.map(t => String(t).toUpperCase())
    : [...WATCHLIST];
  const symbolCap = typeof body.limit === 'number' && body.limit > 0 ? Math.min(body.limit, 5000) : 5000;

  // Dates: today + yesterday (UTC). Snapshot slot rule per spec:
  //   yesterday → 'close', today → 'open'.
  const today = new Date();
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const todayStr = today.toISOString().slice(0, 10);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  // ------------------------------------------------------------------
  // Step 1: find distinct option_symbols in scored_flow (last 48h) that
  // DON'T already have snapshot rows on BOTH yesterday + today.
  // ------------------------------------------------------------------
  const since = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  // Fetch distinct (ticker, option_symbol) from scored_flow
  const allFlowPairs = new Map<string, { ticker: string; option_symbol: string }>();
  {
    let from = 0;
    const page = 1000;
    // Paginate in case there are >1000 rows.
    // We sort by option_symbol to dedupe in-memory; per-row pagination is fine.
    while (true) {
      const { data, error } = await supabase
        .from('ct_scored_flow')
        .select('ticker, option_symbol')
        .gte('event_ts', since)
        .in('ticker', tickerFilter)
        .not('option_symbol', 'is', null)
        .range(from, from + page - 1);
      if (error) {
        return new Response(JSON.stringify({ ok: false, error: `scored_flow query: ${error.message}` }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      if (!data || data.length === 0) break;
      for (const r of data) {
        if (!r.option_symbol) continue;
        const key = `${r.ticker}|${r.option_symbol}`;
        if (!allFlowPairs.has(key)) allFlowPairs.set(key, r as { ticker: string; option_symbol: string });
      }
      if (data.length < page) break;
      from += page;
      if (allFlowPairs.size >= symbolCap * 2) break;  // safety
    }
  }

  // Fetch existing snapshots for (yesterday, today) so we can filter
  const existingSnaps = new Set<string>();  // key = `${ticker}|${option_symbol}|${snap_date}`
  if (allFlowPairs.size > 0) {
    const { data, error } = await supabase
      .from('ct_oi_snapshots')
      .select('ticker, option_symbol, snap_date')
      .in('snap_date', [todayStr, yesterdayStr])
      .in('ticker', tickerFilter);
    if (error) {
      return new Response(JSON.stringify({ ok: false, error: `snapshots query: ${error.message}` }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    for (const r of data ?? []) {
      existingSnaps.add(`${r.ticker}|${r.option_symbol}|${r.snap_date}`);
    }
  }

  // A symbol "needs backfill" if it's missing snapshot on yesterday OR today.
  const needsBackfill: Array<{ ticker: string; option_symbol: string }> = [];
  for (const pair of allFlowPairs.values()) {
    const hasY = existingSnaps.has(`${pair.ticker}|${pair.option_symbol}|${yesterdayStr}`);
    const hasT = existingSnaps.has(`${pair.ticker}|${pair.option_symbol}|${todayStr}`);
    if (!hasY || !hasT) needsBackfill.push(pair);
    if (needsBackfill.length >= symbolCap) break;
  }

  // ------------------------------------------------------------------
  // Step 2: for each missing symbol, pull get_historic_chains and build
  // 2 upsert rows (yesterday=close, today=open).
  // ------------------------------------------------------------------
  const UPSERT_BATCH = 500;
  let mcpCalls = 0;
  let mcpErrors = 0;
  let rateLimitHits = 0;
  let rowsInserted = 0;
  let symbolsBackfilled = 0;
  let bailedAtCap = false;
  const upsertBuffer: Array<Record<string, unknown>> = [];
  const remainingByTicker = new Map<string, number>();
  for (const t of tickerFilter) remainingByTicker.set(t, 0);

  async function flushUpserts(): Promise<void> {
    if (upsertBuffer.length === 0) return;
    const { error, count } = await supabase
      .from('ct_oi_snapshots')
      .upsert(upsertBuffer, {
        onConflict: 'ticker,snap_date,snap_slot,option_symbol',
        count: 'exact',
      });
    if (error) {
      mcpErrors++;
      console.error('[ct-oi-backfill-historical] upsert failed:', error.message);
    } else {
      rowsInserted += count ?? upsertBuffer.length;
    }
    upsertBuffer.length = 0;
  }

  for (let i = 0; i < needsBackfill.length; i++) {
    if (mcpCalls >= MCP_CALL_HARD_CAP) {
      bailedAtCap = true;
      // Count remaining per ticker for the report.
      for (let j = i; j < needsBackfill.length; j++) {
        const t = needsBackfill[j].ticker;
        remainingByTicker.set(t, (remainingByTicker.get(t) ?? 0) + 1);
      }
      break;
    }

    const { ticker, option_symbol } = needsBackfill[i];
    const { rows, calls, rateLimited, error } = await pullContractHistory(option_symbol);
    mcpCalls += calls;
    if (rateLimited) rateLimitHits++;
    if (error) {
      mcpErrors++;
      continue;
    }
    if (!rows || rows.length === 0) continue;

    // Split rows into today vs yesterday. We require at least one matching date.
    const todayRow = rows.find(r => r.date === todayStr)
      ?? rows[0];  // if today isn't in the history yet (pre-market), use newest row
    const yRow = rows.find(r => r.date === yesterdayStr)
      ?? rows.find(r => r.date < todayStr) // fallback to prev trading day
      ?? null;

    const parsed = parseOptionSymbol(option_symbol);
    const base = {
      ticker,
      option_symbol,
      strike: parsed?.strike ?? null,
      expiry: parsed?.expiry ?? null,
      side: parsed?.side ?? null,
    };

    let didInsertForSymbol = false;

    // Yesterday row → snap_slot='close', snap_date=yesterdayStr.
    // Only insert if we don't already have ANY row for that day.
    if (yRow && !existingSnaps.has(`${ticker}|${option_symbol}|${yesterdayStr}`)) {
      upsertBuffer.push({
        ...base,
        snap_date: yesterdayStr,
        snap_slot: 'close',
        oi: yRow.open_interest,
        volume_today: yRow.volume,
        raw: { source: 'get_historic_chains', backfill: true, date: yRow.date },
      });
      didInsertForSymbol = true;
    }

    // Today row → snap_slot='open', snap_date=todayStr.
    if (todayRow && !existingSnaps.has(`${ticker}|${option_symbol}|${todayStr}`)) {
      upsertBuffer.push({
        ...base,
        snap_date: todayStr,
        snap_slot: 'open',
        oi: todayRow.open_interest,
        volume_today: todayRow.volume,
        raw: { source: 'get_historic_chains', backfill: true, date: todayRow.date },
      });
      didInsertForSymbol = true;
    }

    if (didInsertForSymbol) symbolsBackfilled++;

    if (upsertBuffer.length >= UPSERT_BATCH) {
      await flushUpserts();
    }
  }

  // Flush any remaining buffer.
  await flushUpserts();

  // ------------------------------------------------------------------
  // Step 3: recompute deltas so /tape shows oi_delta_1d populated.
  // ------------------------------------------------------------------
  let deltasComputed = 0;
  let deltaErr: string | null = null;
  try {
    const { data, error } = await supabase.rpc('ct_compute_oi_deltas');
    if (error) deltaErr = error.message;
    else deltasComputed = typeof data === 'number' ? data : 0;
  } catch (e) {
    deltaErr = e instanceof Error ? e.message : String(e);
  }

  const remaining_tickers: Record<string, number> = {};
  for (const [t, n] of remainingByTicker.entries()) if (n > 0) remaining_tickers[t] = n;

  return new Response(JSON.stringify({
    ok: true,
    today: todayStr,
    yesterday: yesterdayStr,
    symbols_targeted: needsBackfill.length,
    symbols_backfilled: symbolsBackfilled,
    rows_inserted: rowsInserted,
    deltas_computed: deltasComputed,
    delta_err: deltaErr,
    mcp_calls: mcpCalls,
    mcp_errors: mcpErrors,
    rate_limit_hits: rateLimitHits,
    bailed_at_cap: bailedAtCap,
    remaining_by_ticker: remaining_tickers,
    flow_pairs_scanned: allFlowPairs.size,
    duration_ms: Date.now() - startedAt,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
