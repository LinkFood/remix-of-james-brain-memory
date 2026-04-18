/**
 * Replay — Historical replay harness for Co-Trader.
 *
 * v3: 2-column navigator UX. Left sidebar has date picker + last-20 runs list
 * with pagination + prev/next session stepper. Right panel renders the full
 * ct_replay_runs row: status header, progress bar, actual-vs-replay counts,
 * per-tick diff, trade decisions, cost/duration, and fire buttons.
 *
 * URL param: /replay?run=<id> deep-links to a specific run. On load we hydrate
 * from the URL; selecting a run in the UI writes back to the URL so links can
 * be shared/bookmarked.
 *
 * Real-time: when the viewed run is 'running', poll every 2s (preserved from
 * v2). Also refreshes the sidebar list when new runs land.
 *
 * Two fire modes preserved from v2:
 *   - Single run (12 ticks, ~45s).
 *   - Chunked 40-tick session (3 chunks of 14 ticks, fired sequentially).
 * Both ran against the currently selected session_date.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Loader2, Play, TrendingUp, TrendingDown, Zap, AlertTriangle,
  ChevronLeft, ChevronRight, Calendar as CalendarIcon, Clock, RotateCw,
} from 'lucide-react';

// Chunked-mode config. 40-tick session split into 3 chunks of ~14 each.
const CHUNKED_TOTAL_TICKS = 40;
const CHUNKED_COUNT = 3;
const CHUNKED_TICKS_PER = Math.ceil(CHUNKED_TOTAL_TICKS / CHUNKED_COUNT); // 14
const SINGLE_TICKS = 12;
const POLL_MS = 2000;
const SIDEBAR_PAGE_SIZE = 20;

type RunStatus = 'running' | 'completed' | 'timeout' | 'error';

interface AlertCommitDecision {
  alert_ref: string;
  tick_time: string;
  instrument: string;
  direction: 'bullish' | 'bearish' | 'neutral' | 'volatility';
  passed_guards: boolean;
  reason: string;
  entry_level: number | null;
}

interface PerTick {
  tick_time: string;
  heartbeat_id: string;
  actual_state: 'HEARTBEAT' | 'OBSERVATION' | 'FLAG' | 'ALERT';
  actual_event_id: string | null;
  replay_state: 'HEARTBEAT' | 'OBSERVATION' | 'FLAG' | 'ALERT';
  replay_direction: string | null;
  replay_conviction: number | null;
  replay_instruments: string[];
  replay_alert_trigger: string | null;
  replay_demoted_to: 'observation' | 'flag' | null;
  replay_demote_reason: string | null;
  changed: boolean;
  claude_ok: boolean;
  input_tokens: number;
  output_tokens: number;
}

interface RunRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  session_date: string;
  max_ticks: number;
  chunk_index: number;
  total_chunks: number;
  parent_run_id: string | null;
  status: RunStatus;
  dry_run: boolean;
  modules: string[];
  ticks_completed: number;
  actual_counts: { observations: number; flags: number; alerts: number; trades_committed: number } | null;
  replay_counts: { observations: number; flags: number; alerts: number; demoted: number; trades_would_commit: number } | null;
  per_tick: PerTick[] | null;
  trade_decisions: AlertCommitDecision[] | null;
  cost_usd: number | null;
  duration_ms: number | null;
  error_message: string | null;
  triggered_by: string | null;
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function stateBadgeClass(state: string): string {
  switch (state) {
    case 'ALERT': return 'bg-red-500/20 text-red-400 border-red-500/30';
    case 'FLAG': return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    case 'OBSERVATION': return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    default: return 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30';
  }
}

function statusBadgeClass(status: RunStatus | string): string {
  switch (status) {
    case 'completed': return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
    case 'running':   return 'bg-blue-500/20 text-blue-400 border-blue-500/30';
    case 'timeout':   return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    case 'error':     return 'bg-red-500/20 text-red-400 border-red-500/30';
    default:          return 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30';
  }
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
  });
}

function fmtShortDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// Parent-only parent_run_id IS NULL. Chunk 0 of a chunked run qualifies too.
function selectParentRuns() {
  return supabase
    .from('ct_replay_runs')
    .select('*')
    .is('parent_run_id', null)
    .order('started_at', { ascending: false });
}

export default function Replay() {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlRunId = searchParams.get('run');

  const [sessionDate, setSessionDate] = useState<string>(todayIsoDate());
  const [error, setError] = useState<string | null>(null);

  // The set of chunks we are currently displaying. For single runs: one entry.
  // For chunked or loaded-from-history: the parent + children sorted by chunk_index.
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [firing, setFiring] = useState<null | 'single' | 'chunked'>(null);
  const [sidebarLimit, setSidebarLimit] = useState(SIDEBAR_PAGE_SIZE);

  const runsRef = useRef<RunRow[]>([]);
  runsRef.current = runs;

  const queryClient = useQueryClient();

  // -------------------- History (sidebar) via React Query --------------------
  const {
    data: historyData,
    isLoading: historyLoading,
    refetch: refetchHistory,
  } = useQuery({
    queryKey: ['ct_replay_runs_history', sidebarLimit],
    queryFn: async () => {
      const { data, error: qErr } = await selectParentRuns().limit(sidebarLimit);
      if (qErr) throw qErr;
      return (data ?? []) as RunRow[];
    },
    staleTime: 30_000, // don't hammer the DB — stale after 30s, but keep showing while refetching
  });
  const history: RunRow[] = historyData ?? [];

  // Distinct session dates, most-recent-first. Used by prev/next navigator so
  // we ONLY step to dates that actually have runs (skips gaps like weekends).
  const {
    data: allSessionDates,
  } = useQuery({
    queryKey: ['ct_replay_runs_session_dates'],
    queryFn: async () => {
      // Cap at 1000 distinct-session parent runs — plenty for navigation UX.
      // Dedup client-side; server distinct via PostgREST is clunky.
      const { data, error: qErr } = await supabase
        .from('ct_replay_runs')
        .select('session_date')
        .is('parent_run_id', null)
        .order('session_date', { ascending: false })
        .limit(1000);
      if (qErr) throw qErr;
      const seen = new Set<string>();
      const dates: string[] = [];
      for (const row of (data ?? []) as { session_date: string }[]) {
        if (!seen.has(row.session_date)) {
          seen.add(row.session_date);
          dates.push(row.session_date);
        }
      }
      return dates;
    },
    staleTime: 60_000,
  });

  // -------------------- URL param deep-link hydrate --------------------
  // On mount / when ?run= changes externally, load that run + its chunks.
  useEffect(() => {
    if (!urlRunId) return;
    // If we already have this run loaded as a parent, don't re-fetch.
    if (runsRef.current.some(r => r.id === urlRunId && r.parent_run_id === null)) return;
    (async () => {
      const { data: parent, error: qErr } = await supabase
        .from('ct_replay_runs')
        .select('*')
        .eq('id', urlRunId)
        .maybeSingle();
      if (qErr || !parent) {
        setError(qErr?.message ?? `run ${urlRunId} not found`);
        return;
      }
      await hydrateRunView(parent as RunRow);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlRunId]);

  // -------------------- Poll the active viewed run --------------------
  useEffect(() => {
    const hasRunning = runs.some(r => r.status === 'running');
    if (!hasRunning) return;

    const timer = setInterval(async () => {
      const current = runsRef.current;
      const ids = current.filter(r => r.status === 'running').map(r => r.id);
      if (ids.length === 0) return;
      const { data } = await supabase
        .from('ct_replay_runs')
        .select('*')
        .in('id', ids);
      if (!data) return;
      setRuns(prev => prev.map(r => {
        const updated = (data as RunRow[]).find(d => d.id === r.id);
        return updated ?? r;
      }));
      // Also refresh sidebar so ticks_completed updates there too.
      queryClient.invalidateQueries({ queryKey: ['ct_replay_runs_history'] });
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [runs, queryClient]);

  // -------------------- UI-side timeout override --------------------
  const runsWithTimeoutOverride = useMemo(() => {
    const now = Date.now();
    return runs.map(r => {
      if (r.status !== 'running') return r;
      const elapsed = now - new Date(r.started_at).getTime();
      if (elapsed > 170_000) {
        return { ...r, status: 'timeout' as RunStatus, error_message: r.error_message ?? 'edge function 150s timeout — partial results below' };
      }
      return r;
    });
  }, [runs]);

  // -------------------- Sequential chunk firing --------------------
  useEffect(() => {
    if (firing !== 'chunked') return;
    if (runs.length === 0) return;
    const last = runs[runs.length - 1];
    if (last.status !== 'completed') return;
    if (runs.length >= CHUNKED_COUNT) {
      setFiring(null);
      queryClient.invalidateQueries({ queryKey: ['ct_replay_runs_history'] });
      queryClient.invalidateQueries({ queryKey: ['ct_replay_runs_session_dates'] });
      return;
    }
    const parentId = runs[0].id;
    const nextIndex = runs.length;
    fireChunk(nextIndex, parentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, firing]);

  // -------------------- Firing helpers --------------------
  async function fireChunk(chunkIndex: number, parentRunId: string | null) {
    const prior = runsRef.current[runsRef.current.length - 1];
    if (prior && prior.status === 'running') {
      setError(`refusing to fire chunk ${chunkIndex}: prior chunk still running`);
      setFiring(null);
      return;
    }

    try {
      const { data, error: invokeErr } = await supabase.functions.invoke('ct-replay', {
        body: {
          session_date: sessionDate,
          dry_run: true,
          modules: ['watcher_writes', 'cooldown', 'alert_book_commit'],
          max_ticks: chunkIndex === 0 && runsRef.current.length === 0 && firing === 'single' ? SINGLE_TICKS : CHUNKED_TICKS_PER,
          chunk_index: chunkIndex,
          total_chunks: firing === 'chunked' ? CHUNKED_COUNT : 1,
          parent_run_id: parentRunId,
        },
      });
      if (invokeErr) throw invokeErr;
      if (data?.error && !data?.run_id) throw new Error(data.error);
      const runId = data?.run_id as string | undefined;
      if (!runId) throw new Error('ct-replay returned no run_id');

      const { data: row } = await supabase
        .from('ct_replay_runs').select('*').eq('id', runId).single();
      if (row) {
        setRuns(prev => [...prev, row as RunRow]);
        // If this is the parent (chunk 0), deep-link the URL to it immediately.
        if (parentRunId === null) {
          setSearchParams({ run: runId }, { replace: true });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFiring(null);
    }
  }

  async function runSingle() {
    setError(null);
    setRuns([]);
    setFiring('single');
    await fireChunk(0, null);
    setFiring(null);
    // Refresh sidebar + session-dates so the new run shows up.
    setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: ['ct_replay_runs_history'] });
      queryClient.invalidateQueries({ queryKey: ['ct_replay_runs_session_dates'] });
    }, 1500);
  }

  async function runChunked() {
    setError(null);
    setRuns([]);
    setFiring('chunked');
    await fireChunk(0, null);
    // Subsequent chunks fire via the effect watching `runs`.
  }

  // Fire "another run for this same date" — single-mode re-fire against the
  // currently viewed session_date. Used by the right-panel button so the user
  // can stack runs for comparison without navigating.
  async function refireSameDate() {
    if (!runs[0]) return;
    setSessionDate(runs[0].session_date);
    // Next tick — setState isn't synchronous but fireChunk reads sessionDate
    // from closure, so set then kick.
    setError(null);
    setRuns([]);
    setFiring('single');
    // Use a microtask to let setSessionDate apply before fire reads it.
    queueMicrotask(async () => {
      await fireChunk(0, null);
      setFiring(null);
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['ct_replay_runs_history'] });
        queryClient.invalidateQueries({ queryKey: ['ct_replay_runs_session_dates'] });
      }, 1500);
    });
  }

  // -------------------- Load a specific run (sidebar click / prev-next) --------------------
  async function hydrateRunView(parentRun: RunRow) {
    setError(null);
    setFiring(null);

    if (parentRun.total_chunks > 1) {
      const { data: children } = await supabase
        .from('ct_replay_runs')
        .select('*')
        .eq('parent_run_id', parentRun.id)
        .order('chunk_index', { ascending: true });
      const all = [parentRun, ...((children ?? []) as RunRow[])]
        .sort((a, b) => a.chunk_index - b.chunk_index);
      setRuns(all);
    } else {
      setRuns([parentRun]);
    }
    setSessionDate(parentRun.session_date);
    setSearchParams({ run: parentRun.id }, { replace: true });
  }

  // Given a target session_date, load the MOST RECENT parent run for it.
  async function loadMostRecentForDate(date: string) {
    const { data, error: qErr } = await supabase
      .from('ct_replay_runs')
      .select('*')
      .is('parent_run_id', null)
      .eq('session_date', date)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (qErr) {
      setError(qErr.message);
      return false;
    }
    if (!data) return false;
    await hydrateRunView(data as RunRow);
    return true;
  }

  // Date picker handler — try to load existing run; if none, just set date.
  async function onPickDate(date: string) {
    setSessionDate(date);
    if (!date) return;
    const loaded = await loadMostRecentForDate(date);
    if (!loaded) {
      // No run for this date — clear view so the "Run new replay" CTA shows.
      setRuns([]);
      setSearchParams({}, { replace: true });
    }
  }

  // -------------------- Prev/Next navigator --------------------
  // Only steps to dates that HAVE runs (skips gaps). Uses distinct session_dates.
  const currentSessionDate = runs[0]?.session_date ?? sessionDate;
  const navIndex = useMemo(() => {
    if (!allSessionDates) return -1;
    return allSessionDates.indexOf(currentSessionDate);
  }, [allSessionDates, currentSessionDate]);

  // allSessionDates is sorted DESC (most recent first). "Next" = more recent = earlier index.
  // "Previous" = older = later index.
  const hasNewer = navIndex > 0;
  const hasOlder = allSessionDates && navIndex >= 0 && navIndex < allSessionDates.length - 1;

  async function goOlder() {
    if (!allSessionDates || navIndex < 0) return;
    const target = allSessionDates[navIndex + 1];
    if (target) await loadMostRecentForDate(target);
  }
  async function goNewer() {
    if (!allSessionDates || navIndex <= 0) return;
    const target = allSessionDates[navIndex - 1];
    if (target) await loadMostRecentForDate(target);
  }

  // -------------------- Merge chunks for display --------------------
  const merged = useMemo(() => {
    if (runs.length === 0) return null;
    const sorted = [...runsWithTimeoutOverride].sort((a, b) => a.chunk_index - b.chunk_index);

    const per_tick: PerTick[] = [];
    const trade_decisions: AlertCommitDecision[] = [];
    const actual_counts = { observations: 0, flags: 0, alerts: 0, trades_committed: 0 };
    const replay_counts = { observations: 0, flags: 0, alerts: 0, demoted: 0, trades_would_commit: 0 };
    let ticks_completed = 0;
    let ticks_planned = 0;
    let cost_usd = 0;
    let duration_ms = 0;
    const tokens = { input: 0, output: 0 };

    const firstWithActuals = sorted.find(r => r.actual_counts);
    if (firstWithActuals?.actual_counts) {
      Object.assign(actual_counts, firstWithActuals.actual_counts);
    }

    for (const r of sorted) {
      if (r.per_tick) per_tick.push(...r.per_tick);
      if (r.trade_decisions) trade_decisions.push(...r.trade_decisions);
      if (r.replay_counts) {
        replay_counts.observations += r.replay_counts.observations ?? 0;
        replay_counts.flags += r.replay_counts.flags ?? 0;
        replay_counts.alerts += r.replay_counts.alerts ?? 0;
        replay_counts.demoted += r.replay_counts.demoted ?? 0;
        replay_counts.trades_would_commit += r.replay_counts.trades_would_commit ?? 0;
      }
      ticks_completed += r.ticks_completed ?? 0;
      ticks_planned += r.max_ticks ?? 0;
      cost_usd += Number(r.cost_usd ?? 0);
      duration_ms += r.duration_ms ?? 0;
      for (const t of r.per_tick ?? []) {
        tokens.input += t.input_tokens ?? 0;
        tokens.output += t.output_tokens ?? 0;
      }
    }

    return {
      sorted_runs: sorted,
      per_tick,
      trade_decisions,
      actual_counts,
      replay_counts,
      ticks_completed,
      ticks_planned,
      cost_usd,
      duration_ms,
      tokens,
    };
  }, [runs, runsWithTimeoutOverride]);

  const overallProgressPct = merged && merged.ticks_planned > 0
    ? Math.min(100, Math.round((merged.ticks_completed / merged.ticks_planned) * 100))
    : 0;

  const anyRunning = runs.some(r => r.status === 'running');
  const disableFire = firing !== null || anyRunning;
  const dateHasRun = !!merged;
  const parentId = runs[0]?.id ?? null;

  return (
    <div className="p-4 md:p-6 max-w-[1600px] mx-auto">
      <header className="mb-4 space-y-1">
        <h1 className="text-2xl font-bold">Replay Harness</h1>
        <p className="text-sm text-zinc-400">
          Re-run the watcher's decision logic against any past session. Persisted to
          ct_replay_runs — every run is browsable. Claude is non-deterministic; read
          the numbers as a distribution.
        </p>
      </header>

      {/* Top-level error banner */}
      {error && (
        <Card className="p-3 mb-4 border-red-500/30 bg-red-500/10">
          <p className="text-sm text-red-400 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            {error}
            <Button size="sm" variant="ghost" className="ml-auto h-6" onClick={() => setError(null)}>
              dismiss
            </Button>
          </p>
        </Card>
      )}

      <div className="flex flex-col lg:flex-row gap-4">
        {/* ================= LEFT SIDEBAR ================= */}
        <aside className="w-full lg:w-[300px] lg:flex-shrink-0 space-y-4">
          {/* Date picker */}
          <Card className="p-3 space-y-2">
            <label className="text-xs text-zinc-400 flex items-center gap-1">
              <CalendarIcon className="w-3 h-3" />
              Session Date
            </label>
            <Input
              type="date"
              value={sessionDate}
              max={todayIsoDate()}
              onChange={(e) => onPickDate(e.target.value)}
              disabled={disableFire}
            />
            {!dateHasRun && sessionDate && (
              <Button
                onClick={runSingle}
                disabled={disableFire}
                size="sm"
                className="w-full gap-2 mt-1"
              >
                {firing === 'single'
                  ? <Loader2 className="w-3 h-3 animate-spin" />
                  : <Play className="w-3 h-3" />}
                Run new replay for {sessionDate}
              </Button>
            )}
          </Card>

          {/* Runs list */}
          <Card className="p-3 space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-zinc-300 uppercase tracking-wide">
                Recent Runs
              </h2>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2"
                onClick={() => refetchHistory()}
                disabled={historyLoading}
              >
                {historyLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCw className="w-3 h-3" />}
              </Button>
            </div>

            {history.length === 0 && !historyLoading && (
              <div className="text-xs text-zinc-500 py-4 text-center space-y-2">
                <p>No replays yet.</p>
                <Button size="sm" onClick={runSingle} disabled={disableFire} className="gap-2">
                  <Play className="w-3 h-3" /> Run your first replay
                </Button>
              </div>
            )}

            <div className="space-y-1 max-h-[60vh] overflow-y-auto -mx-1 px-1">
              {history.map(h => {
                const active = h.id === parentId;
                const totalTicks = h.max_ticks * h.total_chunks;
                return (
                  <button
                    key={h.id}
                    onClick={() => hydrateRunView(h)}
                    className={`w-full text-left rounded border p-2 text-xs transition-colors ${
                      active
                        ? 'border-emerald-500/40 bg-emerald-500/10'
                        : 'border-zinc-800 hover:bg-zinc-900/60 hover:border-zinc-700'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-mono font-semibold">{h.session_date}</span>
                      <Badge variant="outline" className={`${statusBadgeClass(h.status)} text-[10px] px-1.5 py-0`}>
                        {h.status}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between text-zinc-500">
                      <span className="font-mono">{h.ticks_completed ?? 0}/{totalTicks} ticks</span>
                      <span className="font-mono">${Number(h.cost_usd ?? 0).toFixed(3)}</span>
                    </div>
                    <div className="text-[10px] text-zinc-600 mt-0.5 flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5" />
                      {fmtShortDate(h.started_at)}
                      {h.total_chunks > 1 && (
                        <span className="ml-auto">{h.total_chunks}-chunk</span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {history.length >= sidebarLimit && (
              <Button
                size="sm"
                variant="ghost"
                className="w-full text-xs"
                onClick={() => setSidebarLimit(n => n + SIDEBAR_PAGE_SIZE)}
              >
                Load more
              </Button>
            )}
          </Card>
        </aside>

        {/* ================= RIGHT PANEL ================= */}
        <main className="flex-1 min-w-0 space-y-4">
          {/* Prev/Next nav + current date header */}
          <Card className="p-3 flex items-center gap-3 flex-wrap">
            <Button
              size="sm"
              variant="ghost"
              onClick={goOlder}
              disabled={!hasOlder || disableFire}
              className="gap-1 h-8"
              title="Older session with runs"
            >
              <ChevronLeft className="w-4 h-4" /> Older
            </Button>
            <div className="flex-1 min-w-0 text-center">
              <div className="text-[10px] uppercase tracking-wide text-zinc-500">Viewing</div>
              <div className="font-mono font-bold text-zinc-100 text-lg">
                {currentSessionDate || '—'}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={goNewer}
              disabled={!hasNewer || disableFire}
              className="gap-1 h-8"
              title="Newer session with runs"
            >
              Newer <ChevronRight className="w-4 h-4" />
            </Button>
          </Card>

          {/* Empty state (chosen date has no run OR no runs selected yet) */}
          {!merged && (
            <Card className="p-8 text-center space-y-3">
              <p className="text-sm text-zinc-400">
                {history.length === 0
                  ? 'No past runs. Fire one to get started.'
                  : sessionDate
                    ? `No run exists for ${sessionDate}. Fire a new one or pick a date from the sidebar.`
                    : 'Select a run from the sidebar, or pick a date.'}
              </p>
              <div className="flex gap-2 justify-center flex-wrap">
                <Button onClick={runSingle} disabled={disableFire || !sessionDate} className="gap-2">
                  {firing === 'single'
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Play className="w-4 h-4" />}
                  Run single ({SINGLE_TICKS} ticks)
                </Button>
                <Button
                  onClick={runChunked}
                  disabled={disableFire || !sessionDate}
                  variant="secondary"
                  className="gap-2"
                >
                  {firing === 'chunked'
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <Zap className="w-4 h-4" />}
                  Full session ({CHUNKED_TOTAL_TICKS} ticks, chunked)
                </Button>
              </div>
            </Card>
          )}

          {/* Status + progress header */}
          {merged && (
            <Card className="p-4 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2 text-sm flex-wrap">
                  <span className="text-zinc-300 font-mono">
                    {merged.sorted_runs[0].session_date}
                  </span>
                  {merged.sorted_runs.length > 1 && (
                    <Badge variant="outline" className="text-xs">
                      {merged.sorted_runs.length}-chunk
                    </Badge>
                  )}
                  {merged.sorted_runs.map(r => (
                    <Badge key={r.id} variant="outline" className={statusBadgeClass(r.status)}>
                      chunk {r.chunk_index}: {r.status}
                    </Badge>
                  ))}
                </div>
                <div className="text-xs text-zinc-400 font-mono">
                  Tick {merged.ticks_completed} of {merged.ticks_planned} — {overallProgressPct}% complete
                </div>
              </div>
              <div className="h-2 bg-zinc-800 rounded overflow-hidden">
                <div
                  className={`h-full transition-all ${anyRunning ? 'bg-blue-500' : 'bg-emerald-500'}`}
                  style={{ width: `${overallProgressPct}%` }}
                />
              </div>
              {merged.sorted_runs.some(r => r.error_message) && (
                <div className="text-xs text-amber-400 space-y-0.5">
                  {merged.sorted_runs.filter(r => r.error_message).map(r => (
                    <div key={r.id}>Chunk {r.chunk_index}: {r.error_message}</div>
                  ))}
                </div>
              )}

              {/* Fire buttons — re-run same date or fire chunked */}
              <div className="flex gap-2 flex-wrap pt-1">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={refireSameDate}
                  disabled={disableFire}
                  className="gap-2"
                >
                  {firing === 'single'
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Play className="w-3 h-3" />}
                  Fire new replay for this date
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={runChunked}
                  disabled={disableFire}
                  className="gap-2"
                >
                  {firing === 'chunked'
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Zap className="w-3 h-3" />}
                  Fire {CHUNKED_TOTAL_TICKS}-tick chunked run
                </Button>
              </div>
            </Card>
          )}

          {/* Summary side-by-side */}
          {merged && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Card className="p-4 space-y-3">
                <h2 className="text-sm font-semibold text-zinc-300">
                  Actual ({merged.sorted_runs[0].session_date})
                </h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Stat label="Observations" value={merged.actual_counts.observations} />
                  <Stat label="Flags" value={merged.actual_counts.flags} />
                  <Stat label="Alerts" value={merged.actual_counts.alerts} />
                  <Stat label="Trades Committed" value={merged.actual_counts.trades_committed} />
                </div>
              </Card>

              <Card className="p-4 space-y-3 border-emerald-500/20 bg-emerald-500/5">
                <h2 className="text-sm font-semibold text-emerald-400">Replay (new logic)</h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <Stat label="Observations" value={merged.replay_counts.observations} />
                  <Stat label="Flags" value={merged.replay_counts.flags} />
                  <Stat label="Alerts" value={merged.replay_counts.alerts} />
                  <Stat label="Trades Would Open" value={merged.replay_counts.trades_would_commit} highlight />
                  <Stat label="Demoted by Cooldown" value={merged.replay_counts.demoted} />
                  <Stat label="Ticks Replayed" value={`${merged.ticks_completed} / ${merged.ticks_planned}`} />
                </div>
              </Card>
            </div>
          )}

          {/* Cost line */}
          {merged && (
            <div className="text-xs text-zinc-500 flex gap-4 flex-wrap px-1">
              <span>Model: claude-haiku-4-5</span>
              <span>Tokens in: {merged.tokens.input.toLocaleString()}</span>
              <span>Tokens out: {merged.tokens.output.toLocaleString()}</span>
              <span>Cost: ${merged.cost_usd.toFixed(4)}</span>
              <span>Duration: {(merged.duration_ms / 1000).toFixed(1)}s</span>
              {merged.sorted_runs[0].triggered_by && (
                <span>Triggered by: {merged.sorted_runs[0].triggered_by}</span>
              )}
            </div>
          )}

          {/* Trades */}
          {merged && (
            <Card className="p-4 space-y-3">
              <h2 className="text-sm font-semibold text-zinc-300">
                Alert-Book-Commit Decisions
                {merged.trade_decisions.length > 0 && (
                  <span className="ml-2 text-xs text-zinc-500">
                    ({merged.trade_decisions.filter(d => d.passed_guards).length} passed / {merged.trade_decisions.length} scanned)
                  </span>
                )}
              </h2>
              {merged.trade_decisions.length === 0 ? (
                <p className="text-sm text-zinc-500">No replay ALERTs fired — nothing to commit.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-zinc-500 text-left border-b border-zinc-800">
                      <tr>
                        <th className="p-2">Time ET</th>
                        <th className="p-2">Instrument</th>
                        <th className="p-2">Direction</th>
                        <th className="p-2">Pass</th>
                        <th className="p-2">Reason</th>
                        <th className="p-2">Entry</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {merged.trade_decisions.map(d => (
                        <tr key={d.alert_ref} className={d.passed_guards ? 'bg-emerald-500/5' : ''}>
                          <td className="p-2 font-mono">{fmtTime(d.tick_time)}</td>
                          <td className="p-2 font-medium">{d.instrument}</td>
                          <td className="p-2">
                            <span className="inline-flex items-center gap-1">
                              {d.direction === 'bullish' && <TrendingUp className="w-3 h-3 text-emerald-400" />}
                              {d.direction === 'bearish' && <TrendingDown className="w-3 h-3 text-red-400" />}
                              {d.direction}
                            </span>
                          </td>
                          <td className="p-2">
                            {d.passed_guards ? (
                              <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">PASS</Badge>
                            ) : (
                              <Badge variant="outline" className="text-zinc-400 border-zinc-700">skip</Badge>
                            )}
                          </td>
                          <td className="p-2 text-zinc-400 font-mono">{d.reason}</td>
                          <td className="p-2 font-mono text-zinc-400">{d.entry_level ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          )}

          {/* Per-tick diff */}
          {merged && (
            <Card className="p-4 space-y-3">
              <h2 className="text-sm font-semibold text-zinc-300">
                Per-Tick Diff
                <span className="ml-2 text-xs text-zinc-500">
                  ({merged.per_tick.filter(t => t.changed).length} ticks where the decision changed)
                </span>
              </h2>
              <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="text-zinc-500 text-left border-b border-zinc-800 sticky top-0 bg-background">
                    <tr>
                      <th className="p-2">Time ET</th>
                      <th className="p-2">Actual</th>
                      <th className="p-2">Replay</th>
                      <th className="p-2">Direction</th>
                      <th className="p-2">Conv</th>
                      <th className="p-2">Instruments</th>
                      <th className="p-2">Demote</th>
                      <th className="p-2">Changed</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {merged.per_tick.map(t => (
                      <tr key={t.heartbeat_id} className={t.changed ? 'bg-amber-500/5' : ''}>
                        <td className="p-2 font-mono">{fmtTime(t.tick_time)}</td>
                        <td className="p-2">
                          <Badge variant="outline" className={stateBadgeClass(t.actual_state)}>
                            {t.actual_state}
                          </Badge>
                        </td>
                        <td className="p-2">
                          <Badge variant="outline" className={stateBadgeClass(t.replay_state)}>
                            {t.replay_state}
                          </Badge>
                          {!t.claude_ok && <span className="ml-1 text-red-400 text-[10px]">claude-fail</span>}
                        </td>
                        <td className="p-2 text-zinc-400">{t.replay_direction ?? '—'}</td>
                        <td className="p-2 text-zinc-400">{t.replay_conviction ?? '—'}</td>
                        <td className="p-2 font-mono text-zinc-400">
                          {t.replay_instruments.join(', ') || '—'}
                        </td>
                        <td className="p-2 text-zinc-500 font-mono text-[10px]">
                          {t.replay_demote_reason ?? ''}
                        </td>
                        <td className="p-2">
                          {t.changed ? (
                            <span className="text-amber-400">yes</span>
                          ) : (
                            <span className="text-zinc-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          {/* Caveats */}
          {merged && (
            <Card className="p-4 bg-zinc-900/50 border-zinc-800">
              <h3 className="text-xs font-semibold text-zinc-400 mb-2">Caveats</h3>
              <ul className="text-xs text-zinc-500 space-y-1 list-disc list-inside">
                <li>Claude decisions are non-deterministic even at temp 0.2 — treat as distribution, not deterministic recreation.</li>
                <li>Memory bundle is stripped (theses + snapshot only). Full memoryRecall.ts similar-setups + lessons not re-run.</li>
                <li>Alert-book-commit sim uses entry_level as price proxy — no getCurrentPrice() fetch.</li>
                <li>Bias blocks (ct_biases) not replayed in v1.</li>
                <li>Chunked runs re-fetch theses + actual writes per chunk (service role, small cost).</li>
              </ul>
            </Card>
          )}
        </main>
      </div>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-lg font-mono ${highlight ? 'text-emerald-300' : 'text-zinc-200'}`}>{value}</div>
    </div>
  );
}
