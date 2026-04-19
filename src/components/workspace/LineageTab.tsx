/**
 * LineageTab — past generations timeline + drill-down.
 *
 * Tenet 14 / Tenet 17 made inspectable: "which generations were smart,
 * which were dumb, what did we learn." Renders:
 *
 *   - Cumulative stats header (total, success, fired, avg return, common fire reason)
 *   - Horizontal timeline of past generations, each a card
 *   - Click a gen → expand an inline drawer with its hypotheses, top grades,
 *     recent decisions (esp. reflections), and the fire reason
 *
 * Lives at /workspace?view=lineage.
 */
import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  usePastGenerations,
  useGenerationLineageCount,
  type ClaudeGeneration,
  type GenerationStatus,
  type FireReason,
} from '@/hooks/useClaudeGeneration';
import {
  History, TrendingUp, TrendingDown, Flame, Check, AlertTriangle,
  CircleDashed, Brain, Activity, Target as TargetIcon,
} from 'lucide-react';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `$${Math.round(n).toLocaleString()}`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function statusChipClass(s: GenerationStatus | undefined): string {
  switch (s) {
    case 'succeeded': return 'bg-green-500/15 text-green-400 border-green-500/40';
    case 'fired': return 'bg-red-500/15 text-red-400 border-red-500/40';
    case 'abandoned': return 'bg-amber-500/15 text-amber-400 border-amber-500/40';
    case 'active':
    default: return 'bg-blue-500/15 text-blue-400 border-blue-500/40';
  }
}

function statusIcon(s: GenerationStatus | undefined) {
  switch (s) {
    case 'succeeded': return Check;
    case 'fired': return Flame;
    case 'abandoned': return CircleDashed;
    case 'active':
    default: return Activity;
  }
}

function fireReasonLabel(r: FireReason): string {
  if (!r) return '—';
  return r.replace(/_/g, ' ');
}

// ---------------------------------------------------------------------------
// Data — generation detail drill-down (lazy, only when expanded)
// ---------------------------------------------------------------------------
interface GenDetail {
  hypotheses: Array<{ id: string; claim: string; status: string; elo: number }>;
  topGrades: Array<{
    id: string;
    instrument: string | null;
    verdict: string;
    actual_return_pct: number | null;
    graded_at: string;
  }>;
  lastReflection: { id: string; reasoning: string; created_at: string } | null;
  tradesCount: number;
}

