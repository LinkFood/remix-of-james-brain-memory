/**
 * tradeQuality — fire-and-forget Haiku self-rating of Co-Trader trades.
 *
 * Two calls per trade lifecycle:
 *   1. firePreTradeQuality  — after commit, BEFORE outcome is known.
 *      Grades the SETUP 1-10. Outcome-blind.
 *   2. firePostTradeQuality — after close, outcome is known.
 *      Re-grades EXECUTION 1-10. Delta = post - pre = the learning signal.
 *
 * Both are fire-and-forget. They spawn an async IIFE that writes the rating
 * to ct_trades and logs the Haiku usage — they NEVER throw back into the
 * caller. A rating failure must never block a trade commit or a close path.
 *
 * Cost: Haiku, ~$0.001 per rating. Two per trade = ~$0.002. Negligible at
 * the book-manager's volume.
 */

import { callClaude, CLAUDE_MODELS, parseTextContent } from './anthropic.ts';
import { logClaudeUsage } from './claudeUsageLog.ts';
import { PRE_TRADE_QUALITY_SYSTEM, POST_TRADE_QUALITY_SYSTEM } from './ctPrompts.ts';
import { readTiltSnapshot } from './streakRead.ts';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

// Loose Supabase client shape — avoids pulling @supabase/supabase-js types here.
interface SupabaseLike {
  from: (table: string) => {
    update: (row: Record<string, unknown>) => {
      eq: (col: string, val: string) => Promise<unknown> | PromiseLike<unknown>;
    };
  };
}

export interface PreTradeQualityInput {
  tradeId: string;
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  thesis: string | null;
  conviction: number | null;
  contract_type?: string | null;
  /** Optional context payload — recent grades, active biases, concentration snapshot, etc. */
  context?: Record<string, unknown> | null;
  /** Free-form marker — 'claude-trade-open' | 'alert-book-commit' | 'chat'. Goes on the usage row. */
  source?: string;
}

export interface PostTradeQualityInput {
  tradeId: string;
  instrument: string;
  side: 'long' | 'short';
  entry_price: number | null;
  stop_price: number | null;
  target_price: number | null;
  close_price: number | null;
  close_reason: string | null;
  realized_pnl_pct: number | null;
  thesis: string | null;
  opened_at: string | null;
  closed_at: string | null;
  /** The pre-trade rating we set earlier — fed in so Claude can reference it and justify any delta. */
  pre_trade_quality: number | null;
  pre_trade_quality_reasoning: string | null;
  contract_type?: string | null;
  source?: string;
}

