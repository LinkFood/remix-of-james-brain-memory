/**
 * MacroBanner — /tape Pillar 1 enrichment.
 *
 * Two stacked sections rendered above the filter strip:
 *   1. Macro strip — SPY/QQQ/IWM/VIX spot + % change, plus market tide pill
 *      when ct_market_tide is available. VIX and tide hide gracefully if
 *      source data isn't present (ct_market_tide doesn't exist yet as of
 *      2026-04-23; guarded with try/catch in query).
 *   2. Watchlist tiles — 10 tiles, one per specialist ticker, each with a
 *      NOPE sparkline (today only, 09:30 ET onwards) pulled from
 *      ct_nope_minute. Line + 10% fill colored by sign of the latest value.
 *
 * All network reads batched via .in('ticker', TICKERS) — two queries total
 * for the tile grid (price bars + NOPE), one for the macro strip overlap.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Area, AreaChart, ReferenceLine, ResponsiveContainer } from 'recharts';
import { ChartSafe } from '@/components/ChartSafe';
import { useAllTickersIntradayContext, RegimeChip } from '@/hooks/useTickerIntradayContext';

const TICKERS = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'] as const;
const MACRO_TICKERS = ['SPY','QQQ','IWM','VIX'] as const;

interface PriceBarRow {
  ticker: string;
  ts: string;
  close: number | string;
}

interface NopeRow {
  ticker: string;
  tick_timestamp: string;
  nope: number | string;
}

interface MarketTideRow {
  recorded_at?: string;
  net_call_premium?: number | string | null;
  net_put_premium?: number | string | null;
}

interface PriceSummary {
  spot: number | null;
  pct: number | null;  // today's % change (close vs first close today)
}

/**
 * 48h lookback. We can't use just "today" because pre-market + early hours
 * before the first bar lands would leave the banner empty. 48h guarantees
 * we always get at least yesterday's close.
 */
function lookbackIso(hours = 48): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

function toNum(n: number | string | null | undefined): number | null {
  if (n == null) return null;
  const v = typeof n === 'number' ? n : parseFloat(n);
  return Number.isFinite(v) ? v : null;
}

function fmtSpot(n: number | null): string {
  if (n == null) return '--';
  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(2);
  return n.toFixed(2);
}

