/**
 * SessionTimeline — chronological review tool for one trading session.
 *
 * Pulls every event emitted during the 13:00–21:00 UTC window of `sessionDate`
 * (heartbeats, observations, flags, alerts, trade commits/closes, grades,
 * sweep/dp clusters, regime inversions, news) onto one scrollable timeline,
 * grouped by hour. This is the "review today" tool — no LLM summary, just
 * the raw chronology.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useTodayBook, useBookHistory } from '@/hooks/useCoTraderData';

const TICKER_CHOICES = ['all', 'SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'TSLA', 'GLD', 'USO', 'SPX'];

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

export default function SessionTimeline() {
  const today = new Date().toISOString().slice(0, 10);
  const [sessionDate, setSessionDate] = useState(today);
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

  // Flattened ordered list for keyboard nav.
  const flatIds = useMemo(() => events.map((e) => e.id), [events]);

  // Count by kind
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

  // Keyboard nav: up/down step, Enter expands
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
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
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused, flatIds]);

  // Clamp focus when event list shrinks (e.g. ticker filter tightens).
  useEffect(() => {
    if (focused >= flatIds.length) setFocused(Math.max(0, flatIds.length - 1));
  }, [flatIds.length, focused]);

  const focusedId = flatIds[focused];

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
              Every event for the session · 13:00–21:00 UTC · use ↑/↓ to step, Enter to expand
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

        {/* Timeline body */}
        <div ref={listRef} className="rounded border border-border/50">
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
                return (
                  <div
                    key={e.id}
                    onClick={() => { setExpanded((prev) => (prev === e.id ? null : e.id)); setFocused(flatIds.indexOf(e.id)); }}
                    className={`border-l-4 cursor-pointer transition-colors px-3 py-1.5 text-xs ${e.color_class} ${isFocused ? 'ring-1 ring-primary/60' : ''} hover:brightness-125`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums text-muted-foreground w-[70px] shrink-0">{formatEt(e.time)}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${KIND_BADGE[e.kind]}`}>
                        {KIND_LABEL[e.kind]}
                      </span>
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
      </div>
    </div>
  );
}
