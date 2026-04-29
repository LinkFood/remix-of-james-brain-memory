/**
 * NewsFeed — live news sidebar for /tape right gutter (Co-Trader UI mode).
 *
 * Combines ct_breaking_news (Tavily macro) + ct_news_analyses (UW per-ticker)
 * into one timestamp-ordered scrolling feed. Each row carries a left-border
 * color routed to its likely detector class (see useBreakingNews.resolveColor):
 *
 *   red    = signature_v1   (severity >= 4)
 *   gold   = whale_v1       (whale/flow tag)
 *   purple = zerodte_*      (0DTE mention)
 *   teal   = unusual_oi_v1  (open interest mention)
 *   gray   = no detector match
 *
 * Filter chips: All · Macro · Per-ticker · High-severity (>=3).
 *
 * Read-only — no write operations, no edge-function calls. Pure window into
 * news state. Sticky positioning is handled by the parent layout.
 */

import { useMemo, useState } from 'react';
import { useBreakingNews, type NewsFeedItem, type NewsColor } from '@/hooks/useBreakingNews';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import {
  Newspaper,
  ExternalLink,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Minus,
  ArrowUp,
} from 'lucide-react';

type FilterMode = 'all' | 'macro' | 'ticker' | 'high';

const FILTER_LABELS: Record<FilterMode, string> = {
  all: 'All',
  macro: 'Macro',
  ticker: 'Per-ticker',
  high: 'High',
};

// Tailwind classes per color. Border-left becomes the detector color marker;
// the bg tint is intentionally subtle so the headline stays readable.
const COLOR_BORDER: Record<NewsColor, string> = {
  red: 'border-l-rose-500',
  gold: 'border-l-amber-400',
  teal: 'border-l-teal-400',
  purple: 'border-l-purple-400',
  gray: 'border-l-border',
};

const COLOR_BG: Record<NewsColor, string> = {
  red: 'bg-rose-500/5 hover:bg-rose-500/10',
  gold: 'bg-amber-400/5 hover:bg-amber-400/10',
  teal: 'bg-teal-400/5 hover:bg-teal-400/10',
  purple: 'bg-purple-400/5 hover:bg-purple-400/10',
  gray: 'hover:bg-muted/40',
};

const COLOR_LABEL: Record<NewsColor, string> = {
  red: 'signature',
  gold: 'whale',
  teal: 'OI',
  purple: '0DTE',
  gray: 'news',
};

function relativeTime(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}

function SentimentIcon({ s }: { s: NewsFeedItem['sentiment'] }) {
  if (s === 'bullish' || s === 'positive') {
    return <TrendingUp className="w-3 h-3 text-emerald-400" />;
  }
  if (s === 'bearish' || s === 'negative') {
    return <TrendingDown className="w-3 h-3 text-rose-400" />;
  }
  return <Minus className="w-3 h-3 text-muted-foreground" />;
}

function FeedRow({ item }: { item: NewsFeedItem }) {
  return (
    <a
      href={item.url ?? undefined}
      target={item.url ? '_blank' : undefined}
      rel={item.url ? 'noopener noreferrer' : undefined}
      className={cn(
        'block border-l-2 px-2.5 py-2 text-[11px] leading-snug transition-colors',
        COLOR_BORDER[item.color],
        COLOR_BG[item.color],
        item.url ? 'cursor-pointer' : 'cursor-default',
      )}
    >
      {/* Top row: tickers + tags + age */}
      <div className="flex items-center gap-1.5 mb-1 flex-wrap">
        {item.tickers.length > 0 ? (
          item.tickers.slice(0, 3).map((t) => (
            <Badge
              key={t}
              variant="outline"
              className="h-4 px-1 text-[9px] font-mono tabular-nums"
            >
              {t}
            </Badge>
          ))
        ) : (
          <Badge
            variant="outline"
            className="h-4 px-1 text-[9px] uppercase tracking-wide text-muted-foreground"
          >
            macro
          </Badge>
        )}
        {item.color !== 'gray' && (
          <span
            className={cn(
              'text-[9px] font-mono uppercase tracking-wide px-1 py-0 rounded',
              item.color === 'red' && 'text-rose-300 bg-rose-500/15',
              item.color === 'gold' && 'text-amber-200 bg-amber-400/15',
              item.color === 'teal' && 'text-teal-200 bg-teal-400/15',
              item.color === 'purple' && 'text-purple-200 bg-purple-400/15',
            )}
          >
            {COLOR_LABEL[item.color]}
          </span>
        )}
        <SentimentIcon s={item.sentiment} />
        <span className="ml-auto text-[9px] font-mono text-muted-foreground tabular-nums">
          {relativeTime(item.ts)}
        </span>
      </div>

      {/* Headline */}
      <div className="font-medium text-foreground line-clamp-2">{item.headline}</div>

      {/* Summary preview — 1 line, only if present */}
      {item.summary && (
        <div className="text-muted-foreground line-clamp-1 mt-0.5 text-[10px]">
          {item.summary}
        </div>
      )}

      {/* Footer: publisher + external icon */}
      <div className="flex items-center gap-1.5 mt-1 text-[9px] text-muted-foreground">
        {item.publisher && <span className="truncate">{item.publisher}</span>}
        {item.source === 'analysis' && (
          <span className="text-[8px] uppercase tracking-wide opacity-70">claude take</span>
        )}
        {item.url && <ExternalLink className="w-2.5 h-2.5 ml-auto opacity-60" />}
      </div>
    </a>
  );
}

export function NewsFeed() {
  const { items, isLoading, error, newSinceMount, resetNewCount } = useBreakingNews();
  const [filter, setFilter] = useState<FilterMode>('all');

  const filtered = useMemo(() => {
    switch (filter) {
      case 'macro':
        return items.filter((it) => it.tickers.length === 0);
      case 'ticker':
        return items.filter((it) => it.tickers.length > 0);
      case 'high':
        return items.filter((it) => it.severity >= 3);
      case 'all':
      default:
        return items;
    }
  }, [items, filter]);

  return (
    <Card className="flex flex-col h-[calc(100vh-2rem)] overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 border-b flex items-center gap-2">
        <Newspaper className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">News</h2>
        {newSinceMount > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-[10px] gap-1 text-emerald-400 hover:text-emerald-300"
            onClick={resetNewCount}
          >
            <ArrowUp className="w-3 h-3" />
            {newSinceMount} new
          </Button>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
          {filtered.length}
        </span>
      </div>

      {/* Filter chips */}
      <div className="px-2 py-1.5 border-b flex items-center gap-1 flex-wrap">
        {(Object.keys(FILTER_LABELS) as FilterMode[]).map((m) => (
          <Button
            key={m}
            size="sm"
            variant={filter === m ? 'default' : 'outline'}
            className="h-6 px-2 text-[10px]"
            onClick={() => setFilter(m)}
          >
            {FILTER_LABELS[m]}
          </Button>
        ))}
      </div>

      {/* Body */}
      <ScrollArea className="flex-1">
        {error && (
          <div className="px-3 py-3 text-[11px] text-rose-300 flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5" />
            {error.message}
          </div>
        )}
        {isLoading && !error && (
          <div className="px-3 py-3 text-[11px] text-muted-foreground">Loading news…</div>
        )}
        {!isLoading && !error && filtered.length === 0 && (
          <div className="px-3 py-3 text-[11px] text-muted-foreground">
            No headlines for this filter.
          </div>
        )}
        <div className="divide-y divide-border/40">
          {filtered.map((item) => (
            <FeedRow key={item.key} item={item} />
          ))}
        </div>
      </ScrollArea>
    </Card>
  );
}

export default NewsFeed;
