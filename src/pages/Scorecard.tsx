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
import { Trophy, Target, TrendingUp, TrendingDown, Activity, AlertTriangle, Brain } from 'lucide-react';
import { GhostTradeTape } from '@/components/command/GhostTradeTape';
import { SelfCorrectionsPanel } from '@/components/command/SelfCorrectionsPanel';
import { BiasesPanel } from '@/components/command/BiasesPanel';
import { PreBellGauntletPanel } from '@/components/command/PreBellGauntletPanel';
import { BookPanel } from '@/components/command/BookPanel';
import { EquityCurvePanel } from '@/components/command/EquityCurvePanel';
import { RecallSearch } from '@/components/command/RecallSearch';
import { JamesVsClaude } from '@/components/command/JamesVsClaude';
import { WeeklyReflectionPanel } from '@/components/command/WeeklyReflectionPanel';
import { CalibrationChart } from '@/components/scorecard/CalibrationChart';
import { ClaudesSurprises } from '@/components/scorecard/ClaudesSurprises';
import { AxisAttributionPanel } from '@/components/scorecard/AxisAttributionPanel';
import { AlertPostMortemsPanel } from '@/components/scorecard/AlertPostMortemsPanel';
import { RegimeConditionalPanel } from '@/components/scorecard/RegimeConditionalPanel';
import { useGhostPnl } from '@/hooks/useCoTraderData';
import { useCalibration } from '@/hooks/useCalibration';
import { useClaudesSurprises } from '@/hooks/useClaudesSurprises';
import { usePromptAbTest } from '@/hooks/usePromptAbTest';
import { Link } from 'react-router-dom';
import { FlaskConical, ArrowRight } from 'lucide-react';

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

  /**
   * Self-confidence calibration:
   * Of graded flags/alerts, bucket by the ORIGINAL self-assessed confidence
   * (1-5) and compute % with verdict='right'. Calibrated = higher confidence
   * → higher accuracy. Miscalibrated = inversion or flat line.
   */
  const { data: calibration } = useQuery<{
    buckets: Array<{ confidence: number; total: number; right: number; accuracy: number }>;
    sample: number;
  }>({
    queryKey: ['ct_self_confidence_calibration'],
    refetchInterval: 60_000,
    queryFn: async () => {
      // Pull graded flags with self_assessment, and graded alerts too.
      const [graded, flagSa, alertSa] = await Promise.all([
        supabase.from('ct_grades')
          .select('subject_type, subject_id, verdict')
          .in('subject_type', ['flag', 'alert'])
          .limit(2000),
        supabase.from('ct_flags').select('id, self_assessment').not('self_assessment', 'is', null).limit(2000),
        supabase.from('ct_alerts').select('id, self_assessment').not('self_assessment', 'is', null).limit(2000),
      ]);
      const flagMap = new Map<string, number>();
      for (const r of (flagSa.data ?? []) as Array<Record<string, unknown>>) {
        const sa = r.self_assessment as { confidence?: number } | null;
        if (sa?.confidence != null) flagMap.set(r.id as string, Math.max(1, Math.min(5, Math.round(Number(sa.confidence)))));
      }
      const alertMap = new Map<string, number>();
      for (const r of (alertSa.data ?? []) as Array<Record<string, unknown>>) {
        const sa = r.self_assessment as { confidence?: number } | null;
        if (sa?.confidence != null) alertMap.set(r.id as string, Math.max(1, Math.min(5, Math.round(Number(sa.confidence)))));
      }
      const buckets = new Map<number, { total: number; right: number }>();
      for (let c = 1; c <= 5; c++) buckets.set(c, { total: 0, right: 0 });
      let sample = 0;
      for (const g of (graded.data ?? []) as Array<Record<string, unknown>>) {
        const id = g.subject_id as string;
        const type = g.subject_type as string;
        const conf = type === 'flag' ? flagMap.get(id) : type === 'alert' ? alertMap.get(id) : undefined;
        if (conf == null) continue;
        const b = buckets.get(conf)!;
        b.total += 1;
        if (g.verdict === 'right') b.right += 1;
        sample += 1;
      }
      const out = Array.from(buckets.entries()).map(([confidence, v]) => ({
        confidence,
        total: v.total,
        right: v.right,
        accuracy: v.total > 0 ? v.right / v.total : 0,
      }));
      return { buckets: out, sample };
    },
  });

  // New structured calibration: conviction buckets (1-5) + attention_score buckets (0-20..80-100).
  // Uses ct_flags.conviction/attention_score and ct_alerts.conviction/attention_score joined to ct_grades.
  const { data: calibrationCurves } = useCalibration();

  // Surprise deltas — over/underconfidence counts drive the header bias stat.
  const { data: surprises } = useClaudesSurprises();

  // Prompt A/B teaser — derive "latest vs previous" deltas from the same hook
  // the /prompts page uses. Skip entirely if fewer than 2 comparable versions.
  const { data: promptVersions } = usePromptAbTest();
  const promptTeaser = useMemo(() => {
    if (!promptVersions || promptVersions.length < 2) return null;
    const comparable = promptVersions.filter((v) => !v.insufficient);
    if (comparable.length < 2) return null;
    const prev = comparable[comparable.length - 2];
    const curr = comparable[comparable.length - 1];
    const bits: string[] = [];
    if (prev.hit_rate != null && curr.hit_rate != null) {
      const delta = (curr.hit_rate - prev.hit_rate) * 100;
      const sign = delta >= 0 ? '+' : '';
      bits.push(`${sign}${delta.toFixed(0)}% hit rate`);
    }
    if (prev.alerts_per_day != null && curr.alerts_per_day != null && prev.alerts_per_day > 0) {
      const pct = ((curr.alerts_per_day - prev.alerts_per_day) / prev.alerts_per_day) * 100;
      const sign = pct >= 0 ? '+' : '';
      bits.push(`${sign}${pct.toFixed(0)}% alerts/day`);
    }
    if (prev.calibration_gap_pp != null && curr.calibration_gap_pp != null) {
      const delta = curr.calibration_gap_pp - prev.calibration_gap_pp;
      const sign = delta >= 0 ? '+' : '';
      bits.push(`${sign}${delta.toFixed(1)}pp calibration`);
    }
    if (bits.length === 0) return null;
    return { prev: prev.version, curr: curr.version, bits };
  }, [promptVersions]);

  /**
   * Net calibration bias:
   *   over = count of grades with calibration_delta <= -BIG (claimed high, missed)
   *   under = count of grades with calibration_delta >= +BIG (claimed low, hit)
   *   ratio = over / under (or inverse, whichever side is bigger)
   * Copy:
   *   over > under → "overconfident X times more than underconfident"
   *   under > over → "underconfident X times more than overconfident"
   *   tie / empty → skip the stat
   */
  const biasStat = useMemo(() => {
    if (!surprises) return null;
    const { overconfident_count: over, underconfident_count: under } = surprises;
    if (over === 0 && under === 0) return null;
    if (over === under) {
      return { copy: `Net calibration bias: balanced (${over}:${under} in last 30d)`, tone: 'neutral' as const };
    }
    if (over > under) {
      const ratio = under === 0 ? over : over / under;
      const ratioStr = under === 0 ? `${over}x` : `${ratio.toFixed(1)}x`;
      return {
        copy: `Net calibration bias: Claude is overconfident ${ratioStr} more than underconfident (${over}:${under} in last 30d)`,
        tone: 'over' as const,
      };
    }
    const ratio = over === 0 ? under : under / over;
    const ratioStr = over === 0 ? `${under}x` : `${ratio.toFixed(1)}x`;
    return {
      copy: `Net calibration bias: Claude is underconfident ${ratioStr} more than overconfident (${under}:${over} in last 30d)`,
      tone: 'under' as const,
    };
  }, [surprises]);

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
            {calibrationCurves?.convictionGap != null && (
              <a
                href="#calibration"
                className="ml-auto text-[11px] font-mono flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                title="Positive = underconfident (delivers more than claimed). Negative = overconfident."
              >
                <span className="uppercase tracking-wider">Conviction gap:</span>
                <span
                  className={
                    calibrationCurves.convictionGap > 0.05
                      ? 'text-green-400 font-semibold'
                      : calibrationCurves.convictionGap < -0.05
                        ? 'text-red-400 font-semibold'
                        : 'text-foreground font-semibold'
                  }
                >
                  {calibrationCurves.convictionGap >= 0 ? '+' : ''}
                  {(calibrationCurves.convictionGap * 100).toFixed(0)}%
                </span>
              </a>
            )}
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Every FLAG / ALERT / james_view gets scored at horizon close. This is the referee — the source of trust.
          </p>
          {biasStat && (
            <p
              className={`text-[11px] mt-1 font-mono ${
                biasStat.tone === 'over'
                  ? 'text-red-400'
                  : biasStat.tone === 'under'
                    ? 'text-green-400'
                    : 'text-muted-foreground'
              }`}
              title="Counts of graded calls where |calibration_delta| >= 30pp in the last 30 days. Negative delta = overconfident. Positive delta = underconfident."
            >
              {biasStat.copy}
            </p>
          )}
        </header>

        {/* Weekly reflection — Claude's Sunday cross-day journal. Top placement:
            when a fresh one lands, it's the first thing you read. */}
        <WeeklyReflectionPanel />

        {/* Memory recall search */}
        <RecallSearch />

        {/* Prompt A/B teaser — compact strip linking to /prompts. Only renders
            once we have at least two comparable versions so it doesn't add
            noise for early users. */}
        {promptTeaser && (
          <Link
            to="/prompts"
            className="group flex items-center gap-3 px-3 py-2 rounded border border-border bg-muted/10 hover:bg-muted/25 transition-colors"
          >
            <FlaskConical className="w-4 h-4 text-primary shrink-0" />
            <div className="text-xs text-foreground/90">
              <span className="font-mono font-semibold">Prompt {promptTeaser.curr}</span>
              <span className="text-muted-foreground"> vs </span>
              <span className="font-mono font-semibold">{promptTeaser.prev}</span>
              <span className="text-muted-foreground">: </span>
              <span className="text-foreground">{promptTeaser.bits.join(', ')}</span>
            </div>
            <ArrowRight className="w-3.5 h-3.5 ml-auto text-muted-foreground group-hover:text-foreground transition-colors" />
          </Link>
        )}

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

        {/* Self-confidence calibration — does high self-rated confidence correlate with being right? */}
        <Card className="p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
            <Brain className="w-3 h-3" /> Self-Confidence Calibration
            <span className="normal-case tracking-normal text-muted-foreground/70">
              — graded accuracy by Claude's stated confidence (1-5)
            </span>
            <span className="ml-auto normal-case tracking-normal">
              n={calibration?.sample ?? 0}
            </span>
          </div>
          {!calibration || calibration.sample === 0 ? (
            <div className="text-xs text-muted-foreground">
              no self-assessed graded calls yet — self_assessment lands on flags/alerts written after v21, grades land at horizon close
            </div>
          ) : (
            <div className="grid grid-cols-5 gap-2">
              {calibration.buckets.map((b) => {
                const pct = b.total > 0 ? fmtPct(b.accuracy) : '—';
                const color = b.total === 0
                  ? 'text-muted-foreground'
                  : b.accuracy >= 0.6 ? 'text-green-400'
                  : b.accuracy >= 0.4 ? 'text-amber-400'
                  : 'text-red-400';
                return (
                  <div key={b.confidence} className="text-center bg-muted/20 rounded p-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      conf {b.confidence}
                    </div>
                    <div className={`text-xl font-bold ${color}`}>{pct}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {b.right}/{b.total}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mt-2 text-[10px] text-muted-foreground">
            calibrated reasoning = accuracy rises with stated confidence. flat or inverted line = miscalibrated.
          </div>
        </Card>

        {/* Calibration curves — per-axis is v2 (axis scores are computed on-the-fly
            from UW, not captured at claim time). v1 uses CONVICTION as an overall-score
            proxy plus attention_score from wave 1. Bar + dashed ideal line. */}
        <Card id="calibration" className="p-4 scroll-mt-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
            <Target className="w-3 h-3" /> Calibration Curves
            <span className="normal-case tracking-normal text-muted-foreground/70">
              — does stated conviction / attention correlate with actual outcomes?
            </span>
            {calibrationCurves?.convictionGap != null && (
              <span className="ml-auto normal-case tracking-normal font-mono">
                gap {calibrationCurves.convictionGap >= 0 ? '+' : ''}
                {(calibrationCurves.convictionGap * 100).toFixed(0)}%
                <span className="text-muted-foreground/70 ml-1">
                  {calibrationCurves.convictionGap > 0
                    ? '(underconfident)'
                    : calibrationCurves.convictionGap < 0
                      ? '(overconfident)'
                      : '(calibrated)'}
                </span>
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <CalibrationChart
              title="Conviction Calibration"
              subtitle="stated 1-5 vs actual hit rate · dashed line = ideal"
              buckets={calibrationCurves?.conviction ?? []}
              xLabel="conviction"
            />
            <CalibrationChart
              title="Attention-Score Calibration"
              subtitle="0-100 buckets vs actual hit rate"
              buckets={calibrationCurves?.attention ?? []}
              xLabel="attention score"
            />
          </div>

          <div className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
            <span className="text-foreground/80 font-semibold">Read this:</span>{' '}
            Hit rate = right / (right + partial + wrong). Ambiguous verdicts are excluded.
            Bars below the dashed line = overconfidence at that conviction level; bars above = underconfidence.
            Buckets with fewer than 3 samples show muted and labeled "(sparse)".
            Per-axis ($FLOW / HEDGE / NOW / CALLS / PUTS) calibration requires capturing the 5-axis snapshot
            onto each flag/alert at write time — planned for v2.
          </div>
        </Card>

        {/* Axis attribution — which evidence axes (A..F) actually predict?
            Meta-calibration: if Claude cites A a lot but those calls underperform
            vs C, that's structural input for the watcher prompt (bump C, dampen A). */}
        <AxisAttributionPanel />

        {/* Wrong-alert post-mortems — forensic autopsy of each wrong alert,
            grouped by weakest-axis cites. Pairs directly with Axis Attribution
            above: attribution says "axis A hit rate is weak", this says
            "here's 14 specific wrong alerts where Claude cited A as the
            false signal, and here's the lesson from each." */}
        <AlertPostMortemsPanel />

        {/* Regime-conditional edge — where Claude has real conditional edge vs the
            overall hit rate. Six dimensions + gamma×session heatmap. Sits between
            Calibration/AxisAttribution and Surprises per wave 19 placement. */}
        <RegimeConditionalPanel />

        {/* Claude's Surprises — the furthest-from-reality calls. Most instructive grades. */}
        <ClaudesSurprises />

        {/* Ghost Trade Tape — paper P&L of Claude's flagged calls. Hidden until
            there's at least one graded trade; zero-state would be pure noise. */}
        <GatedGhostTradeTape />

        {/* Claude's book — the direct edge measurement: does he make money? */}
        <BookPanel />
        <EquityCurvePanel />

        {/* Pre-bell gauntlet — today's three committed calls, clean calibration. */}
        <PreBellGauntletPanel />

        {/* Claude's self-corrections — hindsight paired with original read.
            The feedback loop the watcher now reads on every tick. */}
        <SelfCorrectionsPanel />

        {/* Claude's self-identified biases — META-level blindspots written
            weekly by ct-bias-booth. Calibration data. James can veto any
            bias (retire button) after a 3-day self-correction window. */}
        <BiasesPanel />

        {/* James vs Claude — head-to-head disagreement scoreboard with paired
            rationale + grades. 14-day window on the dossier page (wider than
            command station) because this IS the track record. */}
        <JamesVsClaude variant="scorecard" daysBack={14} />

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

/**
 * GhostTradeTape is a huge panel and pre-9am there may be 0 graded trades.
 * Only render once we know there's data; otherwise hide entirely.
 */
function GatedGhostTradeTape() {
  const { data } = useGhostPnl(30);
  if (!data || data.rows.length === 0) return null;
  return <GhostTradeTape days={30} />;
}

export default Scorecard;
