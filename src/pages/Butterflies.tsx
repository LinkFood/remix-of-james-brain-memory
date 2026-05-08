/**
 * /butterflies — Multi-panel Flow Butterfly grid.
 *
 * Captain framing: "MARKET aggregation blurs the per-ticker leader-lagger
 * structure that IS the signal. QQQ front-roaded the recent move, SPY flat,
 * TSLA decoupled. Each ticker has its own story."
 *
 * Single-ticker dropdown forces sequential viewing; the cross-ticker pattern
 * recognition (who's leading, who's lagging, who's decoupled) requires
 * holding 10 charts in working memory while clicking through. This page
 * shows all 10 watchlist tickers' butterflies on one screen at-a-glance.
 *
 * Shared controls (range + mode + dte) at top; 5×2 grid below (responsive
 * to 2-col / 1-col on narrower viewports). Each panel's own y-axis scaled
 * per-ticker — pattern shape readable regardless of magnitude (mirrors
 * heatmap's per-row coloring philosophy).
 *
 * Phase 3 emission triggers (butterfly cross detection per-ticker) will
 * surface cross moments visually across the grid. Hooks already populate
 * Realtime, so when the trigger lands the grid responds without rework.
 */

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { MiniFlowButterfly } from '@/components/command/MiniFlowButterfly';
import type {
  RangeKey,
  ModeKey,
  DteKey,
} from '@/components/command/FlowPulseChart';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

export default function Butterflies() {
  const [range, setRange] = useState<RangeKey>('today');
  const [mode, setMode] = useState<ModeKey>('cp');
  const [dte, setDte] = useState<DteKey>('all');

  return (
    <div className="p-4 max-w-[1700px] mx-auto">
      <div className="mb-4">
        <h1 className="text-lg font-mono font-semibold tracking-wider mb-1">Flow Butterflies</h1>
        <p className="text-xs text-muted-foreground">
          All 10 watchlist tickers. Per-ticker signed-flow regime at a glance.
          Each panel scaled to its own range — read pattern shape, not magnitude across.
        </p>
      </div>

      {/* Shared controls — operate across all 10 panels. */}
      <Card className="px-3 py-2 mb-3 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-1">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mr-1">window</span>
          {(['today', '1h', '30m'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn(
                'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                range === r
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
            >
              {r === 'today' ? 'Today' : r}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mr-1">mode</span>
          {(['cp', 'bb'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                mode === m
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted/20 text-muted-foreground hover:text-foreground',
              )}
              title={m === 'cp' ? 'Calls vs Puts (live signed)' : 'Bulls vs Bears (cumulative directional)'}
            >
              {m === 'cp' ? 'C/P' : 'B/B'}
            </button>
          ))}
        </div>

        {/* DTE filter applies to bb mode only — same convention as
            FlowPulseChart. */}
        {mode === 'bb' && (
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground mr-1">dte</span>
            {(['all', 'short', 'long'] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDte(d)}
                className={cn(
                  'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                  dte === d
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                )}
                title={d === 'short' ? '0-7 DTE' : d === 'long' ? '30+ DTE' : 'All DTE'}
              >
                {d === 'all' ? 'All' : d === 'short' ? '0-7' : '30+'}
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* 5×2 grid responsive to narrow viewports. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
        {WATCHLIST.map((t) => (
          <MiniFlowButterfly key={t} ticker={t} range={range} mode={mode} dte={dte} />
        ))}
      </div>
    </div>
  );
}
