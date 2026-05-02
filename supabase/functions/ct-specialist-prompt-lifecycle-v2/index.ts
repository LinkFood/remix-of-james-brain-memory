/**
 * ct-specialist-prompt-lifecycle-v2 — Specialist Scoreboard v2 lifecycle driver.
 *
 * Two-step nightly run:
 *   1. Call public.ct_specialist_score_v2(7) to refresh ct_specialist_grade_axes,
 *      ct_specialist_scoreboard_v2, and ct_specialist_conviction_calibration.
 *   2. Walk ct_specialist_prompt_lifecycle rows. For each row:
 *      - Look up hit_rate_blended for window='lifetime', regime='all'.
 *      - Apply config-driven status proposal rules.
 *      - K=4 stability gate: only flip status when consecutive_stable_runs >= K.
 *      - Slack one-shot per actual flip.
 *
 * Mirrors ct-detector-scoreboard-update K=4 pattern. The lifecycle table is
 * already seeded with 20 rows (10 specialists x v1=retired + v2=live) by
 * 20260502040200_specialist_v2_schemas.sql.
 *
 * Auth: service_role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getConfig } from '../_shared/configCache.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

type SpecialistStatus = 'shadow' | 'trial' | 'live' | 'decay' | 'retired';

interface LifecycleRow {
  specialist_ticker: string;
  prompt_version: string;
  status: SpecialistStatus;
  proposed_status: SpecialistStatus | null;
  consecutive_stable_runs: number;
  status_changed_at: string;
  hit_rate_at_status_change: number | null;
  hit_rate_current: number | null;
  last_run_at: string;
  last_flip_at: string | null;
  last_flip_from: string | null;
  last_flip_to: string | null;
}

interface ScoreboardRow {
  specialist_ticker: string;
  hit_rate_blended: number | null;
  n_graded: number;
}

interface RpcResult {
  graded_count: number;
  scoreboard_rows: number;
  calibration_rows: number;
  elapsed_ms: number;
  window_days: number;
  thresholds: Record<string, number>;
}

/**
 * Compute proposed_status from hit_rate_blended against config thresholds.
 * Returns the lifecycle proposal — the K=4 gate runs separately.
 */
function computeProposedStatus(
  current: SpecialistStatus,
  hr: number | null,
  cfg: {
    shadowToTrialHr: number;
    trialToLiveHr: number;
    decayHr: number;
    retiredHr: number;
  },
): SpecialistStatus {
  if (hr == null) return current;

  if (current === 'shadow') {
    if (hr >= cfg.shadowToTrialHr) return 'trial';
    return 'shadow';
  }
  if (current === 'trial') {
    if (hr >= cfg.trialToLiveHr) return 'live';
    if (hr < cfg.decayHr) return 'decay';
    return 'trial';
  }
  if (current === 'live') {
    if (hr < cfg.decayHr) return 'decay';
    return 'live';
  }
  if (current === 'decay') {
    if (hr < cfg.retiredHr) return 'retired';
    if (hr >= cfg.shadowToTrialHr) return 'trial';   // recovered
    return 'decay';
  }
  return current;   // retired stays retired
}

