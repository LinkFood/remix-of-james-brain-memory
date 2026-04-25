/**
 * ct-detector-pair-qqq-iwm (pair_qqq_iwm_v1) — sector rotation tell.
 *
 * QQQ (large-cap) Pulse and IWM (small-cap) Pulse moving in OPPOSITE
 * directions over the last 5min == sector rotation. Reads the latest 2-3
 * ct_flow_pulse_ticks per ticker, computes premium_net slope/min for each,
 * fires when signs cross and both magnitudes exceed config.min_slope_threshold.
 *
 * Ticker-level alarm — option_symbol is NULL, instrument='QQQ-IWM-PAIR'.
 * Dedupe by instrument within config.dedupe_min minutes (slower-moving
 * signal — default 60min).
 *
 * Status: shadow.
 *
 * Auth: service_role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { loadDetector } from '../_shared/detectorRegistry.ts';
import {
  loadDetectorWatermark,
  saveDetectorWatermark,
  recentlyAlarmedInstrument,
} from '../_shared/detectorState.ts';

const DETECTOR_ID = 'pair_qqq_iwm_v1';
const PAIR_INSTRUMENT = 'QQQ-IWM-PAIR';

interface Stats {
  ok: boolean;
  detector_id: string;
  status: string | null;
  qqq_ticks_loaded: number;
  iwm_ticks_loaded: number;
  qqq_slope_per_min: number | null;
  iwm_slope_per_min: number | null;
  divergence_detected: boolean;
  alarms_fired: number;
  alarms_deduped: number;
  watermark_before: string | null;
  watermark_after: string | null;
  errors: string[];
}

interface PulseTick {
  tick_time: string;
  premium_net: number | null;
}

async function loadLatestTicks(
  supabase: SupabaseClient,
  ticker: string,
  limit = 3,
): Promise<PulseTick[]> {
  const { data, error } = await supabase
    .from('ct_flow_pulse_ticks')
    .select('tick_time, premium_net')
    .eq('ticker', ticker)
    .order('tick_time', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  // Reverse to chronological order so slope math reads naturally.
  return (data as PulseTick[]).slice().reverse();
}

// Slope = (last - first) / minutes. Returns null if insufficient data or
// duration is zero (single tick or duplicate timestamps).
function slopePerMin(ticks: PulseTick[]): number | null {
  if (ticks.length < 2) return null;
  const first = ticks[0];
  const last = ticks[ticks.length - 1];
  const v0 = first.premium_net == null ? 0 : Number(first.premium_net);
  const v1 = last.premium_net == null ? 0 : Number(last.premium_net);
  const t0 = new Date(first.tick_time).getTime();
  const t1 = new Date(last.tick_time).getTime();
  const minutes = (t1 - t0) / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return (v1 - v0) / minutes;
}

function fmtSlope(s: number): string {
  const k = s / 1000;
  const abs = Math.abs(k);
  return abs >= 100 ? `${Math.round(k)}k/min` : `${k.toFixed(1)}k/min`;
}

async function runSweep(supabase: SupabaseClient): Promise<Stats> {
  const stats: Stats = {
    ok: true,
    detector_id: DETECTOR_ID,
    status: null,
    qqq_ticks_loaded: 0,
    iwm_ticks_loaded: 0,
    qqq_slope_per_min: null,
    iwm_slope_per_min: null,
    divergence_detected: false,
    alarms_fired: 0,
    alarms_deduped: 0,
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

  const cfg = detector.config as { min_slope_threshold?: number; dedupe_min?: number };
  const minSlope = typeof cfg.min_slope_threshold === 'number' ? cfg.min_slope_threshold : 80000;
  const dedupeMin = typeof cfg.dedupe_min === 'number' ? cfg.dedupe_min : 60;

  const watermark = await loadDetectorWatermark(supabase, DETECTOR_ID);
  stats.watermark_before = watermark;

  const qqqTicks = await loadLatestTicks(supabase, 'QQQ', 3);
  const iwmTicks = await loadLatestTicks(supabase, 'IWM', 3);
  stats.qqq_ticks_loaded = qqqTicks.length;
  stats.iwm_ticks_loaded = iwmTicks.length;

  const qqqSlope = slopePerMin(qqqTicks);
  const iwmSlope = slopePerMin(iwmTicks);
  stats.qqq_slope_per_min = qqqSlope;
  stats.iwm_slope_per_min = iwmSlope;

  if (qqqSlope == null || iwmSlope == null) {
    // Insufficient data — Saturday / pre-Pulse / single tick. Save watermark
    // anyway so last_run_at advances.
    const nowIso = new Date().toISOString();
    await saveDetectorWatermark(supabase, DETECTOR_ID, nowIso);
    stats.watermark_after = nowIso;
    return stats;
  }

  // Divergence: signs opposite AND both magnitudes above threshold.
  const oppositeSigns = (qqqSlope > 0 && iwmSlope < 0) || (qqqSlope < 0 && iwmSlope > 0);
  const bothLargeEnough = Math.abs(qqqSlope) >= minSlope && Math.abs(iwmSlope) >= minSlope;
  stats.divergence_detected = oppositeSigns && bothLargeEnough;

  if (stats.divergence_detected) {
    if (await recentlyAlarmedInstrument(supabase, DETECTOR_ID, PAIR_INSTRUMENT, dedupeMin)) {
      stats.alarms_deduped += 1;
    } else {
      const qqqDir = qqqSlope > 0 ? 'rising' : 'falling';
      const iwmDir = iwmSlope > 0 ? 'rising' : 'falling';
      const thesis =
        `Pair divergence: QQQ pulse ${qqqDir} ${fmtSlope(qqqSlope)} ` +
        `while IWM pulse ${iwmDir} ${fmtSlope(iwmSlope)} — sector rotation tell`;

      const horizonHours = 4;
      const horizonTs = new Date(Date.now() + horizonHours * 60 * 60_000).toISOString();

      const { error: flagErr } = await supabase
        .from('ct_flags')
        .insert({
          source: 'detector_alarm',
          detector_id: DETECTOR_ID,
          specialist_ticker: null,
          instrument: PAIR_INSTRUMENT,
          option_symbol: null,
          strike: null,
          expiry: null,
          side: null,
          // 'neutral' = volatility/rotation read, no directional thesis on a
          // single instrument (ct_flags.direction CHECK only allows
          // bullish/bearish/neutral so 'neutral' is the only honest value).
          direction: 'neutral',
          score: 0,
          tags: ['detector_alarm', DETECTOR_ID, 'pair_divergence'],
          thesis,
          horizon_hours: horizonHours,
          horizon_ts: horizonTs,
          entry_price: null,
          target_price: null,
          status: 'active',
        });
      if (flagErr) {
        stats.errors.push(`flag insert: ${flagErr.message}`);
      } else {
        stats.alarms_fired += 1;
      }
    }
  }

  const nowIso = new Date().toISOString();
  await saveDetectorWatermark(supabase, DETECTOR_ID, nowIso);
  stats.watermark_after = nowIso;
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
