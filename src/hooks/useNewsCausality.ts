/**
 * useNewsCausality — frontend mirror of the `newsCausalityContext` brain organ.
 *
 * Sources:
 *   - ct_news_analyses    — Claude-graded per-instrument news (significance 1-3)
 *   - ct_breaking_news    — Tavily / UW firehose (severity 1-5, tickers_affected[])
 *   - ct_news_causality   — left-join: did flow/dark-pool move within 15min?
 *
 * Normalizes both firehoses to a single shape, ranks severity DESC then
 * recency DESC, groups by ticker + market_wide. Mirrors `getNewsCausalityContext`
 * shape so any UI built against this hook stays aligned with what Claude
 * consumers see.
 *
 * Phase 5 of the Synthesis Layer (see `docs/SYNTHESIS_LAYER_ARCHITECTURE.md`
 * § 5a). queryKey starts with `'news-causality-'` (NOT `ct_*`) so the
 * bell-ring useMarketHoursTrigger invalidator picks it up cleanly. Refetch
 * every 60s — news lands continuously but doesn't need 30s polling.
 *
 * Defensive on every error path. retry:false.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type NewsSource = 'ct_news_analyses' | 'ct_breaking_news';
export type NewsSentiment =
  | 'positive' | 'negative' | 'neutral'
  | 'bullish'  | 'bearish'  | 'ambiguous';

export interface NewsCausalityFields {
  moved: boolean | null;
  flow_hits_15min: number | null;
  flow_premium_15min: number | null;
  dp_hits_15min: number | null;
  dp_notional_15min: number | null;
}

export interface NewsItemRow {
  id: string;
  source_table: NewsSource;
  headline: string;
  summary: string | null;
  url: string | null;
  news_source: string | null;
  /** 1-5 normalized urgency. analyses significance 1-3 mapped to 1/3/5. */
  severity: number;
  sentiment: NewsSentiment | null;
  category: string | null;
  tickers_affected: string[];
  /** Headline event time, falls back to ingest. ISO 8601. */
  event_at: string;
  /** When our DB ingested it. ISO 8601. */
  ingested_at: string;
  claude_take: string | null;
  causality: NewsCausalityFields;
}

export interface UseNewsCausalityArgs {
  /** Single ticker focus. Pass null/undefined to fetch full universe. */
  ticker?: string | null;
  /** Hours back from now. Default 6. */
  lookbackHours?: number;
  /** Cap returned items. Default 25. Max 100. */
  cap?: number;
  /** Minimum severity floor (1-5). Default 1 (no floor). */
  minSeverity?: number;
}

const DEFAULT_LOOKBACK_HOURS = 6;
const DEFAULT_CAP = 25;
const MAX_CAP = 100;
const PER_SOURCE_MULT = 3;

const EMPTY_CAUSALITY: NewsCausalityFields = {
  moved: null,
  flow_hits_15min: null,
  flow_premium_15min: null,
  dp_hits_15min: null,
  dp_notional_15min: null,
};

interface BreakingRow {
  id: string;
  headline: string;
  summary: string | null;
  url: string | null;
  source: string | null;
  severity: number;
  sentiment: string | null;
  category: string | null;
  tickers_affected: string[] | null;
  macro_wide: boolean | null;
  published_at: string | null;
  ingested_at: string;
}

interface AnalysisRow {
  id: string;
  instrument: string;
  news_headline: string;
  news_source: string | null;
  news_url: string | null;
  news_timestamp: string | null;
  claude_take: string | null;
  significance: number;
  sentiment: string | null;
  created_at: string;
}

interface CausalityRow {
  news_id: string;
  moved: boolean | null;
  flow_hits_15min: number | null;
  flow_premium_15min: number | null;
  dp_hits_15min: number | null;
  dp_notional_15min: number | null;
}

function normSentiment(s: string | null): NewsSentiment | null {
  if (!s) return null;
  const lc = s.toLowerCase();
  if (
    lc === 'positive' || lc === 'negative' || lc === 'neutral' ||
    lc === 'bullish'  || lc === 'bearish'  || lc === 'ambiguous'
  ) return lc as NewsSentiment;
  return null;
}

function fromBreaking(r: BreakingRow): NewsItemRow {
  return {
    id: r.id,
    source_table: 'ct_breaking_news',
    headline: r.headline,
    summary: r.summary,
    url: r.url,
    news_source: r.source,
    severity: Number(r.severity ?? 1),
    sentiment: normSentiment(r.sentiment),
    category: r.category,
    tickers_affected: Array.isArray(r.tickers_affected)
      ? r.tickers_affected.filter((t): t is string => typeof t === 'string' && t.length > 0)
      : [],
    event_at: r.published_at ?? r.ingested_at,
    ingested_at: r.ingested_at,
    claude_take: null,
    causality: EMPTY_CAUSALITY,
  };
}

