/**
 * ct-replay — Historical Replay Harness for Co-Trader
 *
 * Takes a session (date) and re-runs the watcher's decision logic against the
 * raw UW state snapshots captured that day — applying the CURRENT cooldown
 * and alert-book-commit guards — without touching live markets.
 *
 * This is a SIMULATION, not a perfect recreation. Claude decisions are
 * non-deterministic even at temp 0. The report frames results as:
 *   "given today's raw tape, the NEW logic would have produced roughly THIS
 *    distribution vs the OLD logic actually produced THAT distribution."
 *
 * Shortcuts for v1:
 *   - Stripped memory bundle (recent theses + heartbeat's recent_flow_alerts
 *     only — no full recall)
 *   - Haiku only (cheaper, faster — we compare structure not depth)
 *   - Cap 40 ticks per replay (one full 6.5h session)
 *   - dry_run only — NO writes to real tables
 *
 * Body:
 *   {
 *     "session_date": "2026-04-17",
 *     "dry_run": true,
 *     "modules": ["watcher_writes", "cooldown", "alert_book_commit"]
 *   }
 *
 * Returns: per-tick replay state vs actual state, actual vs replay counts,
 * and the list of trades alert-book-commit would have opened under replay.
 *
 * Auth: JWT (user) OR service role. No external writes in v1.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { extractUserIdWithServiceRole, isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, calculateCost, ClaudeError } from '../_shared/anthropic.ts';
import { CT_SYSTEM_PROMPT_V1 } from '../_shared/systemPromptV1.ts';

// Replay caps
const MAX_TICKS = 40;
const HAIKU_MAX_TOKENS = 2000;
const DEFAULT_MODULES = ['watcher_writes', 'cooldown', 'alert_book_commit'] as const;

// Mirror ct-alert-book-commit.WATCHLIST (12 instruments)
const ALERT_WHITELIST = new Set([
  'SPY', 'QQQ', 'IWM', 'NVDA', 'AAPL', 'MSFT',
  'META', 'GOOGL', 'AMZN', 'TSLA', 'GLD', 'USO',
]);

// Cooldown thresholds (mirror ct-watcher + ct-alert-book-commit)
const SAME_DIR_COOLDOWN_MS = 30 * 60 * 1000;
const INVALIDATION_COOLDOWN_MS = 60 * 60 * 1000;
const ALERT_COMMIT_COOLDOWN_MS = 60 * 60 * 1000;

type CtState = 'HEARTBEAT' | 'OBSERVATION' | 'FLAG' | 'ALERT';
type Direction = 'bullish' | 'bearish' | 'neutral' | 'volatility';

interface ClaudeJson {
  state: CtState;
  status_line?: string;
  instruments?: string[];
  observation?: string;
  direction?: Direction;
  glance?: string[];
  conviction?: number;
  horizon?: string;
  alert_trigger?: 'regime_shift' | 'thesis_invalidation' | 'news' | 'vol_event' | 'other';
  trade_setup?: {
    instrument?: string;
    strike?: number;
    stop_level?: number;
    target_level?: number;
    entry_level?: number;
    rationale?: string;
  } | null;
}

interface ReplayTick {
  tick_time: string;
  heartbeat_id: string;
  actual_state: CtState;
  actual_event_id: string | null;
  replay_state: CtState;
  replay_direction: Direction | null;
  replay_conviction: number | null;
  replay_instruments: string[];
  replay_alert_trigger: string | null;
  replay_demoted_to: 'observation' | 'flag' | null;
  replay_demote_reason: string | null;
  replay_trade_setup: ClaudeJson['trade_setup'] | null;
  changed: boolean;
  claude_ok: boolean;
  input_tokens: number;
  output_tokens: number;
}

interface AlertCommitDecision {
  alert_ref: string;
  tick_time: string;
  instrument: string;
  direction: Direction;
  passed_guards: boolean;
  reason: string;
  entry_level: number | null;
}

// ============================================================================
// Helpers
// ============================================================================

function parseClaudeJson(raw: string): ClaudeJson | null {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    if (!obj || typeof obj !== 'object' || typeof obj.state !== 'string') return null;
    return obj as ClaudeJson;
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]);
        if (obj?.state) return obj as ClaudeJson;
      } catch { /* fall through */ }
    }
    return null;
  }
}

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function ciOverlap(a: string[], b: string[]): boolean {
  const bu = new Set(b.map(s => s.toUpperCase()));
  return a.some(s => bu.has(s.toUpperCase()));
}