async function loadConfig() {
  const [
    stabilityRuns,
    shadowToTrialHr,
    trialToLiveHr,
    decayHr,
    slackEnabled,
  ] = await Promise.all([
    getConfig<number>('specialist.lifecycle.stability_runs', 4),
    getConfig<number>('specialist.lifecycle.shadow_to_trial_hit_rate', 0.45),
    getConfig<number>('specialist.lifecycle.trial_to_live_hit_rate', 0.55),
    getConfig<number>('specialist.lifecycle.decay_hit_rate', 0.40),
    getConfig<boolean>('specialist.lifecycle.slack_enabled', true),
  ]);
  return {
    stabilityRuns: Math.max(1, Number(stabilityRuns) || 4),
    shadowToTrialHr: Number(shadowToTrialHr) || 0.45,
    trialToLiveHr: Number(trialToLiveHr) || 0.55,
    decayHr: Number(decayHr) || 0.40,
    retiredHr: 0.30,           // hard floor — not config'd, conservative
    slackEnabled: slackEnabled !== false,
  };
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase: SupabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const startedAt = Date.now();
  const cfg = await loadConfig();

  // -------------------------------------------------------------------------
  // Step 1 — refresh scoreboard via RPC.
  // -------------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rpcData, error: rpcErr } = await (supabase.rpc as any)(
    'ct_specialist_score_v2',
    { p_since_days: 7 },
  );
  if (rpcErr) {
    return new Response(JSON.stringify({
      error: 'rpc_failed', detail: rpcErr.message,
    }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const rpcResult = (rpcData ?? {}) as RpcResult;

  // -------------------------------------------------------------------------
  // Step 2 — load scoreboard (lifetime, all) + lifecycle rows.
  // -------------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: sbData, error: sbErr } = await (supabase as any)
    .from('ct_specialist_scoreboard_v2')
    .select('specialist_ticker, hit_rate_blended, n_graded')
    .eq('regime', 'all')
    .eq('window_label', 'lifetime');
  if (sbErr) {
    return new Response(JSON.stringify({
      error: 'scoreboard_fetch_failed', detail: sbErr.message,
    }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const sbMap = new Map<string, ScoreboardRow>(
    ((sbData ?? []) as ScoreboardRow[]).map((r) => [r.specialist_ticker, r]),
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: lcData, error: lcErr } = await (supabase as any)
    .from('ct_specialist_prompt_lifecycle')
    .select('*');
  if (lcErr) {
    return new Response(JSON.stringify({
      error: 'lifecycle_fetch_failed', detail: lcErr.message,
    }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const lifecycleRows = (lcData ?? []) as LifecycleRow[];

  // -------------------------------------------------------------------------
  // Step 3 — compute proposed_status + K=4 gate per row.
  // -------------------------------------------------------------------------
  const nowIso = new Date().toISOString();
  const updates: Record<string, unknown>[] = [];
  const flips: Array<{
    specialist_ticker: string;
    prompt_version: string;
    from: SpecialistStatus;
    to: SpecialistStatus;
    hr: number | null;
  }> = [];

  for (const row of lifecycleRows) {
    const sb = sbMap.get(row.specialist_ticker);
    const hr = sb?.hit_rate_blended ?? null;

    // Normalized row shape — every update has the same column set so PostgREST
    // bulk upsert sees a uniform schema. Retired rows simply preserve their
    // existing status/proposed_status/streak values.
    const update: Record<string, unknown> = {
      specialist_ticker: row.specialist_ticker,
      prompt_version: row.prompt_version,
      status: row.status,
      proposed_status: row.proposed_status,
      consecutive_stable_runs: row.consecutive_stable_runs ?? 0,
      hit_rate_current: hr,
      last_run_at: nowIso,
      status_changed_at: row.status_changed_at,
      hit_rate_at_status_change: row.hit_rate_at_status_change,
      last_flip_at: row.last_flip_at,
      last_flip_from: row.last_flip_from,
      last_flip_to: row.last_flip_to,
    };

    // For retired rows: skip status logic (retired requires manual revival).
    if (row.status === 'retired') {
      updates.push(update);
      continue;
    }

    const proposed = computeProposedStatus(row.status, hr, cfg);

    // Streak update: increment if same as previous proposed_status, else reset.
    let newStreak = 1;
    if (row.proposed_status === proposed) {
      newStreak = (row.consecutive_stable_runs ?? 0) + 1;
    }

    update.proposed_status = proposed;
    update.consecutive_stable_runs = newStreak;

    // K=4 gate: flip only when streak >= K and proposed != current.
    // 'retired' proposals require manual touch even when gate clears.
    if (
      newStreak >= cfg.stabilityRuns
      && proposed !== row.status
      && proposed !== 'retired'
    ) {
      flips.push({
        specialist_ticker: row.specialist_ticker,
        prompt_version: row.prompt_version,
        from: row.status,
        to: proposed,
        hr,
      });
      update.status = proposed;
      update.status_changed_at = nowIso;
      update.hit_rate_at_status_change = hr;
      update.last_flip_at = nowIso;
      update.last_flip_from = row.status;
      update.last_flip_to = proposed;
      update.consecutive_stable_runs = 0;   // reset post-flip
    }

    updates.push(update);
  }

  // -------------------------------------------------------------------------
  // Step 4 — bulk upsert lifecycle rows + Slack on flips.
  // -------------------------------------------------------------------------
  let upserted = 0;
  let upsertError: string | null = null;
  if (updates.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: upErr } = await (supabase as any)
      .from('ct_specialist_prompt_lifecycle')
      .upsert(updates, { onConflict: 'specialist_ticker,prompt_version' });
    if (upErr) {
      upsertError = upErr.message;
      console.warn('[ct-specialist-prompt-lifecycle-v2] upsert err:', upErr.message);
    } else {
      upserted = updates.length;
    }
  }

  if (cfg.slackEnabled && flips.length > 0) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: profs } = await (supabase as any)
        .from('profiles').select('id').limit(1);
      const userId = (profs?.[0]?.id as string | undefined) ?? null;
      if (userId) {
        for (const f of flips) {
          const hrStr = f.hr == null ? 'n/a' : `${(f.hr * 100).toFixed(1)}%`;
          const text = `:bar_chart: Specialist lifecycle flip · *${f.specialist_ticker}* v${f.prompt_version} ${f.from} → ${f.to} (hr_blended=${hrStr})`;
          const blocks = [
            { type: 'section', text: { type: 'mrkdwn', text } },
            { type: 'context', elements: [
              { type: 'mrkdwn', text: `K=${cfg.stabilityRuns} stability gate cleared. Auto-flipped ct_specialist_prompt_lifecycle.status. Manual revert via SQL if undesired.` },
            ]},
          ];
          await ctSlackPushDirect(
            supabase, userId, text,
            `spec_lifecycle_${f.specialist_ticker}_${f.prompt_version}_${nowIso}`,
            blocks,
          );
        }
      }
    } catch (e) {
      console.warn('[ct-specialist-prompt-lifecycle-v2] slack err:',
        e instanceof Error ? e.message : String(e));
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    elapsed_ms: Date.now() - startedAt,
    rpc: rpcResult,
    lifecycle_rows_evaluated: lifecycleRows.length,
    lifecycle_rows_upserted: upserted,
    upsert_error: upsertError,
    flips_executed: flips.length,
    stability_runs: cfg.stabilityRuns,
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
