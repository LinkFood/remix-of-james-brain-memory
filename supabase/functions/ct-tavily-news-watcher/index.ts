/**
 * ct-tavily-news-watcher — Tavily-powered breaking-news watcher.
 *
 * Wave F of the Claude Co-Trader Phase 1 build. Complements ct-news-ingester
 * (which pulls per-ticker from UW) by scanning Tavily for macro / geopolitical
 * / policy catalysts that never hit UW's ticker feeds. Each invocation:
 *
 *   1. Pick ONE query from a 16-slot rotation (3 macro + 13 per-ticker).
 *      Rotation cursor lives in ct_config['tavily_news_watcher_cursor'].
 *   2. POST to https://api.tavily.com/search → top 10 results.
 *   3. Dedupe against ct_breaking_news (source='tavily') on URL.
 *   4. For each NEW article, ask Claude Haiku to classify
 *      (severity, sentiment, tickers_affected[], category, macro_wide, summary).
 *   5. Insert into ct_breaking_news with triggers_rebrief = (severity >= threshold).
 *   6. If triggers_rebrief AND no same-day re-brief in last 2h → fire
 *      ct-daily-brief { triggered_by: 'breaking_news', reason }.
 *   7. Record one ct_claude_decisions row decision_type='breaking_news_processed'.
 *
 * Runs weekdays every 30 min (11:00-22:00 UTC) and every 2h on weekends.
 * Auth: service role only. Called by pg_cron.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { getConfig } from '../_shared/configCache.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

// ---------------------------------------------------------------------------
// Query rotation — 3 macro slots + N per-ticker slots. One query per call.
// ---------------------------------------------------------------------------
const MACRO_QUERIES: Array<{ id: string; query: string; category: string }> = [
  { id: 'macro_us_markets',  query: 'US stock market today breaking news',             category: 'macro' },
  { id: 'geopolitical',      query: 'geopolitical conflict war Iran Russia China today', category: 'geopolitical' },
  { id: 'policy_fed_cpi',    query: 'Fed rate decision CPI inflation',                 category: 'policy' },
];

const ROTATION_CURSOR_KEY = 'tavily_news_watcher_cursor';

// ---------------------------------------------------------------------------
// Haiku classifier — signal decomposition for the brief engine.
// ---------------------------------------------------------------------------
const CLASSIFIER_SYSTEM = `You are Claude, the co-trader's news-severity classifier.
A news headline is coming in. Given the watchlist, classify it strictly.

Severity scale (1-5):
  1 — noise / opinion piece / evergreen content
  2 — minor development, no immediate tape impact
  3 — noteworthy, may nudge a single name
  4 — market-moving for one or more watchlist names OR macro-wide catalyst
  5 — session-altering event (rate-path shock, geopolitical escalation, large-cap blowup)

Return strict JSON, no markdown, no prose:
{
  "severity": 1-5,
  "sentiment": "bullish" | "bearish" | "neutral" | "ambiguous",
  "tickers_affected": ["SPY", "NVDA", ...],       // subset of the provided watchlist or []
  "category": "geopolitical" | "macro" | "earnings" | "sector" | "policy" | "other",
  "macro_wide": true | false,                     // affects broad market vs single name
  "summary": "one sentence describing the event and why it matters"
}

Rules:
  - If the article is older than 48h or obviously stale, severity=1.
  - Be conservative with severity=5 — reserve for genuine session-altering events.
  - tickers_affected MUST be a subset of the watchlist you are given. Never invent tickers.
  - sentiment is from the perspective of risk assets (SPY-direction). "bullish" = risk-on.`;

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
  published_date?: string | null;
}

interface TavilyResponse {
  answer?: string | null;
  query?: string;
  response_time?: number;
  results: TavilyResult[];
}

interface Classification {
  severity: number;
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'ambiguous';
  tickers_affected: string[];
  category: 'geopolitical' | 'macro' | 'earnings' | 'sector' | 'policy' | 'other';
  macro_wide: boolean;
  summary: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function validateClassification(raw: unknown, watchlist: string[]): Classification | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const severity = clamp(Math.round(Number(o.severity) || 1), 1, 5);

  const sent = typeof o.sentiment === 'string' ? o.sentiment.toLowerCase() : 'neutral';
  const sentiment: Classification['sentiment'] =
    sent === 'bullish' || sent === 'bearish' || sent === 'ambiguous' ? sent : 'neutral';

  const wl = new Set(watchlist.map((t) => t.toUpperCase()));
  const tickersRaw = Array.isArray(o.tickers_affected) ? o.tickers_affected : [];
  const tickers = tickersRaw
    .map((t) => (typeof t === 'string' ? t.toUpperCase().trim() : ''))
    .filter((t) => t && wl.has(t));

  const catRaw = typeof o.category === 'string' ? o.category.toLowerCase() : 'other';
  const VALID_CATS = ['geopolitical', 'macro', 'earnings', 'sector', 'policy', 'other'] as const;
  const category = (VALID_CATS as readonly string[]).includes(catRaw)
    ? (catRaw as Classification['category'])
    : 'other';

  const macro_wide = Boolean(o.macro_wide);
  const summary = typeof o.summary === 'string' ? o.summary.slice(0, 500) : '';

  if (!summary) return null;
  return { severity, sentiment, tickers_affected: tickers, category, macro_wide, summary };
}

// ---------------------------------------------------------------------------
// Tavily call
// ---------------------------------------------------------------------------
async function searchTavily(query: string, maxResults = 10): Promise<TavilyResult[]> {
  const apiKey = Deno.env.get('TAVILY_API_KEY');
  if (!apiKey) throw new Error('TAVILY_API_KEY not configured');

  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
      max_results: maxResults,
      topic: 'news',
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[tavily-news] ${resp.status} ${text.slice(0, 300)}`);
    // 4xx errors are permanent — propagate the message but don't retry
    if (resp.status >= 400 && resp.status < 500) {
      throw new Error(`Tavily ${resp.status}: ${text.slice(0, 200)}`);
    }
    throw new Error(`Tavily ${resp.status}`);
  }

  const data = (await resp.json()) as TavilyResponse;
  return Array.isArray(data.results) ? data.results : [];
}

async function classifyArticle(
  result: TavilyResult,
  watchlist: string[],
  queryContext: { slotId: string; category: string },
): Promise<{ classification: Classification | null; tokens_in: number; tokens_out: number }> {
  const userMessage = JSON.stringify({
    watchlist,
    query_context: queryContext,
    article: {
      title: result.title,
      url: result.url,
      content_snippet: (result.content || '').slice(0, 800),
      published_date: result.published_date ?? null,
    },
  });

  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  try {
    const res = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: CLASSIFIER_SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
      max_tokens: 400,
      temperature: 0.2,
    });
    text = parseTextContent(res);
    tokensIn = res.usage?.input_tokens ?? 0;
    tokensOut = res.usage?.output_tokens ?? 0;
  } catch (e) {
    console.warn('[tavily-news] classifier error:', e instanceof ClaudeError ? `Claude ${e.status}` : String(e));
    return { classification: null, tokens_in: 0, tokens_out: 0 };
  }

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed: unknown = null;
  try { parsed = JSON.parse(cleaned); }
  catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* ignore */ } }
  }

  const classification = validateClassification(parsed, watchlist);
  return { classification, tokens_in: tokensIn, tokens_out: tokensOut };
}

