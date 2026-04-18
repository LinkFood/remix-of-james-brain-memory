/**
 * SizingCalculator — R-based position sizing + Kelly overlay.
 *
 * Three surfaces from one body:
 *   - <SizingCalculatorBody /> — the card (used inline on /book).
 *   - <SizingCalculatorModal /> — Dialog wrapper around the body.
 *   - <SizingCalculatorButton /> — "📐 Size" button that opens the modal.
 *
 * Inputs: instrument, side (long/short), entry, stop, target, book equity
 * (auto-pulled from latest ct_book, overridable), risk% (persisted to
 * localStorage, default 1%).
 *
 * Outputs (live-computed via usePositionSizing):
 *   - stop distance $/%
 *   - shares/contracts to risk exactly 1R
 *   - position notional & % of book
 *   - 1R in $
 *   - reward-to-risk ratio
 *   - Kelly % from historical win-rate + avg R
 *   - Recommended = min(R-based, Kelly, 40% cap)
 *
 * Commit button calls the existing `commit_manual_trade` RPC
 * (same signature as ct-chat's slash command).
 */
import { useEffect, useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { AlertTriangle, Ruler, TrendingDown, TrendingUp, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  usePositionSizing,
  loadPersistedRiskPct,
  persistRiskPct,
  type Side,
} from '@/hooks/usePositionSizing';

// Matches the tickers called out in CommandStation's header subtitle.
const DEFAULT_WATCHLIST = [
  'SPY', 'QQQ', 'IWM',
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
  'GLD', 'USO',
];

function fmtUsd(n: number | null | undefined, signed = false): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (!signed) return `$${v}`;
  return n >= 0 ? `+$${v}` : `-$${v}`;
}

function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

interface SizingCalculatorBodyProps {
  /** When true, renders compact/inline-friendly layout (no internal card chrome). */
  compact?: boolean;
  /** Called after a successful commit. Good hook to close a parent modal. */
  onCommitted?: (tradeId: string) => void;
}

