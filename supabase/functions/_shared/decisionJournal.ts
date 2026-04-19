/**
 * decisionJournal — thin, non-throwing writer for ct_claude_decisions.
 *
 * Every Claude function in Co-Trader retrofits to call recordDecision() after
 * its main DB write (or at the end, for non-writing functions). The row
 * captures tape-vs-narrative signal decomposition, the alignment outcome,
 * what Claude actually followed, and full linkage to the downstream artifact
 * (hypothesis / trade idea / trade / brief).
 *
 * Contract:
 *   - Never throws. Any failure is console.warn'd and swallowed.
 *   - Returns the inserted row id, or null on any error / skip.
 *   - Callers should prefer over-logging. A pass-through "no-op" decision is
 *     still worth writing so we can diagnose silent skips.
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

// Module-scoped cache for the current generation id. Preflight found callers
// weren't threading generation_id into recordDecision, so journal rows weren't
// getting tagged even when the active generation was well-known. Per tenet 4
// (fix the class, not the instance), we auto-resolve here so future call
// sites can never "forget" to tag. Cache invalidates on recordDecision
// failure or after TTL so we pick up new generations automatically.
let _cachedGenerationId: string | null | undefined = undefined;
let _cachedAt = 0;
const GEN_CACHE_TTL_MS = 60_000;

async function resolveCurrentGenerationId(supabase: SupabaseClient): Promise<string | null> {
  const now = Date.now();
  if (_cachedGenerationId !== undefined && (now - _cachedAt) < GEN_CACHE_TTL_MS) {
    return _cachedGenerationId;
  }
  try {
    const { data } = await supabase.rpc('current_claude_generation');
    const id = Array.isArray(data) && data[0]?.id ? (data[0].id as string) : null;
    _cachedGenerationId = id;
    _cachedAt = now;
    return id;
  } catch {
    // RPC missing or migration not yet applied — treat as no-gen and don't
    // poison future lookups for long.
    _cachedGenerationId = null;
    _cachedAt = now;
    return null;
  }
}

/** Invalidate the generation id cache. Call after a known generation change. */
export function invalidateGenerationCache(): void {
  _cachedGenerationId = undefined;
  _cachedAt = 0;
}

export type DecisionType =
  | 'propose_hypothesis'
  | 'arm_trade_idea'
  | 'no_trade'
  | 'fill_trade'
  | 'close_trade'
  | 'update_hypothesis'
  | 'invalidate_hypothesis'
  | 'promote_playbook'
  | 'retire_hypothesis'
  | 'brief_generated'
  | 'brief_rebriefed'
  | 'breaking_news_processed'
  | 'circuit_breaker_tripped'
  | 'circuit_breaker_cleared'
  | 'reflection'
  | 'stress_check'
  | 'evidence_tagged'
  | 'trade_journal'
  | 'size_override'
  | 'hallucination_flagged';

export type ModelTier = 'opus' | 'sonnet' | 'haiku' | 'none';

export type Alignment = 'aligned' | 'conflict' | 'partial' | 'insufficient_data' | 'n/a';

export type ClaudeFollowed = 'narrative' | 'tape' | 'both' | 'neither';

export interface DecisionSignal {
  direction?: string;
  confidence?: number;
  sources?: string[];
  reasoning?: string;
}

export interface DecisionEntry {
  decision_type: DecisionType;
  model_tier: ModelTier;
  context_snapshot?: Record<string, unknown>;
  narrative_signal?: DecisionSignal;
  tape_signal?: DecisionSignal;
  alignment?: Alignment;
  claude_followed?: ClaudeFollowed;
  reasoning: string;
  tool_calls_summary?: Record<string, unknown>;
  outcome?: string;
  linked_hypothesis_id?: string;
  linked_trade_idea_id?: string;
  linked_trade_id?: string;
  linked_brief_id?: string;
  generation_id?: string | null;
  hallucination_flag?: boolean;
  hallucination_reason?: string;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
}

/**
 * Insert a single row into ct_claude_decisions. Returns the new row id or null.
 * Never throws — a failing decision journal must not break the caller.
 */
export async function recordDecision(
  supabase: SupabaseClient,
  entry: DecisionEntry,
): Promise<string | null> {
  try {
    const row: Record<string, unknown> = {
      decision_type: entry.decision_type,
      model_tier: entry.model_tier,
      reasoning: entry.reasoning.slice(0, 8000),
      hallucination_flag: entry.hallucination_flag ?? false,
    };
    if (entry.context_snapshot !== undefined) row.context_snapshot = entry.context_snapshot;
    if (entry.narrative_signal !== undefined) row.narrative_signal = entry.narrative_signal;
    if (entry.tape_signal !== undefined) row.tape_signal = entry.tape_signal;
    if (entry.alignment !== undefined) row.alignment = entry.alignment;
    if (entry.claude_followed !== undefined) row.claude_followed = entry.claude_followed;
    if (entry.tool_calls_summary !== undefined) row.tool_calls_summary = entry.tool_calls_summary;
    if (entry.outcome !== undefined) row.outcome = entry.outcome.slice(0, 500);
    if (entry.linked_hypothesis_id) row.linked_hypothesis_id = entry.linked_hypothesis_id;
    if (entry.linked_trade_idea_id) row.linked_trade_idea_id = entry.linked_trade_idea_id;
    if (entry.linked_trade_id) row.linked_trade_id = entry.linked_trade_id;
    if (entry.linked_brief_id) row.linked_brief_id = entry.linked_brief_id;

    // Generation tagging: explicit wins, else auto-resolve from active gen.
    // This makes "forgot to pass generation_id" structurally impossible.
    let genId: string | null | undefined = entry.generation_id;
    if (genId === undefined) {
      genId = await resolveCurrentGenerationId(supabase);
    }
    if (genId) row.generation_id = genId;
    if (entry.hallucination_reason) row.hallucination_reason = entry.hallucination_reason.slice(0, 1000);
    if (entry.tokens_in !== undefined) row.tokens_in = entry.tokens_in;
    if (entry.tokens_out !== undefined) row.tokens_out = entry.tokens_out;
    if (entry.cost_usd !== undefined) row.cost_usd = entry.cost_usd;

    const { data, error } = await supabase
      .from('ct_claude_decisions')
      .insert(row)
      .select('id')
      .single();
    if (error) {
      console.warn(`[decisionJournal] insert failed: ${error.message}`);
      return null;
    }
    return (data?.id as string | undefined) ?? null;
  } catch (e) {
    console.warn(`[decisionJournal] recordDecision threw: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
