/**
 * Scorecard — the Referee Dossier.
 * Claude's graded track record by call type, direction, instrument, regime.
 * "The referee is the intelligence."
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Trophy, Target, TrendingUp, TrendingDown, Activity, AlertTriangle } from 'lucide-react';

interface Grade {
  subject_type: 'flag' | 'alert' | 'james_view';
  subject_id: string;
  instrument: string;
  claimed_direction: string;
  actual_direction: string;
  actual_return_pct: number;
  verdict: 'right' | 'wrong' | 'ambiguous' | 'partial';
  calibration_delta: number | null;
  graded_at: string;
}

interface Tallies {
  total: number;
  counts: Record<string, number>;
}

function countCall(rows: { total: number; counts: Record<string, number> }, key: string): void {
  rows.counts[key] = (rows.counts[key] ?? 0) + 1;
  rows.total += 1;
}

function precision(right: number, wrong: number, partial: number): number {
  const denom = right + wrong + partial;
  if (denom === 0) return 0;
  return right / denom;
}

function fmtPct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

export function Scorecard() {
  const { data: grades } = useQuery<Grade[]>({
    queryKey: ['ct_grades_all'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('ct_grades')
        .select('subject_type, subject_id, instrument, claimed_direction, actual_direction, actual_return_pct, verdict, calibration_delta, graded_at')
        .order('graded_at', { ascending: false })
        .limit(500);
      return (data ?? []) as Grade[];
    },
  });

  const { data: pending } = useQuery<{ flags: number; alerts: number; james_views: number }>({
    queryKey: ['ct_pending_counts'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const now = new Date().toISOString();
      const [f, a, j] = await Promise.all([
        supabase.from('ct_flags').select('id', { count: 'exact', head: true }).is('grade_id', null).lt('horizon_end', now),
        supabase.from('ct_alerts').select('id', { count: 'exact', head: true }).is('grade_id', null).lt('horizon_end', now),
        supabase.from('ct_james_views').select('id', { count: 'exact', head: true }).is('grade_id', null).lt('horizon_end', now),
      ]);
      return { flags: f.count ?? 0, alerts: a.count ?? 0, james_views: j.count ?? 0 };
    },
  });

  const { data: observationCount } = useQuery<number>({
    queryKey: ['ct_obs_count'],
    queryFn: async () => {
      const { count } = await supabase.from('ct_observations').select('id', { count: 'exact', head: true });
      return count ?? 0;
    },
  });

  const { data: flagCount } = useQuery<number>({
    queryKey: ['ct_flag_count'],
    queryFn: async () => {
      const { count } = await supabase.from('ct_flags').select('id', { count: 'exact', head: true });
      return count ?? 0;
    },
  });

  const stats = useMemo(() => {
    if (!grades) return null;
    const byType: Record<string, Tallies> = {};
    const byInstrument: Record<string, Tallies> = {};
    const byDirection: Record<string, Tallies> = {};

    for (const g of grades) {
      byType[g.subject_type] ??= { total: 0, counts: {} };
      byInstrument[g.instrument] ??= { total: 0, counts: {} };
      byDirection[g.claimed_direction] ??= { total: 0, counts: {} };
      countCall(byType[g.subject_type], g.verdict);
      countCall(byInstrument[g.instrument], g.verdict);
      countCall(byDirection[g.claimed_direction], g.verdict);
    }

    return { byType, byInstrument, byDirection };
  }, [grades]);

  const overall = useMemo(() => {
    if (!grades || grades.length === 0) return null;
    const r = grades.filter(g => g.verdict === 'right').length;
    const w = grades.filter(g => g.verdict === 'wrong').length;
    const p = grades.filter(g => g.verdict === 'partial').length;
    const a = grades.filter(g => g.verdict === 'ambiguous').length;
    const avgReturn = grades.reduce((s, g) => s + (g.actual_return_pct || 0), 0) / grades.length;
    return { r, w, p, a, total: grades.length, precision: precision(r, w, p), avgReturn };
  }, [grades]);

  return (
    <div className="min-h-screen bg-background text-foreground p-4">
      <div className="max-w-[1400px] mx-auto space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Trophy className="w-6 h-6 text-primary" />
            <span className="text-primary">Scorecard</span>
            <span className="text-sm text-muted-foreground font-normal">Claude's graded track record</span>
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Every FLAG / ALERT / james_view gets scored at horizon close. This is the referee — the source of trust.
          </p>
        </header>

        {/* Top metric tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card className="p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              <Target className="w-3 h-3" /> Overall Precision
            </div>
            <div className="text-2xl font-bold text-foreground">
              {overall ? fmtPct(overall.precision) : '—'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {overall ? `${overall.r}R · ${overall.p}P · ${overall.w}W · ${overall.a}?` : 'no grades yet'}
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              <Activity className="w-3 h-3" /> Graded Calls
            </div>
            <div className="text-2xl font-bold text-foreground">{overall?.total ?? 0}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              pending: {(pending?.flags ?? 0) + (pending?.alerts ?? 0) + (pending?.james_views ?? 0)}
            </div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              <TrendingUp className="w-3 h-3" /> Avg Return
            </div>
            <div className={`text-2xl font-bold ${(overall?.avgReturn ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {overall ? `${overall.avgReturn >= 0 ? '+' : ''}${overall.avgReturn.toFixed(2)}%` : '—'}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">across all graded horizons</div>
          </Card>

          <Card className="p-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              <AlertTriangle className="w-3 h-3" /> Corpus Size
            </div>
            <div className="text-2xl font-bold text-foreground">{(observationCount ?? 0) + (flagCount ?? 0)}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {observationCount ?? 0} obs · {flagCount ?? 0} flags
            </div>
          </Card>
        </div>

        {/* Breakdown tables */}
        {grades && grades.length > 0 ? (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <Card>
              <div className="px-3 py-2 border-b border-border bg-muted/30">
                <h3 className="text-xs font-semibold uppercase tracking-wide">By Call Type</h3>
              </div>
              <BreakdownTable data={stats?.byType ?? {}} />
            </Card>
            <Card>
              <div className="px-3 py-2 border-b border-border bg-muted/30">
                <h3 className="text-xs font-semibold uppercase tracking-wide">By Direction</h3>
              </div>
              <BreakdownTable data={stats?.byDirection ?? {}} />
            </Card>
            <Card>
              <div className="px-3 py-2 border-b border-border bg-muted/30">
                <h3 className="text-xs font-semibold uppercase tracking-wide">By Instrument</h3>
              </div>
              <BreakdownTable data={stats?.byInstrument ?? {}} />
            </Card>
          </div>
        ) : (
          <Card className="p-8 text-center">
            <p className="text-muted-foreground text-sm">
              No graded calls yet. Flags and alerts score at horizon close — first scores will land once cycles complete.
            </p>
            <p className="text-muted-foreground text-xs mt-2">
              Pending at current time: {(pending?.flags ?? 0)} flags · {(pending?.alerts ?? 0)} alerts · {(pending?.james_views ?? 0)} james views
            </p>
          </Card>
        )}

        {/* Recent grades list */}
        {grades && grades.length > 0 && (
          <Card>
            <div className="px-3 py-2 border-b border-border bg-muted/30">
              <h3 className="text-xs font-semibold uppercase tracking-wide">Recent Grades</h3>
            </div>
            <div className="divide-y divide-border max-h-[50vh] overflow-y-auto">
              {grades.slice(0, 50).map((g) => (
                <GradeRow key={`${g.subject_type}-${g.subject_id}`} grade={g} />
              ))}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function BreakdownTable({ data }: { data: Record<string, Tallies> }) {
  const rows = Object.entries(data)
    .map(([key, tallies]) => {
      const r = tallies.counts.right ?? 0;
      const w = tallies.counts.wrong ?? 0;
      const p = tallies.counts.partial ?? 0;
      const a = tallies.counts.ambiguous ?? 0;
      return { key, r, w, p, a, total: tallies.total, prec: precision(r, w, p) };
    })
    .sort((a, b) => b.total - a.total);
  if (rows.length === 0) return <div className="p-3 text-xs text-muted-foreground">no data yet</div>;
  return (
    <div className="divide-y divide-border">
      {rows.map(r => (
        <div key={r.key} className="px-3 py-2 flex items-center gap-2 text-xs">
          <span className="font-mono font-semibold text-foreground">{r.key}</span>
          <span className="text-muted-foreground text-[10px]">n={r.total}</span>
          <span className="ml-auto font-semibold text-foreground">{fmtPct(r.prec)}</span>
          <span className="text-[10px] text-muted-foreground">
            {r.r}R · {r.p}P · {r.w}W
          </span>
        </div>
      ))}
    </div>
  );
}

function GradeRow({ grade }: { grade: Grade }) {
  const verdictColor: Record<string, string> = {
    right: 'bg-green-500/15 text-green-400 border-green-500/30',
    partial: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
    wrong: 'bg-red-500/15 text-red-400 border-red-500/30',
    ambiguous: 'bg-muted/50 text-muted-foreground border-muted',
  };
  return (
    <div className="px-3 py-2 flex items-center gap-2 text-xs hover:bg-muted/30 transition-colors">
      <span className="font-mono font-semibold text-foreground">{grade.instrument}</span>
      <span className="text-muted-foreground text-[10px]">{grade.subject_type}</span>
      <span className="text-muted-foreground">
        {grade.claimed_direction} → {grade.actual_direction}
      </span>
      <span className={`font-mono ${grade.actual_return_pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
        {grade.actual_return_pct >= 0 ? '+' : ''}{grade.actual_return_pct.toFixed(2)}%
      </span>
      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${verdictColor[grade.verdict] ?? ''}`}>
        {grade.verdict}
      </Badge>
      <span className="text-[10px] text-muted-foreground ml-auto">
        {new Date(grade.graded_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
      </span>
    </div>
  );
}

export default Scorecard;
