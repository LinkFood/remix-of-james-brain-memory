/**
 * useBreakingNews — combined live news feed for /tape right gutter.
 *
 * Two sources:
 *   1. ct_breaking_news     — Tavily macro/sweep news (severity, sentiment, tickers)
 *   2. ct_news_analyses     — UW per-ticker news with Claude take (impact, significance)
 *
 * Bootstrap = REST fetch on mount (most recent 40 from each table).
 * Live      = Supabase Realtime INSERT subscriptions on both tables.
 * Floor     = TanStack Query refetchInterval 60s — covers the case where
 *             ALTER PUBLICATION succeeded but live delivery isn't pushing
 *             (memory: supabase_realtime_publication_caveat). News flows 24/7,
 *             no market-hours gating.
 *
 * Returned items are pre-normalized into a single shape for the renderer:
 *   - source       — 'breaking' (Tavily) or 'analysis' (UW per-ticker)
 *   - tickers[]    — array even when source carries a single instrument
 *   - tags[]       — derived heuristic tags (whale/flow/0DTE/OI) for color routing
 *   - severity     — normalized 0-5 (analyses use significance directly)
 *   - color        — pre-resolved left-border tailwind class for the row
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// 10-ticker watchlist (matches tenet 4 + Tape.tsx TICKERS).
const WATCHLIST = ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'TSLA', 'QQQ', 'SPY', 'IWM'];

const BOOTSTRAP_LIMIT = 40;
const MAX_FEED_ITEMS = 120;

export type NewsColor = 'red' | 'gold' | 'teal' | 'purple' | 'gray';

export interface NewsFeedItem {
  /** Unique key across both tables: `${source}:${id}` */
  key: string;
  source: 'breaking' | 'analysis';
  id: string;
  headline: string;
  url: string | null;
  /** Display source string ("Benzinga", "Tavily", "tavily_sweep", etc) */
  publisher: string | null;
  /** Best-available timestamp: published_at > news_timestamp > ingested_at > created_at */
  ts: string;
  summary: string | null;
  sentiment: 'bullish' | 'bearish' | 'neutral' | 'positive' | 'negative' | null;
  tickers: string[];
  tags: string[];
  /** 0-5 normalized urgency. ct_breaking_news.severity 1-5; ct_news_analyses.significance 1-3 doubled. */
  severity: number;
  color: NewsColor;
  /** Detector class this headline could trip (best-effort, gray = none). */
  detectorClass: 'signature_v1' | 'whale_v1' | 'unusual_oi_v1' | 'zerodte' | null;
}

interface BreakingNewsRow {
  id: string;
  headline: string;
  url: string | null;
  source: string | null;
  severity: number | null;
  sentiment: string | null;
  tickers_affected: string[] | null;
  macro_wide: boolean | null;
  category: string | null;
  summary: string | null;
  published_at: string | null;
  ingested_at: string;
}

interface NewsAnalysisRow {
  id: string;
  instrument: string | null;
  news_headline: string;
  news_source: string | null;
  news_url: string | null;
  news_timestamp: string | null;
  claude_take: string | null;
  impact: string | null;
  significance: number | null;
  sentiment: string | null;
  created_at: string;
}

const BREAKING_COLS =
  'id, headline, url, source, severity, sentiment, tickers_affected, macro_wide, category, summary, published_at, ingested_at';
const ANALYSIS_COLS =
  'id, instrument, news_headline, news_source, news_url, news_timestamp, claude_take, impact, significance, sentiment, created_at';

// --- Heuristic tag/color routing ---------------------------------------------

const ZERODTE_RE = /\b(0\s*-?\s*dte|zero\s*-?\s*dte|expir\w*\s+today|same[-\s]day\s+expir)/i;
const OI_RE = /\b(open\s*interest|\boi\b|gamma\s+wall|gamma\s*flip|max\s*pain)/i;
const WHALE_RE = /\b(whale|block\s+trade|massive\s+(call|put)|institutional|smart\s+money|sweep)/i;
const FLOW_RE = /\b(unusual\s+option\s+activity|unusual\s+flow|flow\s+alert|options\s+flow)/i;

function tagsForHeadline(headline: string, summary: string | null): string[] {
  const text = `${headline} ${summary ?? ''}`;
  const tags: string[] = [];
  if (WHALE_RE.test(text)) tags.push('whale');
  if (FLOW_RE.test(text)) tags.push('flow');
  if (ZERODTE_RE.test(text)) tags.push('0dte');
  if (OI_RE.test(text)) tags.push('oi');
  return tags;
}

