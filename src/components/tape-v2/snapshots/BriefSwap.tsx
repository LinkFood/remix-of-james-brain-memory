/**
 * BriefSwap — Morning Brief / EOD Report time-of-day snapshot for the v2
 * Tape command-center right rail.
 *
 * Phase swap (locked default 13:30 UTC RTH open / 20:00 UTC RTH close):
 *   pre_open  → Morning Brief excerpt (macro narrative + top conviction idea)
 *   rth       → most-recent brief (whichever fired last today)
 *   post_close → EOD Report excerpt (regime close + scorecard summary)
 *
 * Reuses useMorningBrief + useEodReport (both exist on main, no new query).
 * Compact rendering: title + 1-2 line summary + click-through link.
 */

import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Sun, Moon, ArrowUpRight } from 'lucide-react';
import { useMorningBrief } from '@/hooks/useMorningBrief';
import { useEodReport } from '@/hooks/useEodReport';
import { useEtPhaseBucket } from '@/hooks/useEtPhaseBucket';

export function BriefSwap() {
  const phase = useEtPhaseBucket();
  const showEod = phase === 'post_close';
  const showMorning = phase === 'pre_open';

  // RTH default: morning brief (it fires at 7am ET, lives through the
  // session). Captain can override later via collapse-state if needed.
  const { data: morningRows, isLoading: morningLoading } = useMorningBrief('today');
  const { data: eodRows, isLoading: eodLoading } = useEodReport();

  const morningBrief = Array.isArray(morningRows) && morningRows.length > 0 ? morningRows[0] : null;
  const eodReport = Array.isArray(eodRows) && eodRows.length > 0 ? eodRows[0] : null;

  if (showEod) {
    return (
      <Card className="p-2.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            <Moon className="w-3 h-3" />
            EOD Report
          </span>
          <Link
            to="/eod-report"
            className="inline-flex items-center gap-0.5 text-[10px] text-primary/70 hover:text-primary transition-colors"
          >
            full <ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>

        {eodLoading && !eodReport && (
          <div className="text-[10px] text-muted-foreground italic px-1 py-2">loading…</div>
        )}

        {!eodLoading && !eodReport && (
          <div className="text-[10px] text-muted-foreground italic px-1 py-2">no report yet today</div>
        )}

        {eodReport && (
          <div className="space-y-1">
            {eodReport.regime_close && (
              <div className="text-[10px] font-mono text-foreground/80 uppercase">
                regime · {String(eodReport.regime_close)}
              </div>
            )}
            {eodReport.session_summary && (
              <div className="text-[11px] leading-tight text-foreground/85 line-clamp-3">
                {eodReport.session_summary}
              </div>
            )}
          </div>
        )}
      </Card>
    );
  }

  // Pre-open or RTH: show morning brief.
  return (
    <Card className="p-2.5">
      <div className="flex items-center justify-between mb-1.5">
        <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
          <Sun className={cn('w-3 h-3', showMorning && 'text-amber-300')} />
          Morning Brief
        </span>
        <Link
          to="/morning-brief"
          className="inline-flex items-center gap-0.5 text-[10px] text-primary/70 hover:text-primary transition-colors"
        >
          full <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>

      {morningLoading && !morningBrief && (
        <div className="text-[10px] text-muted-foreground italic px-1 py-2">loading…</div>
      )}

      {!morningLoading && !morningBrief && (
        <div className="text-[10px] text-muted-foreground italic px-1 py-2">no brief yet today</div>
      )}

      {morningBrief && (
        <div className="space-y-1">
          {morningBrief.macro_regime && (
            <div className="text-[10px] font-mono text-foreground/80 uppercase">
              regime · {String(morningBrief.macro_regime)}
            </div>
          )}
          {morningBrief.macro_narrative && (
            <div className="text-[11px] leading-tight text-foreground/85 line-clamp-3">
              {String(morningBrief.macro_narrative)}
            </div>
          )}
          {Array.isArray(morningBrief.high_conviction_ideas) && morningBrief.high_conviction_ideas.length > 0 && (
            <div className="text-[10px] text-muted-foreground line-clamp-1">
              <span className="font-mono uppercase tracking-wider mr-1">HCI:</span>
              {morningBrief.high_conviction_ideas
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                .slice(0, 2).map((i: any) => i?.ticker ?? i?.symbol ?? '?').join(' · ')}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
