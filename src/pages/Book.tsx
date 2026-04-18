/**
 * Book — Claude's $10k paper book, full page view.
 *
 * Full-width equity curve on top, then:
 *   - Sessions table (every ct_book row)
 *   - Trades table (every ct_trades row, flat across all sessions) with
 *     expandable journal rows (Claude's post-mortem + James's notes).
 */
import { Fragment, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Wallet, Target, ListOrdered, NotebookPen, RefreshCw } from 'lucide-react';
import { BookEquityCurve } from '@/components/command/BookEquityCurve';
import { PnLByTheme } from '@/components/command/PnLByTheme';
import { RiskMetricsPanel } from '@/components/command/RiskMetricsPanel';
import { MonteCarloPanel } from '@/components/command/MonteCarloPanel';
import { ConcentrationPanel } from '@/components/command/ConcentrationPanel';
import { BookGreeks } from '@/components/command/BookGreeks';
import { TradeAuditPanel } from '@/components/command/TradeAuditPanel';
import { TradeAdvisoriesPanel } from '@/components/command/TradeAdvisoriesPanel';
import {
  SizingCalculatorButton,
  SizingCalculatorInline,
} from '@/components/command/SizingCalculator';
import type { CtBookRow, CtTradeRow } from '@/hooks/useCoTraderData';
import { useTradeJournal, formatRelativeTime } from '@/hooks/useTradeJournal';
import { DataExportButton } from '@/components/DataExportButton';

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

interface QualityRollupRow {
  session_date: string;
  trades_count: number;
  pre_rated_count: number;
  post_rated_count: number;
  graded_count: number;
  avg_pre_quality: number | null;
  avg_post_quality: number | null;
  avg_delta: number | null;
}

function useQualityRollup() {
  return useQuery<QualityRollupRow[]>({
    queryKey: ['ct_trade_quality_rollup'],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_trade_quality_rollup')
        .select('*')
        .gte('session_date', since)
        .order('session_date', { ascending: false });
      if (error) throw error;
      return (data ?? []) as QualityRollupRow[];
    },
  });
}

/** Pick the delta color — mirrors Claude's framing: positive delta (post > pre)
 *  means execution graded higher than setup signalled (a win for process);
 *  -1/-2 = mild humility; <= -3 = outcome taught a hard lesson. */
function deltaColor(delta: number | null | undefined): string | undefined {
  if (delta == null) return undefined;
  if (delta > 0) return GREEN;
  if (delta === 0) return undefined;
  if (delta >= -2) return '#F59E0B'; // amber
  return RED;
}

