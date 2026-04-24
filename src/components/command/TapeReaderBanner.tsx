/**
 * TapeReaderBanner — Claude's latest read of the tape, shown at top of /tape.
 *
 * Pulls most recent row from ct_tape_commentary. Polls every 30s. Click the
 * timestamp to jump to /tape-reader for the full day timeline.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Brain, Clock, Zap, Calendar } from 'lucide-react';

interface CommentaryRow {
  id: number;
  created_at: string;
  trigger_kind: 'scheduled' | 'flag_interrupt' | 'manual';
  commentary: string;
  vix_level: number | null;
  market_tide: string | null;
  window_start: string | null;
  window_end: string | null;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function tideClass(tide: string | null): string {
  if (tide === 'bullish') return 'text-emerald-300';
  if (tide === 'bearish') return 'text-red-300';
  return 'text-muted-foreground';
}

export function TapeReaderBanner() {
  const { data } = useQuery<CommentaryRow | null>({
    queryKey: ['ct_tape_commentary_latest'],
    refetchInterval: 30_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_tape_commentary' as never) as any)
        .select('id,created_at,trigger_kind,commentary,vix_level,market_tide,window_start,window_end')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return null;
      return data as CommentaryRow | null;
    },
  });

  if (!data) {
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

  return (
    <Card className="p-3 bg-muted/10 border-primary/20 hover:border-primary/40 transition-colors">
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-center gap-2 text-xs">
          <Brain className="w-3.5 h-3.5 text-primary" />
          <span className="uppercase tracking-wider text-[10px] text-muted-foreground">Claude's read</span>
          {data.trigger_kind === 'flag_interrupt' && (
            <span className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300">
              <Zap className="w-2.5 h-2.5" />
              FLAG INTERRUPT
            </span>
          )}
          {data.market_tide && (
            <span className={cn('text-[10px] font-mono uppercase', tideClass(data.market_tide))}>
              tide {data.market_tide}
            </span>
          )}
          {data.vix_level != null && (
            <span className="text-[10px] font-mono text-muted-foreground">
              VIX {data.vix_level.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {timeAgo(data.created_at)}
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
      <div className="text-sm leading-snug text-foreground/90">{data.commentary}</div>
    </Card>
  );
}
