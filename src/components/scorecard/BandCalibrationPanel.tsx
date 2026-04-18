/**
 * BandCalibrationPanel — magnitude calibration for wave 17 expected_move claims.
 *
 * Reads ct_grades rows where band_hit IS NOT NULL (i.e. the flag/alert had an
 * expected_move claim at write time and the grader scored it at horizon close).
 *
 * Stats:
 *   - Overall band hit rate ("claimed 70% conf bands hit X% of the time")
 *   - Aggregate overconfidence gap ("18pp overconfident" = claimed 70, hit 52)
 *   - Histogram of band_calibration_delta — shows the SHAPE of the miss:
 *     are most deltas clustered near 0 (well-calibrated) or fat-tailed
 *     right (systemically overconfident)?
 *
 * Feeds directly into useRiskMetrics.forwardExpectancy — when the panel
 * shows a large overconfidence gap, Claude's claimed magnitudes are
 * systematically outsized relative to what actually happens.
 *
 * Reads directly from ct_grades (no hook indirection — this panel's
 * query is specific enough that bolting it onto useRiskMetrics would
 * pull unrelated data).
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Target } from 'lucide-react';
import { ChartSafe } from '@/components/ChartSafe';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
  Cell,
} from 'recharts';

const MUTED = 'hsl(var(--muted-foreground))';
const GREEN = '#00C853';
const AMBER = '#F59E0B';
const RED = '#FF1744';

interface BandGradeRow {
  graded_at: string;
  band_hit: boolean;
  band_low_pct: number;
  band_high_pct: number;
  band_confidence_pct: number;
  band_calibration_delta: number;
}

/**
 * Delta bucket edges — signed, in percentage points of confidence claim.
 *   - Negative deltas = underconfident (claimed 50% conf, hit band).
 *     Range (-100, 0]. Bucket to 10pp resolution.
 *   - Positive deltas = overconfident (claimed 90% conf, missed band).
 *     Range [0, 100]. Bucket to 10pp resolution.
 * Center bucket straddles zero (perfectly calibrated ≈ 0).
 */
const BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: '-100..-80', min: -100, max: -80 },
  { label: '-80..-60', min: -80, max: -60 },
  { label: '-60..-40', min: -60, max: -40 },
  { label: '-40..-20', min: -40, max: -20 },
  { label: '-20..0', min: -20, max: 0 },
  // 0 can represent a "claimed 100, hit" or "claimed 0, missed" — neither
  // should occur under the 50-90 validation rubric, but the edge is kept
  // inclusive on the overconfident side so it's never lost.
  { label: '0..20', min: 0, max: 20 },
  { label: '20..40', min: 20, max: 40 },
  { label: '40..60', min: 40, max: 60 },
  { label: '60..80', min: 60, max: 80 },
  { label: '80..100', min: 80, max: 100 },
];

function bucketColor(min: number, max: number): string {
  const center = (min + max) / 2;
  if (Math.abs(center) <= 20) return GREEN;
  if (Math.abs(center) <= 60) return AMBER;
  return RED;
}

function useBandGrades() {
  return useQuery<BandGradeRow[]>({
    queryKey: ['band_calibration_grades'],
    refetchInterval: 60_000,
    staleTime: 60_000,
    queryFn: async () => {
      // band_hit IS NOT NULL = v1.3+ grades that had an expected_move claim.
      // Pre-v1.3 grades are filtered at the DB, not null-filled.
      const { data, error } = await supabase
        .from('ct_grades')
        .select('graded_at, band_hit, band_low_pct, band_high_pct, band_confidence_pct, band_calibration_delta')
        .not('band_hit', 'is', null)
        .order('graded_at', { ascending: false })
        .limit(2000);
      if (error) throw error;
      const rows = (data ?? []) as Array<{
        graded_at: string;
        band_hit: boolean | null;
        band_low_pct: number | null;
        band_high_pct: number | null;
        band_confidence_pct: number | null;
        band_calibration_delta: number | null;
      }>;
      const out: BandGradeRow[] = [];
      for (const r of rows) {
        if (
          r.band_hit == null ||
          r.band_low_pct == null || !Number.isFinite(r.band_low_pct) ||
          r.band_high_pct == null || !Number.isFinite(r.band_high_pct) ||
          r.band_confidence_pct == null || !Number.isFinite(r.band_confidence_pct) ||
          r.band_calibration_delta == null || !Number.isFinite(r.band_calibration_delta)
        ) continue;
        out.push({
          graded_at: r.graded_at,
          band_hit: r.band_hit,
          band_low_pct: r.band_low_pct,
          band_high_pct: r.band_high_pct,
          band_confidence_pct: r.band_confidence_pct,
          band_calibration_delta: r.band_calibration_delta,
        });
      }
      return out;
    },
  });
}

