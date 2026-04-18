/**
 * TradeCommit (/commit) — paper-trade commit form with LIVE gauntlet preview.
 *
 * What this page is:
 *   Left column  → form: instrument, side, size%, entry, stop, target,
 *                  horizon, conviction, thesis + conditional option fields
 *                  (contract_type ≠ underlying). Includes an OCC-symbol
 *                  convenience parser: "SPY 710C 4/18 @1.25" auto-fills
 *                  strike/expiry/type/premium.
 *   Right column → <PreTradeChecklist /> (wave 20) wired to the live draft,
 *                  updating as the form changes (debounced 500ms). This is
 *                  what makes /commit different from /commit-in-chat and
 *                  from the wave-16 SizingCalculator button: the 7-check
 *                  pre-trade gauntlet is on-screen BEFORE commit.
 *   Bottom       → commit button. Hard-disabled if ct_kill_switch active
 *                  or gate returns block-level failures. If only warns
 *                  present, commit is allowed but the confirm modal flags
 *                  them. Summary confirm modal before RPC fires.
 *   Below        → last 10 manual commits from ct_trades (source='james_manual').
 *
 * Flow:
 *   validate → confirm modal → commit_manual_trade RPC → toast + /book.
 *
 * Does NOT:
 *   - bypass the pre-trade gate
 *   - auto-close anything
 *   - deploy / commit / push (that's the builder's job, not the form's)
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
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
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  CheckCircle2,
  Shield,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  Ruler,
  Wand2,
  ArrowRight,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { PreTradeChecklist } from '@/components/command/PreTradeChecklist';
import { SizingCalculatorModal } from '@/components/command/SizingCalculator';
import { useCtKillSwitch } from '@/hooks/useCtKillSwitch';

// ---- constants ---------------------------------------------------------

const DEFAULT_WATCHLIST = [
  'SPY', 'QQQ', 'IWM',
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA',
  'GLD', 'USO',
];

type Side = 'long' | 'short';
type ContractType = 'underlying' | 'call' | 'put';
type Horizon = 'scalp' | 'intraday' | 'swing' | 'position';

// ---- OCC parser --------------------------------------------------------

interface ParsedOcc {
  instrument?: string;
  strike?: number;
  expiry?: string;          // YYYY-MM-DD
  contract_type?: 'call' | 'put';
  entry_premium?: number;
}

/**
 * Parse a casual OCC-ish blob into fields. Accepts forms like:
 *   "SPY 710C 4/18 @1.25"
 *   "spy 710c 04/18 @ 1.25"
 *   "SPY 710 C 4/18/26 1.25"
 *   "QQQ 470P 12/20 @2.00"
 * Year is optional — assumes current or next year (whichever yields a
 * future date). Returns partial matches — caller decides what to apply.
 */
