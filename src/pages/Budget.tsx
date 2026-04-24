/**
 * /budget — UW API budget drilldown.
 *
 * Reads ct_uw_usage: every UW response writes a row with the 5 rate-limit
 * headers + endpoint + caller. This page aggregates today's consumption:
 * daily bar, hourly trend, top endpoints, top callers, projection to 80%.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Gauge, Clock, TrendingUp } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip as RTooltip, CartesianGrid } from 'recharts';

interface UsageRow {
  id: number;
  observed_at: string;
  session_date: string;
  endpoint: string;
  daily_count: number | null;
  daily_limit: number | null;
  minute_counter: number | null;
  minute_remaining: number | null;
  minute_reset_at: string | null;
  status: number | null;
  ms: number | null;
  caller: string | null;
}

function tierClass(pct: number): string {
  if (pct >= 95) return 'text-red-400 bg-red-600/10';
  if (pct >= 85) return 'text-orange-300 bg-orange-500/10';
  if (pct >= 70) return 'text-yellow-300 bg-yellow-500/10';
  if (pct >= 40) return 'text-emerald-300 bg-emerald-500/5';
  return 'text-emerald-400 bg-emerald-500/5';
}

function tierLabel(pct: number): string {
  if (pct >= 95) return 'EXHAUST';
  if (pct >= 85) return 'HOT';
  if (pct >= 70) return 'WARM';
  if (pct >= 40) return 'OK';
  return 'COOL';
}

export default function Budget() {
  // Today's session in NY, and all rows since midnight ET
  const todayET = useMemo(() => {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  }, []);

  const { data: rows, isLoading } = useQuery<UsageRow[]>({
    queryKey: ['ct_uw_usage_today', todayET],
    refetchInterval: 15_000,
    queryFn: async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error } = await (supabase.from('ct_uw_usage' as never) as any)
        .select('id,observed_at,session_date,endpoint,daily_count,daily_limit,minute_counter,minute_remaining,minute_reset_at,status,ms,caller')
        .eq('session_date', todayET)
        .order('observed_at', { ascending: false })
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as UsageRow[];
    },
  });

  const latest = rows?.[0] ?? null;

  // Latest known daily + limit (pick the most recent non-null)
  const { dailyCount, dailyLimit, pct } = useMemo(() => {
    if (!rows || rows.length === 0) return { dailyCount: 0, dailyLimit: 0, pct: 0 };
    let dc = 0, dl = 0;
    for (const r of rows) {
      if (r.daily_count != null && r.daily_limit != null && r.daily_limit > 0) {
        dc = r.daily_count;
        dl = r.daily_limit;
        break;
      }
    }
    const p = dl > 0 ? Math.round((dc / dl) * 1000) / 10 : 0;
    return { dailyCount: dc, dailyLimit: dl, pct: p };
  }, [rows]);

  // Hourly series — count rows per hour, track running daily_count max per hour
  const hourly = useMemo(() => {
    if (!rows) return [];
    const buckets = new Map<string, { hour: string; calls: number; maxDaily: number }>();
    for (const r of rows) {
      const d = new Date(r.observed_at);
      const hr = d.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
      const key = hr.slice(0, 2);
      const cur = buckets.get(key) ?? { hour: key, calls: 0, maxDaily: 0 };
      cur.calls++;
      if (r.daily_count != null && r.daily_count > cur.maxDaily) cur.maxDaily = r.daily_count;
      buckets.set(key, cur);
    }
    return Array.from(buckets.values()).sort((a, b) => a.hour.localeCompare(b.hour));
  }, [rows]);

  // Top endpoints
  const topEndpoints = useMemo(() => {
    if (!rows) return [];
    const agg = new Map<string, { endpoint: string; calls: number; err: number; totalMs: number }>();
    for (const r of rows) {
      const cur = agg.get(r.endpoint) ?? { endpoint: r.endpoint, calls: 0, err: 0, totalMs: 0 };
      cur.calls++;
      if (r.status && r.status >= 400) cur.err++;
      cur.totalMs += r.ms ?? 0;
      agg.set(r.endpoint, cur);
    }
    return Array.from(agg.values())
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 12)
      .map((x) => ({ ...x, avgMs: x.calls > 0 ? Math.round(x.totalMs / x.calls) : 0 }));
  }, [rows]);

  // Top callers
  const topCallers = useMemo(() => {
    if (!rows) return [];
    const agg = new Map<string, { caller: string; calls: number }>();
    for (const r of rows) {
      const k = r.caller ?? '(unattributed)';
      const cur = agg.get(k) ?? { caller: k, calls: 0 };
      cur.calls++;
      agg.set(k, cur);
    }
    return Array.from(agg.values()).sort((a, b) => b.calls - a.calls).slice(0, 10);
  }, [rows]);

  // Projection: if daily_count grew from first to latest sample, linear-project to 80%
  const projection = useMemo(() => {
    if (!rows || rows.length < 2 || dailyLimit === 0) return null;
    const withDaily = rows.filter((r) => r.daily_count != null);
    if (withDaily.length < 2) return null;
    // rows are desc, so last entry = earliest sample today
    const latestS = withDaily[0];
    const firstS = withDaily[withDaily.length - 1];
    const dt = Date.parse(latestS.observed_at) - Date.parse(firstS.observed_at);
    const dCount = (latestS.daily_count ?? 0) - (firstS.daily_count ?? 0);
    if (dt <= 0 || dCount <= 0) return null;
    const rate = dCount / dt; // calls per ms
    const remainingTo80 = 0.80 * dailyLimit - (latestS.daily_count ?? 0);
    if (remainingTo80 <= 0) return { reached80: true, eta: null };
    const msTo80 = remainingTo80 / rate;
    const eta = new Date(Date.now() + msTo80);
    return {
      reached80: false,
      eta: eta.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: true }),
      ratePerHour: Math.round(rate * 3_600_000),
    };
  }, [rows, dailyLimit]);

  const barPct = Math.min(100, pct);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1400px] mx-auto p-4 space-y-4">
        <header>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Gauge className="w-5 h-5 text-primary" />
            <span>UW Budget</span>
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Today's usage against the {dailyLimit > 0 ? dailyLimit.toLocaleString() : '—'} daily cap. Session: {todayET}.
          </p>
        </header>

        {/* Daily bar hero */}
        <Card className="p-6">
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <div className="text-4xl font-bold tabular-nums">
                {dailyCount.toLocaleString()} <span className="text-lg text-muted-foreground font-normal">/ {dailyLimit.toLocaleString() || '—'}</span>
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {rows?.length ?? 0} rate-limited responses today
              </div>
            </div>
            <div className={cn('px-3 py-1.5 rounded text-sm font-mono font-semibold flex items-center gap-2', tierClass(pct))}>
              <span>{pct.toFixed(1)}%</span>
              <span className="uppercase text-[10px] tracking-wider">{tierLabel(pct)}</span>
            </div>
          </div>
          <div className="h-3 rounded-full bg-muted/40 overflow-hidden">
            <div
              className={cn(
                'h-full transition-all',
                pct >= 95 ? 'bg-red-400' : pct >= 85 ? 'bg-orange-400' : pct >= 70 ? 'bg-yellow-400' : 'bg-emerald-400',
              )}
              style={{ width: `${barPct}%` }}
            />
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4 text-xs">
            <div>
              <div className="text-muted-foreground mb-0.5">Minute remaining</div>
              <div className="font-mono tabular-nums">
                {latest?.minute_remaining ?? '—'} <span className="text-muted-foreground">req/min</span>
              </div>
            </div>
            <div>
              <div className="text-muted-foreground mb-0.5">Minute counter</div>
              <div className="font-mono tabular-nums">{latest?.minute_counter ?? '—'}</div>
            </div>
            <div>
              <div className="text-muted-foreground mb-0.5 flex items-center gap-1">
                <Clock className="w-3 h-3" /> Minute reset
              </div>
              <div className="font-mono tabular-nums text-[11px]">
                {latest?.minute_reset_at ? new Date(latest.minute_reset_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground mb-0.5 flex items-center gap-1">
                <TrendingUp className="w-3 h-3" /> Proj. 80%
              </div>
              <div className="font-mono tabular-nums text-[11px]">
                {projection?.reached80 ? <span className="text-orange-300">already ≥80%</span>
                  : projection?.eta
                    ? <>{projection.eta} <span className="text-muted-foreground">({projection.ratePerHour}/hr)</span></>
                    : '—'}
              </div>
            </div>
          </div>
        </Card>

        {/* Hourly trend */}
        <Card className="p-4">
          <div className="text-sm font-semibold mb-2">Hourly trace today</div>
          <div className="h-48">
            {hourly.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourly}>
                  <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                  <XAxis dataKey="hour" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <RTooltip
                    contentStyle={{ background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', fontSize: '11px' }}
                    formatter={(v: number) => v.toLocaleString()}
                  />
                  <Area type="monotone" dataKey="calls" stroke="#10b981" fill="#10b98133" name="calls/hr" />
                  <Area type="monotone" dataKey="maxDaily" stroke="#f59e0b" fill="#f59e0b22" name="running total" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                No UW responses recorded yet today.
              </div>
            )}
          </div>
        </Card>

        {/* Two columns: endpoints + callers */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card className="p-4">
            <div className="text-sm font-semibold mb-3">Top endpoints today</div>
            {topEndpoints.length === 0 ? (
              <div className="text-xs text-muted-foreground py-4">No data.</div>
            ) : (
              <div className="space-y-1.5">
                {topEndpoints.map((e) => {
                  const maxCalls = topEndpoints[0].calls;
                  const w = maxCalls > 0 ? (e.calls / maxCalls) * 100 : 0;
                  return (
                    <div key={e.endpoint} className="space-y-0.5">
                      <div className="flex items-baseline justify-between text-[11px]">
                        <span className="font-mono text-foreground/80 truncate max-w-[60%]">{e.endpoint}</span>
                        <span className="tabular-nums text-muted-foreground">
                          {e.calls} · {e.avgMs}ms
                          {e.err > 0 && <span className="text-red-400 ml-1">· {e.err} err</span>}
                        </span>
                      </div>
                      <div className="h-1 rounded-full bg-muted/40 overflow-hidden">
                        <div className="h-full bg-primary/60" style={{ width: `${w}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="p-4">
            <div className="text-sm font-semibold mb-3">Top callers today</div>
            {topCallers.length === 0 ? (
              <div className="text-xs text-muted-foreground py-4">No data.</div>
            ) : (
              <div className="space-y-1.5">
                {topCallers.map((c) => {
                  const maxCalls = topCallers[0].calls;
                  const w = maxCalls > 0 ? (c.calls / maxCalls) * 100 : 0;
                  return (
                    <div key={c.caller} className="space-y-0.5">
                      <div className="flex items-baseline justify-between text-[11px]">
                        <span className={cn('font-mono truncate max-w-[60%]', c.caller === '(unattributed)' ? 'text-muted-foreground italic' : 'text-foreground/80')}>{c.caller}</span>
                        <span className="tabular-nums text-muted-foreground">{c.calls}</span>
                      </div>
                      <div className="h-1 rounded-full bg-muted/40 overflow-hidden">
                        <div className="h-full bg-amber-400/60" style={{ width: `${w}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        {isLoading && (
          <Card className="p-4 text-xs text-muted-foreground text-center">Loading usage rows…</Card>
        )}

        <div className="text-[10px] text-muted-foreground leading-relaxed">
          UW sends rate-limit headers on most REST responses. Non-critical crons call <code>ct_uw_budget_ok()</code> before firing; at ≥95% daily OR &lt;10 minute-remaining they bail. Unattributed rows = callers that haven't been tagged with <code>setUwCaller()</code> yet.
        </div>
      </div>
    </div>
  );
}
