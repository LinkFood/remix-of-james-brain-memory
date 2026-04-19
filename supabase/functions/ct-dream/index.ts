/**
 * ct-dream — overnight Claude reflection on the closed session.
 *
 * Cron: weekdays at 06:00 UTC (01:00 ET during DST, 02:00 EST).
 *
 * Between EOD (21:30 UTC) and the morning brief (10:45 UTC) there is a
 * ~13-hour silence. Dream Mode fires in that gap. Claude loosely reflects
 * on today's session, pattern-matches against recent history, notices
 * things the structured EOD didn't capture. Stream-of-consciousness.
 * Seeds the next morning's thinking.
 *
 * Weekend suppression: the cron already skips Sat/Sun. Additionally the
 * function itself bails if the resolved session_date is older than 4 days
 * (e.g. holiday Mon — nothing fresh to reflect on) OR if the EOD recap
 * for that session doesn't exist.
 *
 * First few dreams will be thin. That is expected — the reflection quality
 * compounds as ct_session_embeddings accumulates 10+ days of history.
 *
 * ---------------------------------------------------------------------------
 * WAVE K — META-LEARNING EXTENSION (2026-04-18)
 * ---------------------------------------------------------------------------
 * Dream now also MINES the decision journal. A second Sonnet pass with
 * forced tool-use distills biases + principles from yesterday's trades,
 * signal-decomposition conflicts, and hallucination clusters. Tool calls
 * write directly to ct_biases / ct_principles and log each write to
 * ct_claude_decisions (decision_type='reflection') so the feedback loop
 * itself is auditable.
 *
 * Backwards compatible: the primary ct_dreams row is still written whether
 * or not any structural pattern is detected. Pass 2 is best-effort — any
 * failure logs to ct_cron_failures but never breaks Pass 1.
 * ---------------------------------------------------------------------------
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import {
  callClaude,
  CLAUDE_MODELS,
  parseTextContent,
  ClaudeError,
  calculateCost,
  type ClaudeResponse,
} from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { DREAM_SYSTEM } from '../_shared/ctPrompts.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';
import { getConfig } from '../_shared/configCache.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the session_date to reflect on. The cron fires at 06:00 UTC on
 * weekdays. For Tue-Fri, that's "yesterday" in ET. For Monday, "yesterday"
 * would be Sunday (no session) — roll back to Friday.
 */
function resolveSessionDate(now: Date = new Date()): string {
  const d = new Date(now);
  // Step back one UTC day — at 06:00 UTC this lands on yesterday-ET.
  d.setUTCDate(d.getUTCDate() - 1);
  const dow = d.getUTCDay(); // 0 Sun, 6 Sat
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2); // Sun → Fri
  else if (dow === 6) d.setUTCDate(d.getUTCDate() - 1); // Sat → Fri
  return d.toISOString().slice(0, 10);
}

/**
 * Resolve session_date window as UTC timestamps for "today" queries
 * (13:00–21:00 UTC ≈ market hours).
 */
function sessionWindow(sessionDate: string): { start: string; end: string } {
  return {
    start: `${sessionDate}T13:00:00.000Z`,
    end: `${sessionDate}T21:30:00.000Z`,
  };
}

/**
 * Wider journal window — the journal captures pre-open thinking too, so
 * pull the full 24h around the session_date.
 */
function journalWindow(sessionDate: string): { start: string; end: string } {
  return {
    start: `${sessionDate}T00:00:00.000Z`,
    end:   `${sessionDate}T23:59:59.999Z`,
  };
}

/**
 * Gather everything Claude needs to dream. Paralleled — single round trip.
 *
 * Wave K adds: ct_claude_decisions (compressed + signal-conflict cases),
 * ct_hypothesis_events, ct_trade_ideas (fired vs expired), and makes the
 * active biases/principles loads more thorough so Pass 2 can refine rather
 * than duplicate.
 */
