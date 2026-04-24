/**
 * /pulse — per-ticker weighted signal score across today's session.
 *
 * Each tile shows:
 *   - Current net score (green/red)
 *   - 15m slope
 *   - Sparkline of the score through the session
 *   - Dollar-volume bar (bull vs bear weighted premium)
 *   - Vote breakdown by signal type (toggle-filterable)
 *
 * Data flows from ct_pulse_timeline (refreshed every 5 min by ct_pulse_tick).
 * Line and breakdown render the FULL score; toggles currently filter the
 * breakdown counts only (v2 will add filter-aware line recompute on client).
 */

import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Activity, TrendingUp, RefreshCw } from 'lucide-react';
import { Area, AreaChart, ResponsiveContainer, ReferenceLine, Tooltip } from 'recharts';
import { ChartSafe } from '@/components/ChartSafe';

const TICKERS = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];

const SIGNAL_TYPES = [
  { key: 'sweep',        label: 'Sweeps',     color: '#60a5fa' },
  // dp_cluster RETIRED 2026-04-23 (direction unreliable)
  { key: 'news',         label: 'News',       color: '#f59e0b' },
  { key: 'insider',      label: 'Insider',    color: '#34d399' },
  { key: 'congress',     label: 'Congress',   color: '#f472b6' },
  { key: 'claude_alert', label: 'Claude',     color: '#22d3ee' },
];

interface TimelineRow {
  ticker: string;
  bucket_ts: string;
  score: number;
  bull_votes: number;
  bear_votes: number;
  bull_weighted_usd: number;
  bear_weighted_usd: number;
  signals_by_type: Record<string, { n: number; bull: number; bear: number }> | null;
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${Math.round(n)}`;
}

function scoreColor(score: number): string {
  if (score > 15) return '#10b981';    // emerald
  if (score > 5)  return '#34d399';    // teal
  if (score > -5) return '#64748b';    // slate
  if (score > -15) return '#f87171';   // red-300
  return '#dc2626';                     // red
}

function TickerTile({
  ticker,
  rows,
  enabledTypes,
}: {
  ticker: string;
  rows: TimelineRow[];
  enabledTypes: Set<string>;
}) {
  const latest = rows[rows.length - 1];
  const fifteenAgo = rows[Math.max(0, rows.length - 4)];
  const slope = latest && fifteenAgo ? latest.score - fifteenAgo.score : 0;
  const score = latest?.score ?? 0;
  const color = scoreColor(score);

  // Series for sparkline — just (bucket_ts, score) pairs
  const series = useMemo(
    () => rows.map((r) => ({ t: r.bucket_ts.slice(11, 16), s: r.score })),
    [rows]
  );

  // Aggregate bull/bear votes + weighted USD respecting toggles.
  const agg = useMemo(() => {
    let bullVotes = 0, bearVotes = 0;
    let bullUsd = 0, bearUsd = 0;
    const byType: Record<string, { n: number; bull: number; bear: number }> = {};
    for (const r of rows) {
      const sbt = r.signals_by_type ?? {};
      for (const [t, v] of Object.entries(sbt)) {
        if (!enabledTypes.has(t)) continue;
        if (!byType[t]) byType[t] = { n: 0, bull: 0, bear: 0 };
        // Use the most recent bucket's counts (they're cumulative)
        byType[t] = v;
      }
    }
    // bull/bear from latest bucket, filtered
    for (const t of Object.keys(byType)) {
      bullVotes += byType[t].bull;
      bearVotes += byType[t].bear;
    }
    if (latest) {
      bullUsd = Number(latest.bull_weighted_usd) || 0;
      bearUsd = Number(latest.bear_weighted_usd) || 0;
    }
    return { bullVotes, bearVotes, bullUsd, bearUsd, byType };
  }, [rows, enabledTypes, latest]);

  const volTotal = agg.bullUsd + agg.bearUsd;
  const bullPct = volTotal > 0 ? (agg.bullUsd / volTotal) * 100 : 50;

  return (
    <Card className="p-3 flex flex-col gap-2 hover:shadow-md transition-shadow">
      <div className="flex items-baseline justify-between">
        <div className="font-mono font-semibold text-base">{ticker}</div>
        <div className="text-xs text-muted-foreground tabular-nums">
          {slope >= 0 ? '▲' : '▼'} {slope.toFixed(2)}
        </div>
      </div>
      <div className="text-3xl font-bold tabular-nums" style={{ color }}>
        {score >= 0 ? '+' : ''}{score.toFixed(1)}
      </div>

      {/* Sparkline */}
      <div className="h-[54px] -mx-1">
        <ChartSafe>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
              <defs>
                <linearGradient id={`g-${ticker}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={color} stopOpacity={0.6} />
                  <stop offset="95%" stopColor={color} stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <ReferenceLine y={0} stroke="hsl(var(--border))" strokeDasharray="2 2" />
              <Area
                type="monotone"
                dataKey="s"
                stroke={color}
                strokeWidth={1.5}
                fill={`url(#g-${ticker})`}
                isAnimationActive={false}
              />
              <Tooltip
                contentStyle={{ fontSize: 10, padding: '2px 6px' }}
                labelFormatter={() => ''}
                formatter={(value: number) => [value.toFixed(2), 'score']}
              />
            </AreaChart>
          </ResponsiveContainer>
        </ChartSafe>
      </div>

      {/* Dollar volume bar */}
      {volTotal > 0 && (
        <div>
          <div className="h-1.5 w-full rounded bg-muted overflow-hidden flex">
            <div className="bg-emerald-500" style={{ width: `${bullPct}%` }} />
            <div className="bg-red-500" style={{ width: `${100 - bullPct}%` }} />
          </div>
          <div className="flex justify-between text-[9px] text-muted-foreground mt-0.5 tabular-nums">
            <span>{fmtUsd(agg.bullUsd)}</span>
            <span>{fmtUsd(agg.bearUsd)}</span>
          </div>
        </div>
      )}

