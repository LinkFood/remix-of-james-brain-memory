/**
 * ClaudesRead — the read at a glance, at the very top of Command Station.
 *
 * Pulls the most recent OBSERVATION / FLAG / ALERT (not heartbeat) and
 * displays it big and readable: state badge, direction, conviction if any,
 * glance bullets verbatim. This is the "what does Claude think RIGHT NOW"
 * headline that answers "I can't get a read" at a glance.
 */
import { useRecentEvents, type CtEvent } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, Flag, Eye } from 'lucide-react';

function relTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function stateMeta(type: CtEvent['_type']) {
  switch (type) {
    case 'alert':       return { icon: <AlertTriangle className="w-4 h-4" />, label: 'ALERT',       tint: 'bg-red-500/15 border-red-500/40 text-red-400' };
    case 'flag':        return { icon: <Flag className="w-4 h-4" />,          label: 'FLAG',        tint: 'bg-amber-500/15 border-amber-500/40 text-amber-400' };
    case 'observation': return { icon: <Eye className="w-4 h-4" />,           label: 'OBSERVATION', tint: 'bg-muted/40 border-border text-muted-foreground' };
  }
}

function directionColor(d: string | null | undefined): string {
  switch (d) {
    case 'bullish':     return 'bg-green-500/15 text-green-400 border-green-500/40';
    case 'bearish':     return 'bg-red-500/15 text-red-400 border-red-500/40';
    case 'volatility':  return 'bg-amber-500/15 text-amber-400 border-amber-500/40';
    case 'neutral':     return 'bg-muted/40 text-muted-foreground border-border';
    default:            return 'bg-muted/30 text-muted-foreground';
  }
}

export function ClaudesRead() {
  const { data: events, isLoading } = useRecentEvents(5);
  const latest = events?.[0];
  const meta = latest ? stateMeta(latest._type) : null;

  if (isLoading) {
    return (
      <Card className="p-4 min-h-[120px] flex items-center justify-center text-sm text-muted-foreground">
        loading Claude's read…
      </Card>
    );
  }

  if (!latest) {
    return (
      <Card className="p-4 min-h-[120px] flex items-center justify-center text-sm text-muted-foreground">
        No observations yet. Watcher will post first read on next cycle.
      </Card>
    );
  }

  return (
    <Card className={`p-4 border-2 ${meta!.tint.split(' ').slice(1, 2)}`}>
      <div className="flex items-start gap-3">
        <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-semibold uppercase tracking-wider shrink-0 ${meta!.tint}`}>
          {meta!.icon}
          {meta!.label}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs flex-wrap mb-2">
            <span className="text-muted-foreground font-medium">Claude's Read</span>
            <span className="text-muted-foreground/60">·</span>
            <span className="font-mono font-semibold text-foreground">{(latest.instruments ?? []).join(' ')}</span>
            {latest.direction && (
              <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${directionColor(latest.direction)}`}>
                {latest.direction.toUpperCase()}
              </Badge>
            )}
            {latest.conviction != null && (
              <span className="text-[10px] text-muted-foreground">conv {latest.conviction}/5</span>
            )}
            {latest.horizon && (
              <span className="text-[10px] text-muted-foreground">{latest.horizon}</span>
            )}
            {latest.alert_trigger && (
              <span className="text-[10px] text-red-400">{latest.alert_trigger}</span>
            )}
            <span className="text-[10px] text-muted-foreground ml-auto">{relTime(latest.created_at)}</span>
          </div>

          {latest.glance && latest.glance.length > 0 ? (
            <ul className="space-y-1 text-sm text-foreground/90 leading-relaxed">
              {latest.glance.map((g, i) => (
                <li key={i} className="pl-3 relative">
                  <span className="absolute left-0 top-[0.5em] w-1.5 h-1.5 rounded-full bg-primary/70" />
                  {g}
                </li>
              ))}
            </ul>
          ) : latest.full_reasoning ? (
            <p className="text-sm text-foreground/85 leading-relaxed whitespace-pre-wrap">
              {latest.full_reasoning.slice(0, 320)}{latest.full_reasoning.length > 320 ? '…' : ''}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground italic">(no glance captured)</p>
          )}
        </div>
      </div>
    </Card>
  );
}
