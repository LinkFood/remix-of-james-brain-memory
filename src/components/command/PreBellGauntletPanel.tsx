/**
 * PreBellGauntletPanel — today's three committed predictions from the
 * 9:25 ET gauntlet, with live grading status. Cleanest calibration
 * signal the system produces — no hindsight contamination.
 */
import { useTodayGauntlet, type PreBellPrediction } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Target, TrendingUp, Activity } from 'lucide-react';

const slotLabel: Record<PreBellPrediction['prediction_slot'], string> = {
  spy_10am: 'SPY direction at 10:00 AM ET',
  unusual_flow: 'Unusual flow (>$5M premium)',
  lagging_sector: 'Lagging sector (vs SPY by close)',
};

const slotIcon: Record<PreBellPrediction['prediction_slot'], typeof Target> = {
  spy_10am: Activity,
  unusual_flow: TrendingUp,
  lagging_sector: Target,
};

function verdictCls(v: PreBellPrediction['verdict']): string {
  if (v === 'right') return 'bg-emerald-500/20 text-emerald-300';
  if (v === 'wrong') return 'bg-red-500/20 text-red-300';
  if (v === 'partial') return 'bg-amber-500/20 text-amber-200';
  if (v === 'ambiguous') return 'bg-muted text-muted-foreground';
  return 'bg-muted/60 text-muted-foreground';
}

function formatPrediction(slot: PreBellPrediction['prediction_slot'], p: Record<string, unknown>): string {
  if (slot === 'spy_10am') {
    const dir = p.direction as string;
    const t = p.threshold as string;
    return `${dir?.toUpperCase() ?? '?'} — ${t ?? ''}`;
  }
  if (slot === 'unusual_flow') {
    const ticker = p.ticker as string;
    const side = p.most_likely_side as string;
    return `${ticker ?? '?'} ${side ?? ''} contract print`;
  }
  if (slot === 'lagging_sector') {
    return `${p.sector_etf as string ?? '?'} underperforms SPY by >0.5%`;
  }
  return JSON.stringify(p);
}

export function PreBellGauntletPanel() {
  const { data: rows, isLoading } = useTodayGauntlet();

  const committed = rows?.length ?? 0;
  const graded = rows?.filter(r => r.verdict != null).length ?? 0;
  const right = rows?.filter(r => r.verdict === 'right').length ?? 0;

  return (
    <Card className="divide-y divide-border">
      <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-2">
        <Target className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Pre-Bell Gauntlet</h3>
        <span className="text-[10px] text-muted-foreground">today's committed calls — 9:25 ET</span>
        {committed > 0 && (
          <span className="text-[10px] text-muted-foreground ml-auto font-mono">
            {graded}/{committed} graded · {right} right
          </span>
        )}
      </div>
      {isLoading ? (
        <div className="p-4 text-xs text-muted-foreground">loading…</div>
      ) : !rows || rows.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground leading-relaxed">
          No predictions committed yet today. The gauntlet fires at 9:25 AM ET weekdays — Claude locks three calls (SPY direction, unusual-flow ticker, lagging sector) before the bell with no hindsight edits allowed.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {rows.map(r => {
            const Icon = slotIcon[r.prediction_slot];
            return (
              <div key={r.id} className="p-3 space-y-1.5">
                <div className="flex items-center gap-2 text-[10px]">
                  <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                  <span className="text-muted-foreground uppercase tracking-wide">{slotLabel[r.prediction_slot]}</span>
                  <Badge variant="outline" className="ml-auto font-mono text-[9px]">conf {r.confidence}/5</Badge>
                  {r.verdict && (
                    <Badge className={`text-[9px] ${verdictCls(r.verdict)}`}>{r.verdict}</Badge>
                  )}
                </div>
                <div className="text-sm font-semibold text-foreground">
                  {formatPrediction(r.prediction_slot, r.prediction)}
                </div>
                {r.rationale && (
                  <div className="text-[11px] text-muted-foreground leading-relaxed">{r.rationale}</div>
                )}
                {r.actual_outcome && (
                  <div className="text-[10px] font-mono text-foreground/70 bg-muted/30 px-2 py-1 rounded">
                    outcome: {JSON.stringify(r.actual_outcome)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
