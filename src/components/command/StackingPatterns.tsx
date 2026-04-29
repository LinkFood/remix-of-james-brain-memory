/**
 * StackingPatterns — leaderboard of contracts being hit repeatedly in the
 * current session. A single row per contract (not per print), sorted by
 * prints_count desc. Click a row → ContractDrillSheet drill-down (same
 * mechanism as OvernightPositioning / Tape rows).
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
import { Activity, ArrowUp, ArrowDown, ArrowUpDown, ChevronDown, ChevronUp, Zap } from 'lucide-react';
import {
  useContractStacking,
  formatStackCount,
  formatStackPremium,
  formatTimeAgo,
  interpretStack,
  type StackRow,
} from '@/hooks/useContractStacking';

// Sort state — these are the columns where sort actually adds value.
// Contract / Buy-Sell / Signal stay static (alphabetical or text-categorical
// orderings don't help the user's "what's hot" scan).
type SortKey = 'prints' | 'premium' | 'ask_pct' | 'last' | 'accel';
type SortDir = 'asc' | 'desc';

/** Plain-<th> sortable header. Faint ↕ when inactive, solid ▼/▲ when active. */
function SortableTh({
  colKey,
  defaultDir = 'desc',
  children,
  align = 'right',
  sortKey,
  sortDir,
  onSort,
}: {
  colKey: SortKey;
  defaultDir?: SortDir;
  children: React.ReactNode;
  align?: 'left' | 'right' | 'center';
  sortKey: SortKey | null;
  sortDir: SortDir;
  onSort: (k: SortKey, d: SortDir) => void;
}) {
  const isActive = sortKey === colKey;
  const dir = isActive ? sortDir : null;
  const handleClick = () => {
    if (!isActive) onSort(colKey, defaultDir);
    else onSort(colKey, sortDir === 'asc' ? 'desc' : 'asc');
  };
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  const Icon = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ArrowUpDown;
  const iconColor = isActive ? 'text-foreground' : 'text-muted-foreground/40';
  return (
    <th
      className={cn(
        'py-1.5 px-2 text-[10px] uppercase tracking-wider font-medium text-muted-foreground cursor-pointer select-none hover:bg-muted/40 transition-colors',
        align === 'right' && 'text-right',
        align === 'left' && 'text-left',
        align === 'center' && 'text-center',
      )}
      onClick={handleClick}
    >
      <div className={cn('flex items-center gap-1', justify)}>
        <span>{children}</span>
        <Icon className={cn('w-3 h-3', iconColor)} />
      </div>
    </th>
  );
}

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
      {/* Signal — interpreted direction from buy/sell + ask% */}
      <td className="py-1.5 px-2 text-right whitespace-nowrap">
        {(() => {
          const sig = interpretStack(r);
          const tone =
            sig.color === 'bullish'
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
              : sig.color === 'bearish'
                ? 'bg-rose-500/15 text-rose-300 border-rose-500/40'
                : 'bg-slate-500/15 text-slate-300 border-slate-500/40';
          const dot = sig.color === 'bullish' ? '🟢' : sig.color === 'bearish' ? '🔴' : '🟡';
          return (
            <span
              className={cn(
                'inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border',
                tone,
                sig.thin && 'opacity-60',
              )}
              title={sig.mechanism + (sig.thin ? ' · thin data (<5 prints)' : '')}
            >
              <span>{dot}</span>
              <span className="uppercase tracking-wider">{sig.label}</span>
            </span>
          );
        })()}
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

  // Sort state — default matches the hook's pre-sort (prints desc).
  const [sortKey, setSortKey] = useState<SortKey>('prints');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const sortedRows = useMemo(() => {
    const dirMul = sortDir === 'asc' ? -1 : 1;
    const copy = [...rows];
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'prints':
          cmp = b.prints_count - a.prints_count;
          break;
        case 'premium':
          cmp = (b.premium_total ?? 0) - (a.premium_total ?? 0);
          break;
        case 'ask_pct':
          cmp = (b.ask_dominant_pct ?? -1) - (a.ask_dominant_pct ?? -1);
          break;
        case 'last':
          cmp = Date.parse(b.last_ts) - Date.parse(a.last_ts);
          break;
        case 'accel':
          // Boolean sort: accelerating rows first when desc.
          cmp = (b.is_accelerating ? 1 : 0) - (a.is_accelerating ? 1 : 0);
          // Tiebreak by prints so the accelerating bucket itself stays useful.
          if (cmp === 0) cmp = b.prints_count - a.prints_count;
          break;
      }
      return cmp * dirMul;
    });
    return copy;
  }, [rows, sortKey, sortDir]);

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
          <div className="overflow-auto max-h-[500px]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 z-10 bg-card shadow-sm">
                <tr className="border-b border-border bg-muted/20">
                  <th className="py-1.5 px-2 text-left text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Contract</th>
                  <SortableTh colKey="prints" defaultDir="desc" sortKey={sortKey} sortDir={sortDir} onSort={(k, d) => { setSortKey(k); setSortDir(d); }}>Prints</SortableTh>
                  <SortableTh colKey="premium" defaultDir="desc" sortKey={sortKey} sortDir={sortDir} onSort={(k, d) => { setSortKey(k); setSortDir(d); }}>$ Cum</SortableTh>
                  <SortableTh colKey="ask_pct" defaultDir="desc" sortKey={sortKey} sortDir={sortDir} onSort={(k, d) => { setSortKey(k); setSortDir(d); }}>Ask%</SortableTh>
                  <th className="py-1.5 px-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Buy/Sell</th>
                  <SortableTh colKey="last" defaultDir="desc" sortKey={sortKey} sortDir={sortDir} onSort={(k, d) => { setSortKey(k); setSortDir(d); }}>Last</SortableTh>
                  <SortableTh colKey="accel" defaultDir="desc" sortKey={sortKey} sortDir={sortDir} onSort={(k, d) => { setSortKey(k); setSortDir(d); }}>Accel</SortableTh>
                  <th className="py-1.5 px-2 text-right text-[10px] uppercase tracking-wider font-medium text-muted-foreground">Signal</th>
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((r) => (
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
