import { useRecentEvents, useSelfRegrade, type CtEvent, type CtSelfAssessment } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useState } from 'react';
import { ChevronDown, ChevronUp, AlertTriangle, Flag, Eye, Target, Brain } from 'lucide-react';

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

/** Inline 1-5 dot rating. Filled = score, empty = remainder. */
function DotRating({ value, label, color }: { value: number | null | undefined; label: string; color: string }) {
  if (value == null) return null;
  const n = Math.max(0, Math.min(5, Math.round(value)));
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground" title={`${label}: ${n}/5`}>
      <span className="uppercase tracking-wider text-[9px]">{label}</span>
      <span className="flex gap-0.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <span
            key={i}
            className={`w-1.5 h-1.5 rounded-full ${i < n ? color : 'bg-muted'}`}
          />
        ))}
      </span>
    </span>
  );
}

function SelfAssessmentLine({ sa }: { sa: CtSelfAssessment }) {
  return (
    <div className="mt-1 flex items-center gap-3 flex-wrap">
      <DotRating value={sa.confidence} label="conf" color="bg-sky-400" />
      <DotRating value={sa.reasoning_quality} label="reas" color="bg-violet-400" />
      {sa.key_evidence && (
        <span className="text-[10px] text-foreground/70 italic truncate max-w-[60%]">
          ev: {sa.key_evidence}
        </span>
      )}
    </div>
  );
}

function SelfAssessmentDetail({ sa }: { sa: CtSelfAssessment }) {
  return (
    <div className="space-y-1 text-xs">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Target className="w-3 h-3" /> Live self-rating
      </div>
      {sa.key_evidence && (
        <div><span className="text-muted-foreground">key evidence:</span> {sa.key_evidence}</div>
      )}
      {sa.kill_conditions && (
        <div><span className="text-muted-foreground">kill conditions:</span> {sa.kill_conditions}</div>
      )}
      {sa.what_could_go_wrong && (
        <div><span className="text-muted-foreground">what could go wrong:</span> {sa.what_could_go_wrong}</div>
      )}
    </div>
  );
}

function RetrospectiveBlock({ event }: { event: CtEvent }) {
  const { data: regrade } = useSelfRegrade(event._type, event.id);
  if (!regrade) {
    return (
      <div className="mt-2 text-[10px] text-muted-foreground italic">
        retrospective regrade not written yet — runs 2-24hr after creation
      </div>
    );
  }
  return (
    <div className="mt-2 pt-2 border-t border-border space-y-1.5 text-xs">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Brain className="w-3 h-3" /> Retrospective (regraded {relativeTime(regrade.regraded_at)})
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <DotRating value={regrade.retrospective_confidence} label="retro conf" color="bg-sky-400" />
        <DotRating value={regrade.retrospective_reasoning_quality} label="retro reas" color="bg-violet-400" />
        {regrade.grader_verdict && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            grader: {regrade.grader_verdict}
          </Badge>
        )}
      </div>
      {regrade.what_i_got_right && (
        <div><span className="text-green-400 text-[10px] uppercase">got right:</span> {regrade.what_i_got_right}</div>
      )}
      {regrade.what_i_got_wrong && (
        <div><span className="text-red-400 text-[10px] uppercase">got wrong:</span> {regrade.what_i_got_wrong}</div>
      )}
      {regrade.how_id_rewrite && (
        <div><span className="text-muted-foreground text-[10px] uppercase">how i'd rewrite:</span> {regrade.how_id_rewrite}</div>
      )}
    </div>
  );
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

          {event.self_assessment && <SelfAssessmentLine sa={event.self_assessment} />}

          {(event.full_reasoning || event.self_assessment) && (
            <div className="mt-1">
              <button
                onClick={() => setExpanded(!expanded)}
                className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-0.5"
              >
                {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                {expanded ? 'hide' : 'show'} reasoning + regrade
              </button>
              {expanded && (
                <div className="mt-1 text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed bg-muted/20 p-2 rounded space-y-2">
                  {event.full_reasoning && <div>{event.full_reasoning}</div>}
                  {event.self_assessment && <SelfAssessmentDetail sa={event.self_assessment} />}
                  <RetrospectiveBlock event={event} />
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
