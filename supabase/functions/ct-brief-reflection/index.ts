/**
 * ct-brief-reflection — Path A bridge: translate ct_eod_reports.morning_brief_scorecard
 * → ct_daily_briefs.accuracy_score + accuracy_notes.
 *
 * Ship 6 of Bundle 2 (2026-05-13). Phase A discovered ct-eod-report ALREADY
 * computes the morning-brief grade (per-ticker verdict + alpha_pct + commentary
 * + aggregate score_pct) via deterministic code + Sonnet commentary; the result
 * just lives in ct_eod_reports.morning_brief_scorecard / scorecard_summary
 * instead of writing back to ct_daily_briefs.accuracy_score / accuracy_notes.
 * Captain acked Path A — bridge the existing scorecard rather than ship a
 * net-new Haiku reflection cron that would duplicate ~80% of ct-eod-report's
 * work and risk divergence between two scoring systems.
 *
 * NO new Claude calls. Deterministic digest of pre-existing per-ticker
 * commentary. Editorial choice α confirmed by captain.
 *
 * Three invocation modes (in body JSON):
 *   { }                          — bridge today's EOD report (the natural
 *                                  21:30 UTC cron path post ct-eod-report's
 *                                  21:00 UTC fire)
 *   { session_date: 'YYYY-MM-DD' } — bridge a specific session_date (manual
 *                                  via trigger_ct_brief_reflection RPC)
 *   { backfill: true }           — bridge ALL historical ct_eod_reports with
 *                                  morning_brief_id NOT NULL (one-shot
 *                                  catch-up at ship time)
 *
 * NULL stays NULL where no ct_eod_reports row exists or morning_brief_id is
 * NULL on the report — no fabrication. The captain decision rule: presence of
 * an EOD-paired scorecard is the precondition for populating accuracy_*.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { todayInET } from '../_shared/clock.ts';

interface ScorecardSummary {
  wins?: number;
  partials?: number;
  neutrals?: number;
  losses?: number;
  score_pct?: number;
}

interface PerTickerScore {
  ticker?: string;
  verdict?: string; // 'win' | 'partial' | 'neutral' | 'loss'
  alpha_pct?: number;
  commentary?: string;
  morning_call?: string;
  actual_outcome?: string;
  morning_thesis?: string;
}

interface EodReportRow {
  id: string;
  session_date: string;
  morning_brief_id: string | null;
  scorecard_summary: ScorecardSummary | null;
  morning_brief_scorecard: PerTickerScore[] | null;
}

/** Score in 0.0-1.0 range. NULL if scorecard_summary or score_pct missing. */
function deriveAccuracyScore(summary: ScorecardSummary | null): number | null {
  if (!summary || typeof summary.score_pct !== 'number') return null;
  const pct = Math.max(0, Math.min(100, summary.score_pct));
  return Math.round(pct * 100) / 10000; // 0.55 from 55, 2 decimal places
}

/**
 * Deterministic 1-3 sentence digest of per-ticker commentary.
 * Format: "Score X% (W wins, P partials, N neutrals, L losses). Best: <ticker>
 *          (verdict α%) — <first-sentence-of-commentary>. Worst: <ticker>
 *          (verdict α%) — <first-sentence>."
 * Skips highlight clauses when no win/loss exists. Truncates commentary
 * fragments at 140 chars each to keep notes within a reasonable
 * accuracy_notes-as-text shape.
 */
function buildAccuracyNotes(
  summary: ScorecardSummary | null,
  scorecard: PerTickerScore[] | null,
): string {
  const parts: string[] = [];

  // Sentence 1 — aggregate score line
  if (summary && typeof summary.score_pct === 'number') {
    const w = summary.wins ?? 0;
    const p = summary.partials ?? 0;
    const n = summary.neutrals ?? 0;
    const l = summary.losses ?? 0;
    parts.push(`Score ${summary.score_pct}% (${w} wins, ${p} partials, ${n} neutrals, ${l} losses).`);
  }

  if (Array.isArray(scorecard) && scorecard.length > 0) {
    const sortable = scorecard
      .filter((r) => r && typeof r.alpha_pct === 'number' && r.ticker)
      .map((r) => ({
        ticker: r.ticker as string,
        verdict: r.verdict ?? 'unknown',
        alpha: r.alpha_pct as number,
        commentary: (r.commentary ?? '').trim(),
      }));

    if (sortable.length > 0) {
      // Best = highest alpha among wins; fallback = highest alpha overall
      const wins = sortable.filter((r) => r.verdict === 'win');
      const best = wins.length > 0
        ? wins.reduce((a, b) => (a.alpha >= b.alpha ? a : b))
        : sortable.reduce((a, b) => (a.alpha >= b.alpha ? a : b));

      // Worst = lowest alpha among losses; fallback = lowest alpha overall
      const losses = sortable.filter((r) => r.verdict === 'loss');
      const worst = losses.length > 0
        ? losses.reduce((a, b) => (a.alpha <= b.alpha ? a : b))
        : sortable.reduce((a, b) => (a.alpha <= b.alpha ? a : b));

      const firstSentence = (text: string): string => {
        const trimmed = text.split(/(?<=[.!?])\s+/)[0] || text;
        return trimmed.length > 140 ? trimmed.slice(0, 137) + '...' : trimmed;
      };

      const fmtAlpha = (a: number): string => (a >= 0 ? `+${a.toFixed(2)}%` : `${a.toFixed(2)}%`);

      // Only include highlight clauses when commentary is non-empty
      if (best && best.commentary) {
        parts.push(`Best: ${best.ticker} (${best.verdict} ${fmtAlpha(best.alpha)}) — ${firstSentence(best.commentary)}`);
      }
      // Only add a Worst clause when it's a different row than Best (avoid
      // dup on days with only one notable entry)
      if (worst && worst.ticker !== best?.ticker && worst.commentary) {
        parts.push(`Worst: ${worst.ticker} (${worst.verdict} ${fmtAlpha(worst.alpha)}) — ${firstSentence(worst.commentary)}`);
      }
    }
  }

  return parts.join(' ').trim() || '(no scorecard data)';
}

