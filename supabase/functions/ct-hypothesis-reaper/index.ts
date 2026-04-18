/**
 * ct-hypothesis-reaper — daily cleanup for open hypotheses.
 *
 * Runs once a day at 06:00 UTC (02:00 ET). Two passes:
 *
 *   1. Zombie reaper — for each open hypothesis where:
 *         confidence < zombie_confidence_threshold
 *         AND updated_at < now() - zombie_age_days
 *      call retire_hypothesis(id, 'zombie', ...).
 *
 *   2. Confidence decay — for each open hypothesis with no new evidence
 *      in the last 7 days, apply:
 *         confidence_delta = -decay_weekly * confidence
 *         elo_delta        = 0
 *      via update_hypothesis_confidence(...).
 *
 * Both passes are idempotent. Empty DB returns {processed: 0}.
 *
 * Auth: service role only. Called by pg_cron.
 */

// ISOLATION AUDIT (2026-04-18): reads ct_hypotheses + ct_hypothesis_evidence,
// writes via retire_hypothesis / update_hypothesis_confidence RPCs. All
// Claude-own tables. No James-side reads. No Claude API call, so no preamble.
// Contract satisfied. See _shared/CLAUDE_READ_SURFACE.md.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getConfig } from '../_shared/configCache.ts';
import { recordDecision } from '../_shared/decisionJournal.ts';

interface OpenHyp {
  id: string;
  confidence: number;
  elo: number;
  updated_at: string;
  last_tested_at: string | null;
}

async function findEvidenceCutoff(
  supabase: SupabaseClient,
  hypothesisId: string,
  sinceISO: string,
): Promise<boolean> {
  // Returns true if there IS fresh evidence newer than the cutoff.
  const { count, error } = await supabase
    .from('ct_hypothesis_evidence')
    .select('id', { count: 'estimated', head: true })
    .eq('hypothesis_id', hypothesisId)
    .gte('added_at', sinceISO);
  if (error) {
    console.warn(`[ct-hypothesis-reaper] evidence check failed ${hypothesisId}: ${error.message}`);
    return true; // fail-safe: assume evidence so we don't over-decay on DB hiccups.
  }
  return (count ?? 0) > 0;
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Service role required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  const zombieThreshold = Number(await getConfig<number>('hypothesis_zombie_confidence_threshold', 0.20));
  const zombieAgeDays = Number(await getConfig<number>('hypothesis_zombie_age_days', 7));
  const decayWeekly = Number(await getConfig<number>('hypothesis_confidence_decay_weekly', 0.10));

  const zombieCutoff = new Date(Date.now() - zombieAgeDays * 86_400_000).toISOString();
  const decayCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();

  const { data: openHyps, error } = await supabase
    .from('ct_hypotheses')
    .select('id, confidence, elo, updated_at, last_tested_at')
    .eq('status', 'open');

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rows = (openHyps ?? []) as OpenHyp[];
  let zombied = 0, decayed = 0, skipped = 0, failed = 0;

  for (const h of rows) {
    // Zombie pass first — once retired, decay is moot.
    if (h.confidence < zombieThreshold && h.updated_at < zombieCutoff) {
      const reason = `confidence ${h.confidence} < ${zombieThreshold} for ${zombieAgeDays}+ days`;
      const { error: retireErr } = await supabase.rpc('retire_hypothesis', {
        p_hypothesis_id: h.id,
        p_status: 'zombie',
        p_reason: reason,
      });
      if (retireErr) {
        console.warn(`[ct-hypothesis-reaper] zombie retire failed ${h.id}: ${retireErr.message}`);
        failed++;
      } else {
        zombied++;
      }
      await recordDecision(supabase, {
        decision_type: 'retire_hypothesis',
        model_tier: 'none',
        reasoning: `Zombie retirement: ${reason}`,
        outcome: retireErr ? 'retire_rpc_failed' : 'retired_zombie',
        linked_hypothesis_id: h.id,
        context_snapshot: {
          confidence: h.confidence,
          elo: h.elo,
          updated_at: h.updated_at,
          threshold: zombieThreshold,
          age_days: zombieAgeDays,
        },
      });
      continue;
    }

    // Decay pass — only if no fresh evidence in the last 7 days.
    const hasFresh = await findEvidenceCutoff(supabase, h.id, decayCutoff);
    if (hasFresh) { skipped++; continue; }

    const delta = -decayWeekly * h.confidence;
    if (Math.abs(delta) < 0.001) { skipped++; continue; }

    const { error: rpcErr } = await supabase.rpc('update_hypothesis_confidence', {
      p_hypothesis_id: h.id,
      p_confidence_delta: delta,
      p_elo_delta: 0,
      p_reason: `weekly decay, no fresh evidence in 7d (current confidence ${h.confidence})`,
      p_linked_grade_id: null,
      p_event_type: 'confidence_update',
    });
    if (rpcErr) {
      console.warn(`[ct-hypothesis-reaper] decay rpc failed ${h.id}: ${rpcErr.message}`);
      failed++;
    } else {
      decayed++;
    }
    await recordDecision(supabase, {
      decision_type: 'update_hypothesis',
      model_tier: 'none',
      reasoning: `Weekly confidence decay (no fresh evidence in 7d). Applied delta ${delta.toFixed(4)} to current confidence ${h.confidence}.`,
      outcome: rpcErr ? 'decay_rpc_failed' : 'decayed',
      linked_hypothesis_id: h.id,
      context_snapshot: {
        confidence_before: h.confidence,
        confidence_delta: delta,
        decay_weekly_rate: decayWeekly,
      },
    });
  }

  const body = {
    ok: true,
    processed: rows.length,
    zombied,
    decayed,
    skipped,
    failed,
    zombie_threshold: zombieThreshold,
    zombie_age_days: zombieAgeDays,
    decay_weekly: decayWeekly,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-hypothesis-reaper]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
