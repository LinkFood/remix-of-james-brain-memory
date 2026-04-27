/**
 * MacroBanner — /tape Pillar 1 enrichment.
 *
 * Two stacked sections rendered above the filter strip:
 *   1. Macro strip — SPY/QQQ/IWM/VIX spot + % change, plus market tide pill
 *      when ct_market_tide is available. VIX and tide hide gracefully if
 *      source data isn't present (ct_market_tide doesn't exist yet as of
 *      2026-04-23; guarded with try/catch in query).
 *   2. Watchlist tiles — 10 MacroTiles, one per specialist ticker, each
 *      with an intraday price sparkline (from useMacroSparklines), a
 *      flag-count chip, and a Lean-score footer.
 *
 * All network reads are batched at this level: ct_price_bars (via
 * useMacroSparklines + macro-strip 48h), ct_ticker_lean_score,
 * ct_flags (active-only), ct_vix_history, ct_market_tide, plus the
 * intraday-context RPC. Maps are passed down to each tile by key.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useAllTickersIntradayContext } from '@/hooks/useTickerIntradayContext';
import { useMacroSparklines } from '@/hooks/useMacroSparklines';
import { MacroTile, type MacroLeanSummary } from '@/components/command/MacroTile';

const TICKERS = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'] as const;
const MACRO_TICKERS = ['SPY','QQQ','IWM','VIX'] as const;

interface PriceBarRow {
  ticker: string;
  ts: string;
  close: number | string;
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

interface LeanScoreRow {
  ticker: string;
  score: number | string | null;
  momentum_delta: number | string | null;
  score_at: string;
}

interface FlagCountRow {
  specialist_ticker: string;
  status: string;
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
  // Per-ticker fan-out via Promise.all to avoid PostgREST's 1000-row cap;
  // 14 tickers × ~500 bars/ticker would otherwise truncate to alphabetically-
  // first 2 tickers and silently drop the rest. Same fix pattern as
  // useMacroSparklines (commit 3c5e312, 2026-04-27).
  const { data: priceBars } = useQuery<PriceBarRow[]>({
    queryKey: ['ct_macro_price_bars', sinceIso.slice(0, 10)],
    refetchInterval: 30_000,
    queryFn: async () => {
      const allTickers = Array.from(new Set<string>([...TICKERS, ...MACRO_TICKERS]));
      const results = await Promise.all(
        allTickers.map(async (t) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { data, error } = await (supabase.from('ct_price_bars' as never) as any)
            .select('ticker,ts,close')
            .eq('ticker', t)
            .gte('ts', sinceIso)
            .order('ts', { ascending: true });
          if (error) throw error;
          return (data ?? []) as PriceBarRow[];
        }),
      );
      return results.flat();
    },
  });

  // Intraday sparklines — one batch query, downsampled per ticker.
  const { seriesMap } = useMacroSparklines();

  // Lean scores — batched, one row per ticker (latest score_at per ticker).
  // ct_ticker_lean_score can hold history; we only need the freshest per
  // ticker. Pull the last 30min worth and reduce to the latest per ticker.
  const { data: leanRows } = useQuery<LeanScoreRow[]>({
    queryKey: ['ct_macro_lean_scores'],
    refetchInterval: 60_000,
    retry: false,
    staleTime: 60_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_ticker_lean_score' as never) as any)
        .select('ticker,score,momentum_delta,score_at')
        .in('ticker', Array.from(TICKERS))
        .order('score_at', { ascending: false })
        .limit(TICKERS.length * 4);
      if (error) return [];
      return (data ?? []) as LeanScoreRow[];
    },
  });

  // Active flag counts — single batched query, grouped in JS. "Today"
  // bucket is since today's RTH open (13:30 UTC = 09:30 ET). Counts only
  // non-terminal statuses (active, conviction). Cheap enough with a .in().
  const { data: flagRows } = useQuery<FlagCountRow[]>({
    queryKey: ['ct_macro_flag_counts'],
    refetchInterval: 30_000,
    retry: false,
    queryFn: async () => {
      const today = new Date();
      const rthOpen = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 13, 30, 0)).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_flags' as never) as any)
        .select('specialist_ticker,status')
        .in('specialist_ticker', Array.from(TICKERS))
        .in('status', ['active', 'conviction'])
        .gte('created_at', rthOpen);
      if (error) return [];
      return (data ?? []) as FlagCountRow[];
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

  // Reduce lean score history to latest-per-ticker.
  const leanByTicker = useMemo(() => {
    const m = new Map<string, MacroLeanSummary>();
    for (const r of leanRows ?? []) {
      if (m.has(r.ticker)) continue; // rows pre-sorted desc by score_at → first wins
      const score = toNum(r.score);
      if (score == null) continue;
      m.set(r.ticker, { score, momentum_delta: toNum(r.momentum_delta) });
    }
    return m;
  }, [leanRows]);

  // Count active flags per ticker.
  const flagsByTicker = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of TICKERS) m.set(t, 0);
    for (const r of flagRows ?? []) {
      m.set(r.specialist_ticker, (m.get(r.specialist_ticker) ?? 0) + 1);
    }
    return m;
  }, [flagRows]);

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

      {/* Section 2 — watchlist tiles with intraday sparkline + Lean footer */}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {TICKERS.map((t) => {
          // Prefer intraday-context spot/pct (from-prev-close) over the 48h
          // window calc — it handles pre-market cleanly. Fall back to
          // priceSummary if the RPC returned nothing for this ticker.
          const regime = intradayMap?.get(t) ?? null;
          const summary = priceSummary.get(t);
          const spot = regime?.spot ?? summary?.spot ?? null;
          const pct = regime?.pct_from_prev_close ?? summary?.pct ?? null;
          return (
            <MacroTile
              key={t}
              ticker={t}
              spot={spot}
              pct={pct}
              sparkline={seriesMap.get(t)}
              lean={leanByTicker.get(t)}
              flagCount={flagsByTicker.get(t) ?? 0}
              onClick={() => onTickerClick(t)}
            />
          );
        })}
      </div>
    </div>
  );
}

export default MacroBanner;
