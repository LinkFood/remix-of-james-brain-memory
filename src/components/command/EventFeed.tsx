import { useRecentEvents, useSelfRegrade, type CtEvent, type CtSelfAssessment } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, AlertTriangle, Flag, Eye, Target, Brain, Layers } from 'lucide-react';

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

/**
 * Normalize the first glance bullet for dedup comparison:
 * lowercase, collapse whitespace, take first 60 chars.
 */
function normGlance(e: CtEvent): string {
  const g = e.glance?.[0] ?? e.full_reasoning ?? '';
  return g.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
}

interface EventGroup {
  lead: CtEvent;          // newest event in the group (shown as the card)
  members: CtEvent[];     // all events in the group, newest first
}

/**
 * Collapse consecutive events where (instruments, direction, conviction)
 * match AND the normalized first-60-char glance matches. Events is assumed
 * newest-first (that's how useRecentEvents returns it).
 */
function groupConsecutive(events: CtEvent[]): EventGroup[] {
  const out: EventGroup[] = [];
  for (const e of events) {
    const prev = out[out.length - 1];
    if (prev) {
      const a = prev.lead;
      const sameInstr = (a.instruments ?? []).join(',') === (e.instruments ?? []).join(',');
      const sameDir = (a.direction ?? null) === (e.direction ?? null);
      const sameConv = (a.conviction ?? null) === (e.conviction ?? null);
      const sameGlance = normGlance(a) === normGlance(e) && normGlance(a).length > 0;
      if (sameInstr && sameDir && sameConv && sameGlance) {
        prev.members.push(e);
        continue;
      }
    }
    out.push({ lead: e, members: [e] });
  }
  return out;
}

/** Short human span between earliest and latest member (e.g. "2h"). */
function spanLabel(members: CtEvent[]): string {
  if (members.length < 2) return '';
  const newest = Date.parse(members[0].created_at);
  const oldest = Date.parse(members[members.length - 1].created_at);
  const mins = Math.max(0, Math.round((newest - oldest) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hrs = mins / 60;
  if (hrs < 24) return `${hrs.toFixed(hrs < 10 ? 1 : 0)}h`;
  return `${Math.round(hrs / 24)}d`;
}

function GroupedEventRow({ group }: { group: EventGroup }) {
  const [showRestatements, setShowRestatements] = useState(false);
  const n = group.members.length;
  if (n === 1) return <EventRow event={group.lead} />;

  return (
    <div>
      <div className="px-3 pt-2 pb-0.5 flex items-center gap-2 text-[10px] bg-amber-500/5 border-l-2 border-l-amber-500/60">
        <Layers className="w-3 h-3 text-amber-400" />
        <span className="uppercase tracking-wider text-amber-400 font-semibold">
          {n} restatements over {spanLabel(group.members)} · no material change
        </span>
        <button
          onClick={() => setShowRestatements(v => !v)}
          className="ml-auto text-muted-foreground hover:text-foreground"
        >
          {showRestatements ? 'hide timestamps' : 'show timestamps'}
        </button>
      </div>
      {showRestatements && (
        <div className="px-3 py-1 bg-amber-500/5 border-l-2 border-l-amber-500/60 text-[10px] text-muted-foreground space-y-0.5">
          {group.members.map(m => (
            <div key={`${m._type}:${m.id}`} className="font-mono flex items-center gap-2">
              <span>{new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="uppercase text-[9px]">{m._type}</span>
              <span className="truncate">{m.glance?.[0] ?? m.full_reasoning?.slice(0, 60) ?? ''}</span>
            </div>
          ))}
        </div>
      )}
      <EventRow event={group.lead} />
    </div>
  );
}

export function EventFeed() {
  const { data: events, isLoading } = useRecentEvents(25);
  const groups = useMemo(() => groupConsecutive(events ?? []), [events]);

  return (
    <Card className="divide-y divide-border">
      <div className="px-3 py-2 border-b border-border bg-muted/30 sticky top-0 z-10 flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Intraday Feed</h3>
        {events && groups.length > 0 && events.length > groups.length && (
          <span className="text-[10px] text-muted-foreground">
            {events.length} events → {groups.length} threads
          </span>
        )}
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-sm text-muted-foreground">loading…</div>
      ) : !events || events.length === 0 ? (
        <div className="p-6 text-center text-sm text-muted-foreground">
          no events yet — observations/flags/alerts land here as Claude watches
        </div>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto divide-y divide-border">
          {groups.map((g) => (
            <GroupedEventRow key={`${g.lead._type}:${g.lead.id}`} group={g} />
          ))}
        </div>
      )}
    </Card>
  );
}
