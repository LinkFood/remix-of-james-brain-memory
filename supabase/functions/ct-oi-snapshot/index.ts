/**
 * ct-oi-snapshot — Co-Trader v2 Phase 1c.
 *
 * Captures top-OI contracts (calls + puts) across nearest expiries for each
 * v2 watchlist ticker, 3x/day (open, mid, close). Feeds T+1 OI confirmation —
 * the academic-consensus gold-standard signal per Lakonishok et al. and
 * Augustin et al. (see CO_TRADER_V2_SCOPE.md §3).
 *
 * Body: { slot: 'open' | 'mid' | 'close' }   — or derive from UTC hour.
 *
 * For each ticker:
 *   - Pull 2 nearest expiries via get_options_chain (no expiry arg → server picks init),
 *     then get_chains_for_expiry for any weekly/monthly within 10 DTE to get strike-level data.
 *   - Keep top-20 calls by OI + top-20 puts by OI per ticker.
 *   - Upsert into ct_oi_snapshots on (ticker, snap_date, snap_slot, option_symbol).
 *   - After all tickers done, run ct_compute_oi_deltas() to populate 1d/5d deltas.
 *
 * Budget: 10 tickers × ~3 MCP calls/ticker × 3 runs/day ≈ 90 calls/day. Well under UW limit.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { WATCHLIST, setUwCaller } from '../_shared/uwClient.ts';
import { mcpCallToolAsData, isUwRateLimit, setMcpCaller } from '../_shared/uwMcpClient.ts';

type SnapSlot = 'open' | 'mid' | 'close';

function deriveSlotFromHour(): SnapSlot {
  // UTC hour → slot. open = 13:35 UTC = ~13, mid = 17:00 UTC, close = 20:05 UTC = ~20.
  const h = new Date().getUTCHours();
  if (h < 15) return 'open';
  if (h < 19) return 'mid';
  return 'close';
}

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

function daysUntil(dateStr: string): number {
  const d = new Date(dateStr + 'T00:00:00Z').getTime();
  const now = Date.now();
  return Math.round((d - now) / (1000 * 60 * 60 * 24));
}

interface OIContractRow {
  ticker: string;
  option_symbol: string;
  strike: number | null;
  expiry: string | null;
  side: 'C' | 'P' | null;
  oi: number;
  volume_today: number | null;
  raw: Record<string, unknown>;
}

/**
 * Extract contract rows from a UW chain response. UW's option-chain endpoints
 * return arrays of row records with mixed naming conventions — be defensive.
 * Known fields observed: option_symbol, strike, expiry, side/type, open_interest, volume.
 */
function extractContractRows(
  raw: unknown,
  ticker: string,
): OIContractRow[] {
  const root = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : null;
  let data: unknown = root?.data ?? root?.chains ?? root?.result ?? raw;
  if (!Array.isArray(data) && data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const nested = d.chains ?? d.rows ?? d.contracts ?? d.data;
    if (Array.isArray(nested)) data = nested;
  }
  if (!Array.isArray(data)) return [];

  const rows: OIContractRow[] = [];
  for (const r of data as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object') continue;

    const optionSymbol = (r.option_symbol as string | undefined)
      ?? (r.symbol as string | undefined)
      ?? (r.option as string | undefined)
      ?? null;

    const oi = intOrNull(r.open_interest ?? r.oi ?? r.openInterest);
    if (oi === null || oi <= 0) continue;  // skip zero-OI rows — not worth tracking

    // Derive from OCC symbol when fields missing
    const parsed = parseOptionSymbol(optionSymbol);

    const sideRaw = (r.side as string | undefined)
      ?? (r.type as string | undefined)
      ?? (r.option_type as string | undefined)
      ?? null;
    let side: 'C' | 'P' | null = null;
    if (sideRaw) {
      const s = sideRaw.toUpperCase();
      if (s.startsWith('C')) side = 'C';
      else if (s.startsWith('P')) side = 'P';
    }
    if (!side && parsed) side = parsed.side;

    const strike = numOrNull(r.strike ?? r.strike_price ?? r.strikePrice) ?? parsed?.strike ?? null;

    let expiry = (r.expiry as string | undefined)
      ?? (r.expiration as string | undefined)
      ?? (r.expiration_date as string | undefined)
      ?? (r.expires_at as string | undefined)
      ?? parsed?.expiry
      ?? null;
    // Normalize to YYYY-MM-DD
    if (expiry && expiry.length > 10) expiry = expiry.slice(0, 10);

    if (!optionSymbol) continue;

    rows.push({
      ticker,
      option_symbol: optionSymbol,
      strike,
      expiry,
      side,
      oi,
      volume_today: intOrNull(r.volume ?? r.total_volume ?? r.vol),
      raw: r,
    });
  }
  return rows;
}