function fmtPct(n: number | null): string {
  if (n == null) return '--';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(2)}%`;
}

function pctColor(n: number | null): string {
  if (n == null) return 'text-muted-foreground';
  if (n > 0) return 'text-emerald-400';
  if (n < 0) return 'text-red-400';
  return 'text-muted-foreground';
}

/**
 * Compute spot + % change per ticker from a 48h price_bars window.
 * Spot = latest bar. Baseline for % = first bar of the most-recent trading
 * day (UTC date of the latest bar). Pre-market the latest bar is yesterday's
 * close and the "first of that day" becomes the 09:30 bar → daily % holds.
 */
function summarize(rows: PriceBarRow[]): Map<string, PriceSummary> {
  const byTicker = new Map<string, PriceBarRow[]>();
  for (const r of rows) {
    const arr = byTicker.get(r.ticker) ?? [];
    arr.push(r);
    byTicker.set(r.ticker, arr);
  }
  const out = new Map<string, PriceSummary>();
  for (const [t, arr] of byTicker.entries()) {
    arr.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const latestRow = arr[arr.length - 1];
    const last = toNum(latestRow?.close);
    // Pick the most-recent trading day based on the latest bar's UTC date
    // and take its first bar as the "open" for % change.
    const latestDay = latestRow?.ts?.slice(0, 10) ?? '';
    const sameDayRows = latestDay ? arr.filter((r) => r.ts.slice(0, 10) === latestDay) : [latestRow];
    const first = toNum(sameDayRows[0]?.close);
    const pct = first != null && last != null && first !== 0 ? ((last - first) / first) * 100 : null;
    out.set(t, { spot: last, pct });
  }
  return out;
}

export interface MacroBannerProps {
  onTickerClick: (ticker: string) => void;
}

export function MacroBanner({ onTickerClick }: MacroBannerProps) {
  const sinceIso = lookbackIso(48);

  // 48h price bars — covers pre-market when "today" has zero bars yet.
  const { data: priceBars } = useQuery<PriceBarRow[]>({
    queryKey: ['ct_macro_price_bars', sinceIso.slice(0, 10)],
    refetchInterval: 30_000,
    queryFn: async () => {
      const allTickers = Array.from(new Set<string>([...TICKERS, ...MACRO_TICKERS]));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_price_bars' as never) as any)
        .select('ticker,ts,close')
        .in('ticker', allTickers)
        .gte('ts', sinceIso)
        .order('ts', { ascending: true });
      if (error) throw error;
      return (data ?? []) as PriceBarRow[];
    },
  });

  // 48h NOPE — same pre-market reasoning. Sparkline renders most recent
  // session's data when today is still empty.
  const { data: nopeRows } = useQuery<NopeRow[]>({
    queryKey: ['ct_macro_nope', sinceIso.slice(0, 10)],
    refetchInterval: 30_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_nope_minute' as never) as any)
        .select('ticker,tick_timestamp,nope')
        .in('ticker', Array.from(TICKERS))
        .gte('tick_timestamp', sinceIso)
        .order('tick_timestamp', { ascending: true });
      if (error) throw error;
      return (data ?? []) as NopeRow[];
    },
  });

  // VIX — lives in ct_vix_history, not ct_price_bars (different ingester).
  // Captured 3x/day by ct-vix-capture; fields: date, level, prev_close,
  // change_pct, source, created_at.
  const { data: vixRow } = useQuery<{ level: number | null; change_pct: number | null } | null>({
    queryKey: ['ct_macro_vix'],
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_vix_history' as never) as any)
        .select('level,change_pct,created_at')
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) return null;
      const row = (data ?? [])[0] as { level: number | null; change_pct: number | null } | undefined;
      return row ?? null;
    },
  });

  // Regime context for all 10 tickers — single batched RPC, distributed to tiles.
  const { data: intradayMap } = useAllTickersIntradayContext();

  // Market tide — check for table existence, tolerate 404.
  const { data: tide } = useQuery<MarketTideRow | null>({
    queryKey: ['ct_macro_market_tide'],
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data, error } = await (supabase.from('ct_market_tide' as never) as any)
          .select('*')
          .order('recorded_at', { ascending: false })
          .limit(1);
        if (error) return null;
        const row = (data ?? [])[0] as MarketTideRow | undefined;
        return row ?? null;
      } catch {
        return null;
      }
    },
  });

  const priceSummary = useMemo(() => summarize(priceBars ?? []), [priceBars]);

  // Group NOPE by ticker for the tiles.
  const nopeByTicker = useMemo(() => {
    const m = new Map<string, NopeRow[]>();
    for (const t of TICKERS) m.set(t, []);
    for (const r of nopeRows ?? []) {
      const arr = m.get(r.ticker);
      if (arr) arr.push(r);
    }
    return m;
  }, [nopeRows]);

  // Tide label + color.
  const tideLabel = useMemo(() => {
    if (!tide) return null;
    const call = toNum(tide.net_call_premium);
    const put = toNum(tide.net_put_premium);
    if (call == null || put == null) return null;
    const diff = call - put;
    if (diff === 0) return { label: 'FLAT', bullish: null as boolean | null };
    return { label: diff > 0 ? 'BULLISH' : 'BEARISH', bullish: diff > 0 };
  }, [tide]);

  return (
    <div className="space-y-2">
      {/* Section 1 — skinny macro strip */}
      <Card className="px-3 py-1.5 flex items-center gap-4 flex-wrap text-[11px] font-mono tabular-nums">
        {MACRO_TICKERS.map((t) => {
          // VIX draws from ct_vix_history, not ct_price_bars.
          if (t === 'VIX') {
            if (!vixRow || vixRow.level == null) return null;
            return (
              <div key={t} className="flex items-center gap-1.5">
                <span className="text-muted-foreground font-semibold">VIX</span>
                <span className="text-foreground">{vixRow.level.toFixed(2)}</span>
                {vixRow.change_pct != null && (
                  <span className={pctColor(vixRow.change_pct)}>{fmtPct(vixRow.change_pct)}</span>
                )}
              </div>
            );
          }
          const s = priceSummary.get(t);
          return (
            <div key={t} className="flex items-center gap-1.5">
              <span className="text-muted-foreground font-semibold">{t}</span>
              <span className="text-foreground">{fmtSpot(s?.spot ?? null)}</span>
              <span className={pctColor(s?.pct ?? null)}>{fmtPct(s?.pct ?? null)}</span>
            </div>
          );
        })}
        {tideLabel && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground">Tide</span>
            <span
              className={cn(
                'px-1.5 py-0.5 rounded border text-[10px] font-semibold',
                tideLabel.bullish === true && 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
                tideLabel.bullish === false && 'bg-red-500/15 text-red-300 border-red-500/40',
                tideLabel.bullish === null && 'bg-slate-500/15 text-slate-300 border-slate-500/40',
              )}
            >
              {tideLabel.label}
            </span>
          </div>
        )}
      </Card>

      {/* Section 2 — watchlist tiles with NOPE sparklines */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {TICKERS.map((t) => {
          const rows = nopeByTicker.get(t) ?? [];
          const series = rows.map((r) => ({ t: r.tick_timestamp.slice(11, 16), n: toNum(r.nope) ?? 0 }));
          const latest = series.length ? series[series.length - 1].n : null;
          const positive = latest != null ? latest >= 0 : true;
          const color = positive ? '#10b981' : '#ef4444';
          const s = priceSummary.get(t);
          const regime = intradayMap?.get(t) ?? null;
          return (
            <button
              type="button"
              key={t}
              onClick={() => onTickerClick(t)}
              className="shrink-0 w-28 h-24 text-left"
            >
              <Card className="w-full h-full p-1.5 flex flex-col gap-0.5 hover:border-primary/40 transition-colors">
                <div className="flex items-baseline justify-between leading-none">
                  <span className="font-mono font-bold text-[12px] text-foreground">{t}</span>
                  <span className={cn('font-mono tabular-nums text-[9px]', pctColor(s?.pct ?? null))}>
                    {fmtPct(s?.pct ?? null)}
                  </span>
                </div>
                <div className="font-mono tabular-nums text-[10px] text-muted-foreground leading-none">
                  {fmtSpot(s?.spot ?? null)}
                </div>
                {regime && (
                  <div className="leading-none">
                    <RegimeChip context={regime} variant="from-prev-close" withLabel={false} />
                  </div>
                )}
                <div className="flex-1 -mx-1 min-h-0">
                  <ChartSafe>
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={series} margin={{ top: 1, right: 1, left: 1, bottom: 1 }}>
                        <defs>
                          <linearGradient id={`macro-g-${t}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
                            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="2 2" />
                        <Area
                          type="monotone"
                          dataKey="n"
                          stroke={color}
                          strokeWidth={1.25}
                          fill={`url(#macro-g-${t})`}
                          isAnimationActive={false}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </ChartSafe>
                </div>
              </Card>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default MacroBanner;
