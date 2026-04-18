/**
 * TradeAdvisoriesPanel — list of Claude's advisory (non-executing)
 * recommendations for a single trade. Rendered inside the Trade Journal
 * expandable row on /book.
 *
 * Each row shows:
 *   - urgency pill (1-5, color-coded)
 *   - advisory verb (hold / tighten_stop / trail / cut / scale_out / flip?)
 *   - reasoning (Claude's 2-sentence rationale)
 *   - relative timestamp
 *   - ack checkbox (flips acknowledged_by_james=true)
 *
 * The panel polls every 30s via the hook's refetchInterval — so new
 * advisories land automatically between clicks. Empty state is explicit
 * (we never silently show nothing).
 */
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  useTradeAdvisoriesForTrade,
  useAckAdvisory,
  advisoryTypeLabel,
  urgencyClasses,
  type CtTradeAdvisoryRow,
} from '@/hooks/useTradeAdvisories';
import { formatRelativeTime } from '@/hooks/useTradeJournal';
import { MessageSquareWarning } from 'lucide-react';

function AdvisoryRow({ adv }: { adv: CtTradeAdvisoryRow }) {
  const ackMutation = useAckAdvisory();
  const ackDisabled = ackMutation.isPending || adv.acknowledged_by_james;

  return (
    <li
      className={`flex items-start gap-3 rounded border px-3 py-2 text-[11px] ${
        adv.acknowledged_by_james
          ? 'bg-muted/5 border-border/40 opacity-60'
          : 'bg-background/40 border-border/70'
      }`}
    >
      <Checkbox
        checked={adv.acknowledged_by_james}
        disabled={ackDisabled}
        onCheckedChange={() => {
          if (!adv.acknowledged_by_james) ackMutation.mutate(adv.id);
        }}
        className="mt-0.5"
        aria-label="Acknowledge advisory"
      />
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="outline"
            className={`${urgencyClasses(adv.urgency)} text-[9px] px-1.5 py-0 font-semibold uppercase tracking-wide`}
          >
            u{adv.urgency}
          </Badge>
          <span className="text-[10px] uppercase tracking-wide font-medium text-foreground/90">
            {advisoryTypeLabel(adv.advisory_type)}
          </span>
          {adv.current_unrealized_pct != null && (
            <span className="text-[10px] font-mono text-muted-foreground">
              @ {adv.current_unrealized_pct >= 0 ? '+' : ''}
              {adv.current_unrealized_pct.toFixed(2)}%
            </span>
          )}
          <span className="ml-auto text-[9px] text-muted-foreground">
            {formatRelativeTime(adv.created_at)}
          </span>
        </div>
        <p className="text-foreground/90 leading-relaxed">{adv.reasoning}</p>
        {adv.acknowledged_by_james && adv.acknowledged_at && (
          <p className="text-[9px] text-muted-foreground italic">
            acked {formatRelativeTime(adv.acknowledged_at)}
          </p>
        )}
      </div>
    </li>
  );
}

export function TradeAdvisoriesPanel({ tradeId }: { tradeId: string }) {
  const { data, isLoading, error } = useTradeAdvisoriesForTrade(tradeId);

  return (
    <div className="border border-border/60 rounded bg-background/40 px-4 py-3">
      <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <MessageSquareWarning className="w-3.5 h-3.5 text-primary" />
          <h4 className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
            Claude's advisories
          </h4>
          {data && data.length > 0 && (
            <span className="text-[9px] text-muted-foreground">
              {data.filter(a => !a.acknowledged_by_james).length} unacked · {data.length} total
            </span>
          )}
        </div>
        <span className="text-[9px] text-muted-foreground italic">
          advisory only — nothing auto-executes
        </span>
      </div>

      {isLoading && (
        <p className="text-[11px] text-muted-foreground italic">loading advisories…</p>
      )}
      {error && (
        <p className="text-[11px] text-red-400">
          failed to load: {error instanceof Error ? error.message : String(error)}
        </p>
      )}
      {!isLoading && !error && (data?.length ?? 0) === 0 && (
        <p className="text-[11px] text-muted-foreground italic">
          No advisories yet. Advisory layer fires every 15min (offset from book-manager).
        </p>
      )}
      {data && data.length > 0 && (
        <ul className="space-y-2">
          {data.map(a => <AdvisoryRow key={a.id} adv={a} />)}
        </ul>
      )}
    </div>
  );
}
