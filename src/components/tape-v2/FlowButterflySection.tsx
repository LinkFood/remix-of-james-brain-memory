/**
 * FlowButterflySection — Three-mode Flow Butterfly section for the v2 Tape
 * command center.
 *
 * Modes (extends today's single-ticker dropdown to a three-pill toggle):
 *   - MARKET — combined watchlist sum (FlowPulseChart with no ticker)
 *   - TICKER — single ticker focus (FlowPulseChart with ticker prop)
 *   - ALL — 10-up MiniFlowButterfly grid (mirrors /butterflies route layout)
 *
 * MARKET mode is the v1 default (matches FlowPulseChart's existing default).
 * The three-pill toggle is captain-locked per memory/decisions.md 5/8.
 *
 * ALL mode reuses MiniFlowButterfly + shared controls (range / mode / dte)
 * from PR #66's /butterflies pattern — no new substrate, lift-and-shift the
 * exact composition pattern into the Tape main column.
 *
 * Component reuses: FlowPulseChart (existing) for MARKET + TICKER;
 * MiniFlowButterfly (existing, PR #66) for ALL.
 */

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { FlowPulseChart } from '@/components/command/FlowPulseChart';
import { MiniFlowButterfly } from '@/components/command/MiniFlowButterfly';
import type { RangeKey, ModeKey, DteKey } from '@/components/command/FlowPulseChart';
import { TAPE_V2_WATCHLIST } from '@/hooks/useSpecialistsTileRow';

type ViewMode = 'MARKET' | 'TICKER' | 'ALL';

const TICKER_OPTIONS = [...TAPE_V2_WATCHLIST];

export function FlowButterflySection() {
  const [view, setView] = useState<ViewMode>('MARKET');
  const [selectedTicker, setSelectedTicker] = useState<string>('SPY');

  // ALL-mode shared controls (mirrors /butterflies). FlowPulseChart owns its
  // own toolbar in MARKET / TICKER modes — those modes don't surface these
  // controls at the section level.
  const [allRange, setAllRange] = useState<RangeKey>('today');
  const [allMode, setAllMode] = useState<ModeKey>('cp');
  const [allDte, setAllDte] = useState<DteKey>('all');

  return (
    <Card className="p-3">
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            Flow Butterfly
          </span>
          <div className="flex items-center gap-1">
            {(['MARKET', 'TICKER', 'ALL'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  'text-[10px] font-mono px-2 py-0.5 rounded transition-colors',
                  view === v
                    ? 'bg-primary/15 text-primary'
                    : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>

          {view === 'TICKER' && (
            <select
              value={selectedTicker}
              onChange={(e) => setSelectedTicker(e.target.value)}
              className="text-[10px] font-mono px-2 py-0.5 rounded bg-muted/20 text-foreground border-0 focus:ring-1 focus:ring-primary/30"
            >
              {TICKER_OPTIONS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          )}
        </div>

        {view === 'ALL' && (
          <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono">
            <div className="flex items-center gap-1">
              <span className="uppercase tracking-wider text-muted-foreground">window</span>
              {(['today', '1h', '30m', '15m', '10m', '5m'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setAllRange(r)}
                  className={cn(
                    'px-1.5 py-0.5 rounded transition-colors',
                    allRange === r
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {r === 'today' ? 'Today' : r}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1">
              <span className="uppercase tracking-wider text-muted-foreground">mode</span>
              {(['cp', 'bb'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setAllMode(m)}
                  className={cn(
                    'px-1.5 py-0.5 rounded transition-colors',
                    allMode === m
                      ? 'bg-primary/10 text-primary'
                      : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                  )}
                >
                  {m === 'cp' ? 'C/P' : 'B/B'}
                </button>
              ))}
            </div>
            {allMode === 'bb' && (
              <div className="flex items-center gap-1">
                <span className="uppercase tracking-wider text-muted-foreground">dte</span>
                {(['all', 'short', 'long'] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setAllDte(d)}
                    className={cn(
                      'px-1.5 py-0.5 rounded transition-colors',
                      allDte === d
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted/20 text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {d === 'all' ? 'All' : d === 'short' ? '0-7' : '30+'}
                  </button>
                ))}
              </div>
            )}
            <Link
              to="/butterflies"
              className="inline-flex items-center gap-0.5 text-primary/70 hover:text-primary transition-colors"
              title="Open full /butterflies grid"
            >
              <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
        )}
      </div>

      {view === 'MARKET' && <FlowPulseChart />}
      {view === 'TICKER' && <FlowPulseChart ticker={selectedTicker} />}
      {view === 'ALL' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
          {TAPE_V2_WATCHLIST.map((t) => (
            <MiniFlowButterfly key={t} ticker={t} range={allRange} mode={allMode} dte={allDte} />
          ))}
        </div>
      )}
    </Card>
  );
}
