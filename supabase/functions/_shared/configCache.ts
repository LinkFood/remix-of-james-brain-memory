/**
 * configCache — opt-in reader for the ct_config table.
 *
 * Edge functions that want tunable thresholds call getConfig(key, fallback).
 * Values are cached for 60s per isolate to avoid hammering the DB on every
 * cron tick. When the cache misses, we hit the ct_config_get(p_key) RPC and
 * store the jsonb. If the row is missing or the RPC errors, the caller's
 * fallback is returned — existing hard-coded behavior is preserved.
 *
 * NOT WIRED YET. No production function imports this today. The stub exists
 * so the contract is nailed down and /ct-settings has something to target.
 *
 * Cache strategy: simple 60s TTL, per-isolate (no pub/sub, no cross-isolate
 * invalidation). Acceptable because:
 *   - Most crons run on the minute; a 60s TTL means at most one stale tick
 *     after a UI change.
 *   - Isolates are short-lived, so the cache is effectively per-invocation
 *     for cold starts and per-minute for warm ones.
 *   - Config changes are rare and James will tolerate a one-tick lag.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface CacheEntry {
  value: Json;
  fetchedAt: number;
}

const TTL_MS = 60_000;
const cache = new Map<string, CacheEntry>();

let cachedClient: ReturnType<typeof createClient> | null = null;

function client() {
  if (cachedClient) return cachedClient;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    throw new Error('configCache: SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  }
  cachedClient = createClient(url, key, { auth: { persistSession: false } });
  return cachedClient;
}

/**
 * Fetch a config value by key. Returns the `fallback` if the key is missing
 * or the lookup fails — so calling sites are safe to adopt without gating.
 *
 * @example
 *   const cooldownMin = await getConfig<number>('cooldown.same_direction_min', 30);
 */
export async function getConfig<T extends Json>(key: string, fallback: T): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < TTL_MS) {
    return hit.value as T;
  }

  try {
    const { data, error } = await client().rpc('ct_config_get', { p_key: key });
    if (error) {
      console.warn(`[configCache] RPC error for ${key}:`, error.message);
      return fallback;
    }
    if (data === null || data === undefined) {
      // Key not seeded — use fallback and cache the absence so we don't re-hit.
      cache.set(key, { value: fallback as Json, fetchedAt: now });
      return fallback;
    }
    cache.set(key, { value: data as Json, fetchedAt: now });
    return data as T;
  } catch (err) {
    console.warn(`[configCache] fetch failed for ${key}:`, (err as Error).message);
    return fallback;
  }
}

/**
 * Escape hatch for tests / manual resets. Nothing in production calls this.
 */
export function __resetConfigCache() {
  cache.clear();
}
