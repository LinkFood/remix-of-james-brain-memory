/**
 * jac-compose-emission — JAC kernel composition.
 *
 * Inputs:  { trigger_id, event_payload, severity, ticker_focus, event_dedup_key }
 * Output:  { emission_id, headline, take, links, model_used, cost_cents }
 *
 * Pulls the trigger config, builds ClaudeContext (audience-aware),
 * augments with the event payload, calls Claude with the composition
 * template, persists a row to jac_emissions. Defensive on context-build
 * failure: composes with degraded context, marks emission row's
 * context_status accordingly.
 *
 * Severity → model selection (override-capable per trigger config):
 *   info / signal       → CLAUDE_MODELS.haiku
 *   alert / critical    → CLAUDE_MODELS.sonnet
 *
 * Composition templates live in this file (Phase 1). Promotable to a
 * `jac_composition_templates` table in Phase 4 alongside grading infra.
 *
 * Auth: service-role only via isServiceRoleRequest (apikey check per
 * 2026-05-07 gateway-rewrite class kill).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, calculateCost } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { buildClaudeContext } from '../_shared/claudeReadSurface.ts';

interface ComposeRequest {
  trigger_id: string;
  trigger_name: string;
  application: string;
  event_payload: Record<string, unknown>;
  severity: 'info' | 'signal' | 'alert' | 'critical';
  ticker_focus?: string | null;
  event_dedup_key: string;
  composition_template: string;
  model_override?: string | null;
}

interface ComposedOutput {
  headline: string;
  take: string;
  links?: Record<string, string> | null;
}

/**
 * Composition template catalog. Map: template_name → { systemPrompt }.
 * Each template renders a system prompt; the user prompt is built from
 * (event_payload + brain context) by composeUserPrompt().
 */
const TEMPLATES: Record<string, { systemPrompt: string }> = {
  cotrader_hot_contract_v1: {
    systemPrompt: `You are JAC's emission layer for the Co-Trader application — a senior options-flow reader who proactively flags meaningful events to the captain in real time. You are looking over the day-trader's shoulder.

You receive ONE triggered event (a high-score, large-premium options flow print) plus condensed market context (current regime, recent flow on that ticker, current pulse). Output strict JSON:

{
  "headline": "max 12 words, no period at end, names ticker + contract type",
  "take": "TWO to THREE complete sentences. No hedging, no disclaimers, no 'this is not financial advice.' Name the ticker, the contract specifics, and what the print means. If the print aligns with regime, say so. If it cuts against regime, flag the divergence. If stacking signal agrees, mention it.",
  "links": { "chart": "/tape?ticker=<TICKER>", "contract": "/tape?option=<SYMBOL>" }
}

Tone: direct, expert, no filler. Same voice as a trading-desk PM messaging a junior on Slack. If the regime context contradicts the flow direction, name the contradiction explicitly — that IS the signal.`,
  },

  cotrader_regime_transition_v1: {
    systemPrompt: `You are JAC's emission layer for the Co-Trader application — a senior tape reader watching regime context shift under the captain's feet. Regime is the slow signal: the macro/positioning backdrop every other detector fires against. When it flips, the captain needs to recalibrate.

You receive ONE triggered event (a regime classification flip on a ticker, or market-wide if is_market_wide=true) plus condensed market context. The event payload includes:
  - ticker (or is_market_wide=true)
  - prev_classification → current_classification (e.g. trend_up → pre_event_macro)
  - confidence (0-100)
  - trajectory (up / down / steady)
  - momentum (signed numeric)
  - sync_count (peers flipping to the same classification at the same bucket)
  - synchronized_flip (true if sync_count crossed the alert threshold — this IS the headline if true)
  - rationale_snippet (the producer's reason string, truncated)

Output strict JSON:

{
  "headline": "🌀 [TICKER or MKT] regime: [prev] → [current]  — max 14 words, no trailing period",
  "take": "TWO to THREE complete sentences. Lead with WHAT flipped and WHEN. If synchronized_flip=true, lead with the synchronization (\\"5 of 10 watchlist tickers flipped together\\") because that's the signal. Quote confidence as \\"NN%\\". Name trajectory and momentum if they reinforce or contradict the new classification. Close with the implication: what the captain should recalibrate (positioning, detector weight, watchlist focus). No hedging, no \\"this is not financial advice.\\"",
  "links": { "tape": "/tape?ticker=<TICKER>", "regime": "/heatmap?ticker=<TICKER>" }
}

For is_market_wide=true events, use TICKER='MKT' in links and write "market" / "across the watchlist" in copy.

Tone: terse font-mono — direct, calibrated, expert. Same voice as a trading-desk strategist messaging the PM on a regime change. If trajectory or momentum contradict the new classification (e.g. flipped to trend_up but momentum is negative), flag the dissonance — that's the calibration the captain needs.`,
  },
};

