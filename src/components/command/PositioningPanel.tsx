/**
 * PositioningPanel — EOD options positioning at a glance.
 *
 * One row per watchlist ticker. Three columns:
 *   - ticker
 *   - IV rank (color badge: red ≥80, yellow 40-79, green <40)
 *   - max pain strike (nearest upcoming expiry)
 *
 * High IV rank (≥80) gets a flame icon — "expensive options, different setup."
 * Low IV rank (<20) gets a snowflake — "cheap vol, premium-buyer edge."
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Activity, Flame, Snowflake } from 'lucide-react';

const WATCHLIST = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA','GLD','USO','SPX'] as const;

interface IvLatest {
  ticker: string;
  date: string;
  iv_rank: number | null;
  iv_30d: number | null;
}

interface MaxPainNearest {
  ticker: string;
  expiry: string | null;
  max_pain_strike: number | null;
}

/** One query for the latest IV rank per watchlist ticker. */
function useIvRankLatestAll() {
  return useQuery<Record<string, IvLatest>>({
    queryKey: ['ct_iv_rank_latest_all'],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      // Pull last 2 days across watchlist; reduce to latest per ticker client-side.
      // Single-user scale: bounded small set, cheap.
      const since = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_iv_rank_daily')
        .select('ticker, date, iv_rank, iv_30d')
        .in('ticker', WATCHLIST as unknown as string[])
        .gte('date', since)
        .order('date', { ascending: false });
      if (error) throw error;
      const latest: Record<string, IvLatest> = {};
      for (const r of (data ?? []) as IvLatest[]) {
        if (!latest[r.ticker]) latest[r.ticker] = r;
      }
      return latest;
    },
  });
}

/** Nearest-expiry max pain per watchlist ticker, from the latest snapshot date. */
function useMaxPainNearestAll() {
  return useQuery<Record<string, MaxPainNearest>>({
    queryKey: ['ct_max_pain_nearest_all'],
    refetchInterval: 5 * 60_000,
    queryFn: async () => {
      const since = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_max_pain_daily')
        .select('ticker, date, expiry, max_pain_strike')
        .in('ticker', WATCHLIST as unknown as string[])
        .gte('date', since)
        .order('date', { ascending: false })
        .order('expiry', { ascending: true, nullsFirst: false });
      if (error) throw error;
      const todayStr = new Date().toISOString().slice(0, 10);
      const latestDate: Record<string, string> = {};
      for (const r of (data ?? []) as Array<{ ticker: string; date: string }>) {
        if (!latestDate[r.ticker]) latestDate[r.ticker] = r.date;
      }
      const nearest: Record<string, MaxPainNearest> = {};
      for (const r of (data ?? []) as Array<MaxPainNearest & { date: string }>) {
        if (r.date !== latestDate[r.ticker]) continue;
        if (nearest[r.ticker]) continue;
        // Prefer the first expiry >= today; if none, first expiry in list
        if (r.expiry && r.expiry >= todayStr) {
          nearest[r.ticker] = r;
        }
      }
      // fill any tickers that had no future expiry — first row of their latest date
      for (const r of (data ?? []) as Array<MaxPainNearest & { date: string }>) {
        if (r.date !== latestDate[r.ticker]) continue;
        if (!nearest[r.ticker]) nearest[r.ticker] = r;
      }
      return nearest;
    },
  });
}

function ivBadgeClass(rank: number | null): string {
  if (rank === null) return 'bg-muted text-muted-foreground';
  if (rank >= 80) return 'bg-red-500/20 text-red-300 border border-red-500/40';
  if (rank >= 40) return 'bg-yellow-500/15 text-yellow-300 border border-yellow-500/30';
  return 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/25';
}

function fmtStrike(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  // No decimals for whole strikes; otherwise one.
  return Math.abs(n) >= 100
    ? n.toFixed(0)
    : (Math.round(n * 10) / 10).toString();
}

function fmtExpiry(s: string | null): string {
  if (!s) return '';
  // YYYY-MM-DD → M/D
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return s;
  return `${parseInt(m[2], 10)}/${parseInt(m[3], 10)}`;
}

export function PositioningPanel() {
  const ivQ = useIvRankLatestAll();
  const mpQ = useMaxPainNearestAll();
  const isLoading = ivQ.isLoading || mpQ.isLoading;
  const ivMap = ivQ.data ?? {};
  const mpMap = mpQ.data ?? {};

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
        <Activity className="w-3 h-3 text-primary" />
        <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Positioning</span>
        <span className="text-[10px] text-muted-foreground">EOD · IV rank · max pain</span>
        {isLoading && <span className="ml-auto text-[10px] text-muted-foreground">loading…</span>}
      </div>
      <div className="divide-y divide-border/50">
        <div className="grid grid-cols-[56px_1fr_1fr] px-2.5 py-1 text-[9.5px] uppercase tracking-wide text-muted-foreground bg-muted/10">
          <div>Ticker</div>
          <div>IV Rank</div>
          <div>Max Pain</div>
        </div>
        {WATCHLIST.map((t) => {
          const iv = ivMap[t];
          const mp = mpMap[t];
          const rank = iv?.iv_rank ?? null;
          const isHot = rank !== null && rank >= 80;
          const isCold = rank !== null && rank < 20;
          return (
            <div
              key={t}
              className="grid grid-cols-[56px_1fr_1fr] px-2.5 py-1.5 items-center text-[11px]"
            >
              <div className="font-mono font-bold text-foreground">{t}</div>
              <div className="flex items-center gap-1.5">
                <span
                  className={`font-mono text-[10.5px] px-1.5 py-0.5 rounded ${ivBadgeClass(rank)}`}
                  title={iv?.iv_30d != null ? `IV30d: ${iv.iv_30d.toFixed(2)}` : undefined}
                >
                  {rank === null ? '—' : rank.toFixed(0)}
                </span>
                {isHot && <Flame className="w-3 h-3 text-red-400" aria-label="high IV" />}
                {isCold && <Snowflake className="w-3 h-3 text-sky-400" aria-label="low IV" />}
              </div>
              <div className="flex items-baseline gap-1.5 font-mono">
                <span className="text-foreground">{fmtStrike(mp?.max_pain_strike ?? null)}</span>
                {mp?.expiry && (
                  <span className="text-[9.5px] text-muted-foreground">{fmtExpiry(mp.expiry)}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
