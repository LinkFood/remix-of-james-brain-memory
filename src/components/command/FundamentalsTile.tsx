/**
 * FundamentalsTile — compact fundamentals read for a single ticker.
 *
 * Data source: ct_fundamentals_cache (populated weekly Sunday 22:00 UTC by
 * ct-fundamentals-sync). Pulls the most recent row per ticker.
 *
 * Rendered fields (all gracefully hidden when null — ETFs like USO / GLD
 * typically return a sparse row from UW, the tile still displays whatever
 * subset is present):
 *   - PE ratio   (colored: <15 green, 15–30 amber, >30 red)
 *   - EPS TTM
 *   - Revenue TTM
 *   - Last earnings: "Q? EPS $actual actual vs $est est (±surprise%)"
 *   - Revenue YoY growth %
 *   - Next earnings date (joined from useNextEarningsByTicker / ct_events)
 *
 * Empty state:       "fundamentals not cached — runs weekly"
 * Stale state (>14d): all fields still rendered + small "stale" badge.
 *
 * The tile intentionally makes ZERO direct UW calls on render. Fundamentals
 * change slowly; the weekly cron is enough.
 */
import { memo, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { useNextEarningsByTicker } from '@/hooks/useCoTraderData';

// ─── palette (matches TickerTerminal) ────────────────────────────────
const COLOR_CALL = '#00C853';
const COLOR_PUT  = '#FF1744';
const COLOR_AMBER = '#FFB300';

const STALE_DAYS = 14;

interface FundamentalsRow {
  ticker: string;
  as_of_date: string;
  eps_ttm: number | null;
  revenue_ttm: number | null;
  pe_ratio: number | null;
  market_cap: number | null;
  last_earnings_actual_eps: number | null;
  last_earnings_est_eps: number | null;
  last_earnings_surprise_pct: number | null;
  revenue_yoy_growth_pct: number | null;
  fetched_at: string;
}

// ─── format helpers ──────────────────────────────────────────────────
function fmtMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3)  return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}
function fmtEps(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
}
function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}
function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** PE bucket: <15 green, 15–30 amber, >30 red. Null → muted. */
function peColor(pe: number | null): string {
  if (pe === null || !Number.isFinite(pe) || pe <= 0) return '#94a3b8';
  if (pe < 15) return COLOR_CALL;
  if (pe <= 30) return COLOR_AMBER;
  return COLOR_PUT;
}

