/**
 * ct-deploy-probe — Class kill B-3 Phase B (post-deploy synthetic probe).
 *
 * After CI deploys edge functions, this probe is invoked from
 * `.github/workflows/deploy-functions.yml`'s post-deploy step. For each
 * deployed brain-consumer function, the probe:
 *   1. Sends an HTTP POST to /functions/v1/<fn> with a minimal valid
 *      payload using the vault SERVICE_ROLE_KEY (same auth the cron
 *      uses — verified working at all times).
 *   2. Captures HTTP status + response body.
 *   3. Waits N seconds for telemetry to land.
 *   4. Queries `ct_brain_telemetry` for a row from this consumer in
 *      the wait window.
 *   5. Returns aggregated per-function result.
 *
 * Failure-mode dispatch (per PR #45 Phase A):
 *   - HTTP 401              → auth issue (today's P0 archetype) → fail
 *   - HTTP 500              → function code error → fail
 *   - HTTP 200 + telemetry  → PASS
 *   - HTTP 200 + no row     → silent-no-op-write class → fail elevated
 *   - timeout               → cold-start or non-response → fail
 *
 * Coverage v1: 9 RTH-frequent brain consumers per B-4's covered set
 * (ship/b-4-brain-consumer-freshness-warden-2026-05-06). Other 9
 * event-driven consumers added in follow-up iterations.
 *
 * Auth: probe itself checks `isServiceRoleRequest` so only callers
 * with the matching SUPABASE_SERVICE_ROLE_KEY can invoke. CI passes
 * the secret-to-secret match. Probe internally uses the same vault
 * key to invoke target functions (which also check
 * isServiceRoleRequest).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isServiceRoleRequest } from '../_shared/auth.ts';

interface ProbeConfig {
  payload: Record<string, unknown>;
  wait_seconds: number;
  expect_telemetry_consumer?: string;
}

// Per-function probe config. Defaults: empty payload, 30s wait, telemetry
// consumer name = function name. Per-function override only when the
// function requires a structured payload.
const PROBE_CONFIG: Record<string, ProbeConfig> = {
  'ct-tape-reader': {
    payload: { trigger_kind: 'manual', window_minutes: 10 },
    wait_seconds: 30,
  },
  'ct-watcher': {
    payload: { triggered_by: 'ct-deploy-probe', reason: 'post-deploy synthetic probe' },
    wait_seconds: 30,
  },
  'ct-curiosity':               { payload: {}, wait_seconds: 30 },
  'ct-news-sweep':              { payload: {}, wait_seconds: 30 },
  'ct-hypothesis-health-check': { payload: {}, wait_seconds: 30 },
  'ct-hypothesis-proposer':     { payload: {}, wait_seconds: 30 },
  'ct-alert-post-mortem':       { payload: {}, wait_seconds: 30 },
  'ct-self-grader':             { payload: {}, wait_seconds: 30 },
  'ct-daily-brief': {
    payload: { reason: 'post-deploy synthetic probe' },
    wait_seconds: 30,
  },
};

interface ProbeRequest {
  function_names: string[];
  wait_seconds_override?: number;
  // If true, only run the HTTP probe (skip telemetry verification).
  // Useful when the caller wants a fast smoke test without the wait
  // window. CI default is false (full check).
  http_only?: boolean;
}

interface PerFunctionResult {
  function: string;
  http_status: number | null;
  http_body_excerpt: string | null;
  telemetry_landed: boolean;
  telemetry_error: string | null;
  latency_ms: number;
  status: 'PASS' | 'HTTP_FAIL' | 'SILENT_FAIL' | 'TIMEOUT' | 'TELEMETRY_ERROR' | 'NOT_CONFIGURED';
  classification_note: string;
}

interface ProbeResponse {
  ok: boolean;
  results: PerFunctionResult[];
  failed_functions: string[];
  total_latency_ms: number;
  generated_at: string;
}

const HTTP_TIMEOUT_MS = 60_000;

async function probeOne(
  supabaseUrl: string,
  serviceRoleKey: string,
  supabase: ReturnType<typeof createClient>,
  fn: string,
  config: ProbeConfig | null,
  httpOnly: boolean,
): Promise<PerFunctionResult> {
  const startedAt = Date.now();

  if (!config) {
    return {
      function: fn,
      http_status: null,
      http_body_excerpt: null,
      telemetry_landed: false,
      telemetry_error: null,
      latency_ms: 0,
      status: 'NOT_CONFIGURED',
      classification_note: `no probe config for ${fn} — add to PROBE_CONFIG`,
    };
  }

  // 1. HTTP probe
  const probeStart = new Date(startedAt).toISOString();
  let httpStatus: number | null = null;
  let httpBodyExcerpt: string | null = null;
  let timedOut = false;

  try {
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
    const resp = await fetch(`${supabaseUrl}/functions/v1/${fn}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(config.payload),
      signal: ctrl.signal,
    });
    clearTimeout(timeoutId);
    httpStatus = resp.status;
    const body = await resp.text();
    httpBodyExcerpt = body.slice(0, 200);
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      timedOut = true;
    } else {
      httpBodyExcerpt = `fetch_error: ${(e as Error).message}`;
    }
  }

  // Classify HTTP outcome
  if (timedOut) {
    return {
      function: fn,
      http_status: null,
      http_body_excerpt: 'timeout',
      telemetry_landed: false,
      telemetry_error: null,
      latency_ms: Date.now() - startedAt,
      status: 'TIMEOUT',
      classification_note: `no HTTP response within ${HTTP_TIMEOUT_MS}ms`,
    };
  }

  if (httpStatus !== 200) {
    return {
      function: fn,
      http_status: httpStatus,
      http_body_excerpt: httpBodyExcerpt,
      telemetry_landed: false,
      telemetry_error: null,
      latency_ms: Date.now() - startedAt,
      status: 'HTTP_FAIL',
      classification_note: httpStatus === 401
        ? 'auth issue — env var divergence or key mismatch (today\'s P0 archetype)'
        : `HTTP ${httpStatus}`,
    };
  }

  if (httpOnly) {
    return {
      function: fn,
      http_status: 200,
      http_body_excerpt: httpBodyExcerpt,
      telemetry_landed: false,
      telemetry_error: null,
      latency_ms: Date.now() - startedAt,
      status: 'PASS',
      classification_note: 'http_only mode — telemetry check skipped',
    };
  }

  // 2. Wait for telemetry
  await new Promise(r => setTimeout(r, config.wait_seconds * 1000));

  // 3. Telemetry verification
  const consumerName = config.expect_telemetry_consumer ?? fn;
  const { data, error } = await supabase
    .from('ct_brain_telemetry')
    .select('id, error')
    .eq('consumer_name', consumerName)
    .gte('created_at', probeStart)
    .limit(1);

  if (error) {
    return {
      function: fn,
      http_status: 200,
      http_body_excerpt: httpBodyExcerpt,
      telemetry_landed: false,
      telemetry_error: `telemetry_query_error: ${error.message}`,
      latency_ms: Date.now() - startedAt,
      status: 'TELEMETRY_ERROR',
      classification_note: 'telemetry query itself failed; cannot verify',
    };
  }

  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    return {
      function: fn,
      http_status: 200,
      http_body_excerpt: httpBodyExcerpt,
      telemetry_landed: false,
      telemetry_error: null,
      latency_ms: Date.now() - startedAt,
      status: 'SILENT_FAIL',
      classification_note: `HTTP 200 but no telemetry row from consumer=${consumerName} in ${config.wait_seconds}s window — silent-no-op suspected`,
    };
  }

  const teleErr = (rows[0] as { error?: string | null }).error ?? null;
  const isWarning = teleErr && (teleErr.startsWith('warning:') || teleErr.startsWith('skipped:'));

  if (teleErr && !isWarning) {
    return {
      function: fn,
      http_status: 200,
      http_body_excerpt: httpBodyExcerpt,
      telemetry_landed: true,
      telemetry_error: teleErr,
      latency_ms: Date.now() - startedAt,
      status: 'TELEMETRY_ERROR',
      classification_note: `function ran but reported error inline: ${teleErr.slice(0, 100)}`,
    };
  }

  return {
    function: fn,
    http_status: 200,
    http_body_excerpt: httpBodyExcerpt,
    telemetry_landed: true,
    telemetry_error: teleErr,
    latency_ms: Date.now() - startedAt,
    status: 'PASS',
    classification_note: isWarning ? `degraded but acceptable: ${teleErr}` : 'healthy',
  };
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(
      JSON.stringify({ error: 'Unauthorized — service role required' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const body = await req.json().catch(() => ({})) as Partial<ProbeRequest>;
  const functionNames = Array.isArray(body.function_names) ? body.function_names : [];
  const httpOnly = body.http_only === true;
  const waitOverride = typeof body.wait_seconds_override === 'number' ? body.wait_seconds_override : null;

  if (functionNames.length === 0) {
    return new Response(
      JSON.stringify({ error: 'function_names array required' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const t0 = Date.now();
  const results = await Promise.all(
    functionNames.map((fn) => {
      let cfg = PROBE_CONFIG[fn] ?? null;
      if (cfg && waitOverride !== null) {
        cfg = { ...cfg, wait_seconds: waitOverride };
      }
      return probeOne(supabaseUrl, serviceRoleKey, supabase, fn, cfg, httpOnly);
    }),
  );

  const failed = results.filter(r => r.status !== 'PASS' && r.status !== 'NOT_CONFIGURED');
  const failedFns = failed.map(r => r.function);

  const response: ProbeResponse = {
    ok: failed.length === 0,
    results,
    failed_functions: failedFns,
    total_latency_ms: Date.now() - t0,
    generated_at: new Date().toISOString(),
  };

  return new Response(
    JSON.stringify(response, null, 2),
    {
      status: failed.length === 0 ? 200 : 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    },
  );
});
