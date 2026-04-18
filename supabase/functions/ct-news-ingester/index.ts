/**
 * ct-news-ingester — pull UW headlines for the watchlist, Claude-analyze,
 * store in ct_news_analyses, embed for corpus.
 *
 * Modes:
 *   - weekday (default): every 20 min, 11:00-22:00 UTC, full Claude analysis
 *     on every unseen headline. Fetches 10 per ticker.
 *   - weekend: hourly Sat + Sun. Widens per-ticker fetch to 20 so we don't
 *     miss news between the sparser pulls. Pre-filters headlines via a
 *     cheap heuristic — obvious low-signal items (promotional/boilerplate)
 *     are inserted with a [weekend-skipped] sentinel to preserve dedupe
 *     but skip the Claude call. Significant-looking headlines still get
 *     full Claude analysis.
 *
 * Dedupe: TTL'd on (instrument, news_headline) over the last 48 hours of
 * ct_news_analyses.created_at. Spans the weekday/weekend boundary — any
 * row inserted on Friday 21:40 is still in the window at Saturday 00:00.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getNewsHeadlines } from '../_shared/uwClient.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { NEWS_ANALYSIS_SYSTEM } from '../_shared/ctPrompts.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import { embedCtItem } from '../_shared/ctEmbed.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { fireWatcherImmediate } from '../_shared/watcherDispatch.ts';

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
  // The 48h window also covers the weekday/weekend cron boundary cleanly.
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('ct_news_analyses')
    .select('news_headline')
    .eq('instrument', ticker)
    .gte('created_at', cutoff);
  return new Set((data ?? []).map((r: { news_headline: string }) => r.news_headline));
}

/**
 * Cheap pre-filter for weekend mode: flags headlines that look promotional
 * or boilerplate so we can skip the Claude call. Errs on the side of keeping
 * anything ambiguous — better to spend a few extra Haiku calls than miss a
 * Sunday Fed leak.
 */
const LOW_SIG_PATTERNS: RegExp[] = [
  /\b(?:analyst|analysts)\s+(?:maintains?|reiterates?|reaffirms?)\b/i,
  /\bprice target (?:raised|lowered|cut|trimmed|bumped)\b/i,
  /\bshares? (?:up|down|gain|slip|fall|rise) \d/i,
  /\bshould you (?:buy|sell|hold)\b/i,
  /\bis this (?:stock|a) (?:buy|sell)\b/i,
  /\b\d+\s+(?:reasons|stocks|things)\b/i,
  /\btop \d+\s+(?:stocks|picks|reasons)\b/i,
  /\bmotley fool\b/i,
  /\binsider (?:buying|selling) activity\b/i,
  /\b(?:13f|form 4) filing\b/i,
  /\bdividend (?:announcement|declared)\b/i,
  /\btechnical (?:analysis|setup|pattern)\b/i,
];
function looksLowSignal(row: HeadlineRow): boolean {
  const h = row.headline;
  if (h.length < 25) return true; // stubby headlines rarely carry substance
  for (const re of LOW_SIG_PATTERNS) if (re.test(h)) return true;
  return false;
}

