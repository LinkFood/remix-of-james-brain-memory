/**
 * /edge — Signal attribution truth layer.
 *
 * Reads ct_edge_attribution. Every row = one (signal_type, subtype, direction,
 * conviction, horizon) bucket with n, mean alpha vs SPY, hit rate, Sharpe, t-stat.
 * Sort to find edge; re-run the RPC to recompute.
 *
 * Edge = positive mean_alpha_pct with decent n and |t| > ~2. Nothing else counts.
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { Target, RefreshCw, AlertCircle } from 'lucide-react';

interface EdgeRow {
  id: number;
  signal_type: string;
  signal_subtype: string;
  direction: string;
  conviction_bucket: string;
  horizon_mins: number;
  lookback_days: number;
  n: number;
  mean_alpha_pct: number | null;
  median_alpha_pct: number | null;
  stddev_alpha_pct: number | null;
  hit_rate: number | null;
  sharpe: number | null;
  t_stat: number | null;
  mean_return_pct: number | null;
  mean_spy_return_pct: number | null;
  computed_at: string;
}

type SortKey =
  | 'sharpe' | 'mean_alpha_pct' | 'n' | 't_stat'
  | 'hit_rate' | 'horizon_mins' | 'signal_type';

function fmtPct(v: number | null | undefined, digits = 3): string {
  if (v == null) return '—';
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}%`;
}
function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v == null) return '—';
  const s = v >= 0 ? '+' : '';
  return `${s}${v.toFixed(digits)}`;
}
function fmtInt(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toLocaleString();
}
function horizonLabel(m: number): string {
  if (m >= 390) return 'EOD';
  if (m >= 60 && m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

function alphaColor(mean: number | null, tStat: number | null, n: number): string {
  if (mean == null) return '';
  const significant = tStat != null && Math.abs(tStat) >= 2 && n >= 20;
  if (mean > 0 && significant) return 'text-emerald-300 font-semibold';
  if (mean > 0) return 'text-emerald-500/70';
  if (mean < 0 && significant) return 'text-red-300 font-semibold';
  if (mean < 0) return 'text-red-500/60';
  return 'text-muted-foreground';
}

function nColor(n: number): string {
  if (n >= 30) return 'text-foreground';
  if (n >= 10) return 'text-yellow-300';
  return 'text-red-400/70';
}

export default function Edge() {
  const qc = useQueryClient();
  const [lookback, setLookback] = useState<number>(7);
  const [minN, setMinN] = useState<number>(20);
  const [sortKey, setSortKey] = useState<SortKey>('sharpe');
  const [sortAsc, setSortAsc] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  const { data: rows, isLoading, error, dataUpdatedAt } = useQuery<EdgeRow[]>({
    queryKey: ['ct_edge_attribution', lookback],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('ct_edge_attribution' as never)
        .select('*')
        .eq('lookback_days', lookback)
        .order('sharpe', { ascending: false, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as EdgeRow[];
    },
    refetchInterval: 5 * 60_000,
  });

  const filtered = useMemo(() => {
    if (!rows) return [];
    const out = rows.filter((r) => r.n >= minN);
    const k = sortKey;
    out.sort((a, b) => {
      const av = (a[k] as number | string | null) ?? -Infinity;
      const bv = (b[k] as number | string | null) ?? -Infinity;
      if (av === bv) return 0;
      return sortAsc ? (av < bv ? -1 : 1) : (av > bv ? -1 : 1);
    });
    return out;
  }, [rows, minN, sortKey, sortAsc]);

  const stats = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    const positiveAlpha = rows.filter((r) => (r.mean_alpha_pct ?? 0) > 0).length;
    const significant = rows.filter(
      (r) => r.t_stat != null && Math.abs(r.t_stat) >= 2 && r.n >= 20 && (r.mean_alpha_pct ?? 0) > 0
    ).length;
    const bestSharpe = Math.max(...rows.map((r) => r.sharpe ?? -Infinity));
    return { total: rows.length, positiveAlpha, significant, bestSharpe };
  }, [rows]);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortAsc((s) => !s);
    else { setSortKey(k); setSortAsc(false); }
  };

  const recompute = async () => {
    setRecomputing(true);
    try {
      const { error } = await supabase.rpc('ct_attribute_signals' as never, {
        p_lookback_days: lookback,
      } as never);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ['ct_edge_attribution', lookback] });
    } catch (e) {
      console.error('[Edge] recompute failed:', e);
    } finally {
      setRecomputing(false);
    }
  };

  const lastUpdated = rows?.[0]?.computed_at;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-4">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Target className="w-5 h-5 text-primary" />
              <span>Edge</span>
              <span className="text-sm text-muted-foreground font-normal">signal attribution vs SPY</span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Every signal event × horizon, direction-signed alpha vs SPY. Bold rows survive |t| ≥ 2 with n ≥ 20.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-[11px] text-muted-foreground tabular-nums">
              {lastUpdated ? `computed ${new Date(lastUpdated).toLocaleString()}` : 'never computed'}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={recompute}
              disabled={recomputing}
              className="text-xs"
            >
              <RefreshCw className={cn('w-3 h-3 mr-1', recomputing && 'animate-spin')} />
              {recomputing ? 'Recomputing…' : 'Recompute'}
            </Button>
          </div>
        </header>

        {/* Control strip */}
        <Card className="p-3 flex items-center gap-4 flex-wrap text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Lookback:</span>
            {[7, 14, 30].map((d) => (
              <Button
                key={d}
                size="sm"
                variant={lookback === d ? 'default' : 'outline'}
                onClick={() => setLookback(d)}
                className="h-7 px-2 text-[11px]"
              >
                {d}d
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Min n:</span>
            {[5, 10, 20, 30].map((n) => (
              <Button
                key={n}
                size="sm"
                variant={minN === n ? 'default' : 'outline'}
                onClick={() => setMinN(n)}
                className="h-7 px-2 text-[11px]"
              >
                {n}
              </Button>
            ))}
          </div>
          {stats && (
            <div className="ml-auto flex items-center gap-4 text-[11px]">
              <span className="text-muted-foreground">
                {fmtInt(stats.total)} buckets
              </span>
              <span className="text-emerald-400">
                {fmtInt(stats.positiveAlpha)} positive α
              </span>
              <span className="text-emerald-300 font-semibold">
                {fmtInt(stats.significant)} significant
              </span>
              <span className="text-muted-foreground">
                best Sharpe: <span className="tabular-nums font-semibold text-foreground">
                  {Number.isFinite(stats.bestSharpe) ? stats.bestSharpe.toFixed(3) : '—'}
                </span>
              </span>
            </div>
          )}
        </Card>

        {/* Caveat banner */}
        {stats && stats.significant === 0 && (
          <Card className="p-3 border-amber-500/40 bg-amber-500/5 text-[12px] flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold text-amber-200">No statistically significant edge yet.</span>{' '}
              <span className="text-muted-foreground">
                Could mean: (1) sample too thin — wait for more data, (2) signals genuinely noise at these horizons,
                (3) multi-comparison bleed — we test {stats?.total ?? 0} buckets so even significant-looking rows need
                Bonferroni-style skepticism. Best Sharpe = {Number.isFinite(stats.bestSharpe) ? stats.bestSharpe.toFixed(3) : '—'}.
              </span>
            </div>
          </Card>
        )}

        {error && (
          <Card className="p-4 border-red-500/40 bg-red-500/5 text-xs text-red-400">
            Failed to load: {(error as Error).message}
          </Card>
        )}

        {/* Results table */}
        <Card className="overflow-hidden">
          {isLoading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Loading attribution…</div>
          ) : filtered.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No buckets meet current filters. Lower min-n or widen lookback.
            </div>
          ) : (
            <div className="max-h-[70vh] overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card z-10">
                  <TableRow>
                    <TableHead onClick={() => toggleSort('signal_type')} className="cursor-pointer text-[10px] uppercase tracking-wider">
                      Signal {sortKey === 'signal_type' && (sortAsc ? '▲' : '▼')}
                    </TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider">Subtype</TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider">Dir</TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider">Conv</TableHead>
                    <TableHead
                      onClick={() => toggleSort('horizon_mins')}
                      className="cursor-pointer text-[10px] uppercase tracking-wider text-right"
                    >
                      Horz {sortKey === 'horizon_mins' && (sortAsc ? '▲' : '▼')}
                    </TableHead>
                    <TableHead
                      onClick={() => toggleSort('n')}
                      className="cursor-pointer text-[10px] uppercase tracking-wider text-right"
                    >
                      n {sortKey === 'n' && (sortAsc ? '▲' : '▼')}
                    </TableHead>
                    <TableHead
                      onClick={() => toggleSort('mean_alpha_pct')}
                      className="cursor-pointer text-[10px] uppercase tracking-wider text-right"
                    >
                      Mean α {sortKey === 'mean_alpha_pct' && (sortAsc ? '▲' : '▼')}
                    </TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider text-right">Median α</TableHead>
                    <TableHead
                      onClick={() => toggleSort('hit_rate')}
                      className="cursor-pointer text-[10px] uppercase tracking-wider text-right"
                    >
                      Hit {sortKey === 'hit_rate' && (sortAsc ? '▲' : '▼')}
                    </TableHead>
                    <TableHead
                      onClick={() => toggleSort('sharpe')}
                      className="cursor-pointer text-[10px] uppercase tracking-wider text-right"
                    >
                      Sharpe {sortKey === 'sharpe' && (sortAsc ? '▲' : '▼')}
                    </TableHead>
                    <TableHead
                      onClick={() => toggleSort('t_stat')}
                      className="cursor-pointer text-[10px] uppercase tracking-wider text-right"
                    >
                      t {sortKey === 't_stat' && (sortAsc ? '▲' : '▼')}
                    </TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider text-right">Ret</TableHead>
                    <TableHead className="text-[10px] uppercase tracking-wider text-right">SPY</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r) => (
                    <TableRow key={r.id} className="hover:bg-muted/30">
                      <TableCell className="py-1.5 text-[11px] font-mono">{r.signal_type}</TableCell>
                      <TableCell className="py-1.5 text-[11px] text-muted-foreground truncate max-w-[140px]">
                        {r.signal_subtype}
                      </TableCell>
                      <TableCell className="py-1.5">
                        <Badge
                          variant="outline"
                          className={cn(
                            'text-[9px] px-1.5 py-0 font-mono',
                            r.direction === 'bullish' && 'text-emerald-400 border-emerald-400/40',
                            r.direction === 'bearish' && 'text-red-400 border-red-400/40',
                          )}
                        >
                          {r.direction}
                        </Badge>
                      </TableCell>
                      <TableCell className="py-1.5 text-[11px] text-muted-foreground">{r.conviction_bucket}</TableCell>
                      <TableCell className="py-1.5 text-[11px] text-right font-mono">{horizonLabel(r.horizon_mins)}</TableCell>
                      <TableCell className={cn('py-1.5 text-[11px] text-right tabular-nums', nColor(r.n))}>
                        {r.n}
                      </TableCell>
                      <TableCell
                        className={cn('py-1.5 text-[11px] text-right tabular-nums', alphaColor(r.mean_alpha_pct, r.t_stat, r.n))}
                      >
                        {fmtPct(r.mean_alpha_pct)}
                      </TableCell>
                      <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
                        {fmtPct(r.median_alpha_pct)}
                      </TableCell>
                      <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                        {r.hit_rate != null ? `${(r.hit_rate * 100).toFixed(0)}%` : '—'}
                      </TableCell>
                      <TableCell className={cn('py-1.5 text-[11px] text-right tabular-nums', alphaColor(r.sharpe, r.t_stat, r.n))}>
                        {fmtNum(r.sharpe, 3)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'py-1.5 text-[11px] text-right tabular-nums font-mono',
                          r.t_stat != null && Math.abs(r.t_stat) >= 2 && 'font-semibold'
                        )}
                      >
                        {fmtNum(r.t_stat, 2)}
                      </TableCell>
                      <TableCell className="py-1.5 text-[10px] text-right tabular-nums text-muted-foreground">
                        {fmtPct(r.mean_return_pct, 2)}
                      </TableCell>
                      <TableCell className="py-1.5 text-[10px] text-right tabular-nums text-muted-foreground">
                        {fmtPct(r.mean_spy_return_pct, 2)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>

        <div className="text-[10px] text-muted-foreground leading-relaxed space-y-1">
          <div>
            <span className="font-semibold">α (alpha)</span> = direction-signed return minus SPY return over the same window.
            Bullish signal + ticker up more than SPY = positive α. Bearish signal + ticker down more than SPY = positive α.
          </div>
          <div>
            <span className="font-semibold">Sharpe</span> = mean α / stdev α (not annualized). <span className="font-semibold">|t| ≥ 2</span> ≈ p &lt; 0.05 for n &gt; 30.
            Multi-comparison caveat applies — testing 60+ buckets, some cross significance by chance.
          </div>
          <div>
            <span className="font-semibold">Hit rate</span> = % of events where signed α was positive. Fat-tailed signals
            (rare wins, frequent losses) can have &lt;50% hit rate AND positive mean. Both matter.
          </div>
          <div>
            Sweeps and political signals missing from the stream — see <span className="font-mono">ct_sweeps.type/ask_side_perc</span> NULL
            ingester bug and 1-min price window gap for political dates before 2026-04-15.
          </div>
        </div>
      </div>
    </div>
  );
}
