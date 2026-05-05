// In-process TTL cache for stable brain organs. v1.1 lever 2 per Phase A
// audit (`docs/audit/2026-05-05-cotrader-mcp-v1-1-phase-a.md`).
//
// Lifetime: the MCP server process. Per Claude Code MCP docs, stdio servers
// persist across the entire session, so module-level state survives across
// tool calls — viable cache target.
//
// Stable organs (5-min TTL):
//   - regime                — Pulse v2 5-min bucket cadence
//   - event_recency         — last-72h material events; refreshes daily
//   - analogs               — ct_session_embeddings nearest neighbors;
//                             session-level
//   - specialist_recall     — last 5 flagged + 5 unflagged on ticker;
//                             changes only on new specialist write
//   - james_flags           — James's hand-labeled signals; sparse writes
//
// Volatile organs (always fresh, never cached):
//   - flow_heatmap, pulse, detector, tape, news_causality, specialist
//
// On cache hit, the MCP emits a telemetry row tagged
// `error='cache_hit:fresh_<sec>s'` so the warden + get_brain_health stay
// populated (Option A per James 2026-05-05). Preserves supervisor visibility.

import type { HelperResult } from '../../../supabase/functions/_shared/contextHelper.ts';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

export const STABLE_ORGANS = new Set([
  'regime',
  'event_recency',
  'analogs',
  'specialist_recall',
  'james_flags',
] as const);

export type StableOrgan =
  | 'regime'
  | 'event_recency'
  | 'analogs'
  | 'specialist_recall'
  | 'james_flags';

interface CacheEntry {
  value: HelperResult<unknown>;
  fetchedAt: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function isStableOrgan(name: string): boolean {
  return STABLE_ORGANS.has(name as StableOrgan);
}

export interface CacheHit {
  value: HelperResult<unknown>;
  ageSec: number;
}

export function cacheGet(ticker: string, organ: string): CacheHit | null {
  const key = `${ticker.toUpperCase()}:${organ}`;
  const entry = cache.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (now >= entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return { value: entry.value, ageSec: Math.round((now - entry.fetchedAt) / 1000) };
}

export function cacheSet(ticker: string, organ: string, value: HelperResult<unknown>): void {
  if (!isStableOrgan(organ)) return; // only cache stable organs
  const key = `${ticker.toUpperCase()}:${organ}`;
  const now = Date.now();
  cache.set(key, {
    value,
    fetchedAt: now,
    expiresAt: now + TTL_MS,
  });
}

export interface CacheStats {
  entries: number;
  ttlMs: number;
}

export function cacheStats(): CacheStats {
  return { entries: cache.size, ttlMs: TTL_MS };
}

// Test-only — never call from production code.
export function _resetCacheForTests(): void {
  cache.clear();
}
