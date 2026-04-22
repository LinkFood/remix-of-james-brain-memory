// edgePriors.ts — fetch + format the top empirical edges from ct_edge_attribution
// for injection into Claude's system prompts. Called by the watcher and
// trade-idea-generator so every decision is anchored to measured signal
// strength, not vibes.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

export interface EdgePrior {
  signal_type: string;
  signal_subtype: string;
  direction: string;
  conviction_bucket: string;
  horizon_mins: number;
  n: number;
  mean_alpha_pct: number;
  hit_rate: number;
  t_stat: number;
  summary: string;
}

/**
 * Fetch top-N empirical priors. Defaults mirror the SQL RPC: n>=30, |t|>=3,
 * positive mean_alpha. Returns [] on any failure — never blocks a Claude call.
 */
export async function fetchEdgePriors(
  supabase: SupabaseClient,
  opts?: { maxPriors?: number; minN?: number; minAbsT?: number; lookbackDays?: number }
): Promise<EdgePrior[]> {
  try {
    const { data, error } = await supabase.rpc('ct_top_edge_priors', {
      p_max_priors: opts?.maxPriors ?? 8,
      p_min_n: opts?.minN ?? 30,
      p_min_abs_t: opts?.minAbsT ?? 3.0,
      p_lookback: opts?.lookbackDays ?? 7,
    });
    if (error) {
      console.warn('[edgePriors] rpc error:', error.message);
      return [];
    }
    return (data ?? []) as EdgePrior[];
  } catch (e) {
    console.warn('[edgePriors] fetch failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Format priors as a prompt block. Returns empty string if no priors — the
 * caller can append unconditionally without creating dangling headers.
 *
 * The block is blunt on purpose: Claude should CITE priors that match its
 * signal and update conviction accordingly. Silence means no empirical edge
 * has been measured yet at that horizon / subtype / direction.
 */
export function formatEdgePriorsBlock(priors: EdgePrior[]): string {
  if (!priors || priors.length === 0) return '';
  const bullets = priors.map((p) => `- ${p.summary}`).join('\n');
  return `

EMPIRICAL PRIORS (from /edge attribution over last 7d — these survived |t|≥3 with n≥30):
${bullets}

When your call matches a prior's (signal_type, direction, horizon), CITE the prior in your reasoning and raise conviction accordingly. When your call does NOT match any prior here, say so — the absence is itself a signal ("no prior edge measured for this combination"). Do not fabricate priors that aren't in this list. Priors refresh nightly; they describe what *has been* measured, not what *must be* true going forward.`;
}

/**
 * Convenience wrapper: fetch + format in one call.
 */
export async function fetchFormattedEdgePriors(
  supabase: SupabaseClient,
  opts?: { maxPriors?: number; minN?: number; minAbsT?: number; lookbackDays?: number }
): Promise<string> {
  const priors = await fetchEdgePriors(supabase, opts);
  return formatEdgePriorsBlock(priors);
}