      {/* Vote counts by type */}
      <div className="flex flex-wrap gap-1">
        {SIGNAL_TYPES.filter((st) => enabledTypes.has(st.key)).map((st) => {
          const v = agg.byType[st.key];
          if (!v || v.n === 0) return null;
          return (
            <div
              key={st.key}
              className="text-[9px] px-1.5 py-0.5 rounded font-mono flex items-center gap-1"
              style={{ backgroundColor: `${st.color}22`, color: st.color }}
              title={`${st.label}: ${v.bull} bull, ${v.bear} bear`}
            >
              <span>{st.label.slice(0, 3)}</span>
              <span className="tabular-nums">{v.bull > 0 && `+${v.bull}`}{v.bear > 0 && ` -${v.bear}`}</span>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default function Pulse() {
  const qc = useQueryClient();
  const [enabled, setEnabled] = useState<Set<string>>(
    new Set(SIGNAL_TYPES.map((s) => s.key))
  );
  const [recomputing, setRecomputing] = useState(false);

  const { data: rows, isLoading, dataUpdatedAt } = useQuery<TimelineRow[]>({
    queryKey: ['ct_pulse_timeline'],
    queryFn: async () => {
      const today = new Date().toISOString().slice(0, 10);
      const { data, error } = await supabase
        .from('ct_pulse_timeline' as never)
        .select('ticker, bucket_ts, score, bull_votes, bear_votes, bull_weighted_usd, bear_weighted_usd, signals_by_type')
        .eq('session_date', today)
        .order('bucket_ts', { ascending: true });
      if (error) throw error;
      return (data ?? []) as unknown as TimelineRow[];
    },
    refetchInterval: 60_000,
  });

  const byTicker = useMemo(() => {
    const m = new Map<string, TimelineRow[]>();
    for (const t of TICKERS) m.set(t, []);
    for (const r of rows ?? []) {
      const arr = m.get(r.ticker);
      if (arr) arr.push(r);
    }
    return m;
  }, [rows]);

  const toggle = (key: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const forceRefresh = async () => {
    setRecomputing(true);
    try {
      await supabase.rpc('ct_pulse_tick' as never);
      qc.invalidateQueries({ queryKey: ['ct_pulse_timeline'] });
    } catch (e) {
      console.error('[Pulse] refresh failed:', e);
    } finally {
      setRecomputing(false);
    }
  };

  const totalVotes = useMemo(() => {
    let bull = 0, bear = 0;
    for (const arr of byTicker.values()) {
      const latest = arr[arr.length - 1];
      if (!latest) continue;
      const sbt = latest.signals_by_type ?? {};
      for (const [t, v] of Object.entries(sbt)) {
        if (!enabled.has(t)) continue;
        bull += v.bull;
        bear += v.bear;
      }
    }
    return { bull, bear };
  }, [byTicker, enabled]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              <span>Pulse</span>
              <span className="text-sm text-muted-foreground font-normal">
                per-ticker weighted signal score — today
              </span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every sweep, DP cluster, news, insider/congress trade, and Claude alert
              classified bull/bear/neutral and weighted by size + recency. Line starts
              at 0 at 09:30 ET, moves with the tape.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-[11px] text-muted-foreground tabular-nums">
              {totalVotes.bull} bull / {totalVotes.bear} bear
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={forceRefresh}
              disabled={recomputing}
              className="text-xs"
            >
              <RefreshCw className={cn('w-3 h-3 mr-1', recomputing && 'animate-spin')} />
              {recomputing ? 'Refreshing…' : 'Refresh'}
            </Button>
          </div>
        </header>

        {/* Signal-type toggles */}
        <Card className="p-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground mr-2">Signals:</span>
          {SIGNAL_TYPES.map((st) => {
            const on = enabled.has(st.key);
            return (
              <button
                key={st.key}
                onClick={() => toggle(st.key)}
                className={cn(
                  'text-[11px] px-2 py-1 rounded border font-mono transition-colors',
                  on ? 'border-transparent' : 'border-muted bg-muted/20 text-muted-foreground'
                )}
                style={on ? { backgroundColor: `${st.color}22`, color: st.color, borderColor: `${st.color}44` } : undefined}
              >
                {on ? '☑' : '☐'} {st.label}
              </button>
            );
          })}
        </Card>

        {/* Tiles */}
        {isLoading && !rows ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Loading pulse…
          </Card>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {TICKERS.map((t) => (
              <TickerTile
                key={t}
                ticker={t}
                rows={byTicker.get(t) ?? []}
                enabledTypes={enabled}
              />
            ))}
          </div>
        )}

        <div className="text-[10px] text-muted-foreground leading-relaxed space-y-1">
          <div>
            Score = sum of (direction × signal-weight × size-multiplier × recency-decay)
            across today's session. Reset at 09:30 ET. Half-lives: sweeps 45m, DP 2h,
            news 6h, insider 14d, congress 30d, Claude alert 1h.
          </div>
          <div>
            <span className="font-semibold">Color scale:</span> green &gt;+15 (strong bull)
            / teal +5 to +15 / slate neutral / red-light -5 to -15 / red &lt; -15 (strong bear).
            <span className="font-semibold ml-2">Volume bar:</span> bull vs bear dollar-weighted premium.
            <span className="font-semibold ml-2">Chips:</span> per-signal-type vote counts — bullish and bearish.
          </div>
          <div>
            Refreshes every 60s. Cron recomputes every 5 min during RTH.
            SPX signals folded into SPY. Watchlist: 12 tickers.
          </div>
        </div>
      </div>
    </div>
  );
}