function useGenerationDetail(genId: string | null) {
  return useQuery<GenDetail | null>({
    queryKey: ['ct_generation_detail', genId],
    enabled: genId !== null,
    queryFn: async () => {
      if (!genId) return null;
      const [hypsRes, gradesRes, reflRes, tradesRes] = await Promise.all([
        sb.from('ct_hypotheses')
          .select('id, claim, status, elo')
          .eq('generation_id', genId)
          .order('elo', { ascending: false })
          .limit(10),
        sb.from('ct_grades')
          .select('id, instrument, verdict, actual_return_pct, graded_at')
          .eq('generation_id', genId)
          .order('graded_at', { ascending: false })
          .limit(10),
        sb.from('ct_claude_decisions')
          .select('id, reasoning, created_at, decision_type')
          .eq('generation_id', genId)
          .eq('decision_type', 'reflection')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        sb.from('ct_trades')
          .select('id', { count: 'estimated', head: true })
          .eq('generation_id', genId),
      ]);
      if (hypsRes.error) throw hypsRes.error;
      if (gradesRes.error) throw gradesRes.error;
      if (reflRes.error) throw reflRes.error;
      if (tradesRes.error) throw tradesRes.error;
      return {
        hypotheses: (hypsRes.data ?? []) as GenDetail['hypotheses'],
        topGrades: (gradesRes.data ?? []) as GenDetail['topGrades'],
        lastReflection: (reflRes.data as GenDetail['lastReflection']) ?? null,
        tradesCount: (tradesRes as { count?: number }).count ?? 0,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------
export function LineageTab() {
  const { data: pastGens = [], isLoading } = usePastGenerations(50);
  const { data: totalCount = 0 } = useGenerationLineageCount();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Cumulative stats — derived from the past-generation rows.
  const stats = useMemo(() => {
    const succeeded = pastGens.filter((g) => g.status === 'succeeded').length;
    const fired = pastGens.filter((g) => g.status === 'fired').length;
    const abandoned = pastGens.filter((g) => g.status === 'abandoned').length;

    const returns = pastGens
      .map((g) => g.total_return_pct)
      .filter((n): n is number => n != null && Number.isFinite(n));
    const avgReturn =
      returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null;

    const fireReasons = pastGens
      .map((g) => g.fire_reason)
      .filter((r): r is Exclude<FireReason, null> => r != null);
    const reasonCounts = new Map<string, number>();
    for (const r of fireReasons) reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
    const mostCommonFireReason =
      Array.from(reasonCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return { succeeded, fired, abandoned, avgReturn, mostCommonFireReason };
  }, [pastGens]);

  // ---------- EMPTY STATE ----------
  if (isLoading) {
    return (
      <Card className="p-8 text-sm text-muted-foreground">Loading lineage…</Card>
    );
  }

  if (pastGens.length === 0) {
    return (
      <Card className="p-8 text-center space-y-2 border-dashed">
        <History className="w-8 h-8 mx-auto text-muted-foreground" />
        <div className="text-sm text-foreground">
          Generation 1 is your first — no lineage yet.
        </div>
        <div className="text-xs text-muted-foreground">
          When a generation ends (fired, succeeded, or abandoned) it lands here.
          You'll see its hypotheses, grades, reflections, and the reason it ended.
        </div>
      </Card>
    );
  }

  // ---------- NORMAL RENDER ----------
  return (
    <div className="space-y-3">
      {/* Cumulative stats */}
      <Card className="p-3 grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Total</div>
          <div className="font-mono text-base">{totalCount}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Succeeded</div>
          <div className="font-mono text-base text-green-400">{stats.succeeded}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Fired</div>
          <div className="font-mono text-base text-red-400">{stats.fired}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Avg return</div>
          <div className={`font-mono text-base ${
            stats.avgReturn != null && stats.avgReturn >= 0
              ? 'text-green-400'
              : stats.avgReturn != null
              ? 'text-red-400'
              : 'text-muted-foreground'
          }`}>
            {fmtPct(stats.avgReturn)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Common fire</div>
          <div className="font-mono text-base text-amber-400">
            {stats.mostCommonFireReason
              ? fireReasonLabel(stats.mostCommonFireReason as FireReason)
              : '—'}
          </div>
        </div>
      </Card>

      {/* Timeline */}
      <Card className="p-3 space-y-2">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
          <History className="w-3 h-3" />
          <span>Lineage timeline · newest first</span>
          <span className="ml-auto font-mono">{pastGens.length}</span>
        </div>
        <div className="flex gap-2 overflow-x-auto pb-2">
          {pastGens.map((gen) => (
            <GenerationTimelineCard
              key={gen.id}
              generation={gen}
              expanded={gen.id === expandedId}
              onClick={() =>
                setExpandedId(expandedId === gen.id ? null : gen.id)
              }
            />
          ))}
        </div>
      </Card>

      {/* Expanded detail */}
      {expandedId && (
        <GenerationDetailCard
          gen={pastGens.find((g) => g.id === expandedId) ?? null}
          onClose={() => setExpandedId(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline card
// ---------------------------------------------------------------------------
function GenerationTimelineCard({
  generation, expanded, onClick,
}: {
  generation: ClaudeGeneration;
  expanded: boolean;
  onClick: () => void;
}) {
  const Icon = statusIcon(generation.status);
  const returnColor =
    generation.total_return_pct != null && generation.total_return_pct >= 0
      ? 'text-green-400'
      : generation.total_return_pct != null
      ? 'text-red-400'
      : 'text-muted-foreground';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 w-[180px] text-left rounded-md border transition-colors ${
        expanded
          ? 'border-primary/60 bg-primary/5'
          : 'border-border bg-card hover:bg-muted/30'
      }`}
    >
      <div className="p-2.5 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="font-bold text-sm">GEN {generation.generation_number}</span>
          <Badge
            variant="outline"
            className={`text-[9px] px-1 py-0 h-4 ml-auto ${statusChipClass(generation.status)}`}
          >
            {generation.status}
          </Badge>
        </div>
        <div className="text-[10px] text-muted-foreground font-mono">
          {fmtDate(generation.started_at)} → {fmtDate(generation.ended_at)}
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          {generation.total_return_pct != null && generation.total_return_pct >= 0 ? (
            <TrendingUp className={`w-3 h-3 ${returnColor}`} />
          ) : (
            <TrendingDown className={`w-3 h-3 ${returnColor}`} />
          )}
          <span className={`font-mono ${returnColor}`}>
            {fmtPct(generation.total_return_pct)}
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground">
          ended at <span className="font-mono">{fmtUsd(generation.ending_balance_usd)}</span>
        </div>
        {generation.fire_reason && (
          <div className="text-[10px] text-red-400 flex items-center gap-1">
            <Flame className="w-2.5 h-2.5" />
            {fireReasonLabel(generation.fire_reason)}
          </div>
        )}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Expanded detail
// ---------------------------------------------------------------------------
function GenerationDetailCard({
  gen, onClose,
}: {
  gen: ClaudeGeneration | null;
  onClose: () => void;
}) {
  const { data: detail, isLoading } = useGenerationDetail(gen?.id ?? null);

  if (!gen) return null;

  return (
    <Card className="p-4 space-y-3 border-primary/40">
      {/* Header */}
      <div className="flex items-start gap-3 flex-wrap">
        <div className="text-xl font-bold text-primary">GEN {gen.generation_number}</div>
        <Badge
          variant="outline"
          className={`text-[10px] px-1.5 py-0.5 ${statusChipClass(gen.status)}`}
        >
          {gen.status}
        </Badge>
        <div className="text-[10px] text-muted-foreground ml-auto flex items-center gap-2">
          <span>
            {fmtDate(gen.started_at)} → {fmtDate(gen.ended_at)} · {gen.days_lived ?? '—'}d lived
          </span>
          <button
            type="button"
            onClick={onClose}
            className="text-primary hover:underline text-[10px]"
          >
            close
          </button>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
        <Stat label="Starting" value={fmtUsd(gen.starting_balance_usd)} />
        <Stat label="Ended at" value={fmtUsd(gen.ending_balance_usd)} />
        <Stat label="Return" value={fmtPct(gen.total_return_pct)} />
        <Stat label="Max drawdown" value={fmtPct(gen.max_drawdown_pct)} />
        <Stat label="Trades" value={`${gen.total_trades ?? 0}`} />
        <Stat label="Wins / Losses" value={`${gen.wins ?? 0} / ${gen.losses ?? 0}`} />
        <Stat label="Hallucinations" value={`${gen.hallucinations_flagged ?? 0}`} />
        <Stat label="Breakers tripped" value={`${gen.circuit_breakers_tripped ?? 0}`} />
      </div>

      {/* Fire reason callout */}
      {gen.fire_reason && (
        <div className="rounded-md border border-red-500/40 bg-red-500/5 p-2.5">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-red-400">
            <AlertTriangle className="w-3 h-3" />
            Fire reason
          </div>
          <div className="text-xs text-red-400 mt-0.5 font-mono">
            {fireReasonLabel(gen.fire_reason)}
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-xs text-muted-foreground">Loading detail…</div>
      ) : (
        <>
          <Separator />

          {/* Hypotheses */}
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <Brain className="w-3 h-3" />
              Hypotheses · top by elo
              <span className="ml-auto font-mono">{detail?.hypotheses.length ?? 0}</span>
            </div>
            {detail?.hypotheses.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                No hypotheses recorded for this generation.
              </div>
            ) : (
              <div className="space-y-1">
                {detail?.hypotheses.map((h) => (
                  <div
                    key={h.id}
                    className="text-xs flex items-start gap-2 border-l-2 border-muted-foreground/20 pl-2 py-1"
                  >
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 shrink-0">
                      {h.status}
                    </Badge>
                    <span className="text-foreground/90 leading-snug flex-1 line-clamp-2">
                      {h.claim}
                    </span>
                    <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                      elo {h.elo}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <Separator />

          {/* Grades */}
          <section className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              <TargetIcon className="w-3 h-3" />
              Top grades · recent
              <span className="ml-auto font-mono">{detail?.topGrades.length ?? 0}</span>
            </div>
            {detail?.topGrades.length === 0 ? (
              <div className="text-xs text-muted-foreground italic">
                No graded outcomes for this generation.
              </div>
            ) : (
              <div className="space-y-0.5">
                {detail?.topGrades.map((g) => (
                  <div key={g.id} className="text-xs flex items-center gap-2 py-0.5">
                    <span className="font-mono font-semibold">{g.instrument ?? '—'}</span>
                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4">
                      {g.verdict}
                    </Badge>
                    <span className={`font-mono ml-auto ${
                      g.actual_return_pct != null && g.actual_return_pct >= 0
                        ? 'text-green-400'
                        : 'text-red-400'
                    }`}>
                      {fmtPct(g.actual_return_pct)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Reflection */}
          {detail?.lastReflection && (
            <>
              <Separator />
              <section className="space-y-1">
                <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  <Activity className="w-3 h-3" />
                  Final reflection
                </div>
                <div className="text-xs leading-snug text-foreground/90 border-l-2 border-primary/60 pl-2">
                  {detail.lastReflection.reasoning}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {fmtDate(detail.lastReflection.created_at)}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card/50 p-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="text-xs font-mono text-foreground mt-0.5">{value}</div>
    </div>
  );
}