async function analyzeAndStore(
  supabase: SupabaseClient,
  userId: string | null,
  row: HeadlineRow,
  runMode: 'weekday' | 'weekend',
): Promise<{ ok: boolean; id?: string; error?: string; tokens_in?: number; tokens_out?: number; skipped_claude?: boolean }> {
  const userMessage = JSON.stringify({
    ticker: row.ticker,
    headline: row.headline,
    source: row.source,
    published_at: row.published_at,
  });

  let claudeText = '';
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: NEWS_ANALYSIS_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 500,
      temperature: 0.2,
    });
    claudeText = parseTextContent(res);
    tokensIn = res.usage?.input_tokens ?? 0;
    tokensOut = res.usage?.output_tokens ?? 0;
  } catch (e) {
    return { ok: false, error: e instanceof ClaudeError ? `Claude ${e.status}` : String(e) };
  }

  // Parse JSON
  const cleaned = claudeText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed: {
    claude_take?: string;
    impact?: string;
    significance?: number;
    sentiment?: string;
    sentiment_magnitude?: number;
    sentiment_reasoning?: string;
  } | null = null;
  try { parsed = JSON.parse(cleaned); } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
  }
  if (!parsed?.claude_take || !parsed.impact) return { ok: false, error: 'unparsable', tokens_in: tokensIn, tokens_out: tokensOut };

  const impact = ['bullish', 'bearish', 'neutral', 'mixed'].includes(parsed.impact) ? parsed.impact : 'neutral';
  const significance = Math.max(1, Math.min(5, Number(parsed.significance) || 2));

  // Sentiment validation — Haiku sometimes returns "bullish"/"bearish" or
  // out-of-range magnitudes. Default to neutral/1 with a warning so downstream
  // rollups don't see garbage. sentiment_reasoning is free-form so we accept
  // whatever came back, but cap length defensively.
  const SENT_VALID = ['positive', 'negative', 'neutral'] as const;
  let sentiment: 'positive' | 'negative' | 'neutral' = 'neutral';
  let sentimentMagnitude = 1;
  let sentimentReasoning: string | null =
    typeof parsed.sentiment_reasoning === 'string' && parsed.sentiment_reasoning.length <= 500
      ? parsed.sentiment_reasoning
      : (typeof parsed.sentiment_reasoning === 'string' ? parsed.sentiment_reasoning.slice(0, 500) : null);
  if (typeof parsed.sentiment === 'string' && (SENT_VALID as readonly string[]).includes(parsed.sentiment)) {
    sentiment = parsed.sentiment as 'positive' | 'negative' | 'neutral';
    const mag = Number(parsed.sentiment_magnitude);
    if (Number.isFinite(mag) && mag >= 1 && mag <= 5) {
      sentimentMagnitude = Math.round(mag);
    } else {
      console.warn(`[ct-news] ${row.ticker} invalid sentiment_magnitude=${parsed.sentiment_magnitude} — defaulting to 1`);
    }
  } else {
    console.warn(`[ct-news] ${row.ticker} invalid sentiment=${parsed.sentiment} — defaulting to neutral/1`);
    if (!sentimentReasoning) sentimentReasoning = 'sentiment parse fallback — model returned invalid value';
  }

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
    sentiment,
    sentiment_magnitude: sentimentMagnitude,
    sentiment_reasoning: sentimentReasoning,
    prompt_version: runMode === 'weekend' ? `${CT_PROMPT_VERSION}+weekend` : CT_PROMPT_VERSION,
  }).select('id').maybeSingle();

  if (error || !data) return { ok: false, error: error?.message ?? 'insert failed', tokens_in: tokensIn, tokens_out: tokensOut };

  // Embed significant news only (sig >= 3) — keeps the corpus tight
  if (significance >= 3) {
    await embedCtItem(supabase, {
      item_type: 'news',
      item_id: data.id as string,
      text: `${row.ticker} NEWS ${impact} sig${significance} | ${row.headline} | ${parsed.claude_take}`,
      metadata: {
        instrument: row.ticker,
        impact,
        significance,
        run_mode: runMode,
        created_at: new Date().toISOString(),
      },
    });
  }

  // Event-driven watcher trigger: magnitude-5 sentiment is a catalyst-class
  // headline. Don't wait for the next scheduled tick (~7 min avg). Debounce
  // enforced in watcherDispatch — multiple magnitude-5 headlines within 90s
  // collapse to one watcher invocation.
  if (sentimentMagnitude >= 5) {
    const truncHead = row.headline.length > 140 ? row.headline.slice(0, 137) + '…' : row.headline;
    await fireWatcherImmediate(supabase, {
      source: 'news_event',
      priority: 'urgent',
      reason: `${row.ticker} ${sentiment} magnitude 5 — ${truncHead}`,
    });
  }

  return { ok: true, id: data.id as string, tokens_in: tokensIn, tokens_out: tokensOut };
}

/**
 * Raw-capture insert for weekend low-signal headlines. Skips the Claude
 * call but still writes a row so dedupe holds. Marked with a sentinel
 * claude_take so it's trivially greppable and excluded from the morning
 * brief (which filters significance >= 3).
 */
