/**
 * useStreaks — psychology dashboard for Co-Trader.
 *
 * 3 wrong calls in a row → tilt risk. Humans size up to "win it back" or
 * freeze up; Claude should have similar awareness. The streak tracker
 * surfaces it; the tilt indicator prompts caution.
 *
 * Two parallel streams: GRADES (flags/alerts/james_views) and TRADES
 * (ct_trades closed). Both feed the same verdict alphabet so panels and
 * the TopNav pill can read either the combined view or either-side view.
 *
 * Trade verdict mapping (client-side, since ct_trades does NOT flow through
 * ct_grades):
 *   realized_pnl_pct >  +0.10%  → 'right'
 *   realized_pnl_pct <  -0.10%  → 'wrong'
 *   |realized_pnl_pct| <= 0.10% → 'partial'   (flat/scratch)
 *   null                        → ignored
 *
 * Client-side aggregation. 30-day window. 5-min refresh matches
 * useCalibration — data moves at horizon-close speed, not tick speed.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export type Verdict = 'right' | 'partial' | 'wrong' | 'ambiguous';

/**
 * Minimum graded history required before we trust the tilt signal /
 * heatmap numbers. Below this, the UI shows "insufficient history".
 */
export const MIN_HISTORY = 20;

/** Flat/scratch threshold for trade pnl → verdict mapping. */
const TRADE_FLAT_PCT = 0.1;

/** A graded outcome normalized across ct_grades and ct_trades closes. */
export interface GradeDot {
  id: string;
  source: 'grade' | 'trade';
  verdict: Verdict;
  graded_at: string;
  /** Instrument, if known — drives Slack ticker-set breakdown. */
  instrument: string | null;
}

export interface StreakStats {
  current_right_streak: number;
  current_wrong_streak: number;
  longest_right_streak_30d: number;
  longest_wrong_streak_30d: number;
  last_verdict: Verdict | null;
  /** True if current_wrong_streak >= 3 OR last 5 grades were <=40% right. */
  tilt_risk: boolean;
  /** Reasons the tilt fired — both reasons listed if both fire. */
  tilt_reasons: string[];
  /** Average length of right AND wrong runs in the 30d window. */
  avg_streak_length: number;
  /** Last-20 outcomes, most recent first. Heatmap renders from this. */
  recent: GradeDot[];
  total: number;
}

export interface UseStreaksResult {
  /** All subjects (flags/alerts/james_views + trades). */
  combined: StreakStats;
  /** Grades only — ct_grades rows. */
  grades: StreakStats;
  /** Trades only — ct_trades.status='closed' in last 30d. */
  trades: StreakStats;
  /** Most-frequent instruments in the current wrong streak (for Slack). */
  wrong_streak_tickers: string[];
}

type GradeRow = {
  id: string;
  subject_type: string;
  subject_id: string;
  instrument: string | null;
  verdict: string;
  graded_at: string;
};

type TradeRow = {
  id: string;
  instrument: string | null;
  realized_pnl_pct: number | null;
  closed_at: string | null;
  session_date: string | null;
};

function mapTradeVerdict(pnl: number | null): Verdict | null {
  if (pnl == null || !Number.isFinite(pnl)) return null;
  if (pnl > TRADE_FLAT_PCT) return 'right';
  if (pnl < -TRADE_FLAT_PCT) return 'wrong';
  return 'partial';
}

/** Count the leading run of a given verdict from index 0 (most recent). */
function leadingRun(dots: GradeDot[], verdict: Verdict): number {
  let n = 0;
  for (const d of dots) {
    if (d.verdict === verdict) n += 1;
    else break;
  }
  return n;
}

