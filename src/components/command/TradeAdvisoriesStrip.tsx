/**
 * TradeAdvisoriesStrip — top-of-right-sidebar pill strip on CommandStation
 * surfacing the highest-urgency unacked trade advisories. Shows at most 5.
 *
 * Each pill: urgency color + instrument + advisory verb + 1-line reasoning
 * (truncated). Click → scrolls the Book page into view via in-app link.
 * A lightweight Ack button lets James dismiss from the strip without
 * navigating. Once acked, the pill disappears from this list (hook polls
 * every 30s).
 *
 * Hidden entirely when no unacked advisories exist (no empty-state chrome —
 * the sidebar has enough going on already).
 */
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { MessageSquareWarning, Check } from 'lucide-react';
import {
  useTopUnackedAdvisories,
  useAckAdvisory,
  advisoryTypeLabel,
  urgencyClasses,
  type CtTradeAdvisoryRow,
} from '@/hooks/useTradeAdvisories';
import { supabase } from '@/integrations/supabase/client';
import { useQuery } from '@tanstack/react-query';
import { formatRelativeTime } from '@/hooks/useTradeJournal';

/**
 * Single-shot fetch to resolve trade_id → instrument + side so the pill
 * can show "SPY long" without every advisory row carrying the denorm.
 * Cached alongside the advisories query.
 */
function useAdvisoryTradeLookup(tradeIds: string[]) {
  return useQuery<Record<string, { instrument: string; side: string }>>({
    queryKey: ['ct_trade_advisories', 'trade_lookup', [...tradeIds].sort()],
    enabled: tradeIds.length > 0,
    staleTime: 60_000,
    queryFn: async () => {
      if (tradeIds.length === 0) return {};
      const { data, error } = await supabase
        .from('ct_trades')
        .select('id, instrument, side')
        .in('id', tradeIds);
      if (error) throw error;
      const map: Record<string, { instrument: string; side: string }> = {};
      for (const row of data ?? []) {
        map[(row as { id: string }).id] = {
          instrument: (row as { instrument: string }).instrument,
          side: (row as { side: string }).side,
        };
      }
      return map;
    },
  });
}

function AdvisoryPill({
  adv,
  tradeMeta,
}: {
  adv: CtTradeAdvisoryRow;
  tradeMeta: { instrument: string; side: string } | undefined;
}) {
  const ackMutation = useAckAdvisory();
  const label = tradeMeta
    ? `${tradeMeta.instrument} ${tradeMeta.side}`
    : 'trade';

  return (
    <li className={`rounded border px-2.5 py-2 text-[10px] space-y-1 ${urgencyClasses(adv.urgency)}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-semibold uppercase tracking-wide">
          u{adv.urgency} · {label} · {advisoryTypeLabel(adv.advisory_type)}
        </span>
        <span className="ml-auto text-[9px] opacity-70">
          {formatRelativeTime(adv.created_at)}
        </span>
      </div>
      <p className="leading-snug opacity-95 line-clamp-3">{adv.reasoning}</p>
      <div className="flex items-center gap-2 pt-0.5">
        <Link
          to="/book#trades-table"
          className="text-[9px] underline underline-offset-2 opacity-80 hover:opacity-100"
        >
          view trade
        </Link>
        <Button
          size="sm"
          variant="ghost"
          className="h-5 px-1.5 text-[9px] ml-auto gap-1"
          disabled={ackMutation.isPending}
          onClick={() => ackMutation.mutate(adv.id)}
        >
          <Check className="w-2.5 h-2.5" />
          ack
        </Button>
      </div>
    </li>
  );
}

export function TradeAdvisoriesStrip() {
  const { data: advisories, isLoading } = useTopUnackedAdvisories(5);
  const tradeIds = (advisories ?? []).map(a => a.trade_id);
  const { data: tradeMap } = useAdvisoryTradeLookup(tradeIds);

  // Hide entirely when nothing unacked — no empty-state chrome in the sidebar.
  if (isLoading) return null;
  if (!advisories || advisories.length === 0) return null;

  return (
    <Card className="border-primary/30">
      <div className="px-3 py-2 border-b border-border/60 bg-muted/10 flex items-center gap-2">
        <MessageSquareWarning className="w-3.5 h-3.5 text-primary" />
        <h3 className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
          Advisories
        </h3>
        <span className="text-[9px] text-muted-foreground">
          {advisories.length} unacked
        </span>
        <span className="ml-auto text-[9px] text-muted-foreground italic">
          advisory only
        </span>
      </div>
      <ul className="p-2 space-y-1.5">
        {advisories.map(a => (
          <AdvisoryPill
            key={a.id}
            adv={a}
            tradeMeta={tradeMap?.[a.trade_id]}
          />
        ))}
      </ul>
    </Card>
  );
}
