/**
 * TickerSheet — per-ticker briefing opened from Tape.
 *
 * Answers: "what's happening on this ticker right now?" Three panes:
 *   1. Hot contracts today (top 8 by premium AND by Vol/OI)
 *   2. Latest specialist flags for this ticker (from ct_flags)
 *   3. Specialist's latest take — pulled from ct_specialist_memory if present,
 *      else ct_flags thesis of the most recent flag
 *
 * Click hot contract → opens ContractDrillSheet for that option_symbol.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Flame, Activity, Brain, TrendingUp, TrendingDown, ArrowUp, ArrowDown, Minus, Newspaper, Globe, Loader2, Target, Gauge, LineChart } from 'lucide-react';
import { toast } from 'sonner';
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChartSafe } from '@/components/ChartSafe';
import { ContractDrillSheet } from '@/components/co-trader/ContractDrillSheet';
import {
  useOvernightPositioning,
  normalizeSide,
  formatDollarsCompact,
  formatDeltaContracts,
  formatMoneyness,
} from '@/hooks/useOvernightPositioning';
import { useTickerIntradayContext, RegimeChip } from '@/hooks/useTickerIntradayContext';
import { useSpecialistReads, type SpecialistRead } from '@/hooks/useSpecialistReads';

interface HotContractRow {
  option_symbol: string;
  side: 'call' | 'put' | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  classification: string | null;
  direction: string | null;
  score: number | null;
  premium: number | null;
  volume: number | null;
  open_interest: number | null;
  event_ts: string;
}

interface FlagRow {
  id: string;
  option_symbol: string | null;
  direction: 'bullish' | 'bearish' | 'neutral';
  score: number;
  thesis: string;
  invalidation: string;
  horizon_ts: string | null;
  status: string;
  created_at: string;
  tags: string[] | null;
}

interface LatestPriceRow {
  close: number | null;
  volume: number | null;
  ts: string;
}

interface TickerSnapshotRow {
  ticker: string;
  spot: number | null;
  gamma_flip: number | null;
  call_wall: number | null;
  put_wall: number | null;
  max_pain: number | null;
  iv_rank: number | null;
  iv_percentile: number | null;
  net_gamma: number | null;
  regime: string | null;
  put_call_ratio: number | null;
  net_premium_cum: number | null;
  next_earnings_date: string | null;
  earnings_expected_move: number | null;
  snapshot_at: string | null;
  recent_news: Array<{
    headline: string;
    source: string | null;
    impact: string | null;
    significance: number | null;
    claude_take: string | null;
    created_at: string;
    news_timestamp: string | null;
  }> | null;
}

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score?: number;
}

function formatPremium(n: number | null): string {
  if (n == null) return '-';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function sideColor(side: string | null): string {
  if (side === 'call') return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50';
  if (side === 'put') return 'bg-red-500/20 text-red-300 border-red-500/50';
  return 'bg-slate-500/20 text-slate-300 border-slate-500/50';
}

/**
 * Parse call/put from an OCC option symbol. ct_scored_flow doesn't carry
 * side, and ct_flow_alerts.side is frequently null (UW returns null on
 * flow-alerts). OCC format: ROOT + YYMMDD + (C|P) + 8-digit strike.
 */
function parseOccSide(sym: string | null | undefined): 'call' | 'put' | null {
  if (!sym || sym.length < 9) return null;
  const ch = sym.charAt(sym.length - 9);
  if (ch === 'C' || ch === 'c') return 'call';
  if (ch === 'P' || ch === 'p') return 'put';
  return null;
}

function directionPill(d: string | null): string {
  if (d === 'bullish') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  if (d === 'bearish') return 'bg-red-500/15 text-red-300 border-red-500/40';
  return 'bg-slate-500/15 text-slate-300 border-slate-500/40';
}

function directionColor(d: string | null): string {
  if (d === 'bullish') return 'text-emerald-400';
  if (d === 'bearish') return 'text-red-400';
  return 'text-muted-foreground';
}

function leanChipClass(d: string | null | undefined): string {
  if (d === 'bullish') return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40';
  if (d === 'bearish') return 'bg-rose-500/15 text-rose-300 border-rose-500/40';
  if (d === 'mixed') return 'bg-amber-500/15 text-amber-300 border-amber-500/40';
  return 'bg-slate-500/15 text-slate-300 border-slate-500/40';
}

function leanTextColor(d: string | null | undefined): string {
  if (d === 'bullish') return 'text-emerald-300';
  if (d === 'bearish') return 'text-rose-300';
  if (d === 'mixed') return 'text-amber-300';
  return 'text-slate-300';
}

function leanBarClass(d: string | null | undefined): string {
  if (d === 'bullish') return 'bg-emerald-400/70';
  if (d === 'bearish') return 'bg-rose-400/70';
  if (d === 'mixed') return 'bg-amber-400/70';
  return 'bg-slate-400/70';
}

