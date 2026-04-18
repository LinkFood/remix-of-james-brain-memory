/**
 * ct-premarket-scan — overnight-gap scanner for the watchlist.
 *
 * Fires at 13:15 UTC (9:15 AM ET) weekdays — 15 min before the US cash open.
 * For each ticker in the configured watchlist (ct_config['watcher.watchlist'],
 * 12 by default) we:
 *   1) pull UW spot-exposures/strike to get the current (pre-market) underlying
 *      price — same wrapper everyone else uses, no new endpoint.
 *   2) derive a prev_close baseline:
 *        SPY  → most recent ct_spy_daily row BEFORE today
 *        else → most recent ct_heartbeats._snapshot.per_ticker.<T>.price
 *               captured BEFORE today
 *   3) compute gap_pct and tier, upsert into ct_premarket_gaps.
 *
 * Zero Claude calls in this function. We still log to ct_claude_usage with
 * zero tokens so the /health page's cost-attribution view picks the function
 * up and shows it "ran" — a silent cron is how bugs hide.
 *
 * Kill switch respected: returns the standard skip response when engaged.
 *
 * Pre-market liquidity caveat: UW spot-exposures underlying_price is the last
 * print from whatever venue UW aggregates. At 9:15 ET the tape can still be
 * sparse, so a 0.5% "gap" might be a single odd-lot print. We tier on absolute
 * % and leave interpretation to Claude / the morning brief.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { getSpotGexByStrike } from '../_shared/uwClient.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';

// ============================================================================
// Tier thresholds (absolute gap %). Keep in sync with the UI card + brief text.
// ============================================================================
const TIER_FLAT_MAX        = 0.2;   // < 0.2  → flat
const TIER_MINOR_MAX       = 0.5;   // 0.2 - 0.5 → minor
const TIER_MODERATE_MAX    = 1.5;   // 0.5 - 1.5 → moderate
const TIER_SIGNIFICANT_MAX = 3.0;   // 1.5 - 3   → significant
// > 3 → extreme

type Tier = 'flat' | 'minor' | 'moderate' | 'significant' | 'extreme';
type Direction = 'up' | 'down' | 'flat';

function tierFor(absPct: number): Tier {
  if (!Number.isFinite(absPct) || absPct < TIER_FLAT_MAX) return 'flat';
  if (absPct < TIER_MINOR_MAX) return 'minor';
  if (absPct < TIER_MODERATE_MAX) return 'moderate';
  if (absPct < TIER_SIGNIFICANT_MAX) return 'significant';
  return 'extreme';
}

function directionFor(pct: number): Direction {
  if (!Number.isFinite(pct) || Math.abs(pct) < TIER_FLAT_MAX) return 'flat';
  return pct > 0 ? 'up' : 'down';
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Extract the underlying price from a UW spot-exposures/strike payload.
 * Mirrors ct-spy-capture's extractClose — same endpoint, same envelope quirks.
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
  if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) {
    return extractSpotPrice(r.data);
  }
  return null;
}

// ============================================================================
// Prev-close sources
// ============================================================================

/**
 * SPY baseline — use the most recent ct_spy_daily row strictly before today.
 * ct-spy-capture writes this at 21:05 UTC (4:05 PM ET) every weekday, so by
 * 13:15 UTC the prior day's close is always present once we've been live a day.
 */
async function prevCloseForSpy(supabase: SupabaseClient, today: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('ct_spy_daily')
    .select('date, close')
    .lt('date', today)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.warn('[ct-premarket-scan] SPY prev-close query failed:', error.message);
    return null;
  }
  return typeof data?.close === 'number' ? data.close : (data?.close ? Number(data.close) : null);
}

/**
 * Non-SPY baseline — last heartbeat snapshot price captured BEFORE today
 * (i.e. yesterday's watcher cycles). ct-watcher writes current_reads._snapshot
 * every 30 min during market hours, so the most recent pre-today row is
 * effectively the 4pm close view through the watcher.
 */
