/**
 * pulseContext — read Pulse-at-time-of-fire for any alarm path.
 *
 * Per tenet 9 (2026-04-25): Pulse is regime context for every alarm. Every
 * alarm row stores Pulse-at-fire-time so the same detector reads differently
 * in different regimes (steady positive = ride; sudden flip = fade).
 *
 * Reads ct_flow_pulse_ticks for the most recent 2-3 ticks at-or-before
 * `atTime` (defaults to now), computes slope over the ~5min spacing, then
 * classifies regime by |slope| against the configured threshold.
 *
 * Read-only consumer of ct_flow_pulse_ticks — DO NOT modify the capture cron
 * or the table schema from here.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export type PulseRegime = 'trending_up' | 'trending_down' | 'chop' | 'unknown';

export interface PulseContext {
  netPremium: number | null;   // most recent ct_flow_pulse_ticks.premium_net
  slope5min: number | null;    // delta premium_net per minute over the last gap
  regime: PulseRegime;
}

const DEFAULT_TREND_THRESHOLD = 100_000;

let cachedThreshold: { value: number; expires: number } | null = null;

async function loadTrendThreshold(supabase: SupabaseClient): Promise<number> {
  // 60s cache — trivial RPC pressure savings across a sweep's many alerts.
  if (cachedThreshold && cachedThreshold.expires > Date.now()) {
    return cachedThreshold.value;
  }
  const { data } = await supabase
    .from('ct_config')
    .select('value')
    .eq('key', 'pulse_regime_trend_threshold')
    .maybeSingle();
  // value is JSONB — could be number, numeric string, or absent.
  let v = DEFAULT_TREND_THRESHOLD;
  if (data?.value != null) {
    const n = typeof data.value === 'number' ? data.value : Number(data.value);
    if (Number.isFinite(n) && n > 0) v = n;
  }
  cachedThreshold = { value: v, expires: Date.now() + 60_000 };
  return v;
}

/**
 * Returns the Pulse state for `ticker` at `atTime`. Insufficient data
 * (≤1 tick available) → regime='unknown' but netPremium populated when
 * exactly one tick exists.
 */
export async function readPulseContext(
  supabase: SupabaseClient,
  ticker: string,
  atTime?: Date,
): Promise<PulseContext> {
  const tickerUpper = (ticker ?? '').toUpperCase();
  if (!tickerUpper) {
    return { netPremium: null, slope5min: null, regime: 'unknown' };
  }

  const cutoff = (atTime ?? new Date()).toISOString();

  // Pull the 3 most-recent ticks at-or-before cutoff. 3 = enough to compute
  // a 5min slope even if one tick is anomalously close (multiple captures).
  const { data, error } = await supabase
    .from('ct_flow_pulse_ticks')
    .select('tick_time, premium_net')
    .eq('ticker', tickerUpper)
    .lte('tick_time', cutoff)
    .order('tick_time', { ascending: false })
    .limit(3);

  if (error || !data || data.length === 0) {
    return { netPremium: null, slope5min: null, regime: 'unknown' };
  }

  const latest = data[0];
  const netPremium = latest.premium_net == null ? null : Number(latest.premium_net);
  if (data.length < 2) {
    // Only one tick — we have a level but no slope.
    return { netPremium, slope5min: null, regime: 'unknown' };
  }

  const prev = data[1];
  const latestMs = Date.parse(latest.tick_time as string);
  const prevMs = Date.parse(prev.tick_time as string);
  const minutes = (latestMs - prevMs) / 60_000;
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { netPremium, slope5min: null, regime: 'unknown' };
  }

  const prevPrem = prev.premium_net == null ? null : Number(prev.premium_net);
  if (netPremium == null || prevPrem == null) {
    return { netPremium, slope5min: null, regime: 'unknown' };
  }

  const slope5min = (netPremium - prevPrem) / minutes;
  const threshold = await loadTrendThreshold(supabase);

  let regime: PulseRegime = 'chop';
  if (slope5min >= threshold) regime = 'trending_up';
  else if (slope5min <= -threshold) regime = 'trending_down';

  return { netPremium, slope5min, regime };
}