export function SizingCalculatorBody({ compact, onCommitted }: SizingCalculatorBodyProps) {
  const qc = useQueryClient();

  // Inputs
  const [instrument, setInstrument] = useState<string>('SPY');
  const [customInstrument, setCustomInstrument] = useState<string>('');
  const [side, setSide] = useState<Side>('long');
  const [entryStr, setEntryStr] = useState<string>('');
  const [stopStr, setStopStr] = useState<string>('');
  const [targetStr, setTargetStr] = useState<string>('');
  const [bookOverrideStr, setBookOverrideStr] = useState<string>('');
  const [riskPctStr, setRiskPctStr] = useState<string>(() => String(loadPersistedRiskPct(1)));
  const [thesis, setThesis] = useState<string>('');
  const [committing, setCommitting] = useState(false);

  // Persist risk% on change (debounced via effect)
  useEffect(() => {
    const n = parseFloat(riskPctStr);
    if (Number.isFinite(n) && n > 0) persistRiskPct(n);
  }, [riskPctStr]);

  const parsed = useMemo(() => {
    const entry = parseFloat(entryStr);
    const stop = parseFloat(stopStr);
    const target = parseFloat(targetStr);
    const book = parseFloat(bookOverrideStr);
    const risk = parseFloat(riskPctStr);
    return {
      entry: Number.isFinite(entry) ? entry : null,
      stop: Number.isFinite(stop) ? stop : null,
      target: Number.isFinite(target) ? target : null,
      book: Number.isFinite(book) && book > 0 ? book : null,
      risk: Number.isFinite(risk) && risk > 0 ? risk : 1,
    };
  }, [entryStr, stopStr, targetStr, bookOverrideStr, riskPctStr]);

  const resolvedInstrument = (instrument === '__custom__' ? customInstrument : instrument)
    .trim()
    .toUpperCase();

  const sizing = usePositionSizing({
    instrument: resolvedInstrument,
    side,
    entryPrice: parsed.entry,
    stopPrice: parsed.stop,
    targetPrice: parsed.target,
    bookEquityOverride: parsed.book,
    riskPct: parsed.risk,
    contractType: 'underlying',
  });

  const canCommit =
    resolvedInstrument.length > 0 &&
    resolvedInstrument.length <= 10 &&
    sizing.hasValidStop &&
    sizing.recommendedPct > 0 &&
    !committing;

  async function onCommit() {
    if (!canCommit) return;
    setCommitting(true);
    try {
      const rpcArgs = {
        p_instrument: resolvedInstrument,
        p_side: side,
        p_size_pct: Number(sizing.recommendedPct.toFixed(2)),
        p_contract_type: 'underlying' as const,
        p_strike: null,
        p_expiry: null,
        p_contracts: null,
        p_entry_premium: null,
        p_entry_price: parsed.entry, // if present, opens immediately; else book-manager fills
        p_stop_price: parsed.stop,
        p_target_price: parsed.target,
        p_thesis: thesis.trim() || `sizing-calc ${side} ${resolvedInstrument} @${sizing.riskPct}% risk`,
        p_horizon: 'intraday',
        p_conviction: 3,
      };
      const { data, error } = await supabase.rpc('commit_manual_trade', rpcArgs);
      if (error) {
        toast.error(`commit failed: ${error.message}`);
        return;
      }
      const tradeId = (data as unknown) as string;
      toast.success(
        `✓ committed ${resolvedInstrument} ${side} ${rpcArgs.p_size_pct}% — trade ${tradeId.slice(0, 8)}`,
      );
      // Refetch book/trades so the UI reflects the new row.
      qc.invalidateQueries({ queryKey: ['ct_trades_today'] });
      qc.invalidateQueries({ queryKey: ['ct_book_today'] });
      qc.invalidateQueries({ queryKey: ['book_all_trades'] });
      qc.invalidateQueries({ queryKey: ['book_all_sessions'] });
      onCommitted?.(tradeId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`commit error: ${msg}`);
    } finally {
      setCommitting(false);
    }
  }

  const content = (
    <div className="space-y-3">
      {!compact && (
        <div className="flex items-center gap-2 pb-1">
          <Ruler className="w-4 h-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wide">Position Sizing</h3>
          <span className="text-[10px] text-muted-foreground">R-based · Kelly-aware</span>
        </div>
      )}

      {/* Instrument + Side */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Instrument</Label>
          <Select value={instrument} onValueChange={setInstrument}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEFAULT_WATCHLIST.map(t => (
                <SelectItem key={t} value={t} className="text-xs">{t}</SelectItem>
              ))}
              <SelectItem value="__custom__" className="text-xs">Custom…</SelectItem>
            </SelectContent>
          </Select>
          {instrument === '__custom__' && (
            <Input
              autoFocus
              value={customInstrument}
              onChange={e => setCustomInstrument(e.target.value.toUpperCase())}
              placeholder="TICKER"
              className="h-8 text-xs mt-1 font-mono"
              maxLength={10}
            />
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Side</Label>
          <div className="flex gap-1">
            <Button
              type="button"
              size="sm"
              variant={side === 'long' ? 'default' : 'outline'}
              onClick={() => setSide('long')}
              className="flex-1 h-8 text-xs"
            >
              <TrendingUp className="w-3 h-3 mr-1" /> long
            </Button>
            <Button
              type="button"
              size="sm"
              variant={side === 'short' ? 'default' : 'outline'}
              onClick={() => setSide('short')}
              className="flex-1 h-8 text-xs"
            >
              <TrendingDown className="w-3 h-3 mr-1" /> short
            </Button>
          </div>
        </div>
      </div>

      {/* Prices */}
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Entry</Label>
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={entryStr}
            onChange={e => setEntryStr(e.target.value)}
            placeholder="710"
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Stop</Label>
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={stopStr}
            onChange={e => setStopStr(e.target.value)}
            placeholder="708"
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Target</Label>
          <Input
            type="number"
            inputMode="decimal"
            step="0.01"
            value={targetStr}
            onChange={e => setTargetStr(e.target.value)}
            placeholder="714"
            className="h-8 text-xs font-mono"
          />
        </div>
      </div>

      {/* Book + Risk% */}
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Book equity{' '}
            <span className="text-[9px] normal-case text-muted-foreground/70">
              ({sizing.bookEquitySource === 'override'
                ? 'override'
                : sizing.bookEquitySource === 'ct_book'
                  ? 'auto'
                  : 'fallback'})
            </span>
          </Label>
          <Input
            type="number"
            inputMode="decimal"
            step="1"
            value={bookOverrideStr}
            onChange={e => setBookOverrideStr(e.target.value)}
            placeholder={sizing.bookEquity.toFixed(0)}
            className="h-8 text-xs font-mono"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Risk % of book</Label>
          <Input
            type="number"
            inputMode="decimal"
            step="0.1"
            min="0.1"
            value={riskPctStr}
            onChange={e => setRiskPctStr(e.target.value)}
            placeholder="1.0"
            className="h-8 text-xs font-mono"
          />
        </div>
      </div>

      {/* Outputs */}
      <div className="rounded border border-border bg-muted/20 p-2 space-y-1 text-[11px] font-mono">
        <OutputRow label="Stop distance">
          {fmtUsd(sizing.stopDistance)} · {fmtPct(sizing.stopDistancePct)}
        </OutputRow>
        <OutputRow label="Risk (1R)">
          {fmtUsd(sizing.riskDollars)}
        </OutputRow>
        <OutputRow label="Shares @ 1R">
          {sizing.shares.toLocaleString()}
        </OutputRow>
        <OutputRow label="Position notional">
          {fmtUsd(sizing.positionNotional)} · {fmtPct(sizing.positionPctOfBook)}
        </OutputRow>
        <OutputRow label="Reward-to-risk">
          {sizing.rewardToRisk == null ? '—' : `${fmtNum(sizing.rewardToRisk, 2)}R`}
        </OutputRow>
        <OutputRow label="Kelly size">
          {sizing.kellyPct == null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            fmtPct(sizing.kellyPct)
          )}
          {sizing.historicalTrades > 0 && (
            <span className="text-[9px] text-muted-foreground ml-1">
              ({sizing.historicalTrades}t · {fmtPct((sizing.historicalWinRate ?? 0) * 100, 0)} win)
            </span>
          )}
        </OutputRow>
        <div className="h-px bg-border my-1" />
        <OutputRow label="Recommended" highlight>
          <span className="text-primary font-semibold">
            {fmtPct(sizing.recommendedPct)} · {sizing.recommendedShares.toLocaleString()} sh · {fmtUsd(sizing.recommendedNotional)}
          </span>
        </OutputRow>
      </div>

      {/* Warnings */}
      <div className="space-y-1">
        {sizing.warnings.stopTooTight && (
          <WarnBanner>Stop &lt; 0.3% — too tight, likely to whipsaw out</WarnBanner>
        )}
        {sizing.warnings.poorRewardToRisk && (
          <WarnBanner>R:R &lt; 1.5 — negative expectancy at 50% hit rate</WarnBanner>
        )}
        {sizing.warnings.concentrationRisk && (
          <WarnBanner>Size &gt; 30% — concentration risk</WarnBanner>
        )}
        {sizing.warnings.thinKellyEdge && (
          <WarnBanner>Kelly &lt; 5% — historical edge is thin on this setup type</WarnBanner>
        )}
      </div>

      {/* Thesis */}
      <div className="space-y-1">
        <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Thesis (optional)</Label>
        <Input
          value={thesis}
          onChange={e => setThesis(e.target.value)}
          placeholder="why this trade?"
          className="h-8 text-xs"
          maxLength={240}
        />
      </div>

      {/* Commit */}
      <Button
        type="button"
        onClick={onCommit}
        disabled={!canCommit}
        className="w-full h-9 text-xs"
      >
        <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
        {committing
          ? 'committing…'
          : !sizing.hasValidStop
            ? 'enter valid entry + stop'
            : `commit ${resolvedInstrument || '—'} ${side} ${fmtPct(sizing.recommendedPct, 1)}`}
      </Button>

      {sizing.optionsApproximated && (
        <p className="text-[9px] text-muted-foreground">
          Options sizing approximated — contract-level greeks/premium not yet modeled (v2).
        </p>
      )}
    </div>
  );

  if (compact) return content;
  return <Card className="p-3">{content}</Card>;
}

function OutputRow({
  label,
  children,
  highlight,
}: {
  label: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between ${highlight ? 'text-[12px]' : ''}`}>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span>{children}</span>
    </div>
  );
}

function WarnBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-300">
      <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
      <span>{children}</span>
    </div>
  );
}

/**
 * Inline widget wrapper — for /book alongside risk metrics.
 * Uses the compact body so it slots into a column of cards cleanly.
 */
export function SizingCalculatorInline() {
  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border bg-muted/20 flex items-center gap-2">
        <Ruler className="w-4 h-4 text-primary" />
        <h3 className="text-xs font-semibold uppercase tracking-wide text-foreground">Sizing</h3>
        <span className="text-[10px] text-muted-foreground">R-based · Kelly-aware</span>
      </div>
      <div className="p-3">
        <SizingCalculatorBody compact />
      </div>
    </Card>
  );
}

/**
 * Modal wrapper — controlled. 400px wide, single column.
 */
export function SizingCalculatorModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[400px] p-4">
        <DialogHeader className="mb-2">
          <DialogTitle className="text-sm flex items-center gap-2">
            <Ruler className="w-4 h-4 text-primary" /> Position Sizing
          </DialogTitle>
        </DialogHeader>
        <SizingCalculatorBody compact onCommitted={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Trigger button + self-contained modal. Drop anywhere in a header.
 */
export function SizingCalculatorButton({
  variant = 'outline',
  size = 'sm',
  className,
}: {
  variant?: 'default' | 'outline' | 'secondary' | 'ghost';
  size?: 'default' | 'sm' | 'lg';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={variant} size={size} className={className}>
          <Ruler className="w-3.5 h-3.5 mr-1" /> Size
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-[400px] p-4">
        <DialogHeader className="mb-2">
          <DialogTitle className="text-sm flex items-center gap-2">
            <Ruler className="w-4 h-4 text-primary" /> Position Sizing
          </DialogTitle>
        </DialogHeader>
        <SizingCalculatorBody compact onCommitted={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}