function QualityRollupStrip() {
  const { data, isLoading } = useQualityRollup();
  const rows = data ?? [];
  if (isLoading) return null;
  if (rows.length === 0) return null;

  // Aggregate across the 7-day window (weighted by counts — each trade contributes equally).
  let sumPre = 0, nPre = 0, sumPost = 0, nPost = 0, sumDelta = 0, nDelta = 0;
  for (const r of rows) {
    if (r.avg_pre_quality != null && r.pre_rated_count > 0) {
      sumPre += Number(r.avg_pre_quality) * r.pre_rated_count;
      nPre  += r.pre_rated_count;
    }
    if (r.avg_post_quality != null && r.post_rated_count > 0) {
      sumPost += Number(r.avg_post_quality) * r.post_rated_count;
      nPost  += r.post_rated_count;
    }
    if (r.avg_delta != null && r.graded_count > 0) {
      sumDelta += Number(r.avg_delta) * r.graded_count;
      nDelta  += r.graded_count;
    }
  }
  if (nPre === 0 && nPost === 0) return null;

  const avgPre  = nPre  > 0 ? sumPre  / nPre  : null;
  const avgPost = nPost > 0 ? sumPost / nPost : null;
  const avgDelta = nDelta > 0 ? sumDelta / nDelta : null;
  const deltaSign = avgDelta == null ? '' : avgDelta >= 0 ? '+' : '';
  const deltaLabel = avgDelta == null
    ? null
    : avgDelta > 0
      ? 'execution exceeded setup'
      : avgDelta === 0
        ? 'setup played as rated'
        : avgDelta >= -1
          ? 'mild humility'
          : avgDelta >= -2
            ? 'tight execution'
            : 'outcome taught a lesson';

  return (
    <Card className="px-4 py-3 flex items-center gap-4 flex-wrap text-[11px]">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        This week avg quality
      </span>
      <span>
        <span className="text-muted-foreground">pre</span>{' '}
        <span className="font-mono font-semibold">{avgPre != null ? avgPre.toFixed(1) : '—'}</span>
        <span className="text-muted-foreground">/10</span>
      </span>
      <span className="text-muted-foreground">·</span>
      <span>
        <span className="text-muted-foreground">post</span>{' '}
        <span className="font-mono font-semibold">{avgPost != null ? avgPost.toFixed(1) : '—'}</span>
        <span className="text-muted-foreground">/10</span>
      </span>
      <span className="text-muted-foreground">·</span>
      <span>
        <span className="text-muted-foreground">delta</span>{' '}
        <span className="font-mono font-semibold" style={{ color: deltaColor(avgDelta ?? 0) }}>
          {avgDelta != null ? `${deltaSign}${avgDelta.toFixed(1)}` : '—'}
        </span>
        {deltaLabel && (
          <span className="text-muted-foreground italic ml-2">({deltaLabel})</span>
        )}
      </span>
      <span className="ml-auto text-[9px] text-muted-foreground">
        n={nPost}/{nPre} trades graded (post/pre)
      </span>
    </Card>
  );
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
        <div className="ml-auto">
          <DataExportButton
            data={rows as unknown as Record<string, unknown>[]}
            filename="book-sessions"
            label="Export"
          />
        </div>
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

function JournalPanel({ trade }: { trade: CtTradeRow }) {
  const {
    jamesNotes, setJamesNotes, flushSave,
    saving, saveError, lastSavedAt,
    regenerate, regenerating, regenError,
  } = useTradeJournal(trade);

  const hasClaudeNotes = !!(trade.claude_notes && trade.claude_notes.trim());
  const canRegen = trade.status === 'closed' && trade.close_price != null;
  const hasAnyQuality = trade.pre_trade_quality != null || trade.post_trade_quality != null;

  return (
    <div className="bg-muted/10 border-t border-border px-6 py-4 text-xs space-y-4">
      {/* Advisories — per-tick, non-executing recommendations from
          ct-trade-advisories (15min offset from book-manager). Shows for
          every trade regardless of status — closed trades keep their
          historical advisory trail for after-the-fact review. */}
      <TradeAdvisoriesPanel tradeId={trade.id} />
      {/* Quality ratings — Claude's self-grade of process (pre) and
          outcome-informed execution (post). Only shown when at least one
          rating exists. Clicking the row already expanded this panel;
          the reasonings are always visible here. */}
      {hasAnyQuality && (
        <div className="border border-border/60 rounded bg-background/40 px-4 py-3">
          <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
            <h4 className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
              Quality self-rating
            </h4>
            <div className="flex items-center gap-3 text-[11px] font-mono">
              <span>
                <span className="text-muted-foreground">pre</span>{' '}
                <span className="font-semibold">{trade.pre_trade_quality ?? '—'}</span>
                <span className="text-muted-foreground">/10</span>
              </span>
              <span className="text-muted-foreground">·</span>
              <span>
                <span className="text-muted-foreground">post</span>{' '}
                <span className="font-semibold">{trade.post_trade_quality ?? '—'}</span>
                <span className="text-muted-foreground">/10</span>
              </span>
              {trade.quality_delta != null && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span>
                    <span className="text-muted-foreground">Δ</span>{' '}
                    <span className="font-semibold" style={{ color: deltaColor(trade.quality_delta) }}>
                      {trade.quality_delta > 0 ? `+${trade.quality_delta}` : trade.quality_delta}
                    </span>
                  </span>
                </>
              )}
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-[11px] leading-relaxed">
            <div>
              <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Setup (pre)</div>
              {trade.pre_trade_quality_reasoning
                ? <p className="text-foreground/90">{trade.pre_trade_quality_reasoning}</p>
                : <p className="text-muted-foreground italic">No pre-trade reasoning recorded.</p>}
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-wide text-muted-foreground mb-1">Execution (post)</div>
              {trade.post_trade_quality_reasoning
                ? <p className="text-foreground/90">{trade.post_trade_quality_reasoning}</p>
                : trade.status === 'closed'
                  ? <p className="text-muted-foreground italic">Post-rating pending — fire-and-forget Haiku call may still be in flight, or this close path predates the rating feature.</p>
                  : <p className="text-muted-foreground italic">Trade still open — post-rating is written at close.</p>}
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Claude's post-mortem — read-only, markdown */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <NotebookPen className="w-3.5 h-3.5 text-primary" />
              <h4 className="text-[10px] font-semibold uppercase tracking-wide text-foreground">
                Claude's post-mortem
              </h4>
              {trade.journal_version != null && trade.journal_version > 1 && (
                <Badge variant="outline" className="text-[9px] px-1 py-0">v{trade.journal_version}</Badge>
              )}
            </div>
            <div className="flex items-center gap-2">
              {!canRegen && (
                <span className="text-[9px] text-muted-foreground italic">open trade — no post-mortem yet</span>
              )}
              {canRegen && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[10px] gap-1"
                  onClick={() => void regenerate()}
                  disabled={regenerating}
                >
                  <RefreshCw className={`w-3 h-3 ${regenerating ? 'animate-spin' : ''}`} />
                  {regenerating ? 'regenerating…' : 'regenerate'}
                </Button>
              )}
            </div>
          </div>
          <div className="prose prose-xs prose-invert max-w-none text-foreground/90 leading-relaxed">
            {hasClaudeNotes ? (
              <ReactMarkdown>{trade.claude_notes as string}</ReactMarkdown>
            ) : (
              <p className="text-muted-foreground italic">
                {canRegen ? 'No post-mortem yet — click regenerate.' : 'Will appear when the trade closes.'}
              </p>
            )}
          </div>
          {regenError && (
            <p className="mt-2 text-[10px] text-red-400">regenerate failed: {regenError}</p>
          )}
        </div>

        {/* James's freeform notes */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-[10px] font-semibold uppercase tracking-wide text-foreground">Your notes</h4>
            <span className="text-[9px] text-muted-foreground">
              {saving
                ? 'saving…'
                : saveError
                  ? <span className="text-red-400">save failed</span>
                  : lastSavedAt
                    ? `updated ${formatRelativeTime(lastSavedAt)}`
                    : 'not saved yet'}
            </span>
          </div>
          <textarea
            className="w-full h-32 px-3 py-2 text-xs font-sans bg-background border border-border rounded resize-y focus:outline-none focus:ring-1 focus:ring-primary/40"
            value={jamesNotes}
            onChange={e => setJamesNotes(e.target.value)}
            onBlur={() => void flushSave()}
            placeholder={
              trade.status === 'closed'
                ? "What did you see? What did you learn? Be specific."
                : "Pre-trade thesis, live observations, anything you want to revisit later."
            }
          />
        </div>
      </div>
    </div>
  );
}

function TradesTable() {
  const { data: trades, isLoading } = useAllTrades();
  const rows = trades ?? [];
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const closedRealized = rows
    .filter(t => t.status === 'closed')
    .reduce((s, t) => s + (t.realized_pnl_usd ?? 0), 0);
  const closedWins = rows.filter(t => t.status === 'closed' && (t.realized_pnl_usd ?? 0) > 0).length;
  const closedLosses = rows.filter(t => t.status === 'closed' && (t.realized_pnl_usd ?? 0) < 0).length;

  const closedTrades = rows.filter(t => t.status === 'closed');
  const openTrades = rows.filter(t => t.status === 'open');
  // Journal-only export: just the notes fields keyed by trade context.
  const journalRows = rows
    .filter(t => (t.claude_notes && String(t.claude_notes).trim()) || (t.james_notes && String(t.james_notes).trim()))
    .map(t => ({
      id: t.id,
      session_date: t.session_date,
      instrument: t.instrument,
      side: t.side,
      status: t.status,
      opened_at: t.opened_at,
      closed_at: (t as unknown as { closed_at?: string | null }).closed_at ?? null,
      realized_pnl_usd: t.realized_pnl_usd,
      pre_trade_quality: t.pre_trade_quality,
      post_trade_quality: t.post_trade_quality,
      quality_delta: t.quality_delta,
      claude_notes: t.claude_notes ?? '',
      james_notes: t.james_notes ?? '',
      journal_version: t.journal_version ?? null,
    }));

  return (
    <Card id="trades-table" className="overflow-hidden scroll-mt-20">
      <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center gap-2">
        <Target className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Trades</h3>
        <span className="text-[10px] text-muted-foreground">{rows.length} rows (last 2000)</span>
        <span className="ml-2 text-[9px] text-muted-foreground italic">click a row to open the journal</span>
        {/* Three separate exports — closed, open, journal — because they
            answer different offline-analysis questions. JSON payload
            includes all three so a single "full book" backup is one click. */}
        <div className="ml-auto flex items-center gap-1">
          <DataExportButton
            data={closedTrades as unknown as Record<string, unknown>[]}
            filename="trades-closed"
            label="Closed"
          />
          <DataExportButton
            data={openTrades as unknown as Record<string, unknown>[]}
            filename="trades-open"
            label="Open"
          />
          <DataExportButton
            data={journalRows}
            filename="trade-journal"
            label="Journal"
            jsonData={{ exported_at: new Date().toISOString(), trades: rows, journal: journalRows }}
          />
        </div>
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
                <th className="px-3 py-2 text-center" title="Claude's self-rated trade quality — pre (setup) / post (execution) / delta">Quality</th>
                <th className="px-3 py-2 text-center" title="Journal: 📝 green = has notes, grey = empty">📝</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map(t => {
                const sideColor = t.side === 'long' ? GREEN : RED;
                const isOpen = t.status === 'open';
                const pnlPct = isOpen ? t.live_pnl_pct ?? null : t.realized_pnl_pct;
                const pnlUsd = isOpen ? t.live_pnl_usd ?? null : t.realized_pnl_usd;
                const pnlCol = pnlColor(pnlUsd ?? pnlPct);

                const updatedAt = t.live_pnl_updated_at ? new Date(t.live_pnl_updated_at).getTime() : null;
                const isStale =
                  isOpen &&
                  updatedAt != null &&
                  Date.now() - updatedAt > 20 * 60_000;
                const staleTitle = isStale
                  ? `live P&L last updated ${new Date(updatedAt!).toLocaleTimeString()} — book-manager hasn't refreshed in >20min`
                  : undefined;
                const cellOpacity = isStale ? 0.45 : 1;

                const hasJournal = !!(
                  (t.claude_notes && t.claude_notes.trim()) ||
                  (t.james_notes && t.james_notes.trim())
                );
                const isExpanded = expandedId === t.id;

                return (
                  <Fragment key={t.id}>
                    <tr
                      className={`hover:bg-muted/10 cursor-pointer ${isExpanded ? 'bg-muted/15' : ''}`}
                      onClick={() => setExpandedId(isExpanded ? null : t.id)}
                    >
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
                        title={staleTitle}
                      >
                        {fmtPct(pnlPct)}
                        {isStale && <span className="ml-1 text-[9px] text-muted-foreground">(stale)</span>}
                      </td>
                      <td
                        className="px-3 py-1.5 text-right"
                        style={{ color: pnlCol, opacity: cellOpacity }}
                        title={staleTitle}
                      >
                        {fmtUsd(pnlUsd, true)}
                      </td>
                      <td className="px-3 py-1.5 text-center">
                        <Badge variant="outline" className="text-[9px] px-1 py-0">
                          {t.status === 'closed' ? (t.close_reason ?? 'closed') : t.status}
                        </Badge>
                      </td>
                      <td
                        className="px-3 py-1.5 text-center whitespace-nowrap"
                        title={
                          t.pre_trade_quality == null
                            ? 'no quality rating'
                            : `pre: ${t.pre_trade_quality}/10${t.post_trade_quality != null ? ` · post: ${t.post_trade_quality}/10 · Δ ${t.quality_delta != null && t.quality_delta > 0 ? '+' : ''}${t.quality_delta ?? '—'}` : ' · post pending'}`
                        }
                      >
                        {t.pre_trade_quality == null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="text-[10px] font-mono">
                            <span>{t.pre_trade_quality}</span>
                            <span className="text-muted-foreground mx-0.5">/</span>
                            <span>{t.post_trade_quality ?? '·'}</span>
                            {t.quality_delta != null && (
                              <span className="ml-1 font-semibold" style={{ color: deltaColor(t.quality_delta) }}>
                                {t.quality_delta > 0 ? `+${t.quality_delta}` : t.quality_delta}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td
                        className="px-3 py-1.5 text-center"
                        title={hasJournal ? 'journal has notes' : 'journal empty'}
                      >
                        <span style={{ opacity: hasJournal ? 1 : 0.35, filter: hasJournal ? undefined : 'grayscale(1)' }}>
                          📝
                        </span>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr>
                        <td colSpan={12} className="p-0">
                          <JournalPanel trade={t} />
                          {/* Second section: forensic audit trail. One row
                              gives James post-mortem (above) + full forensic
                              reasoning (below). */}
                          <div className="bg-muted/5 border-t border-border px-6 py-4">
                            <TradeAuditPanel tradeId={t.id} />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
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
                <td className="px-3 py-2 text-center text-muted-foreground">—</td>
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
          <div className="flex items-center gap-2">
            <SizingCalculatorButton />
          </div>
        </header>

        {/* Full-width equity curve — same component as CommandStation but gets
            the whole page width here. */}
        <BookEquityCurve />

        {/* Hedge-fund-grade risk/performance stats + inline sizing calc.
            Risk metrics tell you the edge; the calc turns it into a trade. */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <RiskMetricsPanel />
          </div>
          <div>
            <SizingCalculatorInline />
          </div>
        </div>

        {/* Monte Carlo forward simulator — run the observed R-distribution
            forward N days × N paths to visualize the probable equity-curve
            envelope and P(ruin). Client-side only; no DB writes. */}
        <MonteCarloPanel />

        {/* Portfolio concentration — live view of the four caps that gate new
            trades at commit time (ticker, theme, direction, options count). */}
        <ConcentrationPanel />

        {/* Book-level Greeks — live aggregate delta / gamma / theta / vega /
            rho across open option positions. Skips rendering when there are
            no options (book is pure-underlying). */}
        <BookGreeks />

        {/* P&L split by thesis theme — where is the book making/losing money? */}
        <PnLByTheme />

        {/* Pre/Post/Delta quality rollup — Claude's self-graded process-vs-outcome
            signal. Appears only when there's data in the 7-day window. */}
        <QualityRollupStrip />

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
