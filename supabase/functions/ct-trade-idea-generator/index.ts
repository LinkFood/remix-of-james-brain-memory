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
import { callClaude, CLAUDE_MODELS, parseToolUse, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { getConfig } from '../_shared/configCache.ts';

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
Market state is attached: latest heartbeat, recent heartbeats for trend, and
your recent grades on this hypothesis (for learning).

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
  or skip entirely.`;

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

  // Config
  const minConfidence     = Number(await getConfig<number>('claude_min_hypothesis_confidence', 0.45));
  const maxSizePct        = Number(await getConfig<number>('claude_max_position_size_pct', 5));
  const maxConcurrent     = Number(await getConfig<number>('claude_max_concurrent_positions', 5));
  const ttlMinutes        = Number(await getConfig<number>('claude_trade_idea_ttl_minutes', 120));
  const cooldownMinutes   = Number(await getConfig<number>('claude_generator_cooldown_minutes', 5));

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
      continue;
    }

    // Concurrent cap — count live ones (including any we just armed this run).
    const armedThisRun = results.filter((r) => r.outcome === 'armed').length;
    if (currentConcurrent + armedThisRun >= maxConcurrent) {
      results.push({ hypothesis_id: hyp.id, outcome: 'at_concurrent_cap' });
      continue;
    }

    // Recent grades on this hypothesis (learning signal).
    const { data: grades } = await supabase
      .from('ct_grades')
      .select('verdict, actual_return_pct, graded_at, subject_type')
      .eq('hypothesis_id', hyp.id)
      .order('graded_at', { ascending: false })
      .limit(5);

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
    };

    let toolUse: { name: string; input: Record<string, unknown> } | null = null;
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
      continue;
    }

    if (!toolUse) {
      results.push({ hypothesis_id: hyp.id, outcome: 'no_tool_use' });
      continue;
    }
    if (toolUse.name === 'no_trade') {
      const reason = typeof toolUse.input.reason === 'string' ? toolUse.input.reason : 'unstated';
      results.push({ hypothesis_id: hyp.id, outcome: 'no_trade', reason });
      continue;
    }
    if (toolUse.name !== 'propose_trade_idea') {
      results.push({ hypothesis_id: hyp.id, outcome: 'unknown_tool', reason: toolUse.name });
      continue;
    }

    const v = validateIdea(toolUse.input, hyp, maxSizePct);
    if (!v.ok) {
      results.push({ hypothesis_id: hyp.id, outcome: 'validation_failed', reason: v.reason });
      continue;
    }
    const idea = v.idea;

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
        size_pct:           idea.size_pct,
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