export function BandCalibrationPanel() {
  const { data: rows, isLoading } = useBandGrades();

  const stats = useMemo(() => {
    if (!rows || rows.length === 0) return null;

    const n = rows.length;
    const hits = rows.reduce((s, r) => s + (r.band_hit ? 1 : 0), 0);
    const meanClaimedConf = rows.reduce((s, r) => s + r.band_confidence_pct, 0) / n;
    const hitRate = hits / n;
    const gapPp = meanClaimedConf - hitRate * 100;
    const meanDelta = rows.reduce((s, r) => s + r.band_calibration_delta, 0) / n;

    // Histogram — place each delta into its 20pp bucket.
    const buckets = BUCKETS.map((b) => ({ ...b, count: 0 }));
    for (const r of rows) {
      const d = r.band_calibration_delta;
      // Right-edge exclusive except for the very last bucket which is inclusive
      // so delta = +100 (claim 100 miss — can't happen under 50-90 rubric but
      // defensive) still lands somewhere.
      for (let i = 0; i < buckets.length; i++) {
        const b = buckets[i];
        const isLast = i === buckets.length - 1;
        const within = isLast ? d >= b.min && d <= b.max : d >= b.min && d < b.max;
        if (within) {
          b.count += 1;
          break;
        }
      }
    }

    const chartData = buckets.map((b) => ({
      label: b.label,
      count: b.count,
      fill: bucketColor(b.min, b.max),
    }));

    return { n, hits, hitRate, meanClaimedConf, gapPp, meanDelta, chartData };
  }, [rows]);

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground mb-3">
        <Target className="w-3 h-3" /> Band Calibration
        <span className="normal-case tracking-normal text-muted-foreground/70">
          — did actual move fall inside Claude's claimed [low_pct, high_pct]?
        </span>
        <span className="ml-auto normal-case tracking-normal font-mono">
          n={stats?.n ?? 0}
        </span>
      </div>

      {isLoading ? (
        <div className="text-xs text-muted-foreground py-6 text-center">loading…</div>
      ) : !stats ? (
        <div className="text-xs text-muted-foreground py-6 text-center">
          no banded grades yet — expected_move lands on flags/alerts after v1.3,
          and band scores populate at horizon close.
        </div>
      ) : (
        <div className="space-y-3">
          {/* Headline stat */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div className="bg-muted/20 rounded p-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Hit Rate
              </div>
              <div
                className={`text-xl font-bold ${
                  stats.hitRate >= 0.6
                    ? 'text-green-400'
                    : stats.hitRate >= 0.4
                      ? 'text-amber-400'
                      : 'text-red-400'
                }`}
              >
                {(stats.hitRate * 100).toFixed(0)}%
              </div>
              <div className="text-[10px] text-muted-foreground">
                {stats.hits}/{stats.n}
              </div>
            </div>
            <div className="bg-muted/20 rounded p-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Avg Claimed Conf
              </div>
              <div className="text-xl font-bold text-foreground">
                {stats.meanClaimedConf.toFixed(0)}%
              </div>
              <div className="text-[10px] text-muted-foreground">
                rubric range 50-90
              </div>
            </div>
            <div className="bg-muted/20 rounded p-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Conf Gap
              </div>
              <div
                className={`text-xl font-bold ${
                  stats.gapPp > 10
                    ? 'text-red-400'
                    : stats.gapPp < -10
                      ? 'text-green-400'
                      : 'text-foreground'
                }`}
              >
                {stats.gapPp >= 0 ? '+' : ''}
                {stats.gapPp.toFixed(1)}pp
              </div>
              <div className="text-[10px] text-muted-foreground">
                {stats.gapPp > 0 ? 'overconfident' : stats.gapPp < 0 ? 'underconfident' : 'calibrated'}
              </div>
            </div>
            <div className="bg-muted/20 rounded p-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Mean Delta
              </div>
              <div className="text-xl font-bold text-foreground">
                {stats.meanDelta >= 0 ? '+' : ''}
                {stats.meanDelta.toFixed(1)}
              </div>
              <div className="text-[10px] text-muted-foreground">per-call avg</div>
            </div>
          </div>

          {/* Headline copy — "claimed X% conf bands hit Y% of the time = Zpp overconfident" */}
          <div className="text-xs text-foreground/90 font-mono bg-muted/10 rounded px-3 py-2 border border-border/40">
            Claimed <span className="font-semibold">{stats.meanClaimedConf.toFixed(0)}%</span> conf bands hit{' '}
            <span className="font-semibold">{(stats.hitRate * 100).toFixed(0)}%</span> of the time ={' '}
            <span
              className={`font-semibold ${
                stats.gapPp > 10 ? 'text-red-400' : stats.gapPp < -10 ? 'text-green-400' : 'text-foreground'
              }`}
            >
              {Math.abs(stats.gapPp).toFixed(1)}pp {stats.gapPp > 0 ? 'overconfident' : stats.gapPp < 0 ? 'underconfident' : 'calibrated'}
            </span>
          </div>

          {/* Histogram */}
          <div style={{ height: 220 }}>
            <ChartSafe label="band delta histogram">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.chartData} margin={{ top: 16, right: 16, left: 0, bottom: 4 }}>
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 9, fill: MUTED }}
                    axisLine={false}
                    tickLine={false}
                    label={{
                      value: 'band_calibration_delta (pp)',
                      position: 'insideBottom',
                      offset: -2,
                      fontSize: 9,
                      fill: MUTED,
                    }}
                  />
                  <YAxis
                    tick={{ fontSize: 9, fill: MUTED }}
                    axisLine={false}
                    tickLine={false}
                    width={28}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'hsl(var(--popover))',
                      border: '1px solid hsl(var(--border))',
                      fontSize: '10px',
                      padding: '6px 8px',
                    }}
                    formatter={(value: number) => [String(value), 'count']}
                    labelFormatter={(label) => `delta ${label}pp`}
                  />
                  <ReferenceLine x="-20..0" stroke="hsl(var(--border))" strokeDasharray="2 2" />
                  <Bar dataKey="count" isAnimationActive={false} radius={[3, 3, 0, 0]}>
                    {stats.chartData.map((d, i) => (
                      <Cell key={i} fill={d.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartSafe>
          </div>

          <div className="text-[10px] text-muted-foreground leading-relaxed">
            <span className="text-foreground/80 font-semibold">Read this:</span>{' '}
            Delta = claimed_confidence_pct − (band_hit ? 100 : 0). Positive = overconfident
            (claimed high, missed band). Negative = underconfident (claimed low, hit anyway).
            A well-calibrated Claude has a mass centered near the -20..0 bucket
            (confidence matches observed hit rate). Mass piled at the right
            (+40 and up) means systemic overconfidence in magnitude claims.
            Feeds <span className="font-mono">forwardExpectancy</span> in useRiskMetrics.
          </div>
        </div>
      )}
    </Card>
  );
}

export default BandCalibrationPanel;