/**
 * Probe nearest expiries for a ticker and return the top 20 calls + top 20 puts
 * by OI across those expiries.
 *
 * Strategy:
 *   1. Call get_options_chain(ticker) — server picks nearest (init) expiry, returns up to 50 rows.
 *   2. If rows contain multiple expiries, great — pick top-40 by OI.
 *   3. Otherwise, also call get_chains_for_expiry for any second nearby expiry
 *      we can discover from step 1, to get a wider set.
 */
async function pullTopOIContracts(ticker: string): Promise<{
  rows: OIContractRow[];
  errors: string[];
  mcpCalls: number;
}> {
  const errors: string[] = [];
  let mcpCalls = 0;
  const collected: OIContractRow[] = [];

  // Primary call: get_options_chain with default (init) expiry
  try {
    mcpCalls++;
    const raw = await mcpCallToolAsData('get_options_chain', { ticker, limit: 50 });
    const rows = extractContractRows(raw, ticker);
    collected.push(...rows);
  } catch (e) {
    if (isUwRateLimit(e)) {
      errors.push('rate_limit_primary');
      return { rows: [], errors, mcpCalls };
    }
    errors.push(`chain_primary: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`);
  }

  // If we got rows, discover unique expiries present
  const seenExpiries = new Set<string>();
  for (const r of collected) {
    if (r.expiry) seenExpiries.add(r.expiry);
  }

  // If we have fewer than 2 expiries OR fewer than 40 strikes, try to pull a second nearby expiry
  // via get_chains_for_expiry. We need a specific expiry string; use the nearest expiry present
  // + try the next weekly Friday after it.
  const expiryList = Array.from(seenExpiries).sort();
  let secondExpiry: string | null = null;
  if (expiryList.length >= 2) {
    // already have 2+ — don't bother probing more
  } else if (expiryList.length === 1) {
    // Probe the next Friday after the first expiry
    const firstDate = new Date(expiryList[0] + 'T00:00:00Z');
    const candidate = new Date(firstDate.getTime() + 7 * 24 * 60 * 60 * 1000);
    // Snap to Friday (day 5 UTC)
    const dow = candidate.getUTCDay();
    const daysToFri = (5 - dow + 7) % 7 || 7;
    candidate.setUTCDate(candidate.getUTCDate() + daysToFri - 7);
    if (candidate.getTime() > Date.now()) {
      secondExpiry = candidate.toISOString().slice(0, 10);
    }
  }

  if (secondExpiry) {
    try {
      mcpCalls++;
      const raw = await mcpCallToolAsData('get_chains_for_expiry', { ticker, expiry: secondExpiry, limit: 100 });
      const rows = extractContractRows(raw, ticker);
      collected.push(...rows);
    } catch (e) {
      if (!isUwRateLimit(e)) {
        errors.push(`chain_second: ${e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120)}`);
      }
    }
  }

  // Dedupe by option_symbol (defense vs overlapping expiries)
  const byKey = new Map<string, OIContractRow>();
  for (const r of collected) {
    const existing = byKey.get(r.option_symbol);
    if (!existing || r.oi > existing.oi) byKey.set(r.option_symbol, r);
  }
  const all = Array.from(byKey.values());

  // Filter: prefer contracts with expiry ≤ 60 DTE (monthlies + weeklies), drop LEAPs
  const filtered = all.filter(r => {
    if (!r.expiry) return true;  // keep if we can't tell
    const dte = daysUntil(r.expiry);
    return dte >= -1 && dte <= 60;
  });

  // Split calls / puts, take top 20 each by OI
  const calls = filtered.filter(r => r.side === 'C').sort((a, b) => b.oi - a.oi).slice(0, 20);
  const puts = filtered.filter(r => r.side === 'P').sort((a, b) => b.oi - a.oi).slice(0, 20);
  const unknown = filtered.filter(r => r.side === null).sort((a, b) => b.oi - a.oi).slice(0, 5);

  return {
    rows: [...calls, ...puts, ...unknown],
    errors,
    mcpCalls,
  };
}

