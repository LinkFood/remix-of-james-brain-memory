/**
 * ct-price-tick-capture — 2-minute-resolution spot price capture for the
 * watchlist + SPX + VIX. Populates ct_price_ticks for TickerChartWithAlerts
 * and Monte Carlo actual-vs-projected views.
 *
 * CADENCE: every 2 min during RTH (Mon–Fri 13:00–20:59 UTC). Driven by
 *   pg_cron `*\/2 13-20 * * 1-5` (see 20260420000026_price_ticks.sql).
 *
 * UW BUDGET
 *   13 UW calls per tick (12 watchlist + SPX via getSpotGexByStrike, +1
 *   getVixSpot which is VIX w/ VIXY fallback → usually 1 call).
 *   = 13 calls × 30 ticks/hr × 6.5 hr × 5 days = 2,535/day ≈ 12.7% of the
 *   20k/day UW budget. (Upper-bound if VIX always falls back to VIXY:
 *   14 × 30 × 6.5 × 5 = 2,730/day ≈ 13.7%.)
 *
 *   1-min cadence rejected: would be 5,070–5,460/day = 25–27% of budget
 *   for a single feature. If James later OKs the cost, flipping the cron
 *   to `* 13-20 * * 1-5` is the only change needed here.
 *
 * KILL SWITCH: respected per the standard pattern — if active, skip with a
 * 200 response and write a kill-switch heartbeat row.
 *
 * ERROR POLICY: per-ticker failures are logged to errors[] but do not abort
 * the cycle. Whatever prices we got still get inserted. Matches ct-watcher.
 *
 * DUPES: unique(ticker, tick_time) + upsert with ignore-on-conflict.
 * tick_time is rounded to the 2-min boundary so the key is stable within a
 * cron tick even if the function runs slightly late.
 *
 * Auth: service role only (invoked by pg_cron).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import {
  getSpotGexByStrike,
  getVixSpot,
  WATCHLIST,
  MARKET_BANNER_SYMBOL,
} from '../_shared/uwClient.ts';

// -- Capture cadence in ms (must mirror the cron `*/2` schedule). ------
const CAPTURE_WINDOW_MS = 2 * 60 * 1000;

/**
 * Extract underlying price from a spot-exposures payload. Defensive — the
 * field occasionally lands nested under `.data` or `.data[0]`. Mirrors
 * extractSpotPrice in uwClient.ts for parity.
 */
function extractSpotPrice(raw: unknown): number | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const candidates = ['price', 'spot', 'underlying_price', 'last_price', 'close'];
  for (const k of candidates) {
    const v = r[k];
    if (v === undefined || v === null) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const data = (r as { data?: unknown }).data;
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown>;
    for (const k of candidates) {
      const v = first[k];
      if (v === undefined || v === null) continue;
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return extractSpotPrice(data);
  }
  return null;
}

/** Round a Date down to the most recent 2-min boundary (UTC). */
function roundToWindow(d: Date): Date {
  const t = d.getTime();
  return new Date(t - (t % CAPTURE_WINDOW_MS));
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Kill switch — skip entire capture if engaged.
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-price-tick-capture', corsHeaders);
  }

  const tickTime = roundToWindow(new Date());
  const tickIso = tickTime.toISOString();

  interface Row {
    ticker: string;
    tick_time: string;
    price: number;
  }
  const rows: Row[] = [];
  const errors: Array<{ ticker: string; error: string }> = [];

  // ----- Watchlist (12) + SPX via spot-exposures/strike ------------------
  const stockTargets: string[] = [...WATCHLIST, MARKET_BANNER_SYMBOL];
  for (const ticker of stockTargets) {
    try {
      const raw = await getSpotGexByStrike(ticker);
      const price = extractSpotPrice(raw);
      if (price == null) {
        errors.push({ ticker, error: 'no usable price in UW payload' });
        continue;
      }
      rows.push({ ticker, tick_time: tickIso, price: +price.toFixed(4) });
    } catch (e) {
      errors.push({ ticker, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ----- VIX (or VIXY fallback) ------------------------------------------
  // getVixSpot() tries VIX first (1 call), falls back to VIXY (2 calls)
  // only if the first returns no usable price. Source is preserved in the
  // ticker column so consumers can disambiguate proxy rows.
  try {
    const vix = await getVixSpot();
    if (vix) {
      rows.push({
        ticker: vix.source, // 'VIX' or 'VIXY' — caller knows which it got
        tick_time: tickIso,
        price: +vix.level.toFixed(4),
      });
    } else {
      errors.push({ ticker: 'VIX', error: 'VIX + VIXY both unavailable' });
    }
  } catch (e) {
    errors.push({ ticker: 'VIX', error: e instanceof Error ? e.message : String(e) });
  }

  // ----- Bulk upsert. Ignore dupes (cron retry or boundary jitter). -------
  let inserted = 0;
  if (rows.length > 0) {
    const { error: upErr, count } = await supabase
      .from('ct_price_ticks')
      .upsert(rows, { onConflict: 'ticker,tick_time', ignoreDuplicates: true, count: 'estimated' });
    if (upErr) {
      console.error('[ct-price-tick-capture] upsert failed:', upErr.message);
      return new Response(
        JSON.stringify({ error: upErr.message, attempted: rows.length, errors }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }
    inserted = count ?? rows.length;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      tick_time: tickIso,
      tickers_captured: rows.length,
      inserted,
      errors,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
