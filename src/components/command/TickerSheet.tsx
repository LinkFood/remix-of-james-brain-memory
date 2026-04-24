/**
 * TickerSheet — per-ticker briefing opened from Tape.
 *
 * Answers: "what's happening on this ticker right now?" Three panes:
 *   1. Hot contracts today (top 8 by premium AND by Vol/OI)
 *   2. Latest specialist flags for this ticker (from ct_flags)
 *   3. Specialist's latest take — pulled from ct_specialist_memory if present,
 *      else ct_flags thesis of the most recent flag
 *
 * Click hot contract → opens ContractSheet for that option_symbol.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Flame, Activity, Brain, TrendingUp, ArrowUp, ArrowDown, Minus, Newspaper, Globe, Loader2, Target, Gauge } from 'lucide-react';
import { toast } from 'sonner';
import { ContractSheet } from './ContractSheet';

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

interface Props {
  ticker: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function TickerSheet({ ticker, open, onOpenChange }: Props) {
  const [drillSymbol, setDrillSymbol] = useState<string | null>(null);
  const [tavilyResults, setTavilyResults] = useState<TavilyResult[] | null>(null);
  const [tavilyLoading, setTavilyLoading] = useState(false);

  // Clear Tavily when ticker changes
  const prevTickerRef = useMemo(() => ({ v: ticker }), [ticker]);
  if (prevTickerRef.v !== ticker && tavilyResults !== null) {
    // stale state — reset when swapping tickers via parent
  }

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

  const { data: hotContracts, isLoading: loadingHot } = useQuery<HotContractRow[]>({
    queryKey: ['ticker_hot_contracts', ticker],
    enabled: !!ticker && open,
    refetchInterval: 20_000,
    queryFn: async () => {
      if (!ticker) return [];
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_scored_flow' as never) as any)
        .select('option_symbol,strike,expiry,dte,classification,direction,score,premium,volume,open_interest,event_ts')
        .eq('ticker', ticker)
        .gte('event_ts', todayStart.toISOString())
        .order('premium', { ascending: false })
        .limit(80);
      if (error) throw error;
      return (data ?? []) as HotContractRow[];
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
  const { byPremium, byVolOi } = useMemo(() => {
    if (!hotContracts) return { byPremium: [] as HotContractRow[], byVolOi: [] as HotContractRow[] };
    const byPremium = [...hotContracts].slice(0, 8);
    const byVolOi = [...hotContracts]
      .map((c) => ({ ...c, vol_oi: c.volume && c.open_interest ? c.volume / c.open_interest : 0 }))
      .filter((c) => c.vol_oi > 0)
      .sort((a, b) => b.vol_oi - a.vol_oi)
      .slice(0, 8);
    return { byPremium, byVolOi };
  }, [hotContracts]);

  const flagCount = flags?.length ?? 0;
  const activeFlagCount = flags?.filter((f) => f.status === 'active' || f.status === 'conviction').length ?? 0;
  const latestFlag = flags?.[0] ?? null;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader className="space-y-2">
            <div className="flex items-baseline justify-between">
              <SheetTitle className="text-2xl font-bold tracking-tight flex items-center gap-2">
                {ticker}
                {latestPrice?.close != null && (
                  <span className="text-lg text-foreground/80 font-mono tabular-nums">
                    ${latestPrice.close.toFixed(2)}
                  </span>
                )}
              </SheetTitle>
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">
                  <span className="text-blue-300 font-semibold">{activeFlagCount}</span> active / <span className="text-foreground font-semibold">{flagCount}</span> total flags
                </span>
              </div>
            </div>
            <SheetDescription className="text-[11px]">
              Today's hot contracts + what the {ticker} specialist is thinking.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-4">
            {/* Specialist's latest take */}
            <Card className="p-3 bg-muted/20 border-primary/20">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                <Brain className="w-3.5 h-3.5" />
                {ticker} specialist — latest take
              </div>
              {latestFlag ? (
                <>
                  <div className="flex items-baseline gap-2 mb-1">
                    <Badge variant="outline" className={cn('text-[10px] font-mono px-1.5 py-0', directionColor(latestFlag.direction))}>
                      {latestFlag.direction}
                    </Badge>
                    <span className="font-mono tabular-nums text-sm font-bold">{Math.round(latestFlag.score)}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {timeAgo(latestFlag.created_at)}
                    </span>
                  </div>
                  <div className="text-sm leading-snug text-foreground/90 mb-2">{latestFlag.thesis}</div>
                  {latestFlag.invalidation && (
                    <div className="text-[11px] text-muted-foreground leading-snug">
                      <span className="uppercase tracking-wider mr-1">invalidates:</span>
                      {latestFlag.invalidation}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-xs text-muted-foreground italic">
                  No flags from {ticker} specialist yet today. Specialist wakes on score ≥70 flow events + scheduled RTH cadence.
                </div>
              )}
            </Card>

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

            {/* Hot by premium */}
            <div>
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                <Flame className="w-3.5 h-3.5" />
                Hot by premium today
              </div>
              {loadingHot ? (
                <div className="text-xs text-muted-foreground py-2">Loading…</div>
              ) : byPremium.length === 0 ? (
                <div className="text-xs text-muted-foreground py-2">No scored flow today. Check /tape for raw alerts.</div>
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
                  Hot by Vol/OI today
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

      {/* Drill-down to contract when user clicks a hot row */}
      <ContractSheet
        optionSymbol={drillSymbol}
        open={drillSymbol !== null}
        onOpenChange={(o) => { if (!o) setDrillSymbol(null); }}
      />
    </>
  );
}
