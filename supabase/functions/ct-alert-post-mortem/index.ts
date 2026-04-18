/**
 * ct-alert-post-mortem — forensic autopsy on wrong alerts / flags.
 *
 * The referee (ct-grader) labels each alert right/partial/wrong at horizon
 * close. Wrong calls sit there unexplained. This function walks the ungraded
 * wrong set and, for each, asks Haiku: what did you miss, which axis was
 * the false signal, which known bias showed up, what's the lesson, how
 * confident are you it generalizes?
 *
 * Results land in ct_alert_post_mortems (deduped by alert_id + alert_kind).
 * The bias feedback loop writes confirmation counts back to ct_biases:
 *   - existing active bias matched → bump observed_count + last_confirmed
 *   - new bias cited → INSERT severity=3 provisional (SUPERSEDE/RETIRE stays
 *     with ct-bias-booth's weekly meta view — we only confirm or seed here)
 *
 * Cron: every 30 min. Also callable on-demand from ct-grader with
 * { alert_id, alert_kind } in body to write a single row synchronously.
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, calculateCost, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { POST_MORTEM_ALERT_SYSTEM } from '../_shared/ctPrompts.ts';

const MAX_PER_RUN = 10;         // bound Claude calls per cron tick
const AXIS_VALUES = ['A','B','C','D','E','F'] as const;
type AxisLetter = typeof AXIS_VALUES[number];

type AlertKind = 'alert' | 'flag';

interface WrongTarget {
  grade_id: string;
  alert_id: string;
  alert_kind: AlertKind;
}

interface PostMortemJson {
  what_missed: string;
  weakest_evidence_axis: string;
  bias_implicated: string;
  lesson: string;
  confidence_in_lesson: number;
}

// ---------------------------------------------------------------------------
// Pull wrong grades that don't already have a post-mortem.
// ---------------------------------------------------------------------------
async function fetchUnautopsiedWrongs(supabase: SupabaseClient): Promise<WrongTarget[]> {
  // 1) Existing post-mortems → skip set. Recency bound: wrong grades in the
  // grade pull window top out at ~200 newest, so a 1000-row skip list is
  // more than enough to dedupe without scanning a year of history.
  const { data: existing, error: exErr } = await supabase
    .from('ct_alert_post_mortems')
    .select('alert_id, alert_kind')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (exErr) {
    console.warn('[ct-alert-post-mortem] existing fetch:', exErr.message);
  }
  const skip = new Set<string>();
  for (const r of existing ?? []) {
    skip.add(`${r.alert_kind}:${r.alert_id}`);
  }

  // 2) Wrong grades over flags / alerts. Pull a generous window — dedupe via skip.
  const { data: grades, error: gErr } = await supabase
    .from('ct_grades')
    .select('id, subject_type, subject_id, graded_at')
    .eq('verdict', 'wrong')
    .in('subject_type', ['alert', 'flag'])
    .order('graded_at', { ascending: false })
    .limit(200);
  if (gErr) {
    console.warn('[ct-alert-post-mortem] grade fetch:', gErr.message);
    return [];
  }

  const targets: WrongTarget[] = [];
  for (const g of grades ?? []) {
    const kind = g.subject_type as AlertKind;
    const key = `${kind}:${g.subject_id}`;
    if (skip.has(key)) continue;
    targets.push({
      grade_id: g.id as string,
      alert_id: g.subject_id as string,
      alert_kind: kind,
    });
    if (targets.length >= MAX_PER_RUN) break;
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Gather full context for one wrong alert — alert row + grade + prior 2 on
// same ticker + active biases + expected_move band + news sentiment.
// ---------------------------------------------------------------------------
async function gatherContext(supabase: SupabaseClient, target: WrongTarget) {
  const table = target.alert_kind === 'alert' ? 'ct_alerts' : 'ct_flags';

  const { data: alertRow, error: aErr } = await supabase
    .from(table)
    .select('id, instruments, direction, conviction, evidence_axes, glance, full_reasoning, horizon, horizon_end, expected_move, created_at, alert_trigger')
    .eq('id', target.alert_id)
    .maybeSingle();
  if (aErr || !alertRow) {
    throw new Error(`alert lookup failed: ${aErr?.message ?? 'not found'}`);
  }

  const { data: gradeRow, error: gErr } = await supabase
    .from('ct_grades')
    .select('id, instrument, claimed_direction, actual_direction, actual_return_pct, calibration_delta, entry_price, exit_price, notes, graded_at')
    .eq('id', target.grade_id)
    .maybeSingle();
  if (gErr || !gradeRow) {
    throw new Error(`grade lookup failed: ${gErr?.message ?? 'not found'}`);
  }

  const instruments = Array.isArray(alertRow.instruments) ? alertRow.instruments as string[] : [];
  const primaryTicker = (gradeRow.instrument as string | null) ?? instruments[0] ?? null;

  // Prior 2 alerts on same ticker (the same kind) — continuity.
  let prior: Array<Record<string, unknown>> = [];
  if (primaryTicker) {
    const { data: priorRows } = await supabase
      .from(table)
      .select('id, direction, conviction, glance, created_at, evidence_axes')
      .contains('instruments', [primaryTicker])
      .lt('created_at', alertRow.created_at as string)
      .order('created_at', { ascending: false })
      .limit(2);
    prior = priorRows ?? [];
  }

  // Active biases — the Claude feedback loop anchor. Cited bias strings are
  // matched against these pattern names (case-insensitive substring).
  const { data: biases } = await supabase
    .from('ct_biases')
    .select('id, pattern, severity, observed_count, instruments')
    .eq('active', true)
    .order('severity', { ascending: false })
    .limit(20);

  // expected_move band — did reality fall within the band?
  const em = (alertRow.expected_move ?? null) as Record<string, unknown> | null;
  const actualPct = Number(gradeRow.actual_return_pct ?? 0);
  let within_band: boolean | null = null;
  if (em && typeof em === 'object') {
    const lower = Number((em.lower_pct ?? em.em_low_pct ?? em.lower ?? NaN));
    const upper = Number((em.upper_pct ?? em.em_high_pct ?? em.upper ?? NaN));
    if (Number.isFinite(lower) && Number.isFinite(upper)) {
      within_band = actualPct >= lower && actualPct <= upper;
    }
  }

  // News sentiment at alert time (best effort) — per-ticker, same session day.
  let news_sentiment: Record<string, unknown> | null = null;
  if (primaryTicker) {
    const createdAt = new Date(alertRow.created_at as string);
    const windowStart = new Date(createdAt.getTime() - 12 * 3600_000).toISOString();
    const { data: newsRows } = await supabase
      .from('ct_news_analyses')
      .select('sentiment, sentiment_magnitude, sentiment_reasoning, created_at')
      .eq('instrument', primaryTicker)
      .gte('created_at', windowStart)
      .lte('created_at', alertRow.created_at as string)
      .order('created_at', { ascending: false })
      .limit(3);
    if (newsRows && newsRows.length > 0) {
      news_sentiment = { recent: newsRows };
    }
  }

  return { alertRow, gradeRow, prior, biases: biases ?? [], within_band, news_sentiment, primaryTicker };
}

// ---------------------------------------------------------------------------
// Call Haiku with the post-mortem prompt.
// ---------------------------------------------------------------------------
async function callPostMortem(
  supabase: SupabaseClient,
  target: WrongTarget,
  ctx: Awaited<ReturnType<typeof gatherContext>>,
): Promise<{ pm: PostMortemJson; tokens_in: number; tokens_out: number; cost: number; duration_ms: number } | null> {
  const payload = {
    alert: {
      id: ctx.alertRow.id,
      kind: target.alert_kind,
      instruments: ctx.alertRow.instruments,
      primary_ticker: ctx.primaryTicker,
      direction: ctx.alertRow.direction,
      conviction: ctx.alertRow.conviction,
      evidence_axes: ctx.alertRow.evidence_axes ?? [],
      glance: ctx.alertRow.glance ?? [],
      full_reasoning: ctx.alertRow.full_reasoning,
      horizon: ctx.alertRow.horizon,
      alert_trigger: ctx.alertRow.alert_trigger ?? null,
      created_at: ctx.alertRow.created_at,
    },
    outcome: {
      actual_direction: ctx.gradeRow.actual_direction,
      actual_return_pct: ctx.gradeRow.actual_return_pct,
      claimed_direction: ctx.gradeRow.claimed_direction,
      calibration_delta: ctx.gradeRow.calibration_delta,
      entry_price: ctx.gradeRow.entry_price,
      exit_price: ctx.gradeRow.exit_price,
      within_expected_move_band: ctx.within_band,
    },
    expected_move: ctx.alertRow.expected_move ?? null,
    prior_alerts_on_same_ticker: ctx.prior,
    active_biases: (ctx.biases as Array<Record<string, unknown>>).map(b => ({
      id: b.id, pattern: b.pattern, severity: b.severity, observed_count: b.observed_count, instruments: b.instruments,
    })),
    news_sentiment: ctx.news_sentiment,
    note: 'Return ONLY the JSON described in the system prompt. No prose, no markdown wrapper.',
  };

  const started = Date.now();
  let res;
  try {
    res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: POST_MORTEM_ALERT_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
      max_tokens: 600,
      temperature: 0.2,
    });
  } catch (e) {
    const msg = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
    console.warn(`[ct-alert-post-mortem] Claude failed alert=${target.alert_id}: ${msg}`);
    return null;
  }
  const duration_ms = Date.now() - started;

  const raw = parseTextContent(res);
  const cleaned = raw.replace(/^\s*```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim();
  let parsed: PostMortemJson;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn(`[ct-alert-post-mortem] invalid json alert=${target.alert_id} raw=${raw.slice(0, 200)}`);
    return null;
  }

  const tokens_in = res.usage?.input_tokens ?? 0;
  const tokens_out = res.usage?.output_tokens ?? 0;
  const cost = calculateCost(CLAUDE_MODELS.haiku, { input_tokens: tokens_in, output_tokens: tokens_out });

  logClaudeUsage(supabase, {
    source: 'ct-alert-post-mortem',
    model: CLAUDE_MODELS.haiku,
    usage: res.usage,
    duration_ms,
    metadata: { alert_id: target.alert_id, alert_kind: target.alert_kind, grade_id: target.grade_id },
  });

  return { pm: parsed, tokens_in, tokens_out, cost, duration_ms };
}

// ---------------------------------------------------------------------------
// Bias feedback loop — match Claude's cited bias against ct_biases.
// Returns 'confirmed' if an existing active bias matched, 'seeded' if we
// inserted a new one, 'none' if Claude said 'none' / empty / noisy.
// ---------------------------------------------------------------------------
async function confirmOrSeedBias(
  supabase: SupabaseClient,
  citedRaw: string | null | undefined,
  instruments: string[] | null,
): Promise<'confirmed' | 'seeded' | 'none'> {
  const cited = (citedRaw ?? '').trim();
  if (!cited || /^none$/i.test(cited)) return 'none';

  // Pull active biases once, case-insensitive substring match either direction.
  const { data: active, error } = await supabase
    .from('ct_biases')
    .select('id, pattern, observed_count')
    .eq('active', true);
  if (error) {
    console.warn('[ct-alert-post-mortem] bias lookup failed:', error.message);
    return 'none';
  }

  const citedLower = cited.toLowerCase();
  const match = (active ?? []).find(b => {
    const p = String(b.pattern ?? '').toLowerCase();
    if (!p) return false;
    return p.includes(citedLower) || citedLower.includes(p);
  });

  const now = new Date().toISOString();

  if (match) {
    const current = Number(match.observed_count ?? 0);
    await supabase
      .from('ct_biases')
      .update({ observed_count: current + 1, last_confirmed: now })
      .eq('id', match.id);
    return 'confirmed';
  }

  // Seed a new provisional bias at severity 3. ct-bias-booth's weekly
  // meta view will upgrade / supersede / retire based on replication.
  const { error: insErr } = await supabase.from('ct_biases').insert({
    pattern: cited,
    evidence: `seeded by ct-alert-post-mortem on ${now} (provisional — awaits meta confirmation)`,
    instruments: instruments && instruments.length > 0 ? instruments : null,
    severity: 3,
    active: true,
    first_seen_at: now,
    last_confirmed: now,
    observed_count: 1,
  });
  if (insErr) {
    console.warn('[ct-alert-post-mortem] bias seed failed:', insErr.message);
    return 'none';
  }
  return 'seeded';
}

// ---------------------------------------------------------------------------
// Process one target: context → Claude → insert → bias feedback.
// ---------------------------------------------------------------------------
async function processTarget(supabase: SupabaseClient, target: WrongTarget) {
  const ctx = await gatherContext(supabase, target);

  const result = await callPostMortem(supabase, target, ctx);
  if (!result) return { ok: false, reason: 'claude_failed' as const };

  const pm = result.pm;

  // Normalize + guardrails.
  const citedAxis = String(pm.weakest_evidence_axis ?? '').trim().toUpperCase();
  const axisLetter: AxisLetter | null =
    (AXIS_VALUES as readonly string[]).includes(citedAxis) ? (citedAxis as AxisLetter) : null;

  const alertAxes = Array.isArray(ctx.alertRow.evidence_axes)
    ? (ctx.alertRow.evidence_axes as string[]).map(a => a.toUpperCase())
    : [];
  const misremembered = axisLetter != null && alertAxes.length > 0 && !alertAxes.includes(axisLetter);
  if (misremembered) {
    console.warn(`[ct-alert-post-mortem] axis_misremembered alert=${target.alert_id} cited=${axisLetter} actual=${alertAxes.join(',')}`);
  }

  const confidence = Math.max(1, Math.min(5, Math.round(Number(pm.confidence_in_lesson ?? 3))));
  const lesson = String(pm.lesson ?? '').trim();
  const whatMissed = String(pm.what_missed ?? '').trim();

  if (!lesson || !whatMissed) {
    console.warn(`[ct-alert-post-mortem] missing lesson/what_missed alert=${target.alert_id}`);
    return { ok: false, reason: 'empty_fields' as const };
  }

  const { error: insErr } = await supabase.from('ct_alert_post_mortems').insert({
    alert_id: target.alert_id,
    alert_kind: target.alert_kind,
    grade_id: target.grade_id,
    what_missed: whatMissed,
    weakest_evidence_axis: axisLetter,
    bias_implicated: (pm.bias_implicated ?? '').trim() || null,
    lesson,
    confidence_in_lesson: confidence,
    axis_misremembered: misremembered,
    tokens_used: (result.tokens_in + result.tokens_out) || null,
    cost_usd: Number(result.cost.toFixed(6)),
    model: CLAUDE_MODELS.haiku,
  });
  if (insErr) {
    // Likely a UNIQUE violation if a parallel invocation raced — swallow and report.
    console.warn(`[ct-alert-post-mortem] insert failed alert=${target.alert_id}: ${insErr.message}`);
    return { ok: false, reason: 'insert_failed' as const, error: insErr.message };
  }

  const instruments = Array.isArray(ctx.alertRow.instruments)
    ? (ctx.alertRow.instruments as string[])
    : null;
  const biasAction = await confirmOrSeedBias(supabase, pm.bias_implicated, instruments);

  return {
    ok: true as const,
    alert_id: target.alert_id,
    alert_kind: target.alert_kind,
    axis: axisLetter,
    axis_misremembered: misremembered,
    confidence,
    bias_action: biasAction,
    cost: result.cost,
  };
}

// ---------------------------------------------------------------------------
// Request handler.
// ---------------------------------------------------------------------------
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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();

  // On-demand mode: POST body { alert_id, alert_kind } runs a single autopsy
  // synchronously so the grader can fire-and-forget immediately after grading
  // a wrong verdict, without waiting for the 30-min cron.
  let onDemand: { alert_id: string; alert_kind: AlertKind } | null = null;
  try {
    const body = await req.json().catch(() => null) as Record<string, unknown> | null;
    const aid = body?.alert_id;
    const akind = body?.alert_kind;
    if (typeof aid === 'string' && (akind === 'alert' || akind === 'flag')) {
      onDemand = { alert_id: aid, alert_kind: akind };
    }
  } catch {
    // no body — treat as cron invocation
  }

  let targets: WrongTarget[] = [];

  if (onDemand) {
    // Resolve the grade for this specific alert.
    const { data: gradeRow, error } = await supabase
      .from('ct_grades')
      .select('id, subject_type, subject_id, verdict')
      .eq('subject_id', onDemand.alert_id)
      .eq('subject_type', onDemand.alert_kind)
      .eq('verdict', 'wrong')
      .order('graded_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !gradeRow) {
      return new Response(JSON.stringify({
        ok: false, reason: 'no_wrong_grade_for_alert', alert_id: onDemand.alert_id,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    // Dedupe check.
    const { data: existing } = await supabase
      .from('ct_alert_post_mortems')
      .select('id')
      .eq('alert_id', onDemand.alert_id)
      .eq('alert_kind', onDemand.alert_kind)
      .maybeSingle();
    if (existing?.id) {
      return new Response(JSON.stringify({
        ok: true, skipped: true, reason: 'already_autopsied', alert_id: onDemand.alert_id,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    targets = [{
      grade_id: gradeRow.id as string,
      alert_id: gradeRow.subject_id as string,
      alert_kind: gradeRow.subject_type as AlertKind,
    }];
  } else {
    targets = await fetchUnautopsiedWrongs(supabase);
  }

  if (targets.length === 0) {
    return new Response(JSON.stringify({
      ok: true, processed: 0, duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  let written = 0;
  let failed = 0;
  let axisMisremembered = 0;
  let biasConfirmed = 0;
  let biasSeeded = 0;
  let totalCost = 0;
  const errors: Array<{ alert_id: string; reason: string }> = [];

  for (const target of targets) {
    try {
      const r = await processTarget(supabase, target);
      if (r.ok) {
        written++;
        if (r.axis_misremembered) axisMisremembered++;
        if (r.bias_action === 'confirmed') biasConfirmed++;
        if (r.bias_action === 'seeded') biasSeeded++;
        totalCost += r.cost;
      } else {
        failed++;
        errors.push({ alert_id: target.alert_id, reason: r.reason });
      }
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[ct-alert-post-mortem] target failed alert=${target.alert_id}: ${msg}`);
      errors.push({ alert_id: target.alert_id, reason: msg });
    }
  }

  console.log(`[ct-alert-post-mortem] wrote=${written} failed=${failed} axis_misremembered=${axisMisremembered} bias_confirmed=${biasConfirmed} bias_seeded=${biasSeeded} cost=$${totalCost.toFixed(4)}`);

  return new Response(JSON.stringify({
    ok: true,
    processed: targets.length,
    written,
    failed,
    axis_misremembered: axisMisremembered,
    bias_confirmed: biasConfirmed,
    bias_seeded: biasSeeded,
    cost_usd: Number(totalCost.toFixed(6)),
    duration_ms: Date.now() - startedAt,
    errors: errors.slice(0, 10),
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
