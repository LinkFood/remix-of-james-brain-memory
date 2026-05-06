// get_co_trader_context — v1.1.
//
// Input: { ticker: string, include_regime?: boolean, organs?: string[] }
// Output: composed brain context (organs + preamble + meta), JSON-stringified
// + emitted as MCP `structuredContent`.
//
// v1.1 changes (2026-05-05) per Phase A audit:
//   - Lever 1: passes `skipLegacyFlatFields: true` to `buildClaudeContext` →
//     skips ~50-query legacy flat-fields block (~10s savings on public-internet
//     wall-clock).
//   - Lever 2: 5-min in-process TTL cache for stable organs (regime,
//     event_recency, analogs, specialist_recall, james_flags). Volatile organs
//     always fetched fresh. Cache hits emit telemetry rows with
//     `cache_hit=true` (boolean column carries the signal; `error` column
//     stays null — preserves the column's semantic purity per the
//     2026-05-06 cache_hit-error-column-purity Phase A finding).
//   - Lever 3: optional `organs?: string[]` scopes the brain read to a subset.
//     Unknown names: warn-and-fetch-recognized unless ALL provided are unknown
//     (then hard-fail).
//
// Audience: 'cotrader' (intentional — Tenet 1, terminal-Claude is part of
// operational James's decision loop). Telemetry separated via
// consumerName='cotrader-mcp'.
//
// Read-only. No INSERT/UPDATE/UPSERT/DELETE except the cache_hit telemetry
// rows (which are the same shape `buildClaudeContext` already writes for
// every organ outcome).

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { buildClaudeContext } from '../../../supabase/functions/_shared/claudeReadSurface.ts';
import type { HelperName, HelperResult } from '../../../supabase/functions/_shared/contextHelper.ts';
import { assertUniverseTicker } from '../lib/universe.ts';
import { resolveAuth } from '../lib/auth.ts';
import { cacheGet, cacheSet, cacheStats, isStableOrgan } from '../lib/organ_cache.ts';

const CONSUMER_NAME = 'cotrader-mcp';

const ALL_ORGANS: readonly HelperName[] = [
  'flow_heatmap',
  'pulse',
  'specialist',
  'detector',
  'tape',
  'james_flags',
  'news_causality',
  'event_recency',
  'analogs',
  'specialist_recall',
  'regime',
];

const ALL_ORGANS_SET = new Set<string>(ALL_ORGANS);

function organsNoRegime(): readonly HelperName[] {
  return ALL_ORGANS.filter((o) => o !== 'regime');
}

export interface GetCoTraderContextArgs {
  ticker: string;
  include_regime?: boolean;
  organs?: string[];
}

export interface GetCoTraderContextResult {
  textPayload: string;
  structured: unknown;
  latencyMs: number;
  organsInvoked: string[];
  organsSkipped: { name: string; reason: string }[];
  cacheHits: { organ: string; ageSec: number }[];
  organsRequested: string[];
  unknownOrgans: string[];
}

interface OrgansResolution {
  resolved: HelperName[];
  unknown: string[];
  rejectedWithError?: string;
}

function resolveOrgansArg(
  organsArg: string[] | undefined,
  includeRegime: boolean,
): OrgansResolution {
  if (!organsArg || organsArg.length === 0) {
    return {
      resolved: includeRegime ? [...ALL_ORGANS] : [...organsNoRegime()],
      unknown: [],
    };
  }
  const recognized: HelperName[] = [];
  const unknown: string[] = [];
  for (const name of organsArg) {
    if (ALL_ORGANS_SET.has(name)) {
      // de-dupe
      if (!recognized.includes(name as HelperName)) {
        recognized.push(name as HelperName);
      }
    } else {
      unknown.push(name);
    }
  }
  // include_regime: false drops regime from an explicit list too — caller
  // intent wins (cheap quick-lookup).
  const filtered = includeRegime ? recognized : recognized.filter((o) => o !== 'regime');
  if (filtered.length === 0) {
    return {
      resolved: [],
      unknown,
      rejectedWithError:
        unknown.length > 0
          ? `All requested organs unknown: [${unknown.join(', ')}]. Valid: [${[...ALL_ORGANS].join(', ')}].`
          : 'No organs to fetch (all filtered out by include_regime=false).',
    };
  }
  return { resolved: filtered, unknown };
}

async function emitCacheHitTelemetry(
  supabase: SupabaseClient,
  args: { organ: string; ticker: string; ageSec: number; ttlSec: number },
): Promise<void> {
  // Same shape as the rows buildClaudeContext writes per organ outcome.
  // `cache_hit=true` is the structured signal. The `error` column stays NULL
  // for cache hits — it's reserved for genuine failures only. Warden +
  // get_brain_health read `cache_hit` directly.
  try {
    await supabase.from('ct_brain_telemetry').insert({
      helper_name: args.organ,
      audience: 'cotrader',
      ticker_focus: args.ticker,
      consumer_name: CONSUMER_NAME,
      latency_ms: 0,
      output_size_bytes: 0,
      cache_hit: true,
    });
  } catch (_e) {
    // Telemetry must never block. Swallow.
  }
}

