/**
 * Replay — Historical replay harness for Co-Trader.
 *
 * Pick a session date, run the current watcher logic (new cooldown + alert-
 * book-commit guards) against the raw UW snapshots captured that day, and
 * see what would have been written vs what actually landed.
 *
 * This is a SIMULATION — Claude is non-deterministic. Read results as a
 * distribution, not a deterministic recreation.
 */

import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loader2, Play, TrendingUp, TrendingDown } from 'lucide-react';

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

interface ReplayResult {
  session_date: string;
  dry_run: boolean;
  ticks_replayed: number;
  max_ticks: number;
  actual_writes: { observations: number; flags: number; alerts: number };
  actual_trades_committed: number;
  replay_writes: { observations: number; flags: number; alerts: number; demoted: number };
  replay_trades_would_commit: number;
  alert_commit_decisions: AlertCommitDecision[];
  per_tick: PerTick[];
  cost: { model: string; input_tokens: number; output_tokens: number; usd: number };
  caveats: string[];
  note?: string;
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

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
  });
}

export default function Replay() {
  const [sessionDate, setSessionDate] = useState<string>(todayIsoDate());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runReplay() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke('ct-replay', {
        body: {
          session_date: sessionDate,
          dry_run: true,
          modules: ['watcher_writes', 'cooldown', 'alert_book_commit'],
        },
      });
      if (invokeErr) throw invokeErr;
      if (data?.error) throw new Error(data.error);
      setResult(data as ReplayResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

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

      <Card className="p-4 flex flex-col sm:flex-row gap-3 sm:items-end">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-zinc-400">Session Date (UTC)</label>
          <Input
            type="date"
            value={sessionDate}
            max={todayIsoDate()}
            onChange={(e) => setSessionDate(e.target.value)}
            className="max-w-xs"
          />
        </div>
        <Button onClick={runReplay} disabled={loading || !sessionDate} className="gap-2">
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          {loading ? 'Replaying…' : 'Run Replay'}
        </Button>
      </Card>

      {error && (
        <Card className="p-4 border-red-500/30 bg-red-500/10">
          <p className="text-sm text-red-400">Error: {error}</p>
        </Card>
      )}

      {result && (
        <>
          {result.note && (
            <Card className="p-4 border-zinc-700 bg-zinc-900/50">
              <p className="text-sm text-zinc-400">{result.note}</p>
            </Card>
          )}

          {/* Summary side-by-side */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card className="p-4 space-y-3">
              <h2 className="text-sm font-semibold text-zinc-300">Actual ({result.session_date})</h2>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Stat label="Observations" value={result.actual_writes.observations} />
                <Stat label="Flags" value={result.actual_writes.flags} />
                <Stat label="Alerts" value={result.actual_writes.alerts} />
                <Stat label="Trades Committed" value={result.actual_trades_committed} />
              </div>
            </Card>

            <Card className="p-4 space-y-3 border-emerald-500/20 bg-emerald-500/5">
              <h2 className="text-sm font-semibold text-emerald-400">Replay (new logic)</h2>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <Stat label="Observations" value={result.replay_writes.observations} />
                <Stat label="Flags" value={result.replay_writes.flags} />
                <Stat label="Alerts" value={result.replay_writes.alerts} />
                <Stat label="Trades Would Open" value={result.replay_trades_would_commit} highlight />
                <Stat label="Demoted by Cooldown" value={result.replay_writes.demoted} />
                <Stat label="Ticks Replayed" value={`${result.ticks_replayed} / ${result.max_ticks}`} />
              </div>
            </Card>
          </div>

          {/* Cost line */}
          <div className="text-xs text-zinc-500 flex gap-4 flex-wrap">
            <span>Model: {result.cost.model}</span>
            <span>Tokens in: {result.cost.input_tokens.toLocaleString()}</span>
            <span>Tokens out: {result.cost.output_tokens.toLocaleString()}</span>
            <span>Cost: ${result.cost.usd.toFixed(4)}</span>
          </div>

          {/* Trades that would have opened */}
          <Card className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-300">
              Alert-Book-Commit Decisions
              {result.alert_commit_decisions.length > 0 && (
                <span className="ml-2 text-xs text-zinc-500">
                  ({result.alert_commit_decisions.filter(d => d.passed_guards).length} passed / {result.alert_commit_decisions.length} scanned)
                </span>
              )}
            </h2>
            {result.alert_commit_decisions.length === 0 ? (
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
                    {result.alert_commit_decisions.map(d => (
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

          {/* Per-tick diff */}
          <Card className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-zinc-300">
              Per-Tick Diff
              <span className="ml-2 text-xs text-zinc-500">
                ({result.per_tick.filter(t => t.changed).length} ticks where the decision changed)
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
                  {result.per_tick.map(t => (
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

          {/* Caveats */}
          {result.caveats?.length > 0 && (
            <Card className="p-4 bg-zinc-900/50 border-zinc-800">
              <h3 className="text-xs font-semibold text-zinc-400 mb-2">Caveats</h3>
              <ul className="text-xs text-zinc-500 space-y-1 list-disc list-inside">
                {result.caveats.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </Card>
          )}
        </>
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
