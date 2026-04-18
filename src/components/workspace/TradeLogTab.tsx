/**
 * TradeLogTab — Claude's trade ideas + executed trades, both filterable.
 *
 * Layout: filter chips across the top (All / Armed / Filled / Closed), then
 * a unified table of rows. Each row gets thumbs-up/down writing to
 * ct_james_reviews (subject_type = 'trade' | 'trade_idea'). One row per
 * click; we invalidate the query and let the read re-run.
 *
 * Ideas are merged with trades for a single timeline:
 *   - trade_idea rows show status 'armed' | 'triggered' | 'expired' | ...
 *   - trade rows show 'open' | 'closed' | 'planned' | 'cancelled'
 * The filter chips map to useful buckets that aren't tied to one table.
 */
import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ThumbsUp, ThumbsDown, TrendingUp, TrendingDown, Activity, Link2, MessageSquare,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  useClaudeTradeIdeas, useClaudeTrades, type CtTradeIdeaRow,
} from '@/hooks/useClaudeBook';
import { useReviewSubject } from '@/hooks/useHypotheses';
import type { CtTradeRow } from '@/hooks/useCoTraderData';

type Filter = 'all' | 'armed' | 'filled' | 'closed';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'armed', label: 'Armed' },
  { key: 'filled', label: 'Filled' },
  { key: 'closed', label: 'Closed' },
];

interface UnifiedRow {
  kind: 'trade_idea' | 'trade';
  id: string;
  timestamp: string;
  instrument: string;
  direction: 'long' | 'short';
  status: string;
  hypothesis_id: string | null;
  entry: number | null;
  stop: number | null;
  target: number | null;
  current: number | null;   // live close or live price, best-effort
  pnlPct: number | null;
  pnlUsd: number | null;
  rationale: string;
}

function mergeRows(ideas: CtTradeIdeaRow[], trades: CtTradeRow[]): UnifiedRow[] {
  const ideaRows: UnifiedRow[] = ideas.map(i => ({
    kind: 'trade_idea',
    id: i.id,
    timestamp: i.armed_at,
    instrument: i.instrument,
    direction: i.direction,
    status: i.status,
    hypothesis_id: i.hypothesis_id,
    entry: i.entry_price_target,
    // stop/target here are percentages, not prices — surface as null for the
    // price columns and display the %s in the rationale blurb instead.
    stop: null,
    target: null,
    current: null,
    pnlPct: null,
    pnlUsd: null,
    rationale: i.rationale,
  }));
  const tradeRows: UnifiedRow[] = trades.map(t => ({
    kind: 'trade',
    id: t.id,
    timestamp: t.opened_at ?? t.closed_at ?? t.session_date,
    instrument: t.instrument,
    direction: t.side,
    status: t.status,
    hypothesis_id: null,   // ct_trades.hypothesis_id exists but isn't in our type yet
    entry: t.entry_price,
    stop: t.stop_price,
    target: t.target_price,
    current: t.close_price ?? null,
    pnlPct: t.realized_pnl_pct ?? t.live_pnl_pct ?? null,
    pnlUsd: t.realized_pnl_usd ?? t.live_pnl_usd ?? null,
    rationale: t.thesis,
  }));
  return [...ideaRows, ...tradeRows].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
  );
}

function statusMatchesFilter(status: string, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'armed') return status === 'armed' || status === 'triggered';
  if (filter === 'filled') return status === 'filled' || status === 'open';
  if (filter === 'closed') return status === 'closed' || status === 'expired' || status === 'cancelled';
  return true;
}

