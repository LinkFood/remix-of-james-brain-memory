/**
 * /edge — Hedge-fund-style Edge Attribution dashboard.
 *
 * Reads the truth tables built by the parallel Agent A/B/C backend pipes:
 *   - ct_edge_daily   (Agent B): today's snapshot/track aggregates + retroactive
 *                       slow_burn_pays_today JSONB and by_* dimension breakdowns.
 *   - ct_signatures   (Agent B): promoted recurring signature library with edge
 *                       scores, sample, snap/lifetime hit rates.
 *   - ct_print_grades (Agent A): per-print snapshot grades, joined back to
 *                       ct_flow_alerts for ticker/strike/side/dte context.
 *   - ct_print_tracks (Agent A): live-tracked prints (status WORKING etc).
 *
 * Layout (top to bottom, glance-first per Tenet 9):
 *   A. Hero — today's regime + snapshot hit rate + W/L/F + track counts
 *   B. Retroactive Alpha — slow-burn pays from prior days that paid off today
 *   C. Today's Winners / Losers — top 10 print magnitudes
 *   D. Best Signatures — promoted library, ranked by edge_score
 *   E. Per-ticker scorecards — 5×2 grid w/ FlowPulseSparkline
 *   F. Currently Working Tracks — live position-style view
 *   G. Attribution by Dimension — Ticker / Time bucket / DTE bucket bar charts
 *
 * Empty-state policy: every section renders either a skeleton (loading) or a
 * positive-framed "no data yet" placeholder. No section throws on missing
 * tables. All hooks live in src/hooks/useEdge.ts (retry: false, defensive).
 */

import { useMemo, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, ReferenceLine,
} from 'recharts';
import { cn } from '@/lib/utils';
import {
  Target, TrendingUp, TrendingDown, Zap, Hourglass, Activity,
} from 'lucide-react';
import { FlowPulseSparkline } from '@/components/command/FlowPulseSparkline';
import {
  useEdgeDaily,
  useSignatures,
  usePrintGrades,
  usePrintTracks,
  useSignatureMagnitudeStats,
  useContractThresholdDistribution,
  slowBurnCount,
  fmtPctRate,
  fmtInt,
  fmtNum,
  fmtPct,
  fmtFractionAsPct,
  gradeColor,
  type PrintGradeRow,
  type SignatureRow,
  type PrintTrackRow,
  type SlowBurnPay,
  type EdgeDailyByBucket,
  type SignatureMagnitudeRow,
  type ContractThresholdRow,
} from '@/hooks/useEdge';
import { useDteEligibility, type DteEligibilityMap } from '@/hooks/useDteEligibility';
import {
  useTopContractPeaks,
  fmtPctMagnitude,
} from '@/hooks/useContractTracks';

