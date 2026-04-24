/**
 * ct-news-sweep — per-ticker Tavily news sweep (every 10 min during US RTH).
 *
 * Complements ct-tavily-news-watcher (which is ONE query per call, via rotation
 * cursor). This function is the per-ticker-loop variant: for each ticker in the
 * watchlist, fire a fresh Tavily search and ingest any net-new articles.
 *
 * Thesis: options front-run news. Sweeping per-ticker every 10 min gives the
 * specialists a narrower, per-name news surface than the rotation can provide.
 *
 * Flow per invocation:
 *   1. Load watchlist (10 tickers by default).
 *   2. For each ticker:
 *        a. Tavily search `"$TICKER stock news today"` (max_results=8, days=1).
 *        b. Dedupe URLs against ct_breaking_news where source='tavily_sweep'
 *           in the last 48h.
 *        c. For each new article → Haiku classify (minimal: severity, sentiment,
 *           tickers_affected, category, summary).
 *        d. Insert row with source='tavily_sweep'.
 *        e. On Haiku 429 or any classify failure: insert a "raw" row with
 *           severity=1 (lowest) so the URL is recorded and we don't re-classify
 *           it on every subsequent tick.
 *        f. Sleep 1s between tickers (polite to Tavily + Haiku).
 *   3. Return per-ticker new-article counts + aggregate cost + elapsed.
 *
 * Auth: service role only. Called by pg_cron every 10 min weekdays 13-20 UTC.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import {
  callClaude,
  CLAUDE_MODELS,
  CLAUDE_RATES,
  parseTextContent,
  ClaudeError,
} from '../_shared/anthropic.ts';
import { getWatchlist } from '../_shared/watchlist.ts';

// ---------------------------------------------------------------------------
// Minimal Haiku classifier prompt — narrower than ct-tavily-news-watcher's
// because each Tavily call is already scoped to a single ticker.
// ---------------------------------------------------------------------------
const CLASSIFIER_SYSTEM = `You are the Co-Trader's per-ticker news classifier.
An article was retrieved from a Tavily search scoped to a specific ticker.
Classify it strictly.

Severity (1-5):
  1 — noise / opinion / evergreen
  2 — minor development
  3 — noteworthy, may nudge the name
  4 — market-moving for this name OR macro-wide catalyst
  5 — session-altering event

Return STRICT JSON, no markdown, no prose:
{
  "severity": 1-5,
  "sentiment": "bullish" | "bearish" | "neutral" | "ambiguous",
  "tickers_affected": ["TICKER", ...],   // subset of the watchlist you are given, or []
  "category": "geopolitical" | "macro" | "earnings" | "sector" | "policy" | "other",
  "summary": "one sentence — the event and why it matters"
}

Rules:
  - Bias tickers_affected to include the scoped ticker unless clearly irrelevant.
  - Older than 48h or obviously stale → severity=1.
  - sentiment is from the perspective of risk assets (bullish = risk-on for the name).
  - tickers_affected MUST be a subset of the watchlist.`;

const TAVILY_MAX_RESULTS = 8;
const TAVILY_DAYS = 1;
const SLEEP_BETWEEN_TICKERS_MS = 1000;
const CLASSIFY_FAILURE_SEVERITY = 1; // Insert row with severity=1 when classify fails (NOT NULL constraint)

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
  summary: string;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

  const summary = typeof o.summary === 'string' ? o.summary.slice(0, 500) : '';
  if (!summary) return null;

  return { severity, sentiment, tickers_affected: tickers, category, summary };
}

// ---------------------------------------------------------------------------
// Tavily call — per-ticker scoped.
// ---------------------------------------------------------------------------
async function searchTavily(query: string): Promise<TavilyResult[]> {
  const apiKey = Deno.env.get('TAVILY_API_KEY');
  if (!apiKey) throw new Error('TAVILY_API_KEY not configured');

  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: TAVILY_MAX_RESULTS,
      search_depth: 'basic',
      days: TAVILY_DAYS,
      topic: 'news',
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`[news-sweep] tavily ${resp.status}: ${text.slice(0, 300)}`);
    if (resp.status >= 400 && resp.status < 500) {
      throw new Error(`Tavily ${resp.status}: ${text.slice(0, 200)}`);
    }
    throw new Error(`Tavily ${resp.status}`);
  }

  const data = (await resp.json()) as TavilyResponse;
  return Array.isArray(data.results) ? data.results : [];
}

interface ClassifyOutcome {
  classification: Classification | null;
  tokens_in: number;
  tokens_out: number;
  rate_limited: boolean;
  errored: boolean;
}

async function classifyArticle(
  result: TavilyResult,
  watchlist: string[],
  scopedTicker: string,
): Promise<ClassifyOutcome> {
  const userMessage = JSON.stringify({
    watchlist,
    scoped_ticker: scopedTicker,
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
    const rateLimited = e instanceof ClaudeError && e.status === 429;
    console.warn('[news-sweep] classifier error:',
      e instanceof ClaudeError ? `Claude ${e.status}` : String(e));
    return { classification: null, tokens_in: 0, tokens_out: 0, rate_limited: rateLimited, errored: true };
  }

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch { /* ignore */ }
    }
  }

  const classification = validateClassification(parsed, watchlist);
  return {
    classification,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    rate_limited: false,
    errored: classification === null,
  };
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

    const newPerTicker: Record<string, number> = {};
    const errorsPerTicker: Record<string, string> = {};
    let queriesFired = 0;
    let totalNew = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let rateLimitHits = 0;

    // Pre-compute 48h dedupe lookback window once.
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

    for (let i = 0; i < watchlist.length; i++) {
      const ticker = watchlist[i];
      const query = `${ticker} stock news today`;
      newPerTicker[ticker] = 0;

      // 1. Tavily
      let results: TavilyResult[] = [];
      try {
        results = await searchTavily(query);
        queriesFired += 1;
      } catch (e) {
        errorsPerTicker[ticker] = `tavily: ${e instanceof Error ? e.message : String(e)}`;
        // polite sleep even on error before next ticker
        if (i < watchlist.length - 1) await sleep(SLEEP_BETWEEN_TICKERS_MS);
        continue;
      }

      // 2. Dedupe against recent ct_breaking_news (source='tavily_sweep').
      const urls = results.map((r) => r.url).filter((u): u is string => !!u);
      let seen = new Set<string>();
      if (urls.length > 0) {
        const { data: existing } = await supabase
          .from('ct_breaking_news')
          .select('url')
          .eq('source', 'tavily_sweep')
          .gte('ingested_at', since)
          .in('url', urls);
        seen = new Set(
          (existing ?? [])
            .map((r: { url: string | null }) => r.url ?? '')
            .filter(Boolean),
        );
      }
      const fresh = results.filter((r) => r.url && !seen.has(r.url));

      // 3. Classify + insert each fresh article.
      for (const article of fresh) {
        const outcome = await classifyArticle(article, watchlist, ticker);
        totalTokensIn += outcome.tokens_in;
        totalTokensOut += outcome.tokens_out;
        if (outcome.rate_limited) rateLimitHits += 1;

        const row = outcome.classification
          ? {
              headline: (article.title || '(no title)').slice(0, 500),
              url: article.url,
              source: 'tavily_sweep',
              severity: outcome.classification.severity,
              sentiment: outcome.classification.sentiment,
              tickers_affected: outcome.classification.tickers_affected.length > 0
                ? outcome.classification.tickers_affected
                : [ticker],
              macro_wide: false,
              category: outcome.classification.category,
              summary: outcome.classification.summary,
              raw: { tavily_result: article, query, scoped_ticker: ticker },
              triggers_rebrief: false,
              published_at: article.published_date ?? null,
            }
          : {
              // Classify failed (429 or parse fail). Preserve the dedupe record
              // with lowest severity so we don't thrash Haiku on the same URL.
              headline: (article.title || '(no title)').slice(0, 500),
              url: article.url,
              source: 'tavily_sweep',
              severity: CLASSIFY_FAILURE_SEVERITY,
              sentiment: 'neutral' as const,
              tickers_affected: [ticker],
              macro_wide: false,
              category: 'other',
              summary: (article.content || '').slice(0, 240) || null,
              raw: {
                tavily_result: article,
                query,
                scoped_ticker: ticker,
                classify_failed: true,
                rate_limited: outcome.rate_limited,
              },
              triggers_rebrief: false,
              published_at: article.published_date ?? null,
            };

        const { error: insertErr } = await supabase.from('ct_breaking_news').insert(row);
        if (insertErr) {
          // Unique-violation on (source, url) — not a failure.
          if ((insertErr as { code?: string }).code === '23505') continue;
          console.warn(`[news-sweep] insert failed (${ticker}):`, insertErr.message);
          continue;
        }

        newPerTicker[ticker] += 1;
        totalNew += 1;
      }

      // 4. Polite sleep between tickers.
      if (i < watchlist.length - 1) {
        await sleep(SLEEP_BETWEEN_TICKERS_MS);
      }
    }

    // Cost calc (Haiku).
    const haikuRates = CLAUDE_RATES[CLAUDE_MODELS.haiku];
    const costUsd = haikuRates
      ? (totalTokensIn / 1_000_000) * haikuRates.input +
        (totalTokensOut / 1_000_000) * haikuRates.output
      : 0;

    const elapsedMs = Date.now() - startedAt;

    return new Response(
      JSON.stringify({
        ok: true,
        queries_fired: queriesFired,
        new_articles_per_ticker: newPerTicker,
        total_new: totalNew,
        cost_usd: Number(costUsd.toFixed(6)),
        tokens_in: totalTokensIn,
        tokens_out: totalTokensOut,
        rate_limit_hits: rateLimitHits,
        errors_per_ticker: errorsPerTicker,
        elapsed_ms: elapsedMs,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('[news-sweep] fatal:', e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
