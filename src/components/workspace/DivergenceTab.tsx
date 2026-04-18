/**
 * DivergenceTab — James vs Claude equity curves on the same x-axis.
 *
 * Two overlay lines indexed to 100 at inception so a $10k James and a $100k
 * Claude book can share a y-axis without one dwarfing the other. Below the
 * chart: three stat blocks — James, Claude, and the divergence ratio.
 *
 * v1 is intentionally thin. If James wants win-rate scatter, correlation by
 * day, or drawdown overlays, that's a follow-up — not scope here.
 */
import { useMemo } from 'react';
import { Card } from '@/components/ui/card';
import {
  LineChart, Line, YAxis, XAxis, ResponsiveContainer, Tooltip, CartesianGrid, Legend,
} from 'recharts';
import { ChartSafe } from '@/components/ChartSafe';
import { finiteDomain } from '@/lib/chartSanitize';
import { Users, TrendingUp, TrendingDown } from 'lucide-react';
import { useClaudeBook, useJamesBook } from '@/hooks/useClaudeBook';
import type { CtBookRow } from '@/hooks/useCoTraderData';

interface DivergencePoint {
  date: string;
  label: string;
  james: number | null;
  claude: number | null;
}

function seedOfFirstSession(history: CtBookRow[]): number | null {
  return history[0]?.starting_balance ?? null;
}

/**
 * Index a book to 100 at the first session's starting balance. Returns a
 * Map<session_date, indexed_balance>.
 */
function indexedByDate(history: CtBookRow[]): Map<string, number> {
  const map = new Map<string, number>();
  const seed = seedOfFirstSession(history);
  if (seed == null || seed === 0) return map;
  for (const b of history) {
    const live = b.starting_balance + (b.realized_pnl ?? 0) + (b.unrealized_pnl ?? 0);
    const balance = b.ending_balance ?? live;
    map.set(b.session_date, (balance / seed) * 100);
  }
  return map;
}

function mergeDates(a: CtBookRow[], b: CtBookRow[]): string[] {
  const set = new Set<string>();
  for (const r of a) set.add(r.session_date);
  for (const r of b) set.add(r.session_date);
  return Array.from(set).sort();
}

function buildPoints(jamesHistory: CtBookRow[], claudeHistory: CtBookRow[]): DivergencePoint[] {
  const jamesIdx = indexedByDate(jamesHistory);
  const claudeIdx = indexedByDate(claudeHistory);
  const dates = mergeDates(jamesHistory, claudeHistory);
  return dates.map(d => {
    const [, mm, dd] = d.split('-');
    return {
      date: d,
      label: `${mm}/${dd}`,
      james: jamesIdx.get(d) ?? null,
      claude: claudeIdx.get(d) ?? null,
    };
  });
}

function currentStats(history: CtBookRow[]) {
  if (history.length === 0) {
    return { current: null as number | null, pct: null as number | null, sessions: 0 };
  }
  const seed = history[0].starting_balance;
  const last = history[history.length - 1];
  const live = last.starting_balance + (last.realized_pnl ?? 0) + (last.unrealized_pnl ?? 0);
  const current = last.ending_balance ?? live;
  const pct = seed > 0 ? ((current - seed) / seed) * 100 : 0;
  return { current, pct, sessions: history.length };
}

function fmtUsd(n: number): string {
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function DivergenceTab() {
  const { data: jamesHistory = [], isLoading: jLoading } = useJamesBook();
  const { data: claudeHistory = [], isLoading: cLoading } = useClaudeBook();

  const points = useMemo(
    () => buildPoints(jamesHistory, claudeHistory),
    [jamesHistory, claudeHistory],
  );

  const jamesStats = useMemo(() => currentStats(jamesHistory), [jamesHistory]);
  const claudeStats = useMemo(() => currentStats(claudeHistory), [claudeHistory]);

  // Divergence ratio: positive = Claude ahead, negative = James ahead.
  const divergencePp = (claudeStats.pct ?? 0) - (jamesStats.pct ?? 0);

  const loading = jLoading || cLoading;

  const allVals = points.flatMap(p => [p.james, p.claude].filter((v): v is number => v != null));
  const yDomain = allVals.length > 0
    ? finiteDomain(Math.min(...allVals), Math.max(...allVals), [95, 105], 1)
    : ([95, 105] as [number, number]);

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
          <Users className="w-3 h-3" /> James vs Claude — equity indexed to 100
          <span className="normal-case tracking-normal text-muted-foreground/70">
            · different seed sizes, same y-axis
          </span>
        </div>
        {loading ? (
          <div className="h-[240px] flex items-center text-xs text-muted-foreground">loading...</div>
        ) : points.length === 0 ? (
          <div className="h-[240px] flex items-center justify-center text-xs text-muted-foreground italic">
            No sessions recorded for either trader yet.
          </div>
        ) : (
          <ChartSafe label="divergence curve">
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={points} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={{ stroke: 'hsl(var(--border))' }}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                    axisLine={{ stroke: 'hsl(var(--border))' }}
                    tickLine={false}
                    domain={yDomain}
                    tickFormatter={(v: number) => v.toFixed(0)}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 11,
                      background: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                    }}
                    formatter={(v: number, name: string) => [v?.toFixed?.(2) ?? '—', name]}
                  />
                  <Legend
                    iconType="line"
                    wrapperStyle={{ fontSize: 10 }}
                  />
                  <Line
                    type="monotone"
                    name="James"
                    dataKey="james"
                    stroke="hsl(var(--primary))"
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    name="Claude"
                    dataKey="claude"
                    stroke="hsl(var(--chart-2, 35 100% 55%))"
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </ChartSafe>
        )}
      </Card>

      {/* Stat blocks */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatBlock
          title="James"
          current={jamesStats.current}
          pct={jamesStats.pct}
          sessions={jamesStats.sessions}
          primary
        />
        <StatBlock
          title="Claude"
          current={claudeStats.current}
          pct={claudeStats.pct}
          sessions={claudeStats.sessions}
        />
        <Card className="p-3">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            {divergencePp >= 0
              ? <TrendingUp className="w-3 h-3 text-green-400" />
              : <TrendingDown className="w-3 h-3 text-red-400" />}
            Divergence
          </div>
          <div className={`text-2xl font-bold ${divergencePp >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {fmtPct(divergencePp)}
          </div>
          <div className="text-[10px] text-muted-foreground">
            Claude{divergencePp >= 0 ? ' ahead of ' : ' behind '}James (pp return delta)
          </div>
        </Card>
      </div>
    </div>
  );
}

function StatBlock({
  title, current, pct, sessions, primary = false,
}: {
  title: string;
  current: number | null;
  pct: number | null;
  sessions: number;
  primary?: boolean;
}) {
  return (
    <Card className="p-3">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
        <span className={primary ? 'text-primary font-semibold' : ''}>{title}</span>
      </div>
      <div className={`text-2xl font-bold ${pct == null ? 'text-muted-foreground' : pct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
        {pct == null ? '—' : fmtPct(pct)}
      </div>
      <div className="text-[10px] text-muted-foreground">
        {current == null ? 'no sessions' : `${fmtUsd(current)} · ${sessions} session${sessions === 1 ? '' : 's'}`}
      </div>
    </Card>
  );
}