const WATCHLIST = ['SPY', 'QQQ', 'IWM', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA'];

// ============================================================================
// helpers
// ============================================================================

function todayISO(): string {
  // Local YYYY-MM-DD — matches how Supabase typically slices session_date.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function regimeBadgeClass(regime: string | null | undefined): string {
  if (!regime) return 'bg-muted/40 text-muted-foreground border-muted';
  const r = regime.toLowerCase();
  if (r.includes('bull') || r.includes('risk-on')) return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
  if (r.includes('bear') || r.includes('risk-off')) return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
  if (r.includes('chop') || r.includes('mixed')) return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
  return 'bg-primary/10 text-primary border-primary/30';
}

function sideClass(side: string | null | undefined): string {
  if (!side) return 'text-muted-foreground';
  const s = side.toLowerCase();
  if (s.includes('call') || s === 'c' || s.includes('bull')) return 'text-emerald-300';
  if (s.includes('put') || s === 'p' || s.includes('bear')) return 'text-rose-300';
  return 'text-foreground';
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function fmtStrike(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return '—';
  return `$${s.toFixed(0)}`;
}

/**
 * Human-readable age stamp for ct_edge_daily.computed_at, plus the freshness
 * tier the UI should color-code. Added 2026-05-14 (Ship 3) — Bundle 1 lifted
 * the contract grader thresholds, so freshness UX is load-bearing context for
 * James reading the Edge page.
 */
function computedAtAge(iso: string | null | undefined): { label: string; tone: 'fresh' | 'recent' | 'stale' | 'gap' | 'unknown' } {
  if (!iso) return { label: 'no compute stamp', tone: 'unknown' };
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return { label: 'no compute stamp', tone: 'unknown' };
  const ageMs = Date.now() - t;
  const ageH = ageMs / 3_600_000;
  if (ageH < 2) return { label: 'fresh EOD', tone: 'fresh' };
  if (ageH < 12) {
    const h = Math.max(1, Math.round(ageH));
    return { label: `${h}h stale`, tone: 'recent' };
  }
  if (ageH < 72) {
    const d = Math.max(1, Math.round(ageH / 24));
    return { label: `${d}d stale`, tone: 'stale' };
  }
  const d = Math.round(ageH / 24);
  return { label: `${d}d stale — weekend or gap`, tone: 'gap' };
}

function ageToneClass(tone: 'fresh' | 'recent' | 'stale' | 'gap' | 'unknown'): string {
  switch (tone) {
    case 'fresh':   return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'recent':  return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'stale':   return 'bg-amber-500/20 text-amber-200 border-amber-500/40';
    case 'gap':     return 'bg-rose-500/15 text-rose-300 border-rose-500/40';
    case 'unknown': return 'bg-muted/40 text-muted-foreground border-border/50';
  }
}

// ============================================================================
// Section A — Hero row
// ============================================================================

function HeroRow() {
  const { data, isLoading } = useEdgeDaily();

  const cards: { label: string; value: string; sub?: string; cls?: string }[] = useMemo(() => {
    const d = data;
    const sbCount = slowBurnCount(d);
    return [
      {
        label: 'Snapshot Hit',
        value: fmtPctRate(d?.snapshot_hit_rate, 1),
        sub: `${fmtInt(d?.snapshot_total_graded ?? d?.total_graded)} graded`,
        cls: (d?.snapshot_hit_rate ?? 0) > 0.5 ? 'text-emerald-300' : 'text-foreground',
      },
      { label: 'Wins', value: fmtInt(d?.snapshot_wins), cls: 'text-emerald-300' },
      { label: 'Losses', value: fmtInt(d?.snapshot_losses), cls: 'text-rose-300' },
      { label: 'Flats', value: fmtInt(d?.snapshot_flats), cls: 'text-muted-foreground' },
      {
        label: 'Tracks Realized',
        value: fmtInt(d?.tracks_realized_today),
        sub: 'today',
      },
      {
        label: 'New Peaks',
        value: fmtInt(d?.tracks_new_peaks_today),
        sub: 'tracks',
      },
      {
        label: 'Slow-Burn',
        value: fmtInt(sbCount),
        sub: 'paid today',
        cls: sbCount > 0 ? 'text-amber-300' : 'text-muted-foreground',
      },
    ];
  }, [data]);

  return (
    <Card className="p-4">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex flex-col gap-1 min-w-[160px]">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Today's Regime
          </div>
          {isLoading ? (
            <div className="h-6 w-24 rounded bg-muted/40 animate-pulse" />
          ) : (
            <Badge
              variant="outline"
              className={cn(
                'text-[11px] uppercase tracking-wider px-2 py-1 w-fit',
                regimeBadgeClass(data?.regime_tag),
              )}
            >
              {data?.regime_tag ?? 'unknown'}
            </Badge>
          )}
          <div className="text-[10px] text-muted-foreground/70 mt-1">
            {data?.session_date ?? todayISO()}
          </div>
        </div>

        <div className="flex flex-col gap-1 min-w-[140px]">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Snapshot Hit Rate
          </div>
          {isLoading ? (
            <div className="h-9 w-24 rounded bg-muted/40 animate-pulse" />
          ) : (
            <div className={cn(
              'text-3xl font-mono font-bold tabular-nums',
              (data?.snapshot_hit_rate ?? 0) > 0.5 ? 'text-emerald-300' : 'text-foreground',
            )}>
              {fmtPctRate(data?.snapshot_hit_rate, 1)}
            </div>
          )}
          <div className="text-[10px] text-muted-foreground">
            {fmtInt(data?.snapshot_total_graded ?? data?.total_graded)} prints graded
          </div>
        </div>

        <div className="flex-1 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {cards.map((c) => (
            <div
              key={c.label}
              className="flex flex-col gap-0.5 px-2 py-1.5 rounded bg-muted/20 border border-border/40"
            >
              <div className="text-[9px] uppercase tracking-wider text-muted-foreground">
                {c.label}
              </div>
              <div className={cn('text-lg font-mono tabular-nums leading-tight', c.cls)}>
                {c.value}
              </div>
              {c.sub && (
                <div className="text-[9px] text-muted-foreground/70">{c.sub}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
}

// ============================================================================
// Section B — Retroactive Alpha (Slow-Burn Pays)
// ============================================================================

function SlowBurnPays() {
  const { data, isLoading } = useEdgeDaily();
  const pays: SlowBurnPay[] = data?.slow_burn_pays_today ?? [];

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2 bg-amber-500/[0.04]">
        <Hourglass className="w-4 h-4 text-amber-300" />
        <h2 className="text-sm font-semibold tracking-tight">Retroactive Alpha — Slow-Burn Pays</h2>
        <span className="text-[10px] text-muted-foreground ml-2">
          prints from prior days that paid off today
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
          {fmtInt(pays.length)} realized
        </span>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-xs text-muted-foreground">Loading edge ledger…</div>
      ) : pays.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground italic">
          No slow-burn realizations today — check back tomorrow.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[10px] uppercase tracking-wider">Ticker</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Side</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Strike</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Original Print</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Days</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Peak +%</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Signature</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pays.map((p, i) => (
              <TableRow key={`${p.ticker}-${p.print_date}-${i}`} className="hover:bg-muted/20">
                <TableCell className="py-1.5 text-[11px] font-mono font-semibold text-primary">
                  {p.ticker}
                </TableCell>
                <TableCell className={cn('py-1.5 text-[11px] font-mono', sideClass(p.side))}>
                  {p.side ?? '—'}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] font-mono text-right tabular-nums">
                  {fmtStrike(p.strike)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-muted-foreground">
                  {fmtDate(p.print_date)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtInt(p.days_to_realize)}d
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-emerald-300 font-semibold">
                  {fmtPct(p.peak_favorable_pct, 1)}
                </TableCell>
                <TableCell className="py-1.5 text-[10px] font-mono text-muted-foreground truncate max-w-[180px]">
                  {p.signature_key ?? '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

// ============================================================================
// Section C — Today's Winners / Losers
// ============================================================================

function PrintGradeTable({
  rows,
  isLoading,
  emptyMessage,
}: {
  rows: PrintGradeRow[];
  isLoading: boolean;
  emptyMessage: string;
}) {
  return isLoading ? (
    <div className="p-6 text-center text-xs text-muted-foreground">Loading…</div>
  ) : rows.length === 0 ? (
    <div className="p-6 text-center text-xs text-muted-foreground italic">{emptyMessage}</div>
  ) : (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-[10px] uppercase tracking-wider">Time</TableHead>
          <TableHead className="text-[10px] uppercase tracking-wider">Ticker</TableHead>
          <TableHead className="text-[10px] uppercase tracking-wider">Side</TableHead>
          <TableHead className="text-[10px] uppercase tracking-wider text-right">Strike</TableHead>
          <TableHead className="text-[10px] uppercase tracking-wider text-right">DTE</TableHead>
          <TableHead className="text-[10px] uppercase tracking-wider text-right">Move</TableHead>
          <TableHead className="text-[10px] uppercase tracking-wider">Sig</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={String(r.id)} className="hover:bg-muted/20">
            <TableCell className="py-1.5 text-[10px] text-muted-foreground tabular-nums">
              {fmtTime(r.executed_at ?? r.graded_at)}
            </TableCell>
            <TableCell className="py-1.5 text-[11px] font-mono font-semibold text-primary">
              {r.ticker ?? '—'}
            </TableCell>
            <TableCell className={cn('py-1.5 text-[11px] font-mono', sideClass(r.side))}>
              {r.side ?? '—'}
            </TableCell>
            <TableCell className="py-1.5 text-[11px] text-right font-mono tabular-nums">
              {fmtStrike(r.strike)}
            </TableCell>
            <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
              {fmtInt(r.dte)}
            </TableCell>
            <TableCell className={cn('py-1.5 text-[11px] text-right font-mono tabular-nums font-semibold', gradeColor(r.grade))}>
              {fmtPct(r.magnitude_pct, 1)}
            </TableCell>
            <TableCell className="py-1.5 text-[10px] font-mono text-muted-foreground truncate max-w-[140px]">
              {r.signature_key ?? '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function WinnersLosers() {
  const today = todayISO();
  const winners = usePrintGrades({ date: today, grade: 'WIN', limit: 10, orderBy: 'magnitude_desc' });
  const losers = usePrintGrades({ date: today, grade: 'LOSS', limit: 10, orderBy: 'magnitude_asc' });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2 bg-emerald-500/[0.04]">
          <TrendingUp className="w-4 h-4 text-emerald-300" />
          <h2 className="text-sm font-semibold tracking-tight">Today's Winners</h2>
          <span className="text-[10px] text-muted-foreground ml-auto">top 10 by magnitude</span>
        </div>
        <PrintGradeTable
          rows={winners.data ?? []}
          isLoading={winners.isLoading}
          emptyMessage="No graded wins yet today."
        />
      </Card>
      <Card className="p-0 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2 bg-rose-500/[0.04]">
          <TrendingDown className="w-4 h-4 text-rose-300" />
          <h2 className="text-sm font-semibold tracking-tight">Today's Losers</h2>
          <span className="text-[10px] text-muted-foreground ml-auto">top 10 by magnitude</span>
        </div>
        <PrintGradeTable
          rows={losers.data ?? []}
          isLoading={losers.isLoading}
          emptyMessage="No graded losses yet today."
        />
      </Card>
    </div>
  );
}

// ============================================================================
// Section D — Best Signatures
// ============================================================================

function HitBar({ rate }: { rate: number | null | undefined }) {
  if (rate == null || !Number.isFinite(rate)) {
    return <div className="w-16 h-1.5 rounded bg-muted/30" />;
  }
  const pct = Math.max(0, Math.min(1, Math.abs(rate) <= 1 ? rate : rate / 100));
  const isHigh = pct >= 0.55;
  const isLow = pct <= 0.45;
  return (
    <div className="w-16 h-1.5 rounded bg-muted/30 overflow-hidden inline-block align-middle">
      <div
        className={cn(
          'h-full rounded transition-all',
          isHigh ? 'bg-emerald-400' : isLow ? 'bg-rose-400' : 'bg-amber-400',
        )}
        style={{ width: `${pct * 100}%` }}
      />
    </div>
  );
}

function BestSignatures() {
  const { data, isLoading } = useSignatures({ promoted: true, limit: 20, orderBy: 'edge_score' });
  const rows: SignatureRow[] = data ?? [];

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2 bg-primary/[0.04]">
        <Zap className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">Best Signatures — Promoted Library</h2>
        <span className="text-[10px] text-muted-foreground ml-auto">{fmtInt(rows.length)} promoted</span>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-xs text-muted-foreground">Loading library…</div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground italic">
          No promoted signatures yet — the miner needs more graded prints to crystallize patterns.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[10px] uppercase tracking-wider">Signature</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Sample</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Snap Hit</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Lifetime Hit</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Med Days</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Edge</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">First Seen</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow
                key={s.signature_key}
                className="hover:bg-muted/20 cursor-pointer"
                title="Click to drill (coming soon)"
              >
                <TableCell className="py-1.5 text-[11px] font-mono font-semibold text-foreground truncate max-w-[260px]">
                  {s.signature_key}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtInt(s.sample_count)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  <span className="inline-flex items-center gap-1.5 justify-end">
                    <HitBar rate={s.snapshot_hit_rate} />
                    <span className="text-muted-foreground w-10 text-right">
                      {fmtPctRate(s.snapshot_hit_rate, 0)}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  <span className="inline-flex items-center gap-1.5 justify-end">
                    <HitBar rate={s.lifetime_hit_rate} />
                    <span className="text-foreground w-10 text-right">
                      {fmtPctRate(s.lifetime_hit_rate, 0)}
                    </span>
                  </span>
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
                  {fmtNum(s.median_days_to_realization, 1)}
                </TableCell>
                <TableCell className={cn(
                  'py-1.5 text-[11px] text-right tabular-nums font-mono font-semibold',
                  (s.edge_score ?? 0) > 0 ? 'text-emerald-300' : 'text-rose-300',
                )}>
                  {fmtNum(s.edge_score, 2)}
                </TableCell>
                <TableCell className="py-1.5 text-[10px] text-muted-foreground">
                  {fmtDate(s.first_seen_at)}
                </TableCell>
                <TableCell className="py-1.5 text-[10px] text-muted-foreground">
                  {fmtDate(s.last_updated_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

// ============================================================================
// Section D2 — Contract-axis edge (Phase D preview)
// ============================================================================
//
// Top peaks from ct_contract_tracks over the last 7d. The contract-axis
// grader (Phase C) will eventually fill in the rest of this page with full
// magnitude attribution; this section is the proof-of-life that Phase A's
// tracker rows + Phase B's quote poller are flowing data through.
// Defensive — empty/loading states render their own placeholders.

function ContractAxisEdge() {
  const sinceISO = useMemo(() => new Date(Date.now() - 7 * 86_400_000).toISOString(), []);
  const { data, isLoading } = useTopContractPeaks(10, sinceISO);

  const sideCls = (side: string | null) =>
    side === 'call'
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
      : side === 'put'
        ? 'bg-rose-500/15 text-rose-300 border-rose-500/40'
        : 'bg-muted/40 text-muted-foreground border-border/50';

  const statusCls = (status: string) => {
    if (status === 'WIN' || status === 'EXPIRED_WIN') return 'text-emerald-300';
    if (status === 'LOSS' || status === 'EXPIRED_LOSS') return 'text-rose-300';
    if (status === 'STALE') return 'text-muted-foreground';
    return 'text-amber-300';
  };

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-3 border-b border-border/40 flex items-center gap-2">
        <Zap className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">Contract-axis edge — Top peaks (7d)</h2>
        <span className="text-[10px] text-muted-foreground font-mono ml-auto">
          ct_contract_tracks · Phase D preview
        </span>
      </div>
      {isLoading ? (
        <div className="p-6 text-xs text-muted-foreground text-center">Loading contract tracks…</div>
      ) : !data || data.length === 0 ? (
        <div className="p-6 text-xs text-muted-foreground text-center">
          No contract tracks yet. Phase B's poller fills these as quotes arrive.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/40">
              <TableHead className="h-9 px-3 text-[11px] uppercase tracking-wider">Ticker</TableHead>
              <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider">Strike</TableHead>
              <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider">Side</TableHead>
              <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">DTE</TableHead>
              <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider text-right">Peak</TableHead>
              <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider">Time-to-Peak</TableHead>
              <TableHead className="h-9 px-2 text-[11px] uppercase tracking-wider">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((t) => {
              const ttp = (() => {
                if (!t.peak_contract_at) return '—';
                const printMs = Date.parse(t.print_time);
                const peakMs = Date.parse(t.peak_contract_at);
                if (!Number.isFinite(printMs) || !Number.isFinite(peakMs)) return '—';
                const mins = Math.max(0, Math.round((peakMs - printMs) / 60_000));
                if (mins < 60) return `${mins}m`;
                const h = Math.floor(mins / 60);
                const m = mins % 60;
                return m === 0 ? `${h}h` : `${h}h ${m}m`;
              })();
              return (
                <TableRow key={t.id} className="hover:bg-muted/30 border-b border-border/40">
                  <TableCell className="py-2 px-3 font-mono font-bold">{t.ticker}</TableCell>
                  <TableCell className="py-2 px-2 font-mono tabular-nums">
                    {t.strike != null ? `$${t.strike}` : '—'}
                  </TableCell>
                  <TableCell className="py-2 px-2">
                    <Badge variant="outline" className={cn('text-[10px] font-mono px-1.5 py-0 font-bold', sideCls(t.side))}>
                      {t.side?.toUpperCase()}
                    </Badge>
                  </TableCell>
                  <TableCell className="py-2 px-2 font-mono tabular-nums text-right">
                    {t.dte_at_print ?? '—'}
                  </TableCell>
                  <TableCell className="py-2 px-2 font-mono tabular-nums text-right text-emerald-300 font-semibold">
                    {fmtPctMagnitude(t.peak_contract_pct)}
                  </TableCell>
                  <TableCell className="py-2 px-2 font-mono tabular-nums text-muted-foreground">
                    {ttp}
                  </TableCell>
                  <TableCell className={cn('py-2 px-2 font-mono text-[11px] uppercase tracking-wider', statusCls(t.track_status))}>
                    {t.track_status.replace('_', ' ')}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

// ============================================================================
// Section E — Per-Ticker Scorecards
// ============================================================================

function TickerScorecard({ ticker }: { ticker: string }) {
  const today = todayISO();
  const wins = usePrintGrades({ date: today, grade: 'WIN', ticker, limit: 50, orderBy: 'graded_at_desc' });
  const losses = usePrintGrades({ date: today, grade: 'LOSS', ticker, limit: 50, orderBy: 'graded_at_desc' });
  const sigs = useSignatures({ ticker, promoted: true, limit: 1, orderBy: 'edge_score' });

  const winCount = wins.data?.length ?? 0;
  const lossCount = losses.data?.length ?? 0;
  const total = winCount + lossCount;
  const dayHit = total > 0 ? winCount / total : null;
  const bestSig = sigs.data?.[0];

  return (
    <Card className="p-3 flex flex-col gap-2 hover:border-primary/40 transition-colors cursor-pointer"
      title={`Filter by ${ticker} (coming soon)`}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-mono font-bold text-primary">{ticker}</span>
        <FlowPulseSparkline ticker={ticker} width={56} height={16} />
      </div>
      <div className="flex items-center gap-2 text-[11px] font-mono tabular-nums">
        <span className="text-emerald-300">{winCount}W</span>
        <span className="text-muted-foreground/40">/</span>
        <span className="text-rose-300">{lossCount}L</span>
        <span className="ml-auto text-foreground">
          {dayHit == null ? '—' : `${(dayHit * 100).toFixed(0)}%`}
        </span>
      </div>
      <div className="flex flex-col gap-0.5 pt-1 border-t border-border/40">
        <div className="text-[9px] uppercase tracking-wider text-muted-foreground/70">
          Best Sig
        </div>
        <div className="text-[10px] font-mono text-foreground/80 truncate"
          title={bestSig?.signature_key ?? 'no promoted signature'}>
          {bestSig?.signature_key ?? '—'}
        </div>
        <div className="text-[9px] text-muted-foreground tabular-nums">
          edge {fmtNum(bestSig?.edge_score ?? null, 2)} · n={fmtInt(bestSig?.sample_count ?? null)}
        </div>
      </div>
    </Card>
  );
}

function PerTickerGrid() {
  return (
    <Card className="p-3 bg-card/50">
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">Per-Ticker Scorecards</h2>
        <span className="text-[10px] text-muted-foreground ml-2">today's W/L · session bias · best signature</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
        {WATCHLIST.map((t) => (
          <TickerScorecard key={t} ticker={t} />
        ))}
      </div>
    </Card>
  );
}

// ============================================================================
// Section F — Currently Working Tracks
// ============================================================================

function WorkingTracks() {
  const { data, isLoading } = usePrintTracks({ status: 'WORKING', orderBy: 'peak_favorable_desc', limit: 30 });
  const rows: PrintTrackRow[] = data ?? [];

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2 bg-primary/[0.04]">
        <Hourglass className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">Currently Working Tracks</h2>
        <span className="text-[10px] text-muted-foreground ml-2">prints under live track, sorted by peak favorable</span>
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{fmtInt(rows.length)} open</span>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-xs text-muted-foreground">Loading working tracks…</div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground italic">
          No working tracks — the miner is likely waiting on graded data.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[10px] uppercase tracking-wider">Ticker</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Side</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Strike</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">DTE@print</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Print Date</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Peak +%</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Days Tracked</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">Until</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={String(r.id)} className="hover:bg-muted/20">
                <TableCell className="py-1.5 text-[11px] font-mono font-semibold text-primary">
                  {r.ticker ?? '—'}
                </TableCell>
                <TableCell className={cn('py-1.5 text-[11px] font-mono', sideClass(r.side))}>
                  {r.side ?? '—'}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right font-mono tabular-nums">
                  {fmtStrike(r.strike)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
                  {fmtInt(r.dte_at_print)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-muted-foreground">
                  {fmtDate(r.print_date)}
                </TableCell>
                <TableCell className={cn(
                  'py-1.5 text-[11px] text-right tabular-nums font-mono font-semibold',
                  (r.peak_favorable_pct ?? 0) > 0 ? 'text-emerald-300' : 'text-muted-foreground',
                )}>
                  {fmtPct(r.peak_favorable_pct, 1)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtInt(r.days_tracked)}d
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-muted-foreground">
                  {fmtDate(r.tracking_until)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

// ============================================================================
// Section G — Attribution by Dimension
// ============================================================================

interface BarRow {
  bucket: string;
  hit_pct: number;
  sample: number;
}

function normalizeBuckets(buckets: EdgeDailyByBucket[] | null | undefined): BarRow[] {
  if (!Array.isArray(buckets)) return [];
  return buckets
    .map((b) => {
      const r = b.hit_rate;
      const pct = r == null ? 0 : Math.abs(r) <= 1 ? r * 100 : r;
      return { bucket: String(b.bucket), hit_pct: pct, sample: b.sample ?? 0 };
    })
    // Filter out empty buckets so the chart doesn't render zero-sample noise.
    .filter((b) => b.sample > 0);
}

function DimensionChart({ rows }: { rows: BarRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="p-6 text-center text-xs text-muted-foreground italic">
        No buckets graded yet for this dimension.
      </div>
    );
  }
  return (
    <div className="w-full" style={{ height: 240 }}>
      <ResponsiveContainer>
        <BarChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 18 }}>
          <XAxis
            dataKey="bucket"
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            interval={0}
            angle={-30}
            textAnchor="end"
            height={40}
          />
          <YAxis
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            domain={[0, 100]}
            tickFormatter={(v) => `${v}%`}
            width={36}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: 6,
              fontSize: 11,
            }}
            formatter={(value: number, name: string, p: { payload?: BarRow }) => {
              if (name === 'hit_pct') return [`${value.toFixed(1)}% (n=${p.payload?.sample ?? 0})`, 'Hit Rate'];
              return [value, name];
            }}
          />
          <ReferenceLine y={50} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
          <Bar dataKey="hit_pct" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function AttributionByDimension() {
  const { data, isLoading } = useEdgeDaily();
  const byTicker = useMemo(() => normalizeBuckets(data?.by_ticker), [data?.by_ticker]);
  const byTime = useMemo(() => normalizeBuckets(data?.by_time_bucket), [data?.by_time_bucket]);
  const byDte = useMemo(() => normalizeBuckets(data?.by_dte_bucket), [data?.by_dte_bucket]);

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2">
        <Target className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">Attribution by Dimension</h2>
        <span className="text-[10px] text-muted-foreground ml-2">hit rate × sample size, today</span>
      </div>
      <div className="p-3">
        {isLoading ? (
          <div className="h-[240px] rounded bg-muted/20 animate-pulse" />
        ) : (
          <Tabs defaultValue="ticker">
            <TabsList className="h-8">
              <TabsTrigger value="ticker" className="text-[11px]">Ticker</TabsTrigger>
              <TabsTrigger value="time" className="text-[11px]">Time Bucket</TabsTrigger>
              <TabsTrigger value="dte" className="text-[11px]">DTE Bucket</TabsTrigger>
            </TabsList>
            <TabsContent value="ticker" className="pt-2">
              <DimensionChart rows={byTicker} />
            </TabsContent>
            <TabsContent value="time" className="pt-2">
              <DimensionChart rows={byTime} />
            </TabsContent>
            <TabsContent value="dte" className="pt-2">
              <DimensionChart rows={byDte} />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </Card>
  );
}

// ============================================================================
// Section H — Threshold Calibration (contract-axis WIN bars vs reality)
// ============================================================================
//
// The contract grader uses per-DTE-bucket WIN thresholds stored in ct_config:
//   0DTE = +50%, short = +50%, mid = +100%, long = +200%.
// Are those bars right? This panel surfaces the actual peak distribution per
// bucket alongside the current threshold so James can see at a glance which
// bars are too tight (almost no WINs land) or too loose (everything WINs).
//
// "% over bar" coloring is the headline:
//   <10%  rose  — bar too tight, almost no signature crosses it
//   10-30 amber
//   30-60 emerald — sweet spot
//   60-90 amber
//   >90%  rose  — bar too loose, WIN means nothing

function thresholdHealthClass(pct: number | null | undefined): string {
  if (pct == null) return 'text-muted-foreground';
  const p = pct * 100;
  if (p < 10) return 'text-rose-300';
  if (p < 30) return 'text-amber-300';
  if (p <= 60) return 'text-emerald-300';
  if (p <= 90) return 'text-amber-300';
  return 'text-rose-300';
}

function bucketLabel(b: string): string {
  switch (b) {
    case '0dte': return '0DTE';
    case 'short': return 'Short (1-7d)';
    case 'mid': return 'Mid (8-30d)';
    case 'long': return 'Long (30d+)';
    default: return b;
  }
}

function ThresholdCalibration() {
  const { data, isLoading } = useContractThresholdDistribution(7);
  const rows: ContractThresholdRow[] = data ?? [];

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2 bg-primary/[0.04]">
        <Target className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">Threshold Calibration</h2>
        <span className="text-[10px] text-muted-foreground ml-2">
          actual contract peak distribution vs current WIN thresholds (7d)
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
          {fmtInt(rows.reduce((acc, r) => acc + (r.n_tracks ?? 0), 0))} tracks
        </span>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-xs text-muted-foreground">Loading distribution…</div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground italic">
          No contract tracks yet — calibration appears once the poller fills peaks.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[10px] uppercase tracking-wider">DTE Bucket</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">n</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">WIN bar</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">P50</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">P75</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">P90</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Max</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">% over bar</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Suggest P60</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">Suggest P75</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.dte_bucket} className="hover:bg-muted/20">
                <TableCell className="py-1.5 text-[11px] font-mono font-semibold text-foreground">
                  {bucketLabel(r.dte_bucket)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
                  {fmtInt(r.n_tracks)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right font-mono tabular-nums text-foreground">
                  {fmtFractionAsPct(r.current_threshold_pct, 0)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
                  {fmtFractionAsPct(r.median_peak_pct, 0)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtFractionAsPct(r.p75_peak_pct, 0)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtFractionAsPct(r.p90_peak_pct, 0)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
                  {fmtFractionAsPct(r.max_peak_pct, 0)}
                </TableCell>
                <TableCell className={cn(
                  'py-1.5 text-[11px] text-right font-mono tabular-nums font-semibold',
                  thresholdHealthClass(r.pct_above_threshold),
                )}>
                  {r.pct_above_threshold == null
                    ? '—'
                    : `${(r.pct_above_threshold * 100).toFixed(1)}%`}
                  <span className="ml-1 text-[9px] text-muted-foreground/70">
                    ({fmtInt(r.n_above_threshold)})
                  </span>
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-amber-300/90">
                  {fmtFractionAsPct(r.recommended_p60_pct, 0)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-amber-300/90">
                  {fmtFractionAsPct(r.recommended_p75_pct, 0)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <div className="px-4 py-2 text-[10px] text-muted-foreground/80 border-t border-border/40">
        <span className="font-semibold">% over bar</span> green 30-60% = bar feels right.
        Rose &lt;10% = bar too tight (almost nothing WINs). Rose &gt;90% = bar too loose.
        <span className="ml-1 font-semibold">Suggest P60</span> = threshold that catches top 40% of tracks.
      </div>
    </Card>
  );
}

// ============================================================================
// Section I — Signature Magnitude (contract-axis EV ranking)
// ============================================================================
//
// Sibling of BestSignatures but ranked by ACTUAL contract returns, not
// direction hit rate. Built off ct_contract_tracks grouped by
// (ticker × side × dte_bucket × predicted_source) so it works on every
// tracked print, even ones that haven't earned a promoted ct_signatures row.

function evColorClass(ev: number | null | undefined): string {
  if (ev == null || !Number.isFinite(ev)) return 'text-muted-foreground';
  const p = ev * 100;
  if (p > 50) return 'text-emerald-300';
  if (p >= 0) return 'text-amber-300';
  return 'text-rose-300';
}

function dteBucketBadgeClass(b: string): string {
  switch (b) {
    case '0dte': return 'bg-rose-500/15 text-rose-300 border-rose-500/30';
    case 'short': return 'bg-amber-500/15 text-amber-300 border-amber-500/30';
    case 'mid': return 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30';
    case 'long': return 'bg-primary/15 text-primary border-primary/30';
    default: return 'bg-muted/40 text-muted-foreground border-border/50';
  }
}

type MagSortKey = 'expected_value_pct' | 'median_peak_pct' | 'p75_peak_pct' | 'p90_peak_pct' | 'n_tracks' | 'hit_rate';

// Eligibility scope tag for 0dte signature rows. SPY/QQQ/IWM are daily;
// NVDA is Friday-only; anything else with daily_0dte=false has no business
// in 0dte (flagged "n/a" so it stands out as suspect data).
function dte0DteScope(ticker: string, eligibility: DteEligibilityMap): { label: string; tone: 'daily' | 'fri' | 'na' } {
  const cfg = eligibility[ticker?.toUpperCase()];
  if (!cfg) return { label: 'n/a', tone: 'na' };
  if (cfg.daily_0dte) return { label: 'daily', tone: 'daily' };
  if (cfg.weekly_friday_0dte) return { label: 'Fri-only', tone: 'fri' };
  return { label: 'n/a', tone: 'na' };
}

function dte0DteScopeClass(tone: 'daily' | 'fri' | 'na'): string {
  switch (tone) {
    case 'daily': return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300';
    case 'fri':   return 'border-amber-500/30 bg-amber-500/10 text-amber-300';
    case 'na':    return 'border-rose-500/40 bg-rose-500/10 text-rose-300';
  }
}

function SignatureMagnitude() {
  const { data, isLoading } = useSignatureMagnitudeStats(7, 3);
  const { data: eligibility } = useDteEligibility();
  const [sortKey, setSortKey] = useState<MagSortKey>('expected_value_pct');

  const rows: SignatureMagnitudeRow[] = useMemo(() => {
    const r = (data ?? []).slice();
    r.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      const an = av == null || !Number.isFinite(av) ? -Infinity : av;
      const bn = bv == null || !Number.isFinite(bv) ? -Infinity : bv;
      return bn - an;
    });
    return r;
  }, [data, sortKey]);

  const sortBtn = (k: MagSortKey, label: string) => (
    <button
      type="button"
      onClick={() => setSortKey(k)}
      className={cn(
        'text-[10px] uppercase tracking-wider hover:text-foreground transition-colors',
        sortKey === k ? 'text-primary font-semibold' : 'text-muted-foreground',
      )}
    >
      {label}{sortKey === k ? ' ↓' : ''}
    </button>
  );

  return (
    <Card className="p-0 overflow-hidden">
      <div className="px-4 py-2.5 border-b border-border/60 flex items-center gap-2 bg-primary/[0.04]">
        <TrendingUp className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-semibold tracking-tight">Signatures by Magnitude</h2>
        <span className="text-[10px] text-muted-foreground ml-2">
          contract-axis EV — ranks by actual peak returns, not direction (7d, n≥3)
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
          {fmtInt(rows.length)} shapes
        </span>
      </div>
      {isLoading ? (
        <div className="p-6 text-center text-xs text-muted-foreground">Loading magnitude…</div>
      ) : rows.length === 0 ? (
        <div className="p-6 text-center text-xs text-muted-foreground italic">
          No signature shapes have ≥3 tracked prints yet — bar lowers as the contract poller fills more rows.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[10px] uppercase tracking-wider">Signature</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider">DTE</TableHead>
              <TableHead className="text-right">{sortBtn('n_tracks', 'n')}</TableHead>
              <TableHead className="text-right">{sortBtn('median_peak_pct', 'Median')}</TableHead>
              <TableHead className="text-right">{sortBtn('p75_peak_pct', 'P75')}</TableHead>
              <TableHead className="text-right">{sortBtn('p90_peak_pct', 'P90')}</TableHead>
              <TableHead className="text-[10px] uppercase tracking-wider text-right">W/L/Wk</TableHead>
              <TableHead className="text-right">{sortBtn('hit_rate', 'Hit%')}</TableHead>
              <TableHead className="text-right">{sortBtn('expected_value_pct', 'EV')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const is0dte = r.dte_bucket === '0dte';
              const scope = is0dte ? dte0DteScope(r.ticker, eligibility ?? {}) : null;
              return (
              <TableRow key={r.signature_label} className="hover:bg-muted/20">
                <TableCell className="py-1.5 text-[11px] font-mono font-semibold text-foreground truncate max-w-[320px]">
                  <span className="inline-flex items-center gap-1.5">
                    <span>{r.signature_label}</span>
                    {scope && (
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-[9px] font-mono px-1 py-0 leading-none',
                          dte0DteScopeClass(scope.tone),
                        )}
                        title={`0DTE scope for ${r.ticker}: ${scope.label}`}
                      >
                        {scope.label}
                      </Badge>
                    )}
                  </span>
                </TableCell>
                <TableCell className="py-1.5">
                  <Badge
                    variant="outline"
                    className={cn(
                      'text-[10px] font-mono px-1.5 py-0',
                      dteBucketBadgeClass(r.dte_bucket),
                    )}
                  >
                    {r.dte_bucket}
                  </Badge>
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtInt(r.n_tracks)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums text-muted-foreground">
                  {fmtFractionAsPct(r.median_peak_pct, 0)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtFractionAsPct(r.p75_peak_pct, 0)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  {fmtFractionAsPct(r.p90_peak_pct, 0)}
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right font-mono tabular-nums">
                  <span className="text-emerald-300">{fmtInt(r.win_count)}</span>
                  <span className="text-muted-foreground/40 mx-0.5">/</span>
                  <span className="text-rose-300">{fmtInt(r.loss_count)}</span>
                  <span className="text-muted-foreground/40 mx-0.5">/</span>
                  <span className="text-muted-foreground">{fmtInt(r.working_count)}</span>
                </TableCell>
                <TableCell className="py-1.5 text-[11px] text-right tabular-nums">
                  <span className="inline-flex items-center gap-1.5 justify-end">
                    <HitBar rate={r.hit_rate} />
                    <span className="text-foreground w-10 text-right">
                      {fmtPctRate(r.hit_rate, 0)}
                    </span>
                  </span>
                </TableCell>
                <TableCell className={cn(
                  'py-1.5 text-[11px] text-right font-mono tabular-nums font-semibold',
                  evColorClass(r.expected_value_pct),
                )}>
                  {fmtFractionAsPct(r.expected_value_pct, 0)}
                </TableCell>
              </TableRow>
            );})}
          </TableBody>
        </Table>
      )}
      <div className="px-4 py-2 text-[10px] text-muted-foreground/80 border-t border-border/40">
        <span className="font-semibold">EV</span> = mean peak % treating LOSSes as -loss_threshold.
        Rough "expected return per dollar" if you had bought every print of this signature shape.
        Emerald &gt;50%, amber 0-50%, rose negative.
      </div>
    </Card>
  );
}

// ============================================================================
// Page
// ============================================================================

export default function Edge() {
  const { data: daily } = useEdgeDaily();
  const stamp = daily?.computed_at ?? null;
  const age = computedAtAge(stamp);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-[1600px] mx-auto p-4 space-y-3">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <Target className="w-5 h-5 text-primary" />
              <span>Edge</span>
              <span className="text-sm text-muted-foreground font-normal">
                hedge-fund attribution dashboard
              </span>
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Today's hit rate · slow-burn realizations · promoted signatures · per-ticker scorecards · open tracks · dimension attribution.
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge
              variant="outline"
              className={cn('text-[10px] uppercase tracking-wider font-mono px-2 py-0.5', ageToneClass(age.tone))}
              title={stamp ? `Computed at ${new Date(stamp).toLocaleString()}` : 'No computed_at stamp on the latest ct_edge_daily row'}
            >
              {age.label}
            </Badge>
            <div className="text-[10px] text-muted-foreground tabular-nums">
              {stamp ? `computed ${new Date(stamp).toLocaleString()}` : 'live · 60s refresh'}
            </div>
          </div>
        </header>

        <HeroRow />
        <ThresholdCalibration />
        <SlowBurnPays />
        <WinnersLosers />
        <BestSignatures />
        <SignatureMagnitude />
        <ContractAxisEdge />
        <PerTickerGrid />
        <WorkingTracks />
        <AttributionByDimension />

        <div className="text-[10px] text-muted-foreground leading-relaxed pt-2 space-y-1">
          <div>
            <span className="font-semibold">Snapshot hit</span> = % of graded prints that scored WIN at their immediate snapshot horizon.
            <span className="font-semibold"> Lifetime hit</span> = same, but tracked through the print's full lifetime (incl. slow-burn realizations).
          </div>
          <div>
            <span className="font-semibold">Slow-burn pays</span> = prints that were neutral or losing at snapshot but reached their target later — retroactive attribution.
          </div>
          <div>
            <span className="font-semibold">Edge score</span> = composite per-signature metric weighing lifetime hit, sample, and time-to-realize. Promoted ≥ threshold.
          </div>
        </div>
      </div>
    </div>
  );
}
