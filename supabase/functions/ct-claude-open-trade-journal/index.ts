/**
 * ct-claude-open-trade-journal — running commentary during the trade lifecycle.
 *
 * Claude's open positions used to be silent between entry and exit: we logged
 * WHY he opened, and WHAT happened at close, but the middle was a black box.
 * When a trade lost, we couldn't tell if the thesis broke and Claude failed
 * to recognize it, or if the thesis was wrong from the start.
 *
 * Fix: every 2 min during RTH, for each `ct_trades WHERE trader='claude' AND
 * status='open'`, call Haiku with the quant card + linked hypothesis + prior
 * notes and ask:
 *   - is the thesis still intact
 *   - is the trade working as expected
 *   - any warnings
 * Append one short ~80-char line to claude_notes with a `[HH:MM UTC]` prefix,
 * capture stance (intact | weakening | invalidated | working_as_expected |
 * exceeding_thesis), and log a decision-journal row. On stance='invalidated',
 * write a weight=0.9 'against' evidence row against the linked hypothesis so
 * the confidence loop picks it up.
 *
 * Circuit breaker: this function RUNS even when the breaker is tripped.
 * Managing (journaling) existing positions is not new activity — silencing
 * live commentary while the book bleeds would destroy the record we most
 * want. The breaker only gates NEW trade entry (ct-trade-idea-generator +
 * ct-claude-trade-open).
 *
 * Best-effort contract:
 *   - Never block trade management. All Haiku failures swallowed.
 *   - Skip if opened <4 min ago (let the trade breathe).
 *   - Skip if last journal entry was <90s ago (heartbeat rate limit).
 *   - Quant card is the PRIMARY numerical context. No hallucinated numbers.
 *   - claude_notes capped ~4000 chars; truncate oldest line-entries, keep the
 *     anchor (first entry — usually the close post-mortem will overwrite
 *     entirely, but for OPEN trades the anchor is the earliest running entry)
 *     and the most recent 20 lines.
 *
 * Auth: service role only. Called by pg_cron every 2 min during RTH.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';
import { getTickerQuantCard } from '../_shared/tickerQuantCard.ts';

interface OpenTrade {
  id: string;
  session_date: string;
  instrument: string;
  side: 'long' | 'short';
  size_pct: number;
  size_usd: number;
  entry_price: number;
  stop_price: number | null;
  target_price: number | null;
  thesis: string;
  horizon: string | null;
  opened_at: string | null;
  conviction: number | null;
  hypothesis_id: string | null;
  trade_idea_id: string | null;
  claude_notes: string | null;
  journal_updated_at: string | null;
  journal_version: number | null;
}

interface Hypothesis {
  id: string;
  claim: string;
  invalidate_if: string;
}

type Stance =
  | 'intact'
  | 'weakening'
  | 'invalidated'
  | 'working_as_expected'
  | 'exceeding_thesis';

const STANCES: Stance[] = [
  'intact',
  'weakening',
  'invalidated',
  'working_as_expected',
  'exceeding_thesis',
];

const MIN_AGE_MS = 4 * 60 * 1000;        // 4 min — let the trade breathe
const HEARTBEAT_MS = 90 * 1000;          // 90s — avoid thrashing
const NOTES_CAP_CHARS = 4000;            // claude_notes soft cap
const KEEP_LAST_LINES = 20;              // truncation: keep most recent 20 lines

const TOOLS = [
  {
    name: 'append_journal',
    description:
      'Append one short running-commentary journal line for this open Claude trade. Cite observable numbers from the quant card only — never invent figures. Keep the journal line under ~80 characters. Pick the single best-fit stance. Optionally suggest a tighter stop if the tape has moved materially in Claude\'s favor (only for long/short consistent tightening).',
    input_schema: {
      type: 'object',
      properties: {
        journal_entry: {
          type: 'string',
          description: 'One short line (<=80 chars) summarizing what Claude sees RIGHT NOW. No preamble. No timestamp — the caller prepends [HH:MM UTC].',
        },
        stance: {
          type: 'string',
          enum: STANCES,
          description: 'intact = thesis still plays; weakening = thesis getting shaky; invalidated = invalidate_if condition met or clearly broken; working_as_expected = position moving as planned; exceeding_thesis = trade better than Claude predicted.',
        },
        should_tighten_stop_to: {
          type: 'number',
          description: 'Optional — a tighter stop price. MUST be consistent with side (long: > current stop; short: < current stop) and on the same side of spot as the existing stop. Omit if no change recommended.',
        },
      },
      required: ['journal_entry', 'stance'],
    },
  },
];

const SYSTEM_PROMPT = `You are Co-Trader — Claude, an autonomous paper trader.

You have an OPEN position. Your job RIGHT NOW: re-evaluate the tape and decide if the thesis still holds.

Re-evaluate, don't re-justify. Be honest — if the position is broken, say so. If it's boring, say so. If you want out but your stop hasn't hit, say that.

Read the quant card as your PRIMARY source of truth. Every number you cite must come from it. Do NOT invent prices, levels, or flow figures. If the card is thin, say so and mark stance 'intact' or 'weakening' based on price action vs. stop/target alone.

Stance rules:
- intact: thesis still plausible; nothing has clearly broken it
- weakening: something is starting to cut against the thesis
- invalidated: the invalidate_if condition has been met OR the tape has clearly broken the thesis
- working_as_expected: price is moving toward target, flow supports it
- exceeding_thesis: trade is running harder/faster than planned — consider tightening stop

Journal style: no hedging. One line. Concrete. Example shapes:
- "QQQ 633 > call wall 632; flow still bid, holding"
- "SPY rolled off 708, dp accumulation fading"
- "invalidate_if hit: VIX > 22 spot break below 695"
- "target 40% there, net_call_prem accelerating"

Only suggest a tighter stop when tape has moved materially in your favor. Never widen a stop.

You MUST call the append_journal tool. No freeform text.`;

function hhmmUtc(): string {
  const d = new Date();
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Append a `|`-separated entry onto claude_notes with `[HH:MM UTC]` prefix.
 * Truncates oldest entries if the running total exceeds NOTES_CAP_CHARS:
 * keeps the FIRST entry (which is the running-journal anchor on open trades)
 * and the most recent KEEP_LAST_LINES-1 entries.
 */
