/**
 * Health — Co-Trader system health dashboard.
 *
 * Read-only visibility into:
 *   - ct_* cron status (green/red/grey by last_run_status)
 *   - UW API usage (today's count/limit + 7-day mini trend)
 *   - Claude cost (ct_claude_usage — per-function breakdown + 7-day rolling)
 *   - Attention score histogram (last 24h, 10-pt buckets)
 *   - Last 20 MCP calls
 *   - Paper book snapshot (starting / current / today's realized / open count)
 *
 * No mutations. No action buttons. Just the truth.
 *
 * Per-function Claude cost: every ct-* function that calls Claude now writes
 * to ct_claude_usage via the shared logClaudeUsage() helper — watcher,
 * curiosity, morning-brief, midday-recap, eod-recap, replay, news-ingester,
 * lessons-curator, and chat all appear side-by-side in the Claude Cost card.
 */
import { ChartSafe } from '@/components/ChartSafe';
import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Bug } from 'lucide-react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  CircleSlash,
  Clock,
  Database,
  DollarSign,
  Gauge,
  Shield,
  Timer,
  Wallet,
  XCircle,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
  useHealthData,
  type AttentionBucket,
  type ClaudeUsageBySource,
  type ClaudeUsageDailyTotal,
  type HealthCronRow,
  type McpCallRow,
  type UwUsageDaily,
} from '@/hooks/useHealthData';
import {
  useWatcherObservability,
  type AlertDiversity,
  type DemotionDailyRow,
  type DiversityDailyRow,
} from '@/hooks/useWatcherObservability';

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

const GREEN = '#00C853';
const RED = '#FF1744';
const TEAL = '#00E6B4';
const AMBER = '#F59E0B';

function fmtUsd(n: number | null | undefined, signed = false, digits = 2): string {
  if (n == null) return '—';
  const v = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  if (!signed) return `$${v}`;
  return n >= 0 ? `+$${v}` : `-$${v}`;
}

