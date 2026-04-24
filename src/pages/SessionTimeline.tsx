/**
 * SessionTimeline — chronological review tool for one trading session.
 *
 * Pulls every event emitted during the 13:00–21:00 UTC window of `sessionDate`
 * (heartbeats, observations, flags, alerts, trade commits/closes, grades,
 * sweep/dp clusters, regime inversions, news) onto one scrollable timeline,
 * grouped by hour. This is the "review today" tool — no LLM summary, just
 * the raw chronology.
 *
 * Scrubber (added): a minute-granularity slider across the 13:00–21:00 UTC
 * window drives `virtualNow`. Everything downstream (snapshot card, muted-
 * opacity on future events, time marker) is derived from that single value.
 * Scrubber at "now" hides the marker and disables muting.
 */
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useSessionTimeline, type TimelineEvent, type TimelineKind } from '@/hooks/useSessionTimeline';
import { useSessionSnapshot } from '@/hooks/useSessionSnapshot';
import { useTodayBook, useBookHistory } from '@/hooks/useCoTraderData';
import { Zap } from 'lucide-react';
import { DataExportButton } from '@/components/DataExportButton';

const TICKER_CHOICES = ['all', 'SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'SPX'];

const KIND_LABEL: Record<TimelineKind, string> = {
  HEARTBEAT: 'HEARTBEAT',
  OBSERVATION: 'OBS',
  FLAG: 'FLAG',
  ALERT: 'ALERT',
  TRADE_COMMIT: 'TRADE',
  TRADE_CLOSE: 'CLOSE',
  GRADE: 'GRADE',
  SWEEP: 'SWEEP',
  DP: 'DP',
  REGIME: 'REGIME',
  NEWS: 'NEWS',
};

const KIND_BADGE: Record<TimelineKind, string> = {
  HEARTBEAT: 'bg-slate-500/20 text-slate-300',
  OBSERVATION: 'bg-slate-400/20 text-slate-200',
  FLAG: 'bg-amber-400/25 text-amber-200',
  ALERT: 'bg-red-500/25 text-red-200',
  TRADE_COMMIT: 'bg-teal-400/25 text-teal-200',
  TRADE_CLOSE: 'bg-blue-400/25 text-blue-200',
  GRADE: 'bg-slate-300/20 text-slate-100',
  SWEEP: 'bg-orange-400/25 text-orange-200',
  DP: 'bg-slate-500/30 text-slate-100',
  REGIME: 'bg-yellow-400/25 text-yellow-100',
  NEWS: 'bg-muted/40 text-muted-foreground',
};

function formatEt(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    });
  } catch {
    return iso.slice(11, 19);
  }
}

function formatEtShort(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    });
  } catch {
    return iso.slice(11, 16);
  }
}

function formatEtHour(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: 'America/New_York',
    }).replace(/:\d+$/, ':00');
  } catch {
    return iso.slice(11, 13) + ':00';
  }
}

/** Groups events by ET hour. Preserves order. */
function groupByHour(events: TimelineEvent[]): Array<{ hour: string; events: TimelineEvent[] }> {
  const groups: Array<{ hour: string; events: TimelineEvent[] }> = [];
  let current: { hour: string; events: TimelineEvent[] } | null = null;
  for (const e of events) {
    const h = formatEtHour(e.time);
    if (!current || current.hour !== h) {
      current = { hour: h, events: [] };
      groups.push(current);
    }
    current.events.push(e);
  }
  return groups;
}

/** Convert HH:MM (ET) for sessionDate → absolute ISO in UTC. */
function etClockToIso(sessionDate: string, hhmm: string): string {
  // Build an ISO-local string in America/New_York then re-interpret.
  // We approximate by constructing a Date from the UTC-stamped string and
  // then comparing ET. Simpler approach: compute the UTC-offset for that
  // date with Intl, then subtract.
  const [hh, mm] = hhmm.split(':').map((s) => parseInt(s, 10));
  // Start with noon UTC to anchor the date regardless of DST edge.
  const probe = new Date(`${sessionDate}T12:00:00Z`);
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(probe);
  const etHour = parseInt(etParts.find((p) => p.type === 'hour')?.value ?? '0', 10);
  // offset (in hours) between UTC and ET at this instant.
  const offsetHours = 12 - etHour; // e.g. EDT -> 4, EST -> 5
  const targetUtcHour = hh + offsetHours;
  const d = new Date(`${sessionDate}T00:00:00Z`);
  d.setUTCHours(targetUtcHour, mm, 0, 0);
  return d.toISOString();
}