function parseQualityJson(raw: string): { quality: number; reasoning: string } | null {
  const cleaned = raw
    .replace(/^\s*```(?:json)?\s*/, '')
    .replace(/\s*```\s*$/, '')
    .trim();
  try {
    const parsed = JSON.parse(cleaned) as { quality?: unknown; reasoning?: unknown };
    const q = Number(parsed.quality);
    if (!Number.isFinite(q)) return null;
    const qInt = Math.round(q);
    if (qInt < 1 || qInt > 10) return null;
    const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.trim() : '';
    if (!reasoning) return null;
    return { quality: qInt, reasoning: reasoning.slice(0, 1000) };
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget pre-trade quality rating. Spawns a Haiku call, parses the
 * JSON, writes pre_trade_quality + reasoning on ct_trades.
 *
 * Call this AFTER the insert of ct_trades has succeeded (we need the trade_id).
 * Never awaited by the caller.
 */
export function firePreTradeQuality(supabase: SupabaseLike, input: PreTradeQualityInput): void {
  (async () => {
    try {
      // Pull current tilt snapshot so Haiku can see the psych state. The
      // system prompt (ctPrompts.PRE_TRADE_QUALITY_SYSTEM) has a rule:
      // "If tilt_risk=true, CAP at 6 and mention the tilt context in
      // reasoning." Non-blocking — if the read fails, we just omit it.
      let tiltContext: Record<string, unknown> = {};
      try {
        const snap = await readTiltSnapshot(supabase as unknown as SupabaseClient);
        if (snap.total_30d > 0) {
          tiltContext = {
            tilt_risk: snap.tilt_risk,
            current_wrong_streak: snap.current_wrong_streak,
            current_right_streak: snap.current_right_streak,
            last_5_right_rate: snap.last_5_right_rate,
            tilt_reasons: snap.tilt_reasons,
          };
        }
      } catch (e) {
        console.warn('[tradeQuality:pre] tilt snapshot failed:', e instanceof Error ? e.message : e);
      }

      const userMessage = JSON.stringify({
        instrument: input.instrument,
        side: input.side,
        size_pct: input.size_pct,
        entry_price: input.entry_price,
        stop_price: input.stop_price,
        target_price: input.target_price,
        thesis: input.thesis,
        conviction: input.conviction,
        contract_type: input.contract_type ?? 'underlying',
        ...tiltContext,
        ...(input.context ?? {}),
        note: 'Rate the SETUP per the system prompt. Return ONLY the JSON.',
      });
      const started = Date.now();
      const res = await callClaude({
        model: CLAUDE_MODELS.haiku,
        system: PRE_TRADE_QUALITY_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 300,
        temperature: 0.2,
      });
      const text = parseTextContent(res).trim();
      const parsed = parseQualityJson(text);
      if (!parsed) {
        console.warn(`[tradeQuality:pre] invalid response for ${input.tradeId}: ${text.slice(0, 120)}`);
        return;
      }
      await supabase.from('ct_trades').update({
        pre_trade_quality: parsed.quality,
        pre_trade_quality_reasoning: parsed.reasoning,
      }).eq('id', input.tradeId);
      logClaudeUsage(supabase as unknown as Parameters<typeof logClaudeUsage>[0], {
        source: 'trade-quality',
        model: CLAUDE_MODELS.haiku,
        usage: res.usage,
        duration_ms: Date.now() - started,
        metadata: {
          trade_id: input.tradeId,
          instrument: input.instrument,
          phase: 'pre',
          via: input.source ?? 'unknown',
          quality: parsed.quality,
        },
      });
    } catch (e) {
      console.warn('[tradeQuality:pre] failed for', input.tradeId, e instanceof Error ? e.message : e);
    }
  })();
}

/**
 * Fire-and-forget post-trade quality rating. Spawns a Haiku call AFTER close,
 * parses the JSON, writes post_trade_quality + reasoning on ct_trades.
 *
 * Skips if the trade has no close_price (still open — shouldn't be called in
 * that case, but defensive). Skips if pre_trade_quality is null — the whole
 * point is the delta; grading post without pre just pollutes the view.
 */
export function firePostTradeQuality(supabase: SupabaseLike, input: PostTradeQualityInput): void {
  if (input.close_price == null) {
    console.warn('[tradeQuality:post] skip — no close_price', input.tradeId);
    return;
  }
  // Skip when we have no pre-rating to pair against. A post-only rating
  // can't produce a delta — the whole point of the split is the learning
  // signal. Trades without pre-ratings (backfill gap, feature predates
  // trade) get left alone rather than half-graded.
  if (input.pre_trade_quality == null) {
    console.log('[tradeQuality:post] skip — no pre_trade_quality to pair with', input.tradeId);
    return;
  }
  (async () => {
    try {
      const durationMin = input.opened_at && input.closed_at
        ? Math.max(0, Math.round((new Date(input.closed_at).getTime() - new Date(input.opened_at).getTime()) / 60_000))
        : null;
      const userMessage = JSON.stringify({
        instrument: input.instrument,
        side: input.side,
        contract_type: input.contract_type ?? 'underlying',
        entry_price: input.entry_price,
        stop_price: input.stop_price,
        target_price: input.target_price,
        close_price: input.close_price,
        close_reason: input.close_reason,
        realized_pnl_pct: input.realized_pnl_pct,
        duration_minutes: durationMin,
        thesis: input.thesis,
        pre_trade_quality: input.pre_trade_quality,
        pre_trade_quality_reasoning: input.pre_trade_quality_reasoning,
        note: 'Re-rate EXECUTION per the system prompt. If delta != 0, explain why. Return ONLY the JSON.',
      });
      const started = Date.now();
      const res = await callClaude({
        model: CLAUDE_MODELS.haiku,
        system: POST_TRADE_QUALITY_SYSTEM,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 350,
        temperature: 0.2,
      });
      const text = parseTextContent(res).trim();
      const parsed = parseQualityJson(text);
      if (!parsed) {
        console.warn(`[tradeQuality:post] invalid response for ${input.tradeId}: ${text.slice(0, 120)}`);
        return;
      }
      await supabase.from('ct_trades').update({
        post_trade_quality: parsed.quality,
        post_trade_quality_reasoning: parsed.reasoning,
      }).eq('id', input.tradeId);
      logClaudeUsage(supabase as unknown as Parameters<typeof logClaudeUsage>[0], {
        source: 'trade-quality',
        model: CLAUDE_MODELS.haiku,
        usage: res.usage,
        duration_ms: Date.now() - started,
        metadata: {
          trade_id: input.tradeId,
          instrument: input.instrument,
          phase: 'post',
          via: input.source ?? 'unknown',
          pre: input.pre_trade_quality,
          post: parsed.quality,
          delta: parsed.quality - input.pre_trade_quality,
        },
      });
    } catch (e) {
      console.warn('[tradeQuality:post] failed for', input.tradeId, e instanceof Error ? e.message : e);
    }
  })();
}