async function gatherDreamContext(supabase: SupabaseClient, sessionDate: string) {
  const { start, end } = sessionWindow(sessionDate);
  const journal = journalWindow(sessionDate);
  const tenDaysAgo = new Date(new Date(sessionDate).getTime() - 10 * 24 * 3600_000)
    .toISOString()
    .slice(0, 10);

  const [
    eodReport,
    middayReport,
    observations,
    flags,
    alerts,
    closedTrades,
    tradeActions,
    postMortems,
    activeBiases,
    activePrinciples,
    activeLessons,
    curiosityFindings,
    sessionEmbeddings,
    claudeDecisions,
    hypothesisEvents,
    tradeIdeas,
  ] = await Promise.all([
    // Today's EOD (structured recap — the thing we're reflecting BEYOND).
    supabase.from('ct_reports')
      .select('id, summary, decomposition, rabbit_hole, scorecard, self_assessment, created_at')
      .eq('report_type', 'eod')
      .gte('period_start', start)
      .lte('period_end', end)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    // Today's midday recap — what did we feel at lunch?
    supabase.from('ct_reports')
      .select('id, summary, decomposition, created_at')
      .eq('report_type', 'midday')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),

    // All observations today.
    supabase.from('ct_observations')
      .select('id, instruments, direction, glance, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('created_at'),

    // All flags today.
    supabase.from('ct_flags')
      .select('id, instruments, direction, conviction, horizon, glance, grade_id, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('created_at'),

    // All alerts today.
    supabase.from('ct_alerts')
      .select('id, instruments, direction, conviction, alert_trigger, glance, grade_id, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('created_at'),

    // All trades closed today + their post-mortems attached below.
    supabase.from('ct_trades')
      .select('id, instrument, side, contract_type, strike, expiry, status, entry_price, close_price, realized_pnl_pct, close_reason, thesis, conviction, session_date, opened_at, closed_at')
      .eq('session_date', sessionDate)
      .eq('status', 'closed')
      .order('closed_at'),

    // Trade actions / lifecycle events today.
    supabase.from('ct_trade_actions')
      .select('trade_id, action, rationale, price, created_at')
      .gte('created_at', start).lte('created_at', end)
      .order('created_at'),

    // Post-mortems written at close today (per-alert autopsy notes).
    supabase.from('ct_alert_post_mortems')
      .select('alert_id, alert_kind, what_missed, weakest_evidence_axis, bias_implicated, lesson, confidence_in_lesson, created_at')
      .gte('created_at', start)
      .lte('created_at', end)
      .order('created_at'),

    // Active biases — refinement context (Wave K: raised to 20 so Pass 2
    // can dedupe against a broader surface before emitting a new one).
    supabase.from('ct_biases')
      .select('id, pattern, evidence, instruments, severity, observed_count, last_confirmed')
      .eq('active', true)
      .order('severity', { ascending: false })
      .limit(20),

    // Active principles (ct_principles — distilled wisdom, Phase 1 table).
    supabase.from('ct_principles')
      .select('id, principle, derivation, strength, domain, support_count, refute_count, last_tested_at')
      .eq('trader', 'claude')
      .eq('status', 'active')
      .order('strength', { ascending: false })
      .limit(25),

    // Legacy lessons table — keep reading it for backwards-compat prompt
    // continuity until ct-lessons-curator migrates fully to ct_principles.
    supabase.from('ct_lessons')
      .select('id, lesson, instruments, created_at')
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(15),

    // Latest curiosity findings from today — edge-of-attention material.
    supabase.from('ct_curiosity_findings')
      .select('question, finding, attention_score, actionable, related_instruments, created_at')
      .eq('session_date', sessionDate)
      .order('attention_score', { ascending: false })
      .limit(5),

    // Last 10 days of session embeddings — pattern-match corpus. We give
    // Claude the state_summary + eod_summary so it can free-associate.
    supabase.from('ct_session_embeddings')
      .select('session_date, through_utc, state_summary, state_features, eod_return_pct, eod_summary')
      .gte('session_date', tenDaysAgo)
      .lte('session_date', sessionDate)
      .order('session_date', { ascending: false }),

    // Wave K: raw decision journal rows for the day. We pull the rich
    // columns so signal-conflict and hallucination cases carry their full
    // context into the prompt.
    supabase.from('ct_claude_decisions')
      .select('id, decision_type, model_tier, alignment, claude_followed, narrative_signal, tape_signal, reasoning, outcome, hallucination_flag, hallucination_reason, linked_hypothesis_id, linked_trade_idea_id, linked_trade_id, created_at')
      .gte('created_at', journal.start)
      .lte('created_at', journal.end)
      .order('created_at'),

    // Wave K: confidence / elo moves today — these are the audit trail of
    // hypothesis learning. Small deltas over time are signal.
    supabase.from('ct_hypothesis_events')
      .select('hypothesis_id, event_type, delta, before_value, after_value, reason, linked_grade_id, created_at')
      .gte('created_at', journal.start)
      .lte('created_at', journal.end)
      .order('created_at'),

    // Wave K: trade ideas armed for this session. The fired-vs-expired ratio
    // tells us a lot about Claude's read of the tape vs what actually printed.
    supabase.from('ct_trade_ideas')
      .select('id, hypothesis_id, instrument, direction, contract_type, status, entry_trigger, rationale, size_pct, armed_at, triggered_at, filled_at, cancelled_reason, trade_id')
      .eq('trader', 'claude')
      .gte('armed_at', journal.start)
      .lte('armed_at', journal.end)
      .order('armed_at'),
  ]);

  // Compress the journal: full rows only for signal-conflict + hallucination
  // cases (those are the learning material). Everything else is a count by
  // decision_type — gives Sonnet the shape of the day without burning tokens.
  const rawDecisions = claudeDecisions.data ?? [];
  const decisionTypeCounts: Record<string, number> = {};
  for (const d of rawDecisions) {
    const k = (d.decision_type as string | undefined) ?? 'unknown';
    decisionTypeCounts[k] = (decisionTypeCounts[k] ?? 0) + 1;
  }
  const signalConflictDecisions = rawDecisions.filter(d =>
    d.hallucination_flag === true ||
    (d.claude_followed && d.claude_followed !== 'aligned' && d.claude_followed !== 'both'),
  );

  // Trade ideas: split into fired vs expired for the signal-decomposition
  // mining angle.
  const rawIdeas = tradeIdeas.data ?? [];
  const firedIdeas = rawIdeas.filter(i => ['filled', 'triggered'].includes(i.status as string));
  const expiredIdeas = rawIdeas.filter(i => ['expired', 'cancelled', 'rejected'].includes(i.status as string));

  return {
    session_date: sessionDate,
    eod_report: eodReport.data ?? null,
    midday_report: middayReport.data ?? null,
    observations: observations.data ?? [],
    flags: flags.data ?? [],
    alerts: alerts.data ?? [],
    closed_trades: closedTrades.data ?? [],
    trade_actions: tradeActions.data ?? [],
    post_mortems: postMortems.data ?? [],
    active_biases: activeBiases.data ?? [],
    active_principles: activePrinciples.data ?? [],
    active_lessons_legacy: activeLessons.data ?? [],
    curiosity_findings: curiosityFindings.data ?? [],
    last_10_session_embeddings: sessionEmbeddings.data ?? [],
    // Wave K additions
    decision_journal: {
      total: rawDecisions.length,
      by_type: decisionTypeCounts,
      signal_conflict_and_hallucinations: signalConflictDecisions,
    },
    hypothesis_events: hypothesisEvents.data ?? [],
    trade_ideas: {
      fired: firedIdeas,
      expired: expiredIdeas,
      fired_count: firedIdeas.length,
      expired_count: expiredIdeas.length,
    },
  };
}

interface DreamOutput {
  reflection: string;
  patterns_noticed: Array<{ pattern: string; evidence_refs?: string[] }>;
  connections_drawn: Array<{ today_thing: string; past_thing: string; why_connected: string }>;
  tomorrow_hypotheses: Array<{ hypothesis: string; how_to_test: string }>;
}

/**
 * Strip ```json fences Claude sometimes adds; fall back to first {...}.
 */
function parseDreamJson(text: string): DreamOutput | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned) as DreamOutput; } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]) as DreamOutput; } catch { return null; } }
    return null;
  }
}