function appendNotes(prior: string | null, line: string): string {
  const stamped = `[${hhmmUtc()} UTC] ${line}`.replace(/\s+/g, ' ').trim();
  if (!prior || prior.trim().length === 0) return stamped;
  const combined = `${prior} | ${stamped}`;
  if (combined.length <= NOTES_CAP_CHARS) return combined;

  // Over cap — rebuild with anchor + last N entries.
  const parts = combined.split(' | ').map((p) => p.trim()).filter(Boolean);
  if (parts.length <= KEEP_LAST_LINES + 1) {
    // Nothing to drop structurally — hard-truncate from the front.
    return combined.slice(combined.length - NOTES_CAP_CHARS);
  }
  const anchor = parts[0];
  const tail = parts.slice(-KEEP_LAST_LINES);
  let rebuilt = [anchor, '…', ...tail].join(' | ');
  if (rebuilt.length > NOTES_CAP_CHARS) {
    rebuilt = rebuilt.slice(rebuilt.length - NOTES_CAP_CHARS);
  }
  return rebuilt;
}

function validateStopTighten(
  side: 'long' | 'short',
  currentStop: number | null,
  proposed: unknown,
  entry: number,
): number | null {
  if (proposed == null) return null;
  const p = typeof proposed === 'number' ? proposed : parseFloat(String(proposed));
  if (!Number.isFinite(p)) return null;
  if (currentStop == null) {
    // No prior stop — accept if on the protective side of entry.
    if (side === 'long' && p < entry) return +p.toFixed(4);
    if (side === 'short' && p > entry) return +p.toFixed(4);
    return null;
  }
  // Tightening = moving stop toward entry (reduces risk).
  if (side === 'long' && p > currentStop && p < entry) return +p.toFixed(4);
  if (side === 'short' && p < currentStop && p > entry) return +p.toFixed(4);
  return null;
}