/** "T+Xh Ym since open" where open = 13:30 UTC (market open in EDT/EST land). */
function formatRelToOpen(virtualNowIso: string, sessionDate: string): string {
  const openIso = etClockToIso(sessionDate, '09:30'); // 09:30 ET = market open
  const diffMs = new Date(virtualNowIso).getTime() - new Date(openIso).getTime();
  const sign = diffMs < 0 ? '-' : '+';
  const abs = Math.abs(diffMs);
  const h = Math.floor(abs / 3_600_000);
  const m = Math.floor((abs % 3_600_000) / 60_000);
  return `T${sign}${h}h ${m}m since open`;
}

function formatAgo(ageMs: number): string {
  if (ageMs < 60_000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`;
  const h = Math.floor(ageMs / 3_600_000);
  const m = Math.round((ageMs % 3_600_000) / 60_000);
  return `${h}h ${m}m ago`;
}

const BOOKMARKS: Array<{ label: string; time: string }> = [
  { label: 'Open', time: '09:30' },
  { label: '10:30', time: '10:30' },
  { label: 'Midday', time: '12:30' },
  { label: '14:30', time: '14:30' },
  { label: '3pm', time: '15:00' },
  { label: 'Close', time: '16:00' },
];

/** Play rate: 1 real second advances virtualNow by 1 session minute (60x). */
const PLAY_STEP_MS = 60 * 1000;
const PLAY_TICK_MS = 1000;

export default function SessionTimeline() {
  const today = new Date().toISOString().slice(0, 10);
  // Honor ?date=YYYY-MM-DD (used by HistoricalAnalogsCard links on CommandStation).
  // Invalid / missing values fall back to today. Updates propagate so the date
  // picker remains the source of truth after the user changes it.
  const [searchParams] = useSearchParams();
  const initialDate = useMemo(() => {
    const q = searchParams.get('date');
    return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : today;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [sessionDate, setSessionDate] = useState(initialDate);
  const [ticker, setTicker] = useState<string>('all');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [focused, setFocused] = useState<number>(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { data: events = [], isLoading } = useSessionTimeline({
    sessionDate,
    ticker: ticker === 'all' ? undefined : ticker,
  });

  const { data: todayBook } = useTodayBook();
  const { data: bookHistory } = useBookHistory(60);

  // Pick the book row matching sessionDate.
  const sessionBook = useMemo(() => {
    if (sessionDate === today && todayBook) return todayBook;
    return (bookHistory ?? []).find((b) => b.session_date === sessionDate) ?? null;
  }, [sessionDate, today, todayBook, bookHistory]);

  const groups = useMemo(() => groupByHour(events), [events]);
  const flatIds = useMemo(() => events.map((e) => e.id), [events]);

  // --- Scrubber state ---
  // Session window: 13:00–21:00 UTC (8 hours, 480 minutes, step=1min).
  const windowStartIso = `${sessionDate}T13:00:00.000Z`;
  const windowEndIso = `${sessionDate}T21:00:00.000Z`;
  const windowStartMs = new Date(windowStartIso).getTime();
  const windowEndMs = new Date(windowEndIso).getTime();
  const totalMinutes = Math.floor((windowEndMs - windowStartMs) / 60_000);

  // null virtualNow means "live / now view" — no scrub.
  const [virtualMinute, setVirtualMinute] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);

  // Reset scrubber when sessionDate changes.
  useEffect(() => {
    setVirtualMinute(null);
    setPlaying(false);
  }, [sessionDate]);

  const virtualNowIso: string | null = useMemo(() => {
    if (virtualMinute === null) return null;
    return new Date(windowStartMs + virtualMinute * 60_000).toISOString();
  }, [virtualMinute, windowStartMs]);

  const isScrubbed = virtualNowIso !== null;

  // --- Play/pause loop ---
  useEffect(() => {
    if (!playing) return;
    const iv = window.setInterval(() => {
      setVirtualMinute((m) => {
        if (m === null) return 0;
        const next = m + 1;
        if (next >= totalMinutes) {
          setPlaying(false);
          return totalMinutes;
        }
        return next;
      });
    }, PLAY_TICK_MS);
    return () => window.clearInterval(iv);
  }, [playing, totalMinutes]);

  const stepMinutes = useCallback(
    (delta: number) => {
      setVirtualMinute((m) => {
        const base = m ?? 0;
        const next = Math.max(0, Math.min(totalMinutes, base + delta));
        return next;
      });
    },
    [totalMinutes],
  );

  const jumpToClock = useCallback(
    (hhmm: string) => {
      const iso = etClockToIso(sessionDate, hhmm);
      const ms = new Date(iso).getTime();
      const minute = Math.max(0, Math.min(totalMinutes, Math.round((ms - windowStartMs) / 60_000)));
      setVirtualMinute(minute);
    },
    [sessionDate, windowStartMs, totalMinutes],
  );

  const returnToNow = useCallback(() => {
    setVirtualMinute(null);
    setPlaying(false);
  }, []);

  // --- Auto-scroll to event nearest virtualNow when scrubbed ---
  const eventRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  useEffect(() => {
    if (!isScrubbed || !virtualNowIso || events.length === 0) return;
    const nowMs = new Date(virtualNowIso).getTime();
    // Find nearest by absolute diff.
    let bestId: string | null = null;
    let bestDiff = Infinity;
    for (const e of events) {
      const tMs = new Date(e.time).getTime();
      const diff = Math.abs(tMs - nowMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestId = e.id;
      }
    }
    if (bestId) {
      const el = eventRefs.current.get(bestId);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }
  }, [virtualNowIso, isScrubbed, events]);

  // --- Snapshot ---
  const snapshot = useSessionSnapshot({
    virtualNow: virtualNowIso,
    events,
    sessionBook: sessionBook ?? null,
  });

  // Counts / grades (unchanged aggregates across full session)
  const counts = useMemo(() => {
    const c: Record<TimelineKind, number> = {
      HEARTBEAT: 0, OBSERVATION: 0, FLAG: 0, ALERT: 0,
      TRADE_COMMIT: 0, TRADE_CLOSE: 0, GRADE: 0,
      SWEEP: 0, DP: 0, REGIME: 0, NEWS: 0,
    };
    for (const e of events) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [events]);

  const gradeDist = useMemo(() => {
    const dist: Record<'right' | 'partial' | 'wrong' | 'other', number> = {
      right: 0, partial: 0, wrong: 0, other: 0,
    };
    for (const e of events) {
      if (e.kind !== 'GRADE') continue;
      const v = ((e.detail as Record<string, unknown>).verdict as string | null)?.toLowerCase();
      if (v === 'right') dist.right++;
      else if (v === 'partial') dist.partial++;
      else if (v === 'wrong') dist.wrong++;
      else dist.other++;
    }
    return dist;
  }, [events]);

  // --- Keyboard nav ---
  // Combined listener on window. When focus is in an Input (date picker, etc.)
  // we skip. Scrubber hotkeys (←/→, Shift-←/→, Space) always work unless the
  // user is typing; event-list hotkeys (↑/↓, Enter) also respect inputs.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocused((f) => Math.min(f + 1, flatIds.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocused((f) => Math.max(f - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const id = flatIds[focused];
        if (id) setExpanded((prev) => (prev === id ? null : id));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        stepMinutes(e.shiftKey ? -15 : -1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        stepMinutes(e.shiftKey ? 15 : 1);
      } else if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        setPlaying((p) => {
          // If never scrubbed, start at 0 so play has somewhere to go.
          if (!p) {
            setVirtualMinute((m) => (m === null ? 0 : m));
          }
          return !p;
        });
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, flatIds, stepMinutes]);

  useEffect(() => {
    if (focused >= flatIds.length) setFocused(Math.max(0, flatIds.length - 1));
  }, [flatIds.length, focused]);

  const focusedId = flatIds[focused];

  // --- Time marker position (as a % across the full 13–21 UTC window) ---
  const markerPct = useMemo(() => {
    if (virtualMinute === null) return null;
    return (virtualMinute / totalMinutes) * 100;
  }, [virtualMinute, totalMinutes]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1400px] mx-auto p-4 space-y-4">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <span className="text-primary">Session Timeline</span>
              <span className="text-sm text-muted-foreground font-normal">review the tape</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every event for the session · 13:00–21:00 UTC · ↑/↓ step events, Enter expands · ←/→ scrub (Shift +15m) · Space plays
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="date"
              value={sessionDate}
              max={today}
              onChange={(e) => { setSessionDate(e.target.value || today); setExpanded(null); setFocused(0); }}
              className="w-[160px]"
            />
            <Select value={ticker} onValueChange={(v) => { setTicker(v); setExpanded(null); setFocused(0); }}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TICKER_CHOICES.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={() => { setSessionDate(today); setExpanded(null); setFocused(0); }}>
              Today
            </Button>
            {/* Export the filtered session's events. Nested `detail` /
                `triggered_by` get JSON.stringify'd in the CSV cell; the
                JSON export keeps them structured. Filename encodes the
                session date so re-exports don't overwrite. */}
            <DataExportButton
              data={events as unknown as Record<string, unknown>[]}
              filename={`session-${sessionDate}${ticker !== 'all' ? `-${ticker}` : ''}`}
              label="Export"
            />
          </div>
        </header>

        {/* Stats bar */}
        <div className="grid grid-cols-2 md:grid-cols-6 gap-2 text-xs">
          {(['OBSERVATION', 'FLAG', 'ALERT', 'TRADE_COMMIT', 'TRADE_CLOSE', 'GRADE', 'SWEEP', 'DP', 'REGIME', 'NEWS', 'HEARTBEAT'] as TimelineKind[]).map((k) => (
            <div key={k} className="rounded border border-border/50 px-2 py-1.5 flex items-center justify-between">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${KIND_BADGE[k]}`}>{KIND_LABEL[k]}</span>
              <span className="tabular-nums font-semibold">{counts[k]}</span>
            </div>
          ))}
          <div className="rounded border border-border/50 px-2 py-1.5 flex items-center justify-between">
            <span className="text-muted-foreground">P&amp;L</span>
            <span className={`tabular-nums font-semibold ${sessionBook?.realized_pnl_pct != null ? (sessionBook.realized_pnl_pct >= 0 ? 'text-green-400' : 'text-red-400') : 'text-muted-foreground'}`}>
              {sessionBook?.realized_pnl_pct != null
                ? `${sessionBook.realized_pnl_pct >= 0 ? '+' : ''}${sessionBook.realized_pnl_pct.toFixed(2)}%`
                : '—'}
            </span>
          </div>
          <div className="rounded border border-border/50 px-2 py-1.5 flex items-center gap-2 text-[11px] col-span-2 md:col-span-2">
            <span className="text-green-400 font-semibold">R:{gradeDist.right}</span>
            <span className="text-amber-300 font-semibold">P:{gradeDist.partial}</span>
            <span className="text-red-400 font-semibold">W:{gradeDist.wrong}</span>
            {gradeDist.other > 0 && <span className="text-muted-foreground">?:{gradeDist.other}</span>}
            <span className="text-muted-foreground ml-auto">total {events.length}</span>
          </div>
        </div>

        {/* Scrubber */}
        <div className="rounded border border-border/50 p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              {BOOKMARKS.map((b) => (
                <Button
                  key={b.label}
                  size="sm"
                  variant="secondary"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => jumpToClock(b.time)}
                >
                  {b.label}
                </Button>
              ))}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <Button
                size="sm"
                variant={playing ? 'default' : 'outline'}
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  setPlaying((p) => {
                    if (!p && virtualMinute === null) setVirtualMinute(0);
                    return !p;
                  });
                }}
              >
                {playing ? 'Pause' : 'Play'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={returnToNow}
                disabled={!isScrubbed}
              >
                Return to now
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="tabular-nums text-[11px] text-muted-foreground w-[60px]">13:00 UTC</span>
            <input
              type="range"
              min={0}
              max={totalMinutes}
              step={1}
              value={virtualMinute ?? totalMinutes}
              onChange={(e) => setVirtualMinute(parseInt(e.target.value, 10))}
              className="flex-1 accent-red-500"
            />
            <span className="tabular-nums text-[11px] text-muted-foreground w-[60px] text-right">21:00 UTC</span>
          </div>
          <div className="flex items-center justify-between text-[11px]">
            {isScrubbed && virtualNowIso ? (
              <>
                <span className="font-semibold text-red-400">
                  State at {formatEtShort(virtualNowIso)} ET
                </span>
                <span className="text-muted-foreground">
                  [{formatRelToOpen(virtualNowIso, sessionDate)}]
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Live / full-session view · drag slider or hit a bookmark to time-travel</span>
            )}
          </div>
        </div>

        {/* Two-column body: snapshot (when scrubbed) + timeline */}
        <div className={`grid gap-4 ${isScrubbed ? 'md:grid-cols-[1fr_360px]' : 'grid-cols-1'}`}>
          {/* Timeline body */}
          <div ref={listRef} className="relative rounded border border-border/50">
            {/* Red time marker */}
            {markerPct !== null && (
              <div
                className="pointer-events-none absolute left-0 right-0 z-20 border-t-2 border-red-500/80"
                style={{ top: `${markerPct}%` }}
              >
                <span className="absolute -top-5 left-2 px-1.5 py-0.5 rounded bg-red-500/90 text-white text-[10px] font-bold tabular-nums shadow">
                  {virtualNowIso ? formatEtShort(virtualNowIso) : ''} ET · {virtualNowIso ? formatRelToOpen(virtualNowIso, sessionDate) : ''}
                </span>
              </div>
            )}
            {isLoading && (
              <div className="py-12 text-center text-sm text-muted-foreground">loading session…</div>
            )}
            {!isLoading && events.length === 0 && (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No events recorded for this date.
              </div>
            )}
            {!isLoading && groups.map((grp) => (
              <div key={grp.hour}>
                <div className="sticky top-0 z-10 bg-background/95 backdrop-blur px-3 py-1.5 border-y border-border/50 text-xs font-bold tracking-wide">
                  {grp.hour} ET <span className="text-muted-foreground font-normal">({grp.events.length} events)</span>
                </div>
                {grp.events.map((e) => {
                  const isExpanded = expanded === e.id;
                  const isFocused = e.id === focusedId;
                  const isFuture = isScrubbed && virtualNowIso ? e.time > virtualNowIso : false;
                  return (
                    <div
                      key={e.id}
                      ref={(el) => {
                        if (el) eventRefs.current.set(e.id, el);
                        else eventRefs.current.delete(e.id);
                      }}
                      onClick={() => { setExpanded((prev) => (prev === e.id ? null : e.id)); setFocused(flatIds.indexOf(e.id)); }}
                      className={`border-l-4 cursor-pointer transition-opacity transition-colors px-3 py-1.5 text-xs ${e.color_class} ${isFocused ? 'ring-1 ring-primary/60' : ''} ${isFuture ? 'opacity-30 grayscale' : ''} hover:brightness-125`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="tabular-nums text-muted-foreground w-[70px] shrink-0">{formatEt(e.time)}</span>
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${KIND_BADGE[e.kind]}`}>
                          {KIND_LABEL[e.kind]}
                        </span>
                        {e.triggered_by?.source && (
                          <span
                            className="shrink-0 inline-flex items-center"
                            title={`event-driven: ${e.triggered_by.source}${e.triggered_by.priority ? '/' + e.triggered_by.priority : ''}${e.triggered_by.reason ? ' — ' + e.triggered_by.reason : ''}`}
                            aria-label={`event-driven: ${e.triggered_by.source}`}
                          >
                            <Zap
                              className={`w-3 h-3 ${
                                e.triggered_by.priority === 'urgent' ? 'text-red-400' : 'text-amber-300'
                              }`}
                            />
                          </span>
                        )}
                        <span className="font-semibold text-[11px] shrink-0 min-w-[60px]">{e.subject}</span>
                        {e.attention_score != null && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-primary/20 text-primary shrink-0">
                            {e.attention_score}
                          </span>
                        )}
                        <span className="truncate text-foreground/90">{e.summary}</span>
                      </div>
                      {isExpanded && (
                        <pre className="mt-2 p-2 rounded bg-black/40 text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap break-words">
                          {JSON.stringify(e.detail, null, 2)}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Snapshot pane (only when scrubbed) */}
          {isScrubbed && snapshot && (
            <aside className="rounded border border-red-500/40 bg-red-500/5 p-3 space-y-3 text-xs self-start sticky top-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold tracking-wide text-red-300">
                  STATE AT {virtualNowIso ? formatEtShort(virtualNowIso) : ''} ET
                </span>
                <span className="text-[10px] text-muted-foreground">
                  {virtualNowIso ? formatRelToOpen(virtualNowIso, sessionDate) : ''}
                </span>
              </div>

              {/* Claude's read */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Claude's read</div>
                {snapshot.claude_read ? (
                  <div className="rounded bg-background/60 p-2">
                    <div className="text-foreground/90">{snapshot.claude_read.status_line}</div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {formatAgo(snapshot.claude_read.age_ms)} · {formatEtShort(snapshot.claude_read.created_at)} ET
                    </div>
                  </div>
                ) : (
                  <div className="text-muted-foreground">no data</div>
                )}
              </div>

              {/* Last observation */}
              {snapshot.last_observation && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">Last observation</div>
                  <div className="rounded bg-background/60 p-2">
                    <div className="text-foreground/90 italic">"{snapshot.last_observation.text}"</div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {formatAgo(snapshot.last_observation.age_ms)} Claude wrote this
                    </div>
                  </div>
                </div>
              )}

              {/* Open trades */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  Open trades ({snapshot.counts.open_trades})
                </div>
                {snapshot.open_trades_at_time.length === 0 ? (
                  <div className="text-muted-foreground">—</div>
                ) : (
                  <ul className="space-y-1">
                    {snapshot.open_trades_at_time.map((t) => (
                      <li key={t.id} className="rounded bg-background/60 p-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{t.side?.toUpperCase()} {t.instrument}</span>
                          <span className="text-muted-foreground">@ {t.entry_price ?? '?'}</span>
                          {t.conviction != null && (
                            <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-primary/20 text-primary">
                              {t.conviction}
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          opened {formatAgo(t.age_ms)}
                        </div>
                        {t.thesis && (
                          <div className="text-[10px] text-foreground/80 mt-1 line-clamp-2">{t.thesis}</div>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Active alerts */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  Active alerts ({snapshot.counts.active_alerts})
                </div>
                {snapshot.active_alerts.length === 0 ? (
                  <div className="text-muted-foreground">—</div>
                ) : (
                  <ul className="space-y-1">
                    {snapshot.active_alerts.map((a) => (
                      <li key={a.id} className="rounded bg-background/60 p-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{a.instruments.join('+')}</span>
                          {a.direction && <span className="text-muted-foreground">{a.direction}</span>}
                          {a.conviction != null && (
                            <span className="ml-auto px-1.5 py-0.5 rounded text-[10px] bg-red-500/20 text-red-300">
                              {a.conviction}
                            </span>
                          )}
                        </div>
                        {a.glance && (
                          <div className="text-[10px] text-foreground/80 mt-0.5 line-clamp-2">{a.glance}</div>
                        )}
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          emitted {formatAgo(a.age_ms)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Combo verdicts */}
              {snapshot.combo_verdicts.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                    Combo verdicts (±30m)
                  </div>
                  <ul className="space-y-1">
                    {snapshot.combo_verdicts.slice(0, 3).map((c) => (
                      <li key={c.id} className="rounded bg-background/60 p-2 text-[10px]">
                        <div className="font-semibold">{c.source.toUpperCase()} · {formatAgo(c.age_ms)}</div>
                        <pre className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
                          {JSON.stringify(c.combo, null, 2).slice(0, 300)}
                        </pre>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Book equity */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  Book equity (approx)
                </div>
                {snapshot.book_equity_at_time != null ? (
                  <div className="rounded bg-background/60 p-2 flex items-center justify-between">
                    <span className="tabular-nums font-semibold">${snapshot.book_equity_at_time.toFixed(2)}</span>
                    <span className={`text-[10px] tabular-nums ${snapshot.book_realized_at_time >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                      realized {snapshot.book_realized_at_time >= 0 ? '+' : ''}${snapshot.book_realized_at_time.toFixed(2)}
                    </span>
                  </div>
                ) : (
                  <div className="text-muted-foreground">—</div>
                )}
              </div>

              {/* Biases (empty by default — wire up when bias source is available) */}
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                  Active biases ({snapshot.counts.active_biases})
                </div>
                {snapshot.active_biases.length === 0 ? (
                  <div className="text-muted-foreground">—</div>
                ) : (
                  <ul className="space-y-0.5">
                    {snapshot.active_biases.map((b) => (
                      <li key={b.id} className="text-foreground/80">{b.label}</li>
                    ))}
                  </ul>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
  );
}
