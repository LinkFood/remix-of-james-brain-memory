import { useRecentEvents, type CtEvent } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useState } from 'react';
import { ChevronDown, ChevronUp, AlertTriangle, Flag, Eye } from 'lucide-react';

function relativeTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function stateIcon(type: CtEvent['_type']) {
  switch (type) {
    case 'alert':       return <AlertTriangle className="w-3 h-3 text-red-500" />;
    case 'flag':        return <Flag className="w-3 h-3 text-amber-500" />;
    case 'observation': return <Eye className="w-3 h-3 text-muted-foreground" />;
  }
}

function stateColor(type: CtEvent['_type']): string {
  switch (type) {
    case 'alert':       return 'border-l-red-500';
    case 'flag':        return 'border-l-amber-500';
    case 'observation': return 'border-l-muted-foreground';
  }
}

function directionBadge(d: string | null) {
  if (!d) return null;
  const colors: Record<string, string> = {
    bullish: 'bg-green-500/15 text-green-400 border-green-500/30',
    bearish: 'bg-red-500/15 text-red-400 border-red-500/30',
    neutral: 'bg-muted/50 text-muted-foreground border-muted',
    volatility: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  };
  return <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${colors[d] ?? 'bg-muted'}`}>{d.toUpperCase()}</Badge>;
}

function EventRow({ event }: { event: CtEvent }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`p-3 border-l-2 ${stateColor(event._type)} hover:bg-muted/30 transition-colors`}>
      <div className="flex items-start gap-2">
        <div className="mt-0.5">{stateIcon(event._type)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs mb-1 flex-wrap">
            <span className="font-mono font-semibold text-foreground uppercase text-[10px]">{event._type}</span>
            <span className="font-semibold text-foreground">{event.instruments.join(', ')}</span>
            {directionBadge(event.direction)}
            {event.conviction != null && (
              <span className="text-[10px] text-muted-foreground">conv {event.conviction}</span>
            )}
            {event.horizon && (
              <span className="text-[10px] text-muted-foreground">{event.horizon}</span>
            )}
            {event.alert_trigger && (
              <span className="text-[10px] text-red-400">{event.alert_trigger}</span>
            )}
            <span className="text-[10px] text-muted-foreground ml-auto">{relativeTime(event.created_at)}</span>
          </div>

          {event.glance && event.glance.length > 0 && (
            <ul className="space-y-0.5 text-xs text-foreground/90">
              {event.glance.map((g, i) => (
                <li key={i} className="pl-2 before:content-['·'] before:mr-1 before:text-muted-foreground">{g}</li>
              ))}
            </ul>
          )}

          {event.full_reasoning && (
            <div className="mt-1">
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
              >
                {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {expanded ? 'hide' : 'show'} full reasoning
              </button>
              {expanded && (
                <div className="mt-1 text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed bg-muted/20 p-2 rounded">
                  {event.full_reasoning}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function EventFeed() {
  const { data: events, isLoading } = useRecentEvents(25);

  return (
    <Card className="divide-y divide-border">
      <div className="px-3 py-2 border-b border-border bg-muted/30 sticky top-0 z-10">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Intraday Feed</h3>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">loading…</div>
      ) : !events || events.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          no events yet — observations/flags/alerts land here as Claude watches
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto">
          {events.map((e) => (
            <EventRow key={`${e._type}:${e.id}`} event={e} />
          ))}
        </div>
      )}
    </Card>
  );
}