export async function getCoTraderContext(
  args: GetCoTraderContextArgs,
): Promise<GetCoTraderContextResult> {
  const ticker = assertUniverseTicker(args.ticker);
  const includeRegime = args.include_regime ?? true;

  const { supabaseUrl, serviceRoleKey, voyageApiKey } = await resolveAuth();

  if (includeRegime && !voyageApiKey) {
    console.error(
      '[cotrader-mcp] include_regime=true but VOYAGE_API_KEY not set; running without regime organ',
    );
  }

  const effectiveIncludeRegime = includeRegime && !!voyageApiKey;
  const resolution = resolveOrgansArg(args.organs, effectiveIncludeRegime);

  if (resolution.rejectedWithError) {
    throw new Error(resolution.rejectedWithError);
  }

  const supabase: SupabaseClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // Cache check on stable organs only.
  const cachedOrgans: Partial<Record<HelperName, HelperResult<unknown>>> = {};
  const cacheHits: { organ: string; ageSec: number }[] = [];
  const stableMisses: HelperName[] = [];
  const volatileOrgans: HelperName[] = [];
  for (const o of resolution.resolved) {
    if (isStableOrgan(o)) {
      const hit = cacheGet(ticker, o);
      if (hit) {
        cachedOrgans[o] = hit.value;
        cacheHits.push({ organ: o, ageSec: hit.ageSec });
        // Fire telemetry for this cache hit (best-effort).
        void emitCacheHitTelemetry(supabase, {
          organ: o,
          ticker,
          ageSec: hit.ageSec,
          ttlSec: Math.round(cacheStats().ttlMs / 1000),
        });
      } else {
        stableMisses.push(o);
      }
    } else {
      volatileOrgans.push(o);
    }
  }

  const toFetch: HelperName[] = [...volatileOrgans, ...stableMisses];

  const t0 = performance.now();

  let fetchedOrgans: Partial<Record<HelperName, HelperResult<unknown>>> = {};
  let fetchedAudience = 'cotrader';
  let fetchedPreamble: { temporalAnchor: string; whatJustHappened: string } = {
    temporalAnchor: '',
    whatJustHappened: '',
  };
  let fetchedWatchlist: string[] = [];

  if (toFetch.length > 0) {
    const ctx = await buildClaudeContext(supabase, {
      audience: 'cotrader',
      consumerName: CONSUMER_NAME,
      tickerFocus: ticker,
      organs: toFetch,
      skipLegacyFlatFields: true,
    });
    fetchedOrgans = ctx.organs ?? {};
    fetchedAudience = ctx.audience;
    fetchedPreamble = {
      temporalAnchor: ctx.preamble.temporalAnchor,
      whatJustHappened: ctx.preamble.whatJustHappened,
    };
    fetchedWatchlist = ctx.watchlist;

    // Populate cache for newly-fetched stable organs.
    for (const o of stableMisses) {
      const result = fetchedOrgans[o];
      if (result) cacheSet(ticker, o, result);
    }
  } else {
    // 100% cache hit — still need preamble + watchlist. Read minimally.
    // Cheapest path: invoke buildClaudeContext with empty organ list; it
    // still computes preamble + watchlist (cheap).
    const ctx = await buildClaudeContext(supabase, {
      audience: 'cotrader',
      consumerName: CONSUMER_NAME,
      tickerFocus: ticker,
      organs: [], // empty list — no organs fetched
      skipLegacyFlatFields: true,
    });
    fetchedAudience = ctx.audience;
    fetchedPreamble = {
      temporalAnchor: ctx.preamble.temporalAnchor,
      whatJustHappened: ctx.preamble.whatJustHappened,
    };
    fetchedWatchlist = ctx.watchlist;
  }

  const latencyMs = Math.round(performance.now() - t0);

  // Merge cached + fetched. Cached entries take precedence on overlap (none
  // expected since they're disjoint — cached come from stableMisses path).
  const mergedOrgans: Partial<Record<HelperName, HelperResult<unknown>>> = {
    ...cachedOrgans,
    ...fetchedOrgans,
  };

  const organsInvoked = Object.keys(mergedOrgans);
  const organsSkipped: { name: string; reason: string }[] = [];
  for (const o of resolution.resolved) {
    if (!(o in mergedOrgans)) {
      organsSkipped.push({ name: o, reason: 'helper_returned_no_data' });
    }
  }

  const slimmed = {
    audience: fetchedAudience,
    tickerFocus: ticker,
    watchlist: fetchedWatchlist,
    preamble: fetchedPreamble,
    organs: mergedOrgans,
    meta: {
      consumerName: CONSUMER_NAME,
      buildLatencyMs: latencyMs,
      organsRequested: resolution.resolved,
      organsInvoked,
      organsSkipped,
      cacheHits,
      unknownOrgans: resolution.unknown,
      generatedAt: new Date().toISOString(),
    },
  };

  return {
    textPayload: JSON.stringify(slimmed, null, 2),
    structured: slimmed,
    latencyMs,
    organsInvoked,
    organsSkipped,
    cacheHits,
    organsRequested: resolution.resolved,
    unknownOrgans: resolution.unknown,
  };
}
