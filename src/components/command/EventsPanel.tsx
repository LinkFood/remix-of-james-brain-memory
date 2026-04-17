/**
 * EventsPanel — three-column right-rail display of next 24hr events.
 * Columns: Earnings · FDA · Econ. Times rendered in America/New_York.
 */
import { useEventsToday, type CtEventRow } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { CalendarClock, FlaskConical, Landmark, TrendingUp } from 'lucide-react';

const ET_TZ = 'America/New_York';

function formatEt(date: string, time: string | null): string {
  if (!time) {
    const d = new Date(date + 'T12:00:00Z');
    const today = new Date().toISOString().slice(0, 10);
    return date === today ? 'today' : d.toLocaleDateString('en-US', { timeZone: ET_TZ, month: 'short', day: 'numeric' });
  }
  // time is "HH:MM:SS+00" — combine with date to get UTC moment, then format in ET
  const timeClean = time.replace(/\+00$/, 'Z').replace(/([+-]\d{2})$/, '$1:00');
  const iso = `${date}T${timeClean.includes(':') && timeClean.length >= 8 ? timeClean : time}`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // fallback — treat as UTC HH:MM:SS
    const m = time.match(/^(\d{2}):(\d{2})/);
    if (m) return `${m[1]}:${m[2]} UTC`;
    return time;
  }
  const today = new Date().toISOString().slice(0, 10);
  const hh = d.toLocaleTimeString('en-US', { timeZone: ET_TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  return date === today ? hh : `${d.toLocaleDateString('en-US', { timeZone: ET_TZ, month: 'short', day: 'numeric' })} ${hh}`;
}

function EventColumn({
  title,
  icon: Icon,
  accent,
  events,
  emptyText,
}: {
  title: string;
  icon: typeof CalendarClock;
  accent: string;
  events: CtEventRow[];
  emptyText: string;
}) {
  return (
    <div>
      <div className={`px-2.5 py-1.5 ${accent} text-[10px] font-semibold uppercase tracking-wide flex items-center gap-1`}>
        <Icon className="w-3 h-3" />
        {title}
        <span className="ml-auto text-muted-foreground font-mono">{events.length}</span>
      </div>
      {events.length === 0 ? (
        <div className="p-2 text-[10px] text-muted-foreground">{emptyText}</div>
      ) : (
        <div className="divide-y divide-border/50 max-h-[220px] overflow-y-auto">
          {events.map((e) => (
            <div key={e.id} className="px-2.5 py-1 text-[10.5px] flex flex-col gap-0.5">
              <div className="flex items-center gap-1.5">
                {e.ticker ? (
                  <span className="font-mono font-bold text-foreground">{e.ticker}</span>
                ) : (
                  <span className="text-muted-foreground text-[9.5px] uppercase tracking-wide">macro</span>
                )}
                <span className="ml-auto text-muted-foreground font-mono text-[10px]">
                  {formatEt(e.event_date, e.event_time)}
                </span>
              </div>
              {e.title && (
                <div className="text-muted-foreground truncate" title={e.title}>{e.title}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function EventsPanel() {
  const { data, isLoading } = useEventsToday();
  const all = data ?? [];
  const earnings = all.filter((e) => e.event_type === 'earnings');
  const fda = all.filter((e) => e.event_type === 'fda');
  const econ = all.filter((e) => e.event_type === 'econ');

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <CalendarClock className="w-3 h-3 text-primary" />
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Events</span>
          <span className="text-[10px] text-muted-foreground">today + next 24hr · ET</span>
          {isLoading && <span className="ml-auto text-[10px] text-muted-foreground">loading…</span>}
        </div>
      </div>

      <div className="grid grid-cols-3 divide-x divide-border">
        <EventColumn
          title="Earnings"
          icon={TrendingUp}
          accent="bg-green-500/5 text-green-400"
          events={earnings}
          emptyText="no earnings"
        />
        <EventColumn
          title="FDA"
          icon={FlaskConical}
          accent="bg-purple-500/5 text-purple-400"
          events={fda}
          emptyText="no FDA"
        />
        <EventColumn
          title="Econ"
          icon={Landmark}
          accent="bg-blue-500/5 text-blue-400"
          events={econ}
          emptyText="no econ"
        />
      </div>
    </Card>
  );
}