/**
 * Apply cooldown logic over ORDERED replay events in the simulation timeline.
 * Returns the post-cooldown state (ALERT may demote to FLAG or OBSERVATION).
 *
 * This mirrors ct-watcher writeAlert() cooldowns but against the replay's
 * OWN synthetic alert history — not the real ct_alerts table.
 */
function applyCooldown(
  candidate: ClaudeJson,
  tickTimeMs: number,
  priorReplayAlerts: Array<{ time_ms: number; direction: Direction; instruments: string[]; trigger: string }>,
): { state: CtState; demotedTo: 'observation' | 'flag' | null; reason: string | null; conviction: number | null } {
  if (candidate.state !== 'ALERT') {
    return {
      state: candidate.state,
      demotedTo: null,
      reason: null,
      conviction: typeof candidate.conviction === 'number' ? candidate.conviction : null,
    };
  }
  const instruments = toArray(candidate.instruments).filter(Boolean) as string[];
  const direction = candidate.direction ?? 'neutral';
  const trigger = candidate.alert_trigger ?? 'other';

  // Check 1: thesis_invalidation within 60min
  if (trigger === 'thesis_invalidation') {
    const hit = priorReplayAlerts.find(a =>
      a.trigger === 'thesis_invalidation'
      && (tickTimeMs - a.time_ms) < INVALIDATION_COOLDOWN_MS
      && ciOverlap(a.instruments, instruments)
    );
    if (hit) {
      return { state: 'FLAG', demotedTo: 'flag', reason: 'invalidation_cooldown_60min', conviction: 3 };
    }
  }

  // Check 2: same-direction within 30min
  if (direction === 'bullish' || direction === 'bearish') {
    const hit = priorReplayAlerts.find(a =>
      a.direction === direction
      && (tickTimeMs - a.time_ms) < SAME_DIR_COOLDOWN_MS
      && ciOverlap(a.instruments, instruments)
    );
    if (hit) {
      return { state: 'OBSERVATION', demotedTo: 'observation', reason: 'same_direction_cooldown_30min', conviction: null };
    }
  }

  return { state: 'ALERT', demotedTo: null, reason: null, conviction: 5 };
}

/**
 * Apply ct-alert-book-commit guards in simulation. We do NOT run the bias
 * table or live price fetch — v1 uses the alert's own entry_level as a proxy.
 * Returns one decision per post-cooldown ALERT.
 */
function simulateAlertBookCommit(
  replayAlerts: Array<{
    alert_ref: string;
    tick_time_ms: number;
    tick_time_iso: string;
    instruments: string[];
    direction: Direction;
    trigger: string;
    trade_setup: ClaudeJson['trade_setup'];
  }>,
): AlertCommitDecision[] {
  const decisions: AlertCommitDecision[] = [];
  // Track committed trades in sim for cooldown + capacity
  const committedAt: number[] = [];
  let openCount = 0;
  let totalExposure = 0;
  const ALERT_SIZE_PCT = 20;

  for (const a of replayAlerts) {
    const setup = a.trade_setup;
    const instrument = (setup?.instrument ?? a.instruments[0] ?? '').toUpperCase();

    if (!setup || !instrument) {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'no_trade_setup', entry_level: null,
      });
      continue;
    }

    // Skip invalidation alerts — they close, not open
    if (a.trigger === 'thesis_invalidation') {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'invalidation_does_not_open', entry_level: setup.entry_level ?? null,
      });
      continue;
    }

    // Only directional
    if (a.direction !== 'bullish' && a.direction !== 'bearish') {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'non_directional', entry_level: setup.entry_level ?? null,
      });
      continue;
    }

    // Whitelist
    if (!ALERT_WHITELIST.has(instrument)) {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'instrument_not_whitelisted', entry_level: setup.entry_level ?? null,
      });
      continue;
    }

    // Cooldown — 60min since last committed
    const lastCommitMs = committedAt.length > 0 ? committedAt[committedAt.length - 1] : -Infinity;
    if (a.tick_time_ms - lastCommitMs < ALERT_COMMIT_COOLDOWN_MS) {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'commit_cooldown_60min', entry_level: setup.entry_level ?? null,
      });
      continue;
    }

    // Capacity
    if (openCount >= 3) {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'book_full', entry_level: setup.entry_level ?? null,
      });
      continue;
    }
    if (totalExposure + ALERT_SIZE_PCT > 100) {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'exposure_cap', entry_level: setup.entry_level ?? null,
      });
      continue;
    }

    // Passed (no live price check in sim — use entry_level as proxy)
    decisions.push({
      alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
      passed_guards: true, reason: 'passed_all_guards',
      entry_level: setup.entry_level ?? null,
    });
    committedAt.push(a.tick_time_ms);
    openCount += 1;
    totalExposure += ALERT_SIZE_PCT;
  }
  return decisions;
}

