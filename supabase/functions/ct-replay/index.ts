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
 * Persistence (v2 — 2026-04-19):
 *   - Every run INSERTs a ct_replay_runs row at start with status='running'.
 *   - Every 3 ticks processed, UPDATE the row with accumulated counts +
 *     per_tick so partial data survives even if the edge function hits the
 *     150s timeout. The UI polls this row instead of waiting for the HTTP
 *     response.
 *   - On completion: UPDATE status='completed' + final counts + duration.
 *   - On error: UPDATE status='error' + error_message.
 *   - Returns run_id in the HTTP response immediately after insert; the UI
 *     polls ct_replay_runs by id.
 *
 * Chunked mode (v2):
 *   - Body params: { chunk_index: 0, total_chunks: 3, max_ticks: 12,
 *     parent_run_id?: uuid }
 *   - chunk_index=0 processes ticks 0..max_ticks-1 of the session.
 *   - chunk_index=1 processes ticks max_ticks..2*max_ticks-1, etc.
 *   - Chunk 0 is the root; its run_id becomes parent_run_id for chunks 1+.
 *   - UI fires chunks sequentially and merges client-side — we do NOT fire
 *     chunks in parallel (Claude cost + Supabase IO budget).
 *
 * Body:
 *   {
 *     "session_date": "2026-04-17",
 *     "dry_run": true,
 *     "modules": ["watcher_writes", "cooldown", "alert_book_commit"],
 *     "max_ticks": 12,
 *     "chunk_index": 0,          // optional, default 0
 *     "total_chunks": 1,         // optional, default 1
 *     "parent_run_id": null      // optional, set by UI for chunk 1+
 *   }
 *
 * Returns: { run_id, session_date, chunk_index, total_chunks, status,
 *            actual_counts, replay_counts, per_tick, trade_decisions, cost }
 *
 * Auth: JWT (user) OR service role. No external writes in v1.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { extractUserIdWithServiceRole, isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, calculateCost, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { CT_SYSTEM_PROMPT_V1 } from '../_shared/systemPromptV1.ts';

// Replay caps. Default is conservative so we don't hit the 150s edge
// function timeout — 40 Haiku calls × ~4s can overshoot. Body can set
// `max_ticks` up to 40 for a full session when invoked from a context
// that can wait (Replay page posts via fetch + long-poll).
const DEFAULT_MAX_TICKS = 12;
const MAX_TICKS_CEILING = 40;
const HAIKU_MAX_TOKENS = 2000;
const DEFAULT_MODULES = ['watcher_writes', 'cooldown', 'alert_book_commit'] as const;

// Checkpoint every N ticks — tuned so even a hard timeout after ~140s leaves
// the UI with near-complete data. 3 = one UPDATE per ~12s of Claude wallclock.
const CHECKPOINT_EVERY_N_TICKS = 3;

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

    if (a.trigger === 'thesis_invalidation') {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'invalidation_does_not_open', entry_level: setup.entry_level ?? null,
      });
      continue;
    }

    if (a.direction !== 'bullish' && a.direction !== 'bearish') {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'non_directional', entry_level: setup.entry_level ?? null,
      });
      continue;
    }

    if (!ALERT_WHITELIST.has(instrument)) {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'instrument_not_whitelisted', entry_level: setup.entry_level ?? null,
      });
      continue;
    }

    const lastCommitMs = committedAt.length > 0 ? committedAt[committedAt.length - 1] : -Infinity;
    if (a.tick_time_ms - lastCommitMs < ALERT_COMMIT_COOLDOWN_MS) {
      decisions.push({
        alert_ref: a.alert_ref, tick_time: a.tick_time_iso, instrument, direction: a.direction,
        passed_guards: false, reason: 'commit_cooldown_60min', entry_level: setup.entry_level ?? null,
      });
      continue;
    }

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
    body = {};
  }

  // Replay is read-only / dry-run — service role alone is sufficient.
  let auth: { userId: string | null; error: string | null; supabase: SupabaseClient | null };
  const isSvcRole = isServiceRoleRequest(req);
  if (isSvcRole) {
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
  const dryRun = body.dry_run !== false;
  const modules = Array.isArray(body.modules) && body.modules.length > 0
    ? (body.modules as string[])
    : [...DEFAULT_MODULES];
  const requestedMax = typeof body.max_ticks === 'number' ? Math.floor(body.max_ticks) : DEFAULT_MAX_TICKS;
  const maxTicks = Math.max(1, Math.min(MAX_TICKS_CEILING, requestedMax));

  // Chunked mode params (all optional, default = single unchunked run)
  const chunkIndex = typeof body.chunk_index === 'number' ? Math.max(0, Math.floor(body.chunk_index)) : 0;
  const totalChunks = typeof body.total_chunks === 'number' ? Math.max(1, Math.floor(body.total_chunks)) : 1;
  const parentRunId = typeof body.parent_run_id === 'string' && body.parent_run_id.length > 0
    ? body.parent_run_id
    : null;

  if (chunkIndex >= totalChunks) {
    return new Response(JSON.stringify({ error: `chunk_index (${chunkIndex}) must be < total_chunks (${totalChunks})` }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

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

  // Service-role client for reads + replay_runs writes (bypasses RLS)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // --------------------------------------------------------------------------
  // Sequential chunk guard: if a prior chunk for this parent lineage is still
  // 'running', reject. UI should poll until prior chunk completes before
  // firing the next one. This guard is a safety net — the UI enforces it too.
  // --------------------------------------------------------------------------
  if (chunkIndex > 0 && parentRunId) {
    const { data: parent } = await supabase
      .from('ct_replay_runs')
      .select('id, status, chunk_index')
      .eq('id', parentRunId)
      .maybeSingle();
    if (!parent) {
      return new Response(JSON.stringify({ error: `parent_run_id ${parentRunId} not found` }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Any earlier chunk in the lineage that's still running blocks this one.
    const { data: earlierRunning } = await supabase
      .from('ct_replay_runs')
      .select('id, chunk_index, status')
      .or(`id.eq.${parentRunId},parent_run_id.eq.${parentRunId}`)
      .lt('chunk_index', chunkIndex)
      .eq('status', 'running');
    if (earlierRunning && earlierRunning.length > 0) {
      return new Response(JSON.stringify({
        error: `cannot start chunk ${chunkIndex}: earlier chunk still running`,
        running_chunks: earlierRunning.map(r => r.chunk_index),
      }), {
        status: 409,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // --------------------------------------------------------------------------
  // INSERT run row (status='running') — we need the id before the loop starts
  // so we can return it immediately to the UI for polling.
  // --------------------------------------------------------------------------
  const triggeredBy = isSvcRole
    ? (body.triggered_by === 'cron' ? 'cron' : 'service-role')
    : 'ui';

  const { data: runInsert, error: runInsertErr } = await supabase
    .from('ct_replay_runs')
    .insert({
      session_date: sessionDate,
      max_ticks: maxTicks,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
      parent_run_id: parentRunId,
      status: 'running',
      dry_run: dryRun,
      modules,
      user_id: auth.userId,
      triggered_by: triggeredBy,
    })
    .select('id')
    .single();

  if (runInsertErr || !runInsert) {
    return new Response(JSON.stringify({ error: `failed to create run row: ${runInsertErr?.message ?? 'unknown'}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const runId = runInsert.id as string;

  // All subsequent failure paths must finalize the run row so it doesn't sit
  // stuck at 'running' forever. finalize() handles status='error' with message.
  async function finalize(fields: Record<string, unknown>) {
    try {
      await supabase.from('ct_replay_runs').update(fields).eq('id', runId);
    } catch (e) {
      console.warn(`[ct-replay] finalize update failed for run ${runId}:`, e);
    }
  }

  try {
    const sessionStartIso = `${sessionDate}T00:00:00.000Z`;
    const sessionEndIso = `${sessionDate}T23:59:59.999Z`;

    // Chunked offset — chunk N processes ticks [N*maxTicks .. (N+1)*maxTicks-1]
    // of the session's ordered heartbeat list.
    const chunkOffset = chunkIndex * maxTicks;

    // 1. Pull heartbeats with current_reads for the day, excluding uw-probe rows
    //    Use range() to get exactly the chunk's slice.
    const fromIdx = chunkOffset;
    const toIdx = chunkOffset + maxTicks - 1;

    const { data: hbRows, error: hbErr } = await supabase
      .from('ct_heartbeats')
      .select('id, created_at, status_line, watching, current_reads, prompt_version')
      .gte('created_at', sessionStartIso)
      .lte('created_at', sessionEndIso)
      .not('current_reads', 'is', null)
      .neq('prompt_version', 'uw-probe')
      .order('created_at', { ascending: true })
      .range(fromIdx, toIdx);

    if (hbErr) {
      await finalize({ status: 'error', error_message: `heartbeat query failed: ${hbErr.message}`, completed_at: new Date().toISOString() });
      return new Response(JSON.stringify({ run_id: runId, error: `heartbeat query failed: ${hbErr.message}` }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const heartbeats = hbRows ?? [];
    if (heartbeats.length === 0) {
      const emptyCounts = {
        actual_counts: { observations: 0, flags: 0, alerts: 0, trades_committed: 0 },
        replay_counts: { observations: 0, flags: 0, alerts: 0, demoted: 0, trades_would_commit: 0 },
        per_tick: [],
        trade_decisions: [],
        ticks_completed: 0,
        cost_usd: 0,
        duration_ms: 0,
        status: 'completed',
        completed_at: new Date().toISOString(),
      };
      await finalize(emptyCounts);
      return new Response(JSON.stringify({
        run_id: runId,
        session_date: sessionDate,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        status: 'completed',
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

    const actualCountsJson = {
      observations: actualObs.length,
      flags: actualFlags.length,
      alerts: actualAlerts.length,
      trades_committed: actualCommittedTrades,
    };

    // 3. Replay loop — with periodic checkpoints
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
    let claudeCallsOk = 0;
    const claudeLoopStart = Date.now();

    /**
     * Fast checkpoint: one UPDATE with the accumulated snapshot. We stuff the
     * running decisions into the same row — no per-tick inserts. Fire-and-
     * forget (don't await) to avoid adding to the tick's wall time.
     */
    function checkpoint(finalPass: boolean) {
      const runningCostUsd = calculateCost(CLAUDE_MODELS.haiku, { input_tokens: totalIn, output_tokens: totalOut });
      const runningDecisions = modules.includes('alert_book_commit')
        ? simulateAlertBookCommit(replayAlertsForCommit)
        : [];
      const update = {
        ticks_completed: perTick.length,
        actual_counts: actualCountsJson,
        replay_counts: {
          observations: replayObs,
          flags: replayFlags,
          alerts: replayAlertsCount,
          demoted: replayDemoted,
          trades_would_commit: runningDecisions.filter(d => d.passed_guards).length,
        },
        per_tick: perTick,
        trade_decisions: runningDecisions,
        cost_usd: Number(runningCostUsd.toFixed(6)),
        duration_ms: Date.now() - claudeLoopStart,
      };
      const p = supabase.from('ct_replay_runs').update(update).eq('id', runId);
      if (finalPass) return p; // return promise for awaiting at end
      Promise.resolve(p).catch(err => console.warn(`[ct-replay] checkpoint failed run=${runId}:`, err));
      return null;
    }

    for (let i = 0; i < heartbeats.length; i++) {
      const hb = heartbeats[i];
      const tickIso = hb.created_at as string;
      const tickMs = Date.parse(tickIso);
      const snapshot = (hb.current_reads as { _snapshot?: Record<string, unknown> } | null)?._snapshot ?? {};

      const strippedMemory = await buildStrippedMemory(supabase, tickIso, snapshot);

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
        if (claudeOk) claudeCallsOk++;
      } catch (e) {
        console.warn(`[ct-replay] claude call failed at tick ${tickIso}:`, e instanceof ClaudeError ? `${e.status} ${e.message}` : String(e));
      }

      const candidate: ClaudeJson = parsed ?? { state: 'HEARTBEAT' };
      const postCooldown = applyCooldown(candidate, tickMs, priorReplayAlerts);

      if (postCooldown.state === 'OBSERVATION') replayObs++;
      else if (postCooldown.state === 'FLAG') replayFlags++;
      else if (postCooldown.state === 'ALERT') replayAlertsCount++;
      if (postCooldown.demotedTo) replayDemoted++;

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

      // Checkpoint every N ticks so partial data survives timeout.
      if ((i + 1) % CHECKPOINT_EVERY_N_TICKS === 0) {
        checkpoint(false);
      }
    }

    // 4. Alert-book-commit simulation (final pass — authoritative)
    const alertCommitDecisions = modules.includes('alert_book_commit')
      ? simulateAlertBookCommit(replayAlertsForCommit)
      : [];
    const replayCommitted = alertCommitDecisions.filter(d => d.passed_guards).length;

    // 5. Cost estimate
    const costUsd = calculateCost(CLAUDE_MODELS.haiku, { input_tokens: totalIn, output_tokens: totalOut });
    const durationMs = Date.now() - claudeLoopStart;

    // 6. Final UPDATE — status=completed, all counts + per_tick locked in.
    //    We AWAIT this one so the HTTP response reflects the persisted state.
    await supabase.from('ct_replay_runs').update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      ticks_completed: perTick.length,
      actual_counts: actualCountsJson,
      replay_counts: {
        observations: replayObs,
        flags: replayFlags,
        alerts: replayAlertsCount,
        demoted: replayDemoted,
        trades_would_commit: replayCommitted,
      },
      per_tick: perTick,
      trade_decisions: alertCommitDecisions,
      cost_usd: Number(costUsd.toFixed(6)),
      duration_ms: durationMs,
    }).eq('id', runId);

    // 7. Claude usage log — unified per-run insert, now with run_id so /health
    //    can attribute costs to individual replay runs (or chunks).
    logClaudeUsage(supabase, {
      source: 'ct-replay',
      model: CLAUDE_MODELS.haiku,
      usage: { input_tokens: totalIn, output_tokens: totalOut },
      duration_ms: durationMs,
      mcp_calls: 0,
      cost_usd_override: costUsd,
      metadata: {
        user_id: auth.userId,
        session_date: sessionDate,
        ticks_replayed: heartbeats.length,
        claude_calls_ok: claudeCallsOk,
        dry_run: dryRun,
        run_id: runId,
        chunk_index: chunkIndex,
        total_chunks: totalChunks,
        parent_run_id: parentRunId,
      },
    });

    return new Response(JSON.stringify({
      run_id: runId,
      session_date: sessionDate,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
      parent_run_id: parentRunId,
      status: 'completed',
      dry_run: dryRun,
      modules,
      ticks_replayed: heartbeats.length,
      max_ticks: maxTicks,
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[ct-replay] fatal error in run ${runId}:`, msg);
    await finalize({
      status: 'error',
      error_message: msg.slice(0, 2000),
      completed_at: new Date().toISOString(),
    });
    return new Response(JSON.stringify({ run_id: runId, error: msg, status: 'error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