function tickersFromText(text: string): string[] {
  const found = new Set<string>();
  for (const t of WATCHLIST) {
    // Word boundary match so "META" doesn't match "metadata".
    // Also catch "$NVDA" style tickers.
    const re = new RegExp(`(?:^|[^A-Z])\\$?${t}(?:[^A-Z]|$)`);
    if (re.test(text)) found.add(t);
  }
  return [...found];
}

/**
 * Color resolution per the plan:
 *   red    = severity >= 4         (signature_v1 — high urgency)
 *   gold   = whale/flow/major flag (whale_v1 — institutional flow)
 *   purple = 0DTE                  (zerodte_*)
 *   teal   = OI mention            (unusual_oi_v1)
 *   gray   = no detector match
 *
 * Order matters: severity wins over flow/OI/0DTE since red = "drop everything".
 */
function resolveColor(item: {
  severity: number;
  tags: string[];
  source: string | null;
  category: string | null;
}): { color: NewsColor; detectorClass: NewsFeedItem['detectorClass'] } {
  if (item.severity >= 4) return { color: 'red', detectorClass: 'signature_v1' };
  if (item.tags.includes('whale') || item.tags.includes('flow')) {
    return { color: 'gold', detectorClass: 'whale_v1' };
  }
  if (item.tags.includes('0dte')) return { color: 'purple', detectorClass: 'zerodte' };
  if (item.tags.includes('oi')) return { color: 'teal', detectorClass: 'unusual_oi_v1' };
  return { color: 'gray', detectorClass: null };
}

// --- Row → FeedItem normalization --------------------------------------------

function fromBreaking(row: BreakingNewsRow): NewsFeedItem {
  const tickers = (row.tickers_affected ?? []).filter((t) => WATCHLIST.includes(t));
  const headlineTickers = tickersFromText(row.headline);
  const merged = [...new Set([...tickers, ...headlineTickers])];
  const tags = tagsForHeadline(row.headline, row.summary);
  const severity = row.severity ?? 1;
  const ts = row.published_at ?? row.ingested_at;
  const sentimentRaw = row.sentiment;
  const sentiment =
    sentimentRaw === 'bullish' || sentimentRaw === 'bearish' || sentimentRaw === 'neutral'
      ? sentimentRaw
      : null;
  const { color, detectorClass } = resolveColor({
    severity,
    tags,
    source: row.source,
    category: row.category,
  });
  return {
    key: `breaking:${row.id}`,
    source: 'breaking',
    id: row.id,
    headline: row.headline,
    url: row.url,
    publisher: row.source,
    ts,
    summary: row.summary,
    sentiment,
    tickers: merged,
    tags,
    severity,
    color,
    detectorClass,
  };
}

function fromAnalysis(row: NewsAnalysisRow): NewsFeedItem {
  const tickers: string[] = [];
  if (row.instrument && WATCHLIST.includes(row.instrument)) tickers.push(row.instrument);
  for (const t of tickersFromText(row.news_headline)) {
    if (!tickers.includes(t)) tickers.push(t);
  }
  const tags = tagsForHeadline(row.news_headline, row.claude_take);
  // significance is 1-3; map to 1/3/5 so a sig-3 hits the >=4 red threshold.
  const sig = row.significance ?? 1;
  const severity = sig <= 1 ? 1 : sig === 2 ? 3 : 5;
  const ts = row.news_timestamp ?? row.created_at;
  const sentimentRaw = row.sentiment;
  const sentiment =
    sentimentRaw === 'positive' ||
    sentimentRaw === 'negative' ||
    sentimentRaw === 'neutral' ||
    sentimentRaw === 'bullish' ||
    sentimentRaw === 'bearish'
      ? (sentimentRaw as NewsFeedItem['sentiment'])
      : null;
  const { color, detectorClass } = resolveColor({
    severity,
    tags,
    source: row.news_source,
    category: null,
  });
  return {
    key: `analysis:${row.id}`,
    source: 'analysis',
    id: row.id,
    headline: row.news_headline,
    url: row.news_url,
    publisher: row.news_source,
    ts,
    summary: row.claude_take,
    sentiment,
    tickers,
    tags,
    severity,
    color,
    detectorClass,
  };
}

