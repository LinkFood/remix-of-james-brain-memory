/**
 * MacroTile — one watchlist tile on /tape's MacroBanner.
 *
 * 144×128 card showing (top→bottom):
 *   - ticker + flag badge (right-align chip if >0 active flags)
 *   - spot price (large mono) + % change (color-tinted)
 *   - intraday sparkline filling the middle band
 *   - footer: LEAN {score} {arrow}{momentum_delta}
 *
 * All data batch-fetched at the MacroBanner level. This component is a
 * pure renderer — no network reads of its own.
 */

import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { Card } from '@/components/ui/card';
import { ChartSafe } from '@/components/ChartSafe';
import { cn } from '@/lib/utils';
import type { MacroSparklineSeries } from '@/hooks/useMacroSparklines';

export interface MacroLeanSummary {
  score: number;
  momentum_delta: number | null;
}

export interface MacroTileProps {
  ticker: string;
  spot: number | null;
  pct: number | null;
  sparkline: MacroSparklineSeries | undefined;
  lean: MacroLeanSummary | null | undefined;
  flagCount: number;
  onClick: () => void;
}

function fmtSpot(n: number | null): string {
  if (n == null) return '--';
  if (n >= 1000) return n.toFixed(0);
  return n.toFixed(2);
}

function fmtPct(n: number | null): string {
  if (n == null) return '--';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function pctColor(n: number | null): string {
  if (n == null) return 'text-muted-foreground';
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-muted-foreground';
}

function leanColor(score: number | null | undefined): string {
  if (score == null) return 'text-muted-foreground';
  if (score >= 60) return 'text-emerald-400';
  if (score <= 40) return 'text-red-400';
  return 'text-muted-foreground';
}

function momentumArrow(delta: number | null | undefined): string {
  if (delta == null || Math.abs(delta) < 1) return '—';
  return delta > 0 ? '↑' : '↓';
}

const DIRECTION_STROKE: Record<MacroSparklineSeries['direction'], string> = {
  up: '#10b981',
  down: '#f43f5e',
  flat: '#94a3b8',
};

export function MacroTile({
  ticker,
  spot,
  pct,
  sparkline,
  lean,
  flagCount,
  onClick,
}: MacroTileProps) {
  const direction = sparkline?.direction ?? 'flat';
  const stroke = DIRECTION_STROKE[direction];
  const gradientId = `macro-tile-fill-${ticker}`;
  const points = sparkline?.points ?? [];
  const hasSparkline = points.length >= 2;

  const leanScore = lean?.score ?? null;
  const leanArrow = momentumArrow(lean?.momentum_delta);
  const leanMomentum =
    lean?.momentum_delta != null && Math.abs(lean.momentum_delta) >= 1
      ? `${lean.momentum_delta > 0 ? '+' : ''}${lean.momentum_delta.toFixed(1)}`
      : '';

  return (
    <button type="button" onClick={onClick} className="shrink-0 w-36 h-32 text-left">
      <Card className="w-full h-full p-2 flex flex-col gap-1 hover:border-primary/40 transition-colors">
        {/* Row 1 — ticker + flag chip */}
        <div className="flex items-center justify-between leading-none">
          <span className="font-mono font-bold text-[13px] text-foreground">{ticker}</span>
          {flagCount > 0 && (
            <span
              className={cn(
                'font-mono text-[9px] px-1.5 py-0.5 rounded border tabular-nums',
                'bg-amber-500/15 text-amber-300 border-amber-500/40',
              )}
              title={`${flagCount} active flag${flagCount === 1 ? '' : 's'} today`}
            >
              {flagCount}
            </span>
          )}
        </div>

        {/* Row 2 — spot + % */}
        <div className="flex items-baseline justify-between leading-none">
          <span className="font-mono tabular-nums text-[15px] text-foreground">
            {fmtSpot(spot)}
          </span>
          <span className={cn('font-mono tabular-nums text-[10px]', pctColor(pct))}>
            {fmtPct(pct)}
          </span>
        </div>

        {/* Sparkline — flex-1 fills remaining vertical space */}
        <div className="flex-1 -mx-1 min-h-[36px]">
          {hasSparkline ? (
            <ChartSafe>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={stroke} stopOpacity={0.0} />
                    </linearGradient>
                  </defs>
                  <Area
                    type="monotone"
                    dataKey="c"
                    stroke={stroke}
                    strokeWidth={1.5}
                    fill={`url(#${gradientId})`}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartSafe>
          ) : (
            <div className="w-full h-full" />
          )}
        </div>

        {/* Footer — Lean + momentum */}
        <div className="flex items-center justify-between leading-none text-[10px] font-mono tabular-nums">
          <span className="text-muted-foreground">LEAN</span>
          <span className="flex items-baseline gap-1">
            <span className={cn('font-semibold', leanColor(leanScore))}>
              {leanScore != null ? leanScore.toFixed(0) : '--'}
            </span>
            <span className="text-muted-foreground">
              {leanArrow}
              {leanMomentum}
            </span>
          </span>
        </div>
      </Card>
    </button>
  );
}

export default MacroTile;