function fmtInt(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const d = Date.now() - Date.parse(iso);
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function fmtDuration(interval: string | null): string {
  if (!interval) return '—';
  const match = interval.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (match) {
    const [, h, m, s] = match;
    if (h !== '00') return `${parseInt(h)}h ${parseInt(m)}m`;
    if (m !== '00') return `${parseInt(m)}m ${Math.floor(parseFloat(s))}s`;
    return `${parseFloat(s).toFixed(1)}s`;
  }
  return interval;
}

function prettyCron(schedule: string): string {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const [min, hour] = parts;
  const every = min.match(/^\*\/(\d+)$/);
  if (every && hour === '*') return `every ${every[1]}m`;
  if (/^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const h = parseInt(hour);
    const m = parseInt(min);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${h12}:${m.toString().padStart(2, '0')} ${ampm} UTC`;
  }
  return schedule;
}

function parseTarget(command: string): string {
  const edgeFnMatch = command.match(/invoke_edge_function\s*\(\s*'([^']+)'/);
  if (edgeFnMatch) return edgeFnMatch[1];
  const httpMatch = command.match(/functions\/v1\/([a-z0-9-]+)/);
  if (httpMatch) return httpMatch[1];
  return command.slice(0, 40) + (command.length > 40 ? '…' : '');
}

// ---------------------------------------------------------------------------
// UW tier (mirrors UwUsageBadge so labels stay consistent)
// ---------------------------------------------------------------------------

function uwTier(pct: number | null | undefined): { label: string; fg: string } {
  const p = pct ?? 0;
  if (p >= 95) return { label: 'EXHAUST', fg: 'text-red-400' };
  if (p >= 85) return { label: 'HOT', fg: 'text-orange-300' };
  if (p >= 70) return { label: 'WARM', fg: 'text-yellow-300' };
  if (p >= 40) return { label: 'OK', fg: 'text-emerald-300' };
  return { label: 'COOL', fg: 'text-emerald-400/80' };
}

// ---------------------------------------------------------------------------
// Cron status icon + color
// ---------------------------------------------------------------------------

function CronStatusCell({ job }: { job: HealthCronRow }) {
  if (!job.last_run_at || !job.last_run_status) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <CircleSlash className="w-3.5 h-3.5" />
        <span className="text-[11px]">never ran</span>
      </span>
    );
  }
  if (job.last_run_status === 'succeeded') {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-400">
        <CheckCircle2 className="w-3.5 h-3.5" />
        <span className="text-[11px]">succeeded</span>
      </span>
    );
  }
  if (job.last_run_status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-red-400">
        <XCircle className="w-3.5 h-3.5" />
        <span className="text-[11px]">failed</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
      <Clock className="w-3.5 h-3.5" />
      <span className="text-[11px]">{job.last_run_status}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Section: Crons
// ---------------------------------------------------------------------------

function CronsSection({ crons }: { crons: HealthCronRow[] }) {
  const counts = useMemo(() => {
    let ok = 0, fail = 0, never = 0;
    for (const c of crons) {
      if (!c.last_run_at) never++;
      else if (c.last_run_status === 'succeeded') ok++;
      else if (c.last_run_status === 'failed') fail++;
    }
    return { ok, fail, never };
  }, [crons]);

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <Timer className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Co-Trader Crons</span>
        <span className="text-[11px] text-muted-foreground ml-2">
          {crons.length} job{crons.length === 1 ? '' : 's'}
        </span>
        <div className="ml-auto flex items-center gap-3 text-[11px]">
          <span className="text-emerald-400 tabular-nums">{counts.ok} ok</span>
          <span className="text-red-400 tabular-nums">{counts.fail} failed</span>
          <span className="text-muted-foreground tabular-nums">{counts.never} never</span>
        </div>
      </div>
      {crons.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">
          No ct-* cron jobs found. Either none configured or get_cron_status RPC is missing.
        </div>
      ) : (
        <div className="max-h-[420px] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider">Job</TableHead>
                <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider">Schedule</TableHead>
                <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider">Last Run</TableHead>
                <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider">Status</TableHead>
                <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider">Duration</TableHead>
                <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider text-right">Active</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crons.map((job) => (
                <TableRow key={job.jobid} className={cn(!job.active && 'opacity-50')}>
                  <TableCell className="py-2">
                    <div className="text-xs font-medium truncate max-w-[260px]">{job.jobname}</div>
                    <div className="text-[10px] text-muted-foreground truncate max-w-[260px]">
                      {parseTarget(job.command)}
                    </div>
                  </TableCell>
                  <TableCell className="py-2">
                    <div className="text-[11px]">{prettyCron(job.schedule)}</div>
                    <div className="text-[9px] text-muted-foreground font-mono">{job.schedule}</div>
                  </TableCell>
                  <TableCell className="py-2 text-[11px]">{timeAgo(job.last_run_at)}</TableCell>
                  <TableCell className="py-2"><CronStatusCell job={job} /></TableCell>
                  <TableCell className="py-2 text-[11px] font-mono text-muted-foreground">
                    {fmtDuration(job.last_run_duration)}
                  </TableCell>
                  <TableCell className="py-2 text-right">
                    <span className={cn(
                      'inline-block w-2 h-2 rounded-full',
                      job.active ? 'bg-emerald-400' : 'bg-muted',
                    )} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: UW API
// ---------------------------------------------------------------------------

function UwSection({
  latest,
  daily,
}: {
  latest: ReturnType<typeof useHealthData>['data'] extends infer T
    ? T extends { uwLatest: infer U } ? U : never : never;
  daily: UwUsageDaily[];
}) {
  const tier = uwTier(latest?.pct);
  const pct = latest?.pct ?? 0;
  const barPct = Math.min(100, Math.max(0, pct));

  const chartData = daily.map((d) => ({
    date: d.session_date.slice(5), // MM-DD
    count: d.daily_count ?? 0,
  }));

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <Gauge className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">UW API Usage</span>
        {latest && (
          <span className="text-[11px] text-muted-foreground ml-2">
            updated {timeAgo(latest.observed_at)}
          </span>
        )}
        {latest && (
          <span className={cn('ml-auto text-[11px] font-semibold uppercase tracking-wider', tier.fg)}>
            {tier.label}
          </span>
        )}
      </div>
      <div className="p-4 space-y-4">
        {!latest ? (
          <div className="text-xs text-muted-foreground">No UW usage data yet.</div>
        ) : (
          <>
            <div className="flex items-baseline gap-3">
              <div className="text-3xl font-bold tabular-nums">{fmtInt(latest.daily_count)}</div>
              <div className="text-sm text-muted-foreground tabular-nums">
                / {fmtInt(latest.daily_limit)} today
              </div>
              <div className={cn('ml-auto text-lg font-semibold tabular-nums', tier.fg)}>{pct}%</div>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn('h-full', tier.fg.replace('text-', 'bg-'))}
                style={{ width: `${barPct}%` }}
              />
            </div>
          </>
        )}

        <div>
          <div className="text-[11px] text-muted-foreground mb-1">Last 7 days (count per day)</div>
          {chartData.length === 0 ? (
            <div className="h-[80px] flex items-center justify-center text-[11px] text-muted-foreground">
              no history yet
            </div>
          ) : (
            <div className="h-[80px]">
              <ChartSafe><ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 9 }}
                    stroke="hsl(var(--muted-foreground))"
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis hide />
                  <Tooltip
                    contentStyle={{ fontSize: 11, padding: '4px 8px' }}
                    labelStyle={{ fontSize: 10 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="count"
                    stroke={TEAL}
                    strokeWidth={2}
                    dot={{ r: 2, fill: TEAL }}
                  />
                </LineChart>
              </ResponsiveContainer></ChartSafe>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: Claude cost
// ---------------------------------------------------------------------------

function ClaudeCostSection({
  todayTotal,
  todayBySource,
  daily,
}: {
  todayTotal: ClaudeUsageDailyTotal | null;
  todayBySource: ClaudeUsageBySource[];
  daily: ClaudeUsageDailyTotal[];
}) {
  const chartData = daily.map((d) => ({
    date: d.session_date.slice(5),
    cost: Number(d.cost_usd ?? 0),
    turns: d.turns ?? 0,
  }));

  const total7d = daily.reduce((acc, d) => acc + Number(d.cost_usd ?? 0), 0);

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <DollarSign className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Claude Cost</span>
        <span className="text-[11px] text-muted-foreground ml-2">ct_claude_usage · per function</span>
      </div>
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Today</div>
            <div className="text-2xl font-bold tabular-nums">{fmtUsd(todayTotal?.cost_usd ?? 0, false, 3)}</div>
            <div className="text-[10px] text-muted-foreground">
              {todayTotal ? `${fmtInt(todayTotal.turns)} turns · ${fmtInt((todayTotal.tokens_in ?? 0) + (todayTotal.tokens_out ?? 0))} tok` : 'no calls yet'}
            </div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">7-day total</div>
            <div className="text-2xl font-bold tabular-nums">{fmtUsd(total7d, false, 3)}</div>
            <div className="text-[10px] text-muted-foreground">{daily.length} day{daily.length === 1 ? '' : 's'} with activity</div>
          </div>
          <div>
            <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Avg latency today</div>
            <div className="text-2xl font-bold tabular-nums">
              {todayTotal?.avg_ms ? `${(todayTotal.avg_ms / 1000).toFixed(1)}s` : '—'}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {todayTotal ? `${fmtInt(todayTotal.mcp_calls)} MCP calls` : '—'}
            </div>
          </div>
        </div>

        {/* Per-function breakdown — the v2 gap closed. */}
        <div>
          <div className="text-[11px] text-muted-foreground mb-1">Per function today</div>
          {todayBySource.length === 0 ? (
            <div className="h-[80px] flex items-center justify-center text-[11px] text-muted-foreground">
              no Claude calls logged today yet
            </div>
          ) : (
            <div className="rounded border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="h-7 py-1 text-[10px] uppercase tracking-wider">Function</TableHead>
                    <TableHead className="h-7 py-1 text-[10px] uppercase tracking-wider text-right">Turns</TableHead>
                    <TableHead className="h-7 py-1 text-[10px] uppercase tracking-wider text-right">Tokens</TableHead>
                    <TableHead className="h-7 py-1 text-[10px] uppercase tracking-wider text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {todayBySource.map((r) => (
                    <TableRow key={r.source}>
                      <TableCell className="py-1.5 text-[11px] font-mono">{r.source}</TableCell>
                      <TableCell className="py-1.5 text-[11px] text-right tabular-nums">{fmtInt(r.turns)}</TableCell>
                      <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
                        {fmtInt((r.tokens_in ?? 0) + (r.tokens_out ?? 0))}
                      </TableCell>
                      <TableCell className="py-1.5 text-[11px] text-right tabular-nums font-medium">
                        {fmtUsd(r.cost_usd, false, 4)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {todayTotal && (
                    <TableRow className="bg-muted/40 font-semibold">
                      <TableCell className="py-1.5 text-[11px] font-mono">total</TableCell>
                      <TableCell className="py-1.5 text-[11px] text-right tabular-nums">{fmtInt(todayTotal.turns)}</TableCell>
                      <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                        {fmtInt((todayTotal.tokens_in ?? 0) + (todayTotal.tokens_out ?? 0))}
                      </TableCell>
                      <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                        {fmtUsd(todayTotal.cost_usd, false, 4)}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        <div>
          <div className="text-[11px] text-muted-foreground mb-1">Cost per day (7d rolling)</div>
          {chartData.length === 0 ? (
            <div className="h-[100px] flex items-center justify-center text-[11px] text-muted-foreground">
              no Claude cost history yet
            </div>
          ) : (
            <div className="h-[100px]">
              <ChartSafe><ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 9 }}
                    stroke="hsl(var(--muted-foreground))"
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 9 }}
                    stroke="hsl(var(--muted-foreground))"
                    axisLine={false}
                    tickLine={false}
                    width={28}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 11, padding: '4px 8px' }}
                    labelStyle={{ fontSize: 10 }}
                    formatter={(value: number) => fmtUsd(value, false, 3)}
                  />
                  <Bar dataKey="cost" fill={TEAL} radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer></ChartSafe>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: Attention histogram
// ---------------------------------------------------------------------------

function AttentionSection({ buckets, total }: { buckets: AttentionBucket[]; total: number }) {
  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <Activity className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Attention Distribution</span>
        <span className="text-[11px] text-muted-foreground ml-2">last 24h</span>
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
          {fmtInt(total)} events
        </span>
      </div>
      <div className="p-4">
        {total === 0 ? (
          <div className="h-[160px] flex items-center justify-center text-xs text-muted-foreground">
            No attention_score events in the last 24 hours.
          </div>
        ) : (
          <div className="h-[180px]">
            <ChartSafe><ResponsiveContainer width="100%" height="100%">
              <BarChart data={buckets} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tick={{ fontSize: 9 }}
                  stroke="hsl(var(--muted-foreground))"
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 9 }}
                  stroke="hsl(var(--muted-foreground))"
                  axisLine={false}
                  tickLine={false}
                  width={28}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{ fontSize: 11, padding: '4px 8px' }}
                  labelStyle={{ fontSize: 10 }}
                />
                <Bar
                  dataKey="count"
                  radius={[2, 2, 0, 0]}
                  // Color ramps from teal → amber → red as attention climbs.
                  // High-attention buckets firing a lot = over-firing warning.
                  fill={TEAL}
                />
              </BarChart>
            </ResponsiveContainer></ChartSafe>
          </div>
        )}
        <div className="mt-2 text-[10px] text-muted-foreground">
          Watch the 80-100 buckets — if they&apos;re stacked, the engine is over-firing high-attention events.
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: MCP calls
// ---------------------------------------------------------------------------

function McpCallsSection({ calls }: { calls: McpCallRow[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <Database className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">MCP Call Log</span>
        <span className="text-[11px] text-muted-foreground ml-2">last 20</span>
      </div>
      {calls.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">No MCP calls yet.</div>
      ) : (
        <div className="divide-y divide-border max-h-[320px] overflow-y-auto">
          {calls.map((c) => (
            <div
              key={c.id}
              className={cn(
                'px-3 py-2 flex items-center gap-2 text-[11px]',
                c.is_error && 'bg-red-500/5',
              )}
            >
              {c.is_error ? (
                <XCircle className="w-3 h-3 text-red-400 shrink-0" />
              ) : (
                <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
              )}
              <span className="font-mono font-medium truncate max-w-[180px]">
                {c.tool_name ?? 'unknown'}
              </span>
              <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono shrink-0">
                {c.source}
              </Badge>
              {c.server_name && (
                <span className="text-muted-foreground text-[10px] truncate">{c.server_name}</span>
              )}
              <span className="ml-auto text-muted-foreground text-[10px] shrink-0">
                {timeAgo(c.created_at)}
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: Book snapshot
// ---------------------------------------------------------------------------

function BookSection({
  book,
}: {
  book: ReturnType<typeof useHealthData>['data'] extends infer T
    ? T extends { book: infer B } ? B : never : never;
}) {
  const pnl = book?.realized_pnl_today ?? null;
  const pnlColor = pnl == null || pnl === 0 ? undefined : pnl > 0 ? GREEN : RED;

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <Wallet className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Book Snapshot</span>
        {book?.session_date ? (
          <span className="text-[11px] text-muted-foreground ml-2">{book.session_date}</span>
        ) : (
          <span className="text-[11px] text-muted-foreground ml-2">no session today</span>
        )}
      </div>
      <div className="p-4 grid grid-cols-4 gap-4">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Starting</div>
          <div className="text-xl font-bold tabular-nums">{fmtUsd(book?.starting_balance)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Current Equity</div>
          <div className="text-xl font-bold tabular-nums">{fmtUsd(book?.current_equity)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Realized Today</div>
          <div className="text-xl font-bold tabular-nums" style={{ color: pnlColor }}>
            {fmtUsd(pnl, true)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Open Positions</div>
          <div className="text-xl font-bold tabular-nums">{fmtInt(book?.open_positions ?? 0)}</div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Section: Watcher v1.2 Observability
// ---------------------------------------------------------------------------

function fmtDiversity(v: number | null): string {
  if (v == null) return '—';
  return v.toFixed(2);
}

function fmtPct(v: number): string {
  return `${v.toFixed(0)}%`;
}

function fmtAxes(axes: string[]): string {
  if (!axes || axes.length === 0) return '—';
  return axes.join(', ');
}

function diversityColor(v: number | null): string {
  if (v == null) return 'text-muted-foreground';
  if (v >= 0.5) return 'text-emerald-400';
  if (v < 0.3) return 'text-red-400';
  return 'text-yellow-300';
}

function DiversityTable({ daily }: { daily: DiversityDailyRow[] }) {
  // Show newest 14 days on top.
  const rows = daily.slice().sort((a, b) => b.date.localeCompare(a.date));
  if (rows.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-muted-foreground">
        No v1.1+ alerts in the last 14 days.
      </div>
    );
  }
  return (
    <div className="max-h-[260px] overflow-y-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider">Date</TableHead>
            <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider text-right">Alerts</TableHead>
            <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider text-right">Scored</TableHead>
            <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider text-right">Median Div</TableHead>
            <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider text-right">% &gt; 0.5</TableHead>
            <TableHead className="h-8 py-1 text-[10px] uppercase tracking-wider text-right">% &lt; 0.3</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.date}>
              <TableCell className="py-2 text-[11px] font-mono">{r.date}</TableCell>
              <TableCell className="py-2 text-[11px] tabular-nums text-right">{fmtInt(r.alerts)}</TableCell>
              <TableCell className="py-2 text-[11px] tabular-nums text-right text-muted-foreground">
                {fmtInt(r.scored)}
              </TableCell>
              <TableCell className={cn('py-2 text-[11px] tabular-nums text-right', diversityColor(r.median))}>
                {fmtDiversity(r.median)}
              </TableCell>
              <TableCell className="py-2 text-[11px] tabular-nums text-right text-emerald-400">
                {r.scored === 0 ? '—' : fmtPct(r.pct_good)}
              </TableCell>
              <TableCell className="py-2 text-[11px] tabular-nums text-right text-red-400">
                {r.scored === 0 ? '—' : fmtPct(r.pct_echo)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function DemotionChart({ rows, totals }: {
  rows: DemotionDailyRow[];
  totals: { demotions: number; alerts: number; rate: number };
}) {
  const chartData = rows.map((r) => ({
    date: r.date.slice(5), // MM-DD
    demotions: r.demotions,
    alerts: r.alerts,
  }));

  const hasData = rows.some((r) => r.demotions > 0 || r.alerts > 0);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Demotions (14d)</div>
          <div className="text-xl font-bold tabular-nums text-amber-300">
            {fmtInt(totals.demotions)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Alerts Fired (14d)</div>
          <div className="text-xl font-bold tabular-nums">{fmtInt(totals.alerts)}</div>
        </div>
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wider">Demotion Rate</div>
          <div className="text-xl font-bold tabular-nums text-amber-300">
            {fmtPct(totals.rate)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {totals.demotions} / ({totals.demotions} + {totals.alerts})
          </div>
        </div>
      </div>
      {!hasData ? (
        <div className="h-[140px] flex items-center justify-center text-[11px] text-muted-foreground">
          No alert or demotion activity in the last 14 days.
        </div>
      ) : (
        <div className="h-[140px]">
          <ChartSafe><ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 9 }}
                stroke="hsl(var(--muted-foreground))"
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 9 }}
                stroke="hsl(var(--muted-foreground))"
                axisLine={false}
                tickLine={false}
                width={28}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{ fontSize: 11, padding: '4px 8px' }}
                labelStyle={{ fontSize: 10 }}
              />
              <Line
                type="monotone"
                dataKey="demotions"
                name="demotions"
                stroke={AMBER}
                strokeWidth={2}
                dot={{ r: 2, fill: AMBER }}
              />
              <Line
                type="monotone"
                dataKey="alerts"
                name="alerts"
                stroke={TEAL}
                strokeWidth={2}
                dot={{ r: 2, fill: TEAL }}
              />
            </LineChart>
          </ResponsiveContainer></ChartSafe>
        </div>
      )}
      <div className="text-[10px] text-muted-foreground flex items-start gap-1.5">
        <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
        <span>
          Demotions come from <span className="font-mono">ct_heartbeats.status_line</span> matches
          for <span className="font-mono">ALERT demoted to (FLAG|OBSERVATION) … cooldown</span>.
        </span>
      </div>
    </div>
  );
}

function EchoCandidatesList({ rows }: { rows: AlertDiversity[] }) {
  if (rows.length === 0) {
    return (
      <div className="p-4 text-center text-xs text-muted-foreground">
        No low-diversity alerts in the last 7 days. The gate is holding.
      </div>
    );
  }
  return (
    <div className="divide-y divide-border max-h-[320px] overflow-y-auto">
      {rows.map((r) => (
        <div key={r.id} className="px-3 py-2 space-y-1">
          <div className="flex items-center gap-2 text-[11px]">
            <span className={cn('font-mono tabular-nums font-semibold', diversityColor(r.diversity))}>
              {fmtDiversity(r.diversity)}
            </span>
            <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono">
              {r.direction}
            </Badge>
            <span className="font-mono text-[10px] truncate max-w-[180px]">
              {(r.instruments ?? []).join(', ') || '—'}
            </span>
            <span className="ml-auto text-muted-foreground text-[10px] shrink-0">
              {timeAgo(r.created_at)}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground pl-0.5">
            <span className="font-mono">axes:</span> {fmtAxes(r.axes)}
            {r.prior_axes && r.prior_axes.length > 0 && (
              <>
                <span className="mx-1">·</span>
                <span className="font-mono">prior:</span> {fmtAxes(r.prior_axes)}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function WatcherObservabilitySection() {
  const { data, isLoading, error } = useWatcherObservability();

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <Shield className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Watcher v1.2 Observability</span>
        <span className="text-[11px] text-muted-foreground ml-2">
          evidence diversity + cooldown demotion
        </span>
        {data && (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {fmtInt(data.totals.alerts)} alert{data.totals.alerts === 1 ? '' : 's'} · {fmtInt(data.totals.demotions)} demo
          </span>
        )}
      </div>
      {error && (
        <div className="p-4 text-xs text-red-400 flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5" />
          Failed to load watcher observability: {(error as Error).message}
        </div>
      )}
      {isLoading && !data ? (
        <div className="p-6 text-center text-xs text-muted-foreground">
          Scoring alert diversity…
        </div>
      ) : data ? (
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Evidence Diversity by Day
              </div>
              <DiversityTable daily={data.daily} />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Cooldown Demotions vs Alerts (14d)
              </div>
              <DemotionChart rows={data.demotions} totals={data.totals} />
            </div>
          </div>
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Recent Echo-Chamber Candidates (last 7d, diversity &lt; 0.3)
            </div>
            <EchoCandidatesList rows={data.echoCandidates} />
          </div>
          <div className="text-[10px] text-muted-foreground border-t pt-2 flex items-start gap-1.5">
            <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" />
            <span>
              Diversity = 1 − |prev ∩ curr| / min(3, |curr|) against the most-recent prior ALERT on
              the same instrument set within 60min. Rows with empty <span className="font-mono">evidence_axes</span> (pre-v1.2) are not scored.
            </span>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Section: Recent UI crashes (ct_ui_errors)
// ---------------------------------------------------------------------------

interface UiErrorRow {
  id: string;
  created_at: string;
  route: string;
  error_name: string | null;
  error_message: string | null;
  resolved: boolean;
}

function useUiErrors() {
  return useQuery<UiErrorRow[]>({
    queryKey: ['ct_ui_errors_recent'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .from('ct_ui_errors' as any)
        .select('id, created_at, route, error_name, error_message, resolved')
        .eq('resolved', false)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as unknown as UiErrorRow[];
    },
  });
}

function UiErrorsSection() {
  const { data: rows, isLoading } = useUiErrors();
  const qc = useQueryClient();

  const resolve = async (id: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from('ct_ui_errors' as any) as any)
      .update({ resolved: true })
      .eq('id', id);
    if (error) {
      console.warn('[Health] resolve ct_ui_errors failed:', error);
      return;
    }
    qc.invalidateQueries({ queryKey: ['ct_ui_errors_recent'] });
    qc.invalidateQueries({ queryKey: ['ct_ui_errors_unresolved_24h'] });
  };

  return (
    <Card className="overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/30 flex items-center gap-2">
        <Bug className="w-4 h-4 text-primary" />
        <span className="text-sm font-semibold">Recent UI crashes</span>
        <span className="text-[11px] text-muted-foreground ml-2">last 10 unresolved</span>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
      ) : !rows || rows.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground">
          No unresolved UI crashes. Nice.
        </div>
      ) : (
        <div className="divide-y divide-border max-h-[320px] overflow-y-auto">
          {rows.map((r) => (
            <div key={r.id} className="px-3 py-2 flex items-center gap-2 text-[11px]">
              <Badge variant="outline" className="text-[9px] px-1 py-0 font-mono shrink-0">
                {r.route}
              </Badge>
              <span className="font-mono text-foreground/70 shrink-0">
                {r.error_name ?? 'Error'}
              </span>
              <span className="text-muted-foreground truncate min-w-0 flex-1">
                {r.error_message ?? '(no message)'}
              </span>
              <span className="text-muted-foreground text-[10px] shrink-0">
                {timeAgo(r.created_at)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={() => resolve(r.id)}
              >
                Resolve
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function Health() {
  const { data, isLoading, error, dataUpdatedAt } = useHealthData();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Activity className="w-5 h-5 text-primary" />
              <span>Health</span>
              <span className="text-sm text-muted-foreground font-normal">system status</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Crons, UW usage, Claude cost, attention, MCP, book — everything at a glance. Refreshes every 60s.
            </p>
          </div>
          {dataUpdatedAt > 0 && (
            <div className="text-[11px] text-muted-foreground tabular-nums">
              updated {timeAgo(new Date(dataUpdatedAt).toISOString())}
            </div>
          )}
        </header>

        {error && (
          <Card className="p-4 border-red-500/40 bg-red-500/5 text-xs text-red-400 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            <span>Failed to load health data: {(error as Error).message}</span>
          </Card>
        )}

        {isLoading && !data ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">Loading system health…</Card>
        ) : data ? (
          <>
            {/* Row 1: Book + UW + Claude cost — top-line metrics */}
            <BookSection book={data.book} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <UwSection latest={data.uwLatest} daily={data.uwDaily} />
              <ClaudeCostSection
                todayTotal={data.claudeTodayTotal}
                todayBySource={data.claudeTodayBySource}
                daily={data.claudeDailyTotals}
              />
            </div>

            {/* Row 2: Attention histogram + MCP calls */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <AttentionSection buckets={data.attentionBuckets} total={data.attentionTotal} />
              <McpCallsSection calls={data.mcpCalls} />
            </div>

            {/* Row 2.5: Recent UI crashes */}
            <UiErrorsSection />

            {/* Row 3: Watcher v1.2 observability — full width */}
            <WatcherObservabilitySection />

            {/* Row 4: Crons table full width */}
            <CronsSection crons={data.crons} />
          </>
        ) : null}
      </div>
    </div>
  );
}
