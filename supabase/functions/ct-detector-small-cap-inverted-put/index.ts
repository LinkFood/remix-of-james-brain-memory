/**
 * ct-detector-small-cap-inverted-put (small_cap_inverted_put_v1) — TSLA/IWM
 * aggressive bid-side put prints, fired as bearish-underlying alarms.
 *
 * Per corpus 2026-04-20→24: TSLA/IWM put + is_bid pattern fires at 14% hit
 * rate raw (anti-signal as written), but 100% of TSLA+IWM winners (81 of 81)
 * came from this exact pattern. The signal is real, the direction was
 * inverted. We ship in shadow and let the production scoreboard either
 * validate the ticker-scoped inversion or kill via threshold tuning.
 *
 * Predicate per print:
 *   - ticker in cfg.tickers (default ['TSLA','IWM']) — silent skip otherwise
 *   - ticker in watchlist (defense-in-depth, alarms_off_watchlist counter)
 *   - side === 'put' (silent skip otherwise)
 *   - valid strike + expiry
 *   - is_bid truthy (alarms_not_bid_side counter when false)
 *   - dedupe via recentlyAlarmed(option_symbol, dedupe_min)
 *
 * Direction: bearish (puts winning means underlying drops). Horizon 24h to
 * give the inversion time to play out.
 *
 * Status: shadow — alarms write to /alarms but don't push Slack until the
 * lifecycle is flipped (tenet 10).
 *
 * Auth: service_role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { loadDetector } from '../_shared/detectorRegistry.ts';
import {
  loadWatchlist,
  loadDetectorWatermark,
  saveDetectorWatermark,
  recentlyAlarmed,
} from '../_shared/detectorState.ts';
import { inferDirection } from '../_shared/directionInference.ts';

const DETECTOR_ID = 'small_cap_inverted_put_v1';
const PAGE_SIZE = 1000;
const SCAN_LIMIT = 4000;

interface Stats {
  ok: boolean;
  detector_id: string;
  status: string | null;
  alerts_scanned: number;
  alarms_fired: number;
  alarms_deduped: number;
  alarms_off_watchlist: number;
  alarms_not_bid_side: number;
  watermark_before: string | null;
  watermark_after: string | null;
  errors: string[];
}

interface FlowAlertRow {
  alert_id: string;
  ticker: string | null;
  side: string | null;
  is_ask: boolean | null;
  is_bid: boolean | null;
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  price: number | null;
  ingested_at: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: any;
}

// OCC option symbol — matches ct-signature-watcher.buildOccSymbol so the
// dedupe key shape is consistent across detectors.
function buildOccSymbol(
  ticker: string | null | undefined,
  expiry: string | null | undefined,
  side: string | null | undefined,
  strike: number | null | undefined,
): string | null {
  if (!ticker || !expiry || strike == null || !Number.isFinite(strike) || strike <= 0) return null;
  const sideStr = (side ?? '').toLowerCase();
  if (sideStr !== 'call' && sideStr !== 'put') return null;
  const sideChar = sideStr === 'put' ? 'P' : 'C';
  const m = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const yymmdd = `${m[1].slice(2)}${m[2]}${m[3]}`;
  const strikeInt = Math.round(strike * 1000);
  if (!Number.isFinite(strikeInt) || strikeInt < 0) return null;
  return `${ticker.toUpperCase()}${yymmdd}${sideChar}${String(strikeInt).padStart(8, '0')}`;
}

async function runSweep(supabase: SupabaseClient): Promise<Stats> {
  const stats: Stats = {
    ok: true,
    detector_id: DETECTOR_ID,
    status: null,
    alerts_scanned: 0,
    alarms_fired: 0,
    alarms_deduped: 0,
    alarms_off_watchlist: 0,
    alarms_not_bid_side: 0,
    watermark_before: null,
    watermark_after: null,
    errors: [],
  };

  const detector = await loadDetector(supabase, DETECTOR_ID);
  if (!detector) {
    stats.errors.push('detector not found or retired');
    stats.ok = false;
    return stats;
  }
  stats.status = detector.status;

  const cfg = detector.config as {
    tickers?: unknown;
    dedupe_min?: number;
  };
  const tickerWhitelist = new Set(
    Array.isArray(cfg.tickers)
      ? cfg.tickers.map((s) => String(s).toUpperCase())
      : ['TSLA', 'IWM'],
  );
  const dedupeMin = typeof cfg.dedupe_min === 'number' ? cfg.dedupe_min : 60;

  const watchlist = await loadWatchlist(supabase);
  const watermark = await loadDetectorWatermark(supabase, DETECTOR_ID);
  stats.watermark_before = watermark;

  // Page forward through ct_flow_alerts since the watermark.
  // Window by ingested_at — UW stopped emitting executed_at (memory note).
  const alerts: FlowAlertRow[] = [];
  for (let offset = 0; offset < SCAN_LIMIT; offset += PAGE_SIZE) {
    const end = Math.min(offset + PAGE_SIZE - 1, SCAN_LIMIT - 1);
    const { data: page, error } = await supabase
      .from('ct_flow_alerts')
      .select('alert_id, ticker, side, is_ask, is_bid, strike, expiry, premium, price, ingested_at, raw')
      .gt('ingested_at', watermark)
      .in('ticker', Array.from(watchlist))
      .order('ingested_at', { ascending: true })
      .range(offset, end);
    if (error) {
      stats.errors.push(`fetch page ${offset}: ${error.message}`);
      break;
    }
    if (!page || page.length === 0) break;
    alerts.push(...(page as FlowAlertRow[]));
    if (page.length < (end - offset + 1)) break;
  }
  stats.alerts_scanned = alerts.length;

  let latestIngested = watermark;

  for (const a of alerts) {
    try {
      if (a.ingested_at > latestIngested) latestIngested = a.ingested_at;

      const ticker = (a.ticker ?? '').toUpperCase();

      // Ticker whitelist — silent skip (most prints fail this; no counter noise).
      if (!tickerWhitelist.has(ticker)) continue;

      // Defense-in-depth watchlist filter.
      if (!watchlist.has(ticker)) {
        stats.alarms_off_watchlist += 1;
        continue;
      }

      const side = (a.side ?? '').toLowerCase();
      // Put-only — silent skip on calls.
      if (side !== 'put') continue;

      // Valid strike + expiry.
      const strike = a.strike == null ? null : Number(a.strike);
      if (strike == null || !Number.isFinite(strike) || strike <= 0) continue;
      const expiry = a.expiry;
      if (!expiry || !expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/)) continue;

      // Bid-side aggressive check via canonical inferDirection (raw is_bid is
      // never set on UW alerts — must derive from raw payload + RepeatedHits
      // rule per directionInference.ts).
      const inferred = inferDirection({
        alert_id: a.alert_id,
        ticker,
        side,
        is_ask: a.is_ask,
        is_bid: a.is_bid,
        strike: a.strike,
        expiry: a.expiry,
        ingested_at: a.ingested_at,
        raw: a.raw,
      });
      if (!inferred || inferred.source !== 'aggressive_bid_put') {
        stats.alarms_not_bid_side += 1;
        continue;
      }

      const optionSymbol = buildOccSymbol(ticker, expiry, side, strike);
      if (!optionSymbol) continue;

      if (await recentlyAlarmed(supabase, DETECTOR_ID, optionSymbol, dedupeMin)) {
        stats.alarms_deduped += 1;
        continue;
      }

      // Direction: bearish — puts winning means underlying drops.
      const direction: 'bearish' = 'bearish';

      const premium = a.premium == null ? null : Number(a.premium);
      const premKstr = premium != null && Number.isFinite(premium)
        ? `$${(premium / 1000).toFixed(1)}k`
        : 'unknown';
      const thesis = `${ticker} put $${strike} ${expiry} — aggressive bid-side hit. Per-ticker inversion pattern: TSLA/IWM put-bid historically precedes underlying drop. Premium ${premKstr}.`;

      const horizonHours = 24;
      const horizonTs = new Date(Date.now() + horizonHours * 60 * 60_000).toISOString();
      const entryPrice = a.price == null ? null : Number(a.price);

      const { error: flagErr } = await supabase
        .from('ct_flags')
        .insert({
          source: 'detector_alarm',
          detector_id: DETECTOR_ID,
          specialist_ticker: null,
          instrument: ticker,
          option_symbol: optionSymbol,
          strike,
          expiry,
          side,
          direction,
          score: 0,
          tags: ['detector_alarm', DETECTOR_ID, 'inversion', 'put'],
          thesis,
          horizon_hours: horizonHours,
          horizon_ts: horizonTs,
          entry_price: entryPrice,
          target_price: null,
          status: 'active',
          source_flow_ids: [a.alert_id],
        });
      if (flagErr) {
        stats.errors.push(`flag insert ${a.alert_id}: ${flagErr.message}`);
        continue;
      }
      stats.alarms_fired += 1;
    } catch (e) {
      stats.errors.push(`alert ${a.alert_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (latestIngested !== watermark) {
    await saveDetectorWatermark(supabase, DETECTOR_ID, latestIngested);
  }
  stats.watermark_after = latestIngested;
  return stats;
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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();
  try {
    const stats = await runSweep(supabase);
    return new Response(JSON.stringify({ ...stats, elapsed_ms: Date.now() - startedAt }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      ok: false,
      detector_id: DETECTOR_ID,
      error: e instanceof Error ? e.message : String(e),
      elapsed_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
