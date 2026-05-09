/**
 * ClaudesRead — the synthesis layer of the v2 alpha surface.
 *
 * Top-of-page full-width section. The system's reads of the tape +
 * specialists + (semantic recall over historical reads, iter #2) compose
 * here. Captain reads this FIRST, then drops down to the four alpha
 * surfaces feeding it.
 *
 * Iter #1: latest tape commentary (full text) + 3 most-recent specialist
 * reads ordered by conviction × freshness. Both feeds reuse existing
 * /tape-v2 hooks (useTapeReader, useSpecialistsTileRow) — no new
 * substrate; honest first cut.
 *
 * Iter #2 will wire semantic recall over ct_tape_commentary embedding:
 * "show 5 most-similar historical reads + their NextClose outcomes." See
 * iteration log for sequencing.
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Brain, Calendar, Clock, Zap, Sparkles, Layers } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTapeReader } from '@/hooks/useTapeReader';
import { useSpecialistsTileRow, type SpecialistTile } from '@/hooks/useSpecialistsTileRow';
import { useSemanticTapeRecall, type SemanticTapeMatch } from '@/hooks/useSemanticTapeRecall';

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

function convictionColor(conviction: number | null, direction: SpecialistTile['direction']): string {
  if (conviction == null) return 'text-muted-foreground';
  if (conviction >= 70) {
    if (direction === 'bullish') return 'text-emerald-300 font-semibold';
    if (direction === 'bearish') return 'text-red-300 font-semibold';
    return 'text-amber-300 font-semibold';
  }
  if (conviction >= 50) {
    if (direction === 'bullish') return 'text-emerald-400/80';
    if (direction === 'bearish') return 'text-red-400/80';
    return 'text-foreground/80';
  }
  return 'text-muted-foreground';
}

function arrowFor(direction: SpecialistTile['direction']): string {
  if (direction === 'bullish') return '↑';
  if (direction === 'bearish') return '↓';
  return '−';
}

function shortDay(iso: string): string {
  // "2026-05-05T14:32:00Z" -> "5/5 14:32 ET"
  const d = new Date(iso);
  const m = d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', timeZone: 'America/New_York' });
  const t = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/New_York' });
  return `${m} ${t}`;
}

function matchTideClass(tide: SemanticTapeMatch['market_tide']): string {
  if (tide === 'bullish') return 'text-emerald-300';
  if (tide === 'bearish') return 'text-red-300';
  if (tide === 'flat') return 'text-blue-300';
  return 'text-muted-foreground';
}

export function ClaudesRead() {
  const { latest } = useTapeReader({ priorCount: 0 });
  const { data: specialistTiles } = useSpecialistsTileRow();
  const { matches: semanticMatches, isLoading: recallLoading } = useSemanticTapeRecall({ matchCount: 5 });

  // Top 3 specialist reads by conviction, requiring a populated read.
  const topSpecialists = (specialistTiles ?? [])
    .filter((t) => t.conviction != null && t.last_fired_at != null)
    .sort((a, b) => (b.conviction ?? 0) - (a.conviction ?? 0))
    .slice(0, 3);

  return (
    <Card className="p-4 bg-muted/10 border-primary/20">
      {/* Header strip */}
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Brain className="w-4 h-4 text-primary" />
          <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
            Claude's read
          </span>
          {latest?.trigger_kind === 'flag_interrupt' && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
              <Zap className="w-2.5 h-2.5" />
              FLAG INTERRUPT
            </span>
          )}
          {latest?.market_tide && (
            <span className={cn('text-[10px] font-mono uppercase', tideClass(latest.market_tide))}>
              tide {latest.market_tide}
            </span>
          )}
          {latest?.vix_level != null && (
            <span className="text-[10px] font-mono text-muted-foreground">
              VIX {latest.vix_level.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {latest && (
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {timeAgo(latest.created_at)}
            </span>
          )}
          <Link
            to="/tape-reader"
            className="inline-flex items-center gap-1 text-primary/70 hover:text-primary transition-colors"
          >
            <Calendar className="w-3 h-3" />
            Timeline
          </Link>
        </div>
      </div>

      {/* Tape commentary — the synthesis */}
      <div className="text-[13px] leading-relaxed text-foreground/95 mb-4">
        {latest?.commentary ?? (
          <span className="italic text-muted-foreground">
            Awaiting first commentary. Tape reader fires every 10 min during market hours.
          </span>
        )}
      </div>

      {/* Specialist reads — the inputs the synthesis is reading */}
      {topSpecialists.length > 0 && (
        <div className="border-t border-border/40 pt-3">
          <div className="flex items-center gap-1.5 mb-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            <Sparkles className="w-3 h-3" />
            Top specialist reads · by conviction
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {topSpecialists.map((tile) => (
              <div
                key={tile.ticker}
                className="px-2 py-1.5 rounded bg-muted/15 border border-muted/30 text-[10px] font-mono"
              >
                <div className="flex items-center justify-between mb-0.5">
                  <span className="font-semibold tracking-wider">
                    {tile.ticker} <span className="opacity-70">{arrowFor(tile.direction)}</span>
                  </span>
                  <span className={cn(convictionColor(tile.conviction, tile.direction))}>
                    {tile.conviction != null ? Math.round(tile.conviction) : '—'}
                  </span>
                </div>
                <div className="text-muted-foreground/70 text-[9px]">
                  {tile.last_fired_at ? timeAgo(tile.last_fired_at) : '—'}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Semantic recall — 5 most-similar prior tape reads.
          Phase 4 of audit-driven loop: iter #2 hint becomes reality.
          Substrate: Phase 1 ct_tape_commentary embedding + match_*
          RPC. Captain reads "today is similar to Y at HH:MM" — pattern
          recall over setup-shape, not chronological scrolling. */}
      <div className="mt-3 pt-3 border-t border-border/30">
        <div className="flex items-center gap-1.5 mb-2 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          <Layers className="w-3 h-3" />
          Today most resembles · semantic recall
        </div>
        {recallLoading ? (
          <div className="text-[10px] text-muted-foreground/60 italic">loading prior analogs...</div>
        ) : semanticMatches.length === 0 ? (
          <div className="text-[10px] text-muted-foreground/60 italic">
            No prior reads above similarity threshold yet — gate fills as more sessions embed.
          </div>
        ) : (
          <div className="space-y-1.5">
            {semanticMatches.map((m) => (
              <div
                key={m.id}
                className="flex items-start gap-2 text-[10px] font-mono px-2 py-1.5 rounded bg-muted/15 border border-muted/30"
              >
                <div className="flex items-center gap-2 shrink-0 w-32">
                  <span className="text-foreground/90">{shortDay(m.created_at)}</span>
                  <span className={cn('uppercase', matchTideClass(m.market_tide))}>
                    {m.market_tide ?? '—'}
                  </span>
                </div>
                <div className="flex items-center gap-1 shrink-0 w-20 text-muted-foreground">
                  <span>vix {m.vix_level != null ? m.vix_level.toFixed(1) : '—'}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0 w-16 text-muted-foreground">
                  <span>f{m.flag_id_count}/p{m.flow_id_count}</span>
                </div>
                <div className="flex-1 min-w-0 text-foreground/80 truncate">
                  {m.commentary.replace(/\s+/g, ' ').slice(0, 140)}
                </div>
                <div className="shrink-0 text-primary/70 font-semibold">
                  {(m.similarity * 100).toFixed(0)}%
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