/**
 * Build the stripped memory bundle for a tick — shortcut. Not the full
 * memoryRecall.ts bundle. Just: latest thesis per instrument, plus whatever
 * recent_flow_alerts the snapshot captured.
 */
async function buildStrippedMemory(
  supabase: SupabaseClient,
  tickIso: string,
  snapshot: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Latest thesis per instrument as of the tick
  const { data: theses } = await supabase
    .from('ct_theses')
    .select('instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at')
    .lt('updated_at', tickIso)
    .order('updated_at', { ascending: false })
    .limit(20);

  const byInstrument = new Map<string, unknown>();
  for (const t of (theses ?? []) as Array<{ instrument: string }>) {
    if (!byInstrument.has(t.instrument)) byInstrument.set(t.instrument, t);
  }

  return {
    theses: Array.from(byInstrument.entries()).reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {} as Record<string, unknown>),
    // Flow alerts from the heartbeat snapshot itself (if the watcher tucked
    // them there). For v1 we just surface what the heartbeat recorded.
    snapshot_summary: snapshot && typeof snapshot === 'object' ? {
      per_ticker: (snapshot as { per_ticker?: unknown }).per_ticker ?? null,
      timestamp: (snapshot as { timestamp?: unknown }).timestamp ?? tickIso,
    } : null,
  };
}

