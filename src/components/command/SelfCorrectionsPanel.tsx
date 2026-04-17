/**
 * SelfCorrectionsPanel — Claude's own hindsight on recent calls.
 *
 * ct_self_regrades has "what I got wrong" + "how I'd rewrite" pairs
 * that the self-grader writes automatically. Surfacing them here makes
 * the chess-engine feedback loop visible to James, and also a gut-check
 * on whether Claude's mistakes are getting smaller over time.
 */
import { useRecentSelfCorrections } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Brain } from 'lucide-react';

function relTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

function confDelta(orig: number | null, retro: number | null): string {
  if (orig == null || retro == null) return '';
  const d = retro - orig;
  if (d === 0) return 'held';
  return d > 0 ? `+${d} conv` : `${d} conv`;
}

export function SelfCorrectionsPanel() {
  const { data: rows, isLoading } = useRecentSelfCorrections(6);

  return (
    <Card className="divide-y divide-border">
      <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-2">
        <Brain className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Claude's Self-Corrections</h3>
        <span className="text-[10px] text-muted-foreground ml-auto">what I got wrong · how I'd rewrite</span>
      </div>
      {isLoading ? (
        <div className="p-4 text-xs text-muted-foreground">loading…</div>
      ) : !rows || rows.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground leading-relaxed">
          No self-corrections yet. After a call gets graded, Claude re-reads the same tape with hindsight and writes what it missed here. The watcher sees these on the next tick — chess-engine feedback loop.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {rows.map(r => (
            <div key={r.id} className="p-3 space-y-2">
              <div className="flex items-center gap-2 text-[10px]">
                <Badge variant="outline" className="font-mono">{r.subject_type}</Badge>
                {r.grader_verdict && (
                  <Badge
                    className={
                      r.grader_verdict === 'right' ? 'bg-emerald-500/20 text-emerald-300' :
                      r.grader_verdict === 'wrong' ? 'bg-red-500/20 text-red-300' :
                      'bg-amber-500/20 text-amber-200'
                    }
                  >
                    {r.grader_verdict}
                  </Badge>
                )}
                <span className="text-muted-foreground">{confDelta(r.original_confidence, r.retrospective_confidence)}</span>
                <span className="text-muted-foreground ml-auto">{relTime(r.regraded_at)}</span>
              </div>
              {r.what_i_got_wrong && (
                <div className="text-[11px]">
                  <span className="text-red-400/80 font-semibold">wrong:</span>{' '}
                  <span className="text-foreground/85">{r.what_i_got_wrong}</span>
                </div>
              )}
              {r.how_id_rewrite && (
                <div className="text-[11px]">
                  <span className="text-emerald-400/80 font-semibold">rewrite:</span>{' '}
                  <span className="text-foreground/85">{r.how_id_rewrite}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
