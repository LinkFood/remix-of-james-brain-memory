/**
 * TickerChart — full-width standalone view of the session chart + alerts.
 *
 * Route: /chart/:symbol/:date   (date = YYYY-MM-DD, UTC)
 *
 * This is the "zoom in" view: same component as embedded in TickerTerminal
 * but taller, without surrounding page chrome, so it fills the viewport
 * for close auditing of alert timing vs price movement.
 */
import { memo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TickerChartWithAlerts } from '@/components/command/TickerChartWithAlerts';

const TickerChart = memo(function TickerChart() {
  const { symbol, date } = useParams<{ symbol: string; date: string }>();
  const ticker = (symbol ?? '').toUpperCase().trim();
  const sessionDate = (date ?? '').trim();

  if (!ticker) {
    return (
      <div className="min-h-screen bg-background text-foreground p-6">
        <div className="text-sm text-muted-foreground">No ticker specified.</div>
      </div>
    );
  }

  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(sessionDate);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button asChild size="sm" variant="ghost" className="h-8 w-8 p-0">
              <Link to={`/ticker/${ticker}`} aria-label={`back to ${ticker} terminal`}>
                <ArrowLeft className="w-4 h-4" />
              </Link>
            </Button>
            <div className="flex items-baseline gap-3">
              <h1 className="text-2xl font-bold tracking-tight">{ticker}</h1>
              <span className="text-sm text-muted-foreground tabular-nums">
                {validDate ? sessionDate : '(invalid date — showing today)'}
              </span>
            </div>
          </div>
          <span className="text-[10px] text-muted-foreground">
            full-width · 15-min heartbeat granularity
          </span>
        </header>

        <Card className="p-4 bg-black/60 border-white/10">
          <TickerChartWithAlerts
            ticker={ticker}
            sessionDate={validDate ? sessionDate : undefined}
            standalone
          />
        </Card>

        <footer className="pt-2 text-[10px] text-muted-foreground/60 text-center">
          30s refresh · reads ct_heartbeats, ct_alerts, ct_flags, ct_grades · no new UW calls
        </footer>
      </div>
    </div>
  );
});

export default TickerChart;