/**
 * Pull per-contract OI for the TOP-20-BY-PREMIUM option_symbols in
 * ct_scored_flow (last 24h) for this ticker that aren't already in the
 * top-40 batch. Prevents the blank OI Δ1D column on /tape for the flow
 * contracts that actually matter for positioning signal.
 *
 * Capped at 20 per ticker per slot → ~20 × 10 tickers × 3 slots = ~600
 * calls/day instead of the uncapped ~1500/day that burned ~10% of UW
 * budget in 2 hours on 2026-04-24 morning. Long-tail contracts get
 * filtered out — they contribute no analytical value.
 *
 * Uses get_historic_chains (one MCP call per contract, newest-first).
 */
const FLOW_CONTRACT_CAP_PER_TICKER = 20;

async function pullFlowContractOIs(
  supabase: SupabaseClient,
  ticker: string,
  existingSymbols: Set<string>,
): Promise<{ rows: OIContractRow[]; errors: string[]; mcpCalls: number }> {
  const errors: string[] = [];
  let mcpCalls = 0;
  const rows: OIContractRow[] = [];

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('ct_scored_flow')
    .select('option_symbol, premium')
    .eq('ticker', ticker)
    .gte('event_ts', since)
    .not('option_symbol', 'is', null)
    .order('premium', { ascending: false, nullsFirst: false })
    .limit(400);

  if (error) {
    errors.push(`flow_query: ${error.message.slice(0, 120)}`);
    return { rows, errors, mcpCalls };
  }

  // Dedupe by option_symbol (keep first = highest-premium occurrence),
  // drop anything already in top-40 batch, cap at CAP_PER_TICKER.
  const seen = new Set<string>();
  const flowSymbols: string[] = [];
  for (const r of (data ?? [])) {
    const sym = r.option_symbol as string;
    if (!sym || seen.has(sym) || existingSymbols.has(sym)) continue;
    seen.add(sym);
    flowSymbols.push(sym);
    if (flowSymbols.length >= FLOW_CONTRACT_CAP_PER_TICKER) break;
  }

  for (const sym of flowSymbols) {
    try {
      mcpCalls++;
      const raw = await mcpCallToolAsData('get_historic_chains', { option_symbol: sym, limit: 3 });
      // Defensive extraction — UW returns `{ data: [{ date, open_interest, volume, ... }] }`
      const root = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : null;
      let arr: unknown = root?.data ?? root?.chains ?? raw;
      if (!Array.isArray(arr) && arr && typeof arr === 'object') {
        const d = arr as Record<string, unknown>;
        arr = d.data ?? d.chains ?? d.rows;
      }
      if (!Array.isArray(arr) || arr.length === 0) continue;

      // Take the newest row (UW returns newest-first typically, but be safe)
      const rowsRaw = (arr as Array<Record<string, unknown>>)
        .filter(r => r && typeof r === 'object')
        .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
      const r = rowsRaw[0];
      if (!r) continue;

      const oi = intOrNull(r.open_interest ?? r.oi ?? r.openInterest);
      if (oi === null || oi <= 0) continue;

      const parsed = parseOptionSymbol(sym);
      rows.push({
        ticker,
        option_symbol: sym,
        strike: parsed?.strike ?? null,
        expiry: parsed?.expiry ?? null,
        side: parsed?.side ?? null,
        oi,
        volume_today: intOrNull(r.volume ?? r.total_volume ?? r.vol),
        raw: { source: 'get_historic_chains', date: r.date ?? null },
      });
    } catch (e) {
      if (isUwRateLimit(e)) {
        errors.push('flow_rate_limit');
        break;  // stop — UW bucket is saturated
      }
      errors.push(`flow_hist:${sym.slice(0, 18)}: ${e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80)}`);
      continue;
    }
  }

  return { rows, errors, mcpCalls };
}

