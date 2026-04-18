/**
 * ct-trade-advisories — advisory (non-executing) recommendations per open
 * position. Every 15min during RTH, offset 7min from ct-book-manager
 * (cron: 7,22,37,52 13-20 * * 1-5).
 *
 * For each open ct_trades row:
 *   1. Pull current live_pnl + book-manager's last action for that trade.
 *   2. Pull heartbeat status, recent attention hits, most recent expected_move
 *      for that instrument.
 *   3. Ask Haiku: "would you do anything different now?"
 *   4. INSERT one ct_trade_advisories row per trade.
 *   5. Dedupe: if the last advisory for this trade has the same
 *      (advisory_type, urgency) and landed within 15min, skip the INSERT
 *      entirely (never spam the sidebar).
 *   6. Slack push at urgency >= 4 via ctSlackPushDirect (no dedupe — James
 *      asked for high-urgency signals to come through).
 *
 * Does NOT execute. Does NOT close. Does NOT size. Text only.
 *
 * Kill switch: respected at entry. Skipped tick logs a heartbeat.
 * Auth: service role only (cron caller).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { TRADE_ADVISORY_SYSTEM } from '../_shared/ctPrompts.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

type AdvisoryType =
  | 'hold'
  | 'tighten_stop'
  | 'trail'
  | 'cut'
  | 'scale_out'
  | 'flip_consider';

const VALID_TYPES: ReadonlySet<AdvisoryType> = new Set([
  'hold','tighten_stop','trail','cut','scale_out','flip_consider',
]);

// Dedupe window: if the last advisory for this trade has the same
// (advisory_type, urgency) and landed within this many ms, skip.
const DEDUPE_WINDOW_MS = 15 * 60_000;

// Slack push threshold. >= this urgency triggers a push.
const SLACK_URGENCY_THRESHOLD = 4;

interface OpenTrade {
  id: string;
  instrument: string;
  side: 'long' | 'short';
  entry_price: number;
  stop_price: number | null;
  target_price: number | null;
  thesis: string | null;
  opened_at: string | null;
  live_pnl_pct: number | null;
  contract_type: string | null;
}

interface AdvisoryOut {
  trade_id: string;
  advisory_type: AdvisoryType;
  urgency: number;
  reasoning: string;
}

interface LastAction {
  action: string;
  rationale: string | null;
  created_at: string;
}

interface HeartbeatRow {
  id: string;
  status_line: string | null;
  created_at: string;
}

interface AttentionHit {
  kind: string;
  id: string;
  created_at: string;
  attention_score: number | null;
  summary: string | null;
}

interface ExpectedMoveSnapshot {
  expected_move: Record<string, unknown> | null;
  source: 'flag' | 'alert';
  created_at: string;
}

async function loadLastAction(
  supabase: SupabaseClient,
  tradeId: string,
): Promise<LastAction | null> {
  const { data } = await supabase
    .from('ct_trade_actions')
    .select('action, rationale, created_at')
    .eq('trade_id', tradeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    action: data.action as string,
    rationale: (data.rationale as string | null) ?? null,
    created_at: data.created_at as string,
  };
}

async function loadRecentAttentionForInstrument(
  supabase: SupabaseClient,
  instrument: string,
): Promise<AttentionHit[]> {
  // ct_attention_stream is a view — filter by summary ilike instrument.
  // Not perfect (summary text matching), but the view doesn't carry per-
  // instrument columns. Budget: last 30min.
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const needle = `%${instrument.toUpperCase()}%`;
  const { data } = await supabase
    .from('ct_attention_stream')
    .select('kind, id, created_at, attention_score, summary')
    .gte('created_at', cutoff)
    .ilike('summary', needle)
    .order('attention_score', { ascending: false })
    .limit(5);
  return (data ?? []) as AttentionHit[];
}

async function loadExpectedMoveForInstrument(
  supabase: SupabaseClient,
  instrument: string,
): Promise<ExpectedMoveSnapshot | null> {
  // Prefer the most recent flag; fall back to most recent alert.
  const flagQ = supabase
    .from('ct_flags')
    .select('expected_move, created_at, instruments')
    .contains('instruments', [instrument])
    .not('expected_move', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const alertQ = supabase
    .from('ct_alerts')
    .select('expected_move, created_at, instruments')
    .contains('instruments', [instrument])
    .not('expected_move', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const [flag, alert] = await Promise.all([flagQ, alertQ]);

  const flagRow = flag.data as { expected_move: Record<string, unknown> | null; created_at: string } | null;
  const alertRow = alert.data as { expected_move: Record<string, unknown> | null; created_at: string } | null;

  const candidates: ExpectedMoveSnapshot[] = [];
  if (flagRow && flagRow.expected_move) {
    candidates.push({ expected_move: flagRow.expected_move, source: 'flag', created_at: flagRow.created_at });
  }
  if (alertRow && alertRow.expected_move) {
    candidates.push({ expected_move: alertRow.expected_move, source: 'alert', created_at: alertRow.created_at });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return candidates[0];
}

/**
 * Check the last advisory for this trade. If it matches (advisory_type, urgency)
 * and is newer than DEDUPE_WINDOW_MS ago, skip the INSERT to prevent spam.
 */
