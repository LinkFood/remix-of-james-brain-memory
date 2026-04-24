/**
 * OvernightPositioning — horizontal strip of pill-cards above /tape.
 *
 * Reads ct_top_oi_shifts RPC (top 20 OI accumulations across all 10 specialist
 * tickers, pre-open). One card per row. Click → parent opens ContractSheet.
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, Activity } from 'lucide-react';
import {
  useOvernightPositioning,
  normalizeSide,
  formatDollarsCompact,
  formatDeltaContracts,
  formatExpiryShort,
  formatMoneyness,
} from '@/hooks/useOvernightPositioning';

interface Props {
  onContractClick?: (optionSymbol: string, ticker: string) => void;
}

export function OvernightPositioning({ onContractClick }: Props) {
  const { data, isLoading, isError, error } = useOvernightPositioning(undefined, 20);

  const rows = data ?? [];
  const first = rows[0];
  const headerSuffix = first && (first.snap_date || first.snap_slot)
    ? ` — ${first.snap_date ?? ''}${first.snap_slot ? ` ${first.snap_slot}` : ''}`.trim()
    : '';

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
        <Activity className="w-3.5 h-3.5" />
        Overnight Positioning{headerSuffix}
        {!isLoading && !isError && rows.length > 0 && (
          <span className="text-[10px] normal-case text-muted-foreground/70 ml-auto">
            top {rows.length} OI shifts · refreshes every 5m
          </span>
        )}
      </div>

      {isError ? (
        <div className="text-[11px] text-red-300 px-1 py-2">
          Couldn't load overnight positioning: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      ) : isLoading && rows.length === 0 ? (
        <div className="flex gap-2 overflow-hidden">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="shrink-0 w-56 h-[72px] animate-pulse bg-muted/20" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic px-1 py-2">
          No significant OI shifts captured yet for today's snapshot.
        </div>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1 snap-x snap-mandatory">
          {rows.map((r) => {
            const side = normalizeSide(r.side);
            const { label: moneyLabel } = formatMoneyness(r.distance_from_spot_pct, side);
            const delta = r.delta_contracts;
            const isAccum = delta != null && delta > 0;
            return (
              <button
                key={r.option_symbol + (r.snap_date ?? '') + (r.snap_slot ?? '')}
                onClick={() => onContractClick?.(r.option_symbol, r.ticker)}
                className={cn(
                  'snap-start shrink-0 text-left rounded-md border px-3 py-2 transition-colors',
                  'bg-card hover:bg-muted/40',
                  side === 'call' && 'border-emerald-500/30 hover:border-emerald-500/50',
                  side === 'put' && 'border-rose-500/30 hover:border-rose-500/50',
                  !side && 'border-border',
                )}
                title={r.option_symbol}
              >
                <div className="flex items-center gap-2 text-[11px] font-mono leading-tight whitespace-nowrap">
                  <span className="font-bold text-sm text-foreground">{r.ticker}</span>
                  <span className={cn(
                    'font-semibold tabular-nums',
                    side === 'call' && 'text-emerald-300',
                    side === 'put' && 'text-rose-300',
                    !side && 'text-foreground/80',
                  )}>
                    {r.strike != null ? `${Math.round(r.strike)}` : '?'}
                    {side === 'call' ? 'C' : side === 'put' ? 'P' : ''}
                  </span>
                  <span className="text-muted-foreground">{formatExpiryShort(r.expiry)}</span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-[11px] font-mono whitespace-nowrap">
                  <span className={cn(
                    'font-bold tabular-nums inline-flex items-center gap-0.5',
                    isAccum ? 'text-emerald-400' : 'text-rose-400',
                  )}>
                    {isAccum ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {formatDeltaContracts(delta)} OI
                  </span>
                  <span className="text-foreground/80 tabular-nums">
                    {formatDollarsCompact(r.dollars_at_risk)}
                  </span>
                  {moneyLabel !== '-' && (
                    <span className="text-muted-foreground tabular-nums">{moneyLabel}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