function daysOld(iso: string): number {
  const diffMs = Date.now() - Date.parse(iso);
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

// ─── data hook ───────────────────────────────────────────────────────
function useFundamentals(ticker: string) {
  return useQuery<FundamentalsRow | null>({
    queryKey: ['ct_fundamentals_cache', ticker],
    enabled: !!ticker,
    staleTime: 60 * 60_000,         // 1h — changes weekly, no need to hammer
    refetchInterval: 6 * 60 * 60_000, // 6h background
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_fundamentals_cache')
        .select('ticker, as_of_date, eps_ttm, revenue_ttm, pe_ratio, market_cap, last_earnings_actual_eps, last_earnings_est_eps, last_earnings_surprise_pct, revenue_yoy_growth_pct, fetched_at')
        .eq('ticker', ticker)
        .order('as_of_date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return (data as FundamentalsRow | null) ?? null;
    },
  });
}

// ─── component ───────────────────────────────────────────────────────
export const FundamentalsTile = memo(function FundamentalsTile({ ticker }: { ticker: string }) {
  const { data, isLoading } = useFundamentals(ticker);
  const { data: nextEarningsMap } = useNextEarningsByTicker();
  const nextEarnings = nextEarningsMap?.[ticker] ?? null;

  const stale = useMemo(() => {
    if (!data?.fetched_at) return false;
    return daysOld(data.fetched_at) > STALE_DAYS;
  }, [data?.fetched_at]);

  if (isLoading) {
    return (
      <Card className="p-3 bg-black/60 border-white/10 text-[11px] text-muted-foreground">
        <span className="uppercase tracking-wider text-[10px] text-muted-foreground/60 mr-2">Fundamentals</span>
        loading…
      </Card>
    );
  }

  if (!data) {
    return (
      <Card className="p-3 bg-black/60 border-white/10 text-[11px] text-muted-foreground/70">
        <span className="uppercase tracking-wider text-[10px] text-muted-foreground/60 mr-2">Fundamentals</span>
        fundamentals not cached — runs weekly
      </Card>
    );
  }

  const pe = data.pe_ratio;
  const hasLastEarnings = data.last_earnings_actual_eps !== null || data.last_earnings_est_eps !== null;
  const hasAnyField =
    data.pe_ratio !== null ||
    data.eps_ttm !== null ||
    data.revenue_ttm !== null ||
    data.market_cap !== null ||
    hasLastEarnings ||
    data.revenue_yoy_growth_pct !== null;

  // Edge case: row exists but every numeric is null (shouldn't happen — sync
  // skips that case — but guard anyway).
  if (!hasAnyField) {
    return (
      <Card className="p-3 bg-black/60 border-white/10 text-[11px] text-muted-foreground/70">
        <span className="uppercase tracking-wider text-[10px] text-muted-foreground/60 mr-2">Fundamentals</span>
        no fundamentals available for this instrument (likely ETF — not equity)
      </Card>
    );
  }

  const peTone = peColor(pe);
  const surpriseColor =
    data.last_earnings_surprise_pct === null
      ? '#94a3b8'
      : data.last_earnings_surprise_pct >= 0 ? COLOR_CALL : COLOR_PUT;
  const yoyColor =
    data.revenue_yoy_growth_pct === null
      ? '#94a3b8'
      : data.revenue_yoy_growth_pct >= 0 ? COLOR_CALL : COLOR_PUT;

  return (
    <Card className="p-3 bg-black/60 border-white/10">
      <div className="flex items-center justify-between mb-2">
        <span className="uppercase tracking-wider text-[10px] text-muted-foreground/70">
          Fundamentals
        </span>
        <div className="flex items-center gap-2">
          {stale && (
            <Badge variant="outline" className="text-[9px] bg-amber-500/10 text-amber-400 border-amber-500/30 uppercase tracking-wider">
              stale · {daysOld(data.fetched_at)}d
            </Badge>
          )}
          <span className="text-[10px] text-muted-foreground tabular-nums">
            as of {fmtDate(data.as_of_date)}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-2 text-[11px] tabular-nums">
        {/* PE ratio — color by bucket */}
        {pe !== null && (
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">P/E</span>
            <span className="font-semibold text-sm" style={{ color: peTone }}>
              {pe.toFixed(1)}
            </span>
          </div>
        )}
        {/* Market cap */}
        {data.market_cap !== null && (
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Mkt cap</span>
            <span className="text-foreground">{fmtMoney(data.market_cap)}</span>
          </div>
        )}
        {/* EPS TTM */}
        {data.eps_ttm !== null && (
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">EPS TTM</span>
            <span className="text-foreground">{fmtEps(data.eps_ttm)}</span>
          </div>
        )}
        {/* Revenue TTM */}
        {data.revenue_ttm !== null && (
          <div className="flex flex-col">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">Rev TTM</span>
            <span className="text-foreground">{fmtMoney(data.revenue_ttm)}</span>
          </div>
        )}
      </div>

      {/* Last earnings line */}
      {hasLastEarnings && (
        <div className="mt-2 pt-2 border-t border-white/5 text-[11px]">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mr-2">
            Last earnings
          </span>
          <span className="text-foreground tabular-nums">
            EPS {fmtEps(data.last_earnings_actual_eps)} actual
            {data.last_earnings_est_eps !== null && (
              <> vs {fmtEps(data.last_earnings_est_eps)} est</>
            )}
          </span>
          {data.last_earnings_surprise_pct !== null && (
            <span className="ml-2 font-semibold tabular-nums" style={{ color: surpriseColor }}>
              ({fmtPct(data.last_earnings_surprise_pct, 1)} surprise)
            </span>
          )}
        </div>
      )}

      {/* Revenue YoY + Next earnings — side-by-side footer row */}
      {(data.revenue_yoy_growth_pct !== null || nextEarnings) && (
        <div className="mt-1 flex items-center gap-4 text-[11px]">
          {data.revenue_yoy_growth_pct !== null && (
            <span>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mr-1">
                Rev YoY
              </span>
              <span className="font-semibold tabular-nums" style={{ color: yoyColor }}>
                {fmtPct(data.revenue_yoy_growth_pct, 1)}
              </span>
            </span>
          )}
          {nextEarnings && (
            <span className="ml-auto">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mr-1">
                Next earnings
              </span>
              <span className="text-foreground tabular-nums">
                {nextEarnings.report_date}
                {nextEarnings.report_time ? ` · ${nextEarnings.report_time.toUpperCase()}` : ''}
              </span>
            </span>
          )}
        </div>
      )}
    </Card>
  );
});
