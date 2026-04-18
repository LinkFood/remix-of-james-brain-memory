/**
 * ct-news-sentiment-backfill — idempotent one-shot backfill for sentiment
 * columns on ct_news_analyses rows that predate the sentiment prompt.
 *
 * Scope:
 *   - Rows WHERE sentiment IS NULL
 *   - Default window: last 48 hours (created_at >= now() - 48h)
 *   - Skips rows where claude_take starts with '[weekend-skipped' — those
 *     are dedupe sentinels and already carry neutral/1 on new inserts.
 *
 * Strategy:
 *   - Haiku analyzes the headline + original claude_take as context so we
 *     re-use existing work instead of re-analyzing from scratch.
 *   - Batches of 20 (Voyage-style cap, but applied here to Claude to keep
 *     timeout comfortable — Haiku is fast but network is the bottleneck).
 *   - On invalid sentiment from Haiku: defaults to neutral/1 with a warning
 *     log. Matches the inline ingester's guard so backfilled rows look the
 *     same as fresh ones.
 *
 * Auth: service role only. Manual trigger — NOT scheduled by a cron.
 *
 * Response: { success, scanned, updated, defaulted_to_neutral, failed,
 *             duration_ms }
 *
 * Request body (all optional):
 *   { window_hours?: number (default 48, max 168),
 *     limit?: number (default 200, max 500),
 *     dry_run?: boolean }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { NEWS_ANALYSIS_SYSTEM } from '../_shared/ctPrompts.ts';

const DEFAULT_WINDOW_HOURS = 48;
const MAX_WINDOW_HOURS = 168; // one week hard cap — don't re-analyze everything
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const BATCH_SIZE = 20;

interface TargetRow {
  id: string;
  instrument: string;
  news_headline: string;
  news_source: string | null;
  news_timestamp: string | null;
  claude_take: string | null;
  impact: string | null;
}

interface ScoreResult {
  ok: boolean;
  id: string;
  updated?: boolean;
  defaulted?: boolean;
  error?: string;
  tokens_in?: number;
  tokens_out?: number;
}

async function scoreAndUpdate(
  supabase: SupabaseClient,
  row: TargetRow,
  dryRun: boolean,
): Promise<ScoreResult> {
  // Feed Haiku the headline + existing claude_take so it re-uses prior reasoning
  // instead of re-analyzing from the headline alone.
  const userMessage = JSON.stringify({
    ticker: row.instrument,
    headline: row.news_headline,
    source: row.news_source,
    published_at: row.news_timestamp,
    prior_analysis: row.claude_take,
    prior_impact: row.impact,
    note: 'Backfill: only the sentiment/sentiment_magnitude/sentiment_reasoning fields are being written. The claude_take and impact already exist — use them as context. Still return the full JSON schema; the existing fields will be ignored.',
  });

  let claudeText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: NEWS_ANALYSIS_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 400,
      temperature: 0.2,
    });
    claudeText = parseTextContent(res);
    tokensIn = res.usage?.input_tokens ?? 0;
    tokensOut = res.usage?.output_tokens ?? 0;
  } catch (e) {
    return { ok: false, id: row.id, error: e instanceof ClaudeError ? `Claude ${e.status}` : String(e) };
  }

  // Parse JSON — same forgiving parser as the ingester
  const cleaned = claudeText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed: { sentiment?: string; sentiment_magnitude?: number; sentiment_reasoning?: string } | null = null;
  try { parsed = JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
  }

  // Validation with defaults — matches ingester guard exactly
  const SENT_VALID = ['positive', 'negative', 'neutral'] as const;
  let sentiment: 'positive' | 'negative' | 'neutral' = 'neutral';
  let sentimentMagnitude = 1;
  let sentimentReasoning: string | null = null;
  let defaulted = false;

  if (parsed && typeof parsed.sentiment === 'string' && (SENT_VALID as readonly string[]).includes(parsed.sentiment)) {
    sentiment = parsed.sentiment as 'positive' | 'negative' | 'neutral';
    const mag = Number(parsed.sentiment_magnitude);
    if (Number.isFinite(mag) && mag >= 1 && mag <= 5) {
      sentimentMagnitude = Math.round(mag);
    } else {
      defaulted = true;
      console.warn(`[ct-news-sentiment-backfill] ${row.id} invalid magnitude=${parsed.sentiment_magnitude} — defaulting to 1`);
    }
    if (typeof parsed.sentiment_reasoning === 'string') {
      sentimentReasoning = parsed.sentiment_reasoning.slice(0, 500);
    }
  } else {
    defaulted = true;
    console.warn(`[ct-news-sentiment-backfill] ${row.id} invalid sentiment=${parsed?.sentiment} — defaulting to neutral/1`);
    sentimentReasoning = 'backfill parse fallback — model returned invalid value';
  }

  if (dryRun) {
    return { ok: true, id: row.id, updated: false, defaulted, tokens_in: tokensIn, tokens_out: tokensOut };
  }

  // Idempotent: update ONLY rows where sentiment IS NULL so a concurrent run
  // or accidental re-invocation can't overwrite a real score with a default.
  const { error: updateError, data: updatedRows } = await supabase
    .from('ct_news_analyses')
    .update({
      sentiment,
      sentiment_magnitude: sentimentMagnitude,
      sentiment_reasoning: sentimentReasoning,
    })
    .eq('id', row.id)
    .is('sentiment', null)
    .select('id');

  if (updateError) {
    return { ok: false, id: row.id, error: updateError.message, tokens_in: tokensIn, tokens_out: tokensOut };
  }
  return {
    ok: true,
    id: row.id,
    updated: (updatedRows?.length ?? 0) > 0,
    defaulted,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
  };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Parse optional body
  let windowHours = DEFAULT_WINDOW_HOURS;
  let limit = DEFAULT_LIMIT;
  let dryRun = false;
  try {
    const body = await req.json();
    if (typeof body?.window_hours === 'number' && body.window_hours > 0) {
      windowHours = Math.min(body.window_hours, MAX_WINDOW_HOURS);
    }
    if (typeof body?.limit === 'number' && body.limit > 0) {
      limit = Math.min(body.limit, MAX_LIMIT);
    }
    if (typeof body?.dry_run === 'boolean') dryRun = body.dry_run;
  } catch {
    /* empty body is fine */
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedAt = Date.now();

  try {
    const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

    // Pull target rows. Skip weekend-skipped sentinels — they're already
    // stamped neutral/1 on new inserts, and for legacy rows the string
    // filter excludes them cleanly.
    const { data: targets, error: selectError } = await supabase
      .from('ct_news_analyses')
      .select('id, instrument, news_headline, news_source, news_timestamp, claude_take, impact')
      .is('sentiment', null)
      .gte('created_at', cutoff)
      .not('claude_take', 'ilike', '[weekend-skipped%')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (selectError) {
      return new Response(JSON.stringify({ error: selectError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const rows = (targets ?? []) as TargetRow[];
    let updated = 0, defaulted = 0, failed = 0;
    let totalTokensIn = 0, totalTokensOut = 0, calls = 0;

    // Sequential batches — Haiku is fast and we don't want to burst the
    // Anthropic rate limit on a manually triggered run.
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(batch.map(r => scoreAndUpdate(supabase, r, dryRun)));
      for (const res of results) {
        calls++;
        totalTokensIn += res.tokens_in ?? 0;
        totalTokensOut += res.tokens_out ?? 0;
        if (!res.ok) { failed++; continue; }
        if (res.updated) updated++;
        if (res.defaulted) defaulted++;
      }
    }

    logClaudeUsage(supabase, {
      source: 'ct-news-sentiment-backfill',
      model: CLAUDE_MODELS.haiku,
      usage: { input_tokens: totalTokensIn, output_tokens: totalTokensOut },
      duration_ms: Date.now() - startedAt,
      metadata: {
        window_hours: windowHours,
        scanned: rows.length,
        updated,
        defaulted,
        failed,
        claude_calls: calls,
        dry_run: dryRun,
      },
    });

    return new Response(JSON.stringify({
      success: true,
      dry_run: dryRun,
      window_hours: windowHours,
      scanned: rows.length,
      updated,
      defaulted_to_neutral: defaulted,
      failed,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (error) {
    console.error('[ct-news-sentiment-backfill] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'failed',
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
