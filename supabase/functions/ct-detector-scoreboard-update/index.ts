/**
 * ct-detector-scoreboard-update — #9 detector lifecycle Phase B cron.
 *
 * Every 30 min RTH / hourly off-hours:
 *   1. Call ct_detector_outcome_stats(7) and ct_detector_outcome_stats(30)
 *      to get composite hit rates per detector across two windows.
 *   2. Compute proposed_status per detector against config-driven thresholds.
 *   3. Append a ct_detector_scoreboard snapshot per detector.
 *   4. Update ct_detector_lifecycle_state stability counters.
 *   5. If a detector's proposed_status has held for K consecutive runs AND
 *      differs from current ct_detectors.status: flip the status, fire
 *      Slack on state change.
 *
 * Composite metric (wins + 0.5*partials)/n_graded per the Q1 calibration
 * analysis (docs/decisions/2026-05-02-detector-lifecycle-thresholds.md).
 *
 * K stability gate: proposed_status MUST be stable for
 * detector.lifecycle.stability_runs (default 4) cron runs before an actual
 * flip. Tonight's first run will create state rows with streak=1 — no
 * detector status flips on first fire by design.
 *
 * Auth: service_role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getConfig } from '../_shared/configCache.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';

type DetectorStatus = 'shadow' | 'trial' | 'live' | 'decay' | 'retired';

interface OutcomeRow {
  detector_id: string;
  n_total: number;
  n_graded: number;
  wins: number;
  losses: number;
  partials: number;
  invalidated_early: number;
  hit_rate_composite: number | null;
  current_streak: number;
}

interface DetectorRow {
  id: string;
  status: DetectorStatus;
}

interface LifecycleStateRow {
  detector_id: string;
  proposed_status: string | null;
  proposed_streak: number;
  last_flip_at: string | null;
  last_flip_from: string | null;
  last_flip_to: string | null;
}

/**
 * Compute proposed_status per the config-driven thresholds. Returns the
 * lifecycle proposal, NOT the current status. The K stability gate runs
 * after this — proposed != actual is fine and expected.
 */
function computeProposedStatus(
  current: DetectorStatus,
  hr30d: number | null,
  n30d: number,
  hr14d: number | null,
  n14d: number,
  cfg: {
    shadowToTrialNMin: number;
    shadowToTrialHrMin: number;
    trialToLiveNMin: number;
    trialToLiveHrMin: number;
    liveToDecayHrMax: number;
    liveToDecayNMin: number;
    decayToRetiredHrMax: number;
    decayToRetiredNMin: number;
  },
): DetectorStatus {
  // Insufficient data → keep current.
  if (hr30d == null || n30d === 0) return current;

  if (current === 'shadow') {
    if (n30d >= cfg.shadowToTrialNMin && hr30d >= cfg.shadowToTrialHrMin) {
      // Eligible for trial — but check trial-to-live conditions too;
      // a hot detector with n>=150 AND hr>=trial_to_live_hr can leapfrog.
      if (n30d >= cfg.trialToLiveNMin && hr30d >= cfg.trialToLiveHrMin) {
        return 'live';
      }
      return 'trial';
    }
    return 'shadow';
  }
  if (current === 'trial') {
    if (n30d >= cfg.trialToLiveNMin && hr30d >= cfg.trialToLiveHrMin) {
      return 'live';
    }
    return 'trial';
  }
  if (current === 'live') {
    // Demote on sustained 14d underperformance only.
    if (hr14d != null && n14d >= cfg.liveToDecayNMin && hr14d < cfg.liveToDecayHrMax) {
      return 'decay';
    }
    return 'live';
  }
  if (current === 'decay') {
    // Recover OR fall to retired.
    if (hr30d >= cfg.shadowToTrialHrMin && n30d >= cfg.shadowToTrialNMin) {
      return 'trial'; // recovered
    }
    if (n30d >= cfg.decayToRetiredNMin && hr30d < cfg.decayToRetiredHrMax) {
      return 'retired';
    }
    return 'decay';
  }
  // retired stays retired (manual intervention to revive).
  return current;
}

