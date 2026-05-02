/**
 * ct-eod-specialist-narrative — daily per-ticker narrative consumer.
 *
 * For each watchlist ticker, generates a 2-3 paragraph narrative covering
 * the day's specialist activity:
 *   - Specialist reads (lean trajectory, conviction shifts) from
 *     ct_specialist_reads
 *   - Flag fires today + grade outcomes (DTE-bucketed grader) from
 *     ct_flags + ct_flag_grades
 *   - Regime context from buildClaudeContext (flow_heatmap, pulse,
 *     news_causality, event_recency) audience='cotrader' tickerFocus=ticker
 *
 * Concurrency-limited at 3 parallel tickers (Sonnet spend control).
 * Writes to ct_eod_specialist_narratives — UPSERT on (session_date, ticker).
 *
 * READ-ONLY consumer of specialist context. Does NOT modify the recall
 * organ, the prompt, or any specialist context surface. C1 measurement-
 * window-safe.
 *
 * Auth: service_role only.
 *
 * Body (optional):
 *   { session_date?: 'YYYY-MM-DD',
 *     tickers?: string[],   // override watchlist for testing
 *     skip_slack?: boolean,
 *     triggered_by?: 'scheduled' | 'manual' | 'rerun' }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, calculateCost, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import { buildClaudeContext } from '../_shared/claudeReadSurface.ts';
import { getTemporalContext } from '../_shared/temporalContext.ts';
import { validateTemporalCoherence } from '../_shared/temporalValidator.ts';

const CONCURRENCY = 3;

interface SpecialistRead {
  ticker: string;
  direction_lean: string | null;
  conviction: number | null;
  read_text: string | null;
  flagged: boolean;
  flag_id: string | null;
  updated_at: string;
}

interface FlagWithGrade {
  id: string;
  instrument: string;
  direction: string | null;
  score: number | null;
  thesis: string | null;
  horizon_ts: string;
  created_at: string;
  status: string;
  ct_flag_grades: Array<{
    outcome: string;
    alpha_pct: number | null;
    price_change_pct: number | null;
    notes: string | null;
  }> | null;
}

function nyDateToday(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const yyyy = parts.find(p => p.type === 'year')?.value ?? '1970';
  const mm = parts.find(p => p.type === 'month')?.value ?? '01';
  const dd = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${yyyy}-${mm}-${dd}`;
}

const SYSTEM_PROMPT = `You are a senior trading-floor analyst writing the end-of-day per-ticker recap. Your reader is a single trader (James) who reads this once after close to understand what happened with each ticker today.

Voice: data-scientist, numbers-first, terse. Acknowledge uncertainty. No cheerleading. No "huge day" language. If a section's input is empty, say so plainly.

Format: 2-3 short paragraphs per ticker, plain prose. Lead with the open posture. Cover what flagged + how it graded if any grades landed today. End with the closing posture and what carries into tomorrow. No bullets, no markdown headers.

Specifics:
- Reference specific times in ET (e.g., "at 10:31 ET").
- Reference specific contracts when a flag fires (e.g., "NVDA 250P").
- Cite grade outcomes verbatim ("graded LOSS at -0.91% alpha").
- If specialist conviction shifted, note the trajectory ("conviction climbed from 38 to 71 by 14:00 ET").
- If no flags fired today, say "no flags today" — don't pad.
- If no grades landed today, say "no grades landed today" — don't invent.

Total length per ticker: 80-150 words.`;

interface NarrativeResult {
  ticker: string;
  ok: boolean;
  narrative?: string;
  reads_count?: number;
  flags_count?: number;
  grades_count?: number;
  composite_hr?: number | null;
  closing_lean?: string | null;
  closing_conviction?: number | null;
  cost_usd?: number;
  tokens_in?: number;
  tokens_out?: number;
  validator_ok?: boolean;
  error?: string;
}

async function buildNarrativeForTicker(
  supabase: SupabaseClient,
  ticker: string,
  sessionDate: string,
): Promise<NarrativeResult> {
  try {
    const dayStartIso = `${sessionDate}T00:00:00Z`;
    const gradeStartIso = new Date(Date.parse(dayStartIso) - 12 * 3600_000).toISOString();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sb: any = supabase;

    const [readsRes, flagsRes, gradesTodayRes] = await Promise.all([
      sb.from('ct_specialist_reads')
        .select('ticker, direction_lean, conviction, read_text, flagged, flag_id, updated_at')
        .eq('ticker', ticker)
        .gte('updated_at', dayStartIso)
        .order('updated_at', { ascending: true })
        .limit(50),
      sb.from('ct_flags')
        .select('id, instrument, direction, score, thesis, horizon_ts, created_at, status, ct_flag_grades(outcome, alpha_pct, price_change_pct, notes)')
        .eq('instrument', ticker)
        .gte('created_at', dayStartIso)
        .order('created_at', { ascending: true })
        .limit(50),
      sb.from('ct_flag_grades')
        .select('outcome, alpha_pct, price_change_pct, notes, graded_at, ct_flags!inner(instrument, direction, created_at)')
        .eq('ct_flags.instrument', ticker)
        .gte('graded_at', gradeStartIso)
        .order('graded_at', { ascending: true })
        .limit(50),
    ]);

    const reads = ((readsRes.data ?? []) as SpecialistRead[]);
    const flags = ((flagsRes.data ?? []) as FlagWithGrade[]);
    const grades = (gradesTodayRes.data ?? []) as Array<Record<string, unknown>>;

    const readsCount = reads.length;
    const flagsCount = flags.length;
    const gradesCount = grades.length;

    const lastRead = reads[reads.length - 1];
    const closingLean = lastRead?.direction_lean ?? null;
    const closingConviction = lastRead?.conviction ?? null;

    let wins = 0, partials = 0;
    for (const g of grades) {
      if (g.outcome === 'win') wins += 1;
      else if (g.outcome === 'partial') partials += 1;
    }
    const compositeHr = gradesCount > 0 ? (wins + 0.5 * partials) / gradesCount : null;

    const ctx = await buildClaudeContext(supabase, {
      audience: 'cotrader',
      consumerName: 'ct-eod-specialist-narrative',
      tickerFocus: ticker,
    });

    const userMessage = {
      ticker,
      session_date: sessionDate,
      reads: reads.map(r => ({
        time_et: r.updated_at,
        lean: r.direction_lean,
        conviction: r.conviction,
        flagged: r.flagged,
        flag_id: r.flag_id,
        read_excerpt: (r.read_text ?? '').slice(0, 400),
      })),
      flags_today: flags.map(f => ({
        flag_id: f.id,
        time_et: f.created_at,
        direction: f.direction,
        score: f.score,
        thesis: (f.thesis ?? '').slice(0, 300),
        horizon_ts: f.horizon_ts,
        status: f.status,
        grade: Array.isArray(f.ct_flag_grades) && f.ct_flag_grades.length > 0
          ? f.ct_flag_grades[0]
          : null,
      })),
      grades_landed_today: grades.map(g => ({
        outcome: g.outcome,
        alpha_pct: g.alpha_pct,
        price_change_pct: g.price_change_pct,
        notes: typeof g.notes === 'string' ? g.notes.slice(0, 200) : null,
        graded_at: g.graded_at,
      })),
      brain: {
        flow_heatmap: ctx.organs.flow_heatmap?.data ?? null,
        pulse: ctx.organs.pulse?.data ?? null,
        news_causality: ctx.organs.news_causality?.data ?? null,
        event_recency: ctx.organs.event_recency?.data ?? null,
        tape: ctx.organs.tape?.data ?? null,
      },
      summary: {
        reads_count: readsCount,
        flags_count: flagsCount,
        grades_count: gradesCount,
        composite_hr: compositeHr,
        closing_lean: closingLean,
        closing_conviction: closingConviction,
      },
    };

    const tctx = getTemporalContext();
    const claudeStart = Date.now();
    const claudeResp = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: tctx.temporalAnchorPreamble + '\n\n' + SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(userMessage) }],
      max_tokens: 1200,
      temperature: 0.3,
    });

    const tokensIn = claudeResp.usage?.input_tokens ?? 0;
    const tokensOut = claudeResp.usage?.output_tokens ?? 0;
    const costUsd = calculateCost(CLAUDE_MODELS.sonnet, { input_tokens: tokensIn, output_tokens: tokensOut });

    let narrativeText = '';
    for (const block of claudeResp.content ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b = block as any;
      if (b.type === 'text' && typeof b.text === 'string') narrativeText += b.text;
    }
    narrativeText = narrativeText.trim();

    let validatorOk = true;
    let validatorWarnings: Array<{ quote: string; issue: string; severity: 'critical' | 'warning' }> = [];
    if (narrativeText) {
      try {
        const v = await validateTemporalCoherence(narrativeText, sessionDate);
        validatorOk = v.ok;
        validatorWarnings = v.contradictions;
        const critical = v.contradictions.filter(c => c.severity === 'critical');
        if (critical.length > 0) {
          console.warn(`[ct-eod-specialist-narrative] ${ticker}: ${critical.length} CRITICAL temporal contradiction(s)`,
            JSON.stringify(critical));
        }
      } catch (e) {
        console.warn(`[ct-eod-specialist-narrative] ${ticker} validator threw:`, String(e));
      }
    }

    logClaudeUsage(supabase as unknown as { from: (t: string) => { insert: (r: Record<string, unknown>) => Promise<unknown> } }, {
      source: 'ct-eod-specialist-narrative',
      model: CLAUDE_MODELS.sonnet,
      usage: { input_tokens: tokensIn, output_tokens: tokensOut },
      duration_ms: Date.now() - claudeStart,
      metadata: { ticker, session_date: sessionDate },
    });

    const { error: upsertErr } = await sb
      .from('ct_eod_specialist_narratives')
      .upsert({
        session_date: sessionDate,
        ticker,
        narrative: narrativeText,
        reads_count: readsCount,
        flags_count: flagsCount,
        grades_count: gradesCount,
        composite_hit_rate: compositeHr,
        closing_lean: closingLean,
        closing_conviction: closingConviction,
        generated_at: new Date().toISOString(),
        generated_by_model: CLAUDE_MODELS.sonnet,
        cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        validator_warnings: { ok: validatorOk, contradictions: validatorWarnings },
        brain_organs_used: Object.keys(ctx.organs ?? {}),
      }, { onConflict: 'session_date,ticker' });

    if (upsertErr) return { ticker, ok: false, error: `upsert: ${upsertErr.message}` };

    return {
      ticker, ok: true, narrative: narrativeText,
      reads_count: readsCount, flags_count: flagsCount, grades_count: gradesCount,
      composite_hr: compositeHr, closing_lean: closingLean, closing_conviction: closingConviction,
      cost_usd: costUsd, tokens_in: tokensIn, tokens_out: tokensOut, validator_ok: validatorOk,
    };
  } catch (e) {
    const msg = e instanceof ClaudeError
      ? `Claude ${e.status}: ${e.message}`
      : (e instanceof Error ? e.message : String(e));
    return { ticker, ok: false, error: msg };
  }
}

async function runConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const chunkResults = await Promise.all(chunk.map(fn));
    results.push(...chunkResults);
  }
  return results;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: { session_date?: string; tickers?: string[]; skip_slack?: boolean; triggered_by?: string } = {};
  try {
    if (req.method === 'POST') {
      const text = await req.text();
      if (text && text.trim()) body = JSON.parse(text);
    }
  } catch { /* ignore */ }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const sessionDate = (typeof body.session_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.session_date))
    ? body.session_date
    : nyDateToday(new Date());

  const tickers = Array.isArray(body.tickers) && body.tickers.length > 0
    ? body.tickers.map(t => String(t).toUpperCase())
    : await getWatchlist(supabase);

  const startedAt = Date.now();
  const results = await runConcurrent(tickers, CONCURRENCY, (t) =>
    buildNarrativeForTicker(supabase, t, sessionDate));

  const ok = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  const totalCost = results.reduce((s, r) => s + (r.cost_usd ?? 0), 0);
  const totalTokensIn = results.reduce((s, r) => s + (r.tokens_in ?? 0), 0);
  const totalTokensOut = results.reduce((s, r) => s + (r.tokens_out ?? 0), 0);

  return new Response(JSON.stringify({
    ok: failed.length === 0,
    session_date: sessionDate,
    tickers_total: tickers.length,
    succeeded: ok,
    failed: failed.length,
    failures: failed.map(f => ({ ticker: f.ticker, error: f.error })),
    cost_usd: Math.round(totalCost * 1_000_000) / 1_000_000,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    elapsed_ms: Date.now() - startedAt,
    triggered_by: body.triggered_by ?? 'manual',
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
