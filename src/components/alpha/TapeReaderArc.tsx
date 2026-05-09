/**
 * TapeReaderArc — first captain-visible 5x ship of the audit-driven loop
 * (Phase 3, 2026-05-09). Renders today's tape commentary as a horizontal
 * mood arc — one segment per 10-min read, colored by market_tide
 * (bullish=emerald, bearish=red, flat=blue per captain's "green/red/blue
 * light" framing), height by activity intensity (flag_count + flow_count/4).
 *
 * Purpose: captain's structural insight that the tape reader's evolving
 * "mood" should be glance-able without scrolling /tape-reader prose. Open
 * green-tilt → midday flat → late-day red flip becomes a single visual
 * primitive read in <1s.
 *
 * 5x lift vs /tape, /tape-v2, /tape-reader:
 *   - /tape: raw flow rows, no commentary structure
 *   - /tape-v2: latest commentary text + 3 specialist tiles, snapshot only
 *   - /tape-reader: full commentary timeline as scrollable prose list
 *   - Arc: full session compressed to ~60 segments, structurally reads
 *     the day's mood evolution at a glance
 *
 * Hover any segment → HoverCard with full commentary + tide + VIX + counts.
 * Last segment glows (current/latest).
 */

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { Activity, Zap, Clock } from 'lucide-react';
import { useTapeReaderArc, type TapeArcSegment } from '@/hooks/useTapeReaderArc';

function tideClass(tide: TapeArcSegment['market_tide']): string {
  if (tide === 'bullish') return 'bg-emerald-500';
  if (tide === 'bearish') return 'bg-red-500';
  if (tide === 'flat') return 'bg-blue-400';
  return 'bg-muted-foreground/40';
}

function tideText(tide: TapeArcSegment['market_tide']): string {
  if (tide === 'bullish') return 'text-emerald-300';
  if (tide === 'bearish') return 'text-red-300';
  if (tide === 'flat') return 'text-blue-300';
  return 'text-muted-foreground';
}

function timeOnly(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
}

