/**
 * OvernightPositioning — per-ticker grouping of overnight OI shifts.
 *
 * v2 layout: one row per watchlist ticker. Each row = ticker label on the
 * left + horizontal mini-strip of that ticker's top OI shifts on the right.
 * Rationale: a single cross-ticker strip sorted by |oi_delta| hides non-SPY
 * activity behind the right-scroll on big SPY days. Per-ticker rows give
 * James a at-a-glance "who positioned where" read for all 10 specialists.
 *
 * Data: ct_top_oi_shifts RPC returns cross-ticker. We pull 100 shifts and
 * bucket in JS (RPC has no per-ticker cap). Click card → ContractSheet,
 * click ticker label → TickerSheet.
 */

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { TrendingUp, TrendingDown, Activity } from 'lucide-react';
import { useMemo } from 'react';
import {
  useOvernightPositioning,
  normalizeSide,
  formatDollarsCompact,
  formatDeltaContracts,
  formatExpiryShort,
  formatMoneyness,
  type OiShiftRow,
} from '@/hooks/useOvernightPositioning';

// 10 specialist tickers — order mirrors TICKERS in Tape.tsx / MacroBanner.
const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

// Per-ticker cap — UI-side because RPC returns flat cross-ticker set.
const PER_TICKER_LIMIT = 10;

// Hook limit — enough to ensure each ticker has shots at shifts even if
// one ticker dominates. 100 covers a big-SPY day and still leaves room.
const FETCH_LIMIT = 100;

interface Props {
  onContractClick?: (optionSymbol: string, ticker: string) => void;
  onTickerClick?: (ticker: string) => void;
}

function ShiftCard({
  r,
  onContractClick,
}: {
  r: OiShiftRow;
  onContractClick?: (optionSymbol: string, ticker: string) => void;
}) {
  const side = normalizeSide(r.side);
  const { label: moneyLabel } = formatMoneyness(r.distance_from_spot_pct, side);
  const delta = r.delta_contracts;
  const isAccum = delta != null && delta > 0;
  return (
    <button
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
}

export function OvernightPositioning({ onContractClick, onTickerClick }: Props) {
  const { data, isLoading, isError, error } = useOvernightPositioning(undefined, FETCH_LIMIT);

  const rows = data ?? [];
  const first = rows[0];
  const headerSuffix = first && (first.snap_date || first.snap_slot)
    ? ` — ${first.snap_date ?? ''}${first.snap_slot ? ` ${first.snap_slot}` : ''}`.trim()
    : '';

  // Bucket shifts by ticker, cap at PER_TICKER_LIMIT, sort within bucket by
  // |delta_contracts| descending. RPC is ordered globally, so per-ticker
  // order within is already |delta| desc — we just slice.
  const byTicker = useMemo(() => {
    const map = new Map<string, OiShiftRow[]>();
    for (const r of rows) {
      const arr = map.get(r.ticker) ?? [];
      if (arr.length < PER_TICKER_LIMIT) arr.push(r);
      map.set(r.ticker, arr);
    }
    // Ensure each bucket is sorted by |delta_contracts| desc. Defensive —
    // RPC already does this but guards against future RPC changes.
    for (const [, arr] of map) {
      arr.sort((a, b) => Math.abs(b.delta_contracts ?? 0) - Math.abs(a.delta_contracts ?? 0));
    }
    return map;
  }, [rows]);

  const totalShown = useMemo(() => {
    let n = 0;
    for (const arr of byTicker.values()) n += arr.length;
    return n;
  }, [byTicker]);

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
        <Activity className="w-3.5 h-3.5" />
        Overnight Positioning{headerSuffix}
        {!isLoading && !isError && totalShown > 0 && (
          <span className="text-[10px] normal-case text-muted-foreground/70 ml-auto">
            top {totalShown} OI shifts · refreshes every 5m
          </span>
        )}
      </div>

      {isError ? (
        <div className="text-[11px] text-red-300 px-1 py-2">
          Couldn't load overnight positioning: {error instanceof Error ? error.message : 'unknown error'}
        </div>
      ) : isLoading && rows.length === 0 ? (
        <div className="space-y-1">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="h-10 animate-pulse bg-muted/20" />
          ))}
        </div>
      ) : (
        <div className="space-y-1">
          {WATCHLIST.map((ticker) => {
            const shifts = byTicker.get(ticker) ?? [];
            return (
              <div
                key={ticker}
                className="flex items-center gap-2 rounded-md bg-card/40 border border-border/40 px-2 py-1.5"
              >
                {/* Ticker label — clickable, opens TickerSheet */}
                <button
                  onClick={() => onTickerClick?.(ticker)}
                  className={cn(
                    'shrink-0 w-12 text-left font-mono font-bold text-sm',
                    'text-foreground hover:text-primary transition-colors',
                    'underline decoration-dotted underline-offset-2',
                  )}
                  title={`Open ${ticker} briefing`}
                >
                  {ticker}
                </button>

                {/* Per-ticker mini-strip */}
                {shifts.length === 0 ? (
                  <div className="text-[11px] text-muted-foreground/70 italic">
                    no significant overnight positioning
                  </div>
                ) : (
                  <div className="flex gap-2 overflow-x-auto pb-0.5 snap-x snap-mandatory flex-1">
                    {shifts.map((r) => (
                      <ShiftCard
                        key={r.option_symbol + (r.snap_date ?? '') + (r.snap_slot ?? '')}
                        r={r}
                        onContractClick={onContractClick}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
