/**
 * ct-detector-smart-money-repeat (smart_money_repeat_v1) — same OTM call
 * option_symbol prints ≥3x within a 3hr window.
 *
 * Pure-data cluster detector. Walks ct_flow_alerts since the per-detector
 * watermark, fires alarm rows into ct_flags with source='detector_alarm' and
 * detector_id='smart_money_repeat_v1' for any OTM call print whose exact
 * (ticker, expiry, side, strike) tuple has cleared the configured min_prints
 * count within the configured window_min lookback. Dedupes per option_symbol
 * within config.dedupe_min minutes. Skips 0DTE (this version is non_0dte).
 *
 * Backtest (5-day corpus, 2026-04-20→24): 39% hit rate, 320 catches, 26%
 * catch rate of all winners. Highest-impact new detector in the wave.
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

const DETECTOR_ID = 'smart_money_repeat_v1';
const PAGE_SIZE = 1000;
const SCAN_LIMIT = 4000;

interface Stats {
  ok: boolean;
  detector_id: string;
  status: string | null;
  alerts_scanned: number;
  alarms_fired: number;
  alarms_deduped: number;
  alarms_below_threshold: number;
  alarms_off_watchlist: number;
  alarms_off_filter_otm: number;
  alarms_skipped_0dte: number;
  watermark_before: string | null;
  watermark_after: string | null;
  errors: string[];
}

interface FlowAlertRow {
  alert_id: string;
  ticker: string | null;
  side: string | null;
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  price: number | null;
  executed_at: string | null;
  ingested_at: string;
  underlying_price: number | null;
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
    alarms_below_threshold: 0,
    alarms_off_watchlist: 0,
    alarms_off_filter_otm: 0,
    alarms_skipped_0dte: 0,
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
    window_min?: number;
    min_prints?: number;
    side_filter?: string;
    dedupe_min?: number;
  };
  const windowMin = typeof cfg.window_min === 'number' ? cfg.window_min : 180;
  const minPrints = typeof cfg.min_prints === 'number' ? cfg.min_prints : 3;
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
      .select('alert_id, ticker, side, strike, expiry, premium, price, executed_at, ingested_at, underlying_price')
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
      // smart_money_repeat is call-only this version (side_filter='call_otm_only')
      if (side !== 'call') continue;

      // OTM filter: strike must be strictly above spot.
      const strike = a.strike == null ? null : Number(a.strike);
      const underlying = a.underlying_price == null ? null : Number(a.underlying_price);
      if (
        strike == null || !Number.isFinite(strike) ||
        underlying == null || !Number.isFinite(underlying) ||
        strike <= underlying
      ) {
        stats.alarms_off_filter_otm += 1;
        continue;
      }

      // dte_class='non_0dte' — skip same-day expiries.
      const expiry = a.expiry;
      if (!expiry) continue;
      const expiryMatch = expiry.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!expiryMatch) continue;
      const expiryDate = new Date(`${expiry}T00:00:00Z`);
      const ingestDate = new Date(a.ingested_at);
      // Normalize ingest to UTC midnight so the diff is calendar-day delta.
      const ingestMidnightUtc = new Date(Date.UTC(
        ingestDate.getUTCFullYear(),
        ingestDate.getUTCMonth(),
        ingestDate.getUTCDate(),
      ));
      const dte = Math.floor((expiryDate.getTime() - ingestMidnightUtc.getTime()) / 86400000);
      if (dte === 0) {
        stats.alarms_skipped_0dte += 1;
        continue;
      }

      const optionSymbol = buildOccSymbol(ticker, expiry, side, strike);
      if (!optionSymbol) continue;

      // CORE WINDOW QUERY: how many prints on this exact contract in the
      // last window_min minutes (inclusive of this alert)? option_symbol
      // isn't a column on ct_flow_alerts, so we key on the tuple.
      const windowStart = new Date(
        new Date(a.ingested_at).getTime() - windowMin * 60_000,
      ).toISOString();
      const { data: clusterRows, error: clusterErr } = await supabase
        .from('ct_flow_alerts')
        .select('alert_id')
        .eq('ticker', ticker)
        .eq('expiry', expiry)
        .eq('side', side)
        .eq('strike', strike)
        .gte('ingested_at', windowStart)
        .lte('ingested_at', a.ingested_at);
      if (clusterErr) {
        stats.errors.push(`window query ${a.alert_id}: ${clusterErr.message}`);
        continue;
      }
      const count = clusterRows ? clusterRows.length : 0;
      if (count < minPrints) {
        stats.alarms_below_threshold += 1;
        continue;
      }

      if (await recentlyAlarmed(supabase, DETECTOR_ID, optionSymbol, dedupeMin)) {
        stats.alarms_deduped += 1;
        continue;
      }

      // OTM call repeat = bullish accumulation (smart money + chasers stacking).
      const direction: 'bullish' = 'bullish';

      const thesis = `${ticker} ${side} $${strike} ${expiry} — ${count} prints on this exact contract within ${windowMin}min window. Smart money + chasers stacking.`;

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
          tags: ['detector_alarm', DETECTOR_ID, 'cluster'],
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
