/**
 * PerThesisPanel — per-Thesis win rate + Elo scorecard.
 *
 * Wave 4 of the Co-Trader hypothesis engine. Reads the
 * ct_hypothesis_scorecard() RPC (pre-aggregated per hypothesis) and renders
 * one row per thesis sorted by Elo. Trend arrow per row is derived from the
 * most recent elo_update / confidence_update event.
 *
 * UI label throughout: "Thesis" (even though the underlying tables use
 * "hypothesis" to avoid collision with the older ct_theses snapshot table).
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  Brain,
  TrendingUp,
  TrendingDown,
  Minus,
  ExternalLink,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { FreshnessChip } from '@/components/FreshnessChip';
import {
  useHypothesisScorecard,
  type HypothesisScorecardRow,
} from '@/hooks/useHypothesisScorecard';
import { supabase } from '@/integrations/supabase/client';

// ---------------------------------------------------------------------------
// Trend hook — last elo_update/confidence_update event per hypothesis.
// Keeps it cheap: pulls the latest 500 events ordered DESC, client-side
// reduces to a Map keyed by hypothesis_id.
// ---------------------------------------------------------------------------
type EventRow = {
  hypothesis_id: string;
  event_type: string;
  delta: number | null;
  created_at: string;
};
type TrendMap = Map<string, { delta: number; event_type: string }>;

function useHypothesisTrend(): TrendMap {
  const { data } = useQuery<EventRow[]>({
    queryKey: ['ct_hypothesis_events_trend'],
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase as any)
        .from('ct_hypothesis_events')
        .select('hypothesis_id, event_type, delta, created_at')
        .in('event_type', ['elo_update', 'confidence_update'])
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) {
        console.error('[useHypothesisTrend] error', error);
        return [];
      }
      return (data ?? []) as EventRow[];
    },
  });

  return useMemo<TrendMap>(() => {
    const m: TrendMap = new Map();
    for (const ev of data ?? []) {
      // DESC order — first hit per hypothesis is the most recent.
      if (!m.has(ev.hypothesis_id)) {
        m.set(ev.hypothesis_id, {
          delta: Number(ev.delta ?? 0),
          event_type: ev.event_type,
        });
      }
    }
    return m;
  }, [data]);
}

// ---------------------------------------------------------------------------
// Small format helpers
// ---------------------------------------------------------------------------
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

function fmtDelta(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const pp = n * 100;
  const sign = pp >= 0 ? '+' : '';
  return `${sign}${pp.toFixed(0)}pp`;
}

// Color tokens reused from scorecard convention.
const STATUS_STYLE: Record<HypothesisScorecardRow['status'], string> = {
  open:      'bg-sky-500/15 text-sky-400 border-sky-500/30',
  supported: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  refuted:   'bg-red-500/15 text-red-400 border-red-500/30',
  zombie:    'bg-amber-500/15 text-amber-400 border-amber-500/30',
  retired:   'bg-muted/50 text-muted-foreground border-muted',
};

function WinRateCell({ rate }: { rate: number | null }) {
  if (rate == null) {
    return <span className="text-muted-foreground font-mono text-[11px]">—</span>;
  }
  const pct = rate * 100;
  const color =
    pct >= 55
      ? 'text-emerald-400'
      : pct <= 45
        ? 'text-red-400'
        : 'text-muted-foreground';
  return (
    <span className={`font-mono font-semibold text-[11px] ${color}`}>
      {fmtPct(rate, 0)}
    </span>
  );
}

function TrendArrow({ trend }: { trend: { delta: number; event_type: string } | undefined }) {
  if (!trend || !Number.isFinite(trend.delta) || trend.delta === 0) {
    return <Minus className="w-3 h-3 text-muted-foreground" aria-label="flat" />;
  }
  if (trend.delta > 0) {
    return <TrendingUp className="w-3 h-3 text-emerald-400" aria-label="up" />;
  }
  return <TrendingDown className="w-3 h-3 text-red-400" aria-label="down" />;
}

function CalibrationCell({ delta }: { delta: number | null }) {
  if (delta == null) {
    return <span className="text-muted-foreground font-mono text-[11px]">—</span>;
  }
  // Scorecard convention: positive = underconfident, negative = overconfident.
  const color =
    delta > 0.05
      ? 'text-emerald-400'
      : delta < -0.05
        ? 'text-red-400'
        : 'text-foreground';
  return (
    <span className={`font-mono font-semibold text-[11px] ${color}`} title="Positive = underconfident. Negative = overconfident.">
      {fmtDelta(delta)}
    </span>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-14 rounded-sm bg-muted overflow-hidden">
        <div
          className="h-full bg-primary/70"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[10px] text-muted-foreground w-7 text-right">
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

export function PerThesisPanel() {
  const { data: rows = [], isLoading } = useHypothesisScorecard();
  const trendMap = useHypothesisTrend();

  // Freshness anchored to the most recent last_grade_at (deterministic).
  const latestGradedAt = useMemo(() => {
    let t: string | null = null;
    for (const r of rows) {
      if (!r.last_grade_at) continue;
      if (t === null || new Date(r.last_grade_at) > new Date(t)) {
        t = r.last_grade_at;
      }
    }
    return t;
  }, [rows]);

  return (
    <Card id="per-thesis" className="p-4 scroll-mt-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
        <Brain className="w-3 h-3" /> Per-Thesis Scorecard
        <span className="normal-case tracking-normal text-muted-foreground/70">
          — win rate, Elo, and calibration by Thesis
        </span>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
          {rows.length}
        </Badge>
        <FreshnessChip timestamp={latestGradedAt} className="ml-auto" />
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground py-6">Loading theses…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground py-6">
          No theses graded yet — they'll start grading as alerts resolve.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="text-left font-medium py-1.5 pr-2">Claim</th>
                <th className="text-left font-medium py-1.5 px-2">Status</th>
                <th className="text-left font-medium py-1.5 px-2">Confidence</th>
                <th className="text-left font-medium py-1.5 px-2">Elo</th>
                <th className="text-left font-medium py-1.5 px-2">Grades</th>
                <th className="text-left font-medium py-1.5 px-2">Win rate</th>
                <th className="text-left font-medium py-1.5 px-2">Calibration</th>
                <th className="text-left font-medium py-1.5 px-2 w-6"></th>
              </tr>
            </thead>
            <tbody>
              <TooltipProvider delayDuration={200}>
                {rows.map((r) => {
                  const trend = trendMap.get(r.hypothesis_id);
                  return (
                    <tr
                      key={r.hypothesis_id}
                      className="border-b border-border/50 hover:bg-muted/20 transition-colors"
                    >
                      <td className="py-1.5 pr-2 max-w-[260px]">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-foreground/90 cursor-default">
                              {truncate(r.claim, 60)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-md text-xs">
                            <div className="font-semibold mb-0.5">{r.claim}</div>
                            {r.tickers.length > 0 && (
                              <div className="text-muted-foreground font-mono">
                                {r.tickers.join(', ')} · horizon: {r.horizon}
                              </div>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      </td>
                      <td className="py-1.5 px-2">
                        <Badge
                          variant="outline"
                          className={`text-[10px] px-1.5 py-0 ${STATUS_STYLE[r.status] ?? ''}`}
                        >
                          {r.status}
                        </Badge>
                      </td>
                      <td className="py-1.5 px-2">
                        <ConfidenceBar value={r.confidence} />
                      </td>
                      <td className="py-1.5 px-2">
                        <div className="flex items-center gap-1">
                          <span className="font-mono font-semibold text-foreground">
                            {r.elo}
                          </span>
                          <TrendArrow trend={trend} />
                        </div>
                      </td>
                      <td className="py-1.5 px-2">
                        <span className="font-mono text-[11px] text-foreground/80">
                          {r.total_grades}
                        </span>
                        <span className="text-muted-foreground text-[10px] ml-1">
                          ({r.wins}W · {r.losses}L)
                        </span>
                      </td>
                      <td className="py-1.5 px-2">
                        <WinRateCell rate={r.win_rate} />
                      </td>
                      <td className="py-1.5 px-2">
                        <CalibrationCell delta={r.calibration_delta} />
                      </td>
                      <td className="py-1.5 px-2">
                        <Link
                          to={`/workspace?focus=${r.hypothesis_id}`}
                          title="Open in Workspace"
                          className="text-muted-foreground hover:text-foreground transition-colors inline-flex"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </TooltipProvider>
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
        Win rate = right / (right + wrong + partial). Trend arrow reflects the
        most recent Elo or confidence update per thesis. Calibration delta:
        positive = underconfident, negative = overconfident.
      </div>
    </Card>
  );
}
