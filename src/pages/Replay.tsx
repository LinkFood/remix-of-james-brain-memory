/**
 * Replay — Historical replay harness for Co-Trader.
 *
 * v2: results persist to `ct_replay_runs` and survive the 150s edge function
 * timeout. The UI fires ct-replay, gets a run_id back, then polls the run row
 * every 2s — rendering the diff table from checkpoint'd data as it grows.
 *
 * Two modes:
 *   - Single run (12 ticks, ~45s) — fire once, poll to completion.
 *   - Chunked 40-tick session — fire chunk 0, wait for completion, fire chunk
 *     1 with parent_run_id = chunk0.id, etc. Merges results client-side.
 *
 * History panel: last 10 ct_replay_runs (all users; table is auth-readable).
 * Click a past run to reload its merged data into the view.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loader2, Play, TrendingUp, TrendingDown, Zap, History, AlertTriangle } from 'lucide-react';

// Chunked-mode config. 40-tick session split into 3 chunks of ~14 each.
const CHUNKED_TOTAL_TICKS = 40;
const CHUNKED_COUNT = 3;
const CHUNKED_TICKS_PER = Math.ceil(CHUNKED_TOTAL_TICKS / CHUNKED_COUNT); // 14
const SINGLE_TICKS = 12;
const POLL_MS = 2000;

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

export default function Replay() {
  const [sessionDate, setSessionDate] = useState<string>(todayIsoDate());
  const [error, setError] = useState<string | null>(null);

  // Chunks of the CURRENT run the user fired (empty = nothing running or viewed).
  // For single-run mode: one entry. For chunked: up to CHUNKED_COUNT.
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [firing, setFiring] = useState<null | 'single' | 'chunked'>(null);
  // Loaded-from-history view: if user clicks a past run, we set these rows.
  const [viewingHistory, setViewingHistory] = useState(false);

  // History panel
  const [history, setHistory] = useState<RunRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Keep a ref that latest runs array so polling can read without re-subscribing.
  const runsRef = useRef<RunRow[]>([]);
  runsRef.current = runs;

  // -------------------- History loader --------------------
  async function loadHistory() {
    setHistoryLoading(true);
    // Parent runs only — chunk children are reached via the parent's id. A run
    // is a "parent" if parent_run_id is null (single runs AND chunk 0 of a
    // chunked run both qualify).
    const { data, error: qErr } = await supabase
      .from('ct_replay_runs')
      .select('*')
      .is('parent_run_id', null)
      .order('started_at', { ascending: false })
      .limit(10);
    if (qErr) {
      setError(`history load failed: ${qErr.message}`);
    } else {
      setHistory((data ?? []) as RunRow[]);
    }
    setHistoryLoading(false);
  }

  useEffect(() => { loadHistory(); }, []);

  // -------------------- Poll active runs --------------------
  useEffect(() => {
    // Only poll if there's at least one run in 'running' state.
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
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [runs]);

  // -------------------- Detect timeout for stale 'running' rows --------------------
  // If a row has been 'running' for > 170s (edge timeout + grace), mark local
  // view as timeout so the user knows the loop never returned. Persisted rows
  // will still read as 'running' in the DB; this is a UI-side safety.
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

  // -------------------- Fire next chunk after prior completes --------------------
  // Sequential chunk firing: when the latest chunk completes and we have more
  // to fire, kick off the next one. Only runs in chunked mode.
  useEffect(() => {
    if (firing !== 'chunked') return;
    if (runs.length === 0) return;
    const last = runs[runs.length - 1];
    // Block: only fire next when last chunk is completed AND we haven't fired all.
    if (last.status !== 'completed') return;
    if (runs.length >= CHUNKED_COUNT) {
      // All chunks done — exit chunked firing mode.
      setFiring(null);
      // Refresh history so the new run shows up.
      loadHistory();
      return;
    }
    const parentId = runs[0].id; // chunk 0 is the parent
    const nextIndex = runs.length; // 0-indexed: if we have [chunk0], nextIndex=1
    fireChunk(nextIndex, parentId);
    // Intentionally only depend on runs — we want to react to chunk completions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, firing]);

  // -------------------- Firing helpers --------------------
  async function fireChunk(chunkIndex: number, parentRunId: string | null) {
    // Safety: ensure any prior chunk is done before firing (redundant with the
    // server-side guard but makes UI state crystal clear).
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
          max_ticks: CHUNKED_TICKS_PER,
          chunk_index: chunkIndex,
          total_chunks: CHUNKED_COUNT,
          parent_run_id: parentRunId,
        },
      });
      if (invokeErr) throw invokeErr;
      if (data?.error && !data?.run_id) throw new Error(data.error);
      const runId = data?.run_id as string | undefined;
      if (!runId) throw new Error('ct-replay returned no run_id');

      // Fetch the row we just created so polling has a baseline.
      const { data: row } = await supabase
        .from('ct_replay_runs').select('*').eq('id', runId).single();
      if (row) setRuns(prev => [...prev, row as RunRow]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFiring(null);
    }
  }

  async function runSingle() {
    setError(null);
    setRuns([]);
    setViewingHistory(false);
    setFiring('single');
    await fireChunk(0, null);
    setFiring(null);
    // History refresh happens once the row completes via the polling effect.
    // We also kick one off immediately so it lands in the list.
    setTimeout(() => loadHistory(), 1500);
  }

  async function runChunked() {
    setError(null);
    setRuns([]);
    setViewingHistory(false);
    setFiring('chunked');
    await fireChunk(0, null); // chunk 0 is the parent
    // Subsequent chunks fire via the effect watching `runs`.
  }

  async function loadPastRun(parentRun: RunRow) {
    setError(null);
    setViewingHistory(true);
    setFiring(null);

    // If it's chunked, fetch its children too.
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
  }

  // -------------------- Merge chunks for display --------------------
  // Merged view over all chunks in `runs`: concatenated per_tick, summed
  // counts, concatenated trade decisions, summed cost. The chunked 40-tick
  // button produces up to 3 chunks we stitch together here.
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

    // actual_counts are per-session (same across chunks) — take the first
    // chunk's values, don't sum. Same session = same actual writes.
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

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold">Replay Harness</h1>
        <p className="text-sm text-zinc-400">
          Re-run the watcher's decision logic against a captured session. Validates
          cooldown + alert-book-commit guards against the raw tape without touching
          live markets. Claude is non-deterministic — read the numbers as a distribution.
        </p>
      </header>

      {/* Controls */}
      <Card className="p-4 flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-zinc-400">Session Date (UTC)</label>
          <Input
            type="date"
            value={sessionDate}
            max={todayIsoDate()}
            onChange={(e) => setSessionDate(e.target.value)}
            className="max-w-xs"
            disabled={disableFire}
          />
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <Button onClick={runSingle} disabled={disableFire || !sessionDate} className="gap-2">
            {firing === 'single'
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Play className="w-4 h-4" />}
            {firing === 'single' ? 'Replaying…' : `Run (${SINGLE_TICKS} ticks)`}
          </Button>
          <Button
            onClick={runChunked}
            disabled={disableFire || !sessionDate}
            variant="secondary"
            className="gap-2"
            title={`Fires ${CHUNKED_COUNT} chunks of ${CHUNKED_TICKS_PER} ticks sequentially`}
          >
            {firing === 'chunked'
              ? <Loader2 className="w-4 h-4 animate-spin" />
              : <Zap className="w-4 h-4" />}
            {firing === 'chunked' ? 'Running chunks…' : `Full session (${CHUNKED_TOTAL_TICKS} ticks, chunked)`}
          </Button>
        </div>
      </Card>

      {error && (
        <Card className="p-4 border-red-500/30 bg-red-500/10">
          <p className="text-sm text-red-400 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            {error}
          </p>
        </Card>
      )}

      {/* Progress bar for multi-chunk runs */}
      {merged && merged.sorted_runs.length > 0 && (
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-zinc-300">
                {viewingHistory ? 'History:' : 'Run:'} {merged.sorted_runs[0].session_date}
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
        </Card>
      )}

      {/* Summary side-by-side */}
      {merged && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-300">Actual ({merged.sorted_runs[0].session_date})</h2>
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
        <div className="text-xs text-zinc-500 flex gap-4 flex-wrap">
          <span>Model: claude-haiku-4-5</span>
          <span>Tokens in: {merged.tokens.input.toLocaleString()}</span>
          <span>Tokens out: {merged.tokens.output.toLocaleString()}</span>
          <span>Cost: ${merged.cost_usd.toFixed(4)}</span>
          <span>Duration: {(merged.duration_ms / 1000).toFixed(1)}s</span>
        </div>
      )}

      {/* Trades that would have opened */}
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

      {/* Per-tick diff — renders progressively from checkpoint'd data */}
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

      {/* History */}
      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-300 flex items-center gap-2">
            <History className="w-4 h-4" />
            Recent Replays
            <span className="text-xs text-zinc-500">(last 10)</span>
          </h2>
          <Button size="sm" variant="ghost" onClick={loadHistory} disabled={historyLoading}>
            {historyLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Refresh'}
          </Button>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-zinc-500">No past runs yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-zinc-500 text-left border-b border-zinc-800">
                <tr>
                  <th className="p-2">Started</th>
                  <th className="p-2">Session</th>
                  <th className="p-2">Chunks</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Ticks</th>
                  <th className="p-2">Cost</th>
                  <th className="p-2">Trigger</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {history.map(h => (
                  <tr key={h.id} className="hover:bg-zinc-900/50">
                    <td className="p-2 font-mono text-zinc-400">{fmtShortDate(h.started_at)}</td>
                    <td className="p-2 font-mono">{h.session_date}</td>
                    <td className="p-2 text-zinc-400">{h.total_chunks > 1 ? `${h.total_chunks} chunks` : 'single'}</td>
                    <td className="p-2">
                      <Badge variant="outline" className={statusBadgeClass(h.status)}>
                        {h.status}
                      </Badge>
                    </td>
                    <td className="p-2 font-mono text-zinc-400">
                      {h.ticks_completed ?? 0}/{h.max_ticks * h.total_chunks}
                    </td>
                    <td className="p-2 font-mono text-zinc-400">${Number(h.cost_usd ?? 0).toFixed(4)}</td>
                    <td className="p-2 text-zinc-500">{h.triggered_by ?? '—'}</td>
                    <td className="p-2">
                      <Button size="sm" variant="ghost" onClick={() => loadPastRun(h)}>
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

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
