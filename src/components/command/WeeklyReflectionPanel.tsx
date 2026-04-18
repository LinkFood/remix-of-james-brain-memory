/**
 * WeeklyReflectionPanel — Claude's Sunday self-reflection.
 *
 * Pulls the latest ct_reports where report_type='weekly', renders the
 * 8 required sections as collapsible cards. Each section is expandable
 * (click to open). Links to /reports?tab=weekly for history.
 *
 * Placement: top of /scorecard, below the header.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Layers,
  AlertTriangle,
  Target,
  Compass,
  Activity,
  ExternalLink,
} from 'lucide-react';

// --------------- Types ---------------

interface WeeklyReport {
  id: string;
  report_type: string;
  period_start: string;
  period_end: string;
  summary: string | null;
  decomposition: WeeklyDecomposition | null;
  scorecard: Record<string, unknown> | null;
  self_assessment: string | null;
  created_at: string;
}

interface ThemeAttrRow {
  theme?: string;
  count?: number;
  pnl_pct?: number;
  win_rate?: number;
  note?: string;
}

interface WeeklyDecomposition {
  subtype?: string;
  week_start?: string;
  week_end?: string;
  sparsity_flag?: boolean;
  corpus_empty?: boolean;
  trading_days?: number;
  worked?: string[];
  didnt_work?: string[];
  theme_attribution?: ThemeAttrRow[];
  new_biases?: string;
  calibration_note?: string;
  next_week_posture?: string;
  structural_read?: string;
  counts?: Record<string, number>;
}

// --------------- Helpers ---------------

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null) return '—';
  const v = n.toFixed(digits);
  return n >= 0 ? `+${v}%` : `${v}%`;
}

function fmtRate(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${(n * 100).toFixed(0)}%`;
}

// --------------- Data hook ---------------

function useLatestWeekly() {
  return useQuery<WeeklyReport | null>({
    queryKey: ['ct_latest_weekly_reflection'],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('ct_reports')
        .select('id, report_type, period_start, period_end, summary, decomposition, scorecard, self_assessment, created_at')
        .eq('report_type', 'weekly')
        .order('period_end', { ascending: false })
        .limit(1)
        .maybeSingle();
      return (data ?? null) as WeeklyReport | null;
    },
  });
}

// --------------- Section primitive ---------------

interface SectionProps {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  empty?: boolean;
  emptyLabel?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  badgeRight?: React.ReactNode;
}

function Section({ title, icon: Icon, empty, emptyLabel, children, defaultOpen = false, badgeRight }: SectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="border border-border rounded-md bg-card/40">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-muted/30 transition-colors"
      >
        <Chevron className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <Icon className="w-3.5 h-3.5 text-primary shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">{title}</span>
        {badgeRight && <span className="ml-auto">{badgeRight}</span>}
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 text-xs text-foreground/90 leading-relaxed">
          {empty ? (
            <div className="text-muted-foreground italic">{emptyLabel ?? 'No data this week.'}</div>
          ) : (
            children
          )}
        </div>
      )}
    </div>
  );
}

// --------------- Theme attribution table ---------------

function ThemeAttributionTable({ rows }: { rows: ThemeAttrRow[] }) {
  if (rows.length === 0) {
    return <div className="text-muted-foreground italic">No themes with trades this week.</div>;
  }
  return (
    <div className="divide-y divide-border">
      {rows.map((row, i) => {
        const pnl = typeof row.pnl_pct === 'number' ? row.pnl_pct : null;
        const color = pnl == null
          ? 'text-muted-foreground'
          : pnl > 0 ? 'text-emerald-400'
          : pnl < 0 ? 'text-red-400'
          : 'text-muted-foreground';
        return (
          <div key={`${row.theme ?? 'unknown'}-${i}`} className="py-1.5 flex items-center gap-2 text-[11px]">
            <span className="font-mono font-semibold text-foreground">{row.theme ?? 'unknown'}</span>
            <span className="text-muted-foreground">n={row.count ?? 0}</span>
            <span className="text-muted-foreground">wr {fmtRate(row.win_rate)}</span>
            <span className={`ml-auto font-mono font-semibold ${color}`}>{fmtPct(pnl)}</span>
            {row.note && (
              <span className="w-full text-[10.5px] text-foreground/70 mt-0.5 leading-snug">
                {row.note}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// --------------- Main ---------------

export function WeeklyReflectionPanel() {
  const { data: report, isLoading } = useLatestWeekly();

  const decomp = useMemo<WeeklyDecomposition>(() => {
    return (report?.decomposition ?? {}) as WeeklyDecomposition;
  }, [report]);

  if (isLoading) {
    return (
      <Card className="p-4">
        <div className="text-xs text-muted-foreground">Loading weekly reflection…</div>
      </Card>
    );
  }

  if (!report) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-1">
          <BookOpen className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold uppercase tracking-wide">Weekly Reflection</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          No weekly reflections yet. The first one will land Sunday at 5pm ET after a full trading week.
        </p>
      </Card>
    );
  }

  const weekStart = decomp.week_start ?? report.period_start.slice(0, 10);
  const weekEnd = decomp.week_end ?? report.period_end.slice(0, 10);
  const worked = decomp.worked ?? [];
  const didnt = decomp.didnt_work ?? [];
  const themes = decomp.theme_attribution ?? [];
  const newBiases = decomp.new_biases ?? '';
  const calibrationNote = decomp.calibration_note ?? '';
  const posture = decomp.next_week_posture ?? '';
  const structural = decomp.structural_read ?? '';
  const tradingDays = decomp.trading_days ?? 0;
  const sparsity = decomp.sparsity_flag === true;
  const corpusEmpty = decomp.corpus_empty === true;

  return (
    <Card className="p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center gap-2 flex-wrap">
        <BookOpen className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold uppercase tracking-wide text-foreground">
          Weekly Reflection
        </h2>
        <span className="text-[11px] text-muted-foreground">
          week of {fmtDate(weekStart + 'T00:00:00Z')} – {fmtDate(weekEnd + 'T00:00:00Z')}
        </span>
        {sparsity && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-amber-400 border-amber-500/30">
            sparse · {tradingDays}d
          </Badge>
        )}
        {corpusEmpty && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">
            corpus empty
          </Badge>
        )}
        <Link
          to="/reports?tab=weekly"
          className="ml-auto text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
        >
          view all weekly reflections <ExternalLink className="w-3 h-3" />
        </Link>
      </div>

      {/* Week summary — always open */}
      {report.summary && (
        <div className="text-xs text-foreground/90 leading-relaxed bg-muted/20 rounded p-2.5">
          {report.summary}
        </div>
      )}

      {/* 7 collapsible sections */}
      <div className="space-y-1.5">
        <Section
          title="What worked"
          icon={TrendingUp}
          defaultOpen={worked.length > 0}
          empty={worked.length === 0}
          emptyLabel="No clear wins to call out this week."
          badgeRight={worked.length > 0 ? (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0">{worked.length}</Badge>
          ) : null}
        >
          <ul className="list-disc pl-4 space-y-1">
            {worked.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Section>

        <Section
          title="What didn't work"
          icon={TrendingDown}
          defaultOpen={didnt.length > 0}
          empty={didnt.length === 0}
          emptyLabel="No clear losses to call out this week."
          badgeRight={didnt.length > 0 ? (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0">{didnt.length}</Badge>
          ) : null}
        >
          <ul className="list-disc pl-4 space-y-1">
            {didnt.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Section>

        <Section
          title="Theme attribution"
          icon={Layers}
          empty={themes.length === 0}
          emptyLabel="No thesis_theme activity with trades this week."
          badgeRight={themes.length > 0 ? (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0">{themes.length}</Badge>
          ) : null}
        >
          <ThemeAttributionTable rows={themes} />
        </Section>

        <Section
          title="New biases"
          icon={AlertTriangle}
          empty={!newBiases || newBiases.trim().length === 0}
          emptyLabel="No new biases identified this week."
        >
          <div className="whitespace-pre-wrap">{newBiases}</div>
        </Section>

        <Section
          title="Calibration note"
          icon={Target}
          empty={!calibrationNote || calibrationNote.trim().length === 0}
          emptyLabel="Not enough graded calls to assess calibration."
        >
          <div className="whitespace-pre-wrap">{calibrationNote}</div>
        </Section>

        <Section
          title="Next-week posture"
          icon={Compass}
          defaultOpen
          empty={!posture || posture.trim().length === 0}
          emptyLabel="No specific posture set."
        >
          <div className="whitespace-pre-wrap">{posture}</div>
        </Section>

        <Section
          title="Structural read"
          icon={Activity}
          empty={!structural || structural.trim().length === 0}
          emptyLabel="No dominant structural pattern identified."
        >
          <div className="whitespace-pre-wrap">{structural}</div>
        </Section>
      </div>
    </Card>
  );
}

export default WeeklyReflectionPanel;