function selectModel(severity: string, override?: string | null): string {
  if (override) return override;
  return (severity === 'alert' || severity === 'critical')
    ? CLAUDE_MODELS.sonnet
    : CLAUDE_MODELS.haiku;
}

function composeUserPrompt(
  event_payload: Record<string, unknown>,
  ctxSummary: string,
): string {
  return [
    '[TRIGGERED EVENT]',
    JSON.stringify(event_payload, null, 2),
    '',
    '[BRAIN CONTEXT — condensed]',
    ctxSummary,
    '',
    'Compose the emission. Output strict JSON per the system prompt schema.',
  ].join('\n');
}

/**
 * Condense ClaudeContext into a token-light summary suitable for emission
 * composition. We don't need the full payload — just the fields a hot-
 * contract reader cares about for the focal ticker.
 */
function condenseContextForEmission(
  ctx: Awaited<ReturnType<typeof buildClaudeContext>>,
  tickerFocus: string | null,
): { summary: string; sourceOrgans: string[] } {
  const lines: string[] = [];
  const organs: string[] = [];

  // Active brief snippet (regime + watchlist focus).
  if (ctx.activeBrief) {
    lines.push(`[BRIEF] regime=${ctx.activeBrief.macro_regime ?? 'unknown'}`);
    if (ctx.activeBrief.watchlist_focus?.length) {
      lines.push(`[BRIEF] focus=${(ctx.activeBrief.watchlist_focus as string[]).join(',')}`);
    }
    organs.push('active_brief');
  }

  // Pulse organ — current regime per ticker.
  const pulseOrgan = (ctx.organs as Record<string, { data?: unknown }>)?.pulse;
  if (pulseOrgan?.data && tickerFocus) {
    const pData = pulseOrgan.data as { per_ticker?: Record<string, { regime?: string; netPremium?: number; slope5min?: number }> };
    const pulse = pData.per_ticker?.[tickerFocus];
    if (pulse) {
      lines.push(`[PULSE ${tickerFocus}] regime=${pulse.regime} net_prem=${pulse.netPremium ?? 'n/a'} slope5min=${pulse.slope5min ?? 'n/a'}`);
      organs.push('pulse');
    }
  }

  // Flow heatmap — top stacks for the focus ticker.
  if (tickerFocus && Array.isArray(ctx.flowHeatmapPerTicker)) {
    const fh = ctx.flowHeatmapPerTicker.find((t) => t.ticker === tickerFocus);
    if (fh && fh.stacks?.length) {
      const top = fh.stacks.slice(0, 3).map(
        (s) => `${s.expiry_bucket_week}:$${s.value.toLocaleString()}`,
      ).join(', ');
      lines.push(`[HEATMAP ${tickerFocus}] top_stacks=${top}`);
      organs.push('flow_heatmap');
    }
  }

  // Tape commentary (latest one-liner for color).
  const tapeOrgan = (ctx.organs as Record<string, { data?: unknown }>)?.tape;
  if (tapeOrgan?.data) {
    const tData = tapeOrgan.data as { latest?: { commentary?: string } };
    if (tData.latest?.commentary) {
      lines.push(`[TAPE] ${tData.latest.commentary.slice(0, 200)}`);
      organs.push('tape');
    }
  }

  // Recent news — first headline mentioning the focal ticker.
  if (tickerFocus && Array.isArray(ctx.recentNews)) {
    const news = ctx.recentNews.find((n) => n.instrument === tickerFocus);
    if (news?.news_headline) {
      lines.push(`[NEWS ${tickerFocus}] ${news.news_headline.slice(0, 150)}`);
      organs.push('news');
    }
  }

  if (lines.length === 0) {
    lines.push('(no organ context available — composing on event payload only)');
  }

  return { summary: lines.join('\n'), sourceOrgans: organs };
}

