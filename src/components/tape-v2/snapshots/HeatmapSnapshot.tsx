/**
 * HeatmapSnapshot — top-3 hottest cells from /heatmap, compressed for the
 * v2 Tape command-center right rail.
 *
 * Reuses useFlowHeatmapLive (no new query); sorts client-side by |value|
 * DESC, slices [0:3]. Click any cell → /heatmap (full grid, deep-linked).
 *
 * Default math + filter mirrors /heatmap's own defaults so the snapshot
 * always agrees with what captain sees on the dedicated page.
 */

import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Flame, ArrowUpRight } from 'lucide-react';
import { useFlowHeatmapLive } from '@/hooks/useFlowHeatmap';

function formatDollars(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return n.toFixed(0);
}

function valueClass(v: number): string {
  if (v > 0) return 'text-emerald-300 bg-emerald-500/10 border-emerald-500/25';
  if (v < 0) return 'text-red-300 bg-red-500/10 border-red-500/25';
  return 'text-muted-foreground bg-muted/15 border-muted/25';
}

function formatExpiryShort(iso: string): string {
  const [, m, d] = iso.split('-');
  return m && d ? `${m}/${d}` : iso;
}

export function HeatmapSnapshot() {
  const { data, isLoading } = useFlowHeatmapLive({});

  const top3 = (data ?? [])
    .slice()
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 3);

  return (
    <Card className="p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          <Flame className="w-3 h-3" />
          Heatmap · Hottest
        </span>
        <Link
          to="/heatmap"
          className="inline-flex items-center gap-0.5 text-[10px] text-primary/70 hover:text-primary transition-colors"
        >
          full <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>

      {isLoading && top3.length === 0 && (
        <div className="text-[10px] text-muted-foreground italic px-1 py-2">loading…</div>
      )}

      {!isLoading && top3.length === 0 && (
        <div className="text-[10px] text-muted-foreground italic px-1 py-2">no cells in window</div>
      )}

      <div className="space-y-1">
        {top3.map((cell) => (
          <Link
            key={`${cell.ticker}-${cell.expiry_bucket_week}`}
            to={`/heatmap?ticker=${cell.ticker}`}
            className={cn(
              'flex items-center justify-between px-2 py-1 rounded border transition-colors hover:opacity-80',
              valueClass(cell.value),
            )}
          >
            <div className="flex items-baseline gap-2">
              <span className="text-[11px] font-mono font-semibold tracking-wider">{cell.ticker}</span>
              <span className="text-[9px] font-mono opacity-70">{formatExpiryShort(cell.expiry_bucket_week)}</span>
            </div>
            <span className="text-[11px] font-mono font-semibold">
              {cell.value >= 0 ? '+' : ''}${formatDollars(cell.value)}
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
