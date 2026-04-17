/**
 * Grader helpers — score a flag/alert/james_view against actual outcome.
 *
 * Current-price source: UW spot-exposures/strike (has `price` on each row,
 * current underlying). Reuses uwClient.
 *
 * Verdict rubric (simple Day 3 baseline; tune in Day 8):
 *   - FLAT if |return| < 0.3%
 *   - Direction match: bullish + positive return, bearish + negative, etc.
 *   - VOLATILITY: right if |return| ≥ 0.5% regardless of sign
 *   - NEUTRAL: right if FLAT
 *   - Otherwise wrong
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { getSpotGexByStrike } from './uwClient.ts';

export type Direction = 'bullish' | 'bearish' | 'neutral' | 'volatility';
export type ActualDirection = 'bullish' | 'bearish' | 'flat';
export type Verdict = 'right' | 'wrong' | 'ambiguous' | 'partial';

const FLAT_THRESHOLD = 0.3;          // below this, it's flat (percent)
const VOL_THRESHOLD  = 0.5;          // volatility call needs this magnitude

export async function getCurrentPrice(ticker: string): Promise<number | null> {
  try {
    const raw = await getSpotGexByStrike(ticker);
    if (!raw || typeof raw !== 'object') return null;
    const data = (raw as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0] as Record<string, unknown>;
    const p = typeof first.price === 'string' ? parseFloat(first.price) : (first.price as number | undefined);
    return Number.isFinite(p as number) ? (p as number) : null;
  } catch (e) {
    console.warn(`[ctGrader] price fetch failed for ${ticker}:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export function classifyActualDirection(pct: number): ActualDirection {
  if (Math.abs(pct) < FLAT_THRESHOLD) return 'flat';
  return pct > 0 ? 'bullish' : 'bearish';
}

export function computeVerdict(
  claimed: Direction,
  actualPct: number,
  actualDir: ActualDirection,
): Verdict {
  const mag = Math.abs(actualPct);

  if (claimed === 'volatility') {
    return mag >= VOL_THRESHOLD ? 'right' : 'wrong';
  }
  if (claimed === 'neutral') {
    return actualDir === 'flat' ? 'right' : (mag < VOL_THRESHOLD ? 'partial' : 'wrong');
  }
  if (claimed === 'bullish') {
    if (actualDir === 'bullish') return 'right';
    if (actualDir === 'flat') return 'partial';
    return 'wrong';
  }
  if (claimed === 'bearish') {
    if (actualDir === 'bearish') return 'right';
    if (actualDir === 'flat') return 'partial';
    return 'wrong';
  }
  return 'ambiguous';
}

/**
 * Compute calibration delta — how far off were stated odds from reality?
 * Only meaningful for directional flags. Zero for volatility/neutral calls.
 */
export function computeCalibrationDelta(
  claimedOddsUp: number | null,
  claimedOddsDown: number | null,
  actualDir: ActualDirection,
): number | null {
  if (claimedOddsUp == null || claimedOddsDown == null) return null;
  const realized = actualDir === 'bullish' ? 100 : actualDir === 'bearish' ? 0 : 50;
  // Delta = how wrong the up_odds claim was.
  return claimedOddsUp - realized;
}

export interface GradeResult {
  verdict: Verdict;
  actualReturnPct: number;
  actualDirection: ActualDirection;
  entryPrice: number;
  exitPrice: number;
  calibrationDelta: number | null;
}

export function gradeOne(params: {
  claimedDirection: Direction;
  claimedOddsUp: number | null;
  claimedOddsDown: number | null;
  entryPrice: number;
  exitPrice: number;
}): GradeResult {
  const pct = ((params.exitPrice - params.entryPrice) / params.entryPrice) * 100;
  const actualDir = classifyActualDirection(pct);
  return {
    verdict: computeVerdict(params.claimedDirection, pct, actualDir),
    actualReturnPct: Number(pct.toFixed(4)),
    actualDirection: actualDir,
    entryPrice: params.entryPrice,
    exitPrice: params.exitPrice,
    calibrationDelta: computeCalibrationDelta(params.claimedOddsUp, params.claimedOddsDown, actualDir),
  };
}

/**
 * Batch-grade a list of flag/alert/james_view rows.
 * Mutates DB: inserts ct_grades rows + updates grade_id on subject rows.
 * Returns per-item results.
 */
export async function gradeSubjects(
  supabase: SupabaseClient,
  subjects: Array<{
    subject_type: 'flag' | 'alert' | 'james_view';
    subject_id: string;
    instrument: string;
    direction: Direction;
    odds_up: number | null;
    odds_down: number | null;
    entry_price: number;
  }>,
): Promise<Array<{ subject_id: string; ok: boolean; verdict?: Verdict; error?: string }>> {
  const out: Array<{ subject_id: string; ok: boolean; verdict?: Verdict; error?: string }> = [];

  // Group by instrument — we'll fetch each price once and reuse
  const byInstrument = new Map<string, typeof subjects>();
  for (const s of subjects) {
    const list = byInstrument.get(s.instrument) ?? [];
    list.push(s);
    byInstrument.set(s.instrument, list);
  }

  for (const [instrument, list] of byInstrument) {
    const exitPrice = await getCurrentPrice(instrument);
    if (exitPrice == null) {
      for (const s of list) out.push({ subject_id: s.subject_id, ok: false, error: `no exit price for ${instrument}` });
      continue;
    }

    for (const s of list) {
      if (!Number.isFinite(s.entry_price)) {
        out.push({ subject_id: s.subject_id, ok: false, error: `invalid entry price` });
        continue;
      }
      const grade = gradeOne({
        claimedDirection: s.direction,
        claimedOddsUp: s.odds_up,
        claimedOddsDown: s.odds_down,
        entryPrice: s.entry_price,
        exitPrice,
      });

      // Insert grade
      const { data, error } = await supabase.from('ct_grades').insert({
        subject_type: s.subject_type,
        subject_id: s.subject_id,
        instrument,
        claimed_direction: s.direction,
        claimed_odds_up: s.odds_up,
        claimed_odds_down: s.odds_down,
        entry_price: s.entry_price,
        exit_price: exitPrice,
        actual_return_pct: grade.actualReturnPct,
        actual_direction: grade.actualDirection,
        verdict: grade.verdict,
        calibration_delta: grade.calibrationDelta,
      }).select('id').maybeSingle();

      if (error || !data) {
        out.push({ subject_id: s.subject_id, ok: false, error: error?.message ?? 'insert failed' });
        continue;
      }

      // Update subject's grade_id pointer
      const tableMap: Record<typeof s.subject_type, string> = {
        flag: 'ct_flags',
        alert: 'ct_alerts',
        james_view: 'ct_james_views',
      } as const;
      await supabase.from(tableMap[s.subject_type])
        .update({ grade_id: data.id })
        .eq('id', s.subject_id);

      out.push({ subject_id: s.subject_id, ok: true, verdict: grade.verdict });
    }
  }

  return out;
}