async function prevCloseFromHeartbeat(
  supabase: SupabaseClient,
  ticker: string,
  today: string,
): Promise<number | null> {
  const todayUtcMidnight = `${today}T00:00:00.000Z`;
  const { data, error } = await supabase
    .from('ct_heartbeats')
    .select('current_reads, created_at')
    .lt('created_at', todayUtcMidnight)
    .order('created_at', { ascending: false })
    .limit(20); // scan a few — some rows may lack _snapshot (kill-switch heartbeats)
  if (error) {
    console.warn(`[ct-premarket-scan] heartbeat query failed for ${ticker}:`, error.message);
    return null;
  }
  for (const row of data ?? []) {
    const cr = row.current_reads as Record<string, unknown> | null;
    const snap = cr?._snapshot as Record<string, unknown> | undefined;
    const perTicker = snap?.per_ticker as Record<string, { price?: number | null }> | undefined;
    const price = perTicker?.[ticker]?.price;
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

async function resolvePrevClose(
  supabase: SupabaseClient,
  ticker: string,
  today: string,
): Promise<number | null> {
  if (ticker === 'SPY') {
    const fromDaily = await prevCloseForSpy(supabase, today);
    if (fromDaily != null) return fromDaily;
    // SPY falls back to heartbeat if ct_spy_daily is empty (first-day scenario).
    return prevCloseFromHeartbeat(supabase, ticker, today);
  }
  return prevCloseFromHeartbeat(supabase, ticker, today);
}

// ============================================================================
// Entrypoint
// ============================================================================

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

  // Kill switch — no scan, no writes.
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-premarket-scan', corsHeaders);
  }

  const startedAt = Date.now();
  const today = todayIsoDate();

  // Tunable watchlist — one config read per invocation. Falls back to the
  // shared DEFAULT_WATCHLIST inside getWatchlist if ct_config is unreadable.
  const watchlist = await getWatchlist(supabase);

  interface ScanRow {
    ticker: string;
    prev_close: number | null;
    premarket_price: number | null;
    gap_pct: number | null;
    magnitude_tier: Tier | null;
    gap_direction: Direction | null;
    skipped_reason?: string;
  }

  const results: ScanRow[] = [];
  const errors: Array<{ ticker: string; error: string }> = [];

  for (const ticker of watchlist) {
    // 1) UW spot call
    let raw: unknown;
    try {
      raw = await getSpotGexByStrike(ticker);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ ticker, error: `uw: ${msg.slice(0, 160)}` });
      results.push({ ticker, prev_close: null, premarket_price: null, gap_pct: null, magnitude_tier: null, gap_direction: null, skipped_reason: 'uw_failed' });
      continue;
    }
    const premarket = extractSpotPrice(raw);
    if (premarket == null) {
      errors.push({ ticker, error: 'no price in UW payload' });
      results.push({ ticker, prev_close: null, premarket_price: null, gap_pct: null, magnitude_tier: null, gap_direction: null, skipped_reason: 'no_premarket_price' });
      continue;
    }

    // 2) baseline
    const prevClose = await resolvePrevClose(supabase, ticker, today);
    if (prevClose == null || prevClose === 0) {
      // Graceful skip: still write a row so the UI / brief can see "we looked,
      // baseline missing" rather than pretending this ticker doesn't exist.
      results.push({
        ticker,
        prev_close: null,
        premarket_price: +premarket.toFixed(4),
        gap_pct: null,
        magnitude_tier: null,
        gap_direction: null,
        skipped_reason: 'no_baseline',
      });
      const { error: upErr } = await supabase
        .from('ct_premarket_gaps')
        .upsert({
          session_date: today,
          ticker,
          prev_close: null,
          premarket_price: +premarket.toFixed(4),
          gap_direction: null,
          magnitude_tier: null,
        }, { onConflict: 'session_date,ticker' });
      if (upErr) errors.push({ ticker, error: `upsert: ${upErr.message}` });
      continue;
    }

    // 3) compute
    const gapPct = (premarket - prevClose) / prevClose * 100;
    const abs = Math.abs(gapPct);
    const tier = tierFor(abs);
    const dir = directionFor(gapPct);

    results.push({
      ticker,
      prev_close: +prevClose.toFixed(4),
      premarket_price: +premarket.toFixed(4),
      gap_pct: +gapPct.toFixed(4),
      magnitude_tier: tier,
      gap_direction: dir,
    });

    const { error: upErr } = await supabase
      .from('ct_premarket_gaps')
      .upsert({
        session_date: today,
        ticker,
        prev_close: +prevClose.toFixed(4),
        premarket_price: +premarket.toFixed(4),
        gap_direction: dir,
        magnitude_tier: tier,
      }, { onConflict: 'session_date,ticker' });
    if (upErr) errors.push({ ticker, error: `upsert: ${upErr.message}` });
  }

  // Summary — gapped = tier >= moderate (the brief's threshold).
  const moderateOrWorse = results.filter(r =>
    r.magnitude_tier === 'moderate' ||
    r.magnitude_tier === 'significant' ||
    r.magnitude_tier === 'extreme'
  );
  let largest: { ticker: string; pct: number } | null = null;
  for (const r of results) {
    if (r.gap_pct == null) continue;
    if (!largest || Math.abs(r.gap_pct) > Math.abs(largest.pct)) {
      largest = { ticker: r.ticker, pct: r.gap_pct };
    }
  }

  // Zero-token log — source='ct-premarket-scan' shows up on /health even though
  // no Claude call happened. Uses cost_usd_override so the row writes.
  logClaudeUsage(supabase, {
    source: 'ct-premarket-scan',
    model: 'n/a',
    usage: { input_tokens: 0, output_tokens: 0 },
    duration_ms: Date.now() - startedAt,
    cost_usd_override: 0.000001, // hair above zero so the logger writes the row
    metadata: {
      session_date: today,
      scanned: results.length,
      gapped_moderate_plus: moderateOrWorse.length,
      errors: errors.length,
      largest,
    },
  });

  return new Response(JSON.stringify({
    ok: true,
    session_date: today,
    scanned: results.length,
    gapped: moderateOrWorse.length,
    largest,
    results,
    errors,
    duration_ms: Date.now() - startedAt,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