function parseModelJSON(text: string): ComposedOutput | null {
  // Claude sometimes wraps JSON in markdown fences. Strip if present.
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\n?/, '').replace(/```$/, '').trim();
  }
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed.headline === 'string' && typeof parsed.take === 'string') {
      return {
        headline: parsed.headline,
        take: parsed.take,
        links: typeof parsed.links === 'object' ? parsed.links : null,
      };
    }
  } catch {
    // fall through
  }
  return null;
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

  let body: ComposeRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_json' }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();

  // 1. Build brain context (defensive — never throws).
  let ctx: Awaited<ReturnType<typeof buildClaudeContext>> | null = null;
  let context_status: 'populated' | 'degraded' | 'error' = 'populated';
  try {
    ctx = await buildClaudeContext(supabase, {
      audience: body.application === 'cotrader' ? 'cotrader' : 'analyst',
      tickerFocus: body.ticker_focus ?? undefined,
      consumerName: 'jac-compose-emission',
      // tighter limits — emission compose doesn't need full payload
      flowAlertLimit: 10,
      darkPoolLimit: 5,
      newsLimit: 5,
      principleLimit: 5,
    });
  } catch (e) {
    console.warn('[jac-compose-emission] brain build failed:', e instanceof Error ? e.message : e);
    context_status = 'error';
  }

  let summary = '';
  let sourceOrgans: string[] = [];
  if (ctx) {
    const condensed = condenseContextForEmission(ctx, body.ticker_focus ?? null);
    summary = condensed.summary;
    sourceOrgans = condensed.sourceOrgans;
    if (sourceOrgans.length === 0) context_status = 'degraded';
  } else {
    summary = '(brain context unavailable)';
  }

  // 2. Resolve template.
  const template = TEMPLATES[body.composition_template];
  if (!template) {
    return new Response(
      JSON.stringify({ error: 'unknown_template', template: body.composition_template }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // 3. Call Claude.
  const model = selectModel(body.severity, body.model_override);
  const userPrompt = composeUserPrompt(body.event_payload, summary);

  let composed: ComposedOutput | null = null;
  let tokens_in = 0;
  let tokens_out = 0;
  let cost_cents = 0;

  try {
    const resp = await callClaude({
      model,
      system: template.systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 600,
    });
    tokens_in = resp.usage?.input_tokens ?? 0;
    tokens_out = resp.usage?.output_tokens ?? 0;
    const costUsd = calculateCost(model, { input_tokens: tokens_in, output_tokens: tokens_out });
    cost_cents = Math.round(costUsd * 100 * 100) / 100;  // cents with 2 decimals

    const firstBlock = resp.content?.[0];
    const text = (firstBlock && firstBlock.type === 'text' && typeof firstBlock.text === 'string')
      ? firstBlock.text
      : '';
    composed = parseModelJSON(text);

    logClaudeUsage(supabase, {
      source: 'jac-compose-emission',
      model,
      usage: { input_tokens: tokens_in, output_tokens: tokens_out },
      duration_ms: Date.now() - startedAt,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[jac-compose-emission] LLM call failed:', msg);
    composed = {
      headline: `${body.event_payload.ticker ?? '?'} hot contract — composition failed`,
      take: `Trigger fired but LLM call failed: ${msg.slice(0, 200)}. Inspect jac_emissions row for raw event_payload.`,
      links: null,
    };
    context_status = 'error';
  }

  if (!composed) {
    composed = {
      headline: `${body.event_payload.ticker ?? '?'} hot contract — parse failed`,
      take: 'LLM returned non-JSON output. Inspect jac_emissions row for raw event_payload and recompose manually.',
      links: null,
    };
    context_status = 'error';
  }

  // 4. Persist to jac_emissions.
  const { data: emissionRow, error: insertErr } = await supabase
    .from('jac_emissions')
    .insert({
      trigger_id: body.trigger_id,
      trigger_name: body.trigger_name,
      application: body.application,
      severity: body.severity,
      event_payload: body.event_payload,
      event_dedup_key: body.event_dedup_key,
      headline: composed.headline,
      take_text: composed.take,
      links: composed.links ?? {},
      source_organs: sourceOrgans,
      composed_at: new Date().toISOString(),
      model_used: model,
      cost_cents,
      tokens_in,
      tokens_out,
      context_status,
    })
    .select('id')
    .single();

  if (insertErr) {
    return new Response(
      JSON.stringify({ error: 'insert_failed', message: insertErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  return new Response(
    JSON.stringify({
      emission_id: emissionRow.id,
      headline: composed.headline,
      take: composed.take,
      links: composed.links,
      model_used: model,
      cost_cents,
      context_status,
      duration_ms: Date.now() - startedAt,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