// --- Hook --------------------------------------------------------------------

interface CombinedFetch {
  breaking: NewsFeedItem[];
  analyses: NewsFeedItem[];
}

async function fetchCombined(): Promise<CombinedFetch> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const breakingPromise = (supabase.from as any)('ct_breaking_news')
    .select(BREAKING_COLS)
    .order('ingested_at', { ascending: false })
    .limit(BOOTSTRAP_LIMIT);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const analysisPromise = (supabase.from as any)('ct_news_analyses')
    .select(ANALYSIS_COLS)
    .order('created_at', { ascending: false })
    .limit(BOOTSTRAP_LIMIT);

  const [b, a] = await Promise.all([breakingPromise, analysisPromise]);
  if (b.error) throw new Error(`ct_breaking_news: ${b.error.message}`);
  if (a.error) throw new Error(`ct_news_analyses: ${a.error.message}`);

  return {
    breaking: ((b.data ?? []) as BreakingNewsRow[]).map(fromBreaking),
    analyses: ((a.data ?? []) as NewsAnalysisRow[]).map(fromAnalysis),
  };
}

export interface UseBreakingNewsResult {
  items: NewsFeedItem[];
  isLoading: boolean;
  error: Error | null;
  /** Items received via Realtime since last reset — used for "n new" badge */
  newSinceMount: number;
  resetNewCount: () => void;
}

export function useBreakingNews(): UseBreakingNewsResult {
  const qc = useQueryClient();
  const channelsRef = useRef<RealtimeChannel[]>([]);
  // Realtime-only items — appended to query data so the floor refetch can also drop them
  // back into the merged stream without duplicating.
  const [liveItems, setLiveItems] = useState<NewsFeedItem[]>([]);
  const [newSinceMount, setNewSinceMount] = useState(0);

  const query = useQuery({
    queryKey: ['ct_news_feed_v1'],
    queryFn: fetchCombined,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // Subscribe to INSERT on both tables. New rows go into liveItems and trigger
  // the new-since-mount counter. Floor refetch (60s) eventually folds them into
  // the canonical query data — dedupe by key handles the overlap window.
  useEffect(() => {
    const ch1 = supabase
      .channel('ct_breaking_news-feed-realtime')
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        { event: 'INSERT', schema: 'public', table: 'ct_breaking_news' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          const row = payload?.new as BreakingNewsRow | undefined;
          if (!row) return;
          const item = fromBreaking(row);
          setLiveItems((prev) => (prev.some((p) => p.key === item.key) ? prev : [item, ...prev]));
          setNewSinceMount((n) => n + 1);
        },
      )
      .subscribe();

    const ch2 = supabase
      .channel('ct_news_analyses-feed-realtime')
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        { event: 'INSERT', schema: 'public', table: 'ct_news_analyses' },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (payload: any) => {
          const row = payload?.new as NewsAnalysisRow | undefined;
          if (!row) return;
          const item = fromAnalysis(row);
          setLiveItems((prev) => (prev.some((p) => p.key === item.key) ? prev : [item, ...prev]));
          setNewSinceMount((n) => n + 1);
        },
      )
      .subscribe();

    channelsRef.current = [ch1, ch2];
    return () => {
      for (const ch of channelsRef.current) supabase.removeChannel(ch);
      channelsRef.current = [];
    };
    // qc unused — but keep intentional for potential future invalidate-on-burst.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = useMemo(() => {
    const base: NewsFeedItem[] = [];
    if (query.data) {
      base.push(...query.data.breaking, ...query.data.analyses);
    }
    // Live items first so their order wins in the dedupe map.
    const dedup = new Map<string, NewsFeedItem>();
    for (const it of liveItems) dedup.set(it.key, it);
    for (const it of base) if (!dedup.has(it.key)) dedup.set(it.key, it);
    const merged = [...dedup.values()];
    merged.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    return merged.slice(0, MAX_FEED_ITEMS);
  }, [query.data, liveItems]);

  const resetNewCount = useCallback(() => setNewSinceMount(0), []);

  // Reference qc to satisfy the linter without changing runtime behavior.
  void qc;

  return {
    items,
    isLoading: query.isLoading,
    error: (query.error as Error | null) ?? null,
    newSinceMount,
    resetNewCount,
  };
}
