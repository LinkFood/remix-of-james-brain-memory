/**
 * ct-detector-zerodte-opening-call (zerodte_opening_call_v1) — 0DTE +
 * 9-10am ET + aggressive_ask call prints.
 *
 * Pure-data predicate detector. Walks ct_flow_alerts since the per-detector
 * watermark, fires alarm rows into ct_flags with source='detector_alarm' and
 * detector_id='zerodte_opening_call_v1' for any call print on a same-day
 * expiry that lands inside the configured opening-hour ET window with
 * is_ask = true. Dedupes per option_symbol within config.dedupe_min minutes.
 *
 * Backtest (5-day corpus, 2026-04-20→24): 54% hit rate, 129 fires, narrow
 * window. Avg winner peak +154%. 2.43x lift. Built for the 9:32am NVDA
 * 0DTE bonanza class observed 2026-04-25.
 *
 * Status: shadow — alarms write to /alarms but don't push Slack until
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

const DETECTOR_ID = 'zerodte_opening_call_v1';
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
  alarms_skipped_non_0dte: number;
  alarms_off_hour: number;
  alarms_not_ask_side: number;
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
    alarms_skipped_non_0dte: 0,
    alarms_off_hour: 0,
    alarms_not_ask_side: 0,
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
    hour_et_min?: number;
    hour_et_max?: number;
    dedupe_min?: number;
  };
  const hourEtMin = typeof cfg.hour_et_min === 'number' ? cfg.hour_et_min : 9;
  const hourEtMax = typeof cfg.hour_et_max === 'number' ? cfg.hour_et_max : 10;
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
      if (!watchlist.has(ticker)) {
        stats.alarms_off_watchlist += 1;
        continue;
      }

      const side = (a.side ?? '').toLowerCase();
      // Calls only — puts are silently skipped (no counter).
      if (side !== 'call') continue;

      const strike = a.strike == null ? null : Number(a.strike);
      if (strike == null || !Number.isFinite(strike) || strike <= 0) continue;

      // dte_class='0dte' — calendar-day delta from ingest UTC midnight to
      // expiry UTC midnight. Same approach as smart_money_repeat.
      const expiry = a.expiry;
      if (!expiry) continue;
      const expiryMatch = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!expiryMatch) continue;
      const expiryDate = new Date(`${expiry}T00:00:00Z`);
      const ingestDate = new Date(a.ingested_at);
      const ingestMidnightUtc = new Date(Date.UTC(
        ingestDate.getUTCFullYear(),
        ingestDate.getUTCMonth(),
        ingestDate.getUTCDate(),
      ));
      const dte = Math.floor((expiryDate.getTime() - ingestMidnightUtc.getTime()) / 86400000);
      if (dte !== 0) {
        stats.alarms_skipped_non_0dte += 1;
        continue;
      }

      // Hour-of-day ET: ingest UTC hour minus 4 (mod 24). EDT is UTC-4
      // through 2026-11-01; matches the */5 13-20 UTC cron window which
      // covers 9am-4pm ET.
      const hourEt = ((ingestDate.getUTCHours() - 4) + 24) % 24;
      if (hourEt < hourEtMin || hourEt > hourEtMax) {
        stats.alarms_off_hour += 1;
        continue;
      }

      // Aggressive ask-side check via canonical inferDirection (raw is_ask is
      // never set on UW alerts — must derive from raw payload + RepeatedHits
      // rule per directionInference.ts).
      const inferred = inferDirection({
        alert_id: a.alert_id,
        ticker,
        side,
        is_ask: a.is_ask,
        is_bid: a.is_bid,
        strike,
        expiry,
        ingested_at: a.ingested_at,
        raw: a.raw,
      });
      if (!inferred || inferred.source !== 'aggressive_ask_call') {
        stats.alarms_not_ask_side += 1;
        continue;
      }

      const optionSymbol = buildOccSymbol(ticker, expiry, side, strike);
      if (!optionSymbol) continue;

      if (await recentlyAlarmed(supabase, DETECTOR_ID, optionSymbol, dedupeMin)) {
        stats.alarms_deduped += 1;
        continue;
      }

      // Aggressive ask-side call = bullish (buyer lifting offer).
      const direction: 'bullish' = 'bullish';

      const prem = a.premium == null ? null : Number(a.premium);
      const premKstr = prem != null && Number.isFinite(prem)
        ? `$${(prem / 1000).toFixed(1)}k`
        : 'unknown';
      const thesis = `${ticker} call $${strike} 0DTE — opening-hour aggressive ask. Premium ${premKstr}.`;

      const horizonHours = 4;
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
          tags: ['detector_alarm', DETECTOR_ID, '0dte'],
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
