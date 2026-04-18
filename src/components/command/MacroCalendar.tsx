/**
 * MacroCalendar — dedicated 14-day macro-events surface.
 *
 * Surfaces the next 14 days of the 7 canonical macro releases (FOMC, CPI,
 * PPI, jobs, employment, GDP, fed_speak, retail_sales) as a timeline with
 * per-event countdown + impact tier. High-impact events within 48h show
 * Claude's current pre-event posture (latest ct_alert / ct_flag on index
 * instruments in the last 24h).
 *
 * Distinct from EventsPanel — EventsPanel is 24hr mixed (earnings/FDA/econ);
 * this is 14d pure macro with posture overlay.
 */

import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { CalendarClock, Landmark, AlertCircle } from 'lucide-react';
import { useMacroEvents, usePreEventPosture, type MacroEventRow } from '@/hooks/useCoTraderData';
import { macroLabel } from '@/lib/macroEvents';

const ET_TZ = 'America/New_York';

/** Build the actual UTC ms for an event row. If no event_time, use noon ET. */
function eventMs(row: MacroEventRow): number {
  const time = row.event_time;
  if (!time) {
    // Noon ET on event_date. ET is either UTC-4 (EDT) or UTC-5 (EST); we
    // don't need perfect precision for countdown display, so split the
    // difference at UTC-4:30 and let the user's local clock do the rest.
    return new Date(`${row.event_date}T16:30:00Z`).getTime();
  }
  // UW times come as "HH:MM:SS+00". If it's already tagged, new Date parses it.
  const normalized = time.replace(/\+00$/, 'Z').replace(/([+-]\d{2})$/, '$1:00');
  const iso = `${row.event_date}T${normalized}`;
  const ms = new Date(iso).getTime();
  if (Number.isFinite(ms)) return ms;
  // Fallback — treat as noon-ET
  return new Date(`${row.event_date}T16:30:00Z`).getTime();
}

function countdown(ms: number, nowMs: number): string {
  const delta = ms - nowMs;
  if (delta < 0) return 'now';
  const mins = Math.floor(delta / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
}

function formatEtDateTime(row: MacroEventRow): string {
  const ms = eventMs(row);
  const d = new Date(ms);
  const datePart = d.toLocaleDateString('en-US', { timeZone: ET_TZ, weekday: 'short', month: 'short', day: 'numeric' });
  if (!row.event_time) return `${datePart} · tbd`;
  const timePart = d.toLocaleTimeString('en-US', { timeZone: ET_TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  return `${datePart} · ${timePart} ET`;
}

function impactStyles(impact: MacroEventRow['impact']): { border: string; badge: string; label: string } {
  switch (impact) {
    case 'high':
      return {
        border: 'border-l-2 border-red-500/80',
        badge: 'bg-red-500/15 text-red-300 border border-red-500/30',
        label: 'HIGH',
      };
    case 'medium':
      return {
        border: 'border-l-2 border-amber-500/70',
        badge: 'bg-amber-500/10 text-amber-300 border border-amber-500/30',
        label: 'MED',
      };
    case 'low':
      return {
        border: 'border-l-2 border-muted',
        badge: 'bg-muted/30 text-muted-foreground border border-border',
        label: 'LOW',
      };
  }
}

/** Compact posture line for a high-impact event inside 48h. */
function PostureLine({ asOf }: { asOf: string }) {
  const { data: posture, isLoading } = usePreEventPosture(24);
  if (isLoading) return null;
  if (!posture) {
    return (
      <div className="mt-1 text-[10px] text-muted-foreground italic">
        No recent posture. Claude hasn't spoken on indexes in 24h.
      </div>
    );
  }
  const mins = Math.round((Date.now() - new Date(posture.created_at).getTime()) / 60_000);
  const ageStr = mins < 60 ? `${mins}m ago` : `${Math.floor(mins / 60)}h ago`;
  const dirColor =
    posture.direction === 'bullish' ? 'text-emerald-300'
    : posture.direction === 'bearish' ? 'text-red-300'
    : posture.direction === 'volatility' ? 'text-amber-300'
    : 'text-muted-foreground';
  return (
    <div className="mt-1 flex items-start gap-1.5 text-[10.5px]">
      <AlertCircle className="w-3 h-3 mt-0.5 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <span className="text-muted-foreground">Claude posture: </span>
        <span className={`font-semibold ${dirColor}`}>
          {posture.direction} {posture.instruments.slice(0, 2).join('/')}
        </span>
        <span className="text-muted-foreground"> · conv {posture.conviction} · {posture.horizon} · {ageStr} ({posture.kind})</span>
        {posture.summary && (
          <div className="text-muted-foreground truncate" title={posture.summary}>{posture.summary}</div>
        )}
      </div>
      {/* asOf reserved for later: could show how fresh the posture is relative
          to the event, not just absolute age. Keeping the prop plumbing for
          downstream "posture staleness vs event" styling. */}
      <span className="sr-only">as-of {asOf}</span>
    </div>
  );
}

function EventRow({ event, nowMs }: { event: MacroEventRow; nowMs: number }) {
  const ms = eventMs(event);
  const hoursUntil = (ms - nowMs) / 3_600_000;
  const styles = impactStyles(event.impact);
  const showPosture = event.impact === 'high' && hoursUntil > 0 && hoursUntil <= 48;

  return (
    <div className={`pl-2 pr-2.5 py-1.5 ${styles.border}`}>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className={`px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide ${styles.badge}`}>
          {styles.label}
        </span>
        <span className="text-[11px] font-semibold text-foreground">
          {macroLabel(event.macro_type)}
        </span>
        <span className="text-[10px] text-muted-foreground font-mono ml-auto">
          {countdown(ms, nowMs)}
        </span>
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground font-mono">
        {formatEtDateTime(event)}
      </div>
      {event.title && (
        <div className="text-[10.5px] text-muted-foreground/80 truncate mt-0.5" title={event.title}>
          {event.title}
        </div>
      )}
      {showPosture && <PostureLine asOf={event.event_date} />}
    </div>
  );
}

export function MacroCalendar() {
  const { data, isLoading } = useMacroEvents();
  const nowMs = useMemo(() => Date.now(), [data]); // Refresh "now" when data changes
  const events = data ?? [];

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Landmark className="w-3 h-3 text-primary" />
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground">
            Macro Calendar
          </span>
          <span className="text-[10px] text-muted-foreground">next 14d · ET</span>
          <span className="ml-auto text-[10px] text-muted-foreground font-mono">
            {isLoading ? 'loading…' : `${events.length} events`}
          </span>
        </div>
      </div>
      {events.length === 0 ? (
        <div className="p-4 text-center text-[11px] text-muted-foreground">
          {isLoading ? (
            <span className="inline-flex items-center gap-1"><CalendarClock className="w-3 h-3" /> loading…</span>
          ) : (
            'No macro events in next 14 days.'
          )}
        </div>
      ) : (
        <div className="divide-y divide-border/50 max-h-[440px] overflow-y-auto">
          {events.map((e) => (
            <EventRow key={e.id} event={e} nowMs={nowMs} />
          ))}
        </div>
      )}
    </Card>
  );
}
