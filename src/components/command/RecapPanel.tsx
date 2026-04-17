import { useLatestRecap } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Calendar, Sparkles } from 'lucide-react';

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function RecapPanel() {
  const { data: recap, isLoading } = useLatestRecap();

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Calendar className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Latest Recap</h3>
        {recap && (
          <span className="text-[10px] text-muted-foreground ml-auto">
            {recap.report_type} · {fmtDate(recap.period_start)}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="text-sm text-muted-foreground">loading…</div>
      ) : !recap ? (
        <div className="text-sm text-muted-foreground">no recap written yet — EOD runs at 21:30 UTC weekdays</div>
      ) : (
        <div className="space-y-3 text-xs">
          <div>
            <div className="text-[10px] uppercase text-muted-foreground mb-1">Summary</div>
            <p className="text-foreground/90 whitespace-pre-wrap leading-relaxed">{recap.summary}</p>
          </div>

          {recap.rabbit_hole && (
            <div>
              <div className="text-[10px] uppercase text-muted-foreground mb-1 flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> Today's Rabbit Hole
              </div>
              <p className="text-foreground/85 whitespace-pre-wrap leading-relaxed italic">{recap.rabbit_hole}</p>
            </div>
          )}

          {recap.self_assessment && (
            <div>
              <div className="text-[10px] uppercase text-muted-foreground mb-1">Self-Assessment</div>
              <p className="text-foreground/75 whitespace-pre-wrap leading-relaxed">{recap.self_assessment}</p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