// ---------------------------------------------------------------------------
// Best-effort re-brief trigger. Uses the Vault-powered RPC so we don't depend
// on a runtime service_role key that may be out-of-sync with the CLI.
// ---------------------------------------------------------------------------
async function fireRebrief(
  supabase: SupabaseClient,
  reason: string,
): Promise<{ fired: boolean; skipped?: string }> {
  // Cool-down: no re-brief if one already fired in the last 2h for today.
  const today = new Date().toISOString().slice(0, 10);
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const { data: recent } = await supabase
    .from('ct_daily_briefs')
    .select('id')
    .eq('session_date', today)
    .eq('triggered_by', 'breaking_news')
    .gte('created_at', twoHoursAgo)
    .limit(1);
  if ((recent ?? []).length > 0) return { fired: false, skipped: 'cooldown_2h' };

  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return { fired: false, skipped: 'no_env' };

  try {
    // Fire-and-forget HTTP call (shorter path than a round-trip via Vault RPC).
    fetch(`${url}/functions/v1/ct-daily-brief`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ triggered_by: 'breaking_news', reason }),
    }).catch((e) => console.warn('[tavily-news] rebrief fire failed:', String(e)));
    return { fired: true };
  } catch (e) {
    console.warn('[tavily-news] rebrief fire threw:', String(e));
    return { fired: false, skipped: 'fetch_threw' };
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();

  try {
    const watchlist = await getWatchlist(supabase);
    const severityThreshold = Number(await getConfig<number>('claude_breaking_news_severity_rebrief', 4));

    // Rotation state — macro queries first, then one per ticker.
    const slots: Array<{ id: string; query: string; category: string; ticker?: string }> = [
      ...MACRO_QUERIES,
      ...watchlist.map((t) => ({
        id: `ticker_${t}`,
        query: `${t} stock recent news`,
        category: 'sector',
        ticker: t,
      })),
    ];

    const cursorRaw = await getConfig<number>(ROTATION_CURSOR_KEY, 0);
    const cursor = ((Number(cursorRaw) || 0) % slots.length + slots.length) % slots.length;
    const slot = slots[cursor];
    const nextCursor = (cursor + 1) % slots.length;

    // Advance cursor BEFORE the work so a crash doesn't pin the rotation.
    try {
      await supabase.from('ct_config').upsert(
        {
          key: ROTATION_CURSOR_KEY,
          value: nextCursor,
          description: 'Next rotation slot for ct-tavily-news-watcher (0..N-1).',
          category: 'claude',
          default_value: 0,
        },
        { onConflict: 'key' },
      );
    } catch (e) {
      // Non-fatal — worst case we re-run the same slot next tick.
      console.warn('[tavily-news] cursor advance failed:', String(e));
    }

    // Search Tavily
    let results: TavilyResult[] = [];
    let tavilyError: string | null = null;
    try {
      results = await searchTavily(slot.query, 10);
    } catch (e) {
      tavilyError = e instanceof Error ? e.message : String(e);
    }

    // Dedupe against last 48h of ct_breaking_news for this source.
    const urls = results.map((r) => r.url).filter((u): u is string => !!u);
    let seen = new Set<string>();
    if (urls.length > 0) {
      const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
      const { data: existing } = await supabase
        .from('ct_breaking_news')
        .select('url')
        .eq('source', 'tavily')
        .gte('ingested_at', since)
        .in('url', urls);
      seen = new Set((existing ?? []).map((r: { url: string | null }) => r.url ?? '').filter(Boolean));
    }

    const fresh = results.filter((r) => r.url && !seen.has(r.url));

    let inserted = 0;
    let classifyFailed = 0;
    let triggersCount = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    const triggeredHeadlines: string[] = [];
    let rebriefFired = false;
    let rebriefSkipped: string | null = null;

    for (const result of fresh) {
      const { classification, tokens_in, tokens_out } = await classifyArticle(
        result,
        watchlist,
        { slotId: slot.id, category: slot.category },
      );
      totalTokensIn += tokens_in;
      totalTokensOut += tokens_out;

      if (!classification) {
        classifyFailed += 1;
        continue;
      }

      const triggersRebrief = classification.severity >= severityThreshold;
      // Bias "sector" single-ticker queries toward their own ticker when macro_wide
      // isn't claimed — keeps the per-ticker rotation useful even if Haiku forgot.
      if (slot.ticker && classification.tickers_affected.length === 0 && !classification.macro_wide) {
        classification.tickers_affected = [slot.ticker];
      }

      const { error: insertErr } = await supabase.from('ct_breaking_news').insert({
        headline: (result.title || '(no title)').slice(0, 500),
        url: result.url,
        source: 'tavily',
        severity: classification.severity,
        sentiment: classification.sentiment,
        tickers_affected: classification.tickers_affected,
        macro_wide: classification.macro_wide,
        category: classification.category,
        summary: classification.summary,
        raw: {
          tavily_result: result,
          query: slot.query,
          slot_id: slot.id,
        },
        triggers_rebrief: triggersRebrief,
        published_at: result.published_date ?? null,
      });
      if (insertErr) {
        // Unique-violation on (source, url) is expected under races — not a failure.
        if ((insertErr as { code?: string }).code === '23505') continue;
        console.warn('[tavily-news] insert failed:', insertErr.message);
        continue;
      }

      inserted += 1;
      if (triggersRebrief) {
        triggersCount += 1;
        triggeredHeadlines.push(result.title || '(no title)');
      }
    }

    // If any triggers fired, kick one re-brief (rate-limited to 2h cool-down).
    if (triggersCount > 0) {
      const reason = triggeredHeadlines.length === 1
        ? triggeredHeadlines[0]
        : `${triggersCount} breaking events — lead: ${triggeredHeadlines[0]}`;
      const res = await fireRebrief(supabase, reason.slice(0, 500));
      rebriefFired = res.fired;
      rebriefSkipped = res.skipped ?? null;
    }

    // Claude usage log — batched (the classifier call count is fresh.length - failures).
    if (totalTokensIn + totalTokensOut > 0) {
      logClaudeUsage({
        source: 'ct-tavily-news-watcher',
        model: CLAUDE_MODELS.haiku,
        usage: { input_tokens: totalTokensIn, output_tokens: totalTokensOut },
        duration_ms: Date.now() - startedAt,
        metadata: { slot: slot.id, inserted, triggers: triggersCount },
      }, supabase as unknown as { from: (t: string) => { insert: (r: Record<string, unknown>) => Promise<unknown> } });
    }

    // Decision-journal row — one per invocation.
    try {
      await supabase.from('ct_claude_decisions').insert({
        decision_type: 'breaking_news_processed',
        model_tier: 'haiku',
        context_snapshot: {
          slot: slot.id,
          query: slot.query,
          tavily_results: results.length,
          fresh_count: fresh.length,
          seen_count: seen.size,
          tavily_error: tavilyError,
        },
        reasoning: `Tavily slot=${slot.id} results=${results.length} fresh=${fresh.length} inserted=${inserted} triggers=${triggersCount}${rebriefFired ? ' → rebrief fired' : rebriefSkipped ? ` → rebrief skipped (${rebriefSkipped})` : ''}`,
        outcome: inserted > 0
          ? `inserted_${inserted}_triggers_${triggersCount}${rebriefFired ? '_rebrief' : ''}`
          : tavilyError ? `tavily_error` : 'nothing_fresh',
        tokens_in: totalTokensIn,
        tokens_out: totalTokensOut,
      });
    } catch (e) {
      console.warn('[tavily-news] decision journal insert failed:', String(e));
    }

    const body = {
      ok: true,
      slot: slot.id,
      query: slot.query,
      cursor_before: cursor,
      cursor_after: nextCursor,
      tavily_results: results.length,
      fresh: fresh.length,
      classify_failed: classifyFailed,
      inserted,
      triggers: triggersCount,
      rebrief_fired: rebriefFired,
      rebrief_skipped: rebriefSkipped,
      severity_threshold: severityThreshold,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      tavily_error: tavilyError,
      duration_ms: Date.now() - startedAt,
    };
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[tavily-news] fatal:', e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