/**
 * Build the rich text fed to Voyage. Mirrors the "state | instruments |
 * direction" pattern from buildCtRichText but tuned for dream content.
 */
function buildDreamRichText(sessionDate: string, dream: DreamOutput): string {
  const head = `DREAM ${sessionDate}`;
  const patterns = (dream.patterns_noticed ?? [])
    .map(p => p.pattern)
    .filter(Boolean)
    .join(' · ');
  const hypotheses = (dream.tomorrow_hypotheses ?? [])
    .map(h => h.hypothesis)
    .filter(Boolean)
    .join(' · ');
  return `${head}\npatterns: ${patterns}\nhypotheses: ${hypotheses}\n${dream.reflection ?? ''}`.trim();
}

// ---------------------------------------------------------------------------
// WAVE K — meta-learning (Pass 2): forced tool-use distillation.
// ---------------------------------------------------------------------------

const META_TOOLS = [
  {
    name: 'emit_dream',
    description: 'Acknowledge the reflection you just produced. Always call this exactly once, FIRST, as a no-op anchor pointing at the narrative you already wrote in Pass 1. You do not re-write the narrative here.',
    input_schema: {
      type: 'object',
      properties: {
        narrative_reference: { type: 'string', description: 'One-sentence pointer to the Pass-1 reflection (e.g. "see ct_dreams row for session 2026-04-17").' },
        key_lessons:         { type: 'array', items: { type: 'string' }, description: 'Up to 5 one-line distilled takeaways from the narrative.' },
      },
      required: ['narrative_reference', 'key_lessons'],
    },
  },
  {
    name: 'detect_bias',
    description: 'Emit a NEW identity-level bias pattern you noticed today. Only call this when 2 or more trades/decisions today exhibit the same pattern AND the pattern does not already appear in active_biases. Biases are structural — "I overweight X in Y regime" — not tactical.',
    input_schema: {
      type: 'object',
      properties: {
        pattern:            { type: 'string', description: 'One sentence, identity-level. e.g. "I overweight put flow in low-VIX tape."' },
        description:        { type: 'string', description: 'Short paragraph expanding the pattern and its mechanism.' },
        domain:             { type: 'string', description: 'e.g. execution, flow, vol, macro, psychology, tape_vs_narrative.' },
        evidence_count:     { type: 'integer', description: 'How many trades or decisions support this today.' },
        sample_trade_ids:   { type: 'array', items: { type: 'string' }, description: 'Up to 5 trade or decision IDs from today that evidence the pattern.' },
        instruments:        { type: 'array', items: { type: 'string' }, description: 'Tickers most affected, or empty for universal.' },
        severity:           { type: 'integer', minimum: 1, maximum: 5, description: '1=minor tendency, 3=weekly pattern costing calibration, 5=repeating and eating returns.' },
      },
      required: ['pattern', 'description', 'evidence_count', 'sample_trade_ids', 'severity'],
    },
  },
  {
    name: 'refine_existing_bias',
    description: 'When today\'s evidence adds to a bias that already exists in active_biases, call this to update its evidence + severity rather than emit a duplicate.',
    input_schema: {
      type: 'object',
      properties: {
        bias_id:         { type: 'string', description: 'UUID of the existing ct_biases row.' },
        new_description: { type: 'string', description: 'Refined or expanded pattern description.' },
        strength_delta:  { type: 'integer', description: 'Severity change: -1 to +2. Positive if today reinforced; negative if today weakened.' },
        reason:          { type: 'string', description: 'Why today\'s evidence justifies this refinement. Cite trade/decision IDs.' },
      },
      required: ['bias_id', 'new_description', 'strength_delta', 'reason'],
    },
  },
  {
    name: 'distill_principle',
    description: 'Emit a NEW durable trading principle distilled from today. Principles generalize beyond one trade — prefer conditional forms ("when X, do Y"). Only call when today\'s lesson clearly extends beyond a single setup.',
    input_schema: {
      type: 'object',
      properties: {
        principle:         { type: 'string', description: 'One sentence, actionable, conditional when possible. e.g. "When IV_rank > 80 and net gamma is negative, halve directional size."' },
        domain:            { type: 'string', description: 'execution | psychology | vol | flow | macro | tape_vs_narrative | sizing | timing' },
        derivation:        { type: 'string', description: 'How today led to this principle. Reference specific trade_ids, decision_ids, or hypothesis_events.' },
        strength:          { type: 'number', minimum: 0, maximum: 1, description: 'Initial confidence 0-1. Fresh dream-principles should start around 0.5.' },
        sample_evidence:   { type: 'array', items: { type: 'string' }, description: 'Up to 5 supporting IDs from today.' },
      },
      required: ['principle', 'domain', 'derivation', 'strength'],
    },
  },
  {
    name: 'refine_principle',
    description: 'When an active principle needs updating based on today\'s evidence — rephrased, qualified, or had its strength adjusted — call this rather than emitting a duplicate distill_principle.',
    input_schema: {
      type: 'object',
      properties: {
        principle_id:   { type: 'string', description: 'UUID of the existing ct_principles row.' },
        new_text:       { type: 'string', description: 'Updated principle text.' },
        strength_delta: { type: 'number', description: 'Strength change in [-0.3, +0.3]. Positive = today confirmed; negative = today refuted.' },
        reason:         { type: 'string', description: 'Why today\'s evidence justifies this refinement. Cite IDs.' },
      },
      required: ['principle_id', 'new_text', 'strength_delta', 'reason'],
    },
  },
  {
    name: 'flag_hallucination_cluster',
    description: 'When 3 or more decisions today carry hallucination_flag=true AND share a common fabrication type, call this to surface the cluster. One call per distinct fabrication type.',
    input_schema: {
      type: 'object',
      properties: {
        pattern:            { type: 'string', description: 'The common fabrication type. e.g. "invented gamma wall levels with no source."' },
        count:              { type: 'integer', minimum: 3 },
        sample_decision_ids:{ type: 'array', items: { type: 'string' }, minItems: 1 },
      },
      required: ['pattern', 'count', 'sample_decision_ids'],
    },
  },
];

