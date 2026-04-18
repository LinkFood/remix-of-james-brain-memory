/**
 * AlertPostMortemsPanel — forensic autopsies on wrong alerts.
 *
 * ct-grader labels; this panel shows the why. Last 20 post-mortems with the
 * five structured fields Claude wrote. Axis-count strip up top surfaces the
 * systematically weak axis ("Axis A has 14 post-mortem cites"). Cross-links
 * to AxisAttributionPanel by letter — same A..F taxonomy.
 */
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skull, AlertTriangle } from 'lucide-react';
import { useAlertPostMortems, type PostMortemAxis, type AlertPostMortem } from '@/hooks/useAlertPostMortems';
import { AXIS_NAMES, AXIS_DESCRIPTIONS } from '@/hooks/useAxisAttribution';

const AXIS_LETTERS: PostMortemAxis[] = ['A', 'B', 'C', 'D', 'E', 'F'];

function confidenceColor(c: number): string {
  if (c >= 4) return 'text-green-400';
  if (c >= 3) return 'text-amber-400';
  return 'text-muted-foreground';
}

export function AlertPostMortemsPanel() {
  const { rows, axisCounts, total, misremembered, isLoading } = useAlertPostMortems();

  const worstAxis = [...axisCounts].sort((a, b) => b.count - a.count)[0];

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
        <Skull className="w-3 h-3" /> Wrong-Alert Post-Mortems
        <span className="normal-case tracking-normal text-muted-foreground/70">
          — forensic autopsy of each wrong alert (Haiku, cheap, honest)
        </span>
        <span className="ml-auto normal-case tracking-normal font-mono">n={total}</span>
      </div>

      {isLoading && rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          no post-mortems yet — cron writes one per wrong alert / flag every 30 min.
        </div>
      ) : (
        <>
          {/* Axis rollup — which axis is systematically the false signal. */}
          <div className="mb-4">
            <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Weakest-axis cites · last {total}
              {misremembered > 0 && (
                <span className="normal-case tracking-normal text-amber-400 ml-1">
                  · {misremembered} misremembered
                </span>
              )}
              {worstAxis && worstAxis.count > 0 && (
                <span className="ml-auto normal-case tracking-normal text-[11px] text-foreground/80">
                  Axis {worstAxis.axis} leads at {worstAxis.count} cites · cross-ref Axis Attribution above
                </span>
              )}
            </div>
            <div className="grid grid-cols-6 gap-2">
              {AXIS_LETTERS.map(axis => {
                const count = axisCounts.find(a => a.axis === axis)?.count ?? 0;
                const max = Math.max(1, ...axisCounts.map(a => a.count));
                const intensity = count / max;
                const bg = count === 0
                  ? 'bg-muted/20'
                  : intensity >= 0.66 ? 'bg-red-500/20'
                  : intensity >= 0.33 ? 'bg-amber-500/15'
                  : 'bg-muted/30';
                return (
                  <div key={axis} className={`rounded p-2 text-center ${bg}`}>
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      axis {axis}
                    </div>
                    <div className="text-lg font-bold text-foreground font-mono">{count}</div>
                    <div className="text-[10px] text-muted-foreground truncate" title={AXIS_DESCRIPTIONS[axis]}>
                      {AXIS_NAMES[axis]}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Row list. */}
          <div className="divide-y divide-border max-h-[60vh] overflow-y-auto">
            {rows.map(r => (
              <PostMortemRow key={r.id} row={r} />
            ))}
          </div>
        </>
      )}

      <div className="mt-3 text-[10px] text-muted-foreground leading-relaxed">
        <span className="text-foreground/80 font-semibold">Read this:</span>{' '}
        One row per wrong alert. The weakest-axis count is the systemic signal —
        an axis cited 10+ times here is an axis the watcher leans on that isn't
        paying. Cross-reference Axis Attribution above: if that axis also shows
        a weak hit rate, there's the structural fix. Bias_implicated feeds back
        into ct_biases (existing match → observed_count++, new → seeded at
        severity 3 pending meta review).
      </div>
    </Card>
  );
}

function PostMortemRow({ row }: { row: AlertPostMortem }) {
  const confColor = confidenceColor(row.confidence_in_lesson);
  return (
    <div className="px-1 py-3 hover:bg-muted/20 transition-colors">
      <div className="flex items-center gap-2 text-[11px] mb-1.5">
        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
          {row.alert_kind}
        </Badge>
        {row.weakest_evidence_axis && (
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 bg-red-500/10 text-red-300 border-red-500/30"
            title={`${AXIS_NAMES[row.weakest_evidence_axis]} — ${AXIS_DESCRIPTIONS[row.weakest_evidence_axis]}`}
          >
            weak axis {row.weakest_evidence_axis}
          </Badge>
        )}
        {row.axis_misremembered && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-500/10 text-amber-400 border-amber-500/30" title="Claude cited an axis the alert didn't actually include — ignore with suspicion.">
            <AlertTriangle className="w-3 h-3 mr-1" />
            misremembered
          </Badge>
        )}
        {row.bias_implicated && row.bias_implicated.toLowerCase() !== 'none' && (
          <Badge
            variant="outline"
            className="text-[10px] px-1.5 py-0 bg-purple-500/10 text-purple-300 border-purple-500/30"
            title="Matched or seeded into ct_biases"
          >
            bias: {row.bias_implicated}
          </Badge>
        )}
        <span className={`ml-auto font-mono ${confColor}`} title="Claude's confidence the lesson generalizes (1-5)">
          conf {row.confidence_in_lesson}/5
        </span>
        <span className="text-[10px] text-muted-foreground">
          {new Date(row.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            what missed
          </div>
          <div className="text-foreground/90 leading-snug">{row.what_missed}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-0.5">
            lesson
          </div>
          <div className="text-foreground/90 leading-snug">{row.lesson}</div>
        </div>
      </div>

      <div className="text-[10px] text-muted-foreground mt-1.5 font-mono">
        alert_id: {row.alert_id.slice(0, 8)}…
        {typeof row.cost_usd === 'number' && <span className="ml-3">cost ${row.cost_usd.toFixed(4)}</span>}
      </div>
    </div>
  );
}
