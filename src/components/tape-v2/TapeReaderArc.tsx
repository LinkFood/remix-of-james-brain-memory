/**
 * TapeReaderArc — v2 Tape command-center upgrade of TapeReaderBanner.
 *
 * Adds session ARC: simple progression line of `market_tide` over the day's
 * commentary rows (latest + up to 19 prior). Each ct_tape_commentary row is
 * one data point, mapped bullish=+1 / flat=0 / bearish=-1. Renders compact
 * Recharts LineChart with hidden axes — pattern shape is the read.
 *
 * Captain locked v1 ARC scope as simple progression line. 4-segment ribbon
 * (separate signal sources colored independently) defers to v1.1 when
 * segment definitions lock.
 *
 * Reuses TapeReaderBanner's tide pill / VIX pill / commentary text exactly
 * — surface continuity. Click timeline icon for full /tape-reader.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { LineChart, Line, ReferenceLine, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Brain, Calendar, Clock, Zap, Activity } from 'lucide-react';
import { useTapeReader } from '@/hooks/useTapeReader';
import { TapeCommentaryRender } from '@/components/co-trader/TapeCommentaryRender';

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function tideClass(tide: string | null | undefined): string {
  if (tide === 'bullish') return 'text-emerald-300';
  if (tide === 'bearish') return 'text-red-300';
  return 'text-muted-foreground';
}

function tideToValue(t: string | null): number | null {
  if (t === 'bullish') return 1;
  if (t === 'flat') return 0;
  if (t === 'bearish') return -1;
  return null;
}

interface ArcPoint {
  ts: number;
  iso: string;
  tide: number | null;
  trigger: 'scheduled' | 'flag_interrupt' | 'manual';
}

export function TapeReaderArc() {
  const { latest, rows, isLoading } = useTapeReader({ priorCount: 19 });

  const arcData = useMemo<ArcPoint[]>(() => {
    if (!rows || rows.length === 0) return [];
    // Reverse so chart reads left-to-right oldest → newest.
    return rows
      .slice()
      .reverse()
      .map((r) => ({
        ts: Date.parse(r.created_at),
        iso: r.created_at,
        tide: tideToValue(r.market_tide),
        trigger: r.trigger_kind,
      }));
  }, [rows]);

  const flipMarkers = useMemo(() => {
    // Annotate flag-interrupt rows on the line (they ARE the leading-indicator
    // moments per captain framing). Returns Recharts-friendly coordinates.
    return arcData.filter((p) => p.trigger === 'flag_interrupt');
  }, [arcData]);

  if (isLoading && !latest) {
    return (
      <Card className="p-3 bg-muted/10 border-primary/10">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Brain className="w-3.5 h-3.5" />
          <span className="uppercase tracking-wider text-[10px]">Claude's read</span>
          <span className="italic">Loading session arc…</span>
        </div>
      </Card>
    );
  }

  if (!latest) {
    return (
      <Card className="p-3 bg-muted/10 border-primary/10">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Brain className="w-3.5 h-3.5" />
          <span className="uppercase tracking-wider text-[10px]">Claude's read</span>
          <span className="italic">Waiting for first commentary. Fires every 10 min during market hours.</span>
        </div>
      </Card>
    );
  }

  const hasArc = arcData.length >= 2 && arcData.some((p) => p.tide !== null);

  return (
    <Card className="p-3 bg-muted/10 border-primary/20 hover:border-primary/40 transition-colors">
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 text-xs flex-wrap">
          <Brain className="w-3.5 h-3.5 text-primary" />
          <span className="uppercase tracking-wider text-[10px] text-muted-foreground">Claude's read</span>
          {latest.trigger_kind === 'flag_interrupt' && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
              <Zap className="w-2.5 h-2.5" />
              FLAG INTERRUPT
            </span>
          )}
          {latest.market_tide && (
            <span className={cn('text-[10px] font-mono uppercase', tideClass(latest.market_tide))}>
              tide {latest.market_tide}
            </span>
          )}
          {latest.vix_level != null && (
            <span className="text-[10px] font-mono text-muted-foreground">
              VIX {latest.vix_level.toFixed(2)}
            </span>
          )}
          {hasArc && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-mono text-muted-foreground">
              <Activity className="w-2.5 h-2.5" />
              session arc · {arcData.length} reads
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {timeAgo(latest.created_at)}
          </span>
          <Link
            to="/tape-reader"
            className="inline-flex items-center gap-1 text-primary/70 hover:text-primary transition-colors"
          >
            <Calendar className="w-3 h-3" />
            Timeline
          </Link>
        </div>
      </div>

      {hasArc && (
        <div className="h-[40px] -mx-1 mb-2 mt-1">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={arcData}
              margin={{ top: 4, right: 6, bottom: 2, left: 6 }}
            >
              {/* XAxis required even hidden so ReferenceLine x= resolves
                  against category — same lesson as PR #67 cross-annotations. */}
              <XAxis
                dataKey="ts"
                type="number"
                domain={['dataMin', 'dataMax']}
                hide
              />
              <YAxis domain={[-1.2, 1.2]} hide />
              <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.3} strokeDasharray="2 2" />
              {flipMarkers.map((m) => (
                <ReferenceLine
                  key={m.ts}
                  x={m.ts}
                  stroke="hsl(45 100% 60%)"
                  strokeOpacity={0.7}
                  strokeWidth={1}
                />
              ))}
              <Line
                type="stepAfter"
                dataKey="tide"
                stroke="hsl(var(--primary))"
                strokeWidth={1.5}
                dot={{ r: 1.5, fill: 'hsl(var(--primary))', strokeWidth: 0 }}
                isAnimationActive={false}
                connectNulls={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      <TapeCommentaryRender
        commentary={latest.commentary}
        flagIds={latest.flag_ids}
        flowIds={latest.flow_ids}
        priorCommentary={rows[1]?.commentary ?? null}
      />
    </Card>
  );
}