// ============================================================================
// Main handler
// ============================================================================

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await req.text();
    body = raw ? JSON.parse(raw) : {};
  } catch {
    // Tolerate empty/invalid body and default to today — lets _ct_post
    // fire a "replay today" run from pg_cron or SQL editor without a body.
    body = {};
  }

  // Replay is read-only / dry-run — service role alone is sufficient.
  // Accept service role without a userId in body (so _ct_post and pg_cron
  // can fire it), OR accept a user JWT (the Replay page).
  let auth: { userId: string | null; error: string | null; supabase: SupabaseClient | null };
  if (isServiceRoleRequest(req)) {
    auth = {
      userId: typeof body.userId === 'string' ? body.userId : null,
      error: null,
      supabase: createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      ),
    };
  } else {
    auth = await extractUserIdWithServiceRole(req, body);
    if (auth.error && !auth.supabase) {
      return new Response(JSON.stringify({ error: auth.error }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // Default session_date to today (America/New_York) so an empty-body invoke
  // replays the current session without requiring a body through _ct_post.
  const todayEt = new Date(Date.now() - 4 * 3600_000).toISOString().slice(0, 10);
  const sessionDate = typeof body.session_date === 'string' ? body.session_date : todayEt;
  const dryRun = body.dry_run !== false; // default true
  const modules = Array.isArray(body.modules) && body.modules.length > 0
    ? (body.modules as string[])
    : [...DEFAULT_MODULES];

  if (!sessionDate || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    return new Response(JSON.stringify({ error: 'session_date (YYYY-MM-DD) required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!dryRun) {
    return new Response(JSON.stringify({ error: 'dry_run=false not implemented in v1 — shadow tables not built yet' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Service-role client for reads (bypasses RLS so we see all ct_* rows)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const sessionStartIso = `${sessionDate}T00:00:00.000Z`;
  const sessionEndIso = `${sessionDate}T23:59:59.999Z`;

  // 1. Pull heartbeats with current_reads for the day, excluding uw-probe rows
  const { data: hbRows, error: hbErr } = await supabase
    .from('ct_heartbeats')
    .select('id, created_at, status_line, watching, current_reads, prompt_version')
    .gte('created_at', sessionStartIso)
    .lte('created_at', sessionEndIso)
    .not('current_reads', 'is', null)
    .neq('prompt_version', 'uw-probe')
    .order('created_at', { ascending: true })
    .limit(MAX_TICKS);

  if (hbErr) {
    return new Response(JSON.stringify({ error: `heartbeat query failed: ${hbErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const heartbeats = hbRows ?? [];
  if (heartbeats.length === 0) {
    return new Response(JSON.stringify({
      session_date: sessionDate,
      dry_run: dryRun,
      modules,
      note: 'no heartbeat rows with current_reads in session — nothing to replay',
      actual_writes: { observations: 0, flags: 0, alerts: 0 },
      replay_writes: { observations: 0, flags: 0, alerts: 0, demoted: 0 },
      per_tick: [],
      alert_commit_decisions: [],
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // 2. Pull ACTUAL watcher writes for the same day for diffing
  const [obsActual, flagsActual, alertsActual] = await Promise.all([
    supabase.from('ct_observations').select('id, instruments, direction, created_at')
      .gte('created_at', sessionStartIso).lte('created_at', sessionEndIso).order('created_at', { ascending: true }),
    supabase.from('ct_flags').select('id, instruments, direction, conviction, created_at')
      .gte('created_at', sessionStartIso).lte('created_at', sessionEndIso).order('created_at', { ascending: true }),
    supabase.from('ct_alerts').select('id, instruments, direction, alert_trigger, committed_trade_id, created_at')
      .gte('created_at', sessionStartIso).lte('created_at', sessionEndIso).order('created_at', { ascending: true }),
  ]);

  const actualObs = obsActual.data ?? [];
  const actualFlags = flagsActual.data ?? [];
  const actualAlerts = alertsActual.data ?? [];
  const actualCommittedTrades = actualAlerts.filter(a => !!a.committed_trade_id).length;

  // Index actual events by tick time (nearest heartbeat within ±90s) for diffing
  const TICK_MATCH_WINDOW_MS = 90_000;
  type ActualEvent = { state: CtState; id: string; created_at: string };
  const actualByTime: ActualEvent[] = [
    ...actualObs.map(o => ({ state: 'OBSERVATION' as CtState, id: o.id as string, created_at: o.created_at as string })),
    ...actualFlags.map(f => ({ state: 'FLAG' as CtState, id: f.id as string, created_at: f.created_at as string })),
    ...actualAlerts.map(a => ({ state: 'ALERT' as CtState, id: a.id as string, created_at: a.created_at as string })),
  ].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));

  function nearestActual(tickMs: number): ActualEvent | null {
    let best: ActualEvent | null = null;
    let bestDelta = Infinity;
    for (const e of actualByTime) {
      const d = Math.abs(Date.parse(e.created_at) - tickMs);
      if (d < bestDelta && d <= TICK_MATCH_WINDOW_MS) {
        bestDelta = d;
        best = e;
      }
    }
    return best;
  }

  // 3. Replay loop
  const perTick: ReplayTick[] = [];
  const priorReplayAlerts: Array<{ time_ms: number; direction: Direction; instruments: string[]; trigger: string }> = [];
  const replayAlertsForCommit: Array<{
    alert_ref: string;
    tick_time_ms: number;
    tick_time_iso: string;
    instruments: string[];
    direction: Direction;
    trigger: string;
    trade_setup: ClaudeJson['trade_setup'];
  }> = [];

  let replayObs = 0, replayFlags = 0, replayAlertsCount = 0, replayDemoted = 0;
  let totalIn = 0, totalOut = 0;

  for (const hb of heartbeats) {
    const tickIso = hb.created_at as string;
    const tickMs = Date.parse(tickIso);
    const snapshot = (hb.current_reads as { _snapshot?: Record<string, unknown> } | null)?._snapshot ?? {};

    // Build stripped memory
    const strippedMemory = await buildStrippedMemory(supabase, tickIso, snapshot);

    // Claude user message — much lighter than live watcher's
    const userMessage = JSON.stringify({
      timestamp_utc: tickIso,
      mode: 'REPLAY',
      market_state: snapshot,
      memory: strippedMemory,
      note: 'REPLAY MODE — you are re-deciding state against a historical snapshot. Return the JSON state per the system prompt. Use the stripped memory bundle as-is; do not hallucinate recall.',
    });

    let parsed: ClaudeJson | null = null;
    let claudeOk = false;
    let inTok = 0, outTok = 0;
    try {
      const response = await callClaude({
        model: CLAUDE_MODELS.haiku,
        system: CT_SYSTEM_PROMPT_V1,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: HAIKU_MAX_TOKENS,
        temperature: 0.2,
      });
      const text = parseTextContent(response);
      parsed = parseClaudeJson(text);
      claudeOk = !!parsed;
      inTok = response.usage?.input_tokens ?? 0;
      outTok = response.usage?.output_tokens ?? 0;
      totalIn += inTok;
      totalOut += outTok;
    } catch (e) {
      console.warn(`[ct-replay] claude call failed at tick ${tickIso}:`, e instanceof ClaudeError ? `${e.status} ${e.message}` : String(e));
    }

    // Effective state after cooldown
    const candidate: ClaudeJson = parsed ?? { state: 'HEARTBEAT' };
    const postCooldown = applyCooldown(candidate, tickMs, priorReplayAlerts);

    // Count
    if (postCooldown.state === 'OBSERVATION') replayObs++;
    else if (postCooldown.state === 'FLAG') replayFlags++;
    else if (postCooldown.state === 'ALERT') replayAlertsCount++;
    if (postCooldown.demotedTo) replayDemoted++;

    // If candidate was ALERT and survived cooldown, register for book-commit sim
    const instruments = toArray(candidate.instruments).filter(Boolean) as string[];
    if (candidate.state === 'ALERT' && postCooldown.state === 'ALERT' && instruments.length > 0) {
      priorReplayAlerts.push({
        time_ms: tickMs,
        direction: candidate.direction ?? 'neutral',
        instruments,
        trigger: candidate.alert_trigger ?? 'other',
      });
      replayAlertsForCommit.push({
        alert_ref: `replay-${hb.id}`,
        tick_time_ms: tickMs,
        tick_time_iso: tickIso,
        instruments,
        direction: candidate.direction ?? 'neutral',
        trigger: candidate.alert_trigger ?? 'other',
        trade_setup: candidate.trade_setup ?? null,
      });
    }

    // Diff vs actual
    const actual = nearestActual(tickMs);
    const actualState: CtState = actual?.state ?? 'HEARTBEAT';
    const changed = actualState !== postCooldown.state;

    perTick.push({
      tick_time: tickIso,
      heartbeat_id: hb.id as string,
      actual_state: actualState,
      actual_event_id: actual?.id ?? null,
      replay_state: postCooldown.state,
      replay_direction: candidate.direction ?? null,
      replay_conviction: postCooldown.conviction,
      replay_instruments: instruments,
      replay_alert_trigger: candidate.alert_trigger ?? null,
      replay_demoted_to: postCooldown.demotedTo,
      replay_demote_reason: postCooldown.reason,
      replay_trade_setup: candidate.trade_setup ?? null,
      changed,
      claude_ok: claudeOk,
      input_tokens: inTok,
      output_tokens: outTok,
    });
  }

  // 4. Alert-book-commit simulation
  const alertCommitDecisions = modules.includes('alert_book_commit')
    ? simulateAlertBookCommit(replayAlertsForCommit)
    : [];
  const replayCommitted = alertCommitDecisions.filter(d => d.passed_guards).length;

  // 5. Cost estimate
  const costUsd = calculateCost(CLAUDE_MODELS.haiku, { input_tokens: totalIn, output_tokens: totalOut });

  return new Response(JSON.stringify({
    session_date: sessionDate,
    dry_run: dryRun,
    modules,
    ticks_replayed: heartbeats.length,
    max_ticks: MAX_TICKS,
    actual_writes: {
      observations: actualObs.length,
      flags: actualFlags.length,
      alerts: actualAlerts.length,
    },
    actual_trades_committed: actualCommittedTrades,
    replay_writes: {
      observations: replayObs,
      flags: replayFlags,
      alerts: replayAlertsCount,
      demoted: replayDemoted,
    },
    replay_trades_would_commit: replayCommitted,
    alert_commit_decisions: alertCommitDecisions,
    per_tick: perTick,
    cost: {
      model: CLAUDE_MODELS.haiku,
      input_tokens: totalIn,
      output_tokens: totalOut,
      usd: Number(costUsd.toFixed(4)),
    },
    caveats: [
      'Claude decisions are non-deterministic even at temp 0.2 — treat as distribution, not deterministic recreation.',
      'Memory bundle is stripped (theses + snapshot only). Full memoryRecall.ts similar-setups + lessons not re-run.',
      'Alert-book-commit sim uses entry_level as price proxy — no getCurrentPrice() fetch.',
      'Bias blocks (ct_biases) not replayed in v1.',
    ],
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
