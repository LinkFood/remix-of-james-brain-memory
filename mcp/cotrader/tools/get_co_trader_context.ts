// get_co_trader_context — the v1 single tool.
//
// Input: { ticker: string, include_regime?: boolean }
// Output: composed brain context (the same payload Co-Trader specialists,
// tape-reader, EOD bridge, and ct-chat read for that ticker), JSON-stringified
// + emitted as MCP `structuredContent`.
//
// Audience: 'cotrader' (intentional — Tenet 1 framing: terminal-Claude is
// part of operational James's decision loop, NOT an external analyst grading
// the system). This keeps the specialist_recall organ in scope (it's gated
// to ['cotrader'] only). Telemetry separation is via consumerName.
//
// Read-only. No INSERT/UPDATE/UPSERT/DELETE anywhere in this codepath.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { buildClaudeContext } from '../../../supabase/functions/_shared/claudeReadSurface.ts';
import type { HelperName } from '../../../supabase/functions/_shared/contextHelper.ts';
import { assertUniverseTicker } from '../lib/universe.ts';
import { resolveAuth } from '../lib/auth.ts';

const CONSUMER_NAME = 'cotrader-mcp';

// All 11 organs minus regime (used when include_regime === false).
const ORGANS_NO_REGIME: readonly HelperName[] = [
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
];

export interface GetCoTraderContextArgs {
  ticker: string;
  include_regime?: boolean;
}

export interface GetCoTraderContextResult {
  /** Stringified ctx for terminal-Claude rendering. */
  textPayload: string;
  /** Same ctx as a typed object, for MCP `structuredContent`. */
  structured: unknown;
  /** Wall-clock ms for the buildClaudeContext call. */
  latencyMs: number;
  /** Helpers that ran. */
  organsInvoked: string[];
  /** Helpers skipped + reason. */
  organsSkipped: { name: string; reason: string }[];
}

export async function getCoTraderContext(
  args: GetCoTraderContextArgs,
): Promise<GetCoTraderContextResult> {
  const ticker = assertUniverseTicker(args.ticker);
  const includeRegime = args.include_regime ?? true;

  const { supabaseUrl, serviceRoleKey, voyageApiKey } = await resolveAuth();

  if (includeRegime && !voyageApiKey) {
    // Don't crash — emit a stderr warning and fall back to no-regime. The
    // tool stays useful instead of failing closed on a missing optional key.
    console.error(
      '[cotrader-mcp] include_regime=true but VOYAGE_API_KEY not set; running without regime organ',
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const t0 = performance.now();
  const ctx = await buildClaudeContext(supabase, {
    audience: 'cotrader',
    consumerName: CONSUMER_NAME,
    tickerFocus: ticker,
    organs: includeRegime && voyageApiKey ? 'all' : ORGANS_NO_REGIME,
  });
  const latencyMs = Math.round(performance.now() - t0);

  // ClaudeContext carries BOTH legacy flat fields (50+ keys, full-watchlist
  // populated) AND the synthesis-layer organs map. For MCP consumption we
  // return only the new-consumer interface (organs + preamble + audit meta),
  // which is the shape the synthesis-layer docs describe as canonical going
  // forward ("Phase 4 migrates consumers to read from organs and preamble
  // over time, then we can sunset flat fields"). Without this slim, the
  // payload is ~117k tokens — well beyond MCP's practical per-call budget.
  const organsInvoked = Object.keys(ctx.organs ?? {});
  const organsSkipped: { name: string; reason: string }[] = [];
  const ctxMeta = (ctx as unknown as { meta?: { helpersSkipped?: { name: string; reason: string }[] } })
    .meta;
  if (ctxMeta?.helpersSkipped) organsSkipped.push(...ctxMeta.helpersSkipped);

  const slimmed = {
    audience: ctx.audience,
    tickerFocus: ticker,
    watchlist: ctx.watchlist,
    blockedFromReading: ctx.blockedFromReading,
    preamble: ctx.preamble,
    organs: ctx.organs,
    meta: {
      consumerName: CONSUMER_NAME,
      buildLatencyMs: latencyMs,
      organsInvoked,
      organsSkipped,
      generatedAt: new Date().toISOString(),
    },
  };

  return {
    textPayload: JSON.stringify(slimmed, null, 2),
    structured: slimmed,
    latencyMs,
    organsInvoked,
    organsSkipped,
  };
}