interface Props {
  ticker: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TickerSheet({ ticker, open, onOpenChange }: Props) {
  const [drillSymbol, setDrillSymbol] = useState<string | null>(null);
  const [tavilyResults, setTavilyResults] = useState<TavilyResult[] | null>(null);
  const [tavilyLoading, setTavilyLoading] = useState(false);

  // Regime context — % from prev close + % from today open. Quiet fetch.
  const { data: regime } = useTickerIntradayContext(open ? ticker ?? undefined : undefined);

  // Clear Tavily when ticker changes
  const prevTickerRef = useMemo(() => ({ v: ticker }), [ticker]);
  if (prevTickerRef.v !== ticker && tavilyResults !== null) {
    // stale state — reset when swapping tickers via parent
  }

  // Lean score — our composite bull/bear score per ticker, 0-100.
  // Refreshes every 15min RTH via cron; each ticker also carries a
  // momentum delta vs the prior live score and a confidence chip.
  interface LeanScoreRow {
    score: number;
    lean: string;
    confidence: string;
    n_inputs: number;
    momentum_delta: number | null;
    score_at: string;
    is_closing: boolean;
    breakdown: Record<string, { contribution: number; [k: string]: unknown }>;
  }
  const { data: leanScore } = useQuery<LeanScoreRow | null>({
    queryKey: ['ticker_lean_score', ticker],
    enabled: !!ticker && open,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!ticker) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase.from('ct_ticker_lean_score' as never) as any)
        .select('score,lean,confidence,n_inputs,momentum_delta,score_at,is_closing,breakdown')
        .eq('ticker', ticker)
        .order('score_at', { ascending: false })
        .limit(1);
      const rows = (data ?? []) as LeanScoreRow[];
      return rows[0] ?? null;
    },
  });

  // Breaking news affecting this ticker (Tavily sweep + macro watcher).
  // Separate from the UW news in ct_ticker_snapshots.recent_news — this is
  // fresher (every 10min) and covers geopolitical / policy / sector events
  // that never hit UW's per-ticker feed.
  interface BreakingNewsRow {
    headline: string;
    source: string | null;
    severity: number | null;
    sentiment: string | null;
    summary: string | null;
    macro_wide: boolean | null;
    tickers_affected: string[] | null;
    ingested_at: string;
  }
  const { data: breakingNews } = useQuery<BreakingNewsRow[]>({
    queryKey: ['ct_breaking_news_ticker', ticker],
    enabled: !!ticker && open,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!ticker) return [];
      // 7-day window. Old catalysts often explain today's tape — a
      // Friday headline might be why something's moving Monday. Sheet
      // scrolls naturally when there are many items.
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_breaking_news' as never) as any)
        .select('headline,source,severity,sentiment,summary,macro_wide,tickers_affected,ingested_at')
        .gte('ingested_at', since)
        .order('ingested_at', { ascending: false })
        .limit(200);
      if (error) return [];
      const rows = (data ?? []) as BreakingNewsRow[];
      return rows.filter((r) => (r.tickers_affected ?? []).includes(ticker) || r.macro_wide === true).slice(0, 25);
    },
  });

  // Full quant card — spot, walls, IV, regime, news with Claude's take.
  // This is the payload ct-watcher maintains; already-ingested data.
  const { data: snapshot } = useQuery<TickerSnapshotRow | null>({
    queryKey: ['ticker_snapshot', ticker],
    enabled: !!ticker && open,
    refetchInterval: 60_000,
    queryFn: async () => {
      if (!ticker) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_ticker_snapshots' as never) as any)
        .select('*')
        .eq('ticker', ticker)
        .maybeSingle();
      if (error) return null;
      return data as TickerSnapshotRow | null;
    },
  });

  // Hot contracts — prefer today's flow, fall back to last 24h if empty
  // (pre-market / weekend). James's ask: "we're not seeing any hot contracts,
  // anything that could relate to the news" — solved by widening the window
  // when today hasn't produced flow yet.
  const { data: hotContracts, isLoading: loadingHot } = useQuery<{
    rows: HotContractRow[];
    windowLabel: 'today' | 'last 24h';
  }>({
    queryKey: ['ticker_hot_contracts', ticker],
    enabled: !!ticker && open,
    refetchInterval: 20_000,
    queryFn: async () => {
      if (!ticker) return { rows: [], windowLabel: 'today' as const };
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: todayData } = await (supabase.from('ct_scored_flow' as never) as any)
        .select('option_symbol,strike,expiry,dte,classification,direction,score,premium,volume,open_interest,event_ts')
        .eq('ticker', ticker)
        .gte('event_ts', todayStart.toISOString())
        .order('premium', { ascending: false })
        .limit(80);
      const todayRows = (todayData ?? []) as HotContractRow[];
      if (todayRows.length >= 4) return { rows: todayRows, windowLabel: 'today' as const };

      // Pre-market / quiet — widen to last 24h so we always show something relevant.
      const dayAgo = new Date(Date.now() - 24 * 3600_000);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: recentData } = await (supabase.from('ct_scored_flow' as never) as any)
        .select('option_symbol,strike,expiry,dte,classification,direction,score,premium,volume,open_interest,event_ts')
        .eq('ticker', ticker)
        .gte('event_ts', dayAgo.toISOString())
        .order('premium', { ascending: false })
        .limit(80);
      return { rows: (recentData ?? []) as HotContractRow[], windowLabel: 'last 24h' as const };
    },
  });

  const { data: flags } = useQuery<FlagRow[]>({
    queryKey: ['ticker_flags', ticker],
    enabled: !!ticker && open,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!ticker) return [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_flags' as never) as any)
        .select('id,option_symbol,direction,score,thesis,invalidation,horizon_ts,status,created_at,tags')
        .eq('specialist_ticker', ticker)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as FlagRow[];
    },
  });

  const { data: latestPrice } = useQuery<LatestPriceRow | null>({
    queryKey: ['ticker_spot', ticker],
    enabled: !!ticker && open,
    refetchInterval: 30_000,
    queryFn: async () => {
      if (!ticker) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_price_bars' as never) as any)
        .select('close,volume,ts')
        .eq('ticker', ticker)
        .order('ts', { ascending: false })
        .limit(1);
      if (error) return null;
      const row = (data ?? [])[0] as LatestPriceRow | undefined;
      return row ?? null;
    },
  });

  // Split hot contracts into two lists: by premium, by Vol/OI
  const { byPremium, byVolOi, hotWindow } = useMemo(() => {
    const rows = hotContracts?.rows ?? [];
    if (rows.length === 0) return { byPremium: [] as HotContractRow[], byVolOi: [] as HotContractRow[], hotWindow: 'today' as const };
    const byPremium = [...rows].slice(0, 8);
    const byVolOi = [...rows]
      .map((c) => ({ ...c, vol_oi: c.volume && c.open_interest ? c.volume / c.open_interest : 0 }))
      .filter((c) => c.vol_oi > 0)
      .sort((a, b) => b.vol_oi - a.vol_oi)
      .slice(0, 8);
    return { byPremium, byVolOi, hotWindow: hotContracts?.windowLabel ?? 'today' };
  }, [hotContracts]);

  const flagCount = flags?.length ?? 0;
  const activeFlagCount = flags?.filter((f) => f.status === 'active' || f.status === 'conviction').length ?? 0;
  const latestFlag = flags?.[0] ?? null;

  const {
    reads: specialistReads,
    latest: latestRead,
    isLoading: readsLoading,
    isError: readsError,
  } = useSpecialistReads(ticker ?? undefined, 3);
  const [readsExpanded, setReadsExpanded] = useState(false);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader className="space-y-2">
            <div className="flex items-baseline justify-between">
              <SheetTitle className="text-2xl font-bold tracking-tight flex items-center gap-2 flex-wrap">
                {ticker}
                {latestPrice?.close != null && (
                  <span className="text-lg text-foreground/80 font-mono tabular-nums">
                    ${latestPrice.close.toFixed(2)}
                  </span>
                )}
                {regime && (regime.pct_from_prev_close != null || regime.pct_from_today_open != null) && (
                  <RegimeChip context={regime} variant="both" />
                )}
              </SheetTitle>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">
                  <span className="text-blue-300 font-semibold">{activeFlagCount}</span> active / <span className="text-foreground font-semibold">{flagCount}</span> total flags
                </span>
              </div>
            </div>

            {/* Lean score — our 0-100 composite. */}
            {leanScore && (
              <div className="flex items-center gap-2 pt-1">
                <div className={cn(
                  'flex items-baseline gap-1.5 px-2.5 py-1 rounded border',
                  leanScore.lean === 'bullish' && 'bg-emerald-500/10 border-emerald-500/40',
                  leanScore.lean === 'bearish' && 'bg-red-500/10 border-red-500/40',
                  leanScore.lean === 'neutral' && 'bg-slate-500/10 border-slate-500/40',
                )}>
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Lean</span>
                  <span className={cn(
                    'font-mono tabular-nums font-bold text-xl',
                    leanScore.lean === 'bullish' && 'text-emerald-300',
                    leanScore.lean === 'bearish' && 'text-red-300',
                    leanScore.lean === 'neutral' && 'text-slate-300',
                  )}>
                    {Math.round(leanScore.score)}
                  </span>
                  {leanScore.momentum_delta != null && Math.abs(leanScore.momentum_delta) >= 1 && (
                    <span className={cn(
                      'font-mono tabular-nums text-[10px]',
                      leanScore.momentum_delta > 0 ? 'text-emerald-400' : 'text-red-400',
                    )}>
                      {leanScore.momentum_delta > 0 ? '↑' : '↓'}{Math.abs(leanScore.momentum_delta).toFixed(1)}
                    </span>
                  )}
                </div>
                <span className={cn(
                  'text-[10px] font-mono uppercase px-1.5 py-0.5 rounded border',
                  leanScore.confidence === 'high' && 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
                  leanScore.confidence === 'med' && 'bg-amber-500/10 text-amber-300 border-amber-500/30',
                  leanScore.confidence === 'low' && 'bg-muted/40 text-muted-foreground border-border',
                )} title={`${leanScore.n_inputs} data points across ${Object.keys(leanScore.breakdown).length} components`}>
                  {leanScore.confidence} conf
                </span>
                <span className="text-[10px] text-muted-foreground tabular-nums">
                  {leanScore.n_inputs} inputs
                </span>
                {leanScore.is_closing && (
                  <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                    close
                  </span>
                )}
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {timeAgo(leanScore.score_at)}
                </span>
              </div>
            )}

            {/* Breakdown row — tiny component contributions */}
            {leanScore && (
              <div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground flex-wrap">
                {(['flow', 'specialist', 'news', 'walls', 'oi_momentum', 'iv'] as const).map((k) => {
                  const c = leanScore.breakdown?.[k];
                  if (!c) return null;
                  const v = Number(c.contribution ?? 0);
                  const col = v > 0.5 ? 'text-emerald-400' : v < -0.5 ? 'text-red-400' : 'text-muted-foreground/60';
                  return (
                    <span key={k} className="inline-flex gap-0.5" title={JSON.stringify(c)}>
                      <span className="opacity-60">{k}</span>
                      <span className={cn('tabular-nums', col)}>{v >= 0 ? '+' : ''}{v.toFixed(1)}</span>
                    </span>
                  );
                })}
              </div>
            )}

            <SheetDescription className="text-[11px]">
              Today's hot contracts + what the {ticker} specialist is thinking.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-4">
            {/* Specialist's running commentary — live per-wakeup read */}
            <Card className="p-3 bg-muted/20 border-primary/20">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                <Brain className="w-3.5 h-3.5" />
                <span>{ticker} specialist — latest take</span>
                {latestRead && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="normal-case tracking-normal text-[10px] text-muted-foreground/80">
                      {timeAgo(latestRead.updated_at)}
                    </span>
                    <span className="text-muted-foreground/40">·</span>
                    <span className={cn(
                      'normal-case tracking-normal text-[10px] font-medium',
                      leanTextColor(latestRead.direction_lean),
                    )}>
                      {latestRead.direction_lean} lean
                    </span>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="normal-case tracking-normal text-[10px] text-muted-foreground/80 tabular-nums">
                      conviction {latestRead.conviction}
                    </span>
                  </>
                )}
              </div>

              {readsLoading && !latestRead ? (
                <div className="space-y-1.5">
                  <div className="h-3 rounded bg-muted/40 animate-pulse w-11/12" />
                  <div className="h-3 rounded bg-muted/40 animate-pulse w-10/12" />
                  <div className="h-3 rounded bg-muted/40 animate-pulse w-9/12" />
                </div>
              ) : readsError ? (
                <div className="text-[11px] text-muted-foreground italic">
                  Specialist read unavailable — retrying.
                </div>
              ) : latestRead ? (
                <>
                  <div className="flex items-center gap-2 mb-2">
                    <Badge variant="outline" className={cn('text-[10px] font-mono px-1.5 py-0', leanChipClass(latestRead.direction_lean))}>
                      {latestRead.direction_lean}
                    </Badge>
                    <div className="flex-1 h-1.5 rounded bg-muted/40 overflow-hidden">
                      <div
                        className={cn('h-full transition-all', leanBarClass(latestRead.direction_lean))}
                        style={{ width: `${Math.max(0, Math.min(100, latestRead.conviction))}%` }}
                      />
                    </div>
                    <span className="font-mono tabular-nums text-[11px] text-muted-foreground">
                      {latestRead.conviction}
                    </span>
                    {latestRead.flagged && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-500/15 text-amber-300 border-amber-500/40">
                        🚩 flagged
                      </Badge>
                    )}
                  </div>

                  <div className="text-sm leading-snug text-foreground/90">{latestRead.read_text}</div>

                  {specialistReads.length > 1 && (
                    <div className="mt-2 pt-2 border-t border-border/40">
                      <button
                        type="button"
                        onClick={() => setReadsExpanded((v) => !v)}
                        className="text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {readsExpanded
                          ? 'hide earlier reads'
                          : `show ${specialistReads.length - 1} earlier read${specialistReads.length - 1 === 1 ? '' : 's'}`}
                      </button>
                      {readsExpanded && (
                        <div className="mt-2 space-y-2">
                          {specialistReads.slice(1).map((r: SpecialistRead) => (
                            <div key={r.id} className="pl-2 border-l-2 border-border/40">
                              <div className="flex items-center gap-1.5 mb-0.5 text-[10px] text-muted-foreground">
                                <span className={cn('font-medium', leanTextColor(r.direction_lean))}>
                                  {r.direction_lean}
                                </span>
                                <span className="text-muted-foreground/40">·</span>
                                <span className="tabular-nums">conv {r.conviction}</span>
                                <span className="text-muted-foreground/40">·</span>
                                <span>{timeAgo(r.updated_at)}</span>
                                {r.flagged && <span className="text-amber-400">🚩</span>}
                              </div>
                              <div className="text-[12px] leading-snug text-foreground/75">{r.read_text}</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-xs text-muted-foreground italic">
                  Specialist hasn't woken yet today — next wakeup on score ≥70 flow event or scheduled RTH cadence.
                </div>
              )}
            </Card>

            {/* Price chart — intraday / 5D / 30D context for news + flow */}
            {ticker && <PriceChart ticker={ticker} open={open} />}

            {/* Micro snapshot — spot, walls, IV, regime, P/C, earnings */}
            {snapshot && (
              <div>
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                  <Gauge className="w-3.5 h-3.5" />
                  Micro snapshot
                  {snapshot.snapshot_at && (
                    <span className="text-[10px] text-muted-foreground/60 normal-case ml-auto">
                      {timeAgo(snapshot.snapshot_at)}
                    </span>
                  )}
                </div>
                <Card className="p-3 grid grid-cols-2 md:grid-cols-4 gap-x-3 gap-y-2 text-xs">
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Spot</div>
                    <div className="font-mono tabular-nums font-semibold">
                      {snapshot.spot != null ? `$${snapshot.spot.toFixed(2)}` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Regime</div>
                    <div className={cn(
                      'font-mono text-[11px]',
                      snapshot.regime === 'positive_gamma' ? 'text-emerald-300' : snapshot.regime === 'negative_gamma' ? 'text-red-300' : 'text-muted-foreground',
                    )}>
                      {snapshot.regime?.replace('_', ' ') ?? '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">IV rank</div>
                    <div className="font-mono tabular-nums">
                      {snapshot.iv_rank != null ? snapshot.iv_rank.toFixed(1) : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">P/C</div>
                    <div className="font-mono tabular-nums">
                      {snapshot.put_call_ratio != null ? snapshot.put_call_ratio.toFixed(2) : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider inline-flex items-center gap-1">
                      <Target className="w-2.5 h-2.5" /> Call wall
                    </div>
                    <div className="font-mono tabular-nums text-emerald-300">
                      {snapshot.call_wall != null ? `$${snapshot.call_wall}` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider inline-flex items-center gap-1">
                      <Target className="w-2.5 h-2.5" /> Put wall
                    </div>
                    <div className="font-mono tabular-nums text-red-300">
                      {snapshot.put_wall != null ? `$${snapshot.put_wall}` : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Gamma flip</div>
                    <div className="font-mono tabular-nums text-amber-300">
                      {(() => {
                        const g = snapshot.gamma_flip;
                        const s = snapshot.spot;
                        // Hide gamma flip when it's clearly unreliable
                        // (>20% from spot). Cumulative-zero-crossing method
                        // misfires when net_gex is one-signed across all
                        // strikes. Real flip is always near spot; outliers
                        // are noise.
                        if (g == null) return '—';
                        if (s != null && s > 0 && Math.abs(g - s) / s > 0.20) return '—';
                        return `$${g}`;
                      })()}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Max pain</div>
                    <div className="font-mono tabular-nums">
                      {snapshot.max_pain != null ? `$${snapshot.max_pain}` : '—'}
                    </div>
                  </div>
                  {snapshot.next_earnings_date && (
                    <div className="col-span-2 md:col-span-4 pt-2 border-t border-border/40">
                      <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Earnings</div>
                      <div className="font-mono text-amber-300">
                        {snapshot.next_earnings_date}
                        {snapshot.earnings_expected_move != null && (
                          <span className="ml-2 text-muted-foreground">
                            implied move ±{(snapshot.earnings_expected_move * 100).toFixed(1)}%
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </Card>
              </div>
            )}

            {/* OI Shifts (overnight) — per-ticker view of ct_top_oi_shifts */}
            {ticker && (
              <TickerOiShifts ticker={ticker} onContractClick={setDrillSymbol} />
            )}

            {/* Hot by premium — window widens to last 24h if today is quiet */}
            <div>
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                <Flame className="w-3.5 h-3.5" />
                Hot by premium · {hotWindow}
              </div>
              {loadingHot ? (
                <div className="text-xs text-muted-foreground py-2">Loading…</div>
              ) : byPremium.length === 0 ? (
                <div className="text-xs text-muted-foreground py-2">No scored flow for {ticker} in the last 24h. Try /tape with "Show unscored".</div>
              ) : (
                <div className="space-y-1">
                  {byPremium.map((c) => {
                    const volOi = c.volume && c.open_interest ? c.volume / c.open_interest : null;
                    return (
                      <button
                        key={c.option_symbol + c.event_ts}
                        onClick={() => setDrillSymbol(c.option_symbol)}
                        className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/40 transition-colors text-xs"
                      >
                        <Badge variant="outline" className={cn('text-[10px] font-mono px-1.5 py-0 font-bold', sideColor(c.side ?? parseOccSide(c.option_symbol)))}>
                          {(c.side ?? parseOccSide(c.option_symbol)) === 'call' ? 'CALL' : (c.side ?? parseOccSide(c.option_symbol)) === 'put' ? 'PUT' : '?'}
                        </Badge>
                        {c.direction && (
                          <Badge variant="outline" className={cn('text-[9px] font-mono px-1 py-0 gap-0.5', directionPill(c.direction))}>
                            {c.direction === 'bullish' ? <ArrowUp className="w-2.5 h-2.5" /> : c.direction === 'bearish' ? <ArrowDown className="w-2.5 h-2.5" /> : <Minus className="w-2.5 h-2.5" />}
                          </Badge>
                        )}
                        <span className="font-mono tabular-nums font-semibold w-16 text-right">{c.strike != null ? `$${c.strike}` : '-'}</span>
                        <span className="font-mono tabular-nums text-muted-foreground w-14">
                          {c.expiry ? c.expiry.slice(5).replace('-', '/') : '-'}
                        </span>
                        <span className="font-mono tabular-nums text-muted-foreground w-10 text-right">
                          {c.dte ?? '-'}d
                        </span>
                        <span className="flex-1" />
                        {volOi != null && volOi >= 1 && (
                          <span className={cn('font-mono tabular-nums text-[10px]', volOi >= 5 ? 'text-emerald-400 font-semibold' : volOi >= 2 ? 'text-emerald-300' : 'text-amber-300')}>
                            {volOi.toFixed(1)}x
                          </span>
                        )}
                        <span className="font-mono tabular-nums font-semibold w-16 text-right">
                          {formatPremium(c.premium)}
                        </span>
                        {c.score != null && (
                          <span className={cn(
                            'font-mono tabular-nums text-[10px] w-8 text-right',
                            c.score >= 80 ? 'text-emerald-400 font-bold' : c.score >= 60 ? 'text-amber-400' : 'text-muted-foreground',
                          )}>
                            {Math.round(c.score)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Hot by Vol/OI */}
            {byVolOi.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                  <TrendingUp className="w-3.5 h-3.5" />
                  Hot by Vol/OI · {hotWindow}
                </div>
                <div className="space-y-1">
                  {byVolOi.map((c) => {
                    const volOi = c.volume && c.open_interest ? c.volume / c.open_interest : 0;
                    return (
                      <button
                        key={'voi-' + c.option_symbol + c.event_ts}
                        onClick={() => setDrillSymbol(c.option_symbol)}
                        className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/40 transition-colors text-xs"
                      >
                        <Badge variant="outline" className={cn('text-[10px] font-mono px-1.5 py-0 font-bold', sideColor(c.side ?? parseOccSide(c.option_symbol)))}>
                          {(c.side ?? parseOccSide(c.option_symbol)) === 'call' ? 'CALL' : (c.side ?? parseOccSide(c.option_symbol)) === 'put' ? 'PUT' : '?'}
                        </Badge>
                        {c.direction && (
                          <Badge variant="outline" className={cn('text-[9px] font-mono px-1 py-0 gap-0.5', directionPill(c.direction))}>
                            {c.direction === 'bullish' ? <ArrowUp className="w-2.5 h-2.5" /> : c.direction === 'bearish' ? <ArrowDown className="w-2.5 h-2.5" /> : <Minus className="w-2.5 h-2.5" />}
                          </Badge>
                        )}
                        <span className="font-mono tabular-nums font-semibold w-16 text-right">{c.strike != null ? `$${c.strike}` : '-'}</span>
                        <span className="font-mono tabular-nums text-muted-foreground w-14">
                          {c.expiry ? c.expiry.slice(5).replace('-', '/') : '-'}
                        </span>
                        <span className="flex-1" />
                        <span className={cn('font-mono tabular-nums font-bold text-sm', volOi >= 5 ? 'text-emerald-400' : volOi >= 2 ? 'text-emerald-300' : 'text-amber-300')}>
                          {volOi.toFixed(1)}x
                        </span>
                        <span className="font-mono tabular-nums text-muted-foreground text-[10px] w-20 text-right">
                          {c.volume?.toLocaleString()} / {c.open_interest?.toLocaleString()}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tavily live search */}
            <div>
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                <Globe className="w-3.5 h-3.5" />
                Live web search
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 text-[10px] px-2"
                  disabled={tavilyLoading || !ticker}
                  onClick={async () => {
                    if (!ticker) return;
                    setTavilyLoading(true);
                    setTavilyResults(null);
                    try {
                      const { data, error } = await supabase.functions.invoke('jac-web-search', {
                        body: { query: `${ticker} stock news today`, max_results: 5 },
                      });
                      if (error) throw error;
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const results = ((data as any)?.results ?? (data as any)?.search_results ?? []) as TavilyResult[];
                      setTavilyResults(results);
                      if (results.length === 0) toast.info('No fresh results');
                    } catch (e) {
                      toast.error(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
                      setTavilyResults([]);
                    } finally {
                      setTavilyLoading(false);
                    }
                  }}
                >
                  {tavilyLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Search the web'}
                </Button>
              </div>
              {tavilyResults && tavilyResults.length > 0 && (
                <div className="space-y-1.5">
                  {tavilyResults.map((r, i) => (
                    <a
                      key={i}
                      href={r.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block p-2.5 rounded border border-border hover:border-primary/40 transition-colors"
                    >
                      <div className="text-xs font-semibold text-foreground/90 mb-1 line-clamp-1">{r.title}</div>
                      <div className="text-[11px] text-muted-foreground leading-snug line-clamp-2">{r.content}</div>
                      <div className="text-[10px] text-primary/70 mt-1 truncate">{r.url}</div>
                    </a>
                  ))}
                </div>
              )}
              {tavilyResults !== null && tavilyResults.length === 0 && !tavilyLoading && (
                <div className="text-[11px] text-muted-foreground italic">No results — try clicking search again.</div>
              )}
            </div>

            {/* Recent news with Claude's take */}
            {snapshot?.recent_news && snapshot.recent_news.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                  <Newspaper className="w-3.5 h-3.5" />
                  Recent news · Claude's take
                </div>
                <div className="space-y-2">
                  {snapshot.recent_news.slice(0, 6).map((n, i) => (
                    <Card key={i} className={cn(
                      'p-2.5',
                      n.impact === 'bullish' && 'border-emerald-500/25',
                      n.impact === 'bearish' && 'border-red-500/25',
                    )}>
                      <div className="flex items-baseline gap-2 mb-1">
                        <Badge variant="outline" className={cn(
                          'text-[9px] font-mono px-1 py-0 uppercase',
                          n.impact === 'bullish' && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                          n.impact === 'bearish' && 'bg-red-500/15 text-red-300 border-red-500/40',
                          (!n.impact || n.impact === 'neutral') && 'bg-slate-500/15 text-slate-300 border-slate-500/40',
                        )}>
                          {n.impact ?? 'neutral'}
                        </Badge>
                        {n.source && <span className="text-[10px] text-muted-foreground">{n.source}</span>}
                        {n.significance != null && (
                          <span className="text-[10px] text-muted-foreground">· sig {n.significance}</span>
                        )}
                        <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(n.created_at)}</span>
                      </div>
                      <div className="text-xs font-semibold text-foreground/90 leading-snug mb-1">{n.headline}</div>
                      {n.claude_take && (
                        <div className="text-[11px] text-muted-foreground leading-snug">{n.claude_take}</div>
                      )}
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Breaking news (Tavily sweep + macro watcher) — last 7d */}
            {breakingNews && breakingNews.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2 flex-wrap">
                  <Globe className="w-3.5 h-3.5" />
                  Breaking news · last 7d
                  {(() => {
                    // Rolling severity-weighted sentiment chip.
                    // Bullish=+1, Bearish=-1, weight by severity (1-5).
                    let bullScore = 0, bearScore = 0, counted = 0;
                    for (const n of breakingNews) {
                      const sev = n.severity ?? 1;
                      if (n.sentiment === 'bullish') { bullScore += sev; counted++; }
                      else if (n.sentiment === 'bearish') { bearScore += sev; counted++; }
                    }
                    if (counted < 2 || (bullScore + bearScore) === 0) return null;
                    const bullPct = Math.round((bullScore / (bullScore + bearScore)) * 100);
                    const skew = bullPct >= 65 ? 'bullish' : bullPct <= 35 ? 'bearish' : 'mixed';
                    return (
                      <span className={cn(
                        'ml-auto normal-case text-[10px] font-mono px-1.5 py-0.5 rounded border',
                        skew === 'bullish' && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                        skew === 'bearish' && 'bg-red-500/15 text-red-300 border-red-500/40',
                        skew === 'mixed' && 'bg-slate-500/15 text-slate-300 border-slate-500/40',
                      )}
                      title={`Severity-weighted: bullish=${bullScore}, bearish=${bearScore}, counted=${counted} of ${breakingNews.length}`}
                      >
                        sentiment {bullPct}% bull · {counted}
                      </span>
                    );
                  })()}
                </div>
                <div className="space-y-1.5">
                  {breakingNews.map((n, i) => (
                    <Card key={`bn-${i}`} className={cn(
                      'p-2.5',
                      n.sentiment === 'bullish' && 'border-emerald-500/25',
                      n.sentiment === 'bearish' && 'border-red-500/25',
                      (n.severity ?? 0) >= 4 && 'ring-1 ring-amber-500/40',
                    )}>
                      <div className="flex items-baseline gap-2 mb-1">
                        <Badge variant="outline" className={cn(
                          'text-[9px] font-mono px-1 py-0 uppercase',
                          n.sentiment === 'bullish' && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                          n.sentiment === 'bearish' && 'bg-red-500/15 text-red-300 border-red-500/40',
                          (!n.sentiment || n.sentiment === 'neutral' || n.sentiment === 'ambiguous') && 'bg-slate-500/15 text-slate-300 border-slate-500/40',
                        )}>
                          {n.sentiment ?? 'neutral'}
                        </Badge>
                        {n.severity != null && (
                          <span className={cn('text-[10px] font-mono tabular-nums', n.severity >= 4 ? 'text-amber-300 font-bold' : 'text-muted-foreground')}>
                            sev {n.severity}
                          </span>
                        )}
                        {n.source && <span className="text-[10px] text-muted-foreground">{n.source}</span>}
                        {n.macro_wide && <span className="text-[10px] font-mono text-muted-foreground">macro</span>}
                        <span className="text-[10px] text-muted-foreground ml-auto">{timeAgo(n.ingested_at)}</span>
                      </div>
                      <div className="text-xs font-semibold text-foreground/90 leading-snug mb-1">{n.headline}</div>
                      {n.summary && (
                        <div className="text-[11px] text-muted-foreground leading-snug">{n.summary}</div>
                      )}
                    </Card>
                  ))}
                </div>
              </div>
            )}

            {/* Flag history (condensed) */}
            {flags && flags.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                  <Activity className="w-3.5 h-3.5" />
                  Flag history
                </div>
                <div className="space-y-1">
                  {flags.slice(0, 8).map((f) => (
                    <div key={f.id} className="text-xs flex items-baseline gap-2 py-1">
                      <Badge variant="outline" className={cn('text-[9px] font-mono px-1 py-0 shrink-0', directionColor(f.direction))}>
                        {f.direction}
                      </Badge>
                      <span className="font-mono tabular-nums font-semibold w-8 text-right shrink-0">{Math.round(f.score)}</span>
                      <span className="text-muted-foreground truncate flex-1">{f.thesis}</span>
                      <span className="text-[10px] text-muted-foreground/70 tabular-nums shrink-0">{timeAgo(f.created_at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Drill-down to contract when user clicks a hot row. No onTickerClick
          here — we're already inside the ticker briefing sheet, so the
          "{ticker} dashboard →" button would be a no-op cycle. */}
      <ContractDrillSheet
        optionSymbol={drillSymbol}
        open={drillSymbol !== null}
        onOpenChange={(o) => { if (!o) setDrillSymbol(null); }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// PriceChart — intraday / 5D / 30D price context next to news + flow.
//
// ct_price_bars as of 2026-04-23 only contains 1m bars (~9 days back). The
// 30D window falls back to downsampled 1m data until a daily backfill lands.
// ---------------------------------------------------------------------------

type PriceWindow = '1D' | '5D' | '30D';

interface PriceBar {
  ts: string;
  close: number | string | null;
}

interface ChartPoint {
  t: number;   // epoch ms, for sorting / x-axis
  label: string;
  close: number;
}

/** Today 00:00 ET as ISO. Matches how the hot-contracts query frames "today". */
function todayEtStartIso(): string {
  const now = new Date();
  // Local midnight — matches the rest of the sheet's "today" semantics.
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return start.toISOString();
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function formatLabel(iso: string, window: PriceWindow): string {
  const d = new Date(iso);
  if (window === '1D') {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  // 5D / 30D — MMM dd
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** Downsample by skipping every Nth row so we never ship >500 points to Recharts. */
function downsample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) return rows;
  const step = Math.ceil(rows.length / max);
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
  // Always keep the last point so the line ends on the latest value.
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

interface PriceChartProps {
  ticker: string;
  open: boolean;
}

function PriceChart({ ticker, open }: PriceChartProps) {
  const [window, setWindow] = useState<PriceWindow>('1D');

  const { data: bars, isLoading } = useQuery<PriceBar[]>({
    queryKey: ['ticker_price_chart', ticker, window],
    enabled: !!ticker && open,
    refetchInterval: 30_000,
    queryFn: async () => {
      const sinceIso = window === '1D'
        ? todayEtStartIso()
        : window === '5D'
          ? daysAgoIso(5)
          : daysAgoIso(30);

      // 30D prefers daily bars if they exist. Falls back to any timeframe.
      if (window === '30D') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: daily } = await (supabase.from('ct_price_bars' as never) as any)
          .select('ts,close')
          .eq('ticker', ticker)
          .eq('timeframe', '1d')
          .gte('ts', sinceIso)
          .order('ts', { ascending: true })
          .limit(2000);
        const dailyRows = (daily ?? []) as PriceBar[];
        if (dailyRows.length > 0) return dailyRows;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_price_bars' as never) as any)
        .select('ts,close')
        .eq('ticker', ticker)
        .gte('ts', sinceIso)
        .order('ts', { ascending: true })
        .limit(2000);
      if (error) return [];
      const primary = (data ?? []) as PriceBar[];

      // 1D fallback: if today has no bars (pre-market / weekend / holiday),
      // fall back to the last trading session's intraday data so the chart
      // isn't empty. Walk back one day at a time up to 7 days.
      if (window === '1D' && primary.length === 0) {
        for (let daysBack = 1; daysBack <= 7; daysBack++) {
          const since = new Date(Date.now() - daysBack * 86_400_000);
          since.setUTCHours(0, 0, 0, 0);
          const until = new Date(since.getTime() + 86_400_000);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data: prior } = await (supabase.from('ct_price_bars' as never) as any)
            .select('ts,close')
            .eq('ticker', ticker)
            .gte('ts', since.toISOString())
            .lt('ts', until.toISOString())
            .order('ts', { ascending: true })
            .limit(2000);
          const rows = (prior ?? []) as PriceBar[];
          if (rows.length > 0) return rows;
        }
      }

      return primary;
    },
  });

  const points: ChartPoint[] = useMemo(() => {
    const raw = (bars ?? [])
      .map((b) => {
        const c = typeof b.close === 'string' ? parseFloat(b.close) : b.close;
        if (c == null || !Number.isFinite(c)) return null;
        return { t: Date.parse(b.ts), label: formatLabel(b.ts, window), close: c } as ChartPoint;
      })
      .filter((p): p is ChartPoint => p !== null);
    return window === '1D' ? raw : downsample(raw, 500);
  }, [bars, window]);

  const first = points[0]?.close ?? null;
  const last = points[points.length - 1]?.close ?? null;
  const pct = first != null && last != null && first !== 0 ? ((last - first) / first) * 100 : null;
  const trend: 'up' | 'down' | 'flat' = pct == null ? 'flat' : pct > 0.01 ? 'up' : pct < -0.01 ? 'down' : 'flat';
  const color = trend === 'up' ? '#10b981' : trend === 'down' ? '#ef4444' : '#64748b';
  const pctClass = trend === 'up' ? 'text-emerald-400' : trend === 'down' ? 'text-red-400' : 'text-muted-foreground';
  const gradId = `tkr-price-grad-${ticker}-${window}`;

  // If 1D data is from a prior session (market closed), surface the date.
  const sessionLabel = useMemo(() => {
    if (window !== '1D' || points.length === 0) return null;
    const firstTs = new Date(points[0].t);
    const today = new Date();
    const sameDay = firstTs.getUTCFullYear() === today.getUTCFullYear()
      && firstTs.getUTCMonth() === today.getUTCMonth()
      && firstTs.getUTCDate() === today.getUTCDate();
    if (sameDay) return 'intraday';
    return `last session · ${firstTs.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' })}`;
  }, [points, window]);

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
        <LineChart className="w-3.5 h-3.5" />
        Price context
        <div className="ml-auto flex items-center gap-1">
          {(['1D', '5D', '30D'] as const).map((w) => (
            <button
              key={w}
              type="button"
              onClick={() => setWindow(w)}
              className={cn(
                'px-1.5 py-0.5 rounded border text-[10px] font-mono tracking-wider transition-colors',
                window === w
                  ? 'bg-primary/20 text-foreground border-primary/50'
                  : 'bg-muted/20 text-muted-foreground border-border hover:border-primary/30',
              )}
            >
              {w}
            </button>
          ))}
        </div>
      </div>
      <Card className="p-3">
        <div className="flex items-baseline gap-2 mb-2 text-xs">
          <span className="font-mono tabular-nums font-bold text-sm text-foreground">{ticker}</span>
          <span className="font-mono tabular-nums text-foreground/90">
            {last != null ? `$${last.toFixed(2)}` : '—'}
          </span>
          {pct != null && (
            <span className={cn('font-mono tabular-nums text-[11px]', pctClass)}>
              {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
            </span>
          )}
          <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
            {window === '1D' ? (sessionLabel ?? 'intraday') : window === '5D' ? 'last 5 days' : 'last 30 days'}
          </span>
        </div>
        <div className="h-[180px]">
          {isLoading ? (
            <div className="h-full flex items-center justify-center text-[11px] text-muted-foreground">Loading…</div>
          ) : points.length === 0 ? (
            <div className="h-full flex items-center justify-center text-[11px] text-muted-foreground italic">
              No price data for {window}
            </div>
          ) : (
            <ChartSafe label={`price-${ticker}-${window}`}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={points} margin={{ top: 6, right: 6, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <XAxis
                    dataKey="label"
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                    tickLine={false}
                    axisLine={{ stroke: 'hsl(var(--border))' }}
                    interval="preserveStartEnd"
                    minTickGap={40}
                  />
                  <YAxis
                    domain={['auto', 'auto']}
                    tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                    tickLine={false}
                    axisLine={{ stroke: 'hsl(var(--border))' }}
                    width={48}
                    tickFormatter={(v: number) => `$${v.toFixed(v >= 100 ? 0 : 2)}`}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: 6,
                      fontSize: 11,
                      fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                    }}
                    labelStyle={{ color: 'hsl(var(--muted-foreground))' }}
                    formatter={(val: number) => [`$${val.toFixed(2)}`, 'price']}
                  />
                  <Area
                    type="monotone"
                    dataKey="close"
                    stroke={color}
                    strokeWidth={1.5}
                    fill={`url(#${gradId})`}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartSafe>
          )}
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TickerOiShifts — compact table of ct_top_oi_shifts filtered to this ticker.
// ---------------------------------------------------------------------------

interface TickerOiShiftsProps {
  ticker: string;
  onContractClick: (optionSymbol: string) => void;
}

function TickerOiShifts({ ticker, onContractClick }: TickerOiShiftsProps) {
  const { data, isLoading } = useOvernightPositioning(ticker, 10);
  const rows = data ?? [];

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
        <TrendingUp className="w-3.5 h-3.5" />
        OI Shifts · overnight
      </div>
      {isLoading && rows.length === 0 ? (
        <div className="text-[11px] text-muted-foreground py-1">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-[11px] text-muted-foreground italic py-1">
          No significant OI shifts for {ticker} overnight.
        </div>
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground border-b border-border">
                <th className="text-left font-normal px-2 py-1.5">Strike</th>
                <th className="text-left font-normal px-2 py-1.5">Side</th>
                <th className="text-right font-normal px-2 py-1.5">Δ ctr</th>
                <th className="text-right font-normal px-2 py-1.5">$ risk</th>
                <th className="text-right font-normal px-2 py-1.5">Dist</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const side = normalizeSide(r.side);
                const { label: moneyLabel } = formatMoneyness(r.distance_from_spot_pct, side);
                const delta = r.delta_contracts;
                const isAccum = delta != null && delta > 0;
                return (
                  <tr
                    key={r.option_symbol + (r.snap_date ?? '') + (r.snap_slot ?? '')}
                    onClick={() => onContractClick(r.option_symbol)}
                    className="cursor-pointer border-b border-border/40 hover:bg-muted/40"
                  >
                    <td className="px-2 py-1.5 font-mono tabular-nums font-semibold">
                      {r.strike != null ? `$${Math.round(r.strike)}` : '-'}
                    </td>
                    <td className="px-2 py-1.5">
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[9px] font-mono px-1 py-0 font-bold',
                          side === 'call' && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                          side === 'put' && 'bg-rose-500/15 text-rose-300 border-rose-500/40',
                          !side && 'bg-slate-500/15 text-slate-300 border-slate-500/40',
                        )}
                      >
                        {side === 'call' ? 'CALL' : side === 'put' ? 'PUT' : '?'}
                      </Badge>
                    </td>
                    <td className={cn(
                      'px-2 py-1.5 font-mono tabular-nums text-right font-bold',
                      isAccum ? 'text-emerald-400' : 'text-rose-400',
                    )}>
                      <span className="inline-flex items-center justify-end gap-0.5">
                        {isAccum
                          ? <TrendingUp className="w-3 h-3" />
                          : <TrendingDown className="w-3 h-3" />}
                        {formatDeltaContracts(delta)}
                      </span>
                    </td>
                    <td className="px-2 py-1.5 font-mono tabular-nums text-right text-foreground/90">
                      {formatDollarsCompact(r.dollars_at_risk)}
                    </td>
                    <td className="px-2 py-1.5 font-mono tabular-nums text-right text-muted-foreground">
                      {moneyLabel}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
