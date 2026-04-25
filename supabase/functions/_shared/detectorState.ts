/**
 * detectorState — shared watermark + watchlist helpers for detector functions.
 *
 * Each detector reads/writes its own row in ct_detector_state via these helpers.
 * Watchlist mirrors the ct-signature-watcher loadWatchlist pattern so all
 * detectors respect the 10-ticker universe lock (tenet 4).
 */

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export const DEFAULT_WATCHLIST = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

export async function loadWatchlist(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('ct_config')
    .select('value')
    .eq('key', 'watcher.watchlist')
    .maybeSingle();
  if (error || !data?.value) return new Set(DEFAULT_WATCHLIST);
  const arr = data.value as unknown;
  if (!Array.isArray(arr)) return new Set(DEFAULT_WATCHLIST);
  const set = new Set<string>();
  for (const t of arr) if (typeof t === 'string' && t.length > 0) set.add(t.toUpperCase());
  return set.size > 0 ? set : new Set(DEFAULT_WATCHLIST);
}

export async function loadDetectorWatermark(
  supabase: SupabaseClient,
  detectorId: string,
  fallbackMinutes = 5,
): Promise<string> {
  const { data, error } = await supabase
    .from('ct_detector_state')
    .select('last_processed_at')
    .eq('detector_id', detectorId)
    .maybeSingle();
  if (error || !data) {
    return new Date(Date.now() - fallbackMinutes * 60_000).toISOString();
  }
  return data.last_processed_at as string;
}

export async function saveDetectorWatermark(
  supabase: SupabaseClient,
  detectorId: string,
  ts: string,
): Promise<void> {
  // UPSERT — first run for a detector seeds its state row even if the
  // migration seed missed (e.g. detector added later via INSERT only).
  await supabase
    .from('ct_detector_state')
    .upsert({
      detector_id: detectorId,
      last_processed_at: ts,
      last_run_at: new Date().toISOString(),
    }, { onConflict: 'detector_id' });
}

/**
 * Dedup check — has this detector already fired an alarm for this option_symbol
 * within the dedupe window? Reads ct_flags directly (no separate log table).
 */
export async function recentlyAlarmed(
  supabase: SupabaseClient,
  detectorId: string,
  optionSymbol: string,
  dedupeMin: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - dedupeMin * 60_000).toISOString();
  const { data } = await supabase
    .from('ct_flags')
    .select('id')
    .eq('detector_id', detectorId)
    .eq('option_symbol', optionSymbol)
    .gte('created_at', cutoff)
    .limit(1);
  return !!(data && data.length > 0);
}

/**
 * Pair-detector dedup — keyed on instrument string (e.g. 'QQQ-IWM-PAIR')
 * since these alarms have option_symbol=null.
 */
export async function recentlyAlarmedInstrument(
  supabase: SupabaseClient,
  detectorId: string,
  instrument: string,
  dedupeMin: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - dedupeMin * 60_000).toISOString();
  const { data } = await supabase
    .from('ct_flags')
    .select('id')
    .eq('detector_id', detectorId)
    .eq('instrument', instrument)
    .gte('created_at', cutoff)
    .limit(1);
  return !!(data && data.length > 0);
}
