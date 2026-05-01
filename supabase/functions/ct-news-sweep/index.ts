/**
 * ct-news-sweep — per-ticker Tavily news sweep, fired only on FRESH FLOW SIGNAL.
 *
 * Complements ct-tavily-news-watcher (one rotated query per call). This function
 * sweeps a hot subset of the watchlist: tickers that fired flags inside a recent
 * lookback window get a Tavily search; quiet tickers do not.
 *
 * Flow per invocation:
 *   1. Build hot-ticker list from ct_flags within last `news_sweep_hot_ticker_lookback_min`
 *      minutes, intersected with the watchlist, sorted by flag count desc.
 *   2. Call tavilyBudgetTier() and cap hot-ticker count by tier:
 *        unrestricted=10, tightened=5, critical=2, exhausted=0.
 *   3. For each capped hot ticker:
 *        a. searchTavily() via shared client (auto-logs to ct_tavily_usage,
 *           auto-refuses on exhaustion or kill-switch).
 *        b. Dedupe URLs against ct_breaking_news (source='tavily_sweep') in the
 *           last 48h.
 *        c. Haiku classify each fresh article.
 *        d. Insert row with source='tavily_sweep', or severity=1 fallback row
 *           on classify failure (preserves dedupe key).
 *        e. Sleep 1s between tickers.
 *   4. Return per-ticker stats + tier + pct_used + hot/swept counts.
 *
 * Auth: service role only. Called by pg_cron every 30 min during US RTH.
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
import { getConfig } from '../_shared/configCache.ts';
import {
  searchTavily,
  tavilyBudgetTier,
  TavilyBudgetError,
  TavilyError,
  type TavilyResult,
  type TavilyTier,
} from '../_shared/tavilyClient.ts';
import { buildClaudeContext } from '../_shared/claudeReadSurface.ts';

// ---------------------------------------------------------------------------
// Brain integration (Phase 4 — synthesis layer migration).
// Audience: 'cotrader'. Organs surfaced to the per-article classifier:
//   - event_recency  (so "stale-vs-fresh" severity is anchored to last-72h
//                     material events, not the model's prior)
//   - news_causality (existing news context the brain already mined — keeps
//                     the per-article classifier from re-rating duplicates)
//   - flow_heatmap   (current flow regime — severity 4 vs 3 often hinges on
//                     whether the tape is already pricing it)
// Tavily remains the source for new news; the brain provides existing context.
// One brain build per handler tick is shared across every classify call.
// ---------------------------------------------------------------------------
interface BrainSummary {
  session_date: string;
  what_just_happened: string;
  event_recency: unknown;
  news_causality: unknown;
  flow_heatmap: unknown;
}

function pickOrgan(organs: Record<string, unknown>, name: string): unknown {
  const o = organs[name];
  if (o && typeof o === 'object' && 'data' in (o as Record<string, unknown>)) {
    return (o as { data: unknown }).data;
  }
  return null;
}

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

const TIER_CAPS: Record<TavilyTier, number> = {
  unrestricted: 10,
  tightened: 5,
  critical: 2,
  exhausted: 0,
};

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
  brain: BrainSummary | null,
): Promise<ClassifyOutcome> {
  const userMessage = JSON.stringify({
    watchlist,
    scoped_ticker: scopedTicker,
    brain_context: brain,
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

    // Brain (synthesis layer Phase 4). One build per handler tick, shared
    // across every per-article classify call. Best-effort — if the brain
    // throws, the classifier still runs without context.
    let brain: BrainSummary | null = null;
    try {
      const ctx = await buildClaudeContext(supabase, {
        audience: 'cotrader',
        consumerName: 'ct-news-sweep',
      });
      brain = {
        session_date: ctx.preamble.temporalAnchor,
        what_just_happened: ctx.preamble.whatJustHappened,
        event_recency: pickOrgan(ctx.organs as Record<string, unknown>, 'event_recency'),
        news_causality: pickOrgan(ctx.organs as Record<string, unknown>, 'news_causality'),
        flow_heatmap: pickOrgan(ctx.organs as Record<string, unknown>, 'flow_heatmap'),
      };
    } catch (e) {
      console.warn('[news-sweep] brain build failed (classifier runs without context):',
        e instanceof Error ? e.message : String(e));
    }

    // -----------------------------------------------------------------------
    // Step 1: Hot-ticker selector — count flags per watchlist ticker in window.
    // ct_flags.instrument holds the underlying ticker (specialist_ticker is
    // populated only for specialist-routed flags; null on detector flags).
    // -----------------------------------------------------------------------
    const lookbackMin = Number(await getConfig<number>('news_sweep_hot_ticker_lookback_min', 30));
    const since = new Date(Date.now() - lookbackMin * 60_000).toISOString();

    const { data: flagRows } = await supabase
      .from('ct_flags')
      .select('instrument')
      .gte('created_at', since)
      .in('instrument', watchlist);

    const flagCount = new Map<string, number>();
    for (const r of (flagRows ?? [])) {
      const t = (r as { instrument: string }).instrument;
      if (t) flagCount.set(t, (flagCount.get(t) ?? 0) + 1);
    }

    const hotTickers = Array.from(flagCount.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);

    const elapsedMsEarly = () => Date.now() - startedAt;

    if (hotTickers.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          skipped: 'no_hot_tickers',
          queries_fired: 0,
          hot_tickers_found: 0,
          tickers_swept: 0,
          lookback_min: lookbackMin,
          elapsed_ms: elapsedMsEarly(),
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    // -----------------------------------------------------------------------
    // Step 2: Tier-aware ticker cap.
    // -----------------------------------------------------------------------
    const tierResult = await tavilyBudgetTier();
    const cap = TIER_CAPS[tierResult.tier] ?? 10;

    if (cap === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          skipped: 'tavily_exhausted',
          tier: tierResult.tier,
          pct_used: tierResult.pct_used,
          queries_fired: 0,
          hot_tickers_found: hotTickers.length,
          tickers_swept: 0,
          elapsed_ms: elapsedMsEarly(),
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const tickersToSweep = hotTickers.slice(0, cap);

    // -----------------------------------------------------------------------
    // Step 3: Per-ticker Tavily call via shared client.
    // -----------------------------------------------------------------------
    const newPerTicker: Record<string, number> = {};
    const errorsPerTicker: Record<string, string> = {};
    let queriesFired = 0;
    let totalNew = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let rateLimitHits = 0;

    // Pre-compute 48h dedupe lookback window once.
    const dedupeSince = new Date(Date.now() - 48 * 3600 * 1000).toISOString();

    for (let i = 0; i < tickersToSweep.length; i++) {
      const ticker = tickersToSweep[i];
      const query = `${ticker} stock news today`;
      newPerTicker[ticker] = 0;

      // 1. Tavily via shared client.
      let results: TavilyResult[];
      try {
        results = await searchTavily({
          query,
          caller: 'ct-news-sweep',
          maxResults: TAVILY_MAX_RESULTS,
          searchDepth: 'basic',
          topic: 'news',
          days: TAVILY_DAYS,
        });
        queriesFired += 1;
      } catch (e) {
        if (e instanceof TavilyBudgetError) {
          // Budget tier flipped to exhausted (or caller killed) mid-loop.
          errorsPerTicker[ticker] = `tavily_budget: ${e.tier}`;
          break;
        }
        if (e instanceof TavilyError) {
          errorsPerTicker[ticker] = `tavily: ${e.message}`;
        } else {
          errorsPerTicker[ticker] = `tavily: ${e instanceof Error ? e.message : String(e)}`;
        }
        if (i < tickersToSweep.length - 1) await sleep(SLEEP_BETWEEN_TICKERS_MS);
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
          .gte('ingested_at', dedupeSince)
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
        const outcome = await classifyArticle(article, watchlist, ticker, brain);
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
      if (i < tickersToSweep.length - 1) {
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
        tier: tierResult.tier,
        pct_used: tierResult.pct_used,
        hot_tickers_found: hotTickers.length,
        tickers_swept: tickersToSweep.length,
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
