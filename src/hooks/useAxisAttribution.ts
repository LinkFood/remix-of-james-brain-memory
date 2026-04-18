/**
 * useAxisAttribution — P&L attribution by evidence axis (A..F).
 *
 * Wave 17 added `evidence_axes text[]` to ct_alerts + ct_flags. Every ALERT/FLAG
 * Claude writes cites which axes its evidence spans:
 *   A = Structural        (walls, flip, regime)
 *   B = Institutional flow (DP, blocks, whale calls)
 *   C = Dealer flow        (delta, net prem, NOPE)
 *   D = Positioning/velocity (OIC, call/put velocity, IV rank)
 *   E = Catalyst          (news, event, earnings)
 *   F = Memory/history    (prior setups, graded outcomes, bias)
 *
 * The meta-calibration question: which axes actually predict? An alert that
 * cites A+B+C contributes one sample to A, one to B, one to C. No weighting —
 * we unnest and aggregate. If axis A calls hit 45% but axis C calls hit 70%,
 * that's a signal for the watcher prompt (bump C, dampen A).
 *
 * NOTE: All pre-v1.3 alerts have empty evidence_axes. The hook returns
 * `{ axes: [], sample: 0, ... }` until real data starts landing — the panel
 * degrades gracefully with an "axis attribution requires v1.3+ alerts" message.
 *
 * 5-minute refresh — data moves at horizon-close speed, not tick speed.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const AXIS_KEYS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export type AxisKey = (typeof AXIS_KEYS)[number];

export const AXIS_NAMES: Record<AxisKey, string> = {
  A: 'Structural',
  B: 'Institutional flow',
  C: 'Dealer flow',
  D: 'Positioning/velocity',
  E: 'Catalyst',
  F: 'Memory/history',
};

export const AXIS_DESCRIPTIONS: Record<AxisKey, string> = {
  A: 'walls, flip, regime',
  B: 'DP, blocks, whale calls',
  C: 'delta, net prem, NOPE',
  D: 'OIC, call/put velocity, IV rank',
  E: 'news, event, earnings',
  F: 'prior setups, graded outcomes, bias',
};

export interface AxisStat {
  axis: AxisKey;
  name: string;
  description: string;
  /** how many alerts/flags cited this axis (graded + ungraded) */
  count: number;
  /** graded subset count */
  graded: number;
  right: number;
  partial: number;
  wrong: number;
  ambiguous: number;
  /** right / (right + partial + wrong); ambiguous excluded. null if no graded. */
  win_rate: number | null;
  /** avg actual_return_pct across graded samples, direction-adjusted by grader */
  avg_return_pct: number | null;
  /** avg R-multiple. null — not stored on ct_alerts/ct_flags; surfaced via trades separately */
  avg_r: number | null;
  /** top co-cited axis: the other axis most often appearing alongside this one */
  top_co_cited: AxisKey | null;
  /** % of this axis's rows that also cite the top co-cited axis */
  top_co_cited_pct: number | null;
  /** true when graded < MIN_SAMPLE — panel renders "insufficient sample" */
  insufficient: boolean;
}

export interface AxisAttributionData {
  axes: AxisStat[];
  /** total rows with non-empty evidence_axes (graded + ungraded) */
  sample: number;
  /** graded rows only */
  graded_sample: number;
  /** 6x6 co-citation matrix. matrix[row][col] = P(col | row),
   *  i.e. "when row is cited, col is also cited N% of the time".
   *  Diagonal is always 1 (or null if row never cited). */
  co_citation_matrix: Record<AxisKey, Record<AxisKey, number | null>>;
  /** raw co-citation counts: co_counts[A][B] = how many rows cited both A AND B */
  co_counts: Record<AxisKey, Record<AxisKey, number>>;
  /** per-axis citation count (same as axes[i].count but keyed for matrix math) */
  axis_counts: Record<AxisKey, number>;
  most_reliable: AxisStat | null;
  least_reliable: AxisStat | null;
  /** true when no rows have evidence_axes populated — triggers v1.3 empty state */
  empty: boolean;
}

type ClaimRow = {
  id: string;
  evidence_axes: string[] | null;
};

