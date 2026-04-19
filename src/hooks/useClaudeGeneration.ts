/**
 * useClaudeGeneration — generational state hooks for the Workspace dashboard.
 *
 * Tenet 14 (survival + cost-of-inaction + performance target) is the reason
 * these hooks exist. Each Claude generation gets $50k, 14 trading days, a
 * $60k target, a $30k survival floor. Firing is not death — the account
 * resets, memory persists.
 *
 * The StatusCard pulls current-generation state every 60s; the lineage list
 * (past generations) refreshes every 5 minutes since it only changes when
 * a generation ends.
 *
 * Tables are not in generated supabase types yet — we cast via `any` same as
 * useClaudeBook / useClaudeState. Migration 20260422000017 is the truth.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useClaudeBook } from './useClaudeBook';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb = supabase as any;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type GenerationStatus = 'active' | 'fired' | 'succeeded' | 'abandoned';
export type FireReason =
  | 'survival_breach'
  | 'performance_floor'
  | 'time_cap'
  | 'hallucination_cascade'
  | 'manual_reset'
  | 'target_hit'
  | null;

/**
 * Output of the `current_claude_generation()` RPC. Days_elapsed/remaining are
 * derived server-side via `EXTRACT(day FROM now() - started_at)`, clamped via
 * `target_days - days_elapsed`. Can be null when no active generation.
 */
export interface ClaudeGeneration {
  id: string;
  generation_number: number;
  started_at: string;
  target_balance_usd: number;
  starting_balance_usd: number;
  survival_floor_usd: number;
  target_days: number;
  days_elapsed: number;
  days_remaining: number;
  // Optional fields populated for past-generation rows only
  status?: GenerationStatus;
  ended_at?: string | null;
  fire_reason?: FireReason;
  ending_balance_usd?: number | null;
  total_return_pct?: number | null;
  max_drawdown_pct?: number | null;
  days_lived?: number | null;
  total_trades?: number | null;
  wins?: number | null;
  losses?: number | null;
  hallucinations_flagged?: number | null;
  circuit_breakers_tripped?: number | null;
  signal_categories_used?: string[] | null;
  predecessor_id?: string | null;
  lessons_applied?: string[] | null;
  best_hypothesis_id?: string | null;
}

