/**
 * MarketBreadth — compact watchlist-breadth card.
 *
 * Reads ct_heartbeats (no new UW calls) and shows at a glance whether the
 * tape is broad (all 12 tickers participating) or narrow (SPY up alone).
 *
 * Five mini-stats:
 *   1. Advance / Decline / Flat
 *   2. Net % (avg Δ across watchlist)
 *   3. Leader / Laggard
 *   4. Sector row (Indexes · Mag7 · Commodities)
 *   5. Correlation-to-SPY bar (high >75% · mixed 50-75 · divergent <50)
 *
 * Plus:
 *   - Optional VIX pill (deferred — ct_heartbeats doesn't capture it yet).
 *   - Tiny inline sparkline of (advances − declines) over last 30 heartbeats.
 *
 * "Warming up" state when the session only has 1 heartbeat (no anchor vs
 * latest divergence possible) or no heartbeat at all.
 */
import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { FreshnessChip } from '@/components/FreshnessChip';
import { Activity, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { LineChart, Line, ResponsiveContainer, YAxis } from 'recharts';
import { ChartSafe } from '@/components/ChartSafe';
import { useMarketBreadth } from '@/hooks/useMarketBreadth';
import { useLatestHeartbeat } from '@/hooks/useCoTraderData';
import { SessionBadge } from '@/components/command/SessionBadge';
import { finite } from '@/lib/chartSanitize';

// ─── formatters ─────────────────────────────────────────────────────────────

function fmtPct(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function signColor(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || Math.abs(n) < 0.1) {
    return 'text-muted-foreground';
  }
  return n > 0 ? 'text-green-500' : 'text-red-500';
}

function corrColor(label: 'high' | 'mixed' | 'divergent' | 'n/a'): string {
  if (label === 'high') return 'text-green-500';
  if (label === 'mixed') return 'text-amber-400';
  if (label === 'divergent') return 'text-red-500';
  return 'text-muted-foreground';
}

function corrBarColor(label: 'high' | 'mixed' | 'divergent' | 'n/a'): string {
  if (label === 'high') return 'bg-green-500';
  if (label === 'mixed') return 'bg-amber-400';
  if (label === 'divergent') return 'bg-red-500';
  return 'bg-muted-foreground/40';
}

// ─── main ───────────────────────────────────────────────────────────────────

export function MarketBreadth() {
  const b = useMarketBreadth();
  const { data: latestHeartbeat } = useLatestHeartbeat();

  const warmingUp = !b.loading && !b.has_data;

  // Sparkline data — flatten to (idx, net) and compute a symmetric Y domain.
  // Drop non-finite nets; a single NaN reaching Recharts YAxis triggers LN10.
  const sparkData = useMemo(() => {
    if (b.breadth_trend.length < 2) return [] as Array<{ i: number; net: number }>;
    return b.breadth_trend
      .map((p, i) => {
        const net = finite(p.net);
        return net !== null ? { i, net } : null;
      })
      .filter((r): r is { i: number; net: number } => r !== null);
  }, [b.breadth_trend]);

  const sparkDomain = useMemo<[number, number]>(() => {
    if (sparkData.length === 0) return [-1, 1];
    const abs = Math.max(1, ...sparkData.map(d => Math.abs(d.net)));
    return Number.isFinite(abs) ? [-abs, abs] : [-1, 1];
  }, [sparkData]);

  return (
    <Card className="p-4 bg-gradient-to-br from-muted/50 to-background border-border">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">Breadth</h2>
        <span className="text-[10px] text-muted-foreground/70 ml-1">
          watchlist · {b.ticker_count}/12
        </span>
        <SessionBadge />
        <FreshnessChip
          timestamp={latestHeartbeat?.created_at ?? null}
          label="heartbeat"
          className={b.vix ? '' : 'ml-auto'}
        />
        {b.vix && (
          <span
            className={`ml-auto inline-flex items-center gap-1 px-1.5 py-0 rounded text-[9px] font-semibold uppercase tracking-wider border ${
              b.vix.tier === 'low'
                ? 'bg-green-500/10 text-green-400 border-green-500/25'
                : b.vix.tier === 'mid'
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/25'
                : b.vix.tier === 'elevated'
                ? 'bg-orange-500/10 text-orange-400 border-orange-500/25'
                : 'bg-red-500/10 text-red-400 border-red-500/25'
            }`}
            title={b.vix.source === 'VIXY' ? 'Proxied via VIXY — raw level not comparable to index VIX' : undefined}
          >
            VIX {b.vix.level.toFixed(1)}
            {b.vix.change_pct != null && Number.isFinite(b.vix.change_pct) && (
              <span className="opacity-70 font-mono tabular-nums">
                {b.vix.change_pct >= 0 ? '+' : ''}{b.vix.change_pct.toFixed(1)}%
              </span>
            )}
            <span className="opacity-80">· {b.vix.tier}</span>
            {b.vix.source === 'VIXY' && <span className="opacity-60">·proxy</span>}
          </span>
        )}
      </div>

      {b.loading ? (
        <div className="text-muted-foreground text-sm">loading…</div>
      ) : warmingUp ? (
        <div className="text-xs text-muted-foreground">
          warming up — need at least 2 heartbeats for breadth signal
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3">
          {/* 1 · Advance / Decline / Flat */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              A / D / Flat
            </div>
            <div className="flex items-baseline gap-2 font-mono tabular-nums">
              <span className="text-green-500 text-lg font-semibold">{b.advances}</span>
              <span className="text-muted-foreground/40">/</span>
              <span className="text-red-500 text-lg font-semibold">{b.declines}</span>
              <span className="text-muted-foreground/40">/</span>
              <span className="text-muted-foreground text-lg font-semibold">{b.flat}</span>
            </div>
            {sparkData.length >= 2 && (
              <ChartSafe label="breadth-spark">
                <div className="h-6 mt-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={sparkData} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
                      <YAxis domain={sparkDomain} hide />
                      <Line
                        type="monotone"
                        dataKey="net"
                        stroke="currentColor"
                        className={
                          sparkData[sparkData.length - 1].net >= 0 ? 'text-green-500' : 'text-red-500'
                        }
                        strokeWidth={1.25}
                        dot={false}
                        isAnimationActive={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </ChartSafe>
            )}
          </div>

          {/* 2 · Net % */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Net Δ (avg)
            </div>
            <div
              className={`text-lg font-semibold font-mono tabular-nums flex items-center gap-1 ${signColor(
                b.net_pct
              )}`}
            >
              {b.net_pct != null && Math.abs(b.net_pct) >= 0.1 ? (
                b.net_pct > 0 ? (
                  <TrendingUp className="w-3.5 h-3.5" />
                ) : (
                  <TrendingDown className="w-3.5 h-3.5" />
                )
              ) : (
                <Minus className="w-3.5 h-3.5" />
              )}
              {fmtPct(b.net_pct)}
            </div>
            <div className="text-[10px] text-muted-foreground/70">
              across {b.ticker_count} tickers
            </div>
          </div>

          {/* 3 · Leader / Laggard */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Leader · Laggard
            </div>
            <div className="space-y-0.5 font-mono tabular-nums">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-foreground/90">{b.leader?.ticker ?? '–'}</span>
                <span className={`text-xs font-semibold ${signColor(b.leader?.pct ?? null)}`}>
                  {fmtPct(b.leader?.pct ?? null)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] text-foreground/90">{b.laggard?.ticker ?? '–'}</span>
                <span className={`text-xs font-semibold ${signColor(b.laggard?.pct ?? null)}`}>
                  {fmtPct(b.laggard?.pct ?? null)}
                </span>
              </div>
            </div>
          </div>

          {/* 4 · Sectors */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Sectors
            </div>
            <div className="space-y-0.5 font-mono tabular-nums">
              {b.sectors.map(s => (
                <div key={s.name} className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] text-foreground/80">{s.name}</span>
                  <span className={`text-xs font-semibold ${signColor(s.avg_pct)}`}>
                    {fmtPct(s.avg_pct)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 5 · Correlation to SPY */}
          <div className="space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
              Corr → SPY
            </div>
            <div
              className={`text-lg font-semibold font-mono tabular-nums ${corrColor(
                b.correlation_to_spy.label
              )}`}
            >
              {b.correlation_to_spy.pct != null
                ? `${b.correlation_to_spy.pct.toFixed(0)}%`
                : '–'}
            </div>
            <div className="space-y-1">
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full ${corrBarColor(b.correlation_to_spy.label)} transition-all`}
                  style={{
                    width: `${Math.min(100, Math.max(0, b.correlation_to_spy.pct ?? 0))}%`,
                  }}
                />
              </div>
              <div className={`text-[10px] uppercase tracking-wider ${corrColor(b.correlation_to_spy.label)}`}>
                {b.correlation_to_spy.label === 'n/a' ? 'SPY flat' : b.correlation_to_spy.label}
              </div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