async function snapshotTicker(
  supabase: SupabaseClient,
  ticker: string,
  snapDate: string,
  snapSlot: SnapSlot,
): Promise<{ ticker: string; inserted: number; mcpCalls: number; errors: string[] }> {
  const { rows, errors, mcpCalls } = await pullTopOIContracts(ticker);

  // Bolt-on: capture OI for flow contracts NOT in the top-40 batch so the
  // /tape OI Δ1D column isn't blank on 99% of scored_flow rows.
  const existingSymbols = new Set(rows.map(r => r.option_symbol));
  const flowResult = await pullFlowContractOIs(supabase, ticker, existingSymbols);
  rows.push(...flowResult.rows);
  errors.push(...flowResult.errors);
  const totalMcpCalls = mcpCalls + flowResult.mcpCalls;

  if (rows.length === 0) {
    return { ticker, inserted: 0, mcpCalls: totalMcpCalls, errors: errors.length ? errors : ['no_rows'] };
  }

  const toUpsert = rows.map(r => ({
    ticker: r.ticker,
    snap_date: snapDate,
    snap_slot: snapSlot,
    option_symbol: r.option_symbol,
    strike: r.strike,
    expiry: r.expiry,
    side: r.side,
    oi: r.oi,
    volume_today: r.volume_today,
    raw: r.raw,
  }));

  const { error, count } = await supabase
    .from('ct_oi_snapshots')
    .upsert(toUpsert, {
      onConflict: 'ticker,snap_date,snap_slot,option_symbol',
      count: 'exact',
    });

  if (error) {
    errors.push(`upsert: ${error.message.slice(0, 200)}`);
    return { ticker, inserted: 0, mcpCalls: totalMcpCalls, errors };
  }
  return { ticker, inserted: count ?? toUpsert.length, mcpCalls: totalMcpCalls, errors };
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

  setUwCaller('ct-oi-snapshot');
  setMcpCaller('ct-oi-snapshot');

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  let body: { slot?: string } = {};
  try {
    body = await req.json();
  } catch { /* empty body is fine */ }

  // Resolve slot: body → URL hour fallback
  let snapSlot: SnapSlot;
  const bodySlot = (body.slot ?? '').toLowerCase();
  if (bodySlot === 'open' || bodySlot === 'mid' || bodySlot === 'close') {
    snapSlot = bodySlot;
  } else {
    snapSlot = deriveSlotFromHour();
  }

  const snapDate = new Date().toISOString().slice(0, 10);  // UTC date
  const tickers = [...WATCHLIST];

  const results: Array<{ ticker: string; inserted: number; mcpCalls: number; errors: string[] }> = [];
  let totalInserted = 0;
  let totalMcpCalls = 0;

  // Sequential per-ticker. UW has both a primary rate limit and a flow rate
  // limit; ~21 MCP calls per ticker × 10 tickers blew past the primary limit
  // in production for 12+ days (caught 2026-04-30) — the 5th-8th tickers
  // (MSFT/GOOGL/AMZN/META) consistently got `rate_limit_primary` while the
  // 9th-10th (NVDA/TSLA) recovered after the limiter cooled.
  //
  // Fix: 1.5s sleep between tickers + one retry-after-10s on rate_limit_primary.
  // Adds ~15s to total run time. Stays well under the 60s pg_net budget.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const isRateLimited = (errs: string[]) =>
    errs.some((e) => /rate_limit_primary/i.test(e));

  for (let i = 0; i < tickers.length; i++) {
    const ticker = tickers[i];
    if (i > 0) await sleep(1500);   // pace requests
    try {
      let r = await snapshotTicker(supabase, ticker, snapDate, snapSlot);
      if (r.inserted === 0 && isRateLimited(r.errors)) {
        // One retry after a 10s cooldown — UW rate limit usually resets faster.
        await sleep(10_000);
        const retry = await snapshotTicker(supabase, ticker, snapDate, snapSlot);
        if (retry.inserted > 0) {
          retry.errors = [...r.errors, 'rate_limit_recovered_on_retry', ...retry.errors];
          r = retry;
        } else {
          r = { ...retry, errors: [...r.errors, 'retry_also_rate_limited', ...retry.errors] };
        }
      }
      results.push(r);
      totalInserted += r.inserted;
      totalMcpCalls += r.mcpCalls;
    } catch (e) {
      results.push({
        ticker,
        inserted: 0,
        mcpCalls: 0,
        errors: [`fatal: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`],
      });
    }
  }

  // After all upserts: populate 1d/5d deltas
  let deltasUpdated = 0;
  let deltaErr: string | null = null;
  try {
    const { data, error } = await supabase.rpc('ct_compute_oi_deltas');
    if (error) deltaErr = error.message;
    else deltasUpdated = typeof data === 'number' ? data : 0;
  } catch (e) {
    deltaErr = e instanceof Error ? e.message : String(e);
  }

  const ok = totalInserted > 0;
  return new Response(JSON.stringify({
    ok,
    slot: snapSlot,
    snap_date: snapDate,
    tickers: tickers.length,
    total_inserted: totalInserted,
    total_mcp_calls: totalMcpCalls,
    deltas_updated: deltasUpdated,
    delta_err: deltaErr,
    per_ticker: results,
    duration_ms: Date.now() - startedAt,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
