/**
 * Book — Claude's $10k paper book, full page view.
 *
 * Full-width equity curve on top, then:
 *   - Sessions table (every ct_book row)
 *   - Trades table (every ct_trades row, flat across all sessions)
 *
 * Read-only. Pulls all ct_book + all ct_trades via direct supabase queries.
 * No edge functions, no mutation.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ArrowLeft, Wallet, Target, ListOrdered } from 'lucide-react';
import { BookEquityCurve } from '@/components/command/BookEquityCurve';
import { PnLByTheme } from '@/components/command/PnLByTheme';
import type { CtBookRow, CtTradeRow } from '@/hooks/useCoTraderData';

const GREEN = '#00C853';
const RED = '#FF1744';

function fmtUsd(n: number | null | undefined, signed = false): string {
  if (n == null) return '—';
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!signed) return `$${v}`;
  return n >= 0 ? `+$${v}` : `-$${v}`;
}

function fmtPct(n: number | null | undefined, signed = true, digits = 2): string {
  if (n == null) return '—';
  const v = n.toFixed(digits);
  if (!signed) return `${v}%`;
  return n >= 0 ? `+${v}%` : `${v}%`;
}

function pnlColor(n: number | null | undefined): string | undefined {
  if (n == null || n === 0) return undefined;
  return n > 0 ? GREEN : RED;
}

function useAllSessions() {
  return useQuery<CtBookRow[]>({
    queryKey: ['book_all_sessions'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_book')
        .select('*')
        .order('session_date', { ascending: false });
      if (error) throw error;
      return (data ?? []) as CtBookRow[];
    },
  });
}

function useAllTrades() {
  return useQuery<CtTradeRow[]>({
    queryKey: ['book_all_trades'],
    refetchInterval: 60_000,
    queryFn: async () => {
      // All-time trades. Paginate-guard with a generous cap; if the book ever
      // outgrows this, we'll add range pagination.
      const { data, error } = await supabase
        .from('ct_trades')
        .select('*')
        .order('session_date', { ascending: false })
        .order('opened_at', { ascending: false, nullsFirst: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as CtTradeRow[];
    },
  });
}

function SessionsTable() {
  const { data: sessions, isLoading } = useAllSessions();
  const rows = sessions ?? [];

  // Totals row
  const totalRealized = rows.reduce((s, r) => s + (r.realized_pnl ?? 0), 0);
  const totalTrades = rows.reduce((s, r) => s + (r.trades_count ?? 0), 0);
  const totalWins = rows.reduce((s, r) => s + (r.wins ?? 0), 0);
  const totalLosses = rows.reduce((s, r) => s + (r.losses ?? 0), 0);

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center gap-2">
        <Wallet className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Sessions</h3>
        <span className="text-[10px] text-muted-foreground">{rows.length} rows</span>
      </div>
      {isLoading ? (
        <div className="p-4 text-xs text-muted-foreground">loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground">No sessions yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-muted/20 text-[9px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-right">Start</th>
                <th className="px-3 py-2 text-right">End</th>
                <th className="px-3 py-2 text-right">Realized</th>
                <th className="px-3 py-2 text-right">Unrealized</th>
                <th className="px-3 py-2 text-right">%</th>
                <th className="px-3 py-2 text-right">HWM</th>
                <th className="px-3 py-2 text-right">Max DD</th>
                <th className="px-3 py-2 text-right">Trades</th>
                <th className="px-3 py-2 text-right">W/L</th>
                <th className="px-3 py-2 text-center">Goal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(r => {
                const end = r.ending_balance ?? r.starting_balance + (r.realized_pnl ?? 0) + (r.unrealized_pnl ?? 0);
                const delta = end - r.starting_balance;
                return (
                  <tr key={r.id} className="hover:bg-muted/10">
                    <td className="px-3 py-1.5 text-left">{r.session_date}</td>
                    <td className="px-3 py-1.5 text-right">{fmtUsd(r.starting_balance)}</td>
                    <td className="px-3 py-1.5 text-right" style={{ color: pnlColor(delta) }}>{fmtUsd(end)}</td>
                    <td className="px-3 py-1.5 text-right" style={{ color: pnlColor(r.realized_pnl) }}>
                      {fmtUsd(r.realized_pnl, true)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">
                      {r.ending_balance != null ? '—' : fmtUsd(r.unrealized_pnl, true)}
                    </td>
                    <td className="px-3 py-1.5 text-right" style={{ color: pnlColor(r.realized_pnl_pct) }}>
                      {fmtPct(r.realized_pnl_pct)}
                    </td>
                    <td className="px-3 py-1.5 text-right text-muted-foreground">{fmtUsd(r.high_water_mark)}</td>
                    <td className="px-3 py-1.5 text-right" style={{ color: (r.max_drawdown_pct ?? 0) < 0 ? RED : undefined }}>
                      {fmtPct(r.max_drawdown_pct)}
                    </td>
                    <td className="px-3 py-1.5 text-right">{r.trades_count ?? 0}</td>
                    <td className="px-3 py-1.5 text-right">{r.wins ?? 0}/{r.losses ?? 0}</td>
                    <td className="px-3 py-1.5 text-center">
                      {r.ending_balance == null ? (
                        <Badge variant="outline" className="text-[9px] px-1 py-0">live</Badge>
                      ) : r.goal_hit ? (
                        <Badge className="bg-emerald-500/20 text-emerald-300 text-[9px] px-1 py-0">hit</Badge>
                      ) : (
                        <Badge className="bg-red-500/20 text-red-300 text-[9px] px-1 py-0">miss</Badge>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-muted/30 text-[10px]">
              <tr className="border-t border-border">
                <td className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-muted-foreground">Totals</td>
                <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                <td className="px-3 py-2 text-right font-semibold" style={{ color: pnlColor(totalRealized) }}>
                  {fmtUsd(totalRealized, true)}
                </td>
                <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                <td className="px-3 py-2 text-right text-muted-foreground">—</td>
                <td className="px-3 py-2 text-right font-semibold">{totalTrades}</td>
                <td className="px-3 py-2 text-right font-semibold">{totalWins}/{totalLosses}</td>
                <td className="px-3 py-2 text-center text-muted-foreground">—</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

function TradesTable() {
  const { data: trades, isLoading } = useAllTrades();
  const rows = trades ?? [];

  const closedRealized = rows
    .filter(t => t.status === 'closed')
    .reduce((s, t) => s + (t.realized_pnl_usd ?? 0), 0);
  const closedWins = rows.filter(t => t.status === 'closed' && (t.realized_pnl_usd ?? 0) > 0).length;
  const closedLosses = rows.filter(t => t.status === 'closed' && (t.realized_pnl_usd ?? 0) < 0).length;

  return (
    <Card id="trades-table" className="overflow-hidden scroll-mt-20">
      <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center gap-2">
        <Target className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Trades</h3>
        <span className="text-[10px] text-muted-foreground">{rows.length} rows (last 2000)</span>
      </div>
      {isLoading ? (
        <div className="p-4 text-xs text-muted-foreground">loading…</div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-xs text-muted-foreground">No trades yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono">
            <thead className="bg-muted/20 text-[9px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Instrument</th>
                <th className="px-3 py-2 text-left">Side</th>
                <th className="px-3 py-2 text-right">Size %</th>
                <th className="px-3 py-2 text-right">Size $</th>
                <th className="px-3 py-2 text-right">Entry</th>
                <th className="px-3 py-2 text-right">Exit</th>
                <th className="px-3 py-2 text-right">P&L %</th>
                <th className="px-3 py-2 text-right">P&L $</th>
                <th className="px-3 py-2 text-center">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(t => {
                const sideColor = t.side === 'long' ? GREEN : RED;
                // For open trades, show live_pnl_* (set by ct-book-manager
                // every 15min for underlying). For closed, show realized.
                // Options open trades stay null and render "—" with tooltip.
                const isOpen = t.status === 'open';
                const isOptionOpen = isOpen && t.contract_type && t.contract_type !== 'underlying';
                const pnlPct = isOpen ? t.live_pnl_pct ?? null : t.realized_pnl_pct;
                const pnlUsd = isOpen ? t.live_pnl_usd ?? null : t.realized_pnl_usd;
                const pnlCol = pnlColor(pnlUsd ?? pnlPct);

                // Stale indicator: book-manager runs every 15min, so >20min
                // without an update means the cron missed, market closed,
                // or the function errored. Fade + "(stale)" suffix.
                const updatedAt = t.live_pnl_updated_at ? new Date(t.live_pnl_updated_at).getTime() : null;
                const isStale =
                  isOpen &&
                  !isOptionOpen &&
                  updatedAt != null &&
                  Date.now() - updatedAt > 20 * 60_000;
                const staleTitle = isStale
                  ? `live P&L last updated ${new Date(updatedAt!).toLocaleTimeString()} — book-manager hasn't refreshed in >20min`
                  : undefined;
                const optionTitle = isOptionOpen
                  ? 'options live P&L deferred — needs option-chain mark-to-market (v2)'
                  : undefined;
                const cellOpacity = isStale ? 0.45 : 1;

                return (
                  <tr key={t.id} className="hover:bg-muted/10">
                    <td className="px-3 py-1.5 text-left text-muted-foreground">{t.session_date}</td>
                    <td className="px-3 py-1.5 text-left font-semibold">{t.instrument}</td>
                    <td className="px-3 py-1.5 text-left" style={{ color: sideColor }}>{t.side}</td>
                    <td className="px-3 py-1.5 text-right">{t.size_pct}%</td>
                    <td className="px-3 py-1.5 text-right">{fmtUsd(t.size_usd)}</td>
                    <td className="px-3 py-1.5 text-right">{t.entry_price?.toFixed(2) ?? '—'}</td>
                    <td className="px-3 py-1.5 text-right">{t.close_price?.toFixed(2) ?? '—'}</td>
                    <td
                      className="px-3 py-1.5 text-right"
                      style={{ color: pnlCol, opacity: cellOpacity }}
                      title={optionTitle ?? staleTitle}
                    >
                      {fmtPct(pnlPct)}
                      {isStale && <span className="ml-1 text-[9px] text-muted-foreground">(stale)</span>}
                    </td>
                    <td
                      className="px-3 py-1.5 text-right"
                      style={{ color: pnlCol, opacity: cellOpacity }}
                      title={optionTitle ?? staleTitle}
                    >
                      {fmtUsd(pnlUsd, true)}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <Badge variant="outline" className="text-[9px] px-1 py-0">
                        {t.status === 'closed' ? (t.close_reason ?? 'closed') : t.status}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-muted/30 text-[10px]">
              <tr className="border-t border-border">
                <td className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-muted-foreground" colSpan={7}>
                  Totals (closed only)
                </td>
                <td className="px-3 py-2 text-right font-semibold text-muted-foreground">
                  {closedWins}W / {closedLosses}L
                </td>
                <td className="px-3 py-2 text-right font-semibold" style={{ color: pnlColor(closedRealized) }}>
                  {fmtUsd(closedRealized, true)}
                </td>
                <td className="px-3 py-2 text-center text-muted-foreground">—</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function Book() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link to="/" className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div>
              <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
                <ListOrdered className="w-5 h-5 text-primary" />
                <span className="text-primary">Book</span>
                <span className="text-sm text-muted-foreground font-normal">$10k paper · full history</span>
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Every session, every trade. The binary question after 30 days: does this beat SPY buy-hold?
              </p>
            </div>
          </div>
        </header>

        {/* Full-width equity curve — same component as CommandStation but gets
            the whole page width here. */}
        <BookEquityCurve />

        {/* P&L split by thesis theme — where is the book making/losing money? */}
        <PnLByTheme />

        {/* Sessions + Trades */}
        <SessionsTable />
        <TradesTable />

        <footer className="pt-4 text-[10px] text-muted-foreground/60 text-center">
          ct-book-manager updates unrealized P&L every 15 min during market hours · ct-book-eod-close finalizes at 4 PM ET
        </footer>
      </div>
    </div>
  );
}
