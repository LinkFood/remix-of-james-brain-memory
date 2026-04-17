import { useRecentNews } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

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

export function NewsFeed() {
  const { data: news, isLoading } = useRecentNews(15);

  return (
    <Card className="divide-y divide-border">
      <div className="px-3 py-2 border-b border-border bg-muted/30">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">News · Claude Takes</h3>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">loading…</div>
      ) : !news || news.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          no news analyzed yet
        </div>
      ) : (
        <div className="max-h-[40vh] overflow-y-auto">
          {news.map((n) => (
            <div key={n.id} className="p-3 hover:bg-muted/30 transition-colors">
              <div className="flex items-center gap-2 text-[10px] mb-1 flex-wrap">
                <span className="font-mono font-semibold text-foreground">{n.instrument}</span>
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
      )}
    </Card>
  );
}
