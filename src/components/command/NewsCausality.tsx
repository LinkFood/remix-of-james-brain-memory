/**
 * NewsCausality — per-source hit rate on headlines that moved flow/dark-pool
 * within 15 minutes. A novel derived signal no retail tool ships.
 *
 *   "Bloomberg: 12/18 moved (67%)"
 *   "Benzinga: 5/24 moved (21%)"
 *   "Tradex:   3/25 moved (12%)"
 *
 * Sourced from ct_news_causality. Ranked by hit rate (highest first),
 * with a minimum sample threshold to avoid n=1 noise.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface CausalityRow {
  id: string;
  news_source: string | null;
  ticker: string;
  moved: boolean | null;
  news_at: string;
}

interface SourceStat {
  source: string;
  total: number;
  moved: number;
  rate: number;
}

const MIN_SAMPLE = 3;       // don't rank a source with < 3 items
const ROW_CAP = 60;         // compact table ceiling
const LOOKBACK_DAYS = 30;   // rolling window for hit-rate

function useCausality() {
  return useQuery<CausalityRow[]>({
    queryKey: ['ct_news_causality', LOOKBACK_DAYS],
    refetchInterval: 60_000,
    queryFn: async () => {
      const cutoff = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('ct_news_causality')
        .select('id, news_source, ticker, moved, news_at')
        .gte('news_at', cutoff)
        .order('news_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as CausalityRow[];
    },
  });
}

function rankSources(rows: CausalityRow[]): SourceStat[] {
  const byS = new Map<string, { total: number; moved: number }>();
  for (const r of rows) {
    const src = (r.news_source ?? 'unknown').trim() || 'unknown';
    const agg = byS.get(src) ?? { total: 0, moved: 0 };
    agg.total++;
    if (r.moved) agg.moved++;
    byS.set(src, agg);
  }
  const stats: SourceStat[] = Array.from(byS.entries()).map(([source, v]) => ({
    source,
    total: v.total,
    moved: v.moved,
    rate: v.total > 0 ? v.moved / v.total : 0,
  }));
  stats.sort((a, b) => {
    // Qualified sources (>= MIN_SAMPLE) first, ranked by rate desc; then unqualified by total desc.
    const aq = a.total >= MIN_SAMPLE ? 1 : 0;
    const bq = b.total >= MIN_SAMPLE ? 1 : 0;
    if (aq !== bq) return bq - aq;
    if (aq) return b.rate - a.rate || b.total - a.total;
    return b.total - a.total;
  });
  return stats.slice(0, ROW_CAP);
}

function rateColor(rate: number, total: number): string {
  if (total < MIN_SAMPLE) return 'bg-muted/50 text-muted-foreground border-muted';
  if (rate >= 0.5) return 'bg-green-500/15 text-green-400 border-green-500/30';
  if (rate >= 0.25) return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  return 'bg-red-500/15 text-red-400 border-red-500/30';
}

export function NewsCausality() {
  const { data, isLoading } = useCausality();
  const stats = useMemo(() => rankSources(data ?? []), [data]);
  const totalItems = data?.length ?? 0;
  const totalMoved = (data ?? []).filter((r) => r.moved).length;
  const overallRate = totalItems > 0 ? totalMoved / totalItems : 0;

  return (
    <Card className="divide-y divide-border">
      <div className="px-3 py-2 border-b border-border bg-muted/30 sticky top-0 z-10 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">
          News → Flow Causality
        </h3>
        {totalItems > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {totalMoved}/{totalItems} moved · {Math.round(overallRate * 100)}% · {LOOKBACK_DAYS}d
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">loading…</div>
      ) : stats.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          no causality data yet — runs every 15 min
        </div>
      ) : (
        <div className="max-h-[50vh] overflow-y-auto">
          {stats.map((s) => {
            const pct = Math.round(s.rate * 100);
            const qualified = s.total >= MIN_SAMPLE;
            return (
              <div
                key={s.source}
                className="px-3 py-2 flex items-center gap-2 text-xs hover:bg-muted/20 transition-colors"
              >
                <span className="font-mono font-medium text-foreground truncate flex-1">
                  {s.source}
                </span>
                <span className="text-[10px] text-muted-foreground font-mono">
                  {s.moved}/{s.total}
                </span>
                <Badge
                  variant="outline"
                  className={`text-[10px] px-1.5 py-0 font-mono min-w-[3rem] justify-center ${rateColor(s.rate, s.total)}`}
                >
                  {qualified ? `${pct}%` : 'n/a'}
                </Badge>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
