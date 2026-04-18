/**
 * watchlist — tunable ticker list for Co-Trader.
 *
 * The 12-ticker watchlist was hard-coded across ~15 edge functions. This
 * helper centralizes the read through `ct_config['watcher.watchlist']` so
 * James can edit the list from /ct-settings without redeploying anything.
 *
 * CACHE CONTRACT:
 *   - 60s per-isolate TTL (mirrors configCache.ts).
 *   - One RPC hit per isolate per minute — consumers should call
 *     `getWatchlist(supabase)` ONCE at the top of their handler and reuse
 *     the returned array, NOT per-ticker.
 *
 * FALLBACK CONTRACT:
 *   - If the RPC errors, the config row is missing, or validation fails,
 *     we log a warning and return DEFAULT_WATCHLIST. Consumers never see
 *     an empty array, so the downstream loops always do something sane.
 *
 * VALIDATION RULES (applied before returning DB value):
 *   1. Must be an array.
 *   2. Length 1..MAX_WATCHLIST (16).
 *   3. Every entry is a non-empty string.
 *   4. Every entry matches /^[A-Z0-9.]{1,8}$/ once uppercased/trimmed.
 *      Dots allowed for tickers like `BRK.B`; length cap is conservative.
 *   5. Deduped, uppercase.
 *   Any violation -> log + fallback.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export const DEFAULT_WATCHLIST = [
  'SPY', 'QQQ', 'IWM',
  'NVDA', 'AAPL', 'MSFT', 'META', 'GOOGL', 'AMZN', 'TSLA',
  'GLD', 'USO',
] as const;

export const MAX_WATCHLIST = 16;

const CONFIG_KEY = 'watcher.watchlist';
const TICKER_RE = /^[A-Z0-9.]{1,8}$/;
const TTL_MS = 60_000;

interface CacheEntry {
  value: string[];
  fetchedAt: number;
}

let cached: CacheEntry | null = null;

/**
 * Normalize + validate a candidate ticker list.
 * Returns the cleaned array on success, or null if invalid.
 */
export function validateWatchlist(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < 1 || raw.length > MAX_WATCHLIST) return null;

  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') return null;
    const t = entry.trim().toUpperCase();
    if (!t) return null;
    if (!TICKER_RE.test(t)) return null;
    if (seen.has(t)) continue; // dedupe silently
    seen.add(t);
    cleaned.push(t);
  }
  if (cleaned.length === 0) return null;
  return cleaned;
}

/**
 * Fetch the current watchlist from ct_config, with 60s cache + fallback.
 *
 * Consumers should call this ONCE per invocation (not per ticker) and
 * reuse the resulting array. A cold call hits `ct_config_get`; subsequent
 * calls within 60s are cache hits.
 */
export async function getWatchlist(supabase: SupabaseClient): Promise<string[]> {
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TTL_MS) {
    return cached.value;
  }

  let dbValue: unknown = null;
  try {
    const { data, error } = await supabase.rpc('ct_config_get', { p_key: CONFIG_KEY });
    if (error) {
      console.warn(`[watchlist] ct_config_get error for ${CONFIG_KEY}:`, error.message);
      return fallback(now);
    }
    dbValue = data;
  } catch (err) {
    console.warn(`[watchlist] ct_config_get threw:`, (err as Error).message);
    return fallback(now);
  }

  if (dbValue === null || dbValue === undefined) {
    console.warn(`[watchlist] ${CONFIG_KEY} not seeded — using DEFAULT_WATCHLIST`);
    return fallback(now);
  }

  const validated = validateWatchlist(dbValue);
  if (!validated) {
    console.warn(`[watchlist] ${CONFIG_KEY} failed validation — using DEFAULT_WATCHLIST. raw:`, JSON.stringify(dbValue).slice(0, 200));
    return fallback(now);
  }

  cached = { value: validated, fetchedAt: now };
  return validated;
}

function fallback(now: number): string[] {
  const v = [...DEFAULT_WATCHLIST];
  cached = { value: v, fetchedAt: now };
  return v;
}

/** Escape hatch for tests. Nothing in production calls this. */
export function __resetWatchlistCache(): void {
  cached = null;
}