// ---------------------------------------------------------------------------
// Current generation — RPC-backed, refreshes every 60s.
// ---------------------------------------------------------------------------
export function useCurrentGeneration() {
  return useQuery<ClaudeGeneration | null>({
    queryKey: ['current_claude_generation'],
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await sb.rpc('current_claude_generation');
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      return {
        id: row.id as string,
        generation_number: row.generation_number as number,
        started_at: row.started_at as string,
        starting_balance_usd: Number(row.starting_balance_usd),
        target_balance_usd: Number(row.target_balance_usd),
        survival_floor_usd: Number(row.survival_floor_usd),
        target_days: row.target_days as number,
        days_elapsed: row.days_elapsed as number,
        days_remaining: row.days_remaining as number,
        status: 'active',
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Past generations — completed rows, newest first. Refreshes every 5 min.
// ---------------------------------------------------------------------------
export function usePastGenerations(limit = 5) {
  return useQuery<ClaudeGeneration[]>({
    queryKey: ['ct_claude_generations_past', limit],
    refetchInterval: 300_000,
    queryFn: async () => {
      const { data, error } = await sb
        .from('ct_claude_generations')
        .select('*')
        .neq('status', 'active')
        .order('generation_number', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        generation_number: r.generation_number as number,
        started_at: r.started_at as string,
        ended_at: (r.ended_at as string | null) ?? null,
        status: r.status as GenerationStatus,
        fire_reason: (r.fire_reason as FireReason) ?? null,
        starting_balance_usd: Number(r.starting_balance_usd),
        target_balance_usd: Number(r.target_balance_usd),
        survival_floor_usd: Number(r.survival_floor_usd),
        target_days: r.target_days as number,
        ending_balance_usd:
          r.ending_balance_usd != null ? Number(r.ending_balance_usd) : null,
        total_return_pct:
          r.total_return_pct != null ? Number(r.total_return_pct) : null,
        max_drawdown_pct:
          r.max_drawdown_pct != null ? Number(r.max_drawdown_pct) : null,
        days_lived: (r.days_lived as number | null) ?? null,
        days_elapsed: (r.days_lived as number | null) ?? 0,
        days_remaining: 0,
        total_trades: (r.total_trades as number | null) ?? 0,
        wins: (r.wins as number | null) ?? 0,
        losses: (r.losses as number | null) ?? 0,
        hallucinations_flagged:
          (r.hallucinations_flagged as number | null) ?? 0,
        circuit_breakers_tripped:
          (r.circuit_breakers_tripped as number | null) ?? 0,
        signal_categories_used:
          (r.signal_categories_used as string[] | null) ?? [],
        predecessor_id: (r.predecessor_id as string | null) ?? null,
        lessons_applied: (r.lessons_applied as string[] | null) ?? [],
        best_hypothesis_id: (r.best_hypothesis_id as string | null) ?? null,
      }));
    },
  });
}

// ---------------------------------------------------------------------------
// All generations count — small aggregate used by lineage tab header.
// ---------------------------------------------------------------------------
export function useGenerationLineageCount() {
  return useQuery<number>({
    queryKey: ['ct_claude_generations_count'],
    refetchInterval: 300_000,
    queryFn: async () => {
      const { count, error } = await sb
        .from('ct_claude_generations')
        .select('id', { count: 'estimated', head: true });
      if (error) throw error;
      return count ?? 0;
    },
  });
}

// ---------------------------------------------------------------------------
// Derived generation progress — current balance vs target + survival,
// pace projection, days, ETA.
//
// Pulls latest ct_book row (via useClaudeBook — already cached) and combines
// with the active generation. All math is safe against missing fields; if
// either side is loading we return nulls and let the UI render placeholders.
// ---------------------------------------------------------------------------
export interface GenerationProgress {
  generation: ClaudeGeneration | null;
  currentBalance: number | null;
  // Dollars above starting — positive is profit
  pnlAbsolute: number | null;
  // % of the profit journey completed. 0 = at start, 1 = target hit.
  // Can go negative if Claude is in the red.
  targetProgressPct: number | null;
  // Distance in $ to go before hitting target. 0 if already hit.
  distanceToTarget: number | null;
  // Cushion above survival floor, $. Negative = breached.
  distanceToSurvival: number | null;
  // Survival cushion as a % of the (starting − floor) range. 1 = full room.
  survivalCushionPct: number | null;
  // Average $/day move so far. Null if day 0 (no data).
  paceUsdPerDay: number | null;
  // Projection: at current pace, will Claude hit target before days_remaining
  // runs out? Value is the projected balance at day `target_days`.
  projectedEndingBalance: number | null;
  // true = pace implies target hit in time; false = pace too slow; null = unknown.
  onPaceForTarget: boolean | null;
  isLoading: boolean;
}

export function useGenerationProgress(): GenerationProgress {
  const genQ = useCurrentGeneration();
  const bookQ = useClaudeBook();

  const isLoading = genQ.isLoading || bookQ.isLoading;
  const generation = genQ.data ?? null;
  const bookRows = bookQ.data ?? [];

  // Latest Claude book row (they come sorted ASC). Use ending_balance if
  // present, otherwise fall back to starting_balance of the latest row.
  const latestBook = bookRows.length > 0 ? bookRows[bookRows.length - 1] : null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latestAny = latestBook as any;
  const currentBalance: number | null = latestBook
    ? Number(latestAny?.ending_balance ?? latestAny?.starting_balance ?? null)
    : null;

  if (!generation) {
    return {
      generation: null,
      currentBalance,
      pnlAbsolute: null,
      targetProgressPct: null,
      distanceToTarget: null,
      distanceToSurvival: null,
      survivalCushionPct: null,
      paceUsdPerDay: null,
      projectedEndingBalance: null,
      onPaceForTarget: null,
      isLoading,
    };
  }

  // When the book hasn't ticked yet we fall back to the generation's own
  // starting balance so day-0 looks sane instead of blank.
  const liveBalance =
    currentBalance != null && Number.isFinite(currentBalance)
      ? currentBalance
      : generation.starting_balance_usd;

  const profitJourney =
    generation.target_balance_usd - generation.starting_balance_usd;
  const pnlAbsolute = liveBalance - generation.starting_balance_usd;

  const targetProgressPct =
    profitJourney > 0 ? pnlAbsolute / profitJourney : null;

  const distanceToTarget = Math.max(
    0,
    generation.target_balance_usd - liveBalance,
  );

  const distanceToSurvival = liveBalance - generation.survival_floor_usd;
  const survivalRange =
    generation.starting_balance_usd - generation.survival_floor_usd;
  const survivalCushionPct =
    survivalRange > 0
      ? Math.max(0, Math.min(1, distanceToSurvival / survivalRange))
      : null;

  // Pace — only if at least a full day has elapsed, otherwise the number
  // is meaningless (dividing by 0 or a tiny fractional day).
  const daysElapsedSafe = Math.max(0, generation.days_elapsed);
  const paceUsdPerDay =
    daysElapsedSafe >= 1 ? pnlAbsolute / daysElapsedSafe : null;

  const projectedEndingBalance =
    paceUsdPerDay != null
      ? generation.starting_balance_usd + paceUsdPerDay * generation.target_days
      : null;

  const onPaceForTarget =
    projectedEndingBalance != null
      ? projectedEndingBalance >= generation.target_balance_usd
      : null;

  return {
    generation,
    currentBalance: liveBalance,
    pnlAbsolute,
    targetProgressPct,
    distanceToTarget,
    distanceToSurvival,
    survivalCushionPct,
    paceUsdPerDay,
    projectedEndingBalance,
    onPaceForTarget,
    isLoading,
  };
}