function fromAnalysis(r: AnalysisRow, causality: NewsCausalityFields | undefined): NewsItemRow {
  // significance 1-3 → severity 1/3/5 so a sig-3 hits the >=4 red threshold.
  const sig = Number(r.significance ?? 1);
  const severity = sig <= 1 ? 1 : sig === 2 ? 3 : 5;
  return {
    id: r.id,
    source_table: 'ct_news_analyses',
    headline: r.news_headline,
    summary: null,
    url: r.news_url,
    news_source: r.news_source,
    severity,
    sentiment: normSentiment(r.sentiment),
    category: null,
    tickers_affected: r.instrument ? [r.instrument] : [],
    event_at: r.news_timestamp ?? r.created_at,
    ingested_at: r.created_at,
    claude_take: r.claude_take,
    causality: causality ?? EMPTY_CAUSALITY,
  };
}

export function useNewsCausality(args: UseNewsCausalityArgs = {}) {
  const ticker = args.ticker ?? null;
  const lookbackHours = Math.max(1, args.lookbackHours ?? DEFAULT_LOOKBACK_HOURS);
  const cap = Math.max(1, Math.min(MAX_CAP, args.cap ?? DEFAULT_CAP));
  const minSeverity = Math.max(1, args.minSeverity ?? 1);

  const query = useQuery<NewsItemRow[]>({
    queryKey: [
      'news-causality',
      { ticker, lookbackHours, cap, minSeverity },
    ],
    refetchInterval: 60_000,
    staleTime: 55_000,
    retry: false,
    queryFn: async () => {
      const sinceIso = new Date(Date.now() - lookbackHours * 3600_000).toISOString();
      const perSourceLimit = Math.min(MAX_CAP, cap * PER_SOURCE_MULT);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb: any = supabase;
      let breakingQ = sb.from('ct_breaking_news')
        .select('id, headline, summary, url, source, severity, sentiment, category, tickers_affected, macro_wide, published_at, ingested_at')
        .gte('ingested_at', sinceIso)
        .order('severity', { ascending: false })
        .order('ingested_at', { ascending: false })
        .limit(perSourceLimit);
      if (ticker) breakingQ = breakingQ.contains('tickers_affected', [ticker.toUpperCase()]);

      let analysesQ = sb.from('ct_news_analyses')
        .select('id, instrument, news_headline, news_source, news_url, news_timestamp, claude_take, significance, sentiment, created_at')
        .gte('created_at', sinceIso)
        .order('significance', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(perSourceLimit);
      if (ticker) analysesQ = analysesQ.eq('instrument', ticker.toUpperCase());

      const [b, a] = await Promise.all([breakingQ, analysesQ]);
      if (b.error) throw b.error;
      if (a.error) throw a.error;

      const breakingRows = (Array.isArray(b.data) ? b.data : []) as BreakingRow[];
      const analysisRows = (Array.isArray(a.data) ? a.data : []) as AnalysisRow[];

      // Causality lookup for analyses rows only.
      const causalityMap = new Map<string, NewsCausalityFields>();
      if (analysisRows.length > 0) {
        const { data: cRows, error: cErr } = await sb.from('ct_news_causality')
          .select('news_id, moved, flow_hits_15min, flow_premium_15min, dp_hits_15min, dp_notional_15min')
          .in('news_id', analysisRows.map((r) => r.id));
        if (!cErr && Array.isArray(cRows)) {
          for (const c of cRows as CausalityRow[]) {
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

      const items: NewsItemRow[] = [];
      for (const r of breakingRows) items.push(fromBreaking(r));
      for (const r of analysisRows) items.push(fromAnalysis(r, causalityMap.get(r.id)));

      // severity DESC, then ingested_at DESC.
      const sorted = items
        .filter((it) => it.severity >= minSeverity)
        .sort((x, y) =>
          y.severity !== x.severity
            ? y.severity - x.severity
            : Date.parse(y.ingested_at) - Date.parse(x.ingested_at),
        );
      return sorted.slice(0, cap);
    },
  });

  const items = query.data ?? [];

  const perTicker = useMemo(() => {
    const m = new Map<string, NewsItemRow[]>();
    for (const it of items) {
      for (const t of it.tickers_affected) {
        const k = t.toUpperCase();
        if (!m.has(k)) m.set(k, []);
        m.get(k)!.push(it);
      }
    }
    return m;
  }, [items]);

  const marketWide = useMemo(
    () => items.filter((it) => it.tickers_affected.length === 0),
    [items],
  );

  /** Hot-news count per ticker over a recency window — defaults: last 30min, severity ≥ 3. */
  const hotCountForTicker = (
    tkr: string,
    opts: { withinMin?: number; minSev?: number } = {},
  ): number => {
    const withinMin = opts.withinMin ?? 30;
    const minSev = opts.minSev ?? 3;
    const cutoff = Date.now() - withinMin * 60_000;
    const list = perTicker.get(tkr.toUpperCase()) ?? [];
    let n = 0;
    for (const it of list) {
      if (it.severity < minSev) continue;
      const ts = Date.parse(it.ingested_at);
      if (Number.isFinite(ts) && ts >= cutoff) n++;
    }
    return n;
  };

  return {
    items,
    perTicker,
    marketWide,
    hotCountForTicker,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
