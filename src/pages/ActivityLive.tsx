/**
 * ActivityLive — unified live feed for every Co-Trader event source.
 *
 * Polls 15 tables every 10s (see useActivityLive) and renders the merged
 * stream as compact rows newest-first. Filters: kind / ticker / min
 * attention / heartbeat toggle. Auto-pause while the mouse is over the
 * feed so a row you're reading doesn't scroll away.
 *
 * Click a row → jump to the best source-specific view. Hover → expand
 * raw metadata. Status bar shows rate + polling pulse.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  useActivityLive,
  type ActivityEvent,
  type ActivityKind,
  ACTIVITY_KIND_OPTIONS,
  ACTIVITY_KIND_BADGE,
} from '@/hooks/useActivityLive';

const TICKER_CHOICES = ['all', 'SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'TSLA', 'GLD', 'USO', 'SPX'];

function formatEtTime(iso: string): string {
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

/** yyyy-mm-dd in ET for ?date= deep-links. */
function etDateFor(iso: string): string {
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const y = parts.find((p) => p.type === 'year')?.value ?? '';
    const m = parts.find((p) => p.type === 'month')?.value ?? '';
    const day = parts.find((p) => p.type === 'day')?.value ?? '';
    return `${y}-${m}-${day}`;
  } catch {
    return iso.slice(0, 10);
  }
}

/** Best-effort jump-to-source for a given event. */
function deepLinkFor(e: ActivityEvent): string {
  const date = etDateFor(e.time);
  switch (e.kind) {
    case 'trade':
    case 'trade_action':
    case 'advisory':
      return `/book?date=${date}`;
    case 'grade':
      return `/scorecard?date=${date}`;
    case 'error':
      return '/health';
    case 'chat':
      return '/jac';
    case 'event_trigger':
    case 'curiosity':
      return `/session?date=${date}`;
    default:
      // alert / flag / obs / heartbeat / sweep / dp / regime / iv_shift / news
      // all live best inside SessionTimeline for that date.
      return `/session?date=${date}`;
  }
}

