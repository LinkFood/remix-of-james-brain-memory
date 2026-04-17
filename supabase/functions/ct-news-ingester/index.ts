/**
 * ct-news-ingester — pull UW headlines for the watchlist, Claude-analyze,
 * store in ct_news_analyses, embed for corpus.
 *
 * Cron: every 15 min during market hours + once at 8am/8pm ET for catch-up.
 * Dedupe: (instrument, news_headline) combined to avoid re-analyzing.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getNewsHeadlines } from '../_shared/uwClient.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { NEWS_ANALYSIS_SYSTEM } from '../_shared/ctPrompts.ts';
import { WATCHLIST } from '../_shared/uwClient.ts';
import { embedCtItem } from '../_shared/ctEmbed.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';

interface HeadlineRow {
  headline: string;
  source: string | null;
  url: string | null;
  ticker: string;
  published_at: string | null;
}

function extractHeadlines(raw: unknown, ticker: string): HeadlineRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const rows: HeadlineRow[] = [];
  for (const item of data as Array<Record<string, unknown>>) {
    const headline = typeof item.headline === 'string' ? item.headline
      : typeof item.title === 'string' ? item.title : null;
    if (!headline) continue;
    rows.push({
      headline,
      source: (item.source as string | undefined) ?? null,
      url: (item.url as string | undefined) ?? null,
      ticker,
      published_at: (item.published_at as string | undefined) ?? (item.date as string | undefined) ?? null,
    });
  }
  return rows;
}

async function getSeenHeadlines(
  supabase: SupabaseClient,
  ticker: string,
): Promise<Set<string>> {
  // TTL-based dedup: only consider headlines from the last 48 hours.
  // UW's news feed rotates older items back in eventually — letting those
  // re-enter after 48h is fine and gives us fresh Claude takes.
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('ct_news_analyses')
    .select('news_headline')
    .eq('instrument', ticker)
    .gte('created_at', cutoff);
  return new Set((data ?? []).map((r: { news_headline: string }) => r.news_headline));
}

async function analyzeAndStore(
  supabase: SupabaseClient,
  userId: string | null,
  row: HeadlineRow
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const userMessage = JSON.stringify({
    ticker: row.ticker,
    headline: row.headline,
    source: row.source,
    published_at: row.published_at,
  });

  let claudeText = '';
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: NEWS_ANALYSIS_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 500,
      temperature: 0.2,
    });
    claudeText = parseTextContent(res);
  } catch (e) {
    return { ok: false, error: e instanceof ClaudeError ? `Claude ${e.status}` : String(e) };
  }

  // Parse JSON
  const cleaned = claudeText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed: { claude_take?: string; impact?: string; significance?: number } | null = null;
  try { parsed = JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
  }
  if (!parsed?.claude_take || !parsed.impact) return { ok: false, error: 'unparsable' };

  const impact = ['bullish', 'bearish', 'neutral', 'mixed'].includes(parsed.impact) ? parsed.impact : 'neutral';
  const significance = Math.max(1, Math.min(5, Number(parsed.significance) || 2));

  const { data, error } = await supabase.from('ct_news_analyses').insert({
    user_id: userId,
    instrument: row.ticker,
    news_headline: row.headline,
    news_source: row.source,
    news_url: row.url,
    news_timestamp: row.published_at,
    claude_take: parsed.claude_take,
    impact,
    significance,
    prompt_version: CT_PROMPT_VERSION,
  }).select('id').maybeSingle();

  if (error || !data) return { ok: false, error: error?.message ?? 'insert failed' };

  // Embed significant news only (sig ≥ 3) — keeps the corpus tight
  if (significance >= 3) {
    await embedCtItem(supabase, {
      item_type: 'news',
      item_id: data.id as string,
      text: `${row.ticker} NEWS ${impact} sig${significance} | ${row.headline} | ${parsed.claude_take}`,
      metadata: {
        instrument: row.ticker,
        impact,
        significance,
        created_at: new Date().toISOString(),
      },
    });
  }
  return { ok: true, id: data.id as string };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedAt = Date.now();

  try {
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    let totalHeadlines = 0, analyzed = 0, skipped = 0, failed = 0;
    const perTickerStats: Record<string, { headlines: number; analyzed: number; skipped: number; failed: number }> = {};

    for (const ticker of WATCHLIST) {
      const stats = { headlines: 0, analyzed: 0, skipped: 0, failed: 0 };
      try {
        const raw = await getNewsHeadlines({ ticker, limit: 10 });
        const headlines = extractHeadlines(raw, ticker);
        stats.headlines = headlines.length;
        totalHeadlines += headlines.length;

        const seen = await getSeenHeadlines(supabase, ticker);

        for (const row of headlines) {
          if (seen.has(row.headline)) { stats.skipped++; skipped++; continue; }
          const result = await analyzeAndStore(supabase, userId, row);
          if (result.ok) { stats.analyzed++; analyzed++; }
          else { stats.failed++; failed++; console.warn(`[ct-news] ${ticker} failed:`, result.error); }
        }
      } catch (e) {
        console.warn(`[ct-news] ${ticker} fetch failed:`, e instanceof Error ? e.message : e);
        stats.failed++;
        failed++;
      }
      perTickerStats[ticker] = stats;
    }

    return new Response(JSON.stringify({
      success: true,
      total_headlines_seen: totalHeadlines,
      analyzed,
      skipped,
      failed,
      per_ticker: perTickerStats,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-news-ingester] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
