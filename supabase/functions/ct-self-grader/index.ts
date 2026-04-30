/**
 * ct-self-grader — retrospective self-critique of Claude's own reasoning.
 *
 * Cron: every 2 hours. Finds observations/flags/alerts created 2-24hr ago
 * that don't yet have a ct_self_regrades row. For each (up to 5 per run):
 *   1. Build context: original row + subsequent flow/dp/observations since
 *      creation, price-then-vs-now, grader verdict if available.
 *   2. Call Claude Sonnet with the self-grader prompt.
 *   3. Parse JSON, insert ct_self_regrades row.
 *
 * The grader scores CALLS against prices. The self-grader scores REASONING
 * against what actually happened. Meta-referee.
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { CT_SELF_GRADER_SYSTEM_PROMPT, CT_SELF_GRADER_PROMPT_VERSION } from '../_shared/selfGraderPrompt.ts';
import { getTemporalContext, tagIsoTimestamp } from '../_shared/temporalContext.ts';
import { validateTemporalCoherence } from '../_shared/temporalValidator.ts';
import { getFlowHeatmapContext } from '../_shared/flowHeatmapContext.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

type SubjectType = 'observation' | 'flag' | 'alert';

interface Subject {
  subject_type: SubjectType;
  subject_id: string;
  instruments: string[];
  direction: string | null;
  conviction: number | null;
  horizon: string | null;
  observation_text: string;
  glance: string[] | null;
  up_case: string | null;
  down_case: string | null;
  self_assessment: Record<string, unknown> | null;
  entry_prices: Record<string, number | null>;
  created_at: string;
}

interface RegradeJson {
  retrospective_confidence?: number;
  retrospective_reasoning_quality?: number;
  what_i_got_right?: string;
  what_i_got_wrong?: string;
  how_id_rewrite?: string;
}

function parseJson(raw: string): RegradeJson | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned) as RegradeJson;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]) as RegradeJson; } catch { /* pass */ }
    }
    return null;
  }
}

function clamp1to5(n: unknown): number | null {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(1, Math.min(5, Math.round(x)));
}

async function fetchCandidates(supabase: SupabaseClient): Promise<Subject[]> {
  const now = Date.now();
  const from = new Date(now - 24 * 3600_000).toISOString();
  const to   = new Date(now -  2 * 3600_000).toISOString();

  // Pull any already-regraded subject_ids per type so we can exclude them.
  const { data: existing } = await supabase
    .from('ct_self_regrades')
    .select('subject_type, subject_id');
  const done = new Set<string>((existing ?? []).map(r => `${r.subject_type}:${r.subject_id}`));

  const out: Subject[] = [];

  // Observations (no entry_prices column — will fill empty)
  const { data: obs } = await supabase
    .from('ct_observations')
    .select('id, instruments, direction, observation, glance, up_case, down_case, self_assessment, created_at')
    .gte('created_at', from)
    .lte('created_at', to)
    .order('created_at', { ascending: true })
    .limit(50);
  for (const r of (obs ?? []) as Array<Record<string, unknown>>) {
    const key = `observation:${r.id as string}`;
    if (done.has(key)) continue;
    out.push({
      subject_type: 'observation',
      subject_id: r.id as string,
      instruments: (r.instruments as string[]) ?? [],
      direction: (r.direction as string) ?? null,
      conviction: null,
      horizon: null,
      observation_text: (r.observation as string) ?? '',
      glance: (r.glance as string[]) ?? null,
      up_case: (r.up_case as string) ?? null,
      down_case: (r.down_case as string) ?? null,
      self_assessment: (r.self_assessment as Record<string, unknown>) ?? null,
      entry_prices: {},
      created_at: r.created_at as string,
    });
  }

  // Flags
  const { data: flags } = await supabase
    .from('ct_flags')
    .select('id, instruments, direction, conviction, horizon, full_reasoning, glance, up_case, down_case, self_assessment, entry_prices, created_at')
    .gte('created_at', from)
    .lte('created_at', to)
    .order('created_at', { ascending: true })
    .limit(50);
  for (const r of (flags ?? []) as Array<Record<string, unknown>>) {
    const key = `flag:${r.id as string}`;
    if (done.has(key)) continue;
    out.push({
      subject_type: 'flag',
      subject_id: r.id as string,
      instruments: (r.instruments as string[]) ?? [],
      direction: (r.direction as string) ?? null,
      conviction: (r.conviction as number) ?? null,
      horizon: (r.horizon as string) ?? null,
      observation_text: (r.full_reasoning as string) ?? '',
      glance: (r.glance as string[]) ?? null,
      up_case: (r.up_case as string) ?? null,
      down_case: (r.down_case as string) ?? null,
      self_assessment: (r.self_assessment as Record<string, unknown>) ?? null,
      entry_prices: (r.entry_prices as Record<string, number | null>) ?? {},
      created_at: r.created_at as string,
    });
  }

  // Alerts
  const { data: alerts } = await supabase
    .from('ct_alerts')
    .select('id, instruments, direction, conviction, horizon, full_reasoning, glance, up_case, down_case, self_assessment, entry_prices, created_at')
    .gte('created_at', from)
    .lte('created_at', to)
    .order('created_at', { ascending: true })
    .limit(50);
  for (const r of (alerts ?? []) as Array<Record<string, unknown>>) {
    const key = `alert:${r.id as string}`;
    if (done.has(key)) continue;
    out.push({
      subject_type: 'alert',
      subject_id: r.id as string,
      instruments: (r.instruments as string[]) ?? [],
      direction: (r.direction as string) ?? null,
      conviction: (r.conviction as number) ?? null,
      horizon: (r.horizon as string) ?? null,
      observation_text: (r.full_reasoning as string) ?? '',
      glance: (r.glance as string[]) ?? null,
      up_case: (r.up_case as string) ?? null,
      down_case: (r.down_case as string) ?? null,
      self_assessment: (r.self_assessment as Record<string, unknown>) ?? null,
      entry_prices: (r.entry_prices as Record<string, number | null>) ?? {},
      created_at: r.created_at as string,
    });
  }

  // Oldest first — 24hr-old items have more context + a grader verdict available
  out.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return out;
}

