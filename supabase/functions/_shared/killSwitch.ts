/**
 * killSwitch.ts — shared reader for the ct_kill_switch singleton.
 *
 * Every Claude-calling or trade-writing edge function calls isKillSwitchActive()
 * at entry. If it returns true, the function must skip with a 200 response:
 *   { skipped: true, reason: 'kill_switch_active' }
 * and (optionally) write a heartbeat row explaining why.
 *
 * Memoization: within a single Deno isolate we cache the last result for
 * KILL_SWITCH_CACHE_MS (10s). This keeps cron ticks off the DB but does mean
 * the next cron tick after James engages may still fire ONCE before its
 * isolate's cache flips — see CLAUDE.md / task notes for the <15s lag window.
 *
 * Callers pass any SupabaseClient (service-role or user) — the RPC is
 * SECURITY DEFINER so either works.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export const KILL_SWITCH_CACHE_MS = 10_000;

interface CacheEntry {
  value: boolean;
  at: number;
}

// Per-isolate cache. Survives across requests within one isolate; gone on cold start.
let cache: CacheEntry | null = null;

/**
 * Returns true if the kill switch is engaged.
 *
 * Soft-fails to `false` on DB error — we don't want a flaky DB read to silently
 * shut down the entire trading system. A real engage will be seen on the next
 * successful read (within 10s).
 */
export async function isKillSwitchActive(
  supabase: SupabaseClient,
): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.at < KILL_SWITCH_CACHE_MS) {
    return cache.value;
  }

  try {
    const { data, error } = await supabase.rpc('ct_killswitch_active');
    if (error) {
      console.warn('[killSwitch] RPC error, defaulting to inactive:', error.message);
      // Do NOT cache failures — retry next call.
      return false;
    }
    const value = data === true;
    cache = { value, at: now };
    return value;
  } catch (e) {
    console.warn('[killSwitch] threw, defaulting to inactive:', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/**
 * Force a cache clear. Useful for tests or explicit "we just engaged, check again"
 * flows. Not called by edge functions in normal operation.
 */
export function clearKillSwitchCache(): void {
  cache = null;
}

/**
 * Standard skip response. Callers use this so the kill-switch shape is consistent.
 * We also fire-and-forget a heartbeat row when a supabase client is passed —
 * cron-level heartbeat rows are how operators see "this tick was killed."
 */
export async function killSwitchSkipResponse(
  supabase: SupabaseClient,
  functionName: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  // Fire-and-forget heartbeat — never blocks the response.
  try {
    await supabase.from('ct_heartbeats').insert({
      status_line: `[kill-switch] ${functionName} skipped — ct_kill_switch active`,
      watching: [],
      current_reads: { kill_switch: 'active', function: functionName },
      prompt_version: 'kill-switch',
      attention_score: 0,
    });
  } catch (e) {
    console.warn('[killSwitch] heartbeat log failed:', e instanceof Error ? e.message : String(e));
  }

  return new Response(
    JSON.stringify({ skipped: true, reason: 'kill_switch_active', function: functionName }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
}
