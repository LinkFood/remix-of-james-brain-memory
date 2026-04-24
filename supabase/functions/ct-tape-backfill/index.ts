/**
 * ct-tape-backfill — one-shot historical flow-alerts ingest.
 *
 * Walks UW REST /api/option-trades/flow-alerts per ticker, paginates via
 * `older_than` cursor, client-side floors at `newer_than` (UW silently
 * clamps to their ~24-day retention). Upserts into ct_flow_alerts, then
 * triggers ct_score_existing_flow so the rows land on /tape with scores.
 *
 * Service-role only. Not scheduled. Fire ad-hoc with body
 *   { days?: 7, tickers?: WATCHLIST, min_premium?: 25000 }
 *
 * Budget gate: bails at UW ≥80%. Caller tagged so /budget shows the cost.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getFlowAlerts, setUwCaller, uwBudgetOk, WATCHLIST } from '../_shared/uwClient.ts';

const CALLER = 'ct-tape-backfill';
const PAGE_LIMIT = 200;         // UW caps around 200 per page
const MAX_PAGES_PER_DAY = 6;    // safety — 6 × 200 = 1200 alerts/ticker/day
const PAGE_DELAY_MS = 300;      // respect 120 req/min

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function boolOrNull(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return null;
}

function parseOccSide(sym: string | null | undefined): 'call' | 'put' | null {
  if (!sym || sym.length < 9) return null;
  const ch = sym.charAt(sym.length - 9);
  if (ch === 'C' || ch === 'c') return 'call';
  if (ch === 'P' || ch === 'p') return 'put';
  return null;
}

interface BackfillRow {
  alert_id: string;
  ticker: string;
  option_symbol: string | null;
  strike: number | null;
  expiry: string | null;
  side: string | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  is_otm: boolean | null;
  size: number | null;
  volume: number | null;
  open_interest: number | null;
  size_gt_oi: boolean | null;
  premium: number | null;
  price: number | null;
  underlying_price: number | null;
  executed_at: string | null;
  alert_type: string | null;
  raw: Record<string, unknown>;
}

function mapRow(r: Record<string, unknown>): BackfillRow {
  const optionSymbol = (r.option_symbol as string | undefined) ?? null;
  const rawSide = (r.type as string | undefined) ?? (r.side as string | undefined) ?? null;
  const derivedSide = rawSide === 'call' || rawSide === 'put' ? rawSide : parseOccSide(optionSymbol);
  const executed = (r.executed_at as string | undefined) ?? (r.timestamp as string | undefined) ?? (r.created_at as string | undefined) ?? null;
  return {
    alert_id: (r.id as string | undefined) ?? (r.alert_id as string | undefined) ?? `bfl-${r.ticker_symbol ?? r.ticker}-${executed ?? ''}-${optionSymbol ?? ''}`,
    ticker: (r.ticker_symbol as string | undefined) ?? (r.ticker as string | undefined) ?? 'UNKNOWN',
    option_symbol: optionSymbol,
    strike: numOrNull(r.strike),
    expiry: (r.expiry as string | undefined) ?? (r.expiration as string | undefined) ?? null,
    side: derivedSide,
    is_ask: boolOrNull(r.is_ask_side ?? r.is_ask),
    is_bid: boolOrNull(r.is_bid_side ?? r.is_bid),
    is_otm: boolOrNull(r.is_otm),
    size: numOrNull(r.size ?? r.total_size),
    volume: numOrNull(r.volume ?? r.total_volume),
    open_interest: numOrNull(r.open_interest),
    size_gt_oi: boolOrNull(r.size_greater_oi ?? r.size_gt_oi),
    premium: numOrNull(r.premium ?? r.total_premium),
    price: numOrNull(r.price),
    underlying_price: numOrNull(r.underlying_price),
    executed_at: executed,
    alert_type: (r.alert_type as string | undefined) ?? (r.type as string | undefined) ?? null,
    raw: { ...r, backfill: true },
  };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  setUwCaller(CALLER);

  // Budget gate — bail at ≥80% daily or low minute remaining.
  const budgetOk = await uwBudgetOk({ dailyThreshold: 0.80, minuteFloor: 20 });
  if (!budgetOk) {
    return new Response(JSON.stringify({
      ok: false, reason: 'uw_budget_exceeded',
      message: 'UW daily usage ≥80% or minute remaining <20 — backfill aborted to preserve live-path budget',
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const body = await req.json().catch(() => ({})) as {
    days?: number;
    tickers?: string[];
    min_premium?: number;
  };
  const days = Math.min(Math.max(body.days ?? 7, 1), 14);
  const tickers = (body.tickers && body.tickers.length > 0) ? body.tickers : [...WATCHLIST];
  const minPremium = Math.max(body.min_premium ?? 25_000, 1_000);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const started = Date.now();
  const floorMs = Date.now() - days * 86_400_000;
  const floorIso = new Date(floorMs).toISOString();

  const perTicker: Record<string, { pages: number; rows_seen: number; rows_inserted: number; earliest: string | null; latest: string | null; stopped: string }> = {};
  const errors: Array<{ ticker: string; page: number; error: string }> = [];
  let totalInserted = 0;
  let totalSeen = 0;

  for (const ticker of tickers) {
    perTicker[ticker] = { pages: 0, rows_seen: 0, rows_inserted: 0, earliest: null, latest: null, stopped: 'unknown' };
    let cursor: string | undefined = undefined;  // undefined = most-recent first page
    let reachedFloor = false;
    let earliest: string | null = null;
    let latest: string | null = null;

    for (let page = 0; page < MAX_PAGES_PER_DAY * days / 2 && !reachedFloor; page++) {
      // Quick budget re-check between pages — defense in depth.
      if (page > 0 && page % 5 === 0) {
        const ok = await uwBudgetOk({ dailyThreshold: 0.82, minuteFloor: 20 });
        if (!ok) {
          perTicker[ticker].stopped = 'budget_gate_mid_run';
          reachedFloor = true;
          break;
        }
      }

      let raw: unknown;
      try {
        raw = await getFlowAlerts({
          ticker_symbol: ticker,
          limit: PAGE_LIMIT,
          min_premium: minPremium,
          ...(cursor ? { older_than: cursor } : {}),
        });
      } catch (e) {
        errors.push({ ticker, page, error: e instanceof Error ? e.message : String(e) });
        perTicker[ticker].stopped = 'api_error';
        break;
      }

      const data = raw && typeof raw === 'object' ? (raw as { data?: unknown }).data : null;
      if (!Array.isArray(data) || data.length === 0) {
        perTicker[ticker].stopped = 'empty_page';
        break;
      }

      perTicker[ticker].pages++;

      const rows = (data as Array<Record<string, unknown>>)
        .map(mapRow)
        .filter((r) => {
          // Drop rows below the lower bound — UW clamps newer_than server-side.
          if (!r.executed_at) return false;
          return Date.parse(r.executed_at) >= floorMs;
        });

      // Track span for reporting
      for (const r of data as Array<Record<string, unknown>>) {
        const t = (r.executed_at as string | undefined) ?? (r.timestamp as string | undefined) ?? null;
        if (!t) continue;
        if (!earliest || Date.parse(t) < Date.parse(earliest)) earliest = t;
        if (!latest || Date.parse(t) > Date.parse(latest)) latest = t;
      }

      perTicker[ticker].rows_seen += data.length;
      totalSeen += data.length;

      if (rows.length > 0) {
        const { error, count } = await supabase
          .from('ct_flow_alerts')
          .upsert(rows, { onConflict: 'alert_id', ignoreDuplicates: true, count: 'exact' });
        if (error) {
          errors.push({ ticker, page, error: `upsert: ${error.message}` });
        } else {
          perTicker[ticker].rows_inserted += count ?? rows.length;
          totalInserted += count ?? rows.length;
        }
      }

      // Next cursor = tail of this page (oldest row). If the tail is at/below
      // the floor, stop.
      const tail = (data as Array<Record<string, unknown>>)[data.length - 1];
      const tailTs = (tail.executed_at as string | undefined) ?? (tail.timestamp as string | undefined) ?? null;
      if (!tailTs) {
        perTicker[ticker].stopped = 'no_cursor_in_tail';
        break;
      }
      if (Date.parse(tailTs) < floorMs) {
        perTicker[ticker].stopped = 'reached_floor';
        reachedFloor = true;
        break;
      }
      if (data.length < PAGE_LIMIT) {
        perTicker[ticker].stopped = 'short_page';
        break;
      }
      cursor = tailTs;
      await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
    }

    if (!perTicker[ticker].stopped || perTicker[ticker].stopped === 'unknown') {
      perTicker[ticker].stopped = 'max_pages_hit';
    }
    perTicker[ticker].earliest = earliest;
    perTicker[ticker].latest = latest;
  }

  // After inserts, score the new rows. Cheap — the RPC iterates its own way.
  let scoredCount: number | null = null;
  let scoreErr: string | null = null;
  try {
    const { data, error } = await supabase.rpc('ct_score_existing_flow' as never, {});
    if (error) scoreErr = error.message;
    else scoredCount = typeof data === 'number' ? data : null;
  } catch (e) {
    scoreErr = e instanceof Error ? e.message : String(e);
  }

  return new Response(JSON.stringify({
    ok: true,
    days, tickers, min_premium: minPremium,
    floor_ts: floorIso,
    total_rows_seen: totalSeen,
    total_rows_inserted: totalInserted,
    scored_count: scoredCount,
    score_error: scoreErr,
    per_ticker: perTicker,
    errors,
    elapsed_ms: Date.now() - started,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
