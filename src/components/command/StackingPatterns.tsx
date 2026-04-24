/**
 * StackingPatterns — leaderboard of contracts being hit repeatedly in the
 * current session. A single row per contract (not per print), sorted by
 * prints_count desc. Click a row → ContractSheet drill-down (same mechanism
 * as OvernightPositioning / Tape rows).
 *
 * Default collapsed. When collapsed, the header carries the summary:
 *   "STACKING — 8 contracts stacking today · 2 accelerating"
 * Expanded, shows a compact table (contract, prints, $ cum, ask%, buy/sell,
 * last, accel). Ask% is tinted emerald/rose by side-dominance threshold.
 *
 * RPC-not-ready case: skeleton shows, no error banner. Leaderboard polls
 * every 30s so it self-recovers once the migration lands.
 */

import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Activity, ChevronDown, ChevronUp, Zap } from 'lucide-react';
import {
  useContractStacking,
  formatStackCount,
  formatStackPremium,
  formatTimeAgo,
  type StackRow,
} from '@/hooks/useContractStacking';

interface Props {
  onContractClick?: (optionSymbol: string, ticker: string) => void;
  /** Window in minutes — default matches hook default (6h session). */
  windowMin?: number;
}

const STORAGE_KEY = 'ct_stacking_collapsed';

function sideLetter(side: string): 'C' | 'P' | null {
  if (!side) return null;
  const u = side.toUpperCase();
  if (u.startsWith('C')) return 'C';
  if (u.startsWith('P')) return 'P';
  return null;
}

function askPctTint(pct: number | null): string {
  if (pct == null) return 'text-muted-foreground';
  if (pct > 70) return 'text-emerald-300';
  if (pct < 30) return 'text-rose-300';
  return 'text-muted-foreground';
}

function formatExpiryShort(iso: string | null): string {
  if (!iso) return '-';
  // YYYY-MM-DD → M/D
  const parts = iso.slice(0, 10).split('-');
  if (parts.length !== 3) return iso;
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isFinite(m) || !Number.isFinite(d)) return iso;
  return `${m}/${d}`;
}

function StackRowItem({
  r,
  onContractClick,
}: {
  r: StackRow;
  onContractClick?: (sym: string, ticker: string) => void;
}) {
  const side = sideLetter(r.side);
  return (
    <tr
      onClick={() => onContractClick?.(r.option_symbol, r.ticker)}
      className="cursor-pointer hover:bg-muted/40 border-b border-border/50 transition-colors"
    >
      {/* Contract */}
      <td className="py-1.5 px-2 font-mono whitespace-nowrap">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="font-bold text-foreground">{r.ticker}</span>
          <span className="tabular-nums text-foreground/90">
            {r.strike != null ? `$${Math.round(r.strike)}` : '?'}
          </span>
          <span
            className={cn(
              'font-bold',
              side === 'C' && 'text-emerald-400',
              side === 'P' && 'text-rose-400',
              !side && 'text-muted-foreground',
            )}
          >
            {side ?? '?'}
          </span>
          <span className="text-muted-foreground tabular-nums">{formatExpiryShort(r.expiry)}</span>
        </div>
      </td>
      {/* Prints — big */}
      <td className="py-1.5 px-2 text-right font-mono tabular-nums">
        <span className="text-base font-bold text-foreground">{r.prints_count}</span>
      </td>
      {/* Premium cumulative */}
      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-sm text-emerald-300">
        {formatStackPremium(r.premium_total)}
      </td>
      {/* Ask% */}
      <td className={cn('py-1.5 px-2 text-right font-mono tabular-nums text-xs', askPctTint(r.ask_dominant_pct))}>
        {r.ask_dominant_pct != null ? `${Math.round(r.ask_dominant_pct)}%` : '—'}
      </td>
      {/* Buy/Sell */}
      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-xs text-muted-foreground whitespace-nowrap">
        <span className="text-emerald-300">{r.opening_buy_count}</span>
        <span className="text-muted-foreground/60">/</span>
        <span className="text-rose-300">{r.opening_sell_count}</span>
      </td>
      {/* Last */}
      <td className="py-1.5 px-2 text-right font-mono tabular-nums text-xs text-muted-foreground whitespace-nowrap">
        {formatTimeAgo(r.last_ts)}
      </td>
      {/* Accel */}
      <td className="py-1.5 px-2 text-right whitespace-nowrap">
        {r.is_accelerating ? (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/40">
            <Zap className="w-3 h-3" />
            accel
          </span>
        ) : (
          <span className="text-muted-foreground/40 text-[10px]">—</span>
        )}
      </td>
    </tr>
  );
}

export function StackingPatterns({ onContractClick, windowMin = 360 }: Props) {
  const { rows, isLoading, isError } = useContractStacking(windowMin, 50);

  // Collapsed by default — live-market focus principle. Persist toggle.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === '1';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0');
    }
  }, [collapsed]);

  const acceleratingCount = useMemo(
    () => rows.filter((r) => r.is_accelerating).length,
    [rows],
  );

  const hours = Math.round(windowMin / 60);
  const windowLabel = hours >= 1 ? `last ${hours}h` : `last ${windowMin}m`;

  // Nothing to show AND not loading AND not errored (RPC-not-ready also lands here).
  // Silent — don't burn real estate during live market.
  if (!isLoading && !isError && rows.length === 0) {
    return null;
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2 hover:text-foreground transition-colors"
        title={collapsed ? 'Expand stacking patterns' : 'Collapse stacking patterns'}
      >
        {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        <Activity className="w-3.5 h-3.5" />
        <span>Stacking Patterns</span>
        {!isLoading && !isError && rows.length > 0 && (
          <>
            <span className="normal-case text-muted-foreground/80">
              — <span className="text-foreground font-semibold">{rows.length}</span>
              {' '}contracts hit 3+ times ({windowLabel})
            </span>
            {acceleratingCount > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/40 ml-1 normal-case">
                <Zap className="w-3 h-3" />
                {acceleratingCount} accelerating
              </span>
            )}
          </>
        )}
        {!isLoading && !isError && rows.length > 0 && collapsed && (
          <span className="text-[10px] normal-case text-muted-foreground/70 ml-auto">
            click to expand
          </span>
        )}
      </button>

      {collapsed ? null : isLoading && rows.length === 0 ? (
        <div className="space-y-1">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="h-10 animate-pulse bg-muted/20" />
          ))}
        </div>
      ) : rows.length === 0 ? null : (
        <Card className="p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-muted/20">
                  <th className="py-1.5 px-2 text-left text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Contract</th>
                  <th className="py-1.5 px-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Prints</th>
                  <th className="py-1.5 px-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">$ Cum</th>
                  <th className="py-1.5 px-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Ask%</th>
                  <th className="py-1.5 px-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Buy/Sell</th>
                  <th className="py-1.5 px-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Last</th>
                  <th className="py-1.5 px-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Accel</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <StackRowItem
                    key={r.option_symbol}
                    r={r}
                    onContractClick={onContractClick}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