type GradeRow = {
  subject_type: string;
  subject_id: string;
  verdict: string;
  actual_return_pct: number | null;
};

const MIN_SAMPLE = 3;

function isAxisKey(s: string): s is AxisKey {
  return (AXIS_KEYS as readonly string[]).includes(s);
}

function emptyCoMatrix<T>(fill: T): Record<AxisKey, Record<AxisKey, T>> {
  const out = {} as Record<AxisKey, Record<AxisKey, T>>;
  for (const row of AXIS_KEYS) {
    out[row] = {} as Record<AxisKey, T>;
    for (const col of AXIS_KEYS) out[row][col] = fill;
  }
  return out;
}

export function useAxisAttribution() {
  return useQuery<AxisAttributionData>({
    queryKey: ['ct_axis_attribution'],
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<AxisAttributionData> => {
      // Pull ALERTs + FLAGs with non-empty evidence_axes, and all grades.
      // Supabase cannot filter "non-empty array" directly — we filter client-side
      // after the fetch. Cap at 5k rows per table to bound work.
      const [flagsRes, alertsRes, gradesRes] = await Promise.all([
        supabase
          .from('ct_flags')
          .select('id, evidence_axes')
          .limit(5000),
        supabase
          .from('ct_alerts')
          .select('id, evidence_axes')
          .limit(5000),
        supabase
          .from('ct_grades')
          .select('subject_type, subject_id, verdict, actual_return_pct')
          .in('subject_type', ['flag', 'alert'])
          .limit(5000),
      ]);

      const flagRows = ((flagsRes.data ?? []) as ClaimRow[]).filter(
        (r) => Array.isArray(r.evidence_axes) && r.evidence_axes.length > 0,
      );
      const alertRows = ((alertsRes.data ?? []) as ClaimRow[]).filter(
        (r) => Array.isArray(r.evidence_axes) && r.evidence_axes.length > 0,
      );

      const flagAxes = new Map<string, AxisKey[]>();
      for (const r of flagRows) {
        flagAxes.set(
          r.id,
          (r.evidence_axes ?? []).filter(isAxisKey) as AxisKey[],
        );
      }
      const alertAxes = new Map<string, AxisKey[]>();
      for (const r of alertRows) {
        alertAxes.set(
          r.id,
          (r.evidence_axes ?? []).filter(isAxisKey) as AxisKey[],
        );
      }

      const grades = (gradesRes.data ?? []) as GradeRow[];

      // Per-axis accumulators.
      const perAxis = {} as Record<
        AxisKey,
        {
          count: number;
          graded: number;
          right: number;
          partial: number;
          wrong: number;
          ambiguous: number;
          return_sum: number;
          return_n: number;
        }
      >;
      for (const k of AXIS_KEYS) {
        perAxis[k] = {
          count: 0,
          graded: 0,
          right: 0,
          partial: 0,
          wrong: 0,
          ambiguous: 0,
          return_sum: 0,
          return_n: 0,
        };
      }

      const coCounts = emptyCoMatrix<number>(0);

      // Pass 1: every claim row (graded or not) contributes to count + co-citation.
      // Pattern: for each row's axis list, bump perAxis[axis].count for each axis,
      // and bump coCounts[a][b] for every ordered pair (a, b) including a === b.
      // This is the unnest step — an alert citing [A, B, C] counts once in A, once
      // in B, once in C; the cell coCounts[A][B] gets +1, coCounts[A][C] +1, etc.
      const allRows: Array<{ id: string; axes: AxisKey[] }> = [];
      for (const [id, axes] of flagAxes) allRows.push({ id, axes });
      for (const [id, axes] of alertAxes) allRows.push({ id, axes });

      for (const row of allRows) {
        // Dedupe within a row — if Claude accidentally cites A twice, count once.
        const uniq = Array.from(new Set(row.axes));
        for (const a of uniq) perAxis[a].count += 1;
        for (const a of uniq) {
          for (const b of uniq) {
            coCounts[a][b] += 1;
          }
        }
      }

      // Pass 2: apply grades. Each graded row fans out to every axis it cited,
      // so a graded alert citing [A, B, C] contributes its verdict to all three.
      for (const g of grades) {
        const axes =
          g.subject_type === 'flag'
            ? flagAxes.get(g.subject_id)
            : g.subject_type === 'alert'
              ? alertAxes.get(g.subject_id)
              : undefined;
        if (!axes || axes.length === 0) continue;
        const uniq = Array.from(new Set(axes));
        for (const a of uniq) {
          const bucket = perAxis[a];
          bucket.graded += 1;
          if (g.verdict === 'right') bucket.right += 1;
          else if (g.verdict === 'partial') bucket.partial += 1;
          else if (g.verdict === 'wrong') bucket.wrong += 1;
          else if (g.verdict === 'ambiguous') bucket.ambiguous += 1;
          if (g.actual_return_pct != null && Number.isFinite(g.actual_return_pct)) {
            bucket.return_sum += g.actual_return_pct;
            bucket.return_n += 1;
          }
        }
      }

      // Build co-citation matrix: matrix[row][col] = P(col | row) =
      // coCounts[row][col] / count(row). Diagonal works out to 1 (row always
      // co-cited with itself). Returns null when row has zero citations.
      const matrix = emptyCoMatrix<number | null>(null);
      const axisCounts = {} as Record<AxisKey, number>;
      for (const row of AXIS_KEYS) {
        const rowTotal = perAxis[row].count;
        axisCounts[row] = rowTotal;
        if (rowTotal === 0) continue;
        for (const col of AXIS_KEYS) {
          matrix[row][col] = coCounts[row][col] / rowTotal;
        }
      }

      // Top co-cited axis per axis: pick the other axis (col !== row) with the
      // highest conditional probability. Skip when row has no citations.
      const axes: AxisStat[] = AXIS_KEYS.map((a) => {
        const b = perAxis[a];
        const denom = b.right + b.partial + b.wrong;
        const win_rate = denom > 0 ? b.right / denom : null;
        const avg_return_pct = b.return_n > 0 ? b.return_sum / b.return_n : null;

        let top: AxisKey | null = null;
        let topPct: number | null = null;
        if (b.count > 0) {
          for (const other of AXIS_KEYS) {
            if (other === a) continue;
            const p = matrix[a][other];
            if (p == null) continue;
            if (topPct == null || p > topPct) {
              topPct = p;
              top = other;
            }
          }
          // Treat 0% co-citation as "no co-cite pattern" — cleaner empty cell.
          if (topPct === 0) {
            top = null;
            topPct = null;
          }
        }

        return {
          axis: a,
          name: AXIS_NAMES[a],
          description: AXIS_DESCRIPTIONS[a],
          count: b.count,
          graded: b.graded,
          right: b.right,
          partial: b.partial,
          wrong: b.wrong,
          ambiguous: b.ambiguous,
          win_rate,
          avg_return_pct,
          avg_r: null, // R-multiple not stored on ct_alerts/ct_flags (stop_price lives on ct_trades)
          top_co_cited: top,
          top_co_cited_pct: topPct,
          insufficient: b.graded < MIN_SAMPLE,
        };
      });

      // Sort by win_rate desc, nulls last. Ties broken by graded count desc
      // so "best with most evidence" wins over "best with tiny sample".
      const sorted = [...axes].sort((x, y) => {
        if (x.win_rate == null && y.win_rate == null) return y.graded - x.graded;
        if (x.win_rate == null) return 1;
        if (y.win_rate == null) return -1;
        if (x.win_rate !== y.win_rate) return y.win_rate - x.win_rate;
        return y.graded - x.graded;
      });

      const qualified = sorted.filter((a) => !a.insufficient);
      const most_reliable = qualified.length > 0 ? qualified[0] : null;
      const least_reliable =
        qualified.length > 1 ? qualified[qualified.length - 1] : null;

      const sample = allRows.length;
      const graded_sample = axes.reduce((s, a) => s + a.graded, 0); // note: this double-counts when a row cites multiple axes
      // For "is there any data?" we use row count, not the fanned-out sum.

      return {
        axes: sorted,
        sample,
        graded_sample,
        co_citation_matrix: matrix,
        co_counts: coCounts,
        axis_counts: axisCounts,
        most_reliable,
        least_reliable,
        empty: sample === 0,
      };
    },
  });
}
