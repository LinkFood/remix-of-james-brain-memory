/**
 * NewsCausalityMatrix — Phase 5 of the audit-driven loop. Renders the
 * derived signal documented in ct_news_causality.sql since 2026-04-16 but
 * never surfaced: per-source × per-ticker hit rate ("Bloomberg moves NVDA
 * flow 68% of the time, Tradex 12%").
 *
 * 5x lift: this signal exists in the DB schema by design, the cron has been
 * computing it every 15 min for weeks, but no UI exposes it. Captain has
 * been blind to which news sources reliably drive flow on which tickers.
 * Compact source × ticker hit-rate grid renders the empirical edge in
 * a single glance.
 *
 * Cell color logic:
 *   - empty / N below floor → muted gray
 *   - 0-25% hit (low signal) → cool blue/dim
 *   - 25-50% (moderate) → amber
 *   - 50-75% (strong) → emerald
 *   - 75%+ (very strong) → bold emerald
 *
 * Captain reads down a source row to see "this source drives X tickers
 * reliably." Reads down a ticker column to see "for THIS ticker, lean on
 * Bloomberg + ignore Tradex."
 */

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Newspaper, TrendingUp } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { useNewsCausalityMatrix, type NewsCausalityRow } from '@/hooks/useNewsCausalityMatrix';

function hitClass(hitPct: number | null | undefined): string {
  if (hitPct == null) return 'bg-muted/20 text-muted-foreground/50';
  if (hitPct >= 60) return 'bg-emerald-600/30 text-emerald-200 font-bold';
  if (hitPct >= 40) return 'bg-emerald-500/20 text-emerald-300 font-semibold';
  if (hitPct >= 25) return 'bg-amber-500/15 text-amber-300';
  if (hitPct >= 10) return 'bg-blue-500/10 text-blue-300';
  return 'bg-muted/20 text-muted-foreground';
}

function fmtPremium(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

interface MatrixCellProps {
  row: NewsCausalityRow | undefined;
  source: string;
  ticker: string;
}

function MatrixCell({ row }: MatrixCellProps) {
  if (!row) {
    return (
      <div className="h-7 flex items-center justify-center text-[9px] font-mono bg-muted/10 text-muted-foreground/30 border border-border/20 rounded-sm">
        —
      </div>
    );
  }
  return (
    <HoverCard openDelay={50} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className={cn(
            'h-7 flex items-center justify-center text-[10px] font-mono border border-border/20 rounded-sm cursor-pointer transition-all hover:scale-105 hover:border-primary/40',
            hitClass(row.hit_pct),
          )}
          aria-label={`${row.news_source} on ${row.ticker}: ${row.hit_pct}% hit rate over ${row.total_n} news`}
        >
          {row.hit_pct.toFixed(0)}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        className="w-72 p-3 bg-card/95 backdrop-blur border-primary/30 text-[11px]"
        side="bottom"
        align="center"
      >
        <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
          {row.news_source} · {row.ticker}
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <div className="text-muted-foreground">total news</div>
          <div className="text-right font-semibold">{row.total_n}</div>
          <div className="text-muted-foreground">moved (any)</div>
          <div className="text-right font-semibold">{row.moved_count} ({row.hit_pct}%)</div>
          <div className="text-muted-foreground">flow moved</div>
          <div className="text-right">{row.flow_moved_count}</div>
          <div className="text-muted-foreground">dp moved</div>
          <div className="text-right">{row.dp_moved_count}</div>
          <div className="text-muted-foreground">flow premium total</div>
          <div className="text-right">{fmtPremium(row.total_flow_premium)}</div>
          <div className="text-muted-foreground">dp notional total</div>
          <div className="text-right">{fmtPremium(row.total_dp_notional)}</div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export function NewsCausalityMatrix() {
  const [lookback] = useState<number>(7);
  const { sources, watchlist, isLoading } = useNewsCausalityMatrix({ lookbackDays: lookback });

  if (isLoading) {
    return (
      <Card className="p-3 bg-muted/10 border-primary/20">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          News Causality Matrix · loading...
        </div>
      </Card>
    );
  }

  if (sources.length === 0) {
    return (
      <Card className="p-3 bg-muted/10 border-primary/20">
        <div className="flex items-center gap-2 mb-1">
          <Newspaper className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
            News Causality Matrix · last {lookback}d
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground/70 italic">
          No source × ticker cells with N ≥ 3 yet. Causality cron runs every 15 min — gate fills as news ingests over the next sessions.
        </div>
      </Card>
    );
  }

  // Cap to top 8 sources — keeps the grid readable; minor sources roll into "..."
  const topSources = sources.slice(0, 8);
  const remainingCount = sources.length - topSources.length;

  return (
    <Card className="p-3 bg-muted/10 border-primary/20 space-y-2">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Newspaper className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            News Causality Matrix · last {lookback}d · source × ticker hit %
          </span>
        </div>
        <div className="flex items-center gap-3 text-[9px] font-mono text-muted-foreground">
          <span>{topSources.length} sources × {watchlist.length} tickers</span>
          <span className="flex items-center gap-1.5">
            <TrendingUp className="w-3 h-3 text-emerald-400" />
            <span className="opacity-70">moved = flow_premium &gt; 0 OR dp ≥ $10M within 15min</span>
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div
          className="grid gap-1 min-w-[640px]"
          style={{ gridTemplateColumns: `minmax(140px,1fr) repeat(${watchlist.length}, minmax(36px,1fr)) minmax(56px,1fr)` }}
        >
          {/* Header */}
          <div className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground self-end pl-1">
            source · n
          </div>
          {watchlist.map((t) => (
            <div
              key={`hdr-${t}`}
              className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground text-center self-end"
            >
              {t}
            </div>
          ))}
          <div className="text-[9px] font-mono uppercase tracking-wider text-muted-foreground text-center self-end">
            avg
          </div>

          {/* Rows */}
          {topSources.map((src) => (
            <Row key={src.name} source={src} watchlist={watchlist} />
          ))}
        </div>
      </div>

      {remainingCount > 0 && (
        <div className="text-[9px] font-mono text-muted-foreground/60 text-right pt-1">
          + {remainingCount} more source{remainingCount === 1 ? '' : 's'} below threshold
        </div>
      )}

      <div className="text-[9px] font-mono text-muted-foreground/50 leading-snug pt-1 border-t border-border/30">
        cell color: 60%+ emerald-bold · 40-60% emerald · 25-40% amber · 10-25% blue · &lt;10% gray. hover for full breakdown.
      </div>
    </Card>
  );
}

function Row({
  source,
  watchlist,
}: {
  source: { name: string; total: number; meanHit: number; rows: Map<string, NewsCausalityRow> };
  watchlist: string[];
}) {
  return (
    <>
      <div className="text-[10px] font-mono px-1 self-center truncate" title={source.name}>
        <span className="text-foreground/90">{source.name}</span>
        <span className="text-muted-foreground/60 ml-1">{source.total}</span>
      </div>
      {watchlist.map((t) => (
        <MatrixCell key={`${source.name}-${t}`} row={source.rows.get(t)} source={source.name} ticker={t} />
      ))}
      <div className={cn('h-7 flex items-center justify-center text-[10px] font-mono border border-border/20 rounded-sm', hitClass(source.meanHit))}>
        {source.meanHit > 0 ? source.meanHit.toFixed(0) : '—'}
      </div>
    </>
  );
}
