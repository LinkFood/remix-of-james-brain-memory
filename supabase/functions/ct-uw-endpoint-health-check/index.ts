/**
 * ct-uw-endpoint-health-check
 *
 * Iterates UW_ENDPOINT_REGISTRY, fires a minimal probe at each wrapper, and
 * records the outcome in ct_uw_endpoint_health. Failures trip state machines
 * and — once a wrapper hits `broken` — drop a high-severity row into
 * ct_cron_failures so the /preflight UI lights up.
 *
 * This is the structural answer to "silent failure modes" for UW. When UW
 * renames a path in v4, we find out from telemetry, not from a trade-side
 * outage.
 *
 * Scheduled 05:00 UTC daily (pre-market). Manual trigger:
 *   SELECT public.trigger_ct_uw_endpoint_health_check();
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { UW_ENDPOINT_REGISTRY, UwError } from '../_shared/uwClient.ts';

type Status = 'ok' | 'degraded' | 'broken';

// A wrapper is 'degraded' after 1 consecutive 4xx/5xx and 'broken' after 3.
const BROKEN_THRESHOLD = 3;

interface HealthRow {
  endpoint_path: string;
  wrapper_name: string;
  last_checked_at: string;
  last_success_at: string | null;
  last_error_at: string | null;
  last_status_code: number | null;
  last_error_message: string | null;
  consecutive_failures: number;
  status: Status;
}

interface ProbeResult {
  wrapper: string;
  path: string;
  ok: boolean;
  status_code: number | null;
  error_message: string | null;
  duration_ms: number;
}

async function probeOne(entry: { wrapper: string; path_template: string; probe: () => Promise<unknown> }): Promise<ProbeResult> {
  const t0 = Date.now();
  try {
    await entry.probe();
    return { wrapper: entry.wrapper, path: entry.path_template, ok: true, status_code: 200, error_message: null, duration_ms: Date.now() - t0 };
  } catch (e) {
    const status_code = e instanceof UwError ? e.status : null;
    const error_message = e instanceof Error ? e.message : String(e);
    return { wrapper: entry.wrapper, path: entry.path_template, ok: false, status_code, error_message, duration_ms: Date.now() - t0 };
  }
}

function nextStatus(prev: HealthRow | null, probe: ProbeResult): { status: Status; consecutive_failures: number; transitioned: boolean } {
  const prevStatus: Status = prev?.status ?? 'ok';
  let consecutive_failures = prev?.consecutive_failures ?? 0;
  let status: Status;
  if (probe.ok) {
    consecutive_failures = 0;
    status = 'ok';
  } else {
    consecutive_failures += 1;
    status = consecutive_failures >= BROKEN_THRESHOLD ? 'broken' : 'degraded';
  }
  return { status, consecutive_failures, transitioned: status !== prevStatus };
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const startedAt = Date.now();

  // Load existing health rows once — fewer round trips than per-wrapper select.
  const { data: existing, error: loadErr } = await supabase
    .from('ct_uw_endpoint_health')
    .select('*');
  if (loadErr) {
    console.error('[ct-uw-endpoint-health-check] load failed:', loadErr);
    return new Response(JSON.stringify({ error: loadErr.message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
  const byWrapper = new Map<string, HealthRow>();
  for (const r of existing ?? []) byWrapper.set(r.wrapper_name, r as HealthRow);

  const results: Array<ProbeResult & { status: Status; consecutive_failures: number; transitioned: boolean }> = [];
  const rowsToUpsert: HealthRow[] = [];
  const decisions: Array<Record<string, unknown>> = [];
  const newlyBroken: HealthRow[] = [];

  // Probe sequentially — the registry is ~32 wrappers, each is a single UW
  // GET. Total ~10-15s well inside the edge-function timeout. Parallel would
  // blast the UW 120 req/min budget on tickers already being crawled by the
  // watcher.
  for (const entry of UW_ENDPOINT_REGISTRY) {
    const probe = await probeOne(entry);
    const prev = byWrapper.get(entry.wrapper) ?? null;
    const { status, consecutive_failures, transitioned } = nextStatus(prev, probe);
    const nowIso = new Date().toISOString();
    const row: HealthRow = {
      endpoint_path: entry.path_template,
      wrapper_name: entry.wrapper,
      last_checked_at: nowIso,
      last_success_at: probe.ok ? nowIso : (prev?.last_success_at ?? null),
      last_error_at: probe.ok ? (prev?.last_error_at ?? null) : nowIso,
      last_status_code: probe.status_code,
      last_error_message: probe.error_message,
      consecutive_failures,
      status,
    };
    rowsToUpsert.push(row);
    results.push({ ...probe, status, consecutive_failures, transitioned });

    if (transitioned) {
      decisions.push({
        decision_type: 'stress_check',
        model_tier: 'none',
        reasoning: `UW endpoint health: ${entry.wrapper} ${prev?.status ?? 'unknown'} -> ${status}. path=${entry.path_template}, status_code=${probe.status_code}, error=${(probe.error_message ?? '').slice(0, 200)}`,
        outcome: `endpoint_${status}`,
        tool_calls_summary: {
          wrapper: entry.wrapper,
          path: entry.path_template,
          prev_status: prev?.status ?? null,
          new_status: status,
          consecutive_failures,
          probe_status_code: probe.status_code,
          probe_error: probe.error_message,
          probe_duration_ms: probe.duration_ms,
        },
      });
      if (status === 'broken') newlyBroken.push(row);
    }
  }

  // One upsert of the full registry — idempotent on wrapper_name.
  const { error: upsertErr } = await supabase
    .from('ct_uw_endpoint_health')
    .upsert(rowsToUpsert, { onConflict: 'wrapper_name' });
  if (upsertErr) {
    console.error('[ct-uw-endpoint-health-check] upsert failed:', upsertErr);
  }

  // Log transitions to the Claude decisions journal.
  if (decisions.length > 0) {
    const { error: decisionsErr } = await supabase.from('ct_claude_decisions').insert(decisions);
    if (decisionsErr) console.error('[ct-uw-endpoint-health-check] decisions insert failed:', decisionsErr);
  }

  // Broken wrappers get a high-severity cron failure row so /preflight lights
  // up. Matches ct_cron_failures shape: cron_name, status, detected_at.
  if (newlyBroken.length > 0) {
    const failures = newlyBroken.map((r) => ({
      cron_name: `uw-endpoint:${r.wrapper_name}`,
      status: 'failed',
      last_run_at: r.last_checked_at,
      last_run_status: `broken (${r.consecutive_failures} consecutive failures)`,
      detected_at: r.last_checked_at,
    }));
    const { error: failErr } = await supabase.from('ct_cron_failures').insert(failures);
    if (failErr) console.error('[ct-uw-endpoint-health-check] cron_failures insert failed:', failErr);
  }

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    degraded: results.filter((r) => r.status === 'degraded').length,
    broken: results.filter((r) => r.status === 'broken').length,
    transitions: decisions.length,
    newly_broken: newlyBroken.map((r) => r.wrapper_name),
  };

  return new Response(JSON.stringify({
    success: true,
    summary,
    results,
    duration_ms: Date.now() - startedAt,
  }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