async function storeRawSkipped(
  supabase: SupabaseClient,
  userId: string | null,
  row: HeadlineRow,
): Promise<{ ok: boolean; error?: string; id?: string }> {
  const { data, error } = await supabase.from('ct_news_analyses').insert({
    user_id: userId,
    instrument: row.ticker,
    news_headline: row.headline,
    news_source: row.source,
    news_url: row.url,
    news_timestamp: row.published_at,
    claude_take: '[weekend-skipped: low-signal pre-filter]',
    impact: 'neutral',
    significance: 1,
    sentiment: 'neutral',
    sentiment_magnitude: 1,
    sentiment_reasoning: 'weekend low-signal pre-filter — no model read',
    prompt_version: `${CT_PROMPT_VERSION}+weekend-raw`,
  }).select('id').maybeSingle();
  if (error || !data) return { ok: false, error: error?.message ?? 'insert failed' };
  return { ok: true, id: data.id as string };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  // Parse body for explicit is_weekend flag; fall back to UTC day-of-week.
  // Using UTC day matches the cron's schedule timezone so manual invocations
  // behave the same as scheduled ones.
  let bodyIsWeekend: boolean | null = null;
  try {
    const body = await req.json();
    if (typeof body?.is_weekend === 'boolean') bodyIsWeekend = body.is_weekend;
  } catch {
    /* empty body is fine */
  }
  const utcDow = new Date().getUTCDay(); // 0 Sun, 6 Sat
  const runMode: 'weekday' | 'weekend' =
    bodyIsWeekend ?? (utcDow === 0 || utcDow === 6) ? 'weekend' : 'weekday';
  const perTickerLimit = runMode === 'weekend' ? 20 : 10;

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedAt = Date.now();

  try {
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    // One ct_config read per invocation — reused for the whole loop.
    const watchlist = await getWatchlist(supabase);

    let totalHeadlines = 0, analyzed = 0, skipped = 0, failed = 0, rawSkipped = 0;
    let totalTokensIn = 0, totalTokensOut = 0, claudeCallsMade = 0;
    const perTickerStats: Record<string, { headlines: number; analyzed: number; skipped: number; failed: number; raw_skipped: number }> = {};

    for (const ticker of watchlist) {
      const stats = { headlines: 0, analyzed: 0, skipped: 0, failed: 0, raw_skipped: 0 };
      try {
        const raw = await getNewsHeadlines({ ticker, limit: perTickerLimit });
        const headlines = extractHeadlines(raw, ticker);
        stats.headlines = headlines.length;
        totalHeadlines += headlines.length;

        const seen = await getSeenHeadlines(supabase, ticker);

        for (const row of headlines) {
          if (seen.has(row.headline)) { stats.skipped++; skipped++; continue; }

          // Weekend-only low-signal pre-filter: insert raw, skip Claude.
          if (runMode === 'weekend' && looksLowSignal(row)) {
            const rawRes = await storeRawSkipped(supabase, userId, row);
            if (rawRes.ok) { stats.raw_skipped++; rawSkipped++; }
            else { stats.failed++; failed++; console.warn(`[ct-news] ${ticker} raw-skip failed:`, rawRes.error); }
            continue;
          }

          const result = await analyzeAndStore(supabase, userId, row, runMode);
          // Count tokens whenever Claude actually ran (tokens > 0 is the signal).
          if ((result.tokens_in ?? 0) > 0 || (result.tokens_out ?? 0) > 0) {
            totalTokensIn += result.tokens_in ?? 0;
            totalTokensOut += result.tokens_out ?? 0;
            claudeCallsMade++;
          }
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

    // Unified Claude cost log — one row per ingester run, summed across all
    // headlines analyzed. Per-headline logging would bloat ct_claude_usage.
    logClaudeUsage(supabase, {
      source: 'ct-news-ingester',
      model: CLAUDE_MODELS.haiku,
      usage: { input_tokens: totalTokensIn, output_tokens: totalTokensOut },
      duration_ms: Date.now() - startedAt,
      metadata: {
        user_id: userId,
        run_mode: runMode,
        claude_calls: claudeCallsMade,
        headlines_analyzed: analyzed,
        headlines_seen: totalHeadlines,
        raw_skipped: rawSkipped,
      },
    });

    return new Response(JSON.stringify({
      success: true,
      run_mode: runMode,
      per_ticker_limit: perTickerLimit,
      total_headlines_seen: totalHeadlines,
      analyzed,
      skipped,
      raw_skipped: rawSkipped,
      failed,
      per_ticker: perTickerStats,
      duration_ms: Date.now() - startedAt,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  } catch (error) {
    console.error('[ct-news-ingester] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