async function buildContext(supabase: SupabaseClient, subject: Subject) {
  const createdAt = subject.created_at;
  const tickers = subject.instruments;

  // Subsequent flow (last 10 highest-premium prints on relevant tickers since created_at)
  const { data: flow } = tickers.length > 0
    ? await supabase
        .from('ct_flow_alerts')
        .select('ticker, side, strike, expiry, premium, size, is_ask, executed_at')
        .gte('ingested_at', createdAt)
        .in('ticker', tickers)
        .order('premium', { ascending: false })
        .limit(10)
    : { data: [] };

  // Subsequent dark pool
  const { data: dp } = tickers.length > 0
    ? await supabase
        .from('ct_dark_pool_prints')
        .select('ticker, size, price, notional_value, executed_at')
        .gte('ingested_at', createdAt)
        .in('ticker', tickers)
        .order('notional_value', { ascending: false })
        .limit(10)
    : { data: [] };

  // Subsequent observations on same tickers
  const { data: subsequentObs } = tickers.length > 0
    ? await supabase
        .from('ct_observations')
        .select('id, instruments, direction, glance, created_at')
        .gt('created_at', createdAt)
        .overlaps('instruments', tickers)
        .order('created_at', { ascending: true })
        .limit(10)
    : { data: [] };

  // Price then vs now — take latest heartbeat's snapshot; we embed condensed
  // state there. This is a best-effort lookup, not ground truth.
  const { data: latestHb } = await supabase
    .from('ct_heartbeats')
    .select('current_reads, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const currentPrices: Record<string, number | null> = {};
  const snapshot = (latestHb?.current_reads as Record<string, unknown> | undefined)?._snapshot as { per_ticker?: Record<string, { price?: number | null }> } | undefined;
  if (snapshot?.per_ticker) {
    for (const t of tickers) {
      currentPrices[t] = snapshot.per_ticker[t]?.price ?? null;
    }
  }

  // Grader verdict if flag/alert and graded
  let graderVerdict: { verdict: string; actual_return_pct: number | null; actual_direction: string | null } | null = null;
  if (subject.subject_type === 'flag' || subject.subject_type === 'alert') {
    const { data: grade } = await supabase
      .from('ct_grades')
      .select('verdict, actual_return_pct, actual_direction')
      .eq('subject_type', subject.subject_type)
      .eq('subject_id', subject.subject_id)
      .limit(1)
      .maybeSingle();
    if (grade) {
      graderVerdict = {
        verdict: grade.verdict as string,
        actual_return_pct: (grade.actual_return_pct as number) ?? null,
        actual_direction: (grade.actual_direction as string) ?? null,
      };
    }
  }

  const hoursSince = (Date.now() - Date.parse(createdAt)) / 3600_000;

  return {
    original: {
      subject_type: subject.subject_type,
      subject_id: subject.subject_id,
      instruments: subject.instruments,
      direction: subject.direction,
      conviction: subject.conviction,
      horizon: subject.horizon,
      observation: subject.observation_text,
      glance: subject.glance,
      up_case: subject.up_case,
      down_case: subject.down_case,
      self_assessment: subject.self_assessment,
      entry_prices: subject.entry_prices,
      created_at: subject.created_at,
    },
    time_since_hours: Number(hoursSince.toFixed(1)),
    subsequent_flow: flow ?? [],
    subsequent_dark_pool: dp ?? [],
    subsequent_observations: subsequentObs ?? [],
    price_then_vs_now: {
      then: subject.entry_prices,
      now: currentPrices,
    },
    grader_verdict: graderVerdict,
  };
}

async function regradeSubject(
  supabase: SupabaseClient,
  subject: Subject,
  tctx: ReturnType<typeof getTemporalContext>,
  flowHeatmapPerTicker: Array<{ ticker: string; stacks: Array<{ expiry_bucket_week: string; value: number; source_alert_count: number }> }>,
  flowHeatmapMeta: { generated_at: string; lookback_hours: number; math_mode: string },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await buildContext(supabase, subject);

  // Pre-tag the subject's timestamps + the original observation timestamp.
  // The subject was created hours ago — without anchoring, Sonnet can frame
  // it as "today" and produce yesterday-as-today retrospectives.
  const ctxWithAnchors = {
    ...ctx,
    session_date: tctx.session_date,
    session_day_name: tctx.session_day_name,
    now_et: tctx.now_et,
    original: {
      ...ctx.original,
      created_at_tag: tagIsoTimestamp(ctx.original.created_at, tctx.session_date),
    },
    flow_heatmap_per_ticker: flowHeatmapPerTicker,
    flow_heatmap_meta: flowHeatmapMeta,
  };
  const userMessage = JSON.stringify(ctxWithAnchors);

  let claudeText = '';
  const claudeCallStart = Date.now();
  let response: Awaited<ReturnType<typeof callClaude>> | null = null;
  try {
    response = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      // Self-grader emits prose narrative critique (Sonnet) — full preamble
      // applies. See _shared/temporalContext.ts.
      system: tctx.temporalAnchorPreamble + '\n\n' + CT_SELF_GRADER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 1500,
      temperature: 0.3,
    });
    claudeText = parseTextContent(response);
  } catch (e) {
    const msg = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
    return { ok: false, error: msg };
  }

  const parsed = parseJson(claudeText);
  if (!parsed) {
    // Log the failed call with the (empty) validator warnings before bailing.
    if (response) {
      logClaudeUsage(supabase, {
        source: 'ct-self-grader',
        model: CLAUDE_MODELS.sonnet,
        usage: response.usage,
        duration_ms: Date.now() - claudeCallStart,
        metadata: {
          subject_id: subject.subject_id,
          subject_type: subject.subject_type,
          prompt_version: CT_SELF_GRADER_PROMPT_VERSION,
          parse_failed: true,
        },
      });
    }
    return { ok: false, error: `unparsable response (${claudeText.length} chars)` };
  }

  // Temporal-coherence validator (best-effort). Validate the critique strings.
  // ct_self_regrades has no JSONB catch-all column — persist warnings into
  // ct_claude_usage.metadata instead (existing JSONB on the usage log row).
  let validatorOk = true;
  let validatorContradictions: Array<{ quote: string; issue: string; severity: 'critical' | 'warning' }> = [];
  const narrativeForValidation = [
    parsed.what_i_got_right ?? '',
    parsed.what_i_got_wrong ?? '',
    parsed.how_id_rewrite ?? '',
  ].filter(s => typeof s === 'string' && s.trim().length > 0).join('\n\n---\n\n');
  if (narrativeForValidation) {
    try {
      const validation = await validateTemporalCoherence(narrativeForValidation, tctx.session_date, {
        tickerContext: subject.instruments.join(', ') || undefined,
      });
      validatorOk = validation.ok;
      validatorContradictions = validation.contradictions;
      const critical = validation.contradictions.filter(c => c.severity === 'critical');
      if (critical.length > 0) {
        console.warn(
          `[ct-self-grader] temporal validator flagged ${critical.length} CRITICAL contradiction(s) on ${subject.subject_type}:${subject.subject_id} for session ${tctx.session_date}:`,
          JSON.stringify(critical),
        );
      } else if (!validation.ok && validation.contradictions.length > 0) {
        console.warn(
          `[ct-self-grader] temporal validator flagged ${validation.contradictions.length} warning(s):`,
          JSON.stringify(validation.contradictions),
        );
      }
    } catch (e) {
      console.warn('[ct-self-grader] temporal validator threw (non-blocking):', String(e));
    }
  }
  const temporalValidatorWarnings = {
    ok: validatorOk,
    session_date: tctx.session_date,
    contradiction_count: validatorContradictions.length,
    critical_count: validatorContradictions.filter(c => c.severity === 'critical').length,
    contradictions: validatorContradictions,
  };

  // Now log the successful Claude call with validator warnings stuffed into
  // metadata (JSONB) — the row in ct_claude_usage gives operators a join key
  // back to the regrade.
  logClaudeUsage(supabase, {
    source: 'ct-self-grader',
    model: CLAUDE_MODELS.sonnet,
    usage: response!.usage,
    duration_ms: Date.now() - claudeCallStart,
    metadata: {
      subject_id: subject.subject_id,
      subject_type: subject.subject_type,
      prompt_version: CT_SELF_GRADER_PROMPT_VERSION,
      flow_heatmap_per_ticker: flowHeatmapPerTicker,
      flow_heatmap_meta: flowHeatmapMeta,
      temporal_validator_warnings: temporalValidatorWarnings,
    },
  });

  const originalSa = (subject.self_assessment ?? {}) as Record<string, unknown>;
  const row = {
    subject_type: subject.subject_type,
    subject_id: subject.subject_id,
    original_confidence: clamp1to5(originalSa.confidence),
    original_reasoning_quality: clamp1to5(originalSa.reasoning_quality),
    retrospective_confidence: clamp1to5(parsed.retrospective_confidence),
    retrospective_reasoning_quality: clamp1to5(parsed.retrospective_reasoning_quality),
    what_i_got_right: parsed.what_i_got_right ?? null,
    what_i_got_wrong: parsed.what_i_got_wrong ?? null,
    how_id_rewrite: parsed.how_id_rewrite ?? null,
    grader_verdict: ctx.grader_verdict?.verdict ?? null,
    prompt_version: CT_SELF_GRADER_PROMPT_VERSION,
  };

  const { error: insertErr } = await supabase
    .from('ct_self_regrades')
    .insert(row);
  if (insertErr) return { ok: false, error: insertErr.message };

  return { ok: true };
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const startedAt = Date.now();

  try {
    // Temporal anchor + flow heatmap — pulled once per run, reused across
    // every subject. Self-grader writes prose critique (Sonnet) so the FULL
    // temporalAnchorPreamble applies. See _shared/temporalContext.ts.
    const tctx = getTemporalContext();
    const watchlistForHeatmap = await getWatchlist(supabase);
    const flowHeatmapContext = await getFlowHeatmapContext(supabase, watchlistForHeatmap);
    const flowHeatmapMeta = {
      generated_at: flowHeatmapContext.generated_at,
      lookback_hours: flowHeatmapContext.lookback_hours,
      math_mode: flowHeatmapContext.math_mode,
    };

    const candidates = await fetchCandidates(supabase);
    const batch = candidates.slice(0, 5);

    let regraded = 0;
    const errors: string[] = [];

    for (const subject of batch) {
      const { ok, error } = await regradeSubject(supabase, subject, tctx, flowHeatmapContext.per_ticker, flowHeatmapMeta);
      if (ok) regraded++;
      else if (error) errors.push(`${subject.subject_type}:${subject.subject_id.slice(0, 8)} — ${error}`);
    }

    return new Response(JSON.stringify({
      success: true,
      candidates: candidates.length,
      batched: batch.length,
      regraded,
      errors,
      duration_ms: Date.now() - startedAt,
      prompt_version: CT_SELF_GRADER_PROMPT_VERSION,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ct-self-grader] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'self-grader failed',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