export default function ActivityLive() {
  const navigate = useNavigate();

  const [kind, setKind] = useState<ActivityKind | 'all'>('all');
  const [ticker, setTicker] = useState<string>('all');
  const [minAttention, setMinAttention] = useState<number>(0);
  const [includeHeartbeats, setIncludeHeartbeats] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  const { data, isLoading, isFetching, refetch, dataUpdatedAt } = useActivityLive({
    enabled: !paused,
    filters: { kind, ticker, minAttention, includeHeartbeats },
    lookbackHours: 2,
    perTableLimit: 50,
    maxRows: 200,
  });

  const all = data?.all ?? [];
  const filtered = data?.filtered ?? [];

  // Events per minute, computed over the filtered set.
  const rate = useMemo(() => {
    if (filtered.length < 2) return 0;
    const newest = new Date(filtered[0].time).getTime();
    const oldest = new Date(filtered[filtered.length - 1].time).getTime();
    const spanMin = Math.max(1, (newest - oldest) / 60_000);
    return filtered.length / spanMin;
  }, [filtered]);

  // Tick for "age since last fetch" display (re-renders once per second).
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(iv);
  }, []);
  const ageMs = dataUpdatedAt ? Date.now() - dataUpdatedAt : 0;
  const ageLabel = ageMs < 1000 ? 'just now' : `${Math.floor(ageMs / 1000)}s ago`;

  return (
    <div
      className="min-h-screen bg-background text-foreground"
      // Auto-pause on hover — react-query is disabled when `paused=true`,
      // so the `filtered` array stops churning while the user reads.
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="max-w-[1400px] mx-auto p-4 space-y-3">
        {/* Header */}
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <span className="text-primary">Activity · Live</span>
              <span className="text-sm text-muted-foreground font-normal">every event, right now</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              15 source tables · last 2h · polls every 10s · hover pauses · click to jump to source
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`w-2 h-2 rounded-full ${
                paused
                  ? 'bg-amber-400'
                  : isFetching
                    ? 'bg-green-400 animate-pulse'
                    : 'bg-green-500'
              }`}
              title={paused ? 'paused (mouse over feed)' : 'live'}
            />
            <span className="text-muted-foreground">
              {paused ? 'paused' : isFetching ? 'updating…' : 'live'} · {ageLabel}
            </span>
            <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => refetch()}>
              Refetch
            </Button>
          </div>
        </header>

        {/* Sticky filter bar */}
        <div className="sticky top-0 z-30 bg-background/95 backdrop-blur border border-border/50 rounded p-2 flex flex-wrap items-center gap-2">
          <Select value={kind} onValueChange={(v) => setKind(v as ActivityKind | 'all')}>
            <SelectTrigger className="w-[160px] h-8">
              <SelectValue placeholder="kind" />
            </SelectTrigger>
            <SelectContent>
              {ACTIVITY_KIND_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={ticker} onValueChange={setTicker}>
            <SelectTrigger className="w-[120px] h-8">
              <SelectValue placeholder="ticker" />
            </SelectTrigger>
            <SelectContent>
              {TICKER_CHOICES.map((t) => (
                <SelectItem key={t} value={t}>{t}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">min attention</span>
            <Input
              type="number"
              min={0}
              max={100}
              step={1}
              value={minAttention}
              onChange={(e) => setMinAttention(Math.max(0, Number(e.target.value) || 0))}
              className="w-[70px] h-8 text-xs"
            />
          </div>

          <label className="flex items-center gap-1.5 text-xs cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeHeartbeats}
              onChange={(e) => setIncludeHeartbeats(e.target.checked)}
              className="accent-primary"
            />
            <span className="text-muted-foreground">heartbeats</span>
          </label>

          <Button
            size="sm"
            variant="ghost"
            className="h-8 px-2 text-[11px] ml-auto"
            onClick={() => { setKind('all'); setTicker('all'); setMinAttention(0); setIncludeHeartbeats(false); }}
          >
            Clear
          </Button>
        </div>

        {/* Status line */}
        <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1">
          <span>
            Showing <span className="text-foreground font-semibold">{filtered.length}</span> of{' '}
            <span className="text-foreground font-semibold">{all.length}</span> events from last 2h
          </span>
          <span>
            {filtered.length} matching filters
          </span>
          <span>
            {rate.toFixed(1)} events/min
          </span>
        </div>

        {/* Feed */}
        <div className="rounded border border-border/50 divide-y divide-border/40">
          {isLoading && (
            <div className="py-12 text-center text-sm text-muted-foreground">loading live feed…</div>
          )}
          {!isLoading && filtered.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No events match these filters in the last 2h.
            </div>
          )}
          {!isLoading && filtered.map((e) => {
            const isExpanded = expanded === e.id;
            return (
              <div
                key={e.id}
                onClick={(ev) => {
                  // Shift-click toggles expand; plain click navigates to source.
                  if (ev.shiftKey) {
                    setExpanded((prev) => (prev === e.id ? null : e.id));
                  } else {
                    navigate(deepLinkFor(e));
                  }
                }}
                onMouseEnter={() => setExpanded(e.id)}
                onMouseLeave={() => setExpanded((prev) => (prev === e.id ? null : prev))}
                className="px-3 py-1.5 text-xs cursor-pointer hover:bg-muted/30 transition-colors"
                title="click: jump to source · shift-click: toggle pin · hover: preview"
              >
                <div className="flex items-center gap-2">
                  <span className="tabular-nums text-muted-foreground w-[70px] shrink-0">
                    {formatEtTime(e.time)}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold shrink-0 ${ACTIVITY_KIND_BADGE[e.kind]}`}>
                    {e.kind.toUpperCase()}
                  </span>
                  <span className="font-semibold text-[11px] shrink-0 min-w-[60px] truncate max-w-[160px]">
                    {e.subject}
                  </span>
                  {e.attention_score != null && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-primary/20 text-primary shrink-0">
                      {e.attention_score}
                    </span>
                  )}
                  <span className="truncate text-foreground/90 flex-1">{e.summary}</span>
                  <span className="text-[10px] text-muted-foreground/60 shrink-0">
                    {e.source_table}
                  </span>
                </div>
                {isExpanded && (
                  <pre className="mt-2 p-2 rounded bg-black/40 text-[10px] text-muted-foreground overflow-x-auto whitespace-pre-wrap break-words max-h-[240px]">
                    {JSON.stringify(e.metadata, null, 2)}
                  </pre>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
