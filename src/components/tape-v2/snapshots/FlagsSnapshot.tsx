/**
 * FlagsSnapshot — top-3 active specialist flags by score, for the v2 Tape
 * command-center right rail.
 *
 * Source: useTopActiveFlags (status='active', score>=70, sorted by score
 * DESC). Click a row → /flags (filtered view inherits the snapshot context).
 */

import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Target, ArrowUpRight, ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { useTopActiveFlags, type TopActiveFlag } from '@/hooks/useTopActiveFlags';

function directionMark(d: TopActiveFlag['direction']) {
  if (d === 'bullish') return <ArrowUp className="w-3 h-3 text-emerald-400" />;
  if (d === 'bearish') return <ArrowDown className="w-3 h-3 text-red-400" />;
  return <Minus className="w-3 h-3 text-muted-foreground" />;
}

function scoreClass(score: number): string {
  if (score >= 80) return 'bg-emerald-500/15 text-emerald-200 border-emerald-500/30';
  if (score >= 60) return 'bg-amber-500/15 text-amber-200 border-amber-500/30';
  return 'bg-muted/20 text-muted-foreground border-muted/30';
}

export function FlagsSnapshot() {
  const { data, isLoading } = useTopActiveFlags({ limit: 3, minScore: 70 });
  const rows = data ?? [];

  return (
    <Card className="p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          <Target className="w-3 h-3" />
          Flags · Active
        </span>
        <Link
          to="/flags?outcome=active"
          className="inline-flex items-center gap-0.5 text-[10px] text-primary/70 hover:text-primary transition-colors"
        >
          full <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>

      {isLoading && rows.length === 0 && (
        <div className="text-[10px] text-muted-foreground italic px-1 py-2">loading…</div>
      )}

      {!isLoading && rows.length === 0 && (
        <div className="text-[10px] text-muted-foreground italic px-1 py-2">no active flags ≥70</div>
      )}

      <div className="space-y-1.5">
        {rows.map((flag) => (
          <Link
            key={flag.id}
            to={`/flags?outcome=active`}
            className="block px-2 py-1.5 rounded border bg-muted/10 border-muted/30 hover:border-primary/40 transition-colors"
          >
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <div className="flex items-center gap-1.5">
                {directionMark(flag.direction)}
                <span className="text-[11px] font-mono font-semibold tracking-wider">
                  {flag.instrument}
                </span>
              </div>
              <span className={cn(
                'text-[10px] font-mono px-1.5 py-0.5 rounded border',
                scoreClass(flag.score),
              )}>
                {Math.round(flag.score)}
              </span>
            </div>
            {flag.thesis && (
              <div className="text-[10px] text-muted-foreground leading-tight line-clamp-2">
                {flag.thesis}
              </div>
            )}
          </Link>
        ))}
      </div>
    </Card>
  );
}
