/**
 * ct-trade-idea-generator — Claude proposes concrete tradeable setups from
 * its own open hypotheses, every heartbeat during RTH.
 *
 * Input:  open ct_hypotheses (confidence >= min), latest heartbeat + recent
 *         heartbeats for trend, recent grades on each hypothesis.
 * Output: ct_trade_ideas rows (status='armed', trader='claude') with concrete
 *         entry_trigger JSON, stop/target/size — bounded by max_size_pct and
 *         max_concurrent_positions.
 *
 * Claude Haiku forced tool-use: either `propose_trade_idea` OR `no_trade`.
 * One call per eligible hypothesis (cap 10 per run).
 *
 * Auth: service role only. Called by pg_cron every 5 min during RTH.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse, ClaudeError, calculateCost } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { getConfig } from '../_shared/configCache.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';
import {
  getTickerQuantCard,
  getCachedTickerSnapshot,
  TickerQuantCard,
} from '../_shared/tickerQuantCard.ts';

const VALID_HORIZONS = new Set(['intraday', 'session', 'swing', 'multi_day']);
const VALID_TRIGGER_TYPES = new Set(['price_cross', 'break_above', 'break_below', 'touch_level', 'time_gate']);

interface HypothesisRow {
  id: string;
  claim: string;
  because: string[];
  invalidate_if: string;
  horizon: string;
  confidence: number;
  elo: number;
  tickers: string[];
  status: string;
  created_at: string;
}

interface HeartbeatRow {
  id: string;
  status_line: string;
  current_reads: Record<string, unknown> | null;
  created_at: string;
}

const TOOLS = [
  {
    name: 'propose_trade_idea',
    description: 'Propose a concrete tradeable setup RIGHT NOW based on the hypothesis and current market state. Only use when there is a real, actionable edge with a specific trigger.',
    input_schema: {
      type: 'object',
      properties: {
        instrument:    { type: 'string', description: 'Ticker symbol (must match or be in hypothesis tickers)' },
        contract_type: { type: 'string', enum: ['stock', 'call', 'put'] },
        strike:        { type: 'number', description: 'Strike price (options only, optional for stock)' },
        expiry:        { type: 'string', description: 'YYYY-MM-DD expiry (options only, optional for stock)' },
        direction:     { type: 'string', enum: ['long', 'short'] },
        entry_trigger: {
          type: 'object',
          properties: {
            type:      { type: 'string', enum: ['price_cross', 'break_above', 'break_below', 'touch_level', 'time_gate'] },
            level:     { type: 'number', description: 'Price level for cross/break/touch' },
            condition: { type: 'string', enum: ['above', 'below'], description: 'Required for price_cross' },
            time:      { type: 'string', description: 'ISO timestamp for time_gate' },
          },
          required: ['type'],
        },
        stop_pct:   { type: 'number', description: 'Adverse move pct from entry (negative, e.g. -0.5 for 0.5% stop)' },
        target_pct: { type: 'number', description: 'Favorable move pct from entry (positive, e.g. 1.2 for 1.2% target)' },
        size_pct:   { type: 'number', description: 'Position size as % of book, bounded by max_size_pct' },
        horizon:    { type: 'string', enum: ['intraday', 'session', 'swing', 'multi_day'] },
        rationale:  { type: 'string', description: 'Why this setup right now — cite the hypothesis + market state' },
      },
      required: ['instrument', 'contract_type', 'direction', 'entry_trigger', 'stop_pct', 'target_pct', 'size_pct', 'horizon', 'rationale'],
    },
  },
  {
    name: 'no_trade',
    description: 'Current conditions do not support a concrete tradeable setup. Do not force trades.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why no trade right now' },
      },
      required: ['reason'],
    },
  },
];

const SYSTEM = `You are an independent trader. A hypothesis of yours is currently open.
Market state is attached: latest heartbeat, recent heartbeats for trend, your
recent grades on this hypothesis (for learning), AND — critically — a
per-ticker quant card for every ticker in the hypothesis. Each quant card
contains: structure (gamma_flip, call_wall, put_wall, max_pain, iv_rank,
net_gamma, regime), flow_last_hour (whales/sweeps/net_prem), dark_pool_last_hour,
greek_flow_last_hour, sentiment (nope, put/call, net_prem_cum), events (next
earnings, upcoming catalysts), news (last 5 breaking items), brief tilt, and
freshness.

Use the quant card aggressively — it is the "tape." Your hypothesis is the
"narrative." When they AGREE, size up within limits. When they DISAGREE, either
size down hard or call no_trade. Never ignore the tape.

If current conditions support a concrete tradeable setup RIGHT NOW with a clear
trigger, entry, stop, target, and size (bounded by max_size_pct), call
propose_trade_idea. Otherwise call no_trade.

Rules:
- size_pct MUST be in (0, max_size_pct].
- stop_pct MUST be negative (adverse move from entry).
- target_pct MUST be positive (favorable move).
- instrument MUST match or be one of the hypothesis tickers.
- entry_trigger must be measurable from spot prices (price_cross/break/touch) or
  a specific UTC time (time_gate).
- Do NOT force a trade. No-trade is a first-class response. Quality > frequency.
- Prefer tight stops + asymmetric targets when the hypothesis is high-conviction.
- If your recent grades show the hypothesis has been wrong lately, demote size
  or skip entirely.
- If the brief says avoid_today for this ticker, size must be cut in half or
  you should no_trade.`;

// -----------------------------------------------------------------------------
// Sonnet size-review escalation. When Haiku proposes a size >= the configured
// threshold (claude_size_sonnet_escalation_pct, default 2.0), we run a second
// pass with Sonnet 4 using the full quant card as context and ask it to
// approve / modify_down / reject. Sonnet can only ADJUST SIZE DOWN — Haiku's
// size is the ceiling — or reject entirely.
// -----------------------------------------------------------------------------
const SONNET_REVIEW_TOOLS = [
  {
    name: 'size_approve',
    description: 'Approve the proposed size as-is. Use when the full quant card confirms the thesis and the size is reasonable given iv_rank, gamma regime, flow, and upcoming catalysts.',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Why the proposed size is right given the quant card.' },
      },
      required: ['reasoning'],
    },
  },
  {
    name: 'size_modify',
    description: 'Approve the trade but reduce the size. Use when the thesis is valid but the quant card reveals extra risk (e.g. wide IV, close to earnings, weak flow alignment, negative gamma regime).',
    input_schema: {
      type: 'object',
      properties: {
        new_size_pct: { type: 'number', description: 'New size percent. MUST be > 0 and STRICTLY LESS than the proposed size_pct.' },
        reasoning:    { type: 'string', description: 'Why size should be reduced to this level.' },
      },
      required: ['new_size_pct', 'reasoning'],
    },
  },
  {
    name: 'size_reject',
    description: 'Reject the trade entirely. Use when the quant card materially contradicts the hypothesis, or when the setup is too dangerous at any size (e.g. event day, chop in negative gamma, tape pointing the other way).',
    input_schema: {
      type: 'object',
      properties: {
        reasoning: { type: 'string', description: 'Why the proposed trade should not be armed at any size.' },
      },
      required: ['reasoning'],
    },
  },
];

const SONNET_REVIEW_SYSTEM = `You are the senior reviewer. Haiku just proposed a
trade idea whose size exceeds the normal risk threshold. Your job is a
size-risk sanity check.

You can ONLY:
  - size_approve   (use the proposed size as-is)
  - size_modify    (lower the size — never raise it)
  - size_reject    (skip the trade entirely)

Weight the full quant card against the proposed thesis. Particular red flags:
  - earnings within 2 trading days (cut size or reject),
  - iv_rank > 80 with a long-option direction (cut size),
  - structure regime='negative_gamma' with directional momentum trade (reject or cut),
  - flow pointing the opposite direction of the proposal (reject or cut),
  - brief.avoid_today for this ticker (reject unless thesis explicitly overrides).

If nothing meaningful contradicts the thesis, approve.`;

interface SonnetReviewOutcome {
  decision: 'approve' | 'modify' | 'reject';
  final_size_pct: number | null;
  reasoning: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
}

async function runSonnetSizeReview(
  supabase: SupabaseClient,
  proposed: ProposedIdea,
  hyp: HypothesisRow,
  quantCards: Record<string, TickerQuantCard | null>,
): Promise<SonnetReviewOutcome | null> {
  const payload = {
    proposed_idea: proposed,
    hypothesis: {
      id: hyp.id,
      claim: hyp.claim,
      because: hyp.because,
      invalidate_if: hyp.invalidate_if,
      confidence: hyp.confidence,
      elo: hyp.elo,
    },
    quant_card_for_instrument: quantCards[proposed.instrument] ?? null,
    all_quant_cards: quantCards,
  };

  const callStart = Date.now();
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: SONNET_REVIEW_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
      tools: SONNET_REVIEW_TOOLS,
      tool_choice: { type: 'any' },
      max_tokens: 1500,
      temperature: 0.2,
    });
    const tu = parseToolUse(res);
    const tokensIn = res.usage?.input_tokens ?? 0;
    const tokensOut = res.usage?.output_tokens ?? 0;
    const cost = calculateCost(CLAUDE_MODELS.sonnet, res.usage ?? { input_tokens: 0, output_tokens: 0 });
    logClaudeUsage(supabase, {
      source: 'ct-trade-idea-generator:sonnet_size_review',
      model: CLAUDE_MODELS.sonnet,
      usage: res.usage,
      duration_ms: Date.now() - callStart,
      metadata: { hypothesis_id: hyp.id, instrument: proposed.instrument, proposed_size_pct: proposed.size_pct },
    });

    if (!tu) {
      return { decision: 'reject', final_size_pct: null, reasoning: 'Sonnet returned no tool use — failing closed.', tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost };
    }
    if (tu.name === 'size_approve') {
      const reasoning = typeof tu.input.reasoning === 'string' ? tu.input.reasoning : 'approved';
      return { decision: 'approve', final_size_pct: proposed.size_pct, reasoning, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost };
    }
    if (tu.name === 'size_modify') {
      const candidate = Number(tu.input.new_size_pct);
      const reasoning = typeof tu.input.reasoning === 'string' ? tu.input.reasoning : 'modified';
      // Clamp: Sonnet can only go DOWN. If it tries to match or exceed, treat as approve at proposed.
      if (!Number.isFinite(candidate) || candidate <= 0) {
        return { decision: 'reject', final_size_pct: null, reasoning: `Sonnet modify returned invalid size ${candidate}: ${reasoning}`, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost };
      }
      if (candidate >= proposed.size_pct) {
        return { decision: 'approve', final_size_pct: proposed.size_pct, reasoning: `Sonnet tried to raise/match size (${candidate}); clamped to proposed ${proposed.size_pct}. ${reasoning}`, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost };
      }
      return { decision: 'modify', final_size_pct: candidate, reasoning, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost };
    }
    if (tu.name === 'size_reject') {
      const reasoning = typeof tu.input.reasoning === 'string' ? tu.input.reasoning : 'rejected';
      return { decision: 'reject', final_size_pct: null, reasoning, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost };
    }
    return { decision: 'reject', final_size_pct: null, reasoning: `Unknown Sonnet tool: ${tu.name}`, tokens_in: tokensIn, tokens_out: tokensOut, cost_usd: cost };
  } catch (e) {
    console.warn(`[ct-trade-idea-generator] Sonnet review threw: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

interface ProposedIdea {
  instrument: string;
  contract_type: 'stock' | 'call' | 'put';
  strike?: number;
  expiry?: string;
  direction: 'long' | 'short';
  entry_trigger: {
    type: string;
    level?: number;
    condition?: string;
    time?: string;
  };
  stop_pct: number;
  target_pct: number;
  size_pct: number;
  horizon: string;
  rationale: string;
}

function validateIdea(
  idea: unknown,
  hyp: HypothesisRow,
  maxSizePct: number,
): { ok: true; idea: ProposedIdea } | { ok: false; reason: string } {
  if (!idea || typeof idea !== 'object') return { ok: false, reason: 'not an object' };
  const i = idea as Record<string, unknown>;
  const inst = typeof i.instrument === 'string' ? i.instrument.toUpperCase().trim() : '';
  if (!inst) return { ok: false, reason: 'missing instrument' };
  if (hyp.tickers.length > 0 && !hyp.tickers.map((t) => t.toUpperCase()).includes(inst)) {
    return { ok: false, reason: `instrument ${inst} not in hypothesis tickers ${hyp.tickers.join(',')}` };
  }
  const ct = i.contract_type;
  if (ct !== 'stock' && ct !== 'call' && ct !== 'put') return { ok: false, reason: 'bad contract_type' };
  const dir = i.direction;
  if (dir !== 'long' && dir !== 'short') return { ok: false, reason: 'bad direction' };
  const trig = i.entry_trigger as Record<string, unknown> | undefined;
  if (!trig || typeof trig !== 'object') return { ok: false, reason: 'missing entry_trigger' };
  const trigType = trig.type as string;
  if (!VALID_TRIGGER_TYPES.has(trigType)) return { ok: false, reason: `bad trigger type ${trigType}` };
  if (trigType === 'price_cross') {
    if (typeof trig.level !== 'number' || !(trig.condition === 'above' || trig.condition === 'below')) {
      return { ok: false, reason: 'price_cross needs level + condition' };
    }
  } else if (trigType === 'break_above' || trigType === 'break_below' || trigType === 'touch_level') {
    if (typeof trig.level !== 'number') return { ok: false, reason: `${trigType} needs level` };
  } else if (trigType === 'time_gate') {
    if (typeof trig.time !== 'string' || isNaN(Date.parse(trig.time))) return { ok: false, reason: 'time_gate needs ISO time' };
  }
  const stopPct = Number(i.stop_pct);
  const targetPct = Number(i.target_pct);
  const sizePct = Number(i.size_pct);
  if (!Number.isFinite(stopPct) || stopPct >= 0) return { ok: false, reason: 'stop_pct must be negative' };
  if (!Number.isFinite(targetPct) || targetPct <= 0) return { ok: false, reason: 'target_pct must be positive' };
  if (!Number.isFinite(sizePct) || sizePct <= 0 || sizePct > maxSizePct) return { ok: false, reason: `size_pct must be (0, ${maxSizePct}]` };
  const horizon = i.horizon as string;
  if (!VALID_HORIZONS.has(horizon)) return { ok: false, reason: `bad horizon ${horizon}` };
  const rationale = typeof i.rationale === 'string' ? i.rationale.trim() : '';
  if (rationale.length < 10) return { ok: false, reason: 'rationale too short' };

  return {
    ok: true,
    idea: {
      instrument: inst,
      contract_type: ct,
      strike: typeof i.strike === 'number' ? i.strike : undefined,
      expiry: typeof i.expiry === 'string' ? i.expiry : undefined,
      direction: dir,
      entry_trigger: {
        type: trigType,
        level: typeof trig.level === 'number' ? trig.level : undefined,
        condition: typeof trig.condition === 'string' ? trig.condition : undefined,
        time: typeof trig.time === 'string' ? trig.time : undefined,
      },
      stop_pct: stopPct,
      target_pct: targetPct,
      size_pct: sizePct,
      horizon,
      rationale,
    },
  };
}

/** Look up the most recent spot price for a ticker from heartbeats → gex_timeseries. */
async function resolveSpot(supabase: SupabaseClient, ticker: string): Promise<number | null> {
  // Try the latest heartbeat's current_reads first.
  const { data: hbRows } = await supabase
    .from('ct_heartbeats')
    .select('current_reads')
    .order('created_at', { ascending: false })
    .limit(1);
  const reads = hbRows?.[0]?.current_reads as Record<string, unknown> | null | undefined;
  if (reads && typeof reads === 'object') {
    const per = reads[ticker] as Record<string, unknown> | undefined;
    const spot = per && typeof per === 'object' ? (per.spot ?? per.price ?? per.underlying_price) : undefined;
    const p = typeof spot === 'number' ? spot : typeof spot === 'string' ? parseFloat(spot) : NaN;
    if (Number.isFinite(p)) return p;
  }
  // Fallback: latest gex timeseries row for this ticker.
  const { data: gex } = await supabase
    .from('ct_gex_timeseries')
    .select('underlying_price')
    .eq('ticker', ticker)
    .order('snapshot_at', { ascending: false })
    .limit(1);
  const up = gex?.[0]?.underlying_price;
  if (typeof up === 'number' && Number.isFinite(up)) return up;
  return null;
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

  // Safety gate: skip entirely if Claude is circuit-broken today.
  {
    const { data: haltRows } = await supabase.rpc('is_claude_trading_halted');
    const halt = Array.isArray(haltRows) ? haltRows[0] : null;
    if (halt && halt.halted === true) {
      const reason = `circuit breaker active: ${halt.breaker_type} — ${halt.reason}`;
      await supabase.from('ct_claude_decisions').insert({
        decision_type: 'no_trade',
        model_tier:    'none',
        reasoning:     reason,
        outcome:       'skipped: circuit_breaker_active',
        context_snapshot: {
          source:       'ct-trade-idea-generator',
          breaker_type: halt.breaker_type,
          tripped_at:   halt.tripped_at,
        },
      });
      return new Response(JSON.stringify({
        ok: true,
        halted: true,
        breaker_type: halt.breaker_type,
        reason,
        duration_ms: Date.now() - startedAt,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  // Config
  const minConfidence       = Number(await getConfig<number>('claude_min_hypothesis_confidence', 0.45));
  const maxSizePct          = Number(await getConfig<number>('claude_max_position_size_pct', 5));
  const maxConcurrent       = Number(await getConfig<number>('claude_max_concurrent_positions', 5));
  const ttlMinutes          = Number(await getConfig<number>('claude_trade_idea_ttl_minutes', 120));
  const cooldownMinutes     = Number(await getConfig<number>('claude_generator_cooldown_minutes', 5));
  const sizeEscalationPct   = Number(await getConfig<number>('claude_size_sonnet_escalation_pct', 2.0));

  // Load open hypotheses above min confidence, capped at 10.
  const { data: hyps, error: hypErr } = await supabase
    .from('ct_hypotheses')
    .select('id, claim, because, invalidate_if, horizon, confidence, elo, tickers, status, created_at')
    .eq('status', 'open')
    .gte('confidence', minConfidence)
    .order('confidence', { ascending: false })
    .limit(10);
  if (hypErr) {
    return new Response(JSON.stringify({ ok: false, error: `hypotheses load: ${hypErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!hyps || hyps.length === 0) {
    return new Response(JSON.stringify({
      ok: true,
      eligible_hypotheses: 0,
      armed: 0,
      no_trade_count: 0,
      note: 'no open hypotheses above min confidence',
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Current concurrent position count for Claude (open trades + armed non-expired ideas).
  const nowIso = new Date().toISOString();
  const [openTrades, armedIdeas] = await Promise.all([
    supabase.from('ct_trades').select('id', { count: 'exact', head: true }).eq('trader', 'claude').eq('status', 'open'),
    supabase.from('ct_trade_ideas').select('id', { count: 'exact', head: true }).eq('trader', 'claude').eq('status', 'armed').gt('expires_at', nowIso),
  ]);
  const currentConcurrent = (openTrades.count ?? 0) + (armedIdeas.count ?? 0);

  // Last 3 heartbeats for trend context.
  const { data: heartbeats } = await supabase
    .from('ct_heartbeats')
    .select('id, status_line, current_reads, created_at')
    .order('created_at', { ascending: false })
    .limit(3);

  const results: Array<{ hypothesis_id: string; outcome: string; reason?: string; idea_id?: string }> = [];
  const cooldownIso = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();

  for (const hyp of hyps as HypothesisRow[]) {
    // Cooldown — skip if we already armed something for this hypothesis recently.
    const { count: recentArmed } = await supabase
      .from('ct_trade_ideas')
      .select('id', { count: 'exact', head: true })
      .eq('hypothesis_id', hyp.id)
      .gte('armed_at', cooldownIso);
    if ((recentArmed ?? 0) > 0) {
      results.push({ hypothesis_id: hyp.id, outcome: 'cooldown' });
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'none',
        reasoning: `Cooldown: hypothesis armed a trade idea within last ${cooldownMinutes} min — skipping to avoid duplicate.`,
        outcome: 'cooldown',
        linked_hypothesis_id: hyp.id,
        context_snapshot: { cooldown_minutes: cooldownMinutes, hyp_confidence: hyp.confidence, hyp_elo: hyp.elo, tickers: hyp.tickers },
      });
      continue;
    }

    // Concurrent cap — count live ones (including any we just armed this run).
    const armedThisRun = results.filter((r) => r.outcome === 'armed').length;
    if (currentConcurrent + armedThisRun >= maxConcurrent) {
      results.push({ hypothesis_id: hyp.id, outcome: 'at_concurrent_cap' });
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'none',
        reasoning: `At concurrent position cap (${currentConcurrent + armedThisRun}/${maxConcurrent}) — no new arming.`,
        outcome: 'at_concurrent_cap',
        linked_hypothesis_id: hyp.id,
        context_snapshot: { current_concurrent: currentConcurrent, armed_this_run: armedThisRun, max_concurrent: maxConcurrent },
      });
      continue;
    }

    // Recent grades on this hypothesis (learning signal).
    const { data: grades } = await supabase
      .from('ct_grades')
      .select('verdict, actual_return_pct, graded_at, subject_type')
      .eq('hypothesis_id', hyp.id)
      .order('graded_at', { ascending: false })
      .limit(5);

    // Per-ticker quant cards — prefer cached snapshot; fall back to live RPC
    // build if the cache is stale or missing. One jsonb blob per hypothesis
    // ticker replaces what used to be ~6 separate queries.
    const quantCards: Record<string, TickerQuantCard | null> = {};
    for (const t of hyp.tickers ?? []) {
      const cached = await getCachedTickerSnapshot(supabase, t, 300);
      if (cached) {
        // The cached row already is the flattened quant card shape — rehydrate.
        quantCards[t.toUpperCase()] = {
          ticker: cached.ticker as string,
          as_of: (cached.snapshot_at as string) ?? new Date().toISOString(),
          structure: {
            spot:                    (cached.spot as number) ?? null,
            gamma_flip:              (cached.gamma_flip as number) ?? null,
            call_wall:               (cached.call_wall as number) ?? null,
            put_wall:                (cached.put_wall as number) ?? null,
            max_pain:                (cached.max_pain as number) ?? null,
            iv_rank:                 (cached.iv_rank as number) ?? null,
            iv_percentile:           (cached.iv_percentile as number) ?? null,
            net_gamma:               (cached.net_gamma as number) ?? null,
            regime:                  (cached.regime as TickerQuantCard['structure']['regime']) ?? 'neutral',
            latest_gex_snapshot_at:  (cached.snapshot_at as string) ?? null,
          },
          flow_last_hour:      (cached.flow_last_hour as TickerQuantCard['flow_last_hour'])      ?? { alert_count: 0, total_premium: 0, net_call_prem: 0, net_put_prem: 0, net_prem: 0, whale_count: 0, sweep_count: 0, opening_trades: 0 },
          dark_pool_last_hour: (cached.dark_pool_last_hour as TickerQuantCard['dark_pool_last_hour']) ?? { print_count: 0, total_notional: 0, largest_single: 0, accumulation_score: 0 },
          greek_flow_last_hour:(cached.greek_flow_last_hour as TickerQuantCard['greek_flow_last_hour']) ?? { net_delta_flow: 0, net_vega_flow: 0, net_call_delta: 0, net_put_delta: 0, tick_count: 0 },
          sentiment: {
            nope_latest:     (cached.nope_latest as number) ?? null,
            put_call_ratio:  (cached.put_call_ratio as number) ?? null,
            net_premium_cum: (cached.net_premium_cum as number) ?? 0,
          },
          events: {
            next_earnings_date:     (cached.next_earnings_date as string) ?? null,
            earnings_expected_move: (cached.earnings_expected_move as number) ?? null,
            upcoming_catalysts:     (cached.upcoming_catalysts as TickerQuantCard['events']['upcoming_catalysts']) ?? [],
          },
          news: (cached.recent_news as TickerQuantCard['news']) ?? [],
          brief: {
            source_brief_id: (cached.source_brief_id as string) ?? null,
            tilt:            (cached.brief_tilt as string) ?? null,
            avoid_today:     (cached.avoid_today as boolean) ?? false,
            focus_today:     false,
            session_date:    null,
          },
          freshness: {
            gex_snapshot_at:   (cached.snapshot_at as string) ?? null,
            seconds_stale_gex: null,
            as_of:             (cached.snapshot_at as string) ?? new Date().toISOString(),
          },
        };
      } else {
        quantCards[t.toUpperCase()] = await getTickerQuantCard(supabase, t);
      }
    }

    // Build user payload for Claude.
    const latest = (heartbeats?.[0] ?? null) as HeartbeatRow | null;
    const userPayload = {
      hypothesis: {
        id: hyp.id,
        claim: hyp.claim,
        because: hyp.because,
        invalidate_if: hyp.invalidate_if,
        horizon: hyp.horizon,
        confidence: hyp.confidence,
        elo: hyp.elo,
        tickers: hyp.tickers,
      },
      constraints: {
        max_size_pct: maxSizePct,
        allowed_horizons: Array.from(VALID_HORIZONS),
        allowed_trigger_types: Array.from(VALID_TRIGGER_TYPES),
      },
      latest_heartbeat: latest,
      recent_heartbeats: (heartbeats ?? []).slice(1),
      recent_grades_on_hypothesis: grades ?? [],
      quant_cards: quantCards,
    };

    let toolUse: { name: string; input: Record<string, unknown> } | null = null;
    let thisCallTokensIn = 0;
    let thisCallTokensOut = 0;
    let thisCallCost = 0;
    const callStart = Date.now();
    try {
      const res = await callClaude({
        model: CLAUDE_MODELS.haiku,
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(userPayload) }],
        tools: TOOLS,
        tool_choice: { type: 'any' },
        max_tokens: 1200,
        temperature: 0.3,
      });
      toolUse = parseToolUse(res);
      thisCallTokensIn = res.usage?.input_tokens ?? 0;
      thisCallTokensOut = res.usage?.output_tokens ?? 0;
      thisCallCost = calculateCost(CLAUDE_MODELS.haiku, res.usage ?? { input_tokens: 0, output_tokens: 0 });
      logClaudeUsage(supabase, {
        source: 'ct-trade-idea-generator',
        model: CLAUDE_MODELS.haiku,
        usage: res.usage,
        duration_ms: Date.now() - callStart,
        metadata: { hypothesis_id: hyp.id },
      });
    } catch (e) {
      const msg = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
      results.push({ hypothesis_id: hyp.id, outcome: 'claude_error', reason: msg });
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'haiku',
        reasoning: `Claude error evaluating hypothesis: ${msg}`,
        outcome: 'claude_error',
        linked_hypothesis_id: hyp.id,
        context_snapshot: { hyp_confidence: hyp.confidence, hyp_elo: hyp.elo, tickers: hyp.tickers },
      });
      continue;
    }

    // Shared decision context snapshot across all branches below.
    const decisionCtx: Record<string, unknown> = {
      hyp_claim: hyp.claim.slice(0, 500),
      hyp_confidence: hyp.confidence,
      hyp_elo: hyp.elo,
      hyp_tickers: hyp.tickers,
      hyp_horizon: hyp.horizon,
      recent_grades_count: (grades ?? []).length,
      recent_grades_summary: (grades ?? []).map((g) => g.verdict),
      latest_heartbeat_status: latest?.status_line ?? null,
    };

    if (!toolUse) {
      results.push({ hypothesis_id: hyp.id, outcome: 'no_tool_use' });
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'haiku',
        reasoning: 'Claude returned no tool use.',
        outcome: 'no_tool_use',
        linked_hypothesis_id: hyp.id,
        context_snapshot: decisionCtx,
        tokens_in: thisCallTokensIn,
        tokens_out: thisCallTokensOut,
        cost_usd: thisCallCost,
      });
      continue;
    }
    if (toolUse.name === 'no_trade') {
      const reason = typeof toolUse.input.reason === 'string' ? toolUse.input.reason : 'unstated';
      results.push({ hypothesis_id: hyp.id, outcome: 'no_trade', reason });
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'haiku',
        reasoning: `Claude chose no_trade: ${reason}`,
        outcome: 'no_trade',
        alignment: 'insufficient_data',
        narrative_signal: { reasoning: reason },
        tape_signal: { reasoning: latest?.status_line ?? 'no heartbeat' },
        linked_hypothesis_id: hyp.id,
        context_snapshot: decisionCtx,
        tool_calls_summary: { tool: 'no_trade', input: toolUse.input },
        tokens_in: thisCallTokensIn,
        tokens_out: thisCallTokensOut,
        cost_usd: thisCallCost,
      });
      continue;
    }
    if (toolUse.name !== 'propose_trade_idea') {
      results.push({ hypothesis_id: hyp.id, outcome: 'unknown_tool', reason: toolUse.name });
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'haiku',
        reasoning: `Unknown tool returned by Claude: ${toolUse.name}`,
        outcome: 'unknown_tool',
        linked_hypothesis_id: hyp.id,
        context_snapshot: decisionCtx,
        tool_calls_summary: { tool: toolUse.name, input: toolUse.input },
        tokens_in: thisCallTokensIn,
        tokens_out: thisCallTokensOut,
        cost_usd: thisCallCost,
      });
      continue;
    }

    const v = validateIdea(toolUse.input, hyp, maxSizePct);
    if (!v.ok) {
      results.push({ hypothesis_id: hyp.id, outcome: 'validation_failed', reason: v.reason });
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'haiku',
        reasoning: `Proposed idea failed validation: ${v.reason}`,
        outcome: 'validation_failed',
        linked_hypothesis_id: hyp.id,
        context_snapshot: decisionCtx,
        tool_calls_summary: { tool: 'propose_trade_idea', input: toolUse.input, validation_error: v.reason },
        tokens_in: thisCallTokensIn,
        tokens_out: thisCallTokensOut,
        cost_usd: thisCallCost,
      });
      continue;
    }
    const idea = v.idea;

    // -------------------------------------------------------------------------
    // Size-based Sonnet escalation. When Haiku's proposed size >= threshold
    // (default 2%), route to Sonnet for a risk review using the full quant
    // card. Sonnet can approve (use proposed size), modify (lower size — never
    // raise), or reject (skip the arm entirely). Sonnet errors fall back to
    // proceeding with the Haiku-approved size.
    // -------------------------------------------------------------------------
    let finalSizePct = idea.size_pct;
    let sonnetOutcome: SonnetReviewOutcome | null = null;
    if (idea.size_pct >= sizeEscalationPct) {
      sonnetOutcome = await runSonnetSizeReview(supabase, idea, hyp, quantCards);
      if (sonnetOutcome) {
        if (sonnetOutcome.decision === 'reject') {
          results.push({ hypothesis_id: hyp.id, outcome: 'size_override_reject', reason: sonnetOutcome.reasoning.slice(0, 200) });
          await recordDecision(supabase, {
            decision_type: 'size_override',
            model_tier: 'sonnet',
            reasoning: `Sonnet rejected Haiku-proposed trade at size ${idea.size_pct}%. ${sonnetOutcome.reasoning}`,
            outcome: 'rejected',
            linked_hypothesis_id: hyp.id,
            context_snapshot: {
              haiku_proposed_size_pct: idea.size_pct,
              escalation_threshold_pct: sizeEscalationPct,
              instrument: idea.instrument,
              direction: idea.direction,
              entry_trigger: idea.entry_trigger,
              quant_card_for_instrument: quantCards[idea.instrument] ?? null,
            },
            tool_calls_summary: { haiku_tool: 'propose_trade_idea', haiku_input: toolUse.input, sonnet_decision: 'size_reject' },
            tokens_in: sonnetOutcome.tokens_in,
            tokens_out: sonnetOutcome.tokens_out,
            cost_usd: sonnetOutcome.cost_usd,
          });
          continue;
        }
        if (sonnetOutcome.decision === 'modify' && sonnetOutcome.final_size_pct !== null) {
          finalSizePct = sonnetOutcome.final_size_pct;
          await recordDecision(supabase, {
            decision_type: 'size_override',
            model_tier: 'sonnet',
            reasoning: `Sonnet reduced size from ${idea.size_pct}% to ${finalSizePct}%. ${sonnetOutcome.reasoning}`,
            outcome: 'modified',
            linked_hypothesis_id: hyp.id,
            context_snapshot: {
              haiku_proposed_size_pct: idea.size_pct,
              sonnet_final_size_pct: finalSizePct,
              escalation_threshold_pct: sizeEscalationPct,
              instrument: idea.instrument,
              direction: idea.direction,
              quant_card_for_instrument: quantCards[idea.instrument] ?? null,
            },
            tool_calls_summary: { haiku_tool: 'propose_trade_idea', haiku_input: toolUse.input, sonnet_decision: 'size_modify' },
            tokens_in: sonnetOutcome.tokens_in,
            tokens_out: sonnetOutcome.tokens_out,
            cost_usd: sonnetOutcome.cost_usd,
          });
        }
        // decision === 'approve' → keep idea.size_pct, fall through without a size_override row.
      } else {
        // Sonnet errored: fail open — proceed with Haiku size, but log the miss.
        await recordDecision(supabase, {
          decision_type: 'size_override',
          model_tier: 'sonnet',
          reasoning: `Sonnet size review errored — proceeding with Haiku-proposed size ${idea.size_pct}%.`,
          outcome: 'review_unavailable',
          linked_hypothesis_id: hyp.id,
          context_snapshot: {
            haiku_proposed_size_pct: idea.size_pct,
            escalation_threshold_pct: sizeEscalationPct,
            instrument: idea.instrument,
          },
        });
      }
    }

    // Resolve entry price target = current spot for the instrument.
    const spot = await resolveSpot(supabase, idea.instrument);

    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();

    const { data: inserted, error: insErr } = await supabase
      .from('ct_trade_ideas')
      .insert({
        hypothesis_id:      hyp.id,
        trader:             'claude',
        instrument:         idea.instrument,
        contract_type:      idea.contract_type,
        strike:             idea.strike ?? null,
        expiry:             idea.expiry ?? null,
        direction:          idea.direction,
        entry_trigger:      idea.entry_trigger,
        entry_price_target: spot,
        stop_pct:           idea.stop_pct,
        target_pct:         idea.target_pct,
        size_pct:           finalSizePct,
        horizon:            idea.horizon,
        rationale:          idea.rationale,
        status:             'armed',
        armed_at:           new Date().toISOString(),
        expires_at:         expiresAt,
      })
      .select('id')
      .single();
    if (insErr || !inserted) {
      results.push({ hypothesis_id: hyp.id, outcome: 'insert_failed', reason: insErr?.message ?? 'no data' });
      await recordDecision(supabase, {
        decision_type: 'arm_trade_idea',
        model_tier: 'haiku',
        reasoning: `Claude armed a trade idea but insert failed: ${insErr?.message ?? 'no data'}`,
        outcome: 'insert_failed',
        linked_hypothesis_id: hyp.id,
        context_snapshot: { ...decisionCtx, idea },
        tool_calls_summary: { tool: 'propose_trade_idea', input: toolUse.input },
        tokens_in: thisCallTokensIn,
        tokens_out: thisCallTokensOut,
        cost_usd: thisCallCost,
      });
      continue;
    }

    // Evidence row: this hypothesis just armed a trade idea.
    await supabase.from('ct_hypothesis_evidence').insert({
      hypothesis_id: hyp.id,
      evidence_type: 'manual',
      polarity:      'for',
      weight:        0.3,
      summary:       `trade idea armed: ${idea.instrument} ${idea.direction}`,
      added_by:      'cron',
    });

    results.push({ hypothesis_id: hyp.id, outcome: 'armed', idea_id: inserted.id });

    // Decision journal — armed trade idea. Include abbreviated quant card
    // (instrument only) and Sonnet outcome if escalation fired.
    const abbreviatedQuantCard = quantCards[idea.instrument]
      ? {
          ticker: quantCards[idea.instrument]!.ticker,
          as_of: quantCards[idea.instrument]!.as_of,
          structure: quantCards[idea.instrument]!.structure,
          sentiment: quantCards[idea.instrument]!.sentiment,
          brief: quantCards[idea.instrument]!.brief,
          flow_net_prem: quantCards[idea.instrument]!.flow_last_hour?.net_prem ?? 0,
          events_next_earnings: quantCards[idea.instrument]!.events?.next_earnings_date ?? null,
        }
      : null;

    await recordDecision(supabase, {
      decision_type: 'arm_trade_idea',
      model_tier: sonnetOutcome ? 'sonnet' : 'haiku',
      reasoning: `Armed ${idea.instrument} ${idea.direction} ${idea.contract_type} size ${finalSizePct}% (haiku proposed ${idea.size_pct}%) stop ${idea.stop_pct}% target ${idea.target_pct}%. Rationale: ${idea.rationale}${sonnetOutcome ? ` | Sonnet: ${sonnetOutcome.decision} — ${sonnetOutcome.reasoning.slice(0, 300)}` : ''}`,
      outcome: 'armed',
      alignment: 'aligned',
      claude_followed: 'both',
      narrative_signal: {
        direction: idea.direction === 'long' ? 'bullish' : 'bearish',
        confidence: hyp.confidence,
        reasoning: hyp.claim.slice(0, 500),
        sources: ['ct_hypotheses.claim', 'ct_hypotheses.because'],
      },
      tape_signal: {
        direction: idea.direction === 'long' ? 'bullish' : 'bearish',
        reasoning: `trigger ${idea.entry_trigger.type} level ${idea.entry_trigger.level ?? idea.entry_trigger.time ?? '?'} vs current spot ${spot ?? '?'}`,
        sources: ['ct_heartbeats.current_reads', 'ct_ticker_snapshots'],
      },
      linked_hypothesis_id: hyp.id,
      linked_trade_idea_id: inserted.id,
      context_snapshot: {
        ...decisionCtx,
        spot,
        haiku_proposed_size_pct: idea.size_pct,
        final_size_pct: finalSizePct,
        escalated_to_sonnet: sonnetOutcome !== null,
        sonnet_decision: sonnetOutcome?.decision ?? null,
        entry_trigger: idea.entry_trigger,
        quant_card: abbreviatedQuantCard,
      },
      tool_calls_summary: { tool: 'propose_trade_idea', input: toolUse.input, sonnet: sonnetOutcome?.decision ?? null },
      tokens_in: thisCallTokensIn + (sonnetOutcome?.tokens_in ?? 0),
      tokens_out: thisCallTokensOut + (sonnetOutcome?.tokens_out ?? 0),
      cost_usd: thisCallCost + (sonnetOutcome?.cost_usd ?? 0),
    });
  }

  const armedCount = results.filter((r) => r.outcome === 'armed').length;
  const noTradeCount = results.filter((r) => r.outcome === 'no_trade').length;

  const body = {
    ok: true,
    eligible_hypotheses: hyps.length,
    armed: armedCount,
    no_trade_count: noTradeCount,
    current_concurrent_before_run: currentConcurrent,
    max_concurrent: maxConcurrent,
    results,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-trade-idea-generator]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
