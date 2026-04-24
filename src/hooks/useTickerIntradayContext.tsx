/**
 * useTickerIntradayContext — regime context (% from prev close + % from today
 * open) for Co-Trader's watchlist tickers. Two RPCs feed this:
 *
 *   - ct_ticker_intraday_context(p_ticker TEXT) — one row per ticker
 *   - ct_all_tickers_intraday_context()         — all 10 watchlist tickers
 *
 * The batch hook lives in MacroBanner's orbit — it fetches once for the grid
 * and we pass the map down to avoid per-tile fan-out.
 *
 * Pre-market note: today_open is null until the cash open (13:30 UTC). Every
 * consumer of this data must handle null gracefully — RegimeChip renders a
 * dash in that case.
 */

import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

export interface IntradayContext {
  ticker: string;
  spot: number | null;
  prev_close: number | null;
  today_open: number | null;
  pct_from_prev_close: number | null;
  pct_from_today_open: number | null;
  as_of: string | null;
}

function toNum(n: unknown): number | null {
  if (n == null) return null;
  const v = typeof n === 'number' ? n : parseFloat(String(n));
  return Number.isFinite(v) ? v : null;
}

function normalizeRow(row: Record<string, unknown> | null | undefined): IntradayContext | null {
  if (!row) return null;
  const ticker = typeof row.ticker === 'string' ? row.ticker : null;
  if (!ticker) return null;
  return {
    ticker,
    spot: toNum(row.spot),
    prev_close: toNum(row.prev_close),
    today_open: toNum(row.today_open),
    pct_from_prev_close: toNum(row.pct_from_prev_close),
    pct_from_today_open: toNum(row.pct_from_today_open),
    as_of: typeof row.as_of === 'string' ? row.as_of : null,
  };
}

/** Single-ticker intraday context. Safe to call with undefined — query is disabled. */
export function useTickerIntradayContext(ticker?: string) {
  return useQuery<IntradayContext | null>({
    queryKey: ['intraday-context', ticker ?? null],
    enabled: !!ticker,
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      if (!ticker) return null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('ct_ticker_intraday_context', {
        p_ticker: ticker,
      });
      if (error) return null;
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return normalizeRow(rows[0] as Record<string, unknown> | undefined);
    },
  });
}

/** All-watchlist intraday context returned as Map<ticker, IntradayContext>. */
export function useAllTickersIntradayContext() {
  return useQuery<Map<string, IntradayContext>>({
    queryKey: ['all-intraday-context'],
    staleTime: 60_000,
    refetchInterval: 60_000,
    retry: false,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.rpc as any)('ct_all_tickers_intraday_context');
      const map = new Map<string, IntradayContext>();
      if (error) return map;
      const rows = Array.isArray(data) ? data : [];
      for (const r of rows) {
        const norm = normalizeRow(r as Record<string, unknown>);
        if (norm) map.set(norm.ticker, norm);
      }
      return map;
    },
  });
}

// ---------------------------------------------------------------------------
// RegimeChip — inline % chip. Shared across TickerSheet, MacroBanner, /tape.
// ---------------------------------------------------------------------------

export type RegimeChipVariant = 'from-prev-close' | 'from-today-open' | 'both';

interface RegimeChipProps {
  context: IntradayContext | null | undefined;
  variant?: RegimeChipVariant;
  /** Override: pass raw pct numbers when you don't have a full context row (e.g. /tape rows). */
  pctFromPrevClose?: number | null;
  pctFromTodayOpen?: number | null;
  /** Show the source label ("(prev close)", "(open)") alongside the number. Default true. */
  withLabel?: boolean;
  className?: string;
}

function pctTone(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return 'text-muted-foreground';
  if (Math.abs(pct) < 0.15) return 'text-muted-foreground';
  return pct > 0 ? 'text-emerald-400' : 'text-red-400';
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—';
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

/**
 * Inline regime chip. Small by default, color-tinted by sign (green / red /
 * muted gray when |pct| < 0.15%). Gracefully renders a dash when numbers are
 * null — important pre-market when today_open isn't set yet.
 */
export function RegimeChip({
  context,
  variant = 'both',
  pctFromPrevClose,
  pctFromTodayOpen,
  withLabel = true,
  className,
}: RegimeChipProps) {
  const prevClosePct = pctFromPrevClose !== undefined ? pctFromPrevClose : context?.pct_from_prev_close ?? null;
  const todayOpenPct = pctFromTodayOpen !== undefined ? pctFromTodayOpen : context?.pct_from_today_open ?? null;

  if (variant === 'from-prev-close') {
    return (
      <span className={cn('font-mono tabular-nums text-[10px]', pctTone(prevClosePct), className)}>
        {fmtPct(prevClosePct)}
        {withLabel && <span className="text-muted-foreground/70 ml-1">(prev close)</span>}
      </span>
    );
  }

  if (variant === 'from-today-open') {
    return (
      <span className={cn('font-mono tabular-nums text-[10px]', pctTone(todayOpenPct), className)}>
        {fmtPct(todayOpenPct)}
        {withLabel && <span className="text-muted-foreground/70 ml-1">(open)</span>}
      </span>
    );
  }

  // variant === 'both'
  return (
    <span className={cn('inline-flex items-center gap-1.5 font-mono tabular-nums text-[10px]', className)}>
      <span className={pctTone(prevClosePct)}>
        {fmtPct(prevClosePct)}
        {withLabel && <span className="text-muted-foreground/70 ml-1">(prev close)</span>}
      </span>
      <span className={pctTone(todayOpenPct)}>
        {fmtPct(todayOpenPct)}
        {withLabel && <span className="text-muted-foreground/70 ml-1">(open)</span>}
      </span>
    </span>
  );
}

// Re-export for convenience — some consumers may prefer a shared namespace.
export const IntradayContextUtils = {
  fmtPct,
  pctTone,
};