async function journalOneTrade(
  supabase: SupabaseClient,
  trade: OpenTrade,
): Promise<{ trade_id: string; outcome: string; stance?: Stance; journaled?: string }> {
  const now = Date.now();

  // Breathe gate — trade must be at least MIN_AGE_MS old.
  if (trade.opened_at) {
    const openedMs = Date.parse(trade.opened_at);
    if (Number.isFinite(openedMs) && now - openedMs < MIN_AGE_MS) {
      return { trade_id: trade.id, outcome: 'skip_too_fresh' };
    }
  }

  // Heartbeat gate — last journal entry must be older than HEARTBEAT_MS.
  if (trade.journal_updated_at) {
    const lastMs = Date.parse(trade.journal_updated_at);
    if (Number.isFinite(lastMs) && now - lastMs < HEARTBEAT_MS) {
      return { trade_id: trade.id, outcome: 'skip_heartbeat' };
    }
  }

  // PRIMARY numerical context — quant card (structural + flow + sentiment + news).
  const card = await getTickerQuantCard(supabase, trade.instrument);
  if (!card) {
    return { trade_id: trade.id, outcome: 'skip_no_quant_card' };
  }
  const spot = card.structure?.spot ?? null;

  // Linked hypothesis (just claim + invalidate_if — keep context tight).
  let hypothesis: Hypothesis | null = null;
  if (trade.hypothesis_id) {
    const { data: hyp } = await supabase
      .from('ct_hypotheses')
      .select('id, claim, invalidate_if')
      .eq('id', trade.hypothesis_id)
      .maybeSingle();
    if (hyp) hypothesis = hyp as Hypothesis;
  }

  // Prior notes — last ~5 entries for continuity.
  const priorEntries = (trade.claude_notes ?? '')
    .split(' | ')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-5);

  const userMessage = JSON.stringify({
    position: {
      instrument: trade.instrument,
      side: trade.side,
      entry_price: trade.entry_price,
      stop_price: trade.stop_price,
      target_price: trade.target_price,
      size_pct: trade.size_pct,
      size_usd: trade.size_usd,
      horizon: trade.horizon,
      conviction: trade.conviction,
      thesis: trade.thesis,
      opened_at: trade.opened_at,
      current_spot: spot,
      unrealized_pnl_pct: (spot != null && trade.entry_price)
        ? +(((trade.side === 'long'
            ? (spot / trade.entry_price - 1)
            : (trade.entry_price / spot - 1)) * 100).toFixed(4))
        : null,
    },
    linked_hypothesis: hypothesis
      ? { claim: hypothesis.claim, invalidate_if: hypothesis.invalidate_if }
      : null,
    quant_card: card,
    prior_journal_entries_last_5: priorEntries,
    note: 'Call append_journal exactly once. Cite numbers from quant_card only.',
  });

  const callStart = Date.now();
  let resp;
  try {
    resp = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      tools: TOOLS,
      tool_choice: { type: 'tool', name: 'append_journal' },
      max_tokens: 400,
      temperature: 0.2,
    });
  } catch (e) {
    const msg = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
    console.warn(`[ct-claude-open-trade-journal] Claude failed for ${trade.id}: ${msg}`);
    return { trade_id: trade.id, outcome: 'claude_failed' };
  }

  logClaudeUsage(supabase, {
    source: 'ct-claude-open-trade-journal',
    model: CLAUDE_MODELS.haiku,
    usage: resp.usage,
    duration_ms: Date.now() - callStart,
    metadata: { trade_id: trade.id, instrument: trade.instrument },
  });

  const tool = parseToolUse(resp);
  if (!tool || tool.name !== 'append_journal') {
    return { trade_id: trade.id, outcome: 'no_tool_use' };
  }
  const input = tool.input as {
    journal_entry?: unknown;
    stance?: unknown;
    should_tighten_stop_to?: unknown;
  };

  const journalEntry = typeof input.journal_entry === 'string'
    ? input.journal_entry.trim().slice(0, 180)
    : '';
  if (!journalEntry) return { trade_id: trade.id, outcome: 'empty_entry' };

  const stance = STANCES.includes(input.stance as Stance)
    ? (input.stance as Stance)
    : 'intact';

  const tighterStop = validateStopTighten(
    trade.side,
    trade.stop_price,
    input.should_tighten_stop_to,
    trade.entry_price,
  );

  const nextNotes = appendNotes(trade.claude_notes, journalEntry);

  // APPEND (not overwrite). Also bumps journal_updated_at / journal_version.
  // We do NOT tighten the stop here — the update guard only permits journal
  // columns from the authenticated path, but service-role can write stops.
  // Still, auto-stop-tightening from a journaling function is a new policy
  // decision and would need its own review; we log the SUGGESTED stop in
  // the decision-journal outcome instead of applying it.
  const { error: updErr } = await supabase
    .from('ct_trades')
    .update({
      claude_notes: nextNotes,
      journal_updated_at: new Date().toISOString(),
      journal_version: (trade.journal_version ?? 1) + 1,
    })
    .eq('id', trade.id);
  if (updErr) {
    console.warn(`[ct-claude-open-trade-journal] update failed for ${trade.id}: ${updErr.message}`);
    return { trade_id: trade.id, outcome: 'update_failed' };
  }

  // Decision journal — structured capture of this evaluation. tape_signal
  // captures the observable numbers Claude cited; narrative_signal captures
  // the thesis check (hypothesis intact vs. not).
  await recordDecision(supabase, {
    decision_type: 'trade_journal',
    model_tier: 'haiku',
    reasoning: `Journal (${stance}): ${journalEntry}${tighterStop != null ? ` [suggested_stop=${tighterStop}]` : ''}`,
    outcome: stance,
    alignment: stance === 'invalidated' ? 'conflict'
      : stance === 'weakening' ? 'partial'
      : 'aligned',
    claude_followed: stance === 'invalidated' ? 'tape' : 'narrative',
    narrative_signal: hypothesis ? {
      direction: trade.side === 'long' ? 'bullish' : 'bearish',
      reasoning: hypothesis.claim,
      sources: ['ct_hypotheses.claim', 'ct_hypotheses.invalidate_if'],
    } : undefined,
    tape_signal: {
      direction: (spot != null && trade.entry_price)
        ? (trade.side === 'long'
            ? (spot >= trade.entry_price ? 'bullish' : 'bearish')
            : (spot <= trade.entry_price ? 'bearish' : 'bullish'))
        : undefined,
      reasoning: `spot=${spot} entry=${trade.entry_price} stop=${trade.stop_price} target=${trade.target_price}`,
      sources: ['build_ticker_quant_card'],
    },
    linked_hypothesis_id: trade.hypothesis_id ?? undefined,
    linked_trade_idea_id: trade.trade_idea_id ?? undefined,
    linked_trade_id: trade.id,
    context_snapshot: {
      instrument: trade.instrument,
      side: trade.side,
      size_pct: trade.size_pct,
      entry_price: trade.entry_price,
      stop_price: trade.stop_price,
      target_price: trade.target_price,
      spot,
      suggested_stop: tighterStop,
      quant_card_freshness: card.freshness ?? null,
    },
    tokens_in: resp.usage.input_tokens,
    tokens_out: resp.usage.output_tokens,
  });

  // If Claude marked the thesis invalidated and there's a hypothesis to blame,
  // file it as hard 'against' evidence so the confidence loop picks it up.
  if (stance === 'invalidated' && trade.hypothesis_id) {
    const { error: evErr } = await supabase.from('ct_hypothesis_evidence').insert({
      hypothesis_id: trade.hypothesis_id,
      evidence_type: 'observation',
      source_id: trade.id,
      polarity: 'against',
      weight: 0.9,
      summary: `Live-trade journal marked invalidated: ${journalEntry}`,
      added_by: 'claude',
    });
    if (evErr) {
      console.warn(`[ct-claude-open-trade-journal] evidence insert failed for ${trade.id}: ${evErr.message}`);
    }
  }

  return {
    trade_id: trade.id,
    outcome: 'journaled',
    stance,
    journaled: journalEntry,
  };
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Service role required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  // Circuit breaker: we INTENTIONALLY keep running when halted. Journaling
  // existing positions is not new activity — the whole point of the breaker
  // is that the book can still bleed out; we want the running commentary
  // for exactly those moments. Log a note on the batch response if halted
  // so operators know journaling continued during a halt.
  let haltedBatch = false;
  try {
    const { data: haltRows } = await supabase.rpc('is_claude_trading_halted');
    const halt = Array.isArray(haltRows) ? haltRows[0] : null;
    if (halt && halt.halted === true) haltedBatch = true;
  } catch (_e) {
    // Non-fatal — keep going.
  }

  const { data: trades, error } = await supabase
    .from('ct_trades')
    .select('id, session_date, instrument, side, size_pct, size_usd, entry_price, stop_price, target_price, thesis, horizon, opened_at, conviction, hypothesis_id, trade_idea_id, claude_notes, journal_updated_at, journal_version')
    .eq('trader', 'claude')
    .eq('status', 'open');
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: `trades load: ${error.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const openTrades = (trades ?? []) as OpenTrade[];
  if (openTrades.length === 0) {
    return new Response(JSON.stringify({
      ok: true,
      processed: 0,
      journaled: 0,
      halted_batch: haltedBatch,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const results: Array<{ trade_id: string; outcome: string; stance?: Stance; journaled?: string }> = [];
  for (const t of openTrades) {
    try {
      const r = await journalOneTrade(supabase, t);
      results.push(r);
    } catch (e) {
      // Never block — best effort.
      console.warn(`[ct-claude-open-trade-journal] threw for ${t.id}: ${e instanceof Error ? e.message : String(e)}`);
      results.push({ trade_id: t.id, outcome: 'threw' });
    }
  }

  const journaled = results.filter((r) => r.outcome === 'journaled').length;
  const body = {
    ok: true,
    processed: openTrades.length,
    journaled,
    halted_batch: haltedBatch,
    results,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-claude-open-trade-journal]', JSON.stringify({
    processed: body.processed,
    journaled: body.journaled,
    halted_batch: body.halted_batch,
    duration_ms: body.duration_ms,
  }));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