function statusChipClass(s: string): string {
  if (s === 'armed' || s === 'planned') return 'bg-blue-500/15 text-blue-400 border-blue-500/30';
  if (s === 'triggered' || s === 'open') return 'bg-amber-500/15 text-amber-400 border-amber-500/30';
  if (s === 'filled') return 'bg-primary/20 text-primary border-primary/40';
  if (s === 'closed') return 'bg-green-500/15 text-green-400 border-green-500/30';
  if (s === 'expired' || s === 'cancelled' || s === 'rejected') return 'bg-muted/50 text-muted-foreground border-muted';
  return 'bg-muted/50 text-muted-foreground border-muted';
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

export function TradeLogTab() {
  const [filter, setFilter] = useState<Filter>('all');
  const { data: ideas = [], isLoading: ideasLoading } = useClaudeTradeIdeas('all');
  const { data: trades = [], isLoading: tradesLoading } = useClaudeTrades();

  const rows = useMemo(
    () => mergeRows(ideas, trades).filter(r => statusMatchesFilter(r.status, filter)),
    [ideas, trades, filter],
  );

  const loading = ideasLoading || tradesLoading;

  return (
    <div className="space-y-3">
      {/* Filter chips */}
      <div className="flex items-center gap-1">
        {FILTERS.map(f => (
          <Button
            key={f.key}
            size="sm"
            variant={f.key === filter ? 'default' : 'outline'}
            className="h-7 px-3 text-[11px]"
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
        <div className="ml-auto text-[10px] text-muted-foreground font-mono">
          {rows.length} rows
        </div>
      </div>

      <Card>
        {loading ? (
          <div className="p-4 text-xs text-muted-foreground">loading trade log...</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">
            No {filter === 'all' ? '' : filter + ' '}rows yet. Claude writes trade ideas each heartbeat
            — when the entry trigger fires, a paper trade auto-commits.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {rows.map(r => <TradeLogRow key={`${r.kind}-${r.id}`} row={r} />)}
          </div>
        )}
      </Card>
    </div>
  );
}

function TradeLogRow({ row }: { row: UnifiedRow }) {
  const review = useReviewSubject();
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);

  const submit = (thumb: 'up' | 'down') => {
    review.mutate(
      {
        subjectType: row.kind,
        subjectId: row.id,
        thumb,
        note: note.trim() || undefined,
      },
      {
        onSuccess: () => {
          toast.success(`Review saved (${thumb === 'up' ? '+' : '-'})`);
          setNote('');
          setNoteOpen(false);
        },
        onError: (e) => toast.error(`Review failed: ${(e as Error).message}`),
      },
    );
  };

  const dirIcon = row.direction === 'long'
    ? <TrendingUp className="w-3 h-3 text-green-400" />
    : <TrendingDown className="w-3 h-3 text-red-400" />;

  const pnlColor = row.pnlPct == null
    ? 'text-muted-foreground'
    : row.pnlPct >= 0 ? 'text-green-400' : 'text-red-400';

  return (
    <div className="px-3 py-2 space-y-1.5 hover:bg-muted/20 transition-colors">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-[10px] text-muted-foreground font-mono w-[72px] shrink-0">
          {timeLabel(row.timestamp)}
        </span>
        <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 uppercase">
          {row.kind === 'trade_idea' ? 'idea' : 'trade'}
        </Badge>
        <span className="font-mono font-semibold text-foreground">{row.instrument}</span>
        {dirIcon}
        <Badge variant="outline" className={`text-[9px] px-1.5 py-0 h-4 ${statusChipClass(row.status)}`}>
          {row.status}
        </Badge>
        {row.hypothesis_id && (
          <Link2 className="w-3 h-3 text-muted-foreground" aria-label="linked to hypothesis" />
        )}
        <div className="ml-auto flex items-center gap-2 text-[10px] font-mono">
          {row.entry != null && <span className="text-muted-foreground">E {row.entry.toFixed(2)}</span>}
          {row.stop != null && <span className="text-red-400/80">S {row.stop.toFixed(2)}</span>}
          {row.target != null && <span className="text-green-400/80">T {row.target.toFixed(2)}</span>}
          {row.current != null && <span className="text-foreground">C {row.current.toFixed(2)}</span>}
          {row.pnlPct != null && (
            <span className={pnlColor}>
              {row.pnlPct >= 0 ? '+' : ''}{row.pnlPct.toFixed(2)}%
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="text-[11px] text-muted-foreground leading-snug flex-1 truncate" title={row.rationale}>
          {row.rationale}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-green-400 hover:text-green-300 hover:bg-green-500/10"
            disabled={review.isPending}
            onClick={() => submit('up')}
            title="Thumbs up"
          >
            <ThumbsUp className="w-3 h-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-red-400 hover:text-red-300 hover:bg-red-500/10"
            disabled={review.isPending}
            onClick={() => submit('down')}
            title="Thumbs down"
          >
            <ThumbsDown className="w-3 h-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
            onClick={() => setNoteOpen(v => !v)}
            title="Add note"
          >
            <MessageSquare className="w-3 h-3" />
          </Button>
        </div>
      </div>
      {noteOpen && (
        <div className="flex items-center gap-1 pt-1">
          <Input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="review note (optional) — sandboxed, Claude never reads this"
            className="text-[11px] h-7"
          />
          <Activity className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-[9px] text-muted-foreground shrink-0">thumbs attach note</span>
        </div>
      )}
    </div>
  );
}
