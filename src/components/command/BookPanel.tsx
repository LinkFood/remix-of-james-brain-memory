/**
 * BookPanel — Claude's $10k paper book, live. Today's positions,
 * unrealized P&L, realized P&L, win rate. The direct edge measurement.
 */
import { useState } from 'react';
import { useTodayBook, useTodayTrades, useLatestBookRecap, useTradeActions, type CtTradeRow } from '@/hooks/useCoTraderData';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Wallet, TrendingUp, TrendingDown, Target, CircleDot, ChevronDown, ChevronRight } from 'lucide-react';

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  return n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null) return '—';
  const v = n.toFixed(digits);
  return n >= 0 ? `+${v}%` : `${v}%`;
}

function fmtBalance(n: number | null | undefined): string {
  if (n == null) return '—';
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function TradeRow({ trade }: { trade: CtTradeRow }) {
  const [expanded, setExpanded] = useState(false);
  const { data: actions } = useTradeActions(expanded ? trade.id : null);
  const pct = trade.realized_pnl_pct;
  const usd = trade.realized_pnl_usd;
  const isOpen = trade.status === 'open' || trade.status === 'planned';
  const sideIcon = trade.side === 'long' ? TrendingUp : TrendingDown;
  const SideIcon = sideIcon;
  const pnlColor = (pct ?? 0) > 0 ? 'text-emerald-400' : (pct ?? 0) < 0 ? 'text-red-400' : 'text-muted-foreground';
  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="p-2.5 border-l-2 border-l-border hover:bg-muted/20">
      <div
        className="flex items-center gap-2 text-[10.5px] flex-wrap cursor-pointer"
        onClick={() => setExpanded(e => !e)}
      >
        <Chevron className="w-3 h-3 text-muted-foreground shrink-0" />
        <SideIcon className={`w-3 h-3 ${trade.side === 'long' ? 'text-emerald-400' : 'text-red-400'}`} />
        <span className="font-mono font-semibold text-foreground">{trade.instrument}</span>
        <span className="text-muted-foreground">{trade.side} {trade.size_pct}%</span>
        <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono">
          {isOpen ? (trade.status === 'planned' ? 'planned' : 'open') : (trade.close_reason ?? 'closed')}
        </Badge>
        {trade.conviction && (
          <span className="text-[9px] text-muted-foreground">conv {trade.conviction}/5</span>
        )}
        <span className={`ml-auto font-mono font-semibold ${pnlColor}`}>
          {isOpen ? 'unresolved' : `${fmtPct(pct)} · ${fmtUsd(usd)}`}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground font-mono">
        <span>entry {trade.entry_price?.toFixed(2)}</span>
        {trade.stop_price && <span>stop {trade.stop_price.toFixed(2)}</span>}
        {trade.target_price && <span>target {trade.target_price.toFixed(2)}</span>}
        {trade.close_price && <span>close {trade.close_price.toFixed(2)}</span>}
      </div>
      {trade.thesis && (
        <div className="mt-1 text-[10.5px] text-foreground/80 leading-snug">
          {trade.thesis}
        </div>
      )}
      {expanded && (
        <div className="mt-2 space-y-1 bg-muted/20 rounded p-2">
          <div className="text-[9px] uppercase tracking-wide text-muted-foreground">Action log</div>
          {(actions ?? []).length === 0 ? (
            <div className="text-[10px] text-muted-foreground">no actions yet</div>
          ) : (
            (actions ?? []).map(a => (
              <div key={a.id} className="text-[10px] font-mono flex gap-2">
                <span className="text-muted-foreground shrink-0">{a.created_at.slice(11, 19)}</span>
                <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">{a.action}</Badge>
                {a.price != null && <span className="text-muted-foreground shrink-0">@{a.price.toFixed(2)}</span>}
                <span className="text-foreground/80">{a.rationale ?? ''}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function BookPanel() {
  const { data: book, isLoading } = useTodayBook();
  const { data: trades } = useTodayTrades();
  const { data: recap } = useLatestBookRecap();

  const openTrades = (trades ?? []).filter(t => t.status === 'open' || t.status === 'planned');
  const closedTrades = (trades ?? []).filter(t => t.status === 'closed');
  const goalMet = book?.goal_hit === true;
  const sessionOver = book?.ending_balance != null;

  return (
    <Card className="divide-y divide-border">
      <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-2">
        <Wallet className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Claude's Book</h3>
        <span className="text-[10px] text-muted-foreground">paper trading · $10k</span>
        {sessionOver && (
          <Badge className={`ml-auto ${goalMet ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-300'}`}>
            {goalMet ? 'goal hit' : 'lost today'}
          </Badge>
        )}
      </div>

      {isLoading ? (
        <div className="p-4 text-xs text-muted-foreground">loading…</div>
      ) : !book ? (
        <div className="p-4 text-xs text-muted-foreground">
          No book today yet. ct-claude-trade-open fires at 13:26 UTC (9:26 AM ET).
        </div>
      ) : (
        <>
          {/* Summary bar */}
          <div className="grid grid-cols-4 gap-2 p-3">
            <div>
              <div className="text-[9px] text-muted-foreground uppercase">Balance</div>
              <div className="text-sm font-mono font-semibold">{fmtBalance(book.ending_balance ?? (book.starting_balance + book.realized_pnl + book.unrealized_pnl))}</div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase">Realized P&L</div>
              <div className={`text-sm font-mono font-semibold ${book.realized_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {fmtUsd(book.realized_pnl)} ({fmtPct(book.realized_pnl_pct)})
              </div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase">Trades</div>
              <div className="text-sm font-mono font-semibold">{book.trades_count} · {book.wins}W / {book.losses}L</div>
            </div>
            <div>
              <div className="text-[9px] text-muted-foreground uppercase">Max DD</div>
              <div className="text-sm font-mono font-semibold">{fmtPct(book.max_drawdown_pct)}</div>
            </div>
          </div>

          {/* Open positions */}
          {openTrades.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/10 flex items-center gap-1">
                <CircleDot className="w-3 h-3" />
                Live positions ({openTrades.length})
              </div>
              <div className="divide-y divide-border">
                {openTrades.map(t => <TradeRow key={t.id} trade={t} />)}
              </div>
            </div>
          )}

          {/* Closed trades today */}
          {closedTrades.length > 0 && (
            <div>
              <div className="px-3 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground bg-muted/10 flex items-center gap-1">
                <Target className="w-3 h-3" />
                Closed today ({closedTrades.length})
              </div>
              <div className="divide-y divide-border">
                {closedTrades.map(t => <TradeRow key={t.id} trade={t} />)}
              </div>
            </div>
          )}

          {/* Recap if exists */}
          {recap && recap.session_date === book.session_date && (
            <div className="p-3 space-y-1.5 bg-muted/10">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">EOD Recap</div>
              <div className="text-xs text-foreground leading-relaxed">{recap.recap}</div>
              {recap.what_worked && (
                <div className="text-[11px] text-emerald-400/90">worked: {recap.what_worked}</div>
              )}
              {recap.what_didnt && (
                <div className="text-[11px] text-red-400/90">missed: {recap.what_didnt}</div>
              )}
              {recap.tomorrow_posture && (
                <div className="text-[11px] text-muted-foreground">tomorrow: {recap.tomorrow_posture}</div>
              )}
            </div>
          )}

          {openTrades.length === 0 && closedTrades.length === 0 && (
            <div className="p-4 text-xs text-muted-foreground leading-relaxed">
              Book is flat. Claude will commit today's trades at 9:26 AM ET.
              Gauntlet fires 1min prior — predictions inform the commit.
            </div>
          )}
        </>
      )}
    </Card>
  );
}