export function TapeReaderArc() {
  const { segments, latest, sessionDate, dominantTide, counts, isLoading } = useTapeReaderArc();
  const [pinned, setPinned] = useState<TapeArcSegment | null>(null);

  if (isLoading) {
    return (
      <Card className="p-3 bg-muted/10 border-primary/20">
        <div className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          Tape Reader Arc · loading...
        </div>
      </Card>
    );
  }

  if (segments.length === 0) {
    return (
      <Card className="p-3 bg-muted/10 border-primary/20">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground font-semibold">
            Tape Reader Arc · {sessionDate}
          </span>
          <span className="text-[10px] font-mono text-muted-foreground">
            no reads yet today
          </span>
        </div>
        <div className="text-[11px] text-muted-foreground/70 italic">
          Tape reader fires every 10 min during RTH. First segment lands within 10 min of market open.
        </div>
      </Card>
    );
  }

  // Min/max segment height in px — taller = more activity in that 10-min window.
  const minH = 8;
  const maxH = 32;
  const intensityToH = (i: number) => Math.round(minH + ((maxH - minH) * Math.min(i, 16)) / 16);

  const focused = pinned ?? latest;

  return (
    <Card className="p-3 bg-muted/10 border-primary/20 space-y-2">
      {/* Header strip — session + tide rollup + count */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Activity className="w-3.5 h-3.5 text-primary" />
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
            Tape Reader Arc · {sessionDate}
          </span>
          <span className={cn('text-[10px] font-mono uppercase', tideText(dominantTide))}>
            session: {dominantTide}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[9px] font-mono text-muted-foreground">
          <span><span className="inline-block w-1.5 h-1.5 rounded-sm bg-emerald-500 mr-1 align-middle" />bull {counts.bullish}</span>
          <span><span className="inline-block w-1.5 h-1.5 rounded-sm bg-red-500 mr-1 align-middle" />bear {counts.bearish}</span>
          <span><span className="inline-block w-1.5 h-1.5 rounded-sm bg-blue-400 mr-1 align-middle" />flat {counts.flat}</span>
          <span className="opacity-60">· {segments.length} reads</span>
        </div>
      </div>

      {/* Arc — horizontal segment strip, hover-revealing per-segment commentary */}
      <div className="relative h-12 flex items-end gap-[2px] px-1 py-1 bg-background/50 rounded border border-border/30">
        {segments.map((s, idx) => {
          const isLatest = idx === segments.length - 1;
          const isPinned = pinned?.id === s.id;
          const h = intensityToH(s.intensity);
          const flagInterruptRing = s.trigger_kind === 'flag_interrupt'
            ? 'ring-1 ring-amber-400'
            : '';
          return (
            <HoverCard key={s.id} openDelay={50} closeDelay={100}>
              <HoverCardTrigger asChild>
                <button
                  type="button"
                  onClick={() => setPinned(isPinned ? null : s)}
                  className={cn(
                    'flex-1 min-w-[6px] max-w-[14px] rounded-sm cursor-pointer transition-all hover:opacity-100',
                    tideClass(s.market_tide),
                    flagInterruptRing,
                    isLatest && !isPinned && 'opacity-100 ring-1 ring-primary/60 shadow-[0_0_6px_rgba(96,165,250,0.4)]',
                    isPinned && 'opacity-100 ring-2 ring-primary',
                    !isLatest && !isPinned && 'opacity-80',
                  )}
                  style={{ height: `${h}px` }}
                  aria-label={`${timeOnly(s.created_at)} ${s.market_tide ?? 'na'} tide, ${s.flag_count} flags, ${s.flow_count} flow`}
                />
              </HoverCardTrigger>
              <HoverCardContent
                className="w-80 p-3 bg-card/95 backdrop-blur border-primary/30 text-[11px]"
                side="bottom"
                align="center"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {timeOnly(s.created_at)} ET
                  </span>
                  {s.trigger_kind === 'flag_interrupt' && (
                    <span className="inline-flex items-center gap-0.5 text-[9px] font-mono px-1 py-0.5 rounded bg-amber-500/15 text-amber-300">
                      <Zap className="w-2.5 h-2.5" />
                      INTERRUPT
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mb-2 text-[9px] font-mono text-muted-foreground">
                  <span className={tideText(s.market_tide)}>tide {s.market_tide ?? '—'}</span>
                  <span>vix {s.vix_level != null ? s.vix_level.toFixed(2) : '—'}</span>
                  <span>flags {s.flag_count}</span>
                  <span>flow {s.flow_count}</span>
                </div>
                <div className="text-[11px] leading-snug text-foreground/95 line-clamp-6">
                  {s.commentary}
                </div>
              </HoverCardContent>
            </HoverCard>
          );
        })}
      </div>

      {/* Pinned/latest detail strip below — full commentary text of the segment in focus */}
      {focused && (
        <div className="text-[11px] leading-relaxed text-foreground/90 px-1 pt-1 border-t border-border/30">
          <div className="flex items-center gap-2 mb-1">
            <Clock className="w-3 h-3 text-muted-foreground" />
            <span className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              {pinned ? 'pinned' : 'latest'} · {timeOnly(focused.created_at)} ET
            </span>
            <span className={cn('font-mono text-[9px] uppercase', tideText(focused.market_tide))}>
              {focused.market_tide ?? '—'}
            </span>
            {focused.vix_level != null && (
              <span className="font-mono text-[9px] text-muted-foreground">
                vix {focused.vix_level.toFixed(2)}
              </span>
            )}
            {pinned && (
              <button
                type="button"
                onClick={() => setPinned(null)}
                className="ml-auto text-[9px] font-mono text-muted-foreground/70 hover:text-foreground"
              >
                unpin →
              </button>
            )}
          </div>
          <div className="line-clamp-3">{focused.commentary}</div>
        </div>
      )}
    </Card>
  );
}
