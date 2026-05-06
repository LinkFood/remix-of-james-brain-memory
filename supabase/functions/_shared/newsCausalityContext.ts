/**
 * newsCausalityContext — recent news + flow-causality organ.
 * Sources: ct_news_analyses (Claude-graded per-instrument), ct_breaking_news
 * (Tavily/UW firehose: severity 1..5, tickers_affected[], category),
 * ct_news_causality (left-join: did flow/dark-pool move within 15min?).
 * Normalizes both firehoses to one shape; ranks severity DESC then
 * ingested_at DESC. Default window 6h. Full ContextHelper<T> — never throws.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type {
  ContextHelper,
  HelperDescription,
  HelperFetchContext,
  HelperOpts,
  HelperResult,
  OrganMetadata,
  OrganStatus,
} from './contextHelper.ts';

export type NewsSource = 'ct_news_analyses' | 'ct_breaking_news';
export type NewsSentiment =
  | 'positive'
  | 'negative'
  | 'neutral'
  | 'bullish'
  | 'bearish'
  | 'ambiguous';

export interface NewsCausalityFields {
  moved: boolean | null;
  flow_hits_15min: number | null;
  flow_premium_15min: number | null;
  dp_hits_15min: number | null;
  dp_notional_15min: number | null;
}

export interface NewsItem {
  id: string;
  source_table: NewsSource;
  headline: string;
  summary: string | null;
  url: string | null;
  news_source: string | null; // publisher / 'tavily' / 'uw_news'
  severity: number;           // 1..5; from severity OR significance
  sentiment: NewsSentiment | null;
  category: string | null;
  tickers_affected: string[]; // breaking → array; analyses → [instrument]
  event_at: string;           // headline event time, falls back to ingest. ISO 8601.
  ingested_at: string;        // when our DB ingested it. ISO 8601.
  claude_take: string | null; // only on ct_news_analyses rows
  causality: NewsCausalityFields;
  // Per-item status — heterogeneous-source organ refinement (Phase 2).
  // breaking_news rows are by-design causality-less; analyses rows are
  // either populated (causality joined) or pending_analysis (cron hasn't
  // run for this row yet). Distinguishes 'data missing' from 'by design'
  // at the projection layer — instance #15 of methodology-errors-cascade.
  item_status: OrganStatus;
}

export interface NewsCausalityResult {
  items: NewsItem[];
  per_ticker: Record<string, NewsItem[]>;
  market_wide: NewsItem[];
  generated_at: string;
  lookback_hours: number;
}

const HELPER_NAME = 'news_causality';
const HELPER_VERSION = 'v1';
const DEFAULT_CAP = 10;
const MAX_CAP = 100;
const DEFAULT_LOOKBACK_HOURS = 6;
const PER_SOURCE_MULT = 3;

const EMPTY_CAUSALITY: NewsCausalityFields = {
  moved: null,
  flow_hits_15min: null,
  flow_premium_15min: null,
  dp_hits_15min: null,
  dp_notional_15min: null,
};

type BreakingRow = {
  id: string; headline: string; summary: string | null; url: string | null;
  source: string | null; severity: number; sentiment: string | null; category: string | null;
  tickers_affected: string[] | null; macro_wide: boolean | null;
  published_at: string | null; ingested_at: string;
};
type AnalysisRow = {
  id: string; instrument: string; news_headline: string; news_source: string | null;
  news_url: string | null; news_timestamp: string | null; claude_take: string | null;
  significance: number; sentiment: string | null; created_at: string;
};
type CausalityRow = {
  news_id: string; moved: boolean | null; flow_hits_15min: number | null;
  flow_premium_15min: number | null; dp_hits_15min: number | null; dp_notional_15min: number | null;
};

function normSentiment(s: string | null): NewsSentiment | null {
  if (!s) return null;
  const lc = s.toLowerCase();
  if (
    lc === 'positive' || lc === 'negative' || lc === 'neutral' ||
    lc === 'bullish'  || lc === 'bearish'  || lc === 'ambiguous'
  ) return lc as NewsSentiment;
  return null;
}

function buildOrganMetadata(
  asOf: string,
  lookbackHours: number,
  status: OrganStatus,
): OrganMetadata {
  return {
    as_of: asOf,
    source: 'ct_news_analyses + ct_breaking_news (causality joined from ct_news_causality)',
    window: `trailing ${lookbackHours}h`,
    status,
  };
}

function emptyResult(
  startedAt: number,
  lookbackHours: number,
  warning?: string,
  status: OrganStatus = 'no_signal_detected',
): HelperResult<NewsCausalityResult> {
  const asOf = new Date().toISOString();
  return {
    data: { items: [], per_ticker: {}, market_wide: [], generated_at: asOf, lookback_hours: lookbackHours },
    meta: {
      helperName: HELPER_NAME,
      helperVersion: HELPER_VERSION,
      fetchedAt: asOf,
      rowCount: 0,
      cacheHit: false,
      latencyMs: Date.now() - startedAt,
      truncated: false,
      ...(warning ? { warning } : {}),
    },
    organMetadata: buildOrganMetadata(asOf, lookbackHours, status),
  };
}

/** Convenience wrapper. opts: cap (default 10, max 100), tickerFocus, lookbackHours. */
export async function getNewsCausalityContext(
  supabase: SupabaseClient,
  opts: HelperOpts = {},
): Promise<HelperResult<NewsCausalityResult>> {
  const startedAt = Date.now();
  const cap = Math.max(1, Math.min(MAX_CAP, typeof opts.cap === 'number' ? opts.cap : DEFAULT_CAP));
  const lookbackHours =
    typeof opts.lookbackHours === 'number' && opts.lookbackHours > 0
      ? (opts.lookbackHours as number)
      : DEFAULT_LOOKBACK_HOURS;
  const tickerFocus =
    typeof opts.tickerFocus === 'string' && opts.tickerFocus.length > 0
      ? opts.tickerFocus.toUpperCase()
      : undefined;

  const sinceIso = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();
  const perSourceLimit = Math.min(MAX_CAP, cap * PER_SOURCE_MULT);

  try {
    let breakingQuery = supabase
      .from('ct_breaking_news')
      .select('id, headline, summary, url, source, severity, sentiment, category, tickers_affected, macro_wide, published_at, ingested_at')
      .gte('ingested_at', sinceIso)
      .order('severity', { ascending: false })
      .order('ingested_at', { ascending: false })
      .limit(perSourceLimit);
    if (tickerFocus) breakingQuery = breakingQuery.contains('tickers_affected', [tickerFocus]);

    let analysesQuery = supabase
      .from('ct_news_analyses')
      .select('id, instrument, news_headline, news_source, news_url, news_timestamp, claude_take, significance, sentiment, created_at')
      .gte('created_at', sinceIso)
      .order('significance', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(perSourceLimit);
    if (tickerFocus) analysesQuery = analysesQuery.eq('instrument', tickerFocus);

    const [breakingRes, analysesRes] = await Promise.all([breakingQuery, analysesQuery]);

    const warnings: string[] = [];
    if (breakingRes.error) warnings.push(`breaking_error:${breakingRes.error.message}`);
    if (analysesRes.error) warnings.push(`analyses_error:${analysesRes.error.message}`);

    const breakingRows = (Array.isArray(breakingRes.data) ? breakingRes.data : []) as BreakingRow[];
    const analysisRows = (Array.isArray(analysesRes.data) ? analysesRes.data : []) as AnalysisRow[];

    // Causality lookup — only ct_news_analyses rows have news_id matches.
    const causalityMap = new Map<string, NewsCausalityFields>();
    if (analysisRows.length > 0) {
      const { data: causalityRows, error: causalityErr } = await supabase
        .from('ct_news_causality')
        .select('news_id, moved, flow_hits_15min, flow_premium_15min, dp_hits_15min, dp_notional_15min')
        .in('news_id', analysisRows.map((r) => r.id));
      if (causalityErr) warnings.push(`causality_error:${causalityErr.message}`);
      else if (Array.isArray(causalityRows)) {
        for (const c of causalityRows as CausalityRow[]) {
          causalityMap.set(c.news_id, {
            moved: c.moved,
            flow_hits_15min: c.flow_hits_15min == null ? null : Number(c.flow_hits_15min),
            flow_premium_15min: c.flow_premium_15min == null ? null : Number(c.flow_premium_15min),
            dp_hits_15min: c.dp_hits_15min == null ? null : Number(c.dp_hits_15min),
            dp_notional_15min: c.dp_notional_15min == null ? null : Number(c.dp_notional_15min),
          });
        }
      }
    }

    const items: NewsItem[] = [];
    for (const r of breakingRows) {
      items.push({
        id: r.id,
        source_table: 'ct_breaking_news',
        headline: r.headline,
        summary: r.summary,
        url: r.url,
        news_source: r.source,
        severity: Number(r.severity),
        sentiment: normSentiment(r.sentiment),
        category: r.category,
        tickers_affected: Array.isArray(r.tickers_affected)
          ? r.tickers_affected.filter((t) => typeof t === 'string' && t.length > 0)
          : [],
        event_at: r.published_at ?? r.ingested_at,
        ingested_at: r.ingested_at,
        claude_take: null,
        causality: EMPTY_CAUSALITY,
        item_status: 'firehose_only_no_causality',
      });
    }
    for (const r of analysisRows) {
      const causality = causalityMap.get(r.id);
      items.push({
        id: r.id,
        source_table: 'ct_news_analyses',
        headline: r.news_headline,
        summary: null,
        url: r.news_url,
        news_source: r.news_source,
        severity: Number(r.significance),
        sentiment: normSentiment(r.sentiment),
        category: null,
        tickers_affected: r.instrument ? [r.instrument] : [],
        event_at: r.news_timestamp ?? r.created_at,
        ingested_at: r.created_at,
        claude_take: r.claude_take,
        causality: causality ?? EMPTY_CAUSALITY,
        item_status: causality ? 'populated' : 'pending_analysis',
      });
    }

    // severity DESC, then ingested_at DESC.
    const sorted = items.sort((a, b) =>
      b.severity !== a.severity ? b.severity - a.severity : Date.parse(b.ingested_at) - Date.parse(a.ingested_at)
    );
    const truncated = sorted.length > cap;
    const capped = sorted.slice(0, cap);

    const per_ticker: Record<string, NewsItem[]> = {};
    const market_wide: NewsItem[] = [];
    for (const it of capped) {
      if (it.tickers_affected.length === 0) { market_wide.push(it); continue; }
      for (const t of it.tickers_affected) {
        const key = t.toUpperCase();
        if (!per_ticker[key]) per_ticker[key] = [];
        per_ticker[key].push(it);
      }
    }

    const asOf = new Date().toISOString();
    return {
      data: { items: capped, per_ticker, market_wide, generated_at: asOf, lookback_hours: lookbackHours },
      meta: {
        helperName: HELPER_NAME,
        helperVersion: HELPER_VERSION,
        fetchedAt: asOf,
        rowCount: capped.length,
        cacheHit: false,
        latencyMs: Date.now() - startedAt,
        truncated,
        ...(warnings.length > 0 ? { warning: warnings.join(';') } : {}),
      },
      organMetadata: buildOrganMetadata(
        asOf,
        lookbackHours,
        capped.length > 0 ? 'populated' : 'no_signal_detected',
      ),
    };
  } catch (err) {
    return emptyResult(startedAt, lookbackHours, `exception:${err instanceof Error ? err.message : 'unknown_error'}`, 'error');
  }
}

const newsCausalityContextHelper: ContextHelper<NewsCausalityResult> = {
  name: HELPER_NAME,
  version: HELPER_VERSION,
  defaultCap: DEFAULT_CAP,
  isExpensive: false,
  minRefreshSeconds: 60,
  dependencies: [],
  // No audienceFilter — every audience can see news.

  async fetch(ctx: HelperFetchContext, opts: HelperOpts): Promise<HelperResult<NewsCausalityResult>> {
    return await getNewsCausalityContext(ctx.supabase, opts);
  },

  describe(): HelperDescription {
    return {
      name: HELPER_NAME,
      version: HELPER_VERSION,
      defaultCap: DEFAULT_CAP,
      expensive: false,
      minRefreshSeconds: 60,
      dependencies: [],
      outputShape:
        'Recent news items unioned from ct_breaking_news + ct_news_analyses, ranked severity DESC then recency. Each item carries severity 1..5, sentiment, category, tickers_affected[], optional causality (flow/dp 15min hits + moved) when an analyses row matches ct_news_causality, and item_status (OrganStatus enum: firehose_only_no_causality | populated | pending_analysis) for projection-layer disambiguation. Grouped per_ticker and market_wide. Organ-level organMetadata declares as_of/source/window/status.',
      exampleResult: { items: [], per_ticker: {}, market_wide: [], generated_at: '2026-04-30T18:30:00.000Z', lookback_hours: 6 },
    };
  },
};

export default newsCausalityContextHelper;
