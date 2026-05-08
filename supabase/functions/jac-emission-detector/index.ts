/**
 * jac-emission-detector — JAC kernel cron-driven detection runner.
 *
 * Cron `* 13-20 * * 1-5` (every minute RTH weekdays). For each enabled
 * trigger:
 *   1. Invoke its detection function (RPC) with detection_params
 *   2. For each returned row: build event_payload + dedup_key + severity
 *   3. Honor cadence (debounced / rate_limited / per_event) — detection
 *      function already filters debounced cases via NOT EXISTS lookup
 *      against jac_emissions; runner enforces rate_limited if configured
 *   4. Call jac-compose-emission per row → get emission_id
 *   5. Call jac-emit per emission_id → dispatch
 *
 * Returns a per-trigger summary: events detected / composed / dispatched / errors.
 *
 * Auth: service-role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

interface TriggerRow {
  id: string;
  trigger_name: string;
  application: string;
  detection_function: string;
  detection_params: Record<string, unknown>;
  default_severity: 'info' | 'signal' | 'alert' | 'critical';
  cadence_mode: 'per_event' | 'debounced' | 'rate_limited';
  cadence_params: Record<string, unknown>;
  composition_template: string;
  emission_targets: string[];
  model_override: string | null;
}

interface DetectionRow {
  event_dedup_key: string;
  event_payload: Record<string, unknown>;
  severity: 'info' | 'signal' | 'alert' | 'critical';
  ticker_focus: string | null;
}

interface TriggerSummary {
  trigger_name: string;
  detected: number;
  composed: number;
  dispatched: number;
  errors: string[];
}

const FUNCTIONS_URL = `${Deno.env.get('SUPABASE_URL')}/functions/v1`;

async function callEdgeFn(
  fn: string,
  body: Record<string, unknown>,
  serviceRoleKey: string,
): Promise<{ ok: boolean; status: number; data: unknown; err?: string }> {
  try {
    const resp = await fetch(`${FUNCTIONS_URL}/${fn}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceRoleKey}`,
        'apikey': serviceRoleKey,
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, err: e instanceof Error ? e.message : String(e) };
  }
}

async function checkRateLimit(
  supabase: SupabaseClient,
  trigger: TriggerRow,
  dedup_key: string,
): Promise<boolean> {
  if (trigger.cadence_mode !== 'rate_limited') return true;
  const params = trigger.cadence_params ?? {};
  const n = (params.n as number | undefined) ?? 5;
  const window_minutes = (params.window_minutes as number | undefined) ?? 60;
  const since = new Date(Date.now() - window_minutes * 60_000).toISOString();
  const { count } = await supabase
    .from('jac_emissions')
    .select('id', { count: 'exact', head: true })
    .eq('trigger_name', trigger.trigger_name)
    .gte('created_at', since);
  return (count ?? 0) < n;
}

async function processTrigger(
  supabase: SupabaseClient,
  trigger: TriggerRow,
  serviceRoleKey: string,
): Promise<TriggerSummary> {
  const summary: TriggerSummary = {
    trigger_name: trigger.trigger_name,
    detected: 0,
    composed: 0,
    dispatched: 0,
    errors: [],
  };

  // 1. Invoke detection function.
  const { data: detectionRows, error: detectErr } = await supabase
    .rpc(trigger.detection_function, { p_params: trigger.detection_params });

  if (detectErr) {
    summary.errors.push(`detection_rpc_failed:${detectErr.message.slice(0, 160)}`);
    return summary;
  }
  if (!Array.isArray(detectionRows)) {
    summary.errors.push('detection_rpc_returned_non_array');
    return summary;
  }

  summary.detected = detectionRows.length;

  // 2. For each detected row, compose + emit.
  for (const raw of detectionRows as DetectionRow[]) {
    if (!raw.event_dedup_key || !raw.event_payload) {
      summary.errors.push('detection_row_missing_required_fields');
      continue;
    }

    // Rate-limit gate (debounced is already enforced inside detection function).
    if (!(await checkRateLimit(supabase, trigger, raw.event_dedup_key))) {
      continue;
    }

    const severity = (raw.severity as string | null) || trigger.default_severity;

    // Compose.
    const composeResp = await callEdgeFn('jac-compose-emission', {
      trigger_id: trigger.id,
      trigger_name: trigger.trigger_name,
      application: trigger.application,
      event_payload: raw.event_payload,
      severity,
      ticker_focus: raw.ticker_focus,
      event_dedup_key: raw.event_dedup_key,
      composition_template: trigger.composition_template,
      model_override: trigger.model_override,
    }, serviceRoleKey);

    if (!composeResp.ok) {
      summary.errors.push(
        `compose_failed:${raw.event_dedup_key}:${composeResp.err ?? composeResp.status}`,
      );
      continue;
    }
    summary.composed += 1;

    const emission_id = (composeResp.data as { emission_id?: string })?.emission_id;
    if (!emission_id) {
      summary.errors.push(`compose_no_emission_id:${raw.event_dedup_key}`);
      continue;
    }

    // Emit.
    const emitResp = await callEdgeFn('jac-emit', { emission_id }, serviceRoleKey);
    if (!emitResp.ok) {
      summary.errors.push(`emit_failed:${emission_id}:${emitResp.err ?? emitResp.status}`);
      continue;
    }
    summary.dispatched += 1;
  }

  return summary;
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

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceRoleKey);

  const startedAt = Date.now();

  // Pull enabled triggers.
  const { data: triggers, error: trigErr } = await supabase
    .from('jac_emission_triggers')
    .select('id, trigger_name, application, detection_function, detection_params, default_severity, cadence_mode, cadence_params, composition_template, emission_targets, model_override')
    .eq('enabled', true);

  if (trigErr) {
    return new Response(
      JSON.stringify({ ok: false, error: 'load_triggers_failed', message: trigErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const summaries: TriggerSummary[] = [];
  for (const trigger of (triggers as TriggerRow[] | null) ?? []) {
    summaries.push(await processTrigger(supabase, trigger, serviceRoleKey));
  }

  const totalDetected = summaries.reduce((a, s) => a + s.detected, 0);
  const totalDispatched = summaries.reduce((a, s) => a + s.dispatched, 0);
  const totalErrors = summaries.reduce((a, s) => a + s.errors.length, 0);

  return new Response(
    JSON.stringify({
      ok: totalErrors === 0,
      triggers_evaluated: summaries.length,
      detected_total: totalDetected,
      dispatched_total: totalDispatched,
      errors_total: totalErrors,
      per_trigger: summaries,
      duration_ms: Date.now() - startedAt,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
