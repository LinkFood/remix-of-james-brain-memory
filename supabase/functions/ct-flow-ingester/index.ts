/**
 * ct-flow-ingester — the product-defining data we missed.
 *
 * Pulls market-wide unusual options flow + dark pool prints + (optionally)
 * per-ticker net premium ticks. Deduplicates via alert_id / print_id to
 * avoid re-ingesting the same event across polls.
 *
 * Cron: every 3 min during market hours (aggressive cadence — flow is
 * event-driven, freshness is the point).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getFlowAlerts, getDarkPoolRecent, getDarkPool, getNetPremiumTicks, getNope, getGreekFlow, getTopNetImpact, getSweepScreener, WATCHLIST } from '../_shared/uwClient.ts';
import { mcpCallToolAsData, isUwRateLimit } from '../_shared/uwMcpClient.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';

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

async function ingestFlowAlerts(supabase: SupabaseClient, extraArgs: Record<string, unknown> = {}): Promise<{ seen: number; inserted: number; path: 'mcp' | 'legacy' }> {
  // Wave N.2 — prefer MCP `get_flow_alerts`. Fall back to legacy REST on failure.
  // extraArgs lets the per-ticker pass pin the call to a single ticker
  // (see ingestFlowAlertsPerTicker). Empty = original market-wide behavior.
  let raw: unknown = null;
  let path: 'mcp' | 'legacy' = 'mcp';
  try {
    raw = await mcpCallToolAsData('get_flow_alerts', { limit: 100, ...extraArgs });
  } catch (mcpErr) {
    if (isUwRateLimit(mcpErr)) {
      console.warn('[ct-flow] flow-alerts MCP rate-limited, skipping');
      return { seen: 0, inserted: 0, path: 'legacy' };
    }
    const msg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
    await recordDecision(supabase, {
      decision_type: 'stress_check',
      model_tier: 'none',
      reasoning: `MCP fallback on ct-flow-ingester/flow_alerts: ${msg.slice(0, 400)}`,
    });
    path = 'legacy';
    try {
      raw = await getFlowAlerts({ limit: 100, ...extraArgs });
    } catch (e) {
      console.warn('[ct-flow] flow-alerts legacy pull failed:', e instanceof Error ? e.message : e);
      return { seen: 0, inserted: 0, path };
    }
  }

  try {
    const data = (raw && typeof raw === 'object') ? (raw as { data?: unknown }).data : null;
    if (!Array.isArray(data) || data.length === 0) return { seen: 0, inserted: 0, path };

    // WATCHLIST FILTER AT INSERTION (added 2026-04-27 evening).
    // Per James + tenet 4 (universe lock): /tape, specialists, and detectors
    // are all watchlist-only by design. Off-watchlist alerts get fetched by
    // the market-wide UW call but were being WRITTEN to ct_flow_alerts even
    // though no consumer reads them. Today's audit: 5,236 of 6,799 alerts
    // (77%) were off-watchlist noise — bloated DB, slowed detector scans,
    // cluttered /tape's "ALL" view. Filter at insertion = invisible to all
    // downstream code, since detectors already filter via .in('ticker', WL).
    const rows = (data as Array<Record<string, unknown>>)
      .map((r) => ({
        alert_id: (r.id as string | undefined) ?? (r.alert_id as string | undefined) ?? `${r.ticker_symbol}-${r.executed_at ?? r.timestamp ?? ''}-${r.option_symbol ?? ''}`,
        ticker: (r.ticker_symbol as string | undefined) ?? (r.ticker as string | undefined) ?? 'UNKNOWN',
        option_symbol: (r.option_symbol as string | undefined) ?? null,
        strike: numOrNull(r.strike),
        expiry: (r.expiry as string | undefined) ?? (r.expiration as string | undefined) ?? null,
        side: (r.type as string | undefined) ?? (r.side as string | undefined) ?? null,
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
        executed_at: (r.executed_at as string | undefined) ?? (r.timestamp as string | undefined) ?? null,
        alert_type: (r.alert_type as string | undefined) ?? (r.type as string | undefined) ?? null,
        raw: r,
      }))
      .filter((r) => WATCHLIST.includes(r.ticker as typeof WATCHLIST[number]));

    if (rows.length === 0) return { seen: 0, inserted: 0, path };

    const { error, count } = await supabase
      .from('ct_flow_alerts')
      .upsert(rows, { onConflict: 'alert_id', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn('[ct-flow] flow upsert failed:', error.message);
      return { seen: rows.length, inserted: 0, path };
    }
    return { seen: rows.length, inserted: count ?? rows.length, path };
  } catch (e) {
    console.warn('[ct-flow] flow-alerts shape failed:', e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0, path };
  }
}

async function ingestDarkPool(
  supabase: SupabaseClient,
  ticker: string | null,
): Promise<{ seen: number; inserted: number }> {
  // Wave N.2 — prefer MCP `get_dark_pool_trades`. Fall back to legacy.
  let raw: unknown = null;
  try {
    const mcpArgs: Record<string, unknown> = { limit: 100 };
    if (ticker) mcpArgs.ticker = ticker;
    raw = await mcpCallToolAsData('get_dark_pool_trades', mcpArgs);
  } catch (mcpErr) {
    if (isUwRateLimit(mcpErr)) {
      return { seen: 0, inserted: 0 };
    }
    const msg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
    await recordDecision(supabase, {
      decision_type: 'stress_check',
      model_tier: 'none',
      reasoning: `MCP fallback on ct-flow-ingester/dark_pool ${ticker ?? 'recent'}: ${msg.slice(0, 300)}`,
    });
    try {
      raw = ticker ? await getDarkPool(ticker) : await getDarkPoolRecent();
    } catch (e) {
      console.warn(`[ct-flow] dark-pool legacy failed (${ticker ?? 'recent'}):`, e instanceof Error ? e.message : e);
      return { seen: 0, inserted: 0 };
    }
  }

  try {
    const data = (raw && typeof raw === 'object') ? (raw as { data?: unknown }).data : null;
    if (!Array.isArray(data) || data.length === 0) return { seen: 0, inserted: 0 };

    const rows = (data as Array<Record<string, unknown>>).map((r) => ({
      print_id: (r.id as string | undefined) ?? (r.tracking_id as string | undefined) ?? `${r.ticker ?? ticker}-${r.executed_at ?? r.timestamp ?? ''}-${r.size ?? ''}-${r.price ?? ''}`,
      ticker: (r.ticker as string | undefined) ?? ticker ?? 'UNKNOWN',
      size: numOrNull(r.size) ?? 0,
      price: numOrNull(r.price) ?? 0,
      volume: numOrNull(r.volume),
      sale_code: (r.sale_code as string | undefined) ?? null,
      exchange: (r.exchange as string | undefined) ?? null,
      market_center: (r.market_center as string | undefined) ?? null,
      executed_at: (r.executed_at as string | undefined) ?? (r.timestamp as string | undefined) ?? null,
      raw: r,
    }));

    const { error, count } = await supabase
      .from('ct_dark_pool_prints')
      .upsert(rows, { onConflict: 'print_id', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn(`[ct-flow] dark-pool upsert failed (${ticker ?? 'recent'}):`, error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn(`[ct-flow] dark-pool pull failed (${ticker ?? 'recent'}):`, e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

async function ingestNope(
  supabase: SupabaseClient,
  ticker: string,
): Promise<{ seen: number; inserted: number }> {
  try {
    const raw = await getNope(ticker);
    const data = (raw && typeof raw === 'object') ? (raw as { data?: unknown }).data : null;
    if (!Array.isArray(data) || data.length === 0) return { seen: 0, inserted: 0 };
    const tail = (data as Array<Record<string, unknown>>).slice(-30);
    const rows = tail.map((r) => ({
      ticker,
      tick_timestamp: (r.timestamp as string | undefined) ?? (r.tick_timestamp as string | undefined) ?? new Date().toISOString(),
      nope: numOrNull(r.nope ?? r.value),
      underlying_price: numOrNull(r.underlying_price ?? r.price),
      raw: r,
    })).filter(r => r.tick_timestamp);
    const { error, count } = await supabase
      .from('ct_nope_minute')
      .upsert(rows, { onConflict: 'ticker,tick_timestamp', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn(`[ct-flow] nope upsert failed (${ticker}):`, error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn(`[ct-flow] nope pull failed (${ticker}):`, e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

async function ingestGreekFlow(
  supabase: SupabaseClient,
  ticker: string,
): Promise<{ seen: number; inserted: number }> {
  try {
    const raw = await getGreekFlow(ticker);
    // UW returns { data: [...] } most commonly; be defensive about top-level shape
    const root = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : null;
    let data: unknown = root?.data ?? root?.chains ?? raw;
    if (!Array.isArray(data)) {
      // Sometimes shapes like { data: { chains: [...] } }
      const nested = (data as Record<string, unknown> | null)?.chains
        ?? (data as Record<string, unknown> | null)?.flow;
      if (Array.isArray(nested)) data = nested;
    }
    if (!Array.isArray(data) || data.length === 0) return { seen: 0, inserted: 0 };

    const tail = (data as Array<Record<string, unknown>>).slice(-60);

    const rows = tail.map((r) => {
      // UW greek-flow shape (observed 2026-04-16):
      //   { ticker, timestamp, volume, transactions,
      //     dir_delta_flow, dir_vega_flow,           ← SIGNED net direction (HIRO integrand)
      //     total_delta_flow, total_vega_flow,       ← UNSIGNED total volume
      //     otm_dir_delta_flow, otm_dir_vega_flow, otm_total_delta_flow, otm_total_vega_flow }
      //
      // dir_delta_flow is the signed net dealer hedging direction per minute — this is
      // what we cumsum for HIRO. If UW ever adds a call/put split, we pick it up too.
      const nCallD = numOrNull(r.net_call_delta ?? r.call_delta ?? r.dealer_call_delta);
      const nPutD = numOrNull(r.net_put_delta ?? r.put_delta ?? r.dealer_put_delta);
      const nCallV = numOrNull(r.net_call_vega ?? r.call_vega ?? r.dealer_call_vega);
      const nPutV = numOrNull(r.net_put_vega ?? r.put_vega ?? r.dealer_put_vega);

      // Prefer the signed directional flow. Fall back to derived call-put if UW
      // changes shape later. total_delta_flow in UW is unsigned volume — ignore.
      let totalDelta = numOrNull(r.dir_delta_flow ?? r.directional_delta_flow);
      if (totalDelta === null && (nCallD !== null || nPutD !== null)) {
        totalDelta = (nCallD ?? 0) - (nPutD ?? 0);
      }
      let totalVega = numOrNull(r.dir_vega_flow ?? r.directional_vega_flow);
      if (totalVega === null && (nCallV !== null || nPutV !== null)) {
        totalVega = (nCallV ?? 0) - (nPutV ?? 0);
      }

      return {
        ticker,
        tick_timestamp: (r.timestamp as string | undefined)
          ?? (r.tick_timestamp as string | undefined)
          ?? (r.time as string | undefined)
          ?? new Date().toISOString(),
        net_call_delta: nCallD,
        net_put_delta: nPutD,
        net_call_vega: nCallV,
        net_put_vega: nPutV,
        total_delta_flow: totalDelta,
        total_vega_flow: totalVega,
        underlying_price: numOrNull(r.underlying_price ?? r.price),
        raw: r,
      };
    }).filter(r => r.tick_timestamp);

    const { error, count } = await supabase
      .from('ct_greek_flow_minute')
      .upsert(rows, { onConflict: 'ticker,tick_timestamp', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn(`[ct-flow] greek-flow upsert failed (${ticker}):`, error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn(`[ct-flow] greek-flow pull failed (${ticker}):`, e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

async function ingestTopMovers(supabase: SupabaseClient): Promise<{ seen: number; inserted: number }> {
  try {
    const raw = await getTopNetImpact();
    // UW shape: { data: { bullish: [...], bearish: [...] } } — be defensive
    const root = (raw && typeof raw === 'object') ? (raw as { data?: unknown }).data : null;
    const snapshotAt = new Date().toISOString();
    const rows: Array<Record<string, unknown>> = [];

    const bullish = (root as { bullish?: unknown[] } | null)?.bullish;
    const bearish = (root as { bearish?: unknown[] } | null)?.bearish;
    const seenTickers = new Set<string>();

    if (Array.isArray(bullish)) {
      (bullish as Array<Record<string, unknown>>).forEach((r, i) => {
        const ticker = r.ticker as string | undefined;
        if (!ticker) return;
        const key = `b-${ticker}`;
        if (seenTickers.has(key)) return;
        seenTickers.add(key);
        rows.push({
          snapshot_at: snapshotAt,
          ticker,
          side: 'bullish',
          rank: i + 1,
          net_premium: numOrNull(r.net_premium ?? r.net_call_premium),
          raw: r,
        });
      });
    }
    if (Array.isArray(bearish)) {
      (bearish as Array<Record<string, unknown>>).forEach((r, i) => {
        const ticker = r.ticker as string | undefined;
        if (!ticker) return;
        const key = `s-${ticker}`;
        if (seenTickers.has(key)) return;
        seenTickers.add(key);
        rows.push({
          snapshot_at: snapshotAt,
          ticker,
          side: 'bearish',
          rank: i + 1,
          net_premium: numOrNull(r.net_premium ?? r.net_put_premium),
          raw: r,
        });
      });
    }

    if (rows.length === 0) return { seen: 0, inserted: 0 };
    const { error } = await supabase.from('ct_top_movers').insert(rows);
    if (error) {
      console.warn('[ct-flow] top-movers insert failed:', error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: rows.length };
  } catch (e) {
    console.warn('[ct-flow] top-net-impact pull failed:', e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

async function ingestSweeps(supabase: SupabaseClient): Promise<{ seen: number; inserted: number }> {
  // Wave N.2 — prefer MCP `get_options_screener` (sweep preset params).
  let raw: unknown = null;
  try {
    raw = await mcpCallToolAsData('get_options_screener', {
      limit: 60,
      min_premium: 100_000,
      min_sweep_volume_ratio: 0.7,
      vol_greater_oi: true,
      is_otm: true,
    });
  } catch (mcpErr) {
    if (isUwRateLimit(mcpErr)) {
      return { seen: 0, inserted: 0 };
    }
    const msg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
    await recordDecision(supabase, {
      decision_type: 'stress_check',
      model_tier: 'none',
      reasoning: `MCP fallback on ct-flow-ingester/sweeps: ${msg.slice(0, 300)}`,
    });
    try {
      raw = await getSweepScreener(60);
    } catch (e) {
      console.warn('[ct-flow] sweeps legacy failed:', e instanceof Error ? e.message : e);
      return { seen: 0, inserted: 0 };
    }
  }

  try {
    const data = (raw && typeof raw === 'object') ? (raw as { data?: unknown }).data : null;
    if (!Array.isArray(data) || data.length === 0) return { seen: 0, inserted: 0 };
    const snapshotAt = new Date().toISOString();
    const rows = (data as Array<Record<string, unknown>>).map((r) => {
      const optionSymbol = (r.option_symbol as string | undefined) ?? null;
      // OCC format: ROOT+YYMMDD+C/P+StrikeX1000(8 digits)
      const occ = optionSymbol ? optionSymbol.match(/^([A-Z0-9]+?)(\d{6})([CP])(\d{8})$/) : null;
      const derivedType = occ ? occ[3] : null;
      const derivedExpiry = occ ? `20${occ[2].slice(0, 2)}-${occ[2].slice(2, 4)}-${occ[2].slice(4, 6)}` : null;
      const derivedStrike = occ ? parseInt(occ[4], 10) / 1000 : null;
      const askVol = numOrNull(r.ask_side_volume);
      const bidVol = numOrNull(r.bid_side_volume);
      const askPerc = (askVol != null && bidVol != null && (askVol + bidVol) > 0)
        ? (askVol / (askVol + bidVol)) * 100
        : numOrNull(r.ask_side_perc);
      return {
        ticker: (r.ticker_symbol as string | undefined) ?? (r.ticker as string | undefined) ?? 'UNKNOWN',
        option_symbol: optionSymbol,
        strike: numOrNull(r.strike) ?? derivedStrike,
        expiry: (r.expiry as string | undefined) ?? (r.expiration as string | undefined) ?? derivedExpiry,
        type: (r.type as string | undefined) ?? derivedType,
        premium: numOrNull(r.premium ?? r.total_premium),
        volume: numOrNull(r.volume ?? r.total_volume),
        open_interest: numOrNull(r.open_interest),
        sweep_ratio: numOrNull(r.sweep_volume_ratio ?? r.sweep_ratio),
        ask_side_perc: askPerc,
        snapshot_at: snapshotAt,
        raw: r,
      };
    }).filter(r => r.option_symbol);
    const { error, count } = await supabase
      .from('ct_sweeps')
      .upsert(rows, { onConflict: 'option_symbol,snapshot_at', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn('[ct-flow] sweeps upsert failed:', error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn('[ct-flow] sweep-screener pull failed:', e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

/**
 * ingestFlowAlertsPerTicker — loops the watchlist and calls
 * `get_flow_alerts` per ticker. The market-wide pass in ingestFlowAlerts
 * rarely includes index/mega-cap names (they don't look "unusual" on UW's
 * market-wide screener), leaving v2 specialists with no scored flow to
 * wake up on. This fixes the blocker: one MCP call per watchlist ticker,
 * upserted to ct_flow_alerts with the same schema + dedupe key.
 *
 * Cost: 10 calls / ingester run. At 3-min cadence during RTH (~20 runs/hr
 * * 7 hrs = 140 runs/day), that's 1,400 calls/day — well under UW's
 * 50k/day budget. Errors per-ticker isolate (loop continues on failure).
 */
