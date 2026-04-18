/**
 * MarketMovers — surfaces tickers OUTSIDE the 12-ticker watchlist.
 * Top bullish/bearish by net premium + canonical unusual sweeps.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useEffectiveSessionDate } from '@/hooks/useEffectiveSessionDate';
import { Card } from '@/components/ui/card';
import { Flame, TrendingUp, TrendingDown, Zap } from 'lucide-react';

interface TopMover {
  ticker: string;
  side: 'bullish' | 'bearish';
  rank: number;
  net_premium: number | null;
  snapshot_at: string;
}

interface Sweep {
  ticker: string;
  type: string | null;
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  volume: number | null;
  open_interest: number | null;
  sweep_ratio: number | null;
  snapshot_at: string;
}

function fmtMoney(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(abs / 1e3).toFixed(0)}K`;
  return `$${abs.toFixed(0)}`;
}

function relTime(iso: string): string {
  const d = Date.now() - Date.parse(iso);
  const m = Math.floor(d / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

  // Fallback when ct_top_movers is empty (UW top-net-impact endpoint not
  // populating): derive movers from the last 30min of flow_alerts, aggregating
  // net premium per ticker. Call-heavy = bullish, put-heavy = bearish.
  // This keeps the panel live off the flow-ingester data we already have.
export function MarketMovers() {
  const { data: session } = useEffectiveSessionDate();
  const sinceKey = session?.isLive === false ? session.sessionStartISO : 'live30';
  const { data: movers } = useQuery<TopMover[]>({
    queryKey: ['ct_top_movers_with_fallback', sinceKey],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = session?.isLive === false && session?.sessionStartISO
        ? session.sessionStartISO
        : new Date(Date.now() - 30 * 60_000).toISOString();
      const primary = await supabase
        .from('ct_top_movers')
        .select('ticker, side, rank, net_premium, snapshot_at')
        .gte('snapshot_at', since)
        .order('snapshot_at', { ascending: false })
        .order('rank', { ascending: true })
        .limit(30);
      if (primary.data && primary.data.length > 0) return primary.data as TopMover[];

      // Fallback: aggregate flow_alerts → pseudo-movers
      const flowResp = await supabase
        .from('ct_flow_alerts')
        .select('ticker, side, premium, ingested_at')
        .gte('ingested_at', since)
        .gte('premium', 100_000)
        .order('premium', { ascending: false })
        .limit(500);
      const flows = (flowResp.data ?? []) as { ticker: string; side: string; premium: number | null; ingested_at: string }[];
      const agg = new Map<string, { call: number; put: number; latest: string }>();
      for (const f of flows) {
        const prem = f.premium ?? 0;
        if (!prem) continue;
        const cur = agg.get(f.ticker) ?? { call: 0, put: 0, latest: f.ingested_at };
        if (f.side === 'call') cur.call += prem;
        else if (f.side === 'put') cur.put += prem;
        if (f.ingested_at > cur.latest) cur.latest = f.ingested_at;
        agg.set(f.ticker, cur);
      }
      const synthetic: TopMover[] = [];
      const bull = Array.from(agg.entries()).map(([t, v]) => ({ t, net: v.call - v.put, latest: v.latest }))
        .filter(x => x.net > 0).sort((a, b) => b.net - a.net).slice(0, 10);
      const bear = Array.from(agg.entries()).map(([t, v]) => ({ t, net: v.put - v.call, latest: v.latest }))
        .filter(x => x.net > 0).sort((a, b) => b.net - a.net).slice(0, 10);
      bull.forEach((x, i) => synthetic.push({ ticker: x.t, side: 'bullish', rank: i + 1, net_premium: x.net, snapshot_at: x.latest }));
      bear.forEach((x, i) => synthetic.push({ ticker: x.t, side: 'bearish', rank: i + 1, net_premium: x.net, snapshot_at: x.latest }));
      return synthetic;
    },
  });

  const { data: sweeps } = useQuery<Sweep[]>({
    queryKey: ['ct_sweeps', sinceKey],
    refetchInterval: 60_000,
    queryFn: async () => {
      const since = session?.isLive === false && session?.sessionStartISO
        ? session.sessionStartISO
        : new Date(Date.now() - 30 * 60_000).toISOString();
      const { data } = await supabase
        .from('ct_sweeps')
        .select('ticker, type, strike, expiry, premium, volume, open_interest, sweep_ratio, snapshot_at')
        .gte('snapshot_at', since)
        .order('premium', { ascending: false })
        .limit(20);
      return (data ?? []) as Sweep[];
    },
  });

  // Dedupe movers by (ticker, side) keeping best rank
  const latestBull = new Map<string, TopMover>();
  const latestBear = new Map<string, TopMover>();
  for (const m of movers ?? []) {
    const map = m.side === 'bullish' ? latestBull : latestBear;
    const existing = map.get(m.ticker);
    if (!existing || m.rank < existing.rank) map.set(m.ticker, m);
  }
  const bullish = Array.from(latestBull.values()).sort((a, b) => a.rank - b.rank).slice(0, 8);
  const bearish = Array.from(latestBear.values()).sort((a, b) => a.rank - b.rank).slice(0, 8);

  return (
    <Card>
      <div className="px-3 py-2 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Flame className="w-3 h-3 text-primary" />
          <span className="text-xs font-semibold uppercase tracking-wide text-foreground">Market Movers</span>
          <span className="text-[10px] text-muted-foreground">outside watchlist · last 30min</span>
        </div>
      </div>

      <div className="grid grid-cols-2 divide-x divide-border">
        <div>
          <div className="px-3 py-1.5 bg-green-500/5 text-[10px] font-semibold text-green-400 uppercase tracking-wide flex items-center gap-1">
            <TrendingUp className="w-3 h-3" /> Top Bullish
          </div>
          {bullish.length === 0 ? (
            <div className="p-3 text-[10px] text-muted-foreground">no data yet</div>
          ) : (
            <div className="divide-y divide-border/50">
              {bullish.map((m) => (
                <div key={m.ticker} className="px-3 py-1 flex items-center gap-2 text-[11px]">
                  <span className="text-muted-foreground w-4">{m.rank}</span>
                  <span className="font-mono font-bold text-foreground">{m.ticker}</span>
                  <span className="text-green-400 ml-auto font-semibold">{fmtMoney(m.net_premium)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="px-3 py-1.5 bg-red-500/5 text-[10px] font-semibold text-red-400 uppercase tracking-wide flex items-center gap-1">
            <TrendingDown className="w-3 h-3" /> Top Bearish
          </div>
          {bearish.length === 0 ? (
            <div className="p-3 text-[10px] text-muted-foreground">no data yet</div>
          ) : (
            <div className="divide-y divide-border/50">
              {bearish.map((m) => (
                <div key={m.ticker} className="px-3 py-1 flex items-center gap-2 text-[11px]">
                  <span className="text-muted-foreground w-4">{m.rank}</span>
                  <span className="font-mono font-bold text-foreground">{m.ticker}</span>
                  <span className="text-red-400 ml-auto font-semibold">{fmtMoney(m.net_premium)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Unusual sweeps */}
      <div className="border-t border-border">
        <div className="px-3 py-1.5 bg-orange-500/5 text-[10px] font-semibold text-orange-400 uppercase tracking-wide flex items-center gap-1">
          <Zap className="w-3 h-3" /> Unusual Sweeps · sweep ratio ≥70% · vol {'>'}OI · $100K+
        </div>
        {!sweeps || sweeps.length === 0 ? (
          <div className="p-3 text-[10px] text-muted-foreground">no sweeps yet</div>
        ) : (
          <div className="divide-y divide-border/50 max-h-[200px] overflow-y-auto font-mono text-[10.5px]">
            {sweeps.map((s, i) => (
              <div key={`${s.ticker}-${s.snapshot_at}-${i}`} className="px-3 py-1 grid grid-cols-[auto_1fr_auto_auto] items-center gap-2">
                <span className="font-bold text-foreground w-12">{s.ticker}</span>
                <span className="text-muted-foreground truncate">
                  {s.strike != null ? `$${s.strike}${s.type?.toLowerCase().startsWith('p') ? 'P' : 'C'}` : '—'}
                  {s.expiry ? ` ${s.expiry.slice(5)}` : ''}
                </span>
                <span className="text-muted-foreground">{relTime(s.snapshot_at)}</span>
                <span className="text-orange-400 font-semibold">{fmtMoney(s.premium)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
