/**
 * SpecialistsTileRow — 10-tile specialist breadth row for v2 Tape command
 * center. Always-visible main-column section.
 *
 * Each tile: ticker + current price + conviction (color-graded) + direction
 * arrow + 1h conviction delta + last-fired relative time. Click ticker →
 * opens TickerSheet drill-down (existing modal).
 *
 * Conviction color bands match the captain spec from PR #71 section 4c:
 *   ≥70 dark green strong bull
 *   50-69 light green mid bull
 *   30-49 gray neutral
 *   20-29 light red mid bear
 *   <20 dark red strong bear
 *
 * The conviction-as-bullishness mapping treats higher conviction as more
 * directional (regardless of bullish vs bearish lean). Direction arrow
 * disambiguates: ↑ bullish, ↓ bearish, − neutral/mixed.
 */

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { useSpecialistsTileRow, type SpecialistTile } from '@/hooks/useSpecialistsTileRow';
import { TickerSheet } from '@/components/command/TickerSheet';

function convictionTileClass(conviction: number | null, direction: SpecialistTile['direction']): string {
  if (conviction == null) return 'bg-muted/20 border-muted/30 text-muted-foreground';
  // Convert conviction to magnitude-band, sign by direction.
  const isBearish = direction === 'bearish';
  const isBullish = direction === 'bullish';
  if (conviction >= 70) {
    if (isBullish) return 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200';
    if (isBearish) return 'bg-red-500/15 border-red-500/40 text-red-200';
    return 'bg-amber-500/10 border-amber-500/30 text-amber-200';
  }
  if (conviction >= 50) {
    if (isBullish) return 'bg-emerald-500/8 border-emerald-500/25 text-emerald-300/90';
    if (isBearish) return 'bg-red-500/8 border-red-500/25 text-red-300/90';
    return 'bg-muted/20 border-muted/30 text-foreground/80';
  }
  return 'bg-muted/15 border-muted/25 text-muted-foreground';
}

function DirectionArrow({ direction }: { direction: SpecialistTile['direction'] }) {
  if (direction === 'bullish') return <ArrowUp className="w-3 h-3 text-emerald-400" />;
  if (direction === 'bearish') return <ArrowDown className="w-3 h-3 text-red-400" />;
  return <Minus className="w-3 h-3 text-muted-foreground" />;
}

function formatPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  return n.toFixed(2);
}

function formatDelta(d: number | null): string {
  if (d == null || !Number.isFinite(d) || d === 0) return '';
  const sign = d > 0 ? '+' : '';
  return `${sign}${d.toFixed(0)}`;
}

function deltaColor(d: number | null): string {
  if (d == null || d === 0) return 'text-muted-foreground/60';
  return d > 0 ? 'text-emerald-400/80' : 'text-red-400/80';
}

function freshness(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

export function SpecialistsTileRow() {
  const { data, isLoading } = useSpecialistsTileRow();
  const [activeTicker, setActiveTicker] = useState<string | null>(null);

  return (
    <Card className="p-2">
      <div className="flex items-center justify-between mb-1.5 px-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          Specialists · {data?.length ?? 0}
        </span>
        {isLoading && (
          <span className="text-[10px] font-mono text-muted-foreground/60 italic">loading…</span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 lg:grid-cols-10 gap-1.5">
        {(data ?? []).map((tile) => (
          <button
            key={tile.ticker}
            onClick={() => setActiveTicker(tile.ticker)}
            className={cn(
              'group flex flex-col items-stretch gap-0.5 px-2 py-1.5 rounded border transition-colors text-left',
              convictionTileClass(tile.conviction, tile.direction),
            )}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[11px] font-mono font-semibold tracking-wider">
                {tile.ticker}
              </span>
              <DirectionArrow direction={tile.direction} />
            </div>
            <div className="flex items-baseline justify-between gap-1">
              <span className="text-xs font-mono">
                {formatPrice(tile.current_price)}
              </span>
              <span className="text-[10px] font-mono opacity-80">
                {tile.conviction != null ? Math.round(tile.conviction) : '—'}
              </span>
            </div>
            <div className="flex items-center justify-between text-[9px] font-mono">
              <span className={cn(deltaColor(tile.delta_1h))}>
                {formatDelta(tile.delta_1h) || <span className="opacity-0">·</span>}
              </span>
              <span className="text-muted-foreground/60">
                {freshness(tile.last_fired_at)}
              </span>
            </div>
          </button>
        ))}
      </div>

      <TickerSheet
        ticker={activeTicker}
        open={activeTicker !== null}
        onOpenChange={(o) => !o && setActiveTicker(null)}
      />
    </Card>
  );
}
