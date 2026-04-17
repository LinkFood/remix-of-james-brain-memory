import { useMemo, useState } from 'react';
import { useRecentNews, type NewsItem } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ChevronDown, ChevronRight } from 'lucide-react';

function relativeTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function impactColor(i: string): string {
  switch (i) {
    case 'bullish': return 'bg-green-500/15 text-green-400 border-green-500/30';
    case 'bearish': return 'bg-red-500/15 text-red-400 border-red-500/30';
    case 'mixed':   return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
    default:        return 'bg-muted/50 text-muted-foreground border-muted';
  }
}

function groupAndRank(news: NewsItem[]): Array<{ ticker: string; items: NewsItem[]; topImpact: string; topSig: number }> {
  const byTicker = new Map<string, NewsItem[]>();
  for (const n of news) {
    const list = byTicker.get(n.instrument) ?? [];
    list.push(n);
    byTicker.set(n.instrument, list);
  }
  // Sort items within each ticker by significance desc, then recency
  const groups = Array.from(byTicker.entries()).map(([ticker, items]) => {
    items.sort((a, b) => b.significance - a.significance || b.created_at.localeCompare(a.created_at));
    return {
      ticker,
      items,
      topImpact: items[0].impact,
      topSig: items[0].significance,
    };
  });
  // Sort groups by top item significance desc, then most recent activity
  groups.sort((a, b) => b.topSig - a.topSig || b.items[0].created_at.localeCompare(a.items[0].created_at));
  return groups;
}

function TickerNewsGroup({ ticker, items, topImpact, topSig }: { ticker: string; items: NewsItem[]; topImpact: string; topSig: number }) {
  const [expanded, setExpanded] = useState(items.length === 1);
  const shownItems = expanded ? items : items.slice(0, 1);

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        onClick={() => items.length > 1 && setExpanded(!expanded)}
        className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs bg-muted/20 hover:bg-muted/30 transition-colors ${items.length > 1 ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {items.length > 1 && (expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)}
        <span className="font-mono font-bold text-foreground">{ticker}</span>
        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${impactColor(topImpact)}`}>
          {topImpact}
        </Badge>
        <span className="text-[10px] text-muted-foreground">sig {topSig}</span>
        {items.length > 1 && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            +{items.length - (expanded ? 0 : 1)} more
          </span>
        )}
      </button>

      {shownItems.map((n) => (
        <div key={n.id} className="p-3 bg-background hover:bg-muted/20 transition-colors">
          <div className="flex items-center gap-2 text-[10px] mb-1 flex-wrap">
            <Badge variant="outline" className={`px-1.5 py-0 ${impactColor(n.impact)}`}>
              {n.impact}
            </Badge>
            <span className="text-muted-foreground">sig {n.significance}/5</span>
            {n.news_source && <span className="text-muted-foreground">· {n.news_source}</span>}
            <span className="text-muted-foreground ml-auto">{relativeTime(n.created_at)}</span>
          </div>
          <div className="text-xs font-medium text-foreground mb-1 leading-tight">
            {n.news_url ? (
              <a href={n.news_url} target="_blank" rel="noreferrer" className="hover:underline">
                {n.news_headline}
              </a>
            ) : n.news_headline}
          </div>
          <div className="text-xs text-foreground/75 leading-relaxed">
            {n.claude_take}
          </div>
        </div>
      ))}
    </div>
  );
}

export function NewsFeed() {
  const { data: news, isLoading } = useRecentNews(40);
  const groups = useMemo(() => groupAndRank(news ?? []), [news]);

  return (
    <Card className="divide-y divide-border">
      <div className="px-3 py-2 border-b border-border bg-muted/30 sticky top-0 z-10 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">News · Claude Takes</h3>
        {groups.length > 0 && (
          <span className="text-[10px] text-muted-foreground">{groups.length} tickers · {news?.length ?? 0} items</span>
        )}
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">loading…</div>
      ) : groups.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">no news analyzed yet</div>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto">
          {groups.map((g) => (
            <TickerNewsGroup key={g.ticker} ticker={g.ticker} items={g.items} topImpact={g.topImpact} topSig={g.topSig} />
          ))}
        </div>
      )}
    </Card>
  );
}
