/**
 * streakRead — server-side counterpart of the useStreaks frontend hook.
 *
 * Single responsibility: read ct_grades + ct_trades over the last 30d and
 * return a minimal tilt signal used by:
 *   - preTradeGate `tilt` check (warn-only, wave 20)
 *   - firePreTradeQuality tilt_risk context flag (wave 22 cap at 6)
 *   - ct-grader Slack transition push
 *
 * Trade verdict mapping matches the frontend hook exactly:
 *   realized_pnl_pct >  +0.10%  → 'right'
 *   realized_pnl_pct <  -0.10%  → 'wrong'
 *   |realized_pnl_pct| <= 0.10% → 'partial'
 *
 * This read is defensive — any error returns a zero-state instead of
 * throwing, so the gate never hard-fails on a transient Supabase glitch.
 */
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export type StreakVerdict = 'right' | 'partial' | 'wrong' | 'ambiguous';

export interface StreakDot {
  verdict: StreakVerdict;
  ts: string;
  instrument: string | null;
  source: 'grade' | 'trade';
}

export interface TiltSnapshot {
  current_wrong_streak: number;
  current_right_streak: number;
  last_5_right_rate: number | null;
  tilt_risk: boolean;
  tilt_reasons: string[];
  wrong_streak_tickers: string[];
  total_30d: number;
}

const TRADE_FLAT_PCT = 0.1;

function mapTradeVerdict(pnl: number | null): StreakVerdict | null {
  if (pnl == null || !Number.isFinite(pnl)) return null;
  if (pnl > TRADE_FLAT_PCT) return 'right';
  if (pnl < -TRADE_FLAT_PCT) return 'wrong';
  return 'partial';
}

function leadingRun(dots: StreakDot[], verdict: StreakVerdict): number {
  let n = 0;
  for (const d of dots) {
    if (d.verdict === verdict) n += 1;
    else break;
  }
  return n;
}

function wrongTickerSet(dots: StreakDot[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of dots) {
    if (d.verdict !== 'wrong') break;
    if (d.instrument) {
      const up = d.instrument.toUpperCase();
      if (!seen.has(up)) {
        seen.add(up);
        out.push(up);
      }
    }
  }
  return out;
}

export async function readTiltSnapshot(
  supabase: SupabaseClient,
): Promise<TiltSnapshot> {
  const empty: TiltSnapshot = {
    current_wrong_streak: 0,
    current_right_streak: 0,
    last_5_right_rate: null,
    tilt_risk: false,
    tilt_reasons: [],
    wrong_streak_tickers: [],
    total_30d: 0,
  };
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [gradesRes, tradesRes] = await Promise.all([
      supabase
        .from('ct_grades')
        .select('instrument, verdict, graded_at')
        .gte('graded_at', since)
        .order('graded_at', { ascending: false })
        .limit(500),
      supabase
        .from('ct_trades')
        .select('instrument, realized_pnl_pct, closed_at')
        .eq('status', 'closed')
        .not('closed_at', 'is', null)
        .gte('closed_at', since)
        .order('closed_at', { ascending: false })
        .limit(500),
    ]);

    const dots: StreakDot[] = [];
    for (const r of (gradesRes.data ?? []) as Array<{
      instrument: string | null;
      verdict: string;
      graded_at: string;
    }>) {
      const v = (['right', 'partial', 'wrong', 'ambiguous'] as StreakVerdict[]).includes(
        r.verdict as StreakVerdict,
      )
        ? (r.verdict as StreakVerdict)
        : 'ambiguous';
      dots.push({ verdict: v, ts: r.graded_at, instrument: r.instrument, source: 'grade' });
    }
    for (const r of (tradesRes.data ?? []) as Array<{
      instrument: string | null;
      realized_pnl_pct: number | null;
      closed_at: string | null;
    }>) {
      const v = mapTradeVerdict(r.realized_pnl_pct);
      if (!v || !r.closed_at) continue;
      dots.push({ verdict: v, ts: r.closed_at, instrument: r.instrument, source: 'trade' });
    }
    dots.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

    const current_wrong_streak = leadingRun(dots, 'wrong');
    const current_right_streak = leadingRun(dots, 'right');

    const last5 = dots.slice(0, 5);
    const last5Graded = last5.filter(d => d.verdict !== 'ambiguous').length;
    const last5Right = last5.filter(d => d.verdict === 'right').length;
    const last_5_right_rate = last5Graded >= 3 ? last5Right / last5Graded : null;

    const reasons: string[] = [];
    if (current_wrong_streak >= 3) reasons.push(`${current_wrong_streak} wrong in a row`);
    if (last_5_right_rate != null && last_5_right_rate <= 0.4) {
      reasons.push(`last 5 graded: ${Math.round(last_5_right_rate * 100)}% right`);
    }

    return {
      current_wrong_streak,
      current_right_streak,
      last_5_right_rate,
      tilt_risk: reasons.length > 0,
      tilt_reasons: reasons,
      wrong_streak_tickers: wrongTickerSet(dots),
      total_30d: dots.length,
    };
  } catch (e) {
    console.warn('[streakRead] failed, returning empty snapshot:', e instanceof Error ? e.message : e);
    return empty;
  }
}
