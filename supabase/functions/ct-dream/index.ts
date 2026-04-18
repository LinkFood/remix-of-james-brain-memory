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
} from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { DREAM_SYSTEM } from '../_shared/ctPrompts.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';

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
 * Gather everything Claude needs to dream. Paralleled — single round trip.
 */
async function gatherDreamContext(supabase: SupabaseClient, sessionDate: string) {
  const { start, end } = sessionWindow(sessionDate);
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
    curiosityFindings,
    sessionEmbeddings,
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

    // Active biases — calibration context.
    supabase.from('ct_biases')
      .select('id, pattern, instruments, severity, observed_count, last_confirmed')
      .eq('active', true)
      .order('severity', { ascending: false })
      .limit(10),

    // Active principles — durable rules distilled weekly by lessons-curator.
    // (Referred to as "principles" in the spec; the table is ct_lessons.)
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
  ]);

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
    curiosity_findings: curiosityFindings.data ?? [],
    last_10_session_embeddings: sessionEmbeddings.data ?? [],
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

    // Gather context.
    const ctx = await gatherDreamContext(supabase, sessionDate);

    // Suppress if the session genuinely has nothing — no EOD, no trades, no
    // flags. Means it was a market holiday the cron didn't know to skip.
    const corpusEmpty =
      !ctx.eod_report &&
      ctx.observations.length === 0 &&
      ctx.flags.length === 0 &&
      ctx.alerts.length === 0 &&
      ctx.closed_trades.length === 0;

    if (corpusEmpty && !overrideDate) {
      return new Response(JSON.stringify({
        skipped: true,
        session_date: sessionDate,
        reason: 'corpus empty — no EOD, no trades, no flags for this session (likely a holiday)',
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Ask Claude (Sonnet — quality matters for dream prose).
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
        metadata: { session_date: sessionDate, corpus_empty: corpusEmpty },
      });
    } catch (e) {
      console.error('[ct-dream] Claude failed:', e instanceof ClaudeError ? e.message : e);
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

    // Cost accounting.
    const costUsd = calculateCost(CLAUDE_MODELS.sonnet, {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
    const tokensUsed = inputTokens + outputTokens;

    // Persist.
    const { data: row, error: insertErr } = await supabase.from('ct_dreams').insert({
      session_date: sessionDate,
      reflection: dream.reflection,
      patterns_noticed: patterns,
      connections_drawn: connections,
      tomorrow_hypotheses: hypotheses,
      embedding: embedding as unknown as string | null,
      tokens_used: tokensUsed,
      cost_usd: costUsd,
    }).select('id').maybeSingle();

    if (insertErr || !row) {
      return new Response(JSON.stringify({
        error: 'ct_dreams insert failed',
        detail: insertErr?.message,
      }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({
      success: true,
      dream_id: row.id,
      session_date: sessionDate,
      corpus_empty: corpusEmpty,
      embed_ok: embedding != null,
      embed_error: embedError,
      counts: {
        patterns_noticed: patterns.length,
        connections_drawn: connections.length,
        tomorrow_hypotheses: hypotheses.length,
        context_observations: ctx.observations.length,
        context_flags: ctx.flags.length,
        context_alerts: ctx.alerts.length,
        context_closed_trades: ctx.closed_trades.length,
        context_session_embeddings: ctx.last_10_session_embeddings.length,
      },
      tokens_used: tokensUsed,
      cost_usd: costUsd,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-dream] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'failed',
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