const META_SYSTEM = `You are the META-LEARNING pass of the dream. Pass 1 wrote a reflection (already persisted). Your job now: distill STRUCTURAL learnings from today's decision journal — biases, principles, hallucination clusters.

You will receive a JSON payload containing:
- decision_journal.by_type          — counts of every decision Claude made today
- decision_journal.signal_conflict_and_hallucinations — full rows for conflict/hallucination cases
- hypothesis_events                 — confidence/elo moves today
- trade_ideas.fired / .expired      — what Claude tried vs what actually fired
- closed_trades, post_mortems       — graded outcomes
- active_biases, active_principles  — do NOT duplicate these; refine or skip instead
- pass1_narrative                   — the reflection prose Pass 1 produced

Your tools (call each 0+ times; silence is a valid answer):
1. emit_dream             — ALWAYS call exactly once, FIRST, as anchor. Pull up to 5 key_lessons from the narrative.
2. detect_bias            — only when 2+ trades/decisions today exhibit a NEW pattern.
3. refine_existing_bias   — only when today adds evidence to a bias already in active_biases.
4. distill_principle      — only when today's lesson generalizes beyond a single trade.
5. refine_principle       — only when an active principle needs updating.
6. flag_hallucination_cluster — only when 3+ hallucination_flag=true rows share a fabrication type.

SIGNAL-DECOMPOSITION MINING (tenet 11 — critical):
If today shows 2+ graded winners where claude_followed='tape' AND 2+ graded winners where claude_followed='narrative' under different conditions, emit a distill_principle that conditionalizes: "When [regime], tape leads; when [regime], narrative leads." This is how Claude learns tape-vs-narrative resolution structurally. First structural win takes weeks of data — TRY EVERY NIGHT anyway.

HARD RULES:
- Silence beats hallucination. Most nights detect 0 biases and 0 principles. That's correct.
- Never emit a bias that paraphrases an existing active bias — call refine_existing_bias.
- Never emit a principle that paraphrases an existing active principle — call refine_principle.
- Cite specific trade_ids, decision_ids, or hypothesis_event rows in derivations / evidence. Fabrication of an ID = fatal.
- If the corpus is thin (no closed trades, no hypothesis events), just call emit_dream with narrative_reference + empty key_lessons and stop.`;

// ---------------------------------------------------------------------------
// Tool-use handlers — write rows for each structured output.
// ---------------------------------------------------------------------------

interface ToolCallResult {
  tool: string;
  ok: boolean;
  id?: string;
  error?: string;
}

