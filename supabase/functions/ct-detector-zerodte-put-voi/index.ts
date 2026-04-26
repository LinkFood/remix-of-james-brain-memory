/**
 * ct-detector-zerodte-put-voi (zerodte_put_voi_extreme_v1) — 0DTE puts
 * with Vol/OI ratio ≥ 20.
 *
 * Pure-data per-print detector. Walks ct_flow_alerts since the per-detector
 * watermark, fires alarm rows into ct_flags with source='detector_alarm' and
 * detector_id='zerodte_put_voi_extreme_v1' for any 0DTE put print whose
 * volume/open_interest ratio clears the configured min_voi_ratio threshold.
 * Dedupes per option_symbol within config.dedupe_min minutes.
 *
 * Pattern: SPY 0DTE puts on Thursday 2026-04-23 hit V/OI 25-74x at peak and
 * paid 294-338%. Corpus says raw V/OI alone is anti-signal (15% hit rate),
 * so this detector ships in SHADOW — production scoreboard validates or kills.
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

const DETECTOR_ID = 'zerodte_put_voi_extreme_v1';
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
  alarms_below_voi: number;
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
  volume: number | null;
  open_interest: number | null;
  ingested_at: string;
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

function formatPremium(prem: number | null): string {
  if (prem == null || !Number.isFinite(prem)) return '?';
  if (prem >= 1_000_000) return `$${(prem / 1_000_000).toFixed(1)}M`;
  if (prem >= 1_000) return `$${(prem / 1_000).toFixed(0)}K`;
  return `$${prem.toFixed(0)}`;
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
    alarms_below_voi: 0,
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
    min_voi_ratio?: number;
    dedupe_min?: number;
  };
  const minVoiRatio = typeof cfg.min_voi_ratio === 'number' ? cfg.min_voi_ratio : 20.0;
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
      .select('alert_id, ticker, side, strike, expiry, premium, price, volume, open_interest, ingested_at')
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
      // put-only detector — silent skip on non-puts (no counter)
      if (side !== 'put') continue;

      const strike = a.strike == null ? null : Number(a.strike);
      if (strike == null || !Number.isFinite(strike) || strike <= 0) continue;

      // dte_class='0dte' — skip anything not expiring today.
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
      if (dte !== 0) {
        stats.alarms_skipped_non_0dte += 1;
        continue;
      }

      // V/OI ratio gate.
      const volume = a.volume == null ? null : Number(a.volume);
      const openInterest = a.open_interest == null ? null : Number(a.open_interest);
      if (
        volume == null || !Number.isFinite(volume) || volume <= 0 ||
        openInterest == null || !Number.isFinite(openInterest) || openInterest <= 0
      ) {
        stats.alarms_below_voi += 1;
        continue;
      }
      const voiRatio = volume / openInterest;
      if (voiRatio < minVoiRatio) {
        stats.alarms_below_voi += 1;
        continue;
      }

      const optionSymbol = buildOccSymbol(ticker, expiry, side, strike);
      if (!optionSymbol) continue;

      if (await recentlyAlarmed(supabase, DETECTOR_ID, optionSymbol, dedupeMin)) {
        stats.alarms_deduped += 1;
        continue;
      }

      // 0DTE puts winning means the underlying dropped — predict downside.
      const direction: 'bearish' = 'bearish';

      const premKstr = formatPremium(a.premium == null ? null : Number(a.premium));
      const thesis = `${ticker} put $${strike} 0DTE — V/OI=${voiRatio.toFixed(1)}x extreme, vol=${volume} OI=${openInterest}. Premium ${premKstr}.`;

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
          tags: ['detector_alarm', DETECTOR_ID, '0dte', 'put'],
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