export function parseOccCasual(raw: string): ParsedOcc {
  const out: ParsedOcc = {};
  const s = raw.trim().toUpperCase();
  if (!s) return out;

  // 1) Instrument: first all-letter token, 1–6 chars
  const tickerMatch = s.match(/\b([A-Z]{1,6})\b/);
  if (tickerMatch) out.instrument = tickerMatch[1];

  // 2) Strike + contract type — "710C", "470.5P", "710 C"
  const strikeMatch = s.match(/\b(\d+(?:\.\d+)?)\s*([CP])\b/);
  if (strikeMatch) {
    out.strike = parseFloat(strikeMatch[1]);
    out.contract_type = strikeMatch[2] === 'C' ? 'call' : 'put';
  }

  // 3) Expiry — M/D, M/D/YY, M/D/YYYY
  const dateMatch = s.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/);
  if (dateMatch) {
    const mm = parseInt(dateMatch[1], 10);
    const dd = parseInt(dateMatch[2], 10);
    const rawYear = dateMatch[3];
    let yyyy: number;
    if (rawYear) {
      yyyy = rawYear.length === 2 ? 2000 + parseInt(rawYear, 10) : parseInt(rawYear, 10);
    } else {
      // Pick the nearest future date (this year if M/D hasn't passed, else next year)
      const today = new Date();
      const thisYear = today.getFullYear();
      const candidate = new Date(thisYear, mm - 1, dd);
      yyyy = candidate.getTime() < today.getTime() - 24 * 60 * 60 * 1000
        ? thisYear + 1
        : thisYear;
    }
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      out.expiry = `${yyyy.toString().padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }
  }

  // 4) Premium — "@1.25" or the last bare decimal that isn't the strike
  const premAt = s.match(/@\s*(\d+(?:\.\d+)?)/);
  if (premAt) {
    out.entry_premium = parseFloat(premAt[1]);
  } else {
    // Last numeric token that's not the strike and has a decimal
    const nums = [...s.matchAll(/\b(\d+\.\d+)\b/g)].map(m => parseFloat(m[1]));
    const candidates = nums.filter(n => n !== out.strike);
    if (candidates.length > 0) out.entry_premium = candidates[candidates.length - 1];
  }

  return out;
}

// ---- helpers -----------------------------------------------------------

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

function fmtPct(n: number | null | undefined, signed = false, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const v = n.toFixed(digits);
  if (!signed) return `${v}%`;
  return n >= 0 ? `+${v}%` : `${v}%`;
}

// ---- live price hook ---------------------------------------------------

/**
 * Latest per-ticker price pulled from ct_heartbeats._snapshot.per_ticker —
 * same source useMarketBreadth/useColdOpen read.
 */
function useLivePrice(ticker: string | null) {
  return useQuery<number | null>({
    queryKey: ['ct_heartbeat_price', ticker],
    enabled: !!ticker,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!ticker) return null;
      const { data, error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from('ct_heartbeats' as any)
        .select('current_reads')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      // current_reads shape: { _snapshot: { per_ticker: { [ticker]: { price } } } }
      const reads = (data as { current_reads: Record<string, unknown> }).current_reads;
      const snap = reads?._snapshot as { per_ticker?: Record<string, { price?: number | null }> } | undefined;
      const px = snap?.per_ticker?.[ticker]?.price;
      return typeof px === 'number' ? px : null;
    },
  });
}

// ---- recent manual commits --------------------------------------------

interface RecentCommit {
  id: string;
  session_date: string;
  instrument: string;
  side: Side;
  size_pct: number | null;
  contract_type: ContractType;
  status: string;
  entry_price: number | null;
  created_at: string;
}

function useRecentManualCommits() {
  return useQuery<RecentCommit[]>({
    queryKey: ['recent_manual_commits'],
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_trades')
        .select('id, session_date, instrument, side, size_pct, contract_type, status, entry_price, created_at')
        .eq('source', 'james_manual')
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as RecentCommit[];
    },
  });
}

// ---- component ---------------------------------------------------------

export default function TradeCommit() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ctKill = useCtKillSwitch();
  const killActive = ctKill.state?.active === true;

  // --- form state -------------------------------------------------------

  const [instrument, setInstrument] = useState<string>('SPY');
  const [customInstrument, setCustomInstrument] = useState<string>('');
  const [side, setSide] = useState<Side>('long');
  const [sizePctStr, setSizePctStr] = useState<string>('10');
  const [entryStr, setEntryStr] = useState<string>('');
  const [stopStr, setStopStr] = useState<string>('');
  const [targetStr, setTargetStr] = useState<string>('');
  const [horizon, setHorizon] = useState<Horizon>('intraday');
  const [conviction, setConviction] = useState<number>(3);
  const [thesis, setThesis] = useState<string>('');

  // Options
  const [contractType, setContractType] = useState<ContractType>('underlying');
  const [strikeStr, setStrikeStr] = useState<string>('');
  const [expiryStr, setExpiryStr] = useState<string>('');        // YYYY-MM-DD
  const [contractsStr, setContractsStr] = useState<string>('');
  const [premiumStr, setPremiumStr] = useState<string>('');
  const [occInput, setOccInput] = useState<string>('');

  // UI
  const [sizingModalOpen, setSizingModalOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [committing, setCommitting] = useState(false);

  const resolvedInstrument = (instrument === '__custom__' ? customInstrument : instrument)
    .trim()
    .toUpperCase();

  const parsed = useMemo(() => {
    const numOrNull = (s: string): number | null => {
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : null;
    };
    return {
      sizePct: numOrNull(sizePctStr),
      entry: numOrNull(entryStr),
      stop: numOrNull(stopStr),
      target: numOrNull(targetStr),
      strike: numOrNull(strikeStr),
      contracts: numOrNull(contractsStr),
      premium: numOrNull(premiumStr),
    };
  }, [sizePctStr, entryStr, stopStr, targetStr, strikeStr, contractsStr, premiumStr]);

  // ---- draft for <PreTradeChecklist /> — debounced via its own 250ms ---

  // We debounce the draft KEY at 500ms (per spec); PreTradeChecklist adds
  // its own 250ms on top for a total of ~500ms from last keystroke.
  const [debouncedTick, setDebouncedTick] = useState(0);
  const draftKey = JSON.stringify({
    instrument: resolvedInstrument,
    side,
    size_pct: parsed.sizePct,
    contract_type: contractType,
    thesis_theme: thesis || null,
  });
  useEffect(() => {
    const t = setTimeout(() => setDebouncedTick(v => v + 1), 500);
    return () => clearTimeout(t);
  }, [draftKey]);

  // Freeze draft object so PreTradeChecklist doesn't rerun on every
  // unrelated parent render. New object only when debouncedTick flips.
  const gateDraft = useMemo(() => ({
    instrument: resolvedInstrument || null,
    side: side,
    size_pct: parsed.sizePct,
    contract_type: contractType,
    thesis_theme: thesis || null,
    source: 'manual' as const,
  }), [debouncedTick]);  // eslint-disable-line react-hooks/exhaustive-deps

  // ---- gate status — we call the function ONCE more here to compute
  //     block-vs-warn so we can enable/disable the commit button. Same
  //     debounce; shared key ensures PreTradeChecklist reads the same
  //     cached response (Supabase doesn't cache, so we re-invoke — cheap). --

  const { data: gate, isLoading: gateLoading } = useQuery<{
    passed: boolean;
    checks: { name: string; status: 'pass' | 'warn' | 'block' }[];
    blockers: { name: string }[];
  }>({
    queryKey: ['ct_pre_trade_check_commit_page', gateDraft],
    refetchInterval: 0,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke('ct-pre-trade-check', {
        body: { trade: gateDraft },
      });
      if (error) throw error;
      return data;
    },
    staleTime: 30_000,
  });

  const hasBlocker = (gate?.blockers?.length ?? 0) > 0;
  const hasWarn = (gate?.checks ?? []).some(c => c.status === 'warn');

  // ---- live R-multiple preview -----------------------------------------

  const livePriceQ = useLivePrice(resolvedInstrument || null);
  const livePrice = livePriceQ.data ?? null;

  const rMultiple = useMemo(() => {
    const { entry, stop } = parsed;
    if (entry == null || stop == null || livePrice == null) return null;
    const stopDist = Math.abs(entry - stop);
    if (stopDist <= 0) return null;
    const sign = side === 'long' ? 1 : -1;
    return (sign * (livePrice - entry)) / stopDist;
  }, [parsed.entry, parsed.stop, livePrice, side]);

  // ---- OCC paste -> fill -----------------------------------------------

  function applyOcc() {
    const p = parseOccCasual(occInput);
    if (p.instrument) {
      if (DEFAULT_WATCHLIST.includes(p.instrument)) {
        setInstrument(p.instrument);
      } else {
        setInstrument('__custom__');
        setCustomInstrument(p.instrument);
      }
    }
    if (p.contract_type) setContractType(p.contract_type);
    if (p.strike != null) setStrikeStr(String(p.strike));
    if (p.expiry) setExpiryStr(p.expiry);
    if (p.entry_premium != null) setPremiumStr(String(p.entry_premium));
    if (p.strike || p.contract_type || p.expiry || p.entry_premium) {
      toast.success('parsed OCC fields');
    } else {
      toast.error('couldn\u2019t parse — try "SPY 710C 4/18 @1.25"');
    }
  }

  // ---- validation ------------------------------------------------------

  const validationErrors = useMemo<string[]>(() => {
    const errs: string[] = [];
    if (!resolvedInstrument) errs.push('instrument required');
    if (resolvedInstrument.length > 10) errs.push('instrument too long');
    if (parsed.sizePct == null || parsed.sizePct <= 0) errs.push('size% required (> 0)');
    if (parsed.sizePct != null && parsed.sizePct > 40) errs.push('size% > 40 (cap enforced by RPC)');
    if (contractType === 'underlying') {
      if (parsed.stop == null) errs.push('stop required');
      if (parsed.entry != null && parsed.stop != null) {
        if (side === 'long' && parsed.stop >= parsed.entry) errs.push('long stop must be < entry');
        if (side === 'short' && parsed.stop <= parsed.entry) errs.push('short stop must be > entry');
      }
    } else {
      if (parsed.strike == null) errs.push('strike required');
      if (!expiryStr) errs.push('expiry required');
      if (parsed.contracts == null || parsed.contracts <= 0) errs.push('contracts required (> 0)');
      if (parsed.premium == null || parsed.premium <= 0) errs.push('entry_premium required (> 0)');
    }
    return errs;
  }, [resolvedInstrument, parsed, contractType, expiryStr, side]);

  const canCommit =
    !killActive &&
    !hasBlocker &&
    !gateLoading &&
    validationErrors.length === 0 &&
    !committing;

  // ---- commit flow -----------------------------------------------------

  async function doCommit() {
    if (!canCommit) return;
    setCommitting(true);
    try {
      const args = {
        p_instrument: resolvedInstrument,
        p_side: side,
        p_size_pct: Number((parsed.sizePct ?? 0).toFixed(2)),
        p_contract_type: contractType,
        p_strike: contractType === 'underlying' ? null : parsed.strike,
        p_expiry: contractType === 'underlying' ? null : expiryStr || null,
        p_contracts: contractType === 'underlying' ? null : parsed.contracts,
        p_entry_premium: contractType === 'underlying' ? null : parsed.premium,
        p_entry_price: parsed.entry,
        p_stop_price: parsed.stop,
        p_target_price: parsed.target,
        p_thesis: thesis.trim() || `manual commit /commit ${side} ${resolvedInstrument}`,
        p_horizon: horizon,
        p_conviction: conviction,
      };
      const { data, error } = await supabase.rpc('commit_manual_trade', args);
      if (error) {
        toast.error(`commit failed: ${error.message}`);
        return;
      }
      const tradeId = (data as unknown) as string;
      toast.success(
        `\u2713 committed ${resolvedInstrument} ${side} ${args.p_size_pct}% \u2014 trade ${String(tradeId).slice(0, 8)}`,
      );
      qc.invalidateQueries({ queryKey: ['ct_trades_today'] });
      qc.invalidateQueries({ queryKey: ['ct_book_today'] });
      qc.invalidateQueries({ queryKey: ['book_all_trades'] });
      qc.invalidateQueries({ queryKey: ['book_all_sessions'] });
      qc.invalidateQueries({ queryKey: ['recent_manual_commits'] });
      setConfirmOpen(false);
      navigate('/book');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`commit error: ${msg}`);
    } finally {
      setCommitting(false);
    }
  }

  // Approx risk for confirm modal
  const approxRiskUsd = useMemo(() => {
    if (contractType === 'underlying') {
      if (parsed.entry == null || parsed.stop == null || parsed.sizePct == null) return null;
      // size% is percent of book; we don't have book here, assume $10k default for display
      const approxBook = 10_000;
      const notional = approxBook * (parsed.sizePct / 100);
      const sharesApprox = notional / parsed.entry;
      return Math.abs(sharesApprox * (parsed.entry - parsed.stop));
    }
    if (parsed.contracts != null && parsed.premium != null) {
      return parsed.contracts * parsed.premium * 100;
    }
    return null;
  }, [parsed, contractType]);

  // ---- render ----------------------------------------------------------

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-6xl mx-auto p-4 space-y-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              Commit Trade
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Gauntlet-gated paper trade commit. Same path as <code>/commit</code> in chat.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setSizingModalOpen(true)}>
              <Ruler className="w-3.5 h-3.5 mr-1" /> Use Sizing Calculator
            </Button>
          </div>
        </div>

        {/* Kill-switch banner */}
        {killActive && (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 flex items-start gap-2 text-xs">
            <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-red-300">ct_kill_switch is engaged</div>
              <div className="text-red-300/70 mt-0.5">
                Commit disabled. Reason: {ctKill.state?.engagedReason ?? '(none)'}.
                Disarm from the top nav to proceed.
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">

          {/* Left + Middle — form spans 2 cols */}
          <Card className="md:col-span-2 p-4 space-y-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
              Draft
            </div>

            {/* Instrument + side */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Instrument</Label>
                <Select value={instrument} onValueChange={setInstrument}>
                  <SelectTrigger className="h-9 text-xs">
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
                    className="h-9 text-xs font-mono mt-1"
                    maxLength={10}
                  />
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Side</Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant={side === 'long' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSide('long')}
                    className="flex-1 h-9 text-xs"
                  >
                    <TrendingUp className="w-3.5 h-3.5 mr-1" /> long
                  </Button>
                  <Button
                    type="button"
                    variant={side === 'short' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setSide('short')}
                    className="flex-1 h-9 text-xs"
                  >
                    <TrendingDown className="w-3.5 h-3.5 mr-1" /> short
                  </Button>
                </div>
              </div>
            </div>

            {/* Contract type */}
            <div className="grid grid-cols-[1fr,2fr] gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Contract</Label>
                <Select value={contractType} onValueChange={v => setContractType(v as ContractType)}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="underlying" className="text-xs">underlying (shares)</SelectItem>
                    <SelectItem value="call" className="text-xs">call option</SelectItem>
                    <SelectItem value="put" className="text-xs">put option</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {contractType !== 'underlying' && (
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground flex items-center gap-1">
                    <Wand2 className="w-3 h-3" /> Paste OCC shorthand
                  </Label>
                  <div className="flex gap-1">
                    <Input
                      value={occInput}
                      onChange={e => setOccInput(e.target.value)}
                      placeholder='"SPY 710C 4/18 @1.25"'
                      className="h-9 text-xs font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 text-xs"
                      onClick={applyOcc}
                    >
                      Parse
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Prices */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Entry</Label>
                <Input
                  type="number" inputMode="decimal" step="0.01"
                  value={entryStr}
                  onChange={e => setEntryStr(e.target.value)}
                  placeholder="710"
                  className="h-9 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Stop</Label>
                <Input
                  type="number" inputMode="decimal" step="0.01"
                  value={stopStr}
                  onChange={e => setStopStr(e.target.value)}
                  placeholder="708"
                  className="h-9 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Target</Label>
                <Input
                  type="number" inputMode="decimal" step="0.01"
                  value={targetStr}
                  onChange={e => setTargetStr(e.target.value)}
                  placeholder="714"
                  className="h-9 text-xs font-mono"
                />
              </div>
            </div>

            {/* Size + horizon + conviction */}
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Size %</Label>
                <Input
                  type="number" inputMode="decimal" step="0.5" min="0.5" max="40"
                  value={sizePctStr}
                  onChange={e => setSizePctStr(e.target.value)}
                  placeholder="10"
                  className="h-9 text-xs font-mono"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Horizon</Label>
                <Select value={horizon} onValueChange={v => setHorizon(v as Horizon)}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="scalp" className="text-xs">scalp</SelectItem>
                    <SelectItem value="intraday" className="text-xs">intraday</SelectItem>
                    <SelectItem value="swing" className="text-xs">swing</SelectItem>
                    <SelectItem value="position" className="text-xs">position</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Conviction (1–5)</Label>
                <Select value={String(conviction)} onValueChange={v => setConviction(parseInt(v, 10))}>
                  <SelectTrigger className="h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5].map(n => (
                      <SelectItem key={n} value={String(n)} className="text-xs">{n}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Option-only fields */}
            {contractType !== 'underlying' && (
              <div className="grid grid-cols-4 gap-3">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Strike</Label>
                  <Input
                    type="number" inputMode="decimal" step="0.5"
                    value={strikeStr}
                    onChange={e => setStrikeStr(e.target.value)}
                    placeholder="710"
                    className="h-9 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Expiry</Label>
                  <Input
                    type="date"
                    value={expiryStr}
                    onChange={e => setExpiryStr(e.target.value)}
                    className="h-9 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Contracts</Label>
                  <Input
                    type="number" inputMode="numeric" step="1" min="1"
                    value={contractsStr}
                    onChange={e => setContractsStr(e.target.value)}
                    placeholder="1"
                    className="h-9 text-xs font-mono"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Entry premium</Label>
                  <Input
                    type="number" inputMode="decimal" step="0.01" min="0"
                    value={premiumStr}
                    onChange={e => setPremiumStr(e.target.value)}
                    placeholder="1.25"
                    className="h-9 text-xs font-mono"
                  />
                </div>
              </div>
            )}

            {/* Thesis */}
            <div className="space-y-1">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Thesis</Label>
              <Textarea
                value={thesis}
                onChange={e => setThesis(e.target.value)}
                placeholder="why this trade? (will be joined to session context + used by the grader)"
                className="text-xs min-h-[60px]"
                maxLength={500}
              />
            </div>

            {/* Live R-multiple preview */}
            {parsed.entry != null && parsed.stop != null && (
              <div className="rounded border border-border bg-muted/20 px-3 py-2 flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Live P&amp;L</span>
                  {livePriceQ.isLoading ? (
                    <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
                  ) : livePrice != null ? (
                    <span className="font-mono">last {fmtUsd(livePrice)}</span>
                  ) : (
                    <span className="text-muted-foreground">no price yet</span>
                  )}
                </div>
                <div className="font-mono">
                  {rMultiple != null ? (
                    <span className={rMultiple >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {fmtNum(rMultiple, 2)}R
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            )}

            {/* Validation / status row */}
            {validationErrors.length > 0 && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs space-y-1">
                {validationErrors.map((e, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-amber-300">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {e}
                  </div>
                ))}
              </div>
            )}

            {/* Commit button */}
            <div className="flex items-center justify-between gap-3 pt-1">
              <div className="text-[10px] text-muted-foreground">
                {killActive
                  ? 'Disabled — kill switch engaged.'
                  : hasBlocker
                    ? `Disabled — ${gate?.blockers?.length} block-level gate${gate?.blockers?.length === 1 ? '' : 's'}.`
                    : hasWarn
                      ? 'Warnings present — commit allowed after confirm.'
                      : gateLoading
                        ? 'Gate loading…'
                        : 'All clear.'}
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => setConfirmOpen(true)}
                disabled={!canCommit}
                className="h-9 text-xs"
              >
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                {hasWarn ? 'Review warnings \u2192 commit' : 'Commit'}
                <ArrowRight className="w-3 h-3 ml-1 opacity-70" />
              </Button>
            </div>
          </Card>

          {/* Right — live gauntlet */}
          <div className="space-y-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium px-1">
              Live pre-trade gauntlet
            </div>
            <PreTradeChecklist trade={gateDraft} />
            <p className="text-[10px] text-muted-foreground px-1">
              Updates 500ms after the last edit. Block-level checks hard-disable commit.
              Warnings are surfaced in the confirm modal.
            </p>
          </div>
        </div>

        {/* Recent manual commits */}
        <RecentCommitsCard />
      </div>

      {/* Sizing calculator modal */}
      <SizingCalculatorModal
        open={sizingModalOpen}
        onOpenChange={(o) => {
          setSizingModalOpen(o);
          if (!o) {
            // After the modal commits it invalidates queries; we just
            // refresh our recent list here too.
            qc.invalidateQueries({ queryKey: ['recent_manual_commits'] });
          }
        }}
      />

      {/* Confirm modal */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <Shield className="w-4 h-4 text-primary" />
              Confirm commit
            </DialogTitle>
            <DialogDescription className="text-xs">
              Calls <code>commit_manual_trade</code> RPC. Same path as chat <code>/commit</code>.
            </DialogDescription>
          </DialogHeader>

          <div className="text-xs space-y-2">
            <div className="rounded border border-border bg-muted/20 p-3 space-y-1 font-mono">
              <div>
                <span className="text-muted-foreground">Commit </span>
                <span className="font-semibold">{resolvedInstrument}</span>{' '}
                <span className="uppercase">{side}</span>{' '}
                <span>{fmtPct(parsed.sizePct ?? 0, false, 1)}</span>
                {contractType !== 'underlying' && (
                  <> ({contractType} {parsed.strike} {expiryStr})</>
                )}
              </div>
              {parsed.entry != null && <div>entry: {fmtUsd(parsed.entry)}</div>}
              {parsed.stop != null && <div>stop: {fmtUsd(parsed.stop)}</div>}
              {parsed.target != null && <div>target: {fmtUsd(parsed.target)}</div>}
              {approxRiskUsd != null && <div>risk: ~{fmtUsd(approxRiskUsd)}</div>}
              <div>horizon: {horizon} · conviction: {conviction}</div>
            </div>

            {hasWarn && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 space-y-1">
                <div className="flex items-center gap-1.5 text-amber-300 font-medium">
                  <AlertTriangle className="w-3 h-3" /> Gate warnings
                </div>
                {(gate?.checks ?? []).filter(c => c.status === 'warn').map(c => (
                  <div key={c.name} className="text-amber-300/80">· {c.name}</div>
                ))}
                <div className="text-[10px] text-amber-300/60 pt-1">
                  Warnings are not blocking. Commit will proceed and the trade will be
                  tagged as warned in ct_trade_actions.
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(false)} disabled={committing}>
              Cancel
            </Button>
            <Button size="sm" onClick={doCommit} disabled={committing || !canCommit}>
              {committing ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> committing…</> : 'Yes — commit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---- recent commits card ----------------------------------------------

function RecentCommitsCard() {
  const { data, isLoading } = useRecentManualCommits();

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-medium">
          Last 10 manual commits
        </div>
        {isLoading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
      </div>
      {!data || data.length === 0 ? (
        <div className="text-xs text-muted-foreground py-4 text-center">
          No manual commits yet. Your first one will land here.
        </div>
      ) : (
        <div className="divide-y divide-border/60">
          {data.map(row => (
            <div key={row.id} className="flex items-center justify-between gap-3 py-1.5 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <Badge variant="outline" className="h-5 text-[10px] shrink-0">
                  {row.status}
                </Badge>
                <span className="font-mono font-semibold">{row.instrument}</span>
                <span className="uppercase text-muted-foreground">{row.side}</span>
                <span className="text-muted-foreground shrink-0">
                  {row.contract_type}{row.size_pct != null && ` · ${fmtPct(row.size_pct, false, 1)}`}
                </span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="font-mono text-muted-foreground">
                  {row.entry_price != null ? fmtUsd(row.entry_price) : '—'}
                </span>
                <span className="text-muted-foreground text-[10px]">
                  {new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
