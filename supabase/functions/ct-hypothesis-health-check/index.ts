/**
 * ct-hypothesis-health-check — does the current tape invalidate any open hypothesis?
 *
 * Runs every 15 min during RTH (13-20 UTC, Mon-Fri). For each `status='open'`
 * hypothesis, we:
 *   1. Pull the latest ct_heartbeats.current_reads snapshot (market state).
 *   2. Ask Claude Haiku whether the hypothesis's invalidate_if trigger has
 *      fired given that market state. Return: intact | invalidated | ambiguous.
 *   3. On `invalidated` -> call retire_hypothesis(id, 'refuted', reason).
 *   4. On `ambiguous` -> log a ct_hypothesis_events row (event_type='edited')
 *      so James can review on the UI.
 *   5. `intact` is a no-op (no write, no event — keeps the audit log clean).
 *
 * Budget cap: MAX_PER_RUN=20. Sorted by last_tested_at NULLS FIRST so the
 * oldest-checked hypotheses get re-read first.
 *
 * Auth: service role only. Called by pg_cron.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { buildClaudeContext, claudeSystemPromptPreamble, type ClaudeContext } from '../_shared/claudeReadSurface.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';
import { getTemporalContext } from '../_shared/temporalContext.ts';

const MAX_PER_RUN = 20;

// ---------------------------------------------------------------------------
// Stale-dated-claim detection (2026-04-30).
//
// The morning-brief AMZN crash on 2026-04-30 came from a hypothesis whose
// claim text said "today (Apr 29)" — Apr 29 was already in the past, but the
// hypothesis was still status='open'. The Haiku invalidate_if checker can't
// catch this class because the trigger is a CALENDAR date, not a price level.
//
// On every health-check run we now also scan every open hypothesis's claim
// for absolute date references that are STRICTLY in the past relative to
// session_date. Default behavior: detect + report only. With
// `auto_refute_stale_dated: true` the matched hypotheses are retired to
// status='refuted' with invalidated_reason='Catalyst date in claim has passed'.
// ---------------------------------------------------------------------------

const MONTH_NAMES_FULL = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_NAMES_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const MONTH_LOOKUP = new Map<string, number>();
for (let i = 0; i < 12; i++) {
  MONTH_LOOKUP.set(MONTH_NAMES_FULL[i].toLowerCase(), i + 1);
  MONTH_LOOKUP.set(MONTH_NAMES_ABBR[i].toLowerCase(), i + 1);
}

interface DetectedDate {
  /** YYYY-MM-DD reconstructed from the match. */
  iso: string;
  /** Original matched substring from the claim (for debug). */
  raw: string;
}

/**
 * Scan a claim string for absolute date references and return any that are
 * strictly before sessionDate. Catches:
 *   - 'YYYY-MM-DD' (full ISO date)
 *   - 'Apr 29', 'April 29' (month-name + day; year inferred from sessionDate)
 *   - 'Apr 29, 2026' (month-name + day + 4-digit year)
 *
 * Year inference: when no explicit year, assume sessionDate's year. If that
 * makes the inferred date >6 months in the future from sessionDate, roll back
 * one year (handles "Dec 30" written in early Jan). Conservative — false
 * positives here would auto-refute live hypotheses.
 */
