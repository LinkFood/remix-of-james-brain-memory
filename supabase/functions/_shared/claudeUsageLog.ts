/**
 * claudeUsageLog — unified, fire-and-forget per-call Claude cost logger for
 * every ct-* function that calls Claude.
 *
 * Why this exists:
 *   - Before this helper, only ct-chat wrote per-call cost (to ct_chat_tokens).
 *   - Watcher, curiosity, morning-brief, midday-recap, eod-recap, replay,
 *     news-ingester, lessons-curator all called Claude with zero cost tracking.
 *   - /health had a "cost attribution v2 gap" note. This closes it.
 *
 * Contract:
 *   - Never throws. Any failure is console.warn'd and swallowed.
 *   - Fire-and-forget: insert returns a promise but callers never need to await.
 *   - Handles missing usage (error responses, streaming) by skipping the insert.
 *   - Computes cost from known model rates (see CLAUDE_RATES in anthropic.ts).
 */

import { CLAUDE_RATES, calculateCost } from './anthropic.ts';

export interface ClaudeUsageLogInput {
  /** Edge function name, e.g. 'ct-watcher', 'ct-chat', 'ct-replay'. */
  source: string;
  /** Resolved model id (e.g. claude-sonnet-4-20250514 or claude-haiku-4-5-20251001). */
  model: string;
  /** Token usage from Claude response. Skipped if both tokens are 0/missing. */
  usage?: { input_tokens?: number | null; output_tokens?: number | null } | null;
  /** Wall-clock duration of the Claude call. */
  duration_ms?: number | null;
  /** Number of MCP tool_use blocks in the response. Default 0. */
  mcp_calls?: number | null;
  /** Free-form context: task_id, trade_id, tick_count, model tier, etc. */
  metadata?: Record<string, unknown> | null;
  /** Override cost — used by batched callers (replay) that already summed locally. */
  cost_usd_override?: number | null;
}

// Loose Supabase client shape — avoids pulling @supabase/supabase-js types here.
interface SupabaseLike {
  from: (table: string) => { insert: (row: Record<string, unknown>) => Promise<unknown> | PromiseLike<unknown> };
}

/**
 * Log a single Claude call to ct_claude_usage. Fire-and-forget.
 *
 * If the model isn't in CLAUDE_RATES, cost defaults to 0 (calculateCost returns
 * 0 for unknown models). If usage is missing OR both token counts are 0 and
 * there's no override, the row is skipped — an errored Claude response
 * doesn't deserve a zero-cost row cluttering the view.
 */
export function logClaudeUsage(
  supabase: SupabaseLike,
  input: ClaudeUsageLogInput,
): void {
  try {
    const tokensIn = Number(input.usage?.input_tokens ?? 0) || 0;
    const tokensOut = Number(input.usage?.output_tokens ?? 0) || 0;
    const hasUsage = tokensIn > 0 || tokensOut > 0;
    const hasOverride = typeof input.cost_usd_override === 'number' && input.cost_usd_override > 0;

    // No usage data AND no override → Claude errored or we never got a response.
    // Skip the insert rather than log a meaningless zero-cost row.
    if (!hasUsage && !hasOverride) return;

    const rates = CLAUDE_RATES[input.model as keyof typeof CLAUDE_RATES];
    const computedCost = rates
      ? calculateCost(input.model, { input_tokens: tokensIn, output_tokens: tokensOut })
      : 0;
    const cost = hasOverride ? Number(input.cost_usd_override) : computedCost;

    const row = {
      source: input.source,
      model: input.model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: Number(cost.toFixed(6)),
      duration_ms: input.duration_ms ?? null,
      mcp_calls: Math.max(0, Number(input.mcp_calls ?? 0) || 0),
      metadata: input.metadata ?? null,
    };

    // Fire-and-forget: swallow the promise so callers never block.
    Promise.resolve(supabase.from('ct_claude_usage').insert(row)).catch((err) => {
      console.warn(`[claudeUsageLog] insert failed for ${input.source}:`, err);
    });
  } catch (err) {
    // Defensive: never throw out of the logger — it should NEVER break its caller.
    console.warn(`[claudeUsageLog] unexpected error for ${input.source}:`, err);
  }
}