async function ingestFlowAlertsPerTicker(
  supabase: SupabaseClient,
  tickers: readonly string[],
): Promise<{ seen: number; inserted: number; per_ticker: Record<string, { seen: number; inserted: number }> }> {
  const perTicker: Record<string, { seen: number; inserted: number }> = {};
  let totalSeen = 0;
  let totalInserted = 0;
  for (const ticker of tickers) {
    try {
      const r = await ingestFlowAlerts(supabase, { ticker_symbol: ticker, limit: 50 });
      perTicker[ticker] = { seen: r.seen, inserted: r.inserted };
      totalSeen += r.seen;
      totalInserted += r.inserted;
    } catch (e) {
      console.warn(`[ct-flow] per-ticker flow-alerts failed (${ticker}):`, e instanceof Error ? e.message : e);
      perTicker[ticker] = { seen: 0, inserted: 0 };
    }
  }
  return { seen: totalSeen, inserted: totalInserted, per_ticker: perTicker };
}

async function ingestNetPremiumTicks(
  supabase: SupabaseClient,
  ticker: string,
): Promise<{ seen: number; inserted: number }> {
  try {
    const raw = await getNetPremiumTicks(ticker);
    const data = (raw && typeof raw === 'object') ? (raw as { data?: unknown }).data : null;
    if (!Array.isArray(data) || data.length === 0) return { seen: 0, inserted: 0 };

    // UW returns tick-level — take recent tail only to keep ingest tight
    const tail = (data as Array<Record<string, unknown>>).slice(-50);

    const rows = tail.map((r) => ({
      ticker,
      tick_timestamp: (r.timestamp as string | undefined) ?? (r.tick_timestamp as string | undefined) ?? new Date().toISOString(),
      net_call_premium: numOrNull(r.net_call_premium),
      net_put_premium: numOrNull(r.net_put_premium),
      net_call_volume: numOrNull(r.net_call_volume),
      net_put_volume: numOrNull(r.net_put_volume),
      underlying_price: numOrNull(r.underlying_price ?? r.price),
      raw: r,
    })).filter(r => r.tick_timestamp);

    const { error, count } = await supabase
      .from('ct_net_premium_ticks')
      .upsert(rows, { onConflict: 'ticker,tick_timestamp', ignoreDuplicates: true, count: 'exact' });
    if (error) {
      console.warn(`[ct-flow] net-prem-ticks upsert failed (${ticker}):`, error.message);
      return { seen: rows.length, inserted: 0 };
    }
    return { seen: rows.length, inserted: count ?? rows.length };
  } catch (e) {
    console.warn(`[ct-flow] net-prem-ticks pull failed (${ticker}):`, e instanceof Error ? e.message : e);
    return { seen: 0, inserted: 0 };
  }
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedAt = Date.now();

  // Optional invocation flag: skip the market-wide pass when called from
  // the per-ticker-only cron lane. Lets us run per-ticker every 5min while
  // market-wide runs every 30min — saves UW calls on noisy market-wide
  // data we mostly filter out anyway. Body shape: {"per_ticker_only": true}
  let perTickerOnly = false;
  try {
    const body = await req.clone().json().catch(() => ({}));
    perTickerOnly = body && typeof body === 'object' && body.per_ticker_only === true;
  } catch { /* no body or invalid JSON — keep default */ }

  try {
    // Market-wide flow + market context (top movers + sweeps). Skipped when
    // per_ticker_only=true (the every-5min lane). Otherwise runs every 30min
    // via the market-wide lane. Cuts ~250 UW calls/day vs running market-
    // wide on every 5min invocation.
    const flow = perTickerOnly
      ? { seen: 0, inserted: 0, path: 'mcp' as const }
      : await ingestFlowAlerts(supabase);
    // Per-watchlist flow alerts — the fix for "0 watchlist sweeps captured".
    // Market-wide pass rarely lands on SPY/QQQ/IWM/Mag7; specialists need
    // scored flow on the watchlist to wake up and write flags (Co-Trader v2).
    const perTickerFlow = await ingestFlowAlertsPerTicker(supabase, WATCHLIST);
    // Dark pool removed 2026-04-23 — we can't reliably classify direction
    // and it was burning ~14% of UW budget for noise. Freed calls reallocated
    // to net-premium ticks (more often) + greek-flow (all 12 tickers).
    const topMovers = perTickerOnly
      ? { inserted: 0 }
      : await ingestTopMovers(supabase);
    const sweeps = perTickerOnly
      ? { inserted: 0 }
      : await ingestSweeps(supabase);

    // Per-ticker net premium + greek flow + NOPE for ALL watchlist tickers.
    // NOPE was previously index-only (SPY/QQQ/IWM) under the theory that it's
    // less useful on individual names. Reopened 2026-04-24: James wants the
    // sparkline on every macro-banner tile, not just indexes. UW supports
    // /nope for any ticker; ~10 extra calls per 3-min ingest cycle is a
    // ~0.5% budget impact against the 20k daily cap.
    const perTicker: Record<string, { npt: { seen: number; inserted: number }; nope?: { seen: number; inserted: number }; greek?: { seen: number; inserted: number } }> = {};
    for (const ticker of WATCHLIST) {
      perTicker[ticker] = {
        npt: await ingestNetPremiumTicks(supabase, ticker),
        greek: await ingestGreekFlow(supabase, ticker),
        nope: await ingestNope(supabase, ticker),
      };
    }

    const totalNptNew = Object.values(perTicker).reduce((s, t) => s + t.npt.inserted, 0);
    const totalNopeNew = Object.values(perTicker).reduce((s, t) => s + (t.nope?.inserted ?? 0), 0);
    const totalGreekNew = Object.values(perTicker).reduce((s, t) => s + (t.greek?.inserted ?? 0), 0);

    return new Response(JSON.stringify({
      success: true,
      flow_alerts: { seen: flow.seen, inserted: flow.inserted },
      flow_alerts_per_ticker: {
        seen: perTickerFlow.seen,
        inserted: perTickerFlow.inserted,
        per_ticker: perTickerFlow.per_ticker,
      },
      net_premium_ticks: { total_inserted: totalNptNew },
      nope: { total_inserted: totalNopeNew },
      greek_flow: { total_inserted: totalGreekNew },
      top_movers: { inserted: topMovers.inserted },
      sweeps: { seen: sweeps.seen, inserted: sweeps.inserted },
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[ct-flow-ingester] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
