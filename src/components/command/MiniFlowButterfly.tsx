/**
 * MiniFlowButterfly — compact Flow Butterfly panel for the multi-panel grid.
 *
 * Renders one ticker's 4-series CP butterfly (or 2-series BB area if mode='bb')
 * in a small, glanceable container (~280px wide × ~180px tall). Strips chrome
 * to: ticker label, last cumulative bias, the chart itself.
 *
 * All shared state (range, mode, dte) comes from the parent grid page so
 * captain switches dimensions once and all 10 panels respond. Each panel
 * fetches its own ticker via useNetPremiumExpirySplit (CP) or useFlowPulseChart
 * (BB) — same hooks the full FlowPulseChart uses, so Realtime invalidation +
 * 30s refresh policy match.
 *
 * Pattern alignment: per-panel y-axis (each panel scales to its own range —
 * same philosophy as heatmap's per-row coloring).
 */

import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import {
  useFlowPulseChart,
  useNetPremiumExpirySplit,
  formatPulseDollars,
} from '@/hooks/useFlowPulse';
import {
  buildLiveCp4Series,
  buildButterfly,
  rangeToMin,
  type RangeKey,
  type ModeKey,
  type DteKey,
} from './FlowPulseChart';

interface Props {
  ticker: string;
  range: RangeKey;
  mode: ModeKey;
  dte?: DteKey;
}

export function MiniFlowButterfly({ ticker, range, mode, dte = 'all' }: Props) {
  const cpQuery = useNetPremiumExpirySplit(ticker, undefined);
  const bbQuery = useFlowPulseChart(ticker, rangeToMin(range));

  const cpData = useMemo(
    () => buildLiveCp4Series(
      cpQuery.points,
      /* skipPreMarket */ true,
      /* trailingMinutes */ rangeToMin(range),
      /* multiDay */ false,
    ),
    [cpQuery.points, range],
  );

  const bbData = useMemo(
    () => buildButterfly(bbQuery.points, dte, /* multiDay */ false),
    [bbQuery.points, dte],
  );

  const isLoading = mode === 'cp' ? cpQuery.isLoading : bbQuery.isLoading;
  const isError = mode === 'cp' ? cpQuery.isError : bbQuery.isError;
  const hasData = mode === 'cp' ? cpData.length > 0 : bbData.length > 0;

  // Compute current bias label.
  const bias = useMemo(() => {
    if (mode === 'cp') {
      const last = cpData[cpData.length - 1];
      if (!last) return { tone: 'flat' as const, label: '—' };
      // Bullish: cum_all_call > cum_all_put. Bearish: opposite.
      const callDom = last.cum_all_call > last.cum_all_put;
      const spread = Math.abs(last.cum_all_call - last.cum_all_put);
      if (spread < 100_000) return { tone: 'flat' as const, label: 'flat' };
      return {
        tone: callDom ? ('top' as const) : ('bottom' as const),
        label: `${callDom ? '+' : '−'}${formatPulseDollars(spread)}`,
      };
    }
    const last = bbData[bbData.length - 1];
    if (!last) return { tone: 'flat' as const, label: '—' };
    const top = last.top_bb_abs;
    const bottom = last.bottom_bb_abs;
    const spread = Math.abs(top - bottom);
    if (spread < 100_000) return { tone: 'flat' as const, label: 'flat' };
    return {
      tone: top >= bottom ? ('top' as const) : ('bottom' as const),
      label: `${top >= bottom ? '+' : '−'}${formatPulseDollars(spread)}`,
    };
  }, [mode, cpData, bbData]);

  const biasColor = bias.tone === 'top'
    ? 'text-emerald-400'
    : bias.tone === 'bottom'
      ? 'text-rose-400'
      : 'text-muted-foreground';

  return (
    <Card className="p-2 h-[180px] flex flex-col">
      <div className="flex items-baseline justify-between mb-1 px-1">
        <span className="text-xs font-mono font-semibold tracking-wider">{ticker}</span>
        <span className={cn('text-[10px] font-mono tabular-nums', biasColor)}>
          {bias.label}
        </span>
      </div>
      <div className="flex-1 min-h-0">
        {isLoading ? (
          <div className="h-full flex items-center justify-center text-[10px] text-muted-foreground">
            loading…
          </div>
        ) : isError ? (
          <div className="h-full flex items-center justify-center text-[10px] text-rose-400/70">
            error
          </div>
        ) : !hasData ? (
          <div className="h-full flex items-center justify-center text-[10px] text-muted-foreground/60">
            no flow yet
          </div>
        ) : mode === 'cp' ? (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={cpData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <YAxis hide domain={['dataMin', 'dataMax']} />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.2} strokeWidth={1} />
              <Line type="monotone" dataKey="cum_all_call" stroke="hsl(150 70% 60%)" strokeWidth={1.25} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="cum_all_put" stroke="hsl(350 75% 60%)" strokeWidth={1.25} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="cum_next_call" stroke="hsl(150 70% 60%)" strokeWidth={1} strokeDasharray="2 2" dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="cum_next_put" stroke="hsl(350 75% 60%)" strokeWidth={1} strokeDasharray="2 2" dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={bbData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <YAxis hide domain={['dataMin', 'dataMax']} />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.2} strokeWidth={1} />
              <Area type="monotone" dataKey="top_bb" stroke="hsl(150 70% 60%)" fill="hsl(150 70% 60%)" fillOpacity={0.25} strokeWidth={1.25} isAnimationActive={false} />
              <Area type="monotone" dataKey="bottom_bb" stroke="hsl(350 75% 60%)" fill="hsl(350 75% 60%)" fillOpacity={0.25} strokeWidth={1.25} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </Card>
  );
}