async function shouldDedupe(
  supabase: SupabaseClient,
  tradeId: string,
  candidate: AdvisoryOut,
): Promise<boolean> {
  const { data } = await supabase
    .from('ct_trade_advisories')
    .select('advisory_type, urgency, created_at')
    .eq('trade_id', tradeId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return false;
  const last = data as { advisory_type: string; urgency: number; created_at: string };
  const ageMs = Date.now() - new Date(last.created_at).getTime();
  if (ageMs >= DEDUPE_WINDOW_MS) return false;
  return last.advisory_type === candidate.advisory_type && last.urgency === candidate.urgency;
}

function urgencyEmoji(urgency: number): string {
  if (urgency >= 5) return ':rotating_light:';
  if (urgency >= 4) return ':zap:';
  if (urgency >= 3) return ':warning:';
  return ':information_source:';
}

async function pushSlackIfUrgent(
  supabase: SupabaseClient,
  trade: OpenTrade,
  advisory: AdvisoryOut,
): Promise<void> {
  if (advisory.urgency < SLACK_URGENCY_THRESHOLD) return;

  // Single-user system — pull the one profile row for Slack channel lookup.
  const { data: profile } = await supabase
    .from('profiles')
    .select('id')
    .limit(1)
    .maybeSingle();
  if (!profile?.id) return;

  const emoji = urgencyEmoji(advisory.urgency);
  const verb = advisory.advisory_type.replace(/_/g, ' ');
  const header = `${emoji} *${trade.instrument} ${trade.side} advisory: ${verb}* · urgency ${advisory.urgency}/5`;
  const body = advisory.reasoning;
  const text = `${header}\n${body}`;

  await ctSlackPushDirect(supabase, profile.id as string, text, 'ct-trade-advisories');
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-trade-advisories', corsHeaders);
  }

  const sessionDate = new Date().toISOString().slice(0, 10);

  // Pull the open book for today.
  const { data: openRows, error: openErr } = await supabase
    .from('ct_trades')
    .select('id, instrument, side, entry_price, stop_price, target_price, thesis, opened_at, live_pnl_pct, contract_type')
    .eq('session_date', sessionDate)
    .eq('status', 'open');

  if (openErr) {
    return new Response(JSON.stringify({ error: openErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const open = (openRows ?? []) as OpenTrade[];
  if (open.length === 0) {
    return new Response(JSON.stringify({ ok: true, open: 0, note: 'no live trades' }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Fetch the latest heartbeat once; all trades share it.
  const { data: hb } = await supabase
    .from('ct_heartbeats')
    .select('id, status_line, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const heartbeat = hb as HeartbeatRow | null;

  // Per-trade context fan-out.
  const contexts = await Promise.all(open.map(async (t) => {
    const [lastAction, attention, expectedMove] = await Promise.all([
      loadLastAction(supabase, t.id),
      loadRecentAttentionForInstrument(supabase, t.instrument),
      loadExpectedMoveForInstrument(supabase, t.instrument),
    ]);
    return { trade: t, lastAction, attention, expectedMove };
  }));

  // Build the user payload for Claude.
  const payload = {
    open_trades: contexts.map(c => ({
      trade_id: c.trade.id,
      instrument: c.trade.instrument,
      side: c.trade.side,
      entry_price: c.trade.entry_price,
      current_unrealized_pct: c.trade.live_pnl_pct,
      stop_price: c.trade.stop_price,
      target_price: c.trade.target_price,
      thesis: c.trade.thesis,
      opened_at: c.trade.opened_at,
      contract_type: c.trade.contract_type,
      last_book_manager_action: c.lastAction ? {
        action: c.lastAction.action,
        rationale: c.lastAction.rationale,
        at: c.lastAction.created_at,
      } : null,
      heartbeat_status_line: heartbeat?.status_line ?? null,
      recent_attention: c.attention,
      expected_move: c.expectedMove,
    })),
    note: 'Return ONE advisory per trade_id per the system schema. Return ONLY the JSON.',
  };

  let claudeText = '';
  let usage: { input_tokens?: number | null; output_tokens?: number | null } | null = null;
  const started = Date.now();
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: TRADE_ADVISORY_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
      max_tokens: 1200,
      temperature: 0.1,
    });
    claudeText = parseTextContent(res);
    usage = (res.usage ?? null) as typeof usage;
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Log usage (fire-and-forget).
  logClaudeUsage(supabase, {
    source: 'trade-advisories',
    model: CLAUDE_MODELS.haiku,
    usage,
    duration_ms: Date.now() - started,
    metadata: { open_count: open.length, session_date: sessionDate },
  });

  const cleaned = claudeText.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
  let parsed: { advisories?: AdvisoryOut[] };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return new Response(JSON.stringify({ error: 'invalid json', raw: claudeText.slice(0, 300) }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const advisories = Array.isArray(parsed.advisories) ? parsed.advisories : [];

  let written = 0;
  let deduped = 0;
  let slackPushed = 0;
  let invalid = 0;

  for (const a of advisories) {
    // Schema validation — Haiku has been known to freelance.
    if (!a || typeof a !== 'object') { invalid++; continue; }
    if (typeof a.trade_id !== 'string') { invalid++; continue; }
    if (!VALID_TYPES.has(a.advisory_type)) { invalid++; continue; }
    if (typeof a.urgency !== 'number' || a.urgency < 1 || a.urgency > 5) { invalid++; continue; }
    if (typeof a.reasoning !== 'string' || a.reasoning.trim().length === 0) { invalid++; continue; }

    const ctx = contexts.find(c => c.trade.id === a.trade_id);
    if (!ctx) { invalid++; continue; }

    if (await shouldDedupe(supabase, a.trade_id, a)) {
      deduped++;
      continue;
    }

    const readContext = {
      heartbeat_id: heartbeat?.id ?? null,
      heartbeat_status_line: heartbeat?.status_line ?? null,
      recent_attention: ctx.attention,
      expected_move: ctx.expectedMove,
      book_manager_last_action: ctx.lastAction,
    };

    const { error: insErr } = await supabase
      .from('ct_trade_advisories')
      .insert({
        trade_id: a.trade_id,
        advisory_type: a.advisory_type,
        urgency: Math.round(a.urgency),
        reasoning: a.reasoning.trim(),
        current_unrealized_pct: ctx.trade.live_pnl_pct,
        claude_read_context: readContext,
      });
    if (insErr) {
      console.warn('[ct-trade-advisories] insert failed:', insErr.message);
      continue;
    }
    written++;

    // Slack push for high-urgency advisories. Best-effort, never throws.
    try {
      await pushSlackIfUrgent(supabase, ctx.trade, a);
      if (a.urgency >= SLACK_URGENCY_THRESHOLD) slackPushed++;
    } catch (e) {
      console.warn('[ct-trade-advisories] slack push failed (non-blocking):', e instanceof Error ? e.message : e);
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    reviewed: open.length,
    written,
    deduped,
    slack_pushed: slackPushed,
    invalid,
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
