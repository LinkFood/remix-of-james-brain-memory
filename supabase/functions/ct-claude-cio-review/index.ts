/**
 * ct-claude-cio-review — Phase 2 Wave J.
 *
 * The CIO tier of Claude's model hierarchy (Co-Trader Thesis, Tenet 8).
 * Runs Sunday 22:00 UTC (6pm ET) via pg_cron. Uses Claude Opus 4.7 — the
 * deepest model, the weekly cadence, meta-analysis only.
 *
 * Charter:
 *   - Don't re-trade last week. Extract what changed about HOW you trade.
 *   - Look at principles that aged well or poorly, biases that did or didn't
 *     apply, hypotheses where the algorithmic Elo update was obviously wrong,
 *     macro regime for next week, and whether the meta-system itself drifted.
 *
 * Available tools (forced tool-use, multi-call — Claude may invoke any subset):
 *   - refine_principle(principle_id, new_text, new_strength, reason)
 *   - create_principle(principle_text, domain, derivation, strength)
 *   - adjust_hypothesis_elo(hypothesis_id, new_elo, reason)
 *   - deprecate_bias(bias_id, reason)
 *   - create_bias(pattern, description, domain)
 *   - set_next_week_tilt(macro_regime, focus_tickers, avoid_tickers, tactical_notes)
 *   - flag_drift(component, severity, description)
 *
 * Budget guardrail: if usage.input_tokens * input_rate + usage.output_tokens *
 * output_rate > $10, skip the tool effects, log the overage, and exit.
 *
 * Auth: service role only. Called by pg_cron.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import {
  callClaude,
  CLAUDE_MODELS,
  ClaudeError,
  calculateCost,
} from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import {
  buildClaudeContext,
  claudeSystemPromptPreamble,
} from '../_shared/claudeReadSurface.ts';

const WEEK_MS = 7 * 24 * 3600 * 1000;
const COST_GUARDRAIL_USD = 10;

// ---------------------------------------------------------------------------
// Tool schemas
// ---------------------------------------------------------------------------
const REFINE_PRINCIPLE_TOOL = {
  name: 'refine_principle',
  description: 'Update an existing active principle. Use when a week\'s data sharpens or weakens the statement.',
  input_schema: {
    type: 'object',
    required: ['principle_id', 'new_text', 'new_strength', 'reason'],
    properties: {
      principle_id:  { type: 'string' },
      new_text:      { type: 'string', description: 'The refined principle statement.' },
      new_strength:  { type: 'number', minimum: 0, maximum: 1 },
      reason:        { type: 'string', description: 'Why this refinement — cite grades/trades from this week.' },
    },
  },
} as const;

const CREATE_PRINCIPLE_TOOL = {
  name: 'create_principle',
  description: 'Create a new principle when this week produced a clear, repeatable insight not covered by an existing one.',
  input_schema: {
    type: 'object',
    required: ['principle_text', 'domain', 'derivation', 'strength'],
    properties: {
      principle_text: { type: 'string' },
      domain:         { type: 'string', description: "'execution' | 'psychology' | 'vol' | 'flow' | 'macro' | etc." },
      derivation:     { type: 'string', description: 'How this was derived — reference grades / trades / decisions.' },
      strength:       { type: 'number', minimum: 0, maximum: 1 },
    },
  },
} as const;

const ADJUST_HYPOTHESIS_ELO_TOOL = {
  name: 'adjust_hypothesis_elo',
  description: 'Override the algorithmic Elo on a hypothesis. Use only when the automated update was obviously wrong (e.g. one lucky grade inflated a bad hypothesis).',
  input_schema: {
    type: 'object',
    required: ['hypothesis_id', 'new_elo', 'reason'],
    properties: {
      hypothesis_id: { type: 'string' },
      new_elo:       { type: 'integer', minimum: 800, maximum: 2400 },
      reason:        { type: 'string' },
    },
  },
} as const;

const DEPRECATE_BIAS_TOOL = {
  name: 'deprecate_bias',
  description: 'Mark a bias as no longer active — the pattern has not recurred in recent data.',
  input_schema: {
    type: 'object',
    required: ['bias_id', 'reason'],
    properties: {
      bias_id: { type: 'string' },
      reason:  { type: 'string' },
    },
  },
} as const;

const CREATE_BIAS_TOOL = {
  name: 'create_bias',
  description: 'Record a newly-detected systematic bias — a pattern Claude was repeatedly wrong about this week.',
  input_schema: {
    type: 'object',
    required: ['pattern', 'description'],
    properties: {
      pattern:     { type: 'string', description: 'Short label, e.g. "overweight put flow in low-VIX tape".' },
      description: { type: 'string', description: 'Evidence — which grades / trades exhibited this pattern.' },
      domain:      { type: 'string', description: "Optional tag: 'vol' | 'flow' | 'macro' | ..." },
      severity:    { type: 'integer', minimum: 1, maximum: 5 },
      instruments: { type: 'array', items: { type: 'string' }, description: 'Optional ticker scope.' },
    },
  },
} as const;

const SET_NEXT_WEEK_TILT_TOOL = {
  name: 'set_next_week_tilt',
  description: 'Emit the next-week tilt. Call AT MOST ONCE. These fields land on the ct_weekly_reviews row and downstream Monday morning context.',
  input_schema: {
    type: 'object',
    required: ['macro_regime', 'focus_tickers', 'avoid_tickers', 'tactical_notes'],
    properties: {
      macro_regime:   { type: 'string', description: "'risk-off' | 'risk-on' | 'chop' | 'pre-fed' | 'vol-expansion' | etc." },
      focus_tickers:  { type: 'array', items: { type: 'string' }, description: 'Tickers to lean into next week.' },
      avoid_tickers:  { type: 'array', items: { type: 'string' }, description: 'Tickers to avoid next week.' },
      tactical_notes: { type: 'string', description: 'One paragraph that gets quoted into Monday\'s daily brief context.' },
    },
  },
} as const;

const FLAG_DRIFT_TOOL = {
  name: 'flag_drift',
  description: 'Flag a drift or anomaly in the meta-system itself — stale data, broken ingester, missing feedback loop. Reviewed by operator.',
  input_schema: {
    type: 'object',
    required: ['component', 'severity', 'description'],
    properties: {
      component:   { type: 'string', description: "Which part of the system, e.g. 'hypothesis_elo_updater' | 'grader' | 'brief_generator'." },
      severity:    { type: 'integer', minimum: 1, maximum: 5 },
      description: { type: 'string' },
    },
  },
} as const;

const CIO_TOOLS = [
  REFINE_PRINCIPLE_TOOL,
  CREATE_PRINCIPLE_TOOL,
  ADJUST_HYPOTHESIS_ELO_TOOL,
  DEPRECATE_BIAS_TOOL,
  CREATE_BIAS_TOOL,
  SET_NEXT_WEEK_TILT_TOOL,
  FLAG_DRIFT_TOOL,
] as const;

// ---------------------------------------------------------------------------
// Context pulls — full week of CIO-tier inputs.
// ---------------------------------------------------------------------------
async function pullWeek(supabase: SupabaseClient) {
  const sinceIso = new Date(Date.now() - WEEK_MS).toISOString();

  const [
    { data: trades },
    { data: grades },
    { data: decisions },
    { data: briefs },
    { data: dreams },
    { data: hypotheses },
    { data: principles },
    { data: biases },
    { data: breakingNews },
    { data: bookCurve },
  ] = await Promise.all([
    supabase
      .from('ct_trades')
      .select('id, instrument, side, size_pct, entry_price, close_price, thesis, status, realized_pnl_pct, realized_pnl_usd, opened_at, closed_at, hypothesis_id, conviction')
      .eq('trader', 'claude')
      .gte('opened_at', sinceIso)
      .order('opened_at', { ascending: false })
      .limit(200),
    supabase
      .from('ct_grades')
      .select('id, subject_type, instrument, claimed_direction, actual_direction, actual_return_pct, verdict, notes, hypothesis_id, graded_at')
      .gte('graded_at', sinceIso)
      .order('graded_at', { ascending: false })
      .limit(200),
    supabase
      .from('ct_claude_decisions')
      .select('id, decision_type, model_tier, alignment, claude_followed, outcome, created_at, cost_usd')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(500),
    supabase
      .from('ct_daily_briefs')
      .select('id, session_date, brief_version, urgency, macro_regime, accuracy_score, accuracy_notes, convergent_view, high_conviction_ideas, triggered_by, generated_by_model')
      .gte('session_date', sinceIso.slice(0, 10))
      .order('session_date', { ascending: false })
      .order('brief_version', { ascending: false })
      .limit(40),
    supabase
      .from('ct_dreams')
      .select('id, session_date, reflection, patterns_noticed, tomorrow_hypotheses, created_at')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('ct_hypotheses')
      .select('id, claim, because, invalidate_if, horizon, tickers, confidence, elo, status, last_tested_at, created_at, updated_at')
      .in('status', ['open', 'supported', 'refuted', 'zombie'])
      .order('elo', { ascending: false })
      .limit(60),
    supabase
      .from('ct_principles')
      .select('id, principle, domain, strength, status, support_count, refute_count, last_tested_at, created_at')
      .eq('trader', 'claude')
      .eq('status', 'active')
      .order('strength', { ascending: false })
      .limit(60),
    supabase
      .from('ct_biases')
      .select('id, pattern, evidence, severity, instruments, active, observed_count, last_confirmed, first_seen_at')
      .eq('active', true)
      .order('severity', { ascending: false })
      .order('last_confirmed', { ascending: false })
      .limit(40),
    supabase
      .from('ct_breaking_news')
      .select('id, headline, severity, sentiment, tickers_affected, macro_wide, category, summary, ingested_at')
      .gte('ingested_at', sinceIso)
      .gte('severity', 4)
      .order('severity', { ascending: false })
      .order('ingested_at', { ascending: false })
      .limit(40),
    supabase
      .from('ct_book')
      .select('session_date, starting_balance, ending_balance, realized_pnl, realized_pnl_pct, trades_count, wins, losses, max_drawdown_pct, goal_hit')
      .gte('session_date', sinceIso.slice(0, 10))
      .order('session_date', { ascending: true })
      .limit(14),
  ]);

  // Compress decisions into counts + samples per decision_type.
  const byType: Record<string, { count: number; samples: Record<string, unknown>[] }> = {};
  for (const d of decisions ?? []) {
    const key = String(d.decision_type);
    if (!byType[key]) byType[key] = { count: 0, samples: [] };
    byType[key].count += 1;
    if (byType[key].samples.length < 3) {
      byType[key].samples.push({
        id: d.id,
        alignment: d.alignment,
        claude_followed: d.claude_followed,
        outcome: d.outcome,
        created_at: d.created_at,
      });
    }
  }

  return {
    trades: trades ?? [],
    grades: grades ?? [],
    decisionsCompressed: byType,
    decisionsTotal: (decisions ?? []).length,
    briefs: briefs ?? [],
    dreams: dreams ?? [],
    hypotheses: hypotheses ?? [],
    principles: principles ?? [],
    biases: biases ?? [],
    breakingNews: breakingNews ?? [],
    bookCurve: bookCurve ?? [],
  };
}

function mostRecentFriday(now = new Date()): string {
  // Returns ISO date of the most recent Friday (or today if today is Fri).
  const d = new Date(now);
  // getUTCDay: 0=Sun..6=Sat. Friday=5.
  while (d.getUTCDay() !== 5) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Tool application — idempotent, best-effort. Never throws.
// ---------------------------------------------------------------------------
interface ToolCall { name: string; input: Record<string, unknown>; }

interface ApplyResults {
  principles_refined_count: number;
  principles_created_count: number;
  biases_affected_count: number;
  hypothesis_elo_adjustments: Array<{ hypothesis_id: string; old_elo: number; new_elo: number; reason: string }>;
  drift_flags: Array<{ component: string; severity: number; description: string }>;
  tilt: {
    macro_regime: string | null;
    focus_tickers: string[];
    avoid_tickers: string[];
    tactical_notes: string | null;
  };
  errors: string[];
}

async function applyToolCalls(
  supabase: SupabaseClient,
  calls: ToolCall[],
): Promise<ApplyResults> {
  const res: ApplyResults = {
    principles_refined_count: 0,
    principles_created_count: 0,
    biases_affected_count: 0,
    hypothesis_elo_adjustments: [],
    drift_flags: [],
    tilt: { macro_regime: null, focus_tickers: [], avoid_tickers: [], tactical_notes: null },
    errors: [],
  };

  for (const c of calls) {
    try {
      switch (c.name) {
        case 'refine_principle': {
          const pid = String(c.input.principle_id ?? '');
          const newText = String(c.input.new_text ?? '').slice(0, 2000);
          const newStrength = Math.max(0, Math.min(1, Number(c.input.new_strength ?? 0.5)));
          if (!pid || !newText) break;
          const { error } = await supabase
            .from('ct_principles')
            .update({
              principle: newText,
              strength: newStrength,
              last_tested_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', pid)
            .eq('trader', 'claude');
          if (error) res.errors.push(`refine_principle(${pid}): ${error.message}`);
          else res.principles_refined_count += 1;
          break;
        }
        case 'create_principle': {
          const text = String(c.input.principle_text ?? '').slice(0, 2000);
          const domain = c.input.domain != null ? String(c.input.domain).slice(0, 60) : null;
          const derivation = c.input.derivation != null ? String(c.input.derivation).slice(0, 4000) : null;
          const strength = Math.max(0, Math.min(1, Number(c.input.strength ?? 0.5)));
          if (!text) break;
          const { error } = await supabase
            .from('ct_principles')
            .insert({
              trader: 'claude',
              principle: text,
              domain,
              derivation,
              strength,
              status: 'active',
              last_tested_at: new Date().toISOString(),
            });
          if (error) res.errors.push(`create_principle: ${error.message}`);
          else res.principles_created_count += 1;
          break;
        }
        case 'adjust_hypothesis_elo': {
          const hid = String(c.input.hypothesis_id ?? '');
          const newElo = Math.max(800, Math.min(2400, Math.round(Number(c.input.new_elo ?? 1500))));
          const reason = String(c.input.reason ?? '').slice(0, 1000);
          if (!hid) break;
          // Fetch old elo for audit trail.
          const { data: prior } = await supabase
            .from('ct_hypotheses')
            .select('elo')
            .eq('id', hid)
            .maybeSingle();
          const oldElo = Number(prior?.elo ?? 1500);
          const { error } = await supabase
            .from('ct_hypotheses')
            .update({ elo: newElo, last_edited_by: 'cio_opus' })
            .eq('id', hid);
          if (error) {
            res.errors.push(`adjust_hypothesis_elo(${hid}): ${error.message}`);
          } else {
            res.hypothesis_elo_adjustments.push({ hypothesis_id: hid, old_elo: oldElo, new_elo: newElo, reason });
            // Audit as hypothesis_event (best-effort).
            try {
              await supabase.from('ct_hypothesis_events').insert({
                hypothesis_id: hid,
                event_type: 'elo_override',
                reason: `CIO Opus override: ${reason}`,
                created_by: 'claude',
              });
            } catch { /* table may not have 'elo_override' enum value — skip */ }
          }
          break;
        }
        case 'deprecate_bias': {
          const bid = String(c.input.bias_id ?? '');
          const reason = String(c.input.reason ?? '').slice(0, 1000);
          if (!bid) break;
          const { error } = await supabase
            .from('ct_biases')
            .update({ active: false, last_confirmed: new Date().toISOString() })
            .eq('id', bid);
          if (error) {
            res.errors.push(`deprecate_bias(${bid}): ${error.message}`);
          } else {
            res.biases_affected_count += 1;
            // Best-effort audit — append reason to evidence field.
            try {
              await supabase
                .from('ct_biases')
                .update({ evidence: `DEPRECATED by CIO Opus: ${reason}` })
                .eq('id', bid);
            } catch { /* non-blocking */ }
          }
          break;
        }
        case 'create_bias': {
          const pattern = String(c.input.pattern ?? '').slice(0, 500);
          const description = String(c.input.description ?? '').slice(0, 4000);
          const severity = Math.max(1, Math.min(5, Math.round(Number(c.input.severity ?? 3))));
          const instrumentsRaw = c.input.instruments;
          const instruments = Array.isArray(instrumentsRaw)
            ? instrumentsRaw.map((x) => String(x)).filter((x) => x.length > 0 && x.length <= 12)
            : null;
          if (!pattern || !description) break;
          const { error } = await supabase
            .from('ct_biases')
            .insert({
              pattern,
              evidence: description,
              severity,
              instruments,
              active: true,
            });
          if (error) res.errors.push(`create_bias: ${error.message}`);
          else res.biases_affected_count += 1;
          break;
        }
        case 'set_next_week_tilt': {
          const regime = c.input.macro_regime != null ? String(c.input.macro_regime).slice(0, 60) : null;
          const focusRaw = c.input.focus_tickers;
          const avoidRaw = c.input.avoid_tickers;
          const notes = c.input.tactical_notes != null ? String(c.input.tactical_notes).slice(0, 4000) : null;
          const focus = Array.isArray(focusRaw)
            ? focusRaw.map((x) => String(x).toUpperCase()).filter((x) => x.length > 0 && x.length <= 12)
            : [];
          const avoid = Array.isArray(avoidRaw)
            ? avoidRaw.map((x) => String(x).toUpperCase()).filter((x) => x.length > 0 && x.length <= 12)
            : [];
          res.tilt = { macro_regime: regime, focus_tickers: focus, avoid_tickers: avoid, tactical_notes: notes };
          break;
        }
        case 'flag_drift': {
          const component = String(c.input.component ?? '').slice(0, 120);
          const severity = Math.max(1, Math.min(5, Math.round(Number(c.input.severity ?? 3))));
          const description = String(c.input.description ?? '').slice(0, 2000);
          if (!component || !description) break;
          res.drift_flags.push({ component, severity, description });
          break;
        }
        default:
          res.errors.push(`unknown tool: ${c.name}`);
      }
    } catch (e) {
      res.errors.push(`${c.name} threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return res;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  try {
    // ------- CONTEXT -------
    const [ctx, week] = await Promise.all([
      buildClaudeContext(supabase, {
        heartbeatLimit: 1,
        openHypothesisLimit: 40,
        hypothesisEventLimit: 40,
        closedTradeLimit: 30,
        gradeLimit: 30,
        principleLimit: 40,
        biasLimit: 30,
      }),
      pullWeek(supabase),
    ]);

    const weekEnding = mostRecentFriday();

    // Compact payload — stay bounded. Opus 1M-context capacity is large but
    // the guardrail is $10/run, so trim aggressively.
    const contextPayload = {
      week_ending_date: weekEnding,
      watchlist: ctx.watchlist,
      current_balance: ctx.currentBalance,
      starting_balance: ctx.paperStartingBalance,

      book_curve: week.bookCurve,
      trades: week.trades.map((t: Record<string, unknown>) => ({
        id: t.id,
        instrument: t.instrument,
        side: t.side,
        size_pct: t.size_pct,
        entry_price: t.entry_price,
        close_price: t.close_price,
        status: t.status,
        realized_pnl_pct: t.realized_pnl_pct,
        realized_pnl_usd: t.realized_pnl_usd,
        conviction: t.conviction,
        hypothesis_id: t.hypothesis_id,
        thesis: typeof t.thesis === 'string' ? (t.thesis as string).slice(0, 400) : null,
        opened_at: t.opened_at,
        closed_at: t.closed_at,
      })),

      grades: week.grades.map((g: Record<string, unknown>) => ({
        id: g.id,
        subject_type: g.subject_type,
        instrument: g.instrument,
        claimed_direction: g.claimed_direction,
        actual_direction: g.actual_direction,
        actual_return_pct: g.actual_return_pct,
        verdict: g.verdict,
        hypothesis_id: g.hypothesis_id,
        notes: typeof g.notes === 'string' ? (g.notes as string).slice(0, 300) : null,
        graded_at: g.graded_at,
      })),

      decisions_compressed: {
        total_count: week.decisionsTotal,
        by_type: week.decisionsCompressed,
      },

      briefs: week.briefs.map((b: Record<string, unknown>) => ({
        id: b.id,
        session_date: b.session_date,
        brief_version: b.brief_version,
        urgency: b.urgency,
        macro_regime: b.macro_regime,
        accuracy_score: b.accuracy_score,
        accuracy_notes: typeof b.accuracy_notes === 'string' ? (b.accuracy_notes as string).slice(0, 400) : null,
        convergent_view: typeof b.convergent_view === 'string' ? (b.convergent_view as string).slice(0, 600) : null,
        high_conviction_ideas_count: Array.isArray(b.high_conviction_ideas) ? (b.high_conviction_ideas as unknown[]).length : 0,
        triggered_by: b.triggered_by,
      })),

      dreams: week.dreams.map((d: Record<string, unknown>) => ({
        id: d.id,
        session_date: d.session_date,
        reflection: typeof d.reflection === 'string' ? (d.reflection as string).slice(0, 1200) : '',
        patterns_noticed: d.patterns_noticed,
        tomorrow_hypotheses: d.tomorrow_hypotheses,
      })),

      hypotheses: week.hypotheses.map((h: Record<string, unknown>) => ({
        id: h.id,
        claim: typeof h.claim === 'string' ? (h.claim as string).slice(0, 500) : '',
        tickers: h.tickers,
        horizon: h.horizon,
        confidence: h.confidence,
        elo: h.elo,
        status: h.status,
        last_tested_at: h.last_tested_at,
      })),

      principles: week.principles.map((p: Record<string, unknown>) => ({
        id: p.id,
        principle: p.principle,
        domain: p.domain,
        strength: p.strength,
        support_count: p.support_count,
        refute_count: p.refute_count,
      })),

      biases: week.biases.map((b: Record<string, unknown>) => ({
        id: b.id,
        pattern: b.pattern,
        severity: b.severity,
        instruments: b.instruments,
        observed_count: b.observed_count,
        last_confirmed: b.last_confirmed,
      })),

      breaking_news_severity4plus: week.breakingNews.map((n: Record<string, unknown>) => ({
        headline: n.headline,
        severity: n.severity,
        sentiment: n.sentiment,
        tickers_affected: n.tickers_affected,
        macro_wide: n.macro_wide,
        category: n.category,
        summary: typeof n.summary === 'string' ? (n.summary as string).slice(0, 300) : null,
        ingested_at: n.ingested_at,
      })),
    };

    // ------- PROMPT -------
    const preamble = claudeSystemPromptPreamble(ctx);
    const system = [
      preamble,
      '',
      'ROLE: You are the CIO of your own paper firm. Your role is meta-analysis. Don\'t re-trade last week — extract what changed about HOW you trade.',
      '',
      'You run once a week. The Haiku heartbeat, Sonnet daily brief, and Sonnet hypothesis proposer already did the per-moment and per-day thinking. Your job is the weekly step back.',
      '',
      'What to produce:',
      '  - Principles that earned a refinement (the week\'s data sharpened or weakened the statement).',
      '  - Principles that are genuinely new (clear, repeatable insight not already covered).',
      '  - Elo overrides on hypotheses where the algorithmic update was obviously wrong (one lucky grade inflated a bad hypothesis, or vice-versa).',
      '  - Bias deprecations (the pattern has not recurred) and bias creations (a new systematic error).',
      '  - Exactly one next-week tilt: macro regime, focus tickers, avoid tickers, one paragraph of tactical notes.',
      '  - Drift flags for anything that looks off in the meta-system itself (stale data, missing feedback loop, grader misbehaving).',
      '',
      'Rules:',
      '  - You MUST call set_next_week_tilt exactly once. Every other tool is optional — 0..N calls each.',
      '  - Prefer fewer, higher-conviction tool calls to many weak ones. Silence is valid when the week did not produce a new principle.',
      '  - Cite concrete evidence inside every tool call\'s reasoning/derivation field — grade ids, trade ids, decision_type counts from the payload.',
      '  - Do NOT duplicate an active principle with only wording changes — refine the existing one instead.',
      '  - Your final message may include a plain-text summary. It will be persisted as raw_analysis. Keep it under 2000 words.',
    ].join('\n');

    // ------- CLAUDE CALL -------
    const claudeStart = Date.now();
    let response;
    try {
      response = await callClaude({
        model: CLAUDE_MODELS.opus,
        system,
        messages: [{ role: 'user', content: JSON.stringify(contextPayload) }],
        tools: CIO_TOOLS as unknown as Array<Record<string, unknown>>,
        tool_choice: { type: 'auto' },
        max_tokens: 4096,
        temperature: 0.3,
      });
    } catch (e) {
      const msg = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
      console.error('[ct-claude-cio-review] Claude call failed:', msg);
      return new Response(JSON.stringify({ error: 'claude_failed', detail: msg }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ------- BUDGET GUARDRAIL -------
    const tokensIn = response.usage?.input_tokens ?? 0;
    const tokensOut = response.usage?.output_tokens ?? 0;
    const costUsd = calculateCost(CLAUDE_MODELS.opus, { input_tokens: tokensIn, output_tokens: tokensOut });

    logClaudeUsage(supabase as unknown as { from: (t: string) => { insert: (r: Record<string, unknown>) => Promise<unknown> } }, {
      source: 'ct-claude-cio-review',
      model: CLAUDE_MODELS.opus,
      usage: { input_tokens: tokensIn, output_tokens: tokensOut },
      duration_ms: Date.now() - claudeStart,
      metadata: { week_ending: weekEnding },
    });

    if (costUsd > COST_GUARDRAIL_USD) {
      console.error(`[ct-claude-cio-review] COST GUARDRAIL TRIPPED: $${costUsd.toFixed(2)} > $${COST_GUARDRAIL_USD}. Not applying tool calls.`);
      // Still persist a row documenting the aborted run.
      await supabase.from('ct_weekly_reviews').insert({
        week_ending_date: weekEnding,
        macro_regime: null,
        focus_tickers: [],
        avoid_tickers: [],
        tactical_notes: `ABORTED — cost guardrail tripped ($${costUsd.toFixed(4)} > $${COST_GUARDRAIL_USD})`,
        cost_usd: costUsd,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        drift_flags: [{ component: 'ct-claude-cio-review', severity: 4, description: `cost guardrail tripped at $${costUsd.toFixed(4)}` }],
        model_used: CLAUDE_MODELS.opus,
      });
      return new Response(JSON.stringify({
        error: 'cost_guardrail_tripped',
        cost_usd: costUsd,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
      }), {
        status: 507,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ------- COLLECT TOOL CALLS + RAW TEXT -------
    const toolCalls: ToolCall[] = [];
    let rawAnalysis = '';
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.name && block.input) {
        toolCalls.push({ name: block.name, input: block.input as Record<string, unknown> });
      } else if (block.type === 'text' && block.text) {
        rawAnalysis += (rawAnalysis ? '\n\n' : '') + block.text;
      }
    }

    // ------- APPLY TOOL CALLS -------
    const applied = await applyToolCalls(supabase, toolCalls);

    // ------- PERSIST ct_weekly_reviews -------
    const { data: inserted, error: insertErr } = await supabase
      .from('ct_weekly_reviews')
      .insert({
        week_ending_date: weekEnding,
        macro_regime: applied.tilt.macro_regime,
        focus_tickers: applied.tilt.focus_tickers,
        avoid_tickers: applied.tilt.avoid_tickers,
        tactical_notes: applied.tilt.tactical_notes,
        principles_refined_count: applied.principles_refined_count,
        principles_created_count: applied.principles_created_count,
        biases_affected_count: applied.biases_affected_count,
        hypothesis_elo_adjustments: applied.hypothesis_elo_adjustments,
        drift_flags: applied.drift_flags,
        cost_usd: costUsd,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        model_used: CLAUDE_MODELS.opus,
        raw_analysis: rawAnalysis.slice(0, 20000),
      })
      .select('id, week_ending_date, generated_at')
      .single();

    if (insertErr || !inserted) {
      console.error('[ct-claude-cio-review] ct_weekly_reviews insert failed:', insertErr?.message);
      return new Response(JSON.stringify({ error: 'insert_failed', detail: insertErr?.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ------- DECISION JOURNAL -------
    try {
      await supabase.from('ct_claude_decisions').insert({
        decision_type: 'reflection',
        model_tier: 'opus',
        context_snapshot: {
          week_ending: weekEnding,
          trades_count: week.trades.length,
          grades_count: week.grades.length,
          decisions_total: week.decisionsTotal,
          briefs_count: week.briefs.length,
          dreams_count: week.dreams.length,
          hypotheses_count: week.hypotheses.length,
          principles_count: week.principles.length,
          biases_count: week.biases.length,
          breaking_news_count: week.breakingNews.length,
          book_curve_days: week.bookCurve.length,
        },
        reasoning: (rawAnalysis || 'No prose summary emitted.').slice(0, 8000),
        tool_calls_summary: {
          total_tool_calls: toolCalls.length,
          by_name: toolCalls.reduce((acc: Record<string, number>, c) => {
            acc[c.name] = (acc[c.name] ?? 0) + 1;
            return acc;
          }, {}),
          errors: applied.errors,
        },
        outcome: `review_id=${inserted.id} principles_refined=${applied.principles_refined_count} created=${applied.principles_created_count} biases_touched=${applied.biases_affected_count} elo_overrides=${applied.hypothesis_elo_adjustments.length} drift_flags=${applied.drift_flags.length}`,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
      });
    } catch (e) {
      console.warn('[ct-claude-cio-review] decision journal insert failed:', String(e));
    }

    return new Response(
      JSON.stringify({
        ok: true,
        review_id: inserted.id,
        week_ending_date: inserted.week_ending_date,
        generated_at: inserted.generated_at,
        principles_refined_count: applied.principles_refined_count,
        principles_created_count: applied.principles_created_count,
        biases_affected_count: applied.biases_affected_count,
        hypothesis_elo_adjustments: applied.hypothesis_elo_adjustments,
        drift_flags: applied.drift_flags,
        tilt: applied.tilt,
        tool_calls_applied: toolCalls.length,
        tool_errors: applied.errors,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: Number(costUsd.toFixed(6)),
        duration_ms: Date.now() - startedAt,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('[ct-claude-cio-review] fatal:', e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