function detectPastDatesInText(text: string, sessionDate: string): DetectedDate[] {
  if (!text || typeof text !== 'string') return [];
  const sessionMatch = sessionDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!sessionMatch) return [];
  const sessionYear = Number(sessionMatch[1]);
  const sessionMonth = Number(sessionMatch[2]);
  const sessionDay = Number(sessionMatch[3]);
  const sessionDateNum = sessionYear * 10000 + sessionMonth * 100 + sessionDay;

  const found: DetectedDate[] = [];
  const seen = new Set<string>();

  // 1) Full ISO YYYY-MM-DD.
  const isoRegex = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  for (const m of text.matchAll(isoRegex)) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    const num = y * 10000 + mo * 100 + d;
    if (num >= sessionDateNum) continue;
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    if (seen.has(iso)) continue;
    seen.add(iso);
    found.push({ iso, raw: m[0] });
  }

  // 2) Month-name + day, optional year.
  //    Matches: "Apr 29", "April 29", "Apr 29, 2026", "April 29 2026".
  const monthDayRegex = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:(?:st|nd|rd|th))?(?:\s*,?\s*(\d{4}))?\b/gi;
  for (const m of text.matchAll(monthDayRegex)) {
    const monthName = m[1].toLowerCase();
    const monthNum = MONTH_LOOKUP.get(monthName);
    if (!monthNum) continue;
    const day = Number(m[2]);
    if (day < 1 || day > 31) continue;
    let year: number;
    if (m[3]) {
      year = Number(m[3]);
    } else {
      // Year inference: sessionDate's year, rolled back if inferred date is
      // more than 6 months in the future (handles "Dec 30" in early Jan).
      year = sessionYear;
      const candidateNum = year * 10000 + monthNum * 100 + day;
      const monthsFromSession = (year - sessionYear) * 12 + (monthNum - sessionMonth);
      if (candidateNum > sessionDateNum && monthsFromSession > 6) {
        year = sessionYear - 1;
      }
    }
    const num = year * 10000 + monthNum * 100 + day;
    if (num >= sessionDateNum) continue;
    const iso = `${year.toString().padStart(4, '0')}-${monthNum.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    if (seen.has(iso)) continue;
    seen.add(iso);
    found.push({ iso, raw: m[0] });
  }

  return found;
}

interface HypothesisRow {
  id: string;
  claim: string;
  because: string[];
  invalidate_if: string;
  horizon: string;
  tickers: string[];
  confidence: number;
  elo: number;
  last_tested_at: string | null;
}

interface HaikuVerdict {
  verdict: 'intact' | 'invalidated' | 'ambiguous';
  reasoning: string;
}

const HAIKU_SYSTEM = `You're reviewing ONE running trading hypothesis against the live tape.

Given:
  - claim: what Claude thinks is true
  - because: the supporting reasoning
  - invalidate_if: the concrete trigger that would refute the claim
  - current_market_state: the latest per-instrument reads

Your ONLY job is to judge whether invalidate_if has fired RIGHT NOW.

Return strictly JSON:
  { "verdict": "intact" | "invalidated" | "ambiguous", "reasoning": "one sentence citing specific evidence" }

Rules:
  - "intact"      = the trigger has clearly NOT fired
  - "invalidated" = the trigger has clearly fired — the claim is dead
  - "ambiguous"   = you genuinely cannot tell from the snapshot (use sparingly)
  - Grade against the literal trigger, not vibes. If invalidate_if says
    "SPY breaks 550" and SPY is 552, the answer is intact — not "close call."
  - Single sentence reasoning. Cite the specific read.`;

async function judgeHypothesis(
  h: HypothesisRow,
  marketState: Record<string, unknown> | null,
  systemPrompt: string,
): Promise<HaikuVerdict | null> {
  try {
    const payload = {
      claim: h.claim,
      because: h.because,
      invalidate_if: h.invalidate_if,
      horizon: h.horizon,
      tickers: h.tickers,
      current_market_state: marketState ?? { note: 'no recent heartbeat snapshot' },
    };
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: systemPrompt,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
      max_tokens: 250,
      temperature: 0.1,
    });
    const raw = parseTextContent(res).trim();
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(stripped) as Record<string, unknown>;
    const verdict = parsed.verdict;
    if (verdict !== 'intact' && verdict !== 'invalidated' && verdict !== 'ambiguous') return null;
    return {
      verdict,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch (e) {
    const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
    console.warn(`[ct-hypothesis-health-check] haiku failed for hyp=${h.id}: ${detail}`);
    return null;
  }
}

function marketStateFromContext(ctx: ClaudeContext): Record<string, unknown> | null {
  const hb = ctx.latestHeartbeat;
  if (!hb) return null;
  return {
    status_line: hb.status_line,
    watching: hb.watching,
    current_reads: hb.current_reads,
    snapshot_at: hb.created_at,
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

  // Optional opt-in: auto-refute open hypotheses whose claim text contains
  // an absolute date now in the past. Default false — detect + report only.
  // James will fire with `{ auto_refute_stale_dated: true }` once we trust
  // the detection (likely Saturday after a few RTH cycles of pure reporting).
  let autoRefuteStaleDated = false;
  try {
    if (req.method === 'POST') {
      const body = await req.clone().json().catch(() => null);
      if (body && typeof body === 'object' && (body as Record<string, unknown>).auto_refute_stale_dated === true) {
        autoRefuteStaleDated = true;
      }
    }
  } catch {
    // ignore — non-JSON body or no body, treat as default false
  }

  // Temporal anchor — every Claude consumer must prepend the preamble + tag
  // dates in context. The 2026-04-30 morning-brief AMZN crash was caused by
  // a stale "Apr 29" hypothesis that should have been auto-closed here.
  const tctx = getTemporalContext();

  // ISOLATION: all context (heartbeat, config, preamble) via Claude read surface.
  // The stale-first ordering below is a separate query against the same
  // Claude-own ct_hypotheses table — still inside the contract.
  const claudeCtx = await buildClaudeContext(supabase, { heartbeatLimit: 1 });
  const marketState = marketStateFromContext(claudeCtx);
  const systemPrompt = `${tctx.temporalAnchorPreamble}\n\n${claudeSystemPromptPreamble(claudeCtx)}\n\n${HAIKU_SYSTEM}`;

  const { data: open, error } = await supabase
    .from('ct_hypotheses')
    .select('id, claim, because, invalidate_if, horizon, tickers, confidence, elo, last_tested_at')
    .eq('status', 'open')
    .order('last_tested_at', { ascending: true, nullsFirst: true })
    .limit(MAX_PER_RUN);

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rows = (open ?? []) as HypothesisRow[];
  let intact = 0, invalidated = 0, ambiguous = 0, failed = 0;

  // ---------------------------------------------------------------------------
  // Stale-dated-claim scan — runs against EVERY open hypothesis, not capped to
  // MAX_PER_RUN. Cheap regex over claim text. The Haiku invalidate_if checker
  // can't catch this class because the trigger is a CALENDAR date, not a price
  // level. See header comment for the full rationale.
  // ---------------------------------------------------------------------------
  let staleTemporalCount = 0;
  const staleTemporalHypothesisIds: string[] = [];
  const staleTemporalDetails: Array<{ id: string; matched_dates: string[]; refuted: boolean }> = [];
  let staleTemporalRefuted = 0;
  try {
    const { data: allOpen } = await supabase
      .from('ct_hypotheses')
      .select('id, claim, tickers, horizon')
      .eq('status', 'open');
    for (const h of allOpen ?? []) {
      const claim = typeof h.claim === 'string' ? h.claim : '';
      const detected = detectPastDatesInText(claim, tctx.session_date);
      if (detected.length === 0) continue;

      staleTemporalCount += 1;
      staleTemporalHypothesisIds.push(h.id);
      const matchedIsos = detected.map((d) => d.iso);
      let refuted = false;

      if (autoRefuteStaleDated) {
        const reasonText = `Catalyst date in claim has passed (matched: ${matchedIsos.join(', ')}). session_date=${tctx.session_date}.`;
        const { error: retireErr } = await supabase.rpc('retire_hypothesis', {
          p_hypothesis_id: h.id,
          p_status: 'refuted',
          p_reason: reasonText.slice(0, 500),
        });
        if (retireErr) {
          console.warn(`[ct-hypothesis-health-check] stale-temporal retire failed hyp=${h.id}: ${retireErr.message}`);
        } else {
          refuted = true;
          staleTemporalRefuted += 1;
        }
        await recordDecision(supabase, {
          decision_type: 'invalidate_hypothesis',
          model_tier: 'haiku',
          reasoning: `Stale-dated claim auto-refuted. Matched past dates: ${matchedIsos.join(', ')}. Claim: ${claim.slice(0, 300)}`,
          outcome: refuted ? 'retired_stale_temporal' : 'retire_rpc_failed',
          alignment: 'conflict',
          tape_signal: { reasoning: 'Claim references calendar date(s) now in the past', sources: ['regex:detectPastDatesInText'] },
          linked_hypothesis_id: h.id,
          context_snapshot: {
            session_date: tctx.session_date,
            matched_dates: matchedIsos,
            tickers: h.tickers ?? [],
            horizon: h.horizon ?? null,
            auto_refute_stale_dated: true,
          },
        });
      } else {
        // Detect-only path. Log each occurrence to the decision journal so
        // James can audit before flipping the auto_refute switch.
        await recordDecision(supabase, {
          decision_type: 'no_trade',
          model_tier: 'haiku',
          reasoning: `Stale-dated claim detected (NOT auto-refuted). Matched past dates: ${matchedIsos.join(', ')}. Claim: ${claim.slice(0, 300)}`,
          outcome: 'stale_temporal_detected',
          alignment: 'insufficient_data',
          tape_signal: { reasoning: 'Claim references calendar date(s) now in the past', sources: ['regex:detectPastDatesInText'] },
          linked_hypothesis_id: h.id,
          context_snapshot: {
            session_date: tctx.session_date,
            matched_dates: matchedIsos,
            tickers: h.tickers ?? [],
            horizon: h.horizon ?? null,
            auto_refute_stale_dated: false,
          },
        });
      }

      staleTemporalDetails.push({ id: h.id, matched_dates: matchedIsos, refuted });
    }
  } catch (e) {
    console.warn(`[ct-hypothesis-health-check] stale-temporal scan failed (non-blocking): ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const h of rows) {
    const v = await judgeHypothesis(h, marketState, systemPrompt);
    if (!v) {
      failed++;
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'haiku',
        reasoning: `health-check judgment failed for hypothesis: ${h.claim.slice(0, 300)}`,
        outcome: 'haiku_failed',
        linked_hypothesis_id: h.id,
        context_snapshot: { horizon: h.horizon, tickers: h.tickers, had_market_state: marketState !== null },
      });
      continue;
    }

    const tapeSignal = {
      direction: v.verdict === 'invalidated' ? 'invalidates' : 'supports',
      reasoning: v.reasoning,
      sources: ['ct_heartbeats.current_reads'],
    };

    if (v.verdict === 'invalidated') {
      invalidated++;
      const { error: retireErr } = await supabase.rpc('retire_hypothesis', {
        p_hypothesis_id: h.id,
        p_status: 'refuted',
        p_reason: `health-check: ${v.reasoning}`.slice(0, 500),
      });
      if (retireErr) {
        console.warn(`[ct-hypothesis-health-check] retire failed hyp=${h.id}: ${retireErr.message}`);
      }
      await recordDecision(supabase, {
        decision_type: 'invalidate_hypothesis',
        model_tier: 'haiku',
        reasoning: `Invalidated: ${v.reasoning}. Claim: ${h.claim.slice(0, 300)}`,
        outcome: retireErr ? 'retire_rpc_failed' : 'retired_refuted',
        alignment: 'conflict',
        claude_followed: 'tape',
        tape_signal: tapeSignal,
        linked_hypothesis_id: h.id,
        context_snapshot: { horizon: h.horizon, tickers: h.tickers, invalidate_if: h.invalidate_if },
      });
    } else if (v.verdict === 'ambiguous') {
      ambiguous++;
      const { error: evErr } = await supabase
        .from('ct_hypothesis_events')
        .insert({
          hypothesis_id: h.id,
          event_type: 'edited',
          reason: `health-check ambiguous: ${v.reasoning}`.slice(0, 500),
          created_by: 'cron',
        });
      if (evErr) {
        console.warn(`[ct-hypothesis-health-check] event insert failed hyp=${h.id}: ${evErr.message}`);
      }
      // Touch last_tested_at so we don't re-grade ambiguous every 15 min.
      await supabase
        .from('ct_hypotheses')
        .update({ last_tested_at: new Date().toISOString() })
        .eq('id', h.id);
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'haiku',
        reasoning: `Ambiguous verdict: ${v.reasoning}. Claim: ${h.claim.slice(0, 300)}`,
        outcome: 'ambiguous_hold',
        alignment: 'insufficient_data',
        tape_signal: { reasoning: v.reasoning, sources: ['ct_heartbeats.current_reads'] },
        linked_hypothesis_id: h.id,
        context_snapshot: { horizon: h.horizon, tickers: h.tickers, invalidate_if: h.invalidate_if },
      });
    } else {
      intact++;
      await supabase
        .from('ct_hypotheses')
        .update({ last_tested_at: new Date().toISOString() })
        .eq('id', h.id);
      await recordDecision(supabase, {
        decision_type: 'no_trade',
        model_tier: 'haiku',
        reasoning: `Intact: ${v.reasoning}. Claim: ${h.claim.slice(0, 300)}`,
        outcome: 'intact_hold',
        alignment: 'aligned',
        claude_followed: 'narrative',
        tape_signal: { reasoning: v.reasoning, sources: ['ct_heartbeats.current_reads'] },
        linked_hypothesis_id: h.id,
        context_snapshot: { horizon: h.horizon, tickers: h.tickers, invalidate_if: h.invalidate_if },
      });
    }
  }

  const body = {
    ok: true,
    processed: rows.length,
    intact,
    invalidated,
    ambiguous,
    failed,
    had_market_state: marketState !== null,
    // Stale-dated-claim scan output. Always present — count is 0 when nothing
    // matched. `auto_refute_stale_dated` echoes the input flag so callers can
    // confirm what mode the run executed under.
    stale_temporal_count: staleTemporalCount,
    stale_temporal_hypothesis_ids: staleTemporalHypothesisIds,
    stale_temporal_refuted: staleTemporalRefuted,
    stale_temporal_details: staleTemporalDetails,
    auto_refute_stale_dated: autoRefuteStaleDated,
    session_date: tctx.session_date,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-hypothesis-health-check]', JSON.stringify(body));

  // Run-summary breadcrumb. Edge-function logs aren't reliably reachable via
  // REST during manual verification, so the response body is also stuffed
  // into the decision journal — terminal-Claude can read it back through the
  // REST select pattern documented in feedback_edge_function_logs_unreachable.md.
  await recordDecision(supabase, {
    decision_type: 'no_trade',
    model_tier: 'haiku',
    reasoning: `health-check run summary: processed=${rows.length} intact=${intact} invalidated=${invalidated} ambiguous=${ambiguous} failed=${failed} stale_temporal_count=${staleTemporalCount} stale_temporal_refuted=${staleTemporalRefuted} auto_refute=${autoRefuteStaleDated}`,
    outcome: 'health_check_run_summary',
    context_snapshot: body,
  });

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
