/**
 * ct-system-warden — invariant-based self-supervision cron.
 *
 * Reads enabled rows from ct_invariants, executes each query via the
 * SELECT-only RPC `run_invariant_query(p_sql)`, classifies the outcome
 * (pass/fail/error), writes one append-only row to ct_invariant_log per
 * invariant per run, and updates ct_invariants summary fields.
 *
 * Slack rule: post ONCE on state CHANGE (pass→fail, pass→error,
 * fail→pass recovery, error→pass recovery, etc.) — never on every fail
 * run. State tracked in ct_warden_alarm_state (PRIMARY KEY = invariant
 * name). Daily heartbeat row uses name='_daily_heartbeat'.
 *
 * Cron: every 30min, all day (`* /30 * * * *` minus the space). Migration:
 *   supabase/migrations/20260501060000_schedule_warden_and_seed_invariants.sql
 *
 * Tenets: 24 (cross-component), 25 (structural evolution — adding an
 * invariant is an INSERT, not a code change), 13 (structural prevention
 * over validators).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isServiceRoleRequest } from '../_shared/auth.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface InvariantRow {
  name: string;
  category: string;
  description: string | null;
  query_sql: string;
  expected_min: number | string | null;
  expected_max: number | string | null;
  expected_bool: boolean | null;
  severity: 'info' | 'warn' | 'critical';
  runbook_path: string | null;
  enabled: boolean;
  consecutive_fails: number;
}

type RunStatus = 'pass' | 'fail' | 'error';

interface InvariantResult {
  name: string;
  category: string;
  severity: 'info' | 'warn' | 'critical';
  runbook_path: string | null;
  status: RunStatus;
  metric_value: number | null;
  message: string | null;
  error: string | null;
  consecutive_fails_after: number;
}

interface AlarmStateRow {
  invariant_name: string;
  current_status: RunStatus;
  state_changed_at: string;
  last_slack_posted_at: string | null;
  consecutive_count: number;
}

// ---------------------------------------------------------------------------
// Concurrency limiter (cap parallel RPCs)
// ---------------------------------------------------------------------------
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Status classification
// ---------------------------------------------------------------------------
function classifyResult(
  inv: InvariantRow,
  metricValue: number | null,
  rpcError: string | null,
): { status: RunStatus; reason: string } {
  if (rpcError) return { status: 'error', reason: rpcError };
  if (metricValue === null || Number.isNaN(metricValue)) {
    // Metric null with a numeric expectation = error (data shape mismatch).
    if (inv.expected_min !== null || inv.expected_max !== null || inv.expected_bool !== null) {
      return { status: 'error', reason: 'metric_value is null/NaN' };
    }
    return { status: 'pass', reason: 'no expectation set' };
  }

  // Boolean check (expected_bool true/false; metric should be 1 or 0).
  if (inv.expected_bool !== null) {
    const asBool = Math.round(metricValue) === 1;
    if (asBool === inv.expected_bool) return { status: 'pass', reason: 'bool match' };
    return { status: 'fail', reason: `expected_bool=${inv.expected_bool}, got=${asBool}` };
  }

  // Range check.
  const min = inv.expected_min === null ? null : Number(inv.expected_min);
  const max = inv.expected_max === null ? null : Number(inv.expected_max);
  if (min !== null && metricValue < min) {
    return { status: 'fail', reason: `${metricValue} < min ${min}` };
  }
  if (max !== null && metricValue > max) {
    return { status: 'fail', reason: `${metricValue} > max ${max}` };
  }
  return { status: 'pass', reason: 'within range' };
}

// ---------------------------------------------------------------------------
// Slack helpers
// ---------------------------------------------------------------------------
function severityEmoji(severity: 'info' | 'warn' | 'critical'): string {
  switch (severity) {
    case 'critical': return ':rotating_light:';   // 🚨
    case 'warn':     return ':red_circle:';       // 🔴
    case 'info':     return ':warning:';          // ⚠️
    default:         return ':warning:';
  }
}

function expectationText(inv: InvariantRow): string {
  if (inv.expected_bool !== null) return inv.expected_bool ? 'true' : 'false';
  const parts: string[] = [];
  if (inv.expected_min !== null) parts.push(`>= ${inv.expected_min}`);
  if (inv.expected_max !== null) parts.push(`<= ${inv.expected_max}`);
  return parts.length ? parts.join(' and ') : '(no expectation)';
}

function fmtMetric(v: number | null): string {
  if (v === null) return 'null';
  if (Number.isInteger(v)) return v.toString();
  return v.toFixed(2);
}

interface CachedSlackTarget {
  channelId: string | null;
  botToken: string | null;
}
let SLACK_TARGET: CachedSlackTarget | null = null;

async function resolveSlackTarget(supabase: SupabaseClient): Promise<CachedSlackTarget> {
  if (SLACK_TARGET) return SLACK_TARGET;
  const botToken = Deno.env.get('SLACK_BOT_TOKEN') ?? null;
  let channelId: string | null = null;
  try {
    // Single-user system — pick the row that has slack_channel_id set.
    const { data } = await supabase
      .from('user_settings')
      .select('settings')
      .limit(50);
    for (const row of (data ?? []) as Array<{ settings: Record<string, unknown> | null }>) {
      const id = row.settings?.slack_channel_id as string | undefined;
      if (id) { channelId = id; break; }
    }
  } catch (e) {
    console.warn('[warden] slack channel lookup failed:', e instanceof Error ? e.message : e);
  }
  SLACK_TARGET = { channelId, botToken };
  return SLACK_TARGET;
}

async function postSlack(
  supabase: SupabaseClient,
  text: string,
  blocks: Array<Record<string, unknown>>,
): Promise<boolean> {
  try {
    const target = await resolveSlackTarget(supabase);
    if (!target.botToken || !target.channelId) return false;
    const res = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${target.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: target.channelId,
        text,
        blocks,
        mrkdwn: true,
      }),
    });
    if (!res.ok) {
      console.warn('[warden] slack post http', res.status);
      return false;
    }
    const j = await res.json().catch(() => ({}));
    if (!j.ok) {
      console.warn('[warden] slack ok:false', j.error);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[warden] slack exception (non-blocking):', e instanceof Error ? e.message : e);
    return false;
  }
}

function buildFailBlocks(args: {
  inv: InvariantRow;
  status: 'fail' | 'error';
  metricValue: number | null;
  message: string | null;
  errorText: string | null;
  consecutiveFails: number;
}): { text: string; blocks: Array<Record<string, unknown>> } {
  const { inv, status, metricValue, message, errorText, consecutiveFails } = args;
  const emoji = severityEmoji(inv.severity);
  const valueText = status === 'error'
    ? `\`error\``
    : `\`${fmtMetric(metricValue)}\``;
  const expected = expectationText(inv);
  const detail = errorText
    ? `_error: ${errorText}_`
    : message
      ? `_${message}_`
      : '';
  const consecutiveLine = consecutiveFails > 1
    ? `Failed for *${consecutiveFails}* consecutive runs`
    : `First fail of this run`;
  const runbookLine = inv.runbook_path
    ? `Runbook: \`${inv.runbook_path}\``
    : `Runbook: (none)`;

  const headlineMd =
    `${emoji}  *[WARDEN ${inv.severity}]* \`${inv.name}\` — ${status}\n` +
    `Value: ${valueText}  · Expected: \`${expected}\`\n` +
    `${consecutiveLine}\n${runbookLine}`;
  const blocks: Array<Record<string, unknown>> = [
    { type: 'section', text: { type: 'mrkdwn', text: headlineMd } },
  ];
  if (detail) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: detail }] });
  }
  const fallbackText = `[WARDEN ${inv.severity}] ${inv.name} — ${status} (value=${fmtMetric(metricValue)} expected=${expected})`;
  return { text: fallbackText, blocks };
}

function buildRecoveryBlocks(args: {
  inv: InvariantRow;
  metricValue: number | null;
  message: string | null;
  priorStatus: RunStatus;
  priorRunsInState: number;
}): { text: string; blocks: Array<Record<string, unknown>> } {
  const { inv, metricValue, message, priorStatus, priorRunsInState } = args;
  const headlineMd =
    `:white_check_mark:  *[WARDEN RECOVERED]* \`${inv.name}\`\n` +
    `Was *${priorStatus}* for *${priorRunsInState}* run(s); now passing at \`${fmtMetric(metricValue)}\`.\n` +
    (inv.runbook_path ? `Runbook: \`${inv.runbook_path}\`` : `Runbook: (none)`);
  const blocks: Array<Record<string, unknown>> = [
    { type: 'section', text: { type: 'mrkdwn', text: headlineMd } },
  ];
  if (message) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_${message}_` }] });
  }
  const fallbackText = `[WARDEN RECOVERED] ${inv.name} — back to pass after ${priorRunsInState} ${priorStatus} run(s)`;
  return { text: fallbackText, blocks };
}

function buildHeartbeatBlocks(passing: number, totalEnabled: number): { text: string; blocks: Array<Record<string, unknown>> } {
  const text = `[WARDEN heartbeat] all clear — ${passing}/${totalEnabled} invariants passing`;
  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `:green_heart:  *[WARDEN heartbeat]*  All clear — *${passing}/${totalEnabled}* invariants passing`,
      },
    },
  ];
  return { text, blocks };
}

// ---------------------------------------------------------------------------
// Daily-heartbeat scheduling helper
//   "first run after midnight UTC OR midnight ET, with 0 state changes"
// We persist the last heartbeat date (UTC YYYY-MM-DD AND ET YYYY-MM-DD joined)
// inside ct_warden_alarm_state under the synthetic name '_daily_heartbeat'.
// ---------------------------------------------------------------------------
const HEARTBEAT_KEY = '_daily_heartbeat';

function todayKeyUtcEt(now: Date): string {
  const utc = now.toISOString().slice(0, 10);
  // ET formatter
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const et = fmt.format(now); // YYYY-MM-DD
  return `${utc}|${et}`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
serve(async (req: Request): Promise<Response> => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  // Auth gate — accept either authenticated POST (cron via vault key matches
  // SUPABASE_SERVICE_ROLE_KEY at runtime) or a manual invocation through the
  // RPC pattern. Frontend never calls this — verify_jwt = false but we still
  // require service-role.
  if (!isServiceRoleRequest(req)) {
    return new Response(
      JSON.stringify({ ok: false, error: 'unauthorized — service role required' }),
      { status: 401, headers: jsonHeaders },
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    return new Response(
      JSON.stringify({ ok: false, error: 'missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY' }),
      { status: 500, headers: jsonHeaders },
    );
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const t0 = Date.now();

  // ---------- 1) Read enabled invariants -----------------------------------
  const { data: invariantsData, error: readErr } = await supabase
    .from('ct_invariants')
    .select('name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path, enabled, consecutive_fails')
    .eq('enabled', true)
    .order('name', { ascending: true });

  if (readErr) {
    return new Response(
      JSON.stringify({ ok: false, error: `read ct_invariants failed: ${readErr.message}` }),
      { status: 500, headers: jsonHeaders },
    );
  }

  const invariants = (invariantsData ?? []) as InvariantRow[];

  // ---------- 2) Execute each invariant in parallel (cap=8) -----------------
  const results: InvariantResult[] = await runWithConcurrency(invariants, 8, async (inv) => {
    let metricValue: number | null = null;
    let messageText: string | null = null;
    let rpcErrorText: string | null = null;

    try {
      const { data, error } = await supabase.rpc('run_invariant_query', { p_sql: inv.query_sql });
      if (error) {
        rpcErrorText = error.message ?? 'unknown rpc error';
      } else {
        const rows = Array.isArray(data) ? data : (data == null ? [] : [data]);
        if (rows.length === 0) {
          rpcErrorText = 'rpc returned no rows';
        } else {
          const r = rows[0] as { metric_value?: number | string | null; message?: string | null };
          if (r.metric_value === undefined) {
            rpcErrorText = 'rpc row missing metric_value column';
          } else if (r.metric_value === null) {
            metricValue = null;
            messageText = (r.message ?? null) as string | null;
          } else {
            const n = Number(r.metric_value);
            metricValue = Number.isFinite(n) ? n : null;
            messageText = (r.message ?? null) as string | null;
          }
        }
      }
    } catch (e) {
      rpcErrorText = e instanceof Error ? e.message : String(e);
    }

    const { status, reason } = classifyResult(inv, metricValue, rpcErrorText);
    const errorOut = status === 'error' ? (rpcErrorText ?? reason) : null;
    const consecutiveAfter = (status === 'fail' || status === 'error')
      ? (inv.consecutive_fails ?? 0) + 1
      : 0;

    // 2a) Append to ct_invariant_log (best-effort — never throw out).
    try {
      await supabase.from('ct_invariant_log').insert({
        invariant_name: inv.name,
        status,
        value: metricValue === null ? null : String(metricValue),
        message: messageText ?? (status === 'pass' ? reason : (errorOut ?? reason)),
        severity: inv.severity,
        runbook_path: inv.runbook_path,
      });
    } catch (e) {
      console.warn('[warden] ct_invariant_log insert failed:', e instanceof Error ? e.message : e);
    }

    // 2b) Update ct_invariants summary fields.
    try {
      await supabase
        .from('ct_invariants')
        .update({
          last_run_at: new Date().toISOString(),
          last_status: status,
          last_value: metricValue === null ? null : String(metricValue),
          last_error: errorOut,
          consecutive_fails: consecutiveAfter,
        })
        .eq('name', inv.name);
    } catch (e) {
      console.warn('[warden] ct_invariants update failed:', e instanceof Error ? e.message : e);
    }

    return {
      name: inv.name,
      category: inv.category,
      severity: inv.severity,
      runbook_path: inv.runbook_path,
      status,
      metric_value: metricValue,
      message: messageText,
      error: errorOut,
      consecutive_fails_after: consecutiveAfter,
    };
  });

  // ---------- 3) Read prior alarm state for state-change diffs --------------
  const { data: priorStateData } = await supabase
    .from('ct_warden_alarm_state')
    .select('invariant_name, current_status, state_changed_at, last_slack_posted_at, consecutive_count');
  const priorByName = new Map<string, AlarmStateRow>();
  for (const row of (priorStateData ?? []) as AlarmStateRow[]) {
    priorByName.set(row.invariant_name, row);
  }

  // ---------- 4) Compute state changes + post Slack -------------------------
  const invByName = new Map(invariants.map(i => [i.name, i]));
  let stateChanges = 0;
  let slackPosts = 0;

  for (const r of results) {
    const inv = invByName.get(r.name);
    if (!inv) continue;
    const prior = priorByName.get(r.name);
    const priorStatus = prior?.current_status ?? null;
    const isStateChange = priorStatus !== r.status;

    if (isStateChange) {
      stateChanges++;
      const nowIso = new Date().toISOString();

      let posted = false;
      if (priorStatus === 'pass' && (r.status === 'fail' || r.status === 'error')) {
        const { text, blocks } = buildFailBlocks({
          inv,
          status: r.status,
          metricValue: r.metric_value,
          message: r.message,
          errorText: r.error,
          consecutiveFails: r.consecutive_fails_after,
        });
        posted = await postSlack(supabase, text, blocks);
      } else if ((priorStatus === 'fail' || priorStatus === 'error') && r.status === 'pass') {
        const { text, blocks } = buildRecoveryBlocks({
          inv,
          metricValue: r.metric_value,
          message: r.message,
          priorStatus,
          priorRunsInState: prior?.consecutive_count ?? 1,
        });
        posted = await postSlack(supabase, text, blocks);
      } else if (priorStatus === null && (r.status === 'fail' || r.status === 'error')) {
        // First-ever observation that's already failing: post.
        const { text, blocks } = buildFailBlocks({
          inv,
          status: r.status,
          metricValue: r.metric_value,
          message: r.message,
          errorText: r.error,
          consecutiveFails: r.consecutive_fails_after,
        });
        posted = await postSlack(supabase, text, blocks);
      } else if (priorStatus === 'fail' && r.status === 'error') {
        // Already-failing invariant degraded to error. Treat as state change Slack.
        const { text, blocks } = buildFailBlocks({
          inv,
          status: 'error',
          metricValue: r.metric_value,
          message: r.message,
          errorText: r.error,
          consecutiveFails: r.consecutive_fails_after,
        });
        posted = await postSlack(supabase, text, blocks);
      } else if (priorStatus === 'error' && r.status === 'fail') {
        // Recovered from error to plain fail — minor improvement, log only.
        // No Slack to avoid noise. Tracked in ct_invariant_log already.
      }
      if (posted) slackPosts++;

      try {
        await supabase
          .from('ct_warden_alarm_state')
          .upsert({
            invariant_name: r.name,
            current_status: r.status,
            state_changed_at: nowIso,
            last_slack_posted_at: posted ? nowIso : prior?.last_slack_posted_at ?? null,
            consecutive_count: 1,
          }, { onConflict: 'invariant_name' });
      } catch (e) {
        console.warn('[warden] alarm_state upsert failed:', e instanceof Error ? e.message : e);
      }
    } else if (prior) {
      // Same state — just bump the counter so recovery can report duration.
      try {
        await supabase
          .from('ct_warden_alarm_state')
          .update({ consecutive_count: (prior.consecutive_count ?? 1) + 1 })
          .eq('invariant_name', r.name);
      } catch (e) {
        console.warn('[warden] alarm_state bump failed:', e instanceof Error ? e.message : e);
      }
    } else {
      // No prior state row, status is pass — initialize.
      try {
        await supabase
          .from('ct_warden_alarm_state')
          .upsert({
            invariant_name: r.name,
            current_status: r.status,
            state_changed_at: new Date().toISOString(),
            last_slack_posted_at: null,
            consecutive_count: 1,
          }, { onConflict: 'invariant_name' });
      } catch (e) {
        console.warn('[warden] alarm_state init failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  // ---------- 5) Daily heartbeat --------------------------------------------
  // Fires at most once per (UTC date, ET date) tuple, only when there are 0
  // state changes this run AND the most recent run for the day has not yet
  // fired the heartbeat.
  let heartbeatPosted = false;
  if (stateChanges === 0 && results.length > 0) {
    const todayKey = todayKeyUtcEt(new Date());
    const { data: hbState } = await supabase
      .from('ct_warden_alarm_state')
      .select('invariant_name, current_status, state_changed_at')
      .eq('invariant_name', HEARTBEAT_KEY)
      .maybeSingle();
    const lastKey = (hbState?.current_status ?? '').toString();
    // We pack the last-fired-key into current_status field — schema only
    // permits pass/fail/error, so we cheat: store the key into
    // state_changed_at-tagged comment.  Cleaner: use a stable status='pass'
    // and read state_changed_at's own date.
    const lastStateChangedAt = hbState?.state_changed_at ?? null;
    let firedTodayKey: string | null = null;
    if (lastStateChangedAt) {
      firedTodayKey = todayKeyUtcEt(new Date(lastStateChangedAt));
    }
    void lastKey; // unused — heartbeat key lookup uses state_changed_at
    if (firedTodayKey !== todayKey) {
      const passing = results.filter(r => r.status === 'pass').length;
      const { text, blocks } = buildHeartbeatBlocks(passing, results.length);
      heartbeatPosted = await postSlack(supabase, text, blocks);
      if (heartbeatPosted) slackPosts++;
      try {
        await supabase
          .from('ct_warden_alarm_state')
          .upsert({
            invariant_name: HEARTBEAT_KEY,
            current_status: 'pass',
            state_changed_at: new Date().toISOString(),
            last_slack_posted_at: heartbeatPosted ? new Date().toISOString() : null,
            consecutive_count: 1,
          }, { onConflict: 'invariant_name' });
      } catch (e) {
        console.warn('[warden] heartbeat state upsert failed:', e instanceof Error ? e.message : e);
      }
    }
  }

  // ---------- 6) Summary response -------------------------------------------
  const summary = {
    ok: true,
    total: results.length,
    passed: results.filter(r => r.status === 'pass').length,
    failed: results.filter(r => r.status === 'fail').length,
    errored: results.filter(r => r.status === 'error').length,
    state_changes: stateChanges,
    slack_posts: slackPosts,
    heartbeat_posted: heartbeatPosted,
    duration_ms: Date.now() - t0,
    failures: results
      .filter(r => r.status !== 'pass')
      .map(r => ({
        name: r.name,
        status: r.status,
        severity: r.severity,
        value: r.metric_value,
        error: r.error,
      })),
  };

  return new Response(JSON.stringify(summary), { status: 200, headers: jsonHeaders });
});