async function handleToolCall(
  supabase: SupabaseClient,
  toolName: string,
  input: Record<string, unknown>,
  sessionDate: string,
): Promise<ToolCallResult> {
  const now = new Date().toISOString();

  try {
    if (toolName === 'emit_dream') {
      // No-op anchor — we don't persist this separately. The Pass-1 row is
      // the authoritative dream; emit_dream just proves the model stayed
      // in the loop and gives us key_lessons for logs.
      return { tool: 'emit_dream', ok: true };
    }

    if (toolName === 'detect_bias') {
      const pattern = String(input.pattern ?? '').trim();
      const description = String(input.description ?? '').trim();
      const severity = Math.min(5, Math.max(1, Math.round(Number(input.severity ?? 3))));
      const evidenceCount = Math.max(1, Math.round(Number(input.evidence_count ?? 1)));
      const sampleIds = Array.isArray(input.sample_trade_ids) ? input.sample_trade_ids.slice(0, 5).map(String) : [];
      const instruments = Array.isArray(input.instruments) && input.instruments.length > 0
        ? input.instruments.map(String) : null;
      const domain = input.domain ? String(input.domain) : null;

      if (!pattern || sampleIds.length === 0) {
        return { tool: toolName, ok: false, error: 'missing pattern or sample_trade_ids' };
      }

      // Build the `evidence` text with the dream origin + domain + references.
      const evidenceText = [
        `[dream:${sessionDate}]`,
        domain ? `domain=${domain}` : null,
        `n=${evidenceCount}`,
        `refs=${sampleIds.join(',')}`,
        description ? `— ${description}` : null,
      ].filter(Boolean).join(' ');

      const { data, error } = await supabase.from('ct_biases').insert({
        pattern,
        evidence: evidenceText.slice(0, 2000),
        instruments,
        severity,
        active: true,
        observed_count: evidenceCount,
        first_seen_at: now,
        last_confirmed: now,
      }).select('id').maybeSingle();

      if (error || !data) {
        return { tool: toolName, ok: false, error: error?.message ?? 'insert returned no row' };
      }

      await recordDecision(supabase, {
        decision_type: 'reflection',
        model_tier: 'sonnet',
        reasoning: `detect_bias: ${pattern}`,
        outcome: `ct_biases.insert ${data.id}`,
        context_snapshot: { sample_trade_ids: sampleIds, severity, domain, session_date: sessionDate },
      });
      return { tool: toolName, ok: true, id: data.id };
    }

    if (toolName === 'refine_existing_bias') {
      const biasId = String(input.bias_id ?? '');
      if (!biasId) return { tool: toolName, ok: false, error: 'missing bias_id' };

      const newDescription = String(input.new_description ?? '').trim();
      const strengthDelta = Math.max(-1, Math.min(2, Math.round(Number(input.strength_delta ?? 0))));
      const reason = String(input.reason ?? '').slice(0, 1000);

      const { data: row } = await supabase.from('ct_biases')
        .select('evidence, severity, observed_count')
        .eq('id', biasId)
        .maybeSingle();
      if (!row) return { tool: toolName, ok: false, error: 'bias_id not found' };

      const currentSeverity = Math.round(Number((row as any).severity ?? 3));
      const nextSeverity = Math.max(1, Math.min(5, currentSeverity + strengthDelta));
      const currentCount = Math.max(0, Math.round(Number((row as any).observed_count ?? 0)));
      const appendEvidence = `\n[dream:${sessionDate}] Δ${strengthDelta >= 0 ? '+' : ''}${strengthDelta} — ${reason}`
        + (newDescription ? ` | ${newDescription}` : '');
      const mergedEvidence = (String((row as any).evidence ?? '') + appendEvidence).slice(-4000);

      const { error } = await supabase.from('ct_biases').update({
        evidence: mergedEvidence,
        severity: nextSeverity,
        observed_count: currentCount + 1,
        last_confirmed: now,
      }).eq('id', biasId);

      if (error) return { tool: toolName, ok: false, error: error.message };

      await recordDecision(supabase, {
        decision_type: 'reflection',
        model_tier: 'sonnet',
        reasoning: `refine_existing_bias: ${reason}`,
        outcome: `ct_biases.update ${biasId} Δsev=${strengthDelta}`,
      });
      return { tool: toolName, ok: true, id: biasId };
    }

    if (toolName === 'distill_principle') {
      const principle = String(input.principle ?? '').trim();
      if (!principle) return { tool: toolName, ok: false, error: 'missing principle' };

      const domain = input.domain ? String(input.domain).slice(0, 64) : null;
      const strength = Math.max(0, Math.min(1, Number(input.strength ?? 0.5)));
      const derivation = String(input.derivation ?? '').slice(0, 2000);
      const sampleEvidence = Array.isArray(input.sample_evidence)
        ? input.sample_evidence.slice(0, 5).map(String) : [];

      const derivationText = [
        `[dream:${sessionDate}]`,
        derivation,
        sampleEvidence.length ? `refs=${sampleEvidence.join(',')}` : null,
      ].filter(Boolean).join(' ');

      const { data, error } = await supabase.from('ct_principles').insert({
        trader: 'claude',
        principle,
        derivation: derivationText,
        strength,
        status: 'active',
        domain,
        support_count: 0,
        refute_count: 0,
        last_tested_at: now,
      }).select('id').maybeSingle();

      if (error || !data) {
        return { tool: toolName, ok: false, error: error?.message ?? 'insert returned no row' };
      }

      await recordDecision(supabase, {
        decision_type: 'reflection',
        model_tier: 'sonnet',
        reasoning: `distill_principle: ${principle}`,
        outcome: `ct_principles.insert ${data.id}`,
        context_snapshot: { sample_evidence: sampleEvidence, domain, strength, session_date: sessionDate },
      });
      return { tool: toolName, ok: true, id: data.id };
    }

    if (toolName === 'refine_principle') {
      const principleId = String(input.principle_id ?? '');
      if (!principleId) return { tool: toolName, ok: false, error: 'missing principle_id' };

      const newText = String(input.new_text ?? '').trim();
      const strengthDelta = Math.max(-0.3, Math.min(0.3, Number(input.strength_delta ?? 0)));
      const reason = String(input.reason ?? '').slice(0, 1000);

      const { data: row } = await supabase.from('ct_principles')
        .select('principle, derivation, strength, support_count, refute_count')
        .eq('id', principleId)
        .maybeSingle();
      if (!row) return { tool: toolName, ok: false, error: 'principle_id not found' };

      const currentStrength = Number((row as any).strength ?? 0.5);
      const nextStrength = Math.max(0, Math.min(1, currentStrength + strengthDelta));
      const appendDerivation = `\n[dream:${sessionDate}] Δ${strengthDelta >= 0 ? '+' : ''}${strengthDelta.toFixed(2)} — ${reason}`;
      const mergedDerivation = (String((row as any).derivation ?? '') + appendDerivation).slice(-4000);
      const supportBump  = strengthDelta >= 0 ? 1 : 0;
      const refuteBump   = strengthDelta <  0 ? 1 : 0;

      const { error } = await supabase.from('ct_principles').update({
        principle: newText || String((row as any).principle ?? ''),
        derivation: mergedDerivation,
        strength: nextStrength,
        support_count: Math.round(Number((row as any).support_count ?? 0)) + supportBump,
        refute_count:  Math.round(Number((row as any).refute_count  ?? 0)) + refuteBump,
        last_tested_at: now,
        updated_at: now,
      }).eq('id', principleId);

      if (error) return { tool: toolName, ok: false, error: error.message };

      await recordDecision(supabase, {
        decision_type: 'reflection',
        model_tier: 'sonnet',
        reasoning: `refine_principle: ${reason}`,
        outcome: `ct_principles.update ${principleId} Δstr=${strengthDelta.toFixed(2)}`,
      });
      return { tool: toolName, ok: true, id: principleId };
    }

    if (toolName === 'flag_hallucination_cluster') {
      const pattern = String(input.pattern ?? '').trim();
      const count = Math.max(3, Math.round(Number(input.count ?? 3)));
      const sampleIds = Array.isArray(input.sample_decision_ids) ? input.sample_decision_ids.slice(0, 10).map(String) : [];

      await recordDecision(supabase, {
        decision_type: 'hallucination_flagged',
        model_tier: 'sonnet',
        reasoning: `hallucination_cluster: ${pattern}`,
        outcome: `n=${count}`,
        hallucination_flag: true,
        hallucination_reason: pattern,
        context_snapshot: { sample_decision_ids: sampleIds, session_date: sessionDate },
      });
      // Also seed a severity-4 bias since repeated fabrications of the same
      // type is an identity-level problem, not a one-off.
      const { data, error } = await supabase.from('ct_biases').insert({
        pattern: `Hallucination cluster: ${pattern}`,
        evidence: `[dream:${sessionDate}] count=${count} refs=${sampleIds.join(',')}`,
        instruments: null,
        severity: 4,
        active: true,
        observed_count: count,
        first_seen_at: now,
        last_confirmed: now,
      }).select('id').maybeSingle();

      if (error || !data) return { tool: toolName, ok: false, error: error?.message ?? 'bias insert failed' };
      return { tool: toolName, ok: true, id: data.id };
    }

    return { tool: toolName, ok: false, error: 'unknown tool' };
  } catch (e) {
    return { tool: toolName, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Log a non-crashing failure to ct_cron_failures so the health check
 * surfaces it. Best-effort — never throws.
 */
async function logDreamFailure(
  supabase: SupabaseClient,
  status: 'failed' | 'stale' | 'never_ran',
  detail: string,
): Promise<void> {
  try {
    await supabase.from('ct_cron_failures').insert({
      cron_name: 'ct-dream-meta-pass',
      status,
      last_run_status: detail.slice(0, 500),
    });
  } catch (e) {
    console.warn('[ct-dream] failed to log to ct_cron_failures:', e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
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

  // Kill switch — no Claude call if engaged.
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-dream', corsHeaders);
  }

  const startedAt = Date.now();

  try {
    // Allow override via body for manual triggers / backfills.
    let overrideDate: string | null = null;
    try {
      const body = await req.json().catch(() => null);
      if (body && typeof body.session_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.session_date)) {
        overrideDate = body.session_date;
      }
    } catch { /* ignore — empty body is fine */ }

    const sessionDate = overrideDate ?? resolveSessionDate();

    // Holiday / stale-session suppression. If the resolved session is more
    // than 4 calendar days old, the market was closed recently and there's
    // nothing fresh to dream about (e.g. four-day weekend).
    const ageDays = Math.floor(
      (Date.now() - new Date(`${sessionDate}T21:00:00.000Z`).getTime()) / (24 * 3600_000),
    );
    if (!overrideDate && ageDays > 4) {
      return new Response(JSON.stringify({
        skipped: true,
        reason: `resolved session_date ${sessionDate} is ${ageDays}d old — no fresh session to reflect on`,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Resolve cost cap from config (default 3.00 USD / run).
    const maxCostUsd = Number(await getConfig<number>('claude_dream_max_cost_usd', 3.0));

    // Gather context.
    const ctx = await gatherDreamContext(supabase, sessionDate);

    // Suppress if the session genuinely has nothing — no EOD, no trades, no
    // flags. Means it was a market holiday the cron didn't know to skip.
    const corpusEmpty =
      !ctx.eod_report &&
      ctx.observations.length === 0 &&
      ctx.flags.length === 0 &&
      ctx.alerts.length === 0 &&
      ctx.closed_trades.length === 0 &&
      ctx.decision_journal.total === 0;

    if (corpusEmpty && !overrideDate) {
      return new Response(JSON.stringify({
        skipped: true,
        session_date: sessionDate,
        reason: 'corpus empty — no EOD, no trades, no flags, no decisions for this session (likely a holiday)',
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // -------------------------------------------------------------------
    // PASS 1 — narrative dream (unchanged, backwards-compatible).
    // -------------------------------------------------------------------
    let claudeText = '';
    let inputTokens = 0;
    let outputTokens = 0;
    const claudeStart = Date.now();
    try {
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,
        system: DREAM_SYSTEM,
        messages: [{
          role: 'user',
          content: JSON.stringify({
            session_date: sessionDate,
            now_utc: new Date().toISOString(),
            corpus_empty: corpusEmpty,
            ...ctx,
          }),
        }],
        max_tokens: 2500,
        temperature: 0.7, // looser than recap — this is reflection, not analysis
      });
      claudeText = parseTextContent(res).trim();
      inputTokens = res.usage?.input_tokens ?? 0;
      outputTokens = res.usage?.output_tokens ?? 0;
      logClaudeUsage(supabase, {
        source: 'ct-dream',
        model: CLAUDE_MODELS.sonnet,
        usage: res.usage,
        duration_ms: Date.now() - claudeStart,
        metadata: { session_date: sessionDate, corpus_empty: corpusEmpty, pass: 'narrative' },
      });
    } catch (e) {
      console.error('[ct-dream] Claude Pass-1 failed:', e instanceof ClaudeError ? e.message : e);
      return new Response(JSON.stringify({ error: 'Claude call failed' }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const dream = parseDreamJson(claudeText);
    if (!dream || typeof dream.reflection !== 'string' || !dream.reflection.trim()) {
      return new Response(JSON.stringify({
        error: 'Dream unparsable or empty',
        raw: claudeText.slice(0, 500),
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Normalize jsonb arrays — Claude sometimes returns objects when the
    // array should be empty. Coerce + clip to 10 max each (defensive).
    const patterns = Array.isArray(dream.patterns_noticed) ? dream.patterns_noticed.slice(0, 10) : [];
    const connections = Array.isArray(dream.connections_drawn) ? dream.connections_drawn.slice(0, 10) : [];
    const hypotheses = Array.isArray(dream.tomorrow_hypotheses) ? dream.tomorrow_hypotheses.slice(0, 10) : [];

    // Embed the reflection — Voyage 512-dim. Embedding is best-effort; if
    // Voyage fails we still persist the dream (search just won't hit it).
    let embedding: number[] | null = null;
    let embedError: string | null = null;
    try {
      embedding = await voyageEmbed(buildDreamRichText(sessionDate, dream), 'document');
    } catch (e) {
      embedError = e instanceof Error ? e.message : String(e);
      console.warn('[ct-dream] voyage embed failed (non-blocking):', embedError);
    }

    // Cost accounting — running total across all passes.
    let runningCostUsd = calculateCost(CLAUDE_MODELS.sonnet, {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
    let runningTokens = inputTokens + outputTokens;

    // Persist the Pass-1 dream row — always, even if Pass 2 fails.
    const { data: row, error: insertErr } = await supabase.from('ct_dreams').insert({
      session_date: sessionDate,
      reflection: dream.reflection,
      patterns_noticed: patterns,
      connections_drawn: connections,
      tomorrow_hypotheses: hypotheses,
      embedding: embedding as unknown as string | null,
      tokens_used: runningTokens,
      cost_usd: runningCostUsd,
    }).select('id').maybeSingle();

    if (insertErr || !row) {
      return new Response(JSON.stringify({
        error: 'ct_dreams insert failed',
        detail: insertErr?.message,
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // -------------------------------------------------------------------
    // PASS 2 — meta-learning (Wave K). Best-effort; never blocks Pass 1.
    // -------------------------------------------------------------------
    const toolResults: ToolCallResult[] = [];
    let pass2Skipped: string | null = null;
    let pass2Error: string | null = null;

    // Budget gate before we start Pass 2.
    if (runningCostUsd >= maxCostUsd) {
      pass2Skipped = `budget exceeded before Pass 2 (cost=${runningCostUsd.toFixed(4)} cap=${maxCostUsd.toFixed(2)})`;
    } else {
      try {
        const metaStart = Date.now();
        const metaPayload = {
          session_date: sessionDate,
          pass1_narrative: {
            reflection: dream.reflection,
            patterns_noticed: patterns,
            connections_drawn: connections,
            tomorrow_hypotheses: hypotheses,
          },
          active_biases: ctx.active_biases,
          active_principles: ctx.active_principles,
          decision_journal: ctx.decision_journal,
          hypothesis_events: ctx.hypothesis_events,
          trade_ideas: ctx.trade_ideas,
          closed_trades: ctx.closed_trades,
          post_mortems: ctx.post_mortems,
        };

        const res2: ClaudeResponse = await callClaude({
          model: CLAUDE_MODELS.sonnet,
          system: META_SYSTEM,
          messages: [{ role: 'user', content: JSON.stringify(metaPayload) }],
          tools: META_TOOLS,
          // Let Claude decide — silence is a valid answer. But require at
          // least a tool call (the emit_dream anchor) so we know the
          // model engaged with the payload.
          tool_choice: { type: 'any' },
          max_tokens: 3500,
          temperature: 0.4,
        });

        const res2In  = res2.usage?.input_tokens  ?? 0;
        const res2Out = res2.usage?.output_tokens ?? 0;
        const pass2Cost = calculateCost(CLAUDE_MODELS.sonnet, { input_tokens: res2In, output_tokens: res2Out });
        runningCostUsd += pass2Cost;
        runningTokens  += res2In + res2Out;

        logClaudeUsage(supabase, {
          source: 'ct-dream',
          model: CLAUDE_MODELS.sonnet,
          usage: res2.usage,
          duration_ms: Date.now() - metaStart,
          metadata: { session_date: sessionDate, pass: 'meta' },
        });

        // Process every tool_use block — could be 0 (model emitted text only)
        // or many. Each one writes its row.
        const toolBlocks = (res2.content ?? []).filter(c => c.type === 'tool_use');
        for (const block of toolBlocks) {
          // Budget check between each tool — no further writes if we crossed.
          if (runningCostUsd >= maxCostUsd) {
            toolResults.push({ tool: block.name ?? 'unknown', ok: false, error: 'budget cap reached mid-loop' });
            break;
          }
          const name = block.name ?? '';
          const inp  = (block.input ?? {}) as Record<string, unknown>;
          const r = await handleToolCall(supabase, name, inp, sessionDate);
          toolResults.push(r);
        }

        // Update the Pass-1 row with the combined token/cost total so
        // ct_dreams.tokens_used reflects total run cost.
        await supabase.from('ct_dreams').update({
          tokens_used: runningTokens,
          cost_usd: runningCostUsd,
        }).eq('id', row.id);
      } catch (e) {
        pass2Error = e instanceof ClaudeError ? e.message : (e instanceof Error ? e.message : String(e));
        console.warn('[ct-dream] Pass-2 meta failed (non-blocking):', pass2Error);
        await logDreamFailure(supabase, 'failed', `pass2: ${pass2Error}`);
      }
    }

    // Summarize Pass 2 results for the response.
    const biasesAdded    = toolResults.filter(r => r.tool === 'detect_bias'            && r.ok).length;
    const biasesRefined  = toolResults.filter(r => r.tool === 'refine_existing_bias'   && r.ok).length;
    const principlesAdded   = toolResults.filter(r => r.tool === 'distill_principle'  && r.ok).length;
    const principlesRefined = toolResults.filter(r => r.tool === 'refine_principle'   && r.ok).length;
    const hallucinationFlags = toolResults.filter(r => r.tool === 'flag_hallucination_cluster' && r.ok).length;
    const toolErrors     = toolResults.filter(r => !r.ok).map(r => ({ tool: r.tool, error: r.error }));

    return new Response(JSON.stringify({
      success: true,
      dream_id: row.id,
      session_date: sessionDate,
      corpus_empty: corpusEmpty,
      embed_ok: embedding != null,
      embed_error: embedError,
      pass2: {
        skipped_reason: pass2Skipped,
        error: pass2Error,
        tool_calls: toolResults.length,
        biases_added: biasesAdded,
        biases_refined: biasesRefined,
        principles_added: principlesAdded,
        principles_refined: principlesRefined,
        hallucination_clusters: hallucinationFlags,
        tool_errors: toolErrors,
      },
      counts: {
        patterns_noticed: patterns.length,
        connections_drawn: connections.length,
        tomorrow_hypotheses: hypotheses.length,
        context_observations: ctx.observations.length,
        context_flags: ctx.flags.length,
        context_alerts: ctx.alerts.length,
        context_closed_trades: ctx.closed_trades.length,
        context_session_embeddings: ctx.last_10_session_embeddings.length,
        context_claude_decisions: ctx.decision_journal.total,
        context_hypothesis_events: ctx.hypothesis_events.length,
        context_trade_ideas_fired: ctx.trade_ideas.fired_count,
        context_trade_ideas_expired: ctx.trade_ideas.expired_count,
      },
      tokens_used: runningTokens,
      cost_usd: runningCostUsd,
      max_cost_usd: maxCostUsd,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-dream] fatal:', error);
    try { await logDreamFailure(supabase, 'failed', error instanceof Error ? error.message : String(error)); } catch { /* ignore */ }
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'failed',
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