/** Longest run of a given verdict anywhere in the window. */
function longestRun(dots: GradeDot[], verdict: Verdict): number {
  let best = 0;
  let cur = 0;
  for (const d of dots) {
    if (d.verdict === verdict) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/** Mean length of all right+wrong runs. Partial/ambiguous break runs but don't contribute. */
function averageRunLength(dots: GradeDot[]): number {
  const runs: number[] = [];
  let cur = 0;
  let curKind: Verdict | null = null;
  for (const d of dots) {
    if (d.verdict === 'right' || d.verdict === 'wrong') {
      if (d.verdict === curKind) {
        cur += 1;
      } else {
        if (cur > 0) runs.push(cur);
        cur = 1;
        curKind = d.verdict;
      }
    } else {
      if (cur > 0) runs.push(cur);
      cur = 0;
      curKind = null;
    }
  }
  if (cur > 0) runs.push(cur);
  if (runs.length === 0) return 0;
  return runs.reduce((s, n) => s + n, 0) / runs.length;
}

function computeStats(dots: GradeDot[]): StreakStats {
  const rightStreak = leadingRun(dots, 'right');
  const wrongStreak = leadingRun(dots, 'wrong');

  // Last-5 right rate. Uses dots irrespective of verdict — if the last 5
  // were all ambiguous, right rate = 0/5 and we do NOT trigger on that alone
  // (ambiguous isn't bad execution, it's the referee saying "nothing to
  // measure"). So only trigger when the last-5 window is graded enough.
  const last5 = dots.slice(0, 5);
  const last5Graded = last5.filter(d => d.verdict !== 'ambiguous').length;
  const last5Right = last5.filter(d => d.verdict === 'right').length;
  const last5RightRate = last5Graded >= 3 ? last5Right / last5Graded : null;

  const reasons: string[] = [];
  if (wrongStreak >= 3) reasons.push(`${wrongStreak} wrong in a row`);
  if (last5RightRate != null && last5RightRate <= 0.4) {
    reasons.push(`last 5 graded: ${Math.round(last5RightRate * 100)}% right`);
  }
  const tilt_risk = reasons.length > 0;

  return {
    current_right_streak: rightStreak,
    current_wrong_streak: wrongStreak,
    longest_right_streak_30d: longestRun(dots, 'right'),
    longest_wrong_streak_30d: longestRun(dots, 'wrong'),
    last_verdict: dots[0]?.verdict ?? null,
    tilt_risk,
    tilt_reasons: reasons,
    avg_streak_length: averageRunLength(dots),
    recent: dots.slice(0, 20),
    total: dots.length,
  };
}

/** Pull the top ticker set off the current wrong-streak prefix for Slack copy. */
function wrongStreakTickerBreakdown(dots: GradeDot[]): string[] {
  const run: string[] = [];
  for (const d of dots) {
    if (d.verdict !== 'wrong') break;
    if (d.instrument) run.push(d.instrument);
  }
  // Dedupe preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of run) {
    const up = t.toUpperCase();
    if (!seen.has(up)) {
      seen.add(up);
      out.push(up);
    }
  }
  return out;
}

export function useStreaks() {
  return useQuery<UseStreaksResult>({
    queryKey: ['ct_streaks_30d'],
    refetchInterval: 5 * 60 * 1000,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<UseStreaksResult> => {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

      const [gradesRes, tradesRes] = await Promise.all([
        supabase
          .from('ct_grades')
          .select('id, subject_type, subject_id, instrument, verdict, graded_at')
          .gte('graded_at', since)
          .order('graded_at', { ascending: false })
          .limit(500),
        supabase
          .from('ct_trades')
          .select('id, instrument, realized_pnl_pct, closed_at, session_date')
          .eq('status', 'closed')
          .not('closed_at', 'is', null)
          .gte('closed_at', since)
          .order('closed_at', { ascending: false })
          .limit(500),
      ]);

      const gradeDots: GradeDot[] = ((gradesRes.data ?? []) as GradeRow[])
        .map((r) => ({
          id: r.id,
          source: 'grade' as const,
          verdict: (['right', 'partial', 'wrong', 'ambiguous'] as Verdict[])
            .includes(r.verdict as Verdict)
            ? (r.verdict as Verdict)
            : 'ambiguous',
          graded_at: r.graded_at,
          instrument: r.instrument ?? null,
        }));

      const tradeDots: GradeDot[] = [];
      for (const r of (tradesRes.data ?? []) as TradeRow[]) {
        const verdict = mapTradeVerdict(r.realized_pnl_pct);
        if (!verdict) continue;
        // closed_at is guaranteed non-null by the .not() filter, but TS narrow
        const ts = r.closed_at ?? r.session_date ?? new Date().toISOString();
        tradeDots.push({
          id: r.id,
          source: 'trade',
          verdict,
          graded_at: ts,
          instrument: r.instrument ?? null,
        });
      }

      // Combined view re-sorts by timestamp DESC so streak logic sees real
      // chronological order across both streams.
      const combinedDots = [...gradeDots, ...tradeDots].sort(
        (a, b) => new Date(b.graded_at).getTime() - new Date(a.graded_at).getTime(),
      );

      const combined = computeStats(combinedDots);
      const grades = computeStats(gradeDots);
      const trades = computeStats(tradeDots);

      return {
        combined,
        grades,
        trades,
        wrong_streak_tickers: wrongStreakTickerBreakdown(combinedDots),
      };
    },
  });
}

/**
 * Historical next-outcome win rate after an N-wrong streak in the 30d window.
 * Walks the combined dots DESC, finds every place where a run of N consecutive
 * 'wrong' is followed by another graded outcome, and returns:
 *   hits    = how many N-wrong runs we found
 *   nextWin = count where the following outcome was 'right'
 *   rate    = nextWin / hits (null if hits === 0)
 *
 * The input `dots` is expected most-recent-first. Because the next outcome
 * for tilt psychology means "the one that came AFTER the streak broke", we
 * flip to oldest-first internally and scan forward.
 */
export function nextOutcomeAfterNWrong(
  dots: GradeDot[],
  n: number,
): { hits: number; nextWin: number; rate: number | null } {
  if (n <= 0) return { hits: 0, nextWin: 0, rate: null };
  const oldestFirst = [...dots].reverse();
  let hits = 0;
  let nextWin = 0;
  for (let i = 0; i + n < oldestFirst.length; i++) {
    let streak = true;
    for (let k = 0; k < n; k++) {
      if (oldestFirst[i + k].verdict !== 'wrong') {
        streak = false;
        break;
      }
    }
    if (!streak) continue;
    const next = oldestFirst[i + n];
    if (next.verdict === 'ambiguous') continue; // skip unmeasurable
    hits += 1;
    if (next.verdict === 'right') nextWin += 1;
    i += n - 1; // don't double-count overlapping streaks
  }
  return {
    hits,
    nextWin,
    rate: hits > 0 ? nextWin / hits : null,
  };
}