async function loadConfigThresholds(supabase: SupabaseClient) {
  const [
    shadowToTrialNMin,
    shadowToTrialHrMin,
    trialToLiveNMin,
    trialToLiveHrMin,
    liveToDecayHrMax,
    liveToDecayNMin,
    decayToRetiredHrMax,
    decayToRetiredNMin,
    stabilityRuns,
    slackEnabled,
  ] = await Promise.all([
    getConfig<number>('detector.lifecycle.shadow_to_trial_n_min', 50),
    getConfig<number>('detector.lifecycle.shadow_to_trial_hr_min', 0.30),
    getConfig<number>('detector.lifecycle.trial_to_live_n_min', 150),
    getConfig<number>('detector.lifecycle.trial_to_live_hr_min', 0.35),
    getConfig<number>('detector.lifecycle.live_to_decay_hr_max', 0.20),
    getConfig<number>('detector.lifecycle.live_to_decay_n_min', 30),
    getConfig<number>('detector.lifecycle.decay_to_retired_hr_max', 0.25),
    getConfig<number>('detector.lifecycle.decay_to_retired_n_min', 50),
    getConfig<number>('detector.lifecycle.stability_runs', 4),
    getConfig<boolean>('detector.lifecycle.slack_enabled', true),
  ]);
  return {
    shadowToTrialNMin: Number(shadowToTrialNMin) || 50,
    shadowToTrialHrMin: Number(shadowToTrialHrMin) || 0.30,
    trialToLiveNMin: Number(trialToLiveNMin) || 150,
    trialToLiveHrMin: Number(trialToLiveHrMin) || 0.35,
    liveToDecayHrMax: Number(liveToDecayHrMax) || 0.20,
    liveToDecayNMin: Number(liveToDecayNMin) || 30,
    decayToRetiredHrMax: Number(decayToRetiredHrMax) || 0.25,
    decayToRetiredNMin: Number(decayToRetiredNMin) || 50,
    stabilityRuns: Math.max(1, Number(stabilityRuns) || 4),
    slackEnabled: slackEnabled !== false,
  };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  const cfg = await loadConfigThresholds(supabase);

  // Pull stats for both windows.
  const [stats30, stats7] = await Promise.all([
    supabase.rpc('ct_detector_outcome_stats', { p_since_days: 30 }),
    supabase.rpc('ct_detector_outcome_stats', { p_since_days: 7 }),
  ]);
  if (stats30.error) {
    return new Response(JSON.stringify({ error: 'rpc_30d_failed', detail: stats30.error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (stats7.error) {
    return new Response(JSON.stringify({ error: 'rpc_7d_failed', detail: stats7.error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const rows30 = (stats30.data ?? []) as OutcomeRow[];
  const rows7 = (stats7.data ?? []) as OutcomeRow[];

  // Index by detector_id for fast joins below.
  const map30 = new Map<string, OutcomeRow>(rows30.map((r) => [r.detector_id, r]));
  const map7 = new Map<string, OutcomeRow>(rows7.map((r) => [r.detector_id, r]));

  // 14d hit rate isn't its own RPC call to keep the cron fast — approximate
  // with the 7d figure for the live→decay gate. Acceptable because demotion
  // is conservative + K=4 stability gate.
  // (If we need a true 14d window later, add a third RPC call.)

  // Pull current detector statuses to compute proposed_status.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: detectorsData, error: detsErr } = await (supabase as any)
    .from('ct_detectors')
    .select('id, status')
    .in('status', ['shadow', 'trial', 'live', 'decay']); // retired skipped — manual revive
  if (detsErr) {
    return new Response(JSON.stringify({ error: 'detectors_fetch_failed', detail: detsErr.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const detectors = (detectorsData ?? []) as DetectorRow[];

  // Pull existing lifecycle state rows.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: stateData } = await (supabase as any)
    .from('ct_detector_lifecycle_state')
    .select('detector_id, proposed_status, proposed_streak, last_flip_at, last_flip_from, last_flip_to');
  const stateMap = new Map<string, LifecycleStateRow>(
    ((stateData ?? []) as LifecycleStateRow[]).map((r) => [r.detector_id, r]),
  );

  // Compose snapshots + state updates per detector.
  const scoreboardRows: Record<string, unknown>[] = [];
  const stateUpdates: Record<string, unknown>[] = [];
  const flips: Array<{ detector_id: string; from: DetectorStatus; to: DetectorStatus; n30d: number; hr30d: number | null }> = [];
  const nowIso = new Date().toISOString();

  for (const det of detectors) {
    const r30 = map30.get(det.id);
    const r7 = map7.get(det.id);
    const hr30d = r30?.hit_rate_composite ?? null;
    const n30d = Number(r30?.n_graded ?? 0);
    const hr7d = r7?.hit_rate_composite ?? null;
    const n7d = Number(r7?.n_graded ?? 0);

    const proposed = computeProposedStatus(
      det.status,
      hr30d,
      n30d,
      hr7d, // approximate 14d with 7d for now
      n7d,
      cfg,
    );

    // Streak update.
    const prev = stateMap.get(det.id);
    let newStreak = 1;
    if (prev && prev.proposed_status === proposed) {
      newStreak = (prev.proposed_streak ?? 0) + 1;
    }

    scoreboardRows.push({
      detector_id: det.id,
      computed_at: nowIso,
      n_total: Number(r30?.n_total ?? 0),
      n_graded: n30d,
      wins: Number(r30?.wins ?? 0),
      losses: Number(r30?.losses ?? 0),
      partials: Number(r30?.partials ?? 0),
      invalidated_early: Number(r30?.invalidated_early ?? 0),
      hit_rate_7d: hr7d == null ? null : Number((hr7d as number).toFixed(4)),
      hit_rate_30d: hr30d == null ? null : Number((hr30d as number).toFixed(4)),
      sample_count_7d: n7d,
      sample_count_30d: n30d,
      current_streak: Number(r30?.current_streak ?? 0),
      current_status: det.status,
      proposed_status: proposed,
    });

    // State row UPSERT payload (one row per detector, pk on detector_id).
    const stateRow: Record<string, unknown> = {
      detector_id: det.id,
      proposed_status: proposed,
      proposed_streak: newStreak,
      last_run_at: nowIso,
      updated_at: nowIso,
    };

    // Stability gate: only flip if streak >= K AND proposed != current.
    if (
      newStreak >= cfg.stabilityRuns &&
      proposed !== det.status &&
      proposed !== 'retired' // retired requires manual touch (Tenet 17 — conditions not prescriptions)
    ) {
      flips.push({
        detector_id: det.id,
        from: det.status,
        to: proposed,
        n30d,
        hr30d,
      });
      stateRow.last_flip_at = nowIso;
      stateRow.last_flip_from = det.status;
      stateRow.last_flip_to = proposed;
      // Reset streak post-flip — new equilibrium baseline.
      stateRow.proposed_streak = 0;
    } else if (prev) {
      // Preserve last_flip_* fields if no flip this run.
      stateRow.last_flip_at = prev.last_flip_at;
      stateRow.last_flip_from = prev.last_flip_from;
      stateRow.last_flip_to = prev.last_flip_to;
    }
    stateUpdates.push(stateRow);
  }

  // Bulk-insert scoreboard snapshots.
  if (scoreboardRows.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: scbErr } = await (supabase as any)
      .from('ct_detector_scoreboard')
      .insert(scoreboardRows);
    if (scbErr) console.warn('[ct-detector-scoreboard-update] scoreboard insert err:', scbErr.message);
  }

  // Bulk-upsert lifecycle state.
  if (stateUpdates.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: stateErr } = await (supabase as any)
      .from('ct_detector_lifecycle_state')
      .upsert(stateUpdates, { onConflict: 'detector_id' });
    if (stateErr) console.warn('[ct-detector-scoreboard-update] state upsert err:', stateErr.message);
  }

  // Apply flips + Slack on state change.
  let actualFlips = 0;
  for (const f of flips) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error: flipErr } = await (supabase as any)
      .from('ct_detectors')
      .update({ status: f.to, updated_at: nowIso })
      .eq('id', f.detector_id);
    if (flipErr) {
      console.warn(`[ct-detector-scoreboard-update] flip ${f.detector_id} ${f.from}→${f.to} err:`, flipErr.message);
      continue;
    }
    actualFlips += 1;

    // Slack one-shot per flip.
    if (cfg.slackEnabled) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { data: users } = await (supabase as any).from('profiles').select('id').limit(1);
        const userId = users?.[0]?.id as string | undefined;
        if (userId) {
          const hrStr = f.hr30d == null ? 'n/a' : `${(f.hr30d * 100).toFixed(1)}%`;
          const text = `:dna: Detector lifecycle flip · *${f.detector_id}* ${f.from} → ${f.to} (n=${f.n30d}, hr_v3=${hrStr})`;
          const blocks = [
            { type: 'section', text: { type: 'mrkdwn', text } },
            { type: 'context', elements: [
              { type: 'mrkdwn', text: `Stability gate K=${cfg.stabilityRuns} reached. Auto-flipped ct_detectors.status. Manual revert via SQL if undesired.` },
            ]},
          ];
          await ctSlackPushDirect(supabase, userId, text, `det_lifecycle_${f.detector_id}_${nowIso}`, blocks);
        }
      } catch (e) {
        console.warn(`[ct-detector-scoreboard-update] slack ${f.detector_id} err:`, e instanceof Error ? e.message : String(e));
      }
    }
  }

  return new Response(JSON.stringify({
    ok: true,
    elapsed_ms: Date.now() - startedAt,
    detectors_evaluated: detectors.length,
    snapshots_written: scoreboardRows.length,
    state_rows_upserted: stateUpdates.length,
    flips_proposed: flips.length,
    flips_executed: actualFlips,
    stability_runs: cfg.stabilityRuns,
  }), {
    status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