interface BridgeResult {
  brief_id: string;
  session_date: string;
  accuracy_score: number | null;
  accuracy_notes_length: number;
  status: 'bridged' | 'skipped_no_summary' | 'skipped_brief_missing' | 'update_failed';
  detail?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function bridgeOne(
  supabase: any,
  report: EodReportRow,
): Promise<BridgeResult> {
  if (!report.morning_brief_id) {
    return {
      brief_id: '',
      session_date: report.session_date,
      accuracy_score: null,
      accuracy_notes_length: 0,
      status: 'skipped_brief_missing',
    };
  }

  const score = deriveAccuracyScore(report.scorecard_summary);
  const notes = buildAccuracyNotes(report.scorecard_summary, report.morning_brief_scorecard);

  if (score === null && notes === '(no scorecard data)') {
    return {
      brief_id: report.morning_brief_id,
      session_date: report.session_date,
      accuracy_score: null,
      accuracy_notes_length: 0,
      status: 'skipped_no_summary',
    };
  }

  const { error: updateErr } = await supabase
    .from('ct_daily_briefs')
    .update({
      accuracy_score: score,
      accuracy_notes: notes,
    })
    .eq('id', report.morning_brief_id);

  if (updateErr) {
    return {
      brief_id: report.morning_brief_id,
      session_date: report.session_date,
      accuracy_score: score,
      accuracy_notes_length: notes.length,
      status: 'update_failed',
      detail: updateErr.message,
    };
  }

  // Decision journal — best-effort. Don't fail the bridge if it doesn't write.
  try {
    await supabase.from('ct_claude_decisions').insert({
      decision_type: 'brief_reflected_from_eod_scorecard',
      model_tier: 'deterministic',
      context_snapshot: {
        session_date: report.session_date,
        morning_brief_id: report.morning_brief_id,
        eod_report_id: report.id,
        scorecard_summary: report.scorecard_summary,
        per_ticker_count: Array.isArray(report.morning_brief_scorecard)
          ? report.morning_brief_scorecard.length
          : 0,
      },
      reasoning: `Bridged ct_eod_reports.morning_brief_scorecard → ct_daily_briefs.accuracy_score=${score} + accuracy_notes (${notes.length} chars) for session ${report.session_date}.`,
      outcome: `brief_id=${report.morning_brief_id} accuracy_score=${score}`,
      linked_brief_id: report.morning_brief_id,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
    });
  } catch {
    /* best effort */
  }

  return {
    brief_id: report.morning_brief_id,
    session_date: report.session_date,
    accuracy_score: score,
    accuracy_notes_length: notes.length,
    status: 'bridged',
  };
}

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

  let body: { session_date?: string; backfill?: boolean } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* empty body is fine */
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Build the scope of EOD reports to bridge
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query = (supabase.from('ct_eod_reports' as never) as any)
    .select('id, session_date, morning_brief_id, scorecard_summary, morning_brief_scorecard')
    .not('morning_brief_id', 'is', null);

  if (body.backfill) {
    query = query.order('session_date', { ascending: false });
  } else if (body.session_date && /^\d{4}-\d{2}-\d{2}$/.test(body.session_date)) {
    query = query.eq('session_date', body.session_date).limit(1);
  } else {
    // Default: today's session (the natural cron-fire path)
    const today = todayInET('America/New_York');
    query = query.eq('session_date', today).limit(1);
  }

  const { data, error } = await query;
  if (error) {
    return new Response(JSON.stringify({ error: 'query_failed', detail: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const reports = (data ?? []) as EodReportRow[];
  if (reports.length === 0) {
    return new Response(
      JSON.stringify({
        ok: true,
        bridged: 0,
        skipped: 0,
        failed: 0,
        results: [],
        message: 'no matching ct_eod_reports rows found — nothing to bridge',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const results: BridgeResult[] = [];
  for (const report of reports) {
    results.push(await bridgeOne(supabase, report));
  }

  const bridged = results.filter((r) => r.status === 'bridged').length;
  const skipped = results.filter((r) => r.status.startsWith('skipped')).length;
  const failed = results.filter((r) => r.status === 'update_failed').length;

  return new Response(
    JSON.stringify({
      ok: failed === 0,
      bridged,
      skipped,
      failed,
      results,
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
