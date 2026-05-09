/**
 * GexBanner — market-wide GEX consensus strip rendered above the toolbar.
 *
 * Iter #3 PR-B alpha-class primitive #1. Surfaces the watchlist aggregate
 * from `useGexInference`: consensus_direction badge, N tickers above/below
 * flip, and the freshness clock.
 *
 * Single-row, dense, font-mono — Bloomberg-strip identity. No drill-in;
 * deeper detail lives in the per-ticker direction strips below.
 */

import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Layers } from 'lucide-react';
import { useGexInference } from '@/hooks/useGexInference';
import type { ConsensusDirection } from '@/hooks/useGexInference';

interface ConsensusStyle {
  label: string;
  bg: string;
  text: string;
  ring: string;
  dot: string;
}

function consensusStyle(c: ConsensusDirection): ConsensusStyle {
  switch (c) {
    case 'broad_positive_gamma':
      return {
        label: 'BROAD POSITIVE GAMMA',
        bg: 'bg-emerald-500/15',
        text: 'text-emerald-300',
        ring: 'ring-emerald-500/30',
        dot: 'bg-emerald-400',
      };
    case 'broad_negative_gamma':
      return {
        label: 'BROAD NEGATIVE GAMMA',
        bg: 'bg-red-500/15',
        text: 'text-red-300',
        ring: 'ring-red-500/30',
        dot: 'bg-red-400',
      };
    case 'mixed':
      return {
        label: 'MIXED',
        bg: 'bg-amber-500/15',
        text: 'text-amber-300',
        ring: 'ring-amber-500/30',
        dot: 'bg-amber-400',
      };
    case 'no_signal':
    default:
      return {
        label: 'NO SIGNAL',
        bg: 'bg-muted/20',
        text: 'text-muted-foreground',
        ring: 'ring-muted/30',
        dot: 'bg-muted-foreground/60',
      };
  }
}

function relSeconds(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function formatPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const sign = v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}%`;
}

export function GexBanner() {
  const { data, isLoading, isError } = useGexInference();

  // Tick clock for relative-time display.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(id);
  }, []);

  if (isLoading && !data) {
    return (
      <Card className="px-3 py-1.5 border-dashed">
        <div className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
          GEX consensus loading…
        </div>
      </Card>
    );
  }

  if (isError || !data) {
    return (
      <Card className="px-3 py-1.5 border-dashed">
        <div className="text-[10px] font-mono text-muted-foreground/70 uppercase tracking-wider">
          GEX consensus unavailable
        </div>
      </Card>
    );
  }

  const wl = data.watchlist;
  const populated =
    wl.tickers_above_flip + wl.tickers_below_flip + wl.tickers_at_flip;
  const total = populated + wl.tickers_no_flip;
  const style = consensusStyle(wl.consensus_direction);

  return (
    <Card className="px-3 py-1.5">
      <div className="flex items-center gap-4 text-[10px] font-mono flex-wrap">
        <span className="inline-flex items-center gap-1.5">
          <Layers className="w-3 h-3 text-primary" />
          <span className="uppercase tracking-wider text-muted-foreground">
            dealer net
          </span>
          <span
            className={cn(
              'inline-flex items-center gap-1.5 px-2 py-0.5 rounded ring-1 font-semibold',
              style.bg,
              style.text,
              style.ring,
            )}
          >
            <span className={cn('w-1.5 h-1.5 rounded-full', style.dot)} />
            {style.label}
          </span>
        </span>

        <span className="inline-flex items-center gap-1.5">
          <span className="uppercase tracking-wider text-muted-foreground">
            above flip
          </span>
          <span className="font-semibold text-emerald-300 tabular-nums">
            {wl.tickers_above_flip}
          </span>
          <span className="text-muted-foreground/70">/</span>
          <span className="uppercase tracking-wider text-muted-foreground">
            below
          </span>
          <span className="font-semibold text-red-300 tabular-nums">
            {wl.tickers_below_flip}
          </span>
          {wl.tickers_at_flip > 0 && (
            <>
              <span className="text-muted-foreground/70">/</span>
              <span className="uppercase tracking-wider text-muted-foreground">
                at
              </span>
              <span className="font-semibold text-amber-300 tabular-nums">
                {wl.tickers_at_flip}
              </span>
            </>
          )}
          {wl.tickers_no_flip > 0 && (
            <span className="text-muted-foreground/60">
              · {wl.tickers_no_flip} no-flip
            </span>
          )}
        </span>

        {wl.median_price_vs_flip_pct != null && (
          <span className="inline-flex items-center gap-1.5">
            <span className="uppercase tracking-wider text-muted-foreground">
              median Δ flip
            </span>
            <span
              className={cn(
                'font-semibold tabular-nums',
                wl.median_price_vs_flip_pct >= 0
                  ? 'text-emerald-300'
                  : 'text-red-300',
              )}
            >
              {formatPct(wl.median_price_vs_flip_pct)}
            </span>
          </span>
        )}

        <span className="inline-flex items-center gap-1.5 ml-auto text-muted-foreground/70">
          <span className="uppercase tracking-wider">cohort</span>
          <span className="tabular-nums">{populated}/{total}</span>
        </span>

        <span className="inline-flex items-center gap-1.5 text-muted-foreground/70">
          <span className="uppercase tracking-wider">as of</span>
          <span className="tabular-nums">{relSeconds(data.generated_at)} ago</span>
        </span>
      </div>
    </Card>
  );
}
