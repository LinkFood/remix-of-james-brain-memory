/**
 * ct-watcher — Co-trader watcher cron (Day 2 full)
 *
 * Cycle:
 *   1. Pull live UW state for 13-ticker watchlist + SPX macro + market tide
 *   2. Condense state into per-instrument aggregates for Claude
 *   3. Build per-instrument memory bundle (thesis + recent + similar + lessons)
 *   4. Call Claude Haiku with system prompt v1 + JSON-output instruction
 *   5. Parse response → one of HEARTBEAT / OBSERVATION / FLAG / ALERT
 *   6. Write to the appropriate ct_* table
 *   7. Embed OBSERVATION/FLAG/ALERT into ct_embeddings via Voyage
 *   8. Apply any thesis updates (+ audit trail in ct_thesis_history)
 *   9. Slack push for FLAG conv ≥3 or ALERT
 *
 * Never silent-fails. Always writes at least a heartbeat row so we
 * have proof of cycle. Claude 4xx is permanent — don't retry.
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isKillSwitchActive, killSwitchSkipResponse } from '../_shared/killSwitch.ts';
import { pullWatcherState, WATCHLIST } from '../_shared/uwClient.ts';
import { now as clockNow } from '../_shared/clock.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { CT_SYSTEM_PROMPT_V1, CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { buildMemoryBundle, getRecentSelfCorrections, getActiveBiases } from '../_shared/memoryRecall.ts';
import { embedCtItem, buildCtRichText } from '../_shared/ctEmbed.ts';
import { condenseWatcherState, type CondensedState } from '../_shared/ctStateCondense.ts';
import { getNewsSentimentNet } from '../_shared/ctNewsSentiment.ts';
import { ctSlackPush } from '../_shared/ctSlack.ts';
import { deriveWriteTimeAttention } from '../_shared/attentionScore.ts';
import { logMcpCalls } from '../_shared/mcpLog.ts';
import { getConfig } from '../_shared/configCache.ts';

// Watcher MCP budget — ONE drill-down call per tick. The scheduled snapshot
// covers the 12-ticker watchlist; MCP is only for chasing specific outliers
// (a sweep citing a strike outside the near-ATM window, a news headline
// naming a non-watchlist ticker). See systemPromptV1.ts "UW MCP access (restricted)".
const WATCHER_MCP_BUDGET = 1;

// Count mcp_tool_use blocks in a Claude response — same pattern as ct-curiosity.
function countMcpCalls(res: unknown): number {
  const blocks = (res as { content?: unknown[] }).content ?? [];
  if (!Array.isArray(blocks)) return 0;
  return blocks.filter((b) => (b as { type?: string }).type === 'mcp_tool_use').length;
}

type CtState = 'HEARTBEAT' | 'OBSERVATION' | 'FLAG' | 'ALERT';
type Direction = 'bullish' | 'bearish' | 'neutral' | 'volatility';

interface ClaudeJson {
  state: CtState;
  // heartbeat
  status_line?: string;
  watching?: string[] | string;
  current_reads?: Record<string, string>;
  // event (observation/flag/alert)
  instruments?: string[];
  observation?: string;
  prior_read?: string;
  update_note?: string;
  up_case?: string;
  up_case_odds?: number;
  down_case?: string;
  down_case_odds?: number;
  direction?: Direction;
  memory_recall?: string;
  glance?: string[];
  conviction?: number;
  horizon?: '1h' | '4h' | 'EOD' | 'next-day' | 'weekly';
  alert_trigger?: 'regime_shift' | 'thesis_invalidation' | 'news' | 'vol_event' | 'other';
  // Evidence axes — v1.1 diversity gate. Expected on FLAG and ALERT.
  // Array of axis letters from {A,B,C,D,E,F}. ALERT requires length >=3.
  evidence_axes?: string[];
  // Expected magnitude band — v1.3. Required on FLAG and ALERT.
  // Permissive validation: malformed payloads log a WARN but do NOT block
  // the write (we don't drop a legit alert because Claude fumbled a number).
  expected_move?: {
    low_pct?: number;
    high_pct?: number;
    confidence_pct?: number;
    horizon_hrs?: number;
  };
  // inline self-assessment (required by prompt on obs/flag/alert; trust-pass to DB)
  self_assessment?: {
    confidence?: number;
    reasoning_quality?: number;
    key_evidence?: string;
    kill_conditions?: string;
    what_could_go_wrong?: string;
  };
  // concrete trade setup (required on FLAG conv≥3 and ALERT; trust-pass to DB)
  trade_setup?: Record<string, unknown>;
  // optional thesis updates
  thesis_updates?: Array<{
    instrument: string;
    new_direction: Direction;
    new_conviction: number;
    new_up_case?: string;
    new_down_case?: string;
    new_watching?: string;
    reason: string;
  }>;
}

// ============================================================================
// Helpers
// ============================================================================

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

// Normalize evidence axes → uppercase single-letter array of {A..F}, dedup.
// Non-matching entries are dropped. Returns [] if input is missing/garbled.
function normalizeEvidenceAxes(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(['A', 'B', 'C', 'D', 'E', 'F']);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const up = v.trim().toUpperCase().slice(0, 1);
    if (allowed.has(up) && !seen.has(up)) {
      seen.add(up);
      out.push(up);
    }
  }
  return out;
}

/**
 * Validate and normalize Claude's `expected_move` payload.
 *
 * PERMISSIVE by policy: we never block a write when this is malformed — we
 * log a WARN and return null, and the caller inserts the row with
 * expected_move = null. Rationale: a legitimate ALERT should not die
 * because Claude forgot or botched one field. Magnitude claims are
 * opt-in edge data; missing rows just don't contribute to band-accuracy.
 *
 * Required shape: { low_pct: number, high_pct: number,
 *                   confidence_pct: number in [50,90], horizon_hrs: number }
 *
 * Returns the normalized object (numbers coerced, confidence_pct clamped
 * into the allowed window is NOT done — we reject out-of-range instead,
 * since "80% when you meant 8%" is a data-quality issue worth surfacing).
 */
function validateExpectedMove(
  raw: unknown,
  ctx: string,
): { low_pct: number; high_pct: number; confidence_pct: number; horizon_hrs: number } | null {
  if (raw == null) {
    console.warn(`[ct-watcher] expected_move missing on ${ctx} — writing null`);
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[ct-watcher] expected_move on ${ctx} is not an object (got ${typeof raw}) — writing null`);
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const low = Number(obj.low_pct);
  const high = Number(obj.high_pct);
  const conf = Number(obj.confidence_pct);
  const horiz = Number(obj.horizon_hrs);

  if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(conf) || !Number.isFinite(horiz)) {
    console.warn(`[ct-watcher] expected_move on ${ctx} has non-numeric fields: ${JSON.stringify(obj)} — writing null`);
    return null;
  }
  if (low > high) {
    console.warn(`[ct-watcher] expected_move on ${ctx} has low_pct > high_pct (${low} > ${high}) — writing null`);
    return null;
  }
  // Confidence rule: reject <50 (model shouldn't claim sub-coinflip on its
  // own call — that's noise), accept up to 90 (>90 smells overconfident).
  if (conf < 50 || conf > 90) {
    console.warn(`[ct-watcher] expected_move on ${ctx} confidence_pct=${conf} outside [50,90] — writing null`);
    return null;
  }
  if (horiz <= 0 || horiz > 720) { // >30d smells wrong for intraday watcher
    console.warn(`[ct-watcher] expected_move on ${ctx} horizon_hrs=${horiz} out of sane range — writing null`);
    return null;
  }
  return { low_pct: low, high_pct: high, confidence_pct: conf, horizon_hrs: horiz };
}

function parseClaudeJson(raw: string): ClaudeJson | null {
  // Strip markdown code fences if present
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    const obj = JSON.parse(cleaned);
    if (!obj || typeof obj !== 'object' || typeof obj.state !== 'string') return null;
    return obj as ClaudeJson;
  } catch {
    // Sometimes Claude wraps JSON in prose — try to extract
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

// Roll a UTC timestamp forward to the next regular-session open if it lands
// in after-hours or a weekend. Regular session ≈ 13:30-20:00 UTC weekdays
// (9:30a-4p ET during EDT; 14:30-21:00 UTC during EST is close enough for
// grading purposes — a ~1h slop is fine since horizon_end gates when the
// grader *starts* looking, not the exact exit print). Crucially this
// prevents entry==exit grades where a horizon lands in a no-trade window.
function rollToMarketHours(utcIso: string): string {
  const d = new Date(utcIso);
  // Weekend — push to Monday 13:30 UTC
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) {
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(13, 30, 0, 0);
  }
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const mins = h * 60 + m;
  if (mins < 13 * 60 + 30) {
    // Pre-open → bump to today's 13:30 UTC
    d.setUTCHours(13, 30, 0, 0);
  } else if (mins >= 20 * 60) {
    // Post-close → bump to tomorrow's 13:30 UTC (recurse for weekends)
    d.setUTCDate(d.getUTCDate() + 1);
    d.setUTCHours(13, 30, 0, 0);
    return rollToMarketHours(d.toISOString());
  }
  return d.toISOString();
}

function horizonEnd(horizon: string, fromIso: string): string {
  const from = new Date(fromIso);
  switch (horizon) {
    case '1h':        from.setHours(from.getHours() + 1); break;
    case '4h':        from.setHours(from.getHours() + 4); break;
    case 'EOD':
      from.setUTCHours(20, 0, 0, 0);
      if (from.getTime() <= Date.parse(fromIso)) from.setUTCDate(from.getUTCDate() + 1);
      break;
    case 'next-day':  from.setUTCDate(from.getUTCDate() + 1); break;
    case 'weekly':    from.setUTCDate(from.getUTCDate() + 7); break;
    default:          from.setHours(from.getHours() + 4);
  }
  // EOD / next-day / weekly already target session opens or known bars.
  // 1h / 4h and default need rolling in case they land in after-hours.
  if (horizon === '1h' || horizon === '4h' || !['EOD', 'next-day', 'weekly'].includes(horizon)) {
    return rollToMarketHours(from.toISOString());
  }
  return from.toISOString();
}

function condensedPriceMap(condensed: CondensedState, instruments: string[]): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const t of instruments) out[t] = condensed.per_ticker[t]?.price ?? null;
  return out;
}

function condensedWatching(condensed: CondensedState): string[] {
  return Object.keys(condensed.per_ticker);
}

// ============================================================================
// State writers
// ============================================================================

// Event-trigger metadata threaded from the request body down into every write.
// When present, every row the watcher produces during this tick carries a
// pointer back to ct_watcher_event_triggers, and the heartbeat status_line is
// tagged `[event: source/priority]` for quick filtering on /session.
interface TriggerInfo {
  source: string;
  reason: string;
  priority: string;
  trigger_id?: string | null;
  /**
   * Populated only when source='earnings_approach' — surfaced to the model via
   * a system-prompt addendum so Haiku tilts sizing/stops/horizon accordingly.
   */
  earnings?: {
    ticker: string;
    report_date: string;
    report_time: string | null;
    threshold_hours: number;
    hours_remaining: number;
  } | null;
}

function triggerTag(info: TriggerInfo | null): string {
  if (!info) return '';
  return ` [event: ${info.source}/${info.priority}]`;
}

async function writeHeartbeat(
  supabase: SupabaseClient,
  condensed: CondensedState,
  claude: ClaudeJson,
  fallbackReason: string | null,
  triggerInfo: TriggerInfo | null = null,
): Promise<string | null> {
  const baseLine = asString(claude?.status_line) || fallbackReason || 'watcher cycle — claude output unparsable, wrote fallback heartbeat';
  const statusLine = `${baseLine}${triggerTag(triggerInfo)}`;
  const watching = toArray(claude?.watching as string | string[]).filter(s => typeof s === 'string') as string[];
  const current_reads = claude?.current_reads && typeof claude.current_reads === 'object' ? claude.current_reads : {};
  const triggerMeta = triggerInfo ? { _event_trigger: triggerInfo } : {};

  const { data, error } = await supabase.from('ct_heartbeats').insert({
    status_line: statusLine,
    watching: watching.length > 0 ? watching : condensedWatching(condensed),
    current_reads: { ...current_reads, ...triggerMeta, _snapshot: condensed },
    prompt_version: CT_PROMPT_VERSION,
    attention_score: deriveWriteTimeAttention({ state: 'HEARTBEAT' }),
  }).select('id').maybeSingle();

  if (error) {
    console.error('[ct-watcher] heartbeat insert failed:', error.message);
    return null;
  }
  return data?.id ?? null;
}

async function writeObservation(
  supabase: SupabaseClient,
  userId: string | null,
  condensed: CondensedState,
  claude: ClaudeJson,
  memoryRecallOverride?: string,
  convergenceCount?: number,
  triggerInfo: TriggerInfo | null = null,
): Promise<string | null> {
  const instruments = toArray(claude.instruments).filter(Boolean) as string[];
  if (instruments.length === 0) {
    console.warn('[ct-watcher] OBSERVATION missing instruments');
    return null;
  }

  const memoryRecallSummary = memoryRecallOverride ?? asString(claude.memory_recall);
  const glanceArr = toArray(claude.glance).filter(s => typeof s === 'string') as string[];
  const isInvalidation = glanceArr[0]?.toUpperCase().startsWith('THESIS INVALIDAT') ?? false;

  const { data, error } = await supabase.from('ct_observations').insert({
    user_id: userId,
    instruments,
    observation: asString(claude.observation) || '(empty)',
    glance: glanceArr,
    up_case: asString(claude.up_case),
    up_case_odds: claude.up_case_odds ?? null,
    down_case: asString(claude.down_case),
    down_case_odds: claude.down_case_odds ?? null,
    direction: claude.direction ?? null,
    prior_read: asString(claude.prior_read),
    update_note: asString(claude.update_note),
    watching: asString(claude.memory_recall || claude.watching as string),
    memory_recall_used: { summary: memoryRecallSummary },
    self_assessment: claude.self_assessment ?? null,
    triggered_by: triggerInfo ?? null,
    prompt_version: CT_PROMPT_VERSION,
    attention_score: deriveWriteTimeAttention({
      state: 'OBSERVATION',
      convergenceCount,
      isInvalidation,
    }),
  }).select('id').maybeSingle();

  if (error) {
    console.error('[ct-watcher] observation insert failed:', error.message);
    return null;
  }
  const id = data?.id ?? null;

  // Embed for corpus
  if (id) {
    const richText = buildCtRichText({
      state: 'OBSERVATION',
      instruments,
      direction: claude.direction,
      full_reasoning: asString(claude.observation),
      glance: toArray(claude.glance).filter(s => typeof s === 'string'),
    });
    await embedCtItem(supabase, {
      item_type: 'observation',
      item_id: id,
      text: richText,
      metadata: {
        instrument: instruments[0],
        instruments,
        direction: claude.direction,
        created_at: new Date().toISOString(),
      },
    });
  }
  return id;
}

async function writeFlag(
  supabase: SupabaseClient,
  userId: string | null,
  condensed: CondensedState,
  claude: ClaudeJson,
  opts?: { convictionOverride?: number; memoryRecallOverride?: string; convergenceCount?: number; triggerInfo?: TriggerInfo | null },
): Promise<string | null> {
  const instruments = toArray(claude.instruments).filter(Boolean) as string[];
  if (instruments.length === 0) {
    console.warn('[ct-watcher] FLAG missing instruments');
    return null;
  }
  const baseConviction = Math.max(1, Math.min(4, Number(claude.conviction) || 2));
  const conviction = opts?.convictionOverride != null
    ? Math.max(1, Math.min(4, opts.convictionOverride))
    : baseConviction;
  const horizon = claude.horizon ?? '4h';
  const nowIso = new Date().toISOString();
  const memoryRecallSummary = opts?.memoryRecallOverride ?? asString(claude.memory_recall);

  const { data, error } = await supabase.from('ct_flags').insert({
    user_id: userId,
    instruments,
    direction: claude.direction ?? 'neutral',
    conviction,
    horizon,
    horizon_end: horizonEnd(horizon, nowIso),
    entry_prices: condensedPriceMap(condensed, instruments),
    up_case: asString(claude.up_case) || '(empty)',
    up_case_odds: claude.up_case_odds ?? 50,
    down_case: asString(claude.down_case) || '(empty)',
    down_case_odds: claude.down_case_odds ?? 50,
    watching: asString(claude.watching as string),
    full_reasoning: asString(claude.observation),
    glance: toArray(claude.glance).filter(s => typeof s === 'string'),
    memory_recall_used: { summary: memoryRecallSummary },
    self_assessment: claude.self_assessment ?? null,
    trade_setup: claude.trade_setup ?? null,
    evidence_axes: normalizeEvidenceAxes(claude.evidence_axes),
    expected_move: validateExpectedMove(claude.expected_move, `flag ${instruments.join(',')} ${claude.direction ?? ''}`),
    triggered_by: opts?.triggerInfo ?? null,
    prompt_version: CT_PROMPT_VERSION,
    attention_score: deriveWriteTimeAttention({
      state: 'FLAG',
      conviction,
      convergenceCount: opts?.convergenceCount,
      hasTradeSetup: !!claude.trade_setup,
    }),
  }).select('id').maybeSingle();

  if (error) {
    console.error('[ct-watcher] flag insert failed:', error.message);
    return null;
  }
  const id = data?.id ?? null;

  if (id) {
    const richText = buildCtRichText({
      state: 'FLAG',
      instruments,
      direction: claude.direction,
      conviction,
      horizon,
      full_reasoning: asString(claude.observation),
      glance: toArray(claude.glance).filter(s => typeof s === 'string'),
    });
    await embedCtItem(supabase, {
      item_type: 'flag',
      item_id: id,
      text: richText,
      metadata: {
        instrument: instruments[0],
        instruments,
        direction: claude.direction,
        conviction,
        horizon,
        created_at: nowIso,
      },
    });
  }
  return id;
}

interface WriteAlertResult {
  alertId: string | null;
  demotedTo: 'observation' | 'flag' | null;
  demotedEventId: string | null;
}

async function writeAlert(
  supabase: SupabaseClient,
  userId: string | null,
  condensed: CondensedState,
  claude: ClaudeJson,
  convergenceCount?: number,
  cooldowns?: { sameDirectionMin: number; invalidationMin: number },
  triggerInfo: TriggerInfo | null = null,
): Promise<WriteAlertResult> {
  const instruments = toArray(claude.instruments).filter(Boolean) as string[];
  if (instruments.length === 0) {
    console.warn('[ct-watcher] ALERT missing instruments');
    return { alertId: null, demotedTo: null, demotedEventId: null };
  }
  const horizon = claude.horizon ?? '4h';
  const nowIso = new Date().toISOString();
  const trigger = claude.alert_trigger ?? 'other';
  const direction = claude.direction ?? 'neutral';
  const sameDirectionMin = cooldowns?.sameDirectionMin ?? 30;
  const invalidationMin = cooldowns?.invalidationMin ?? 60;

  // ========================================================================
  // COOLDOWN CHECKS — run BOTH before insert. First match wins and demotes.
  // ========================================================================

  // Check 1: Thesis-invalidation suppression (invalidation_min, default 60m).
  // Higher priority — check this first because invalidations at conv=5 are
  // the loudest symptom.
  if (trigger === 'thesis_invalidation') {
    const invalidationCutoff = new Date(Date.now() - invalidationMin * 60 * 1000).toISOString();
    const { data: recentInvalidations, error: invErr } = await supabase
      .from('ct_alerts')
      .select('id, created_at, instruments')
      .gte('created_at', invalidationCutoff)
      .eq('alert_trigger', 'thesis_invalidation')
      .overlaps('instruments', instruments)
      .order('created_at', { ascending: false })
      .limit(1);

    if (invErr) {
      console.warn('[ct-watcher] invalidation cooldown query failed:', invErr.message);
    } else if (recentInvalidations && recentInvalidations.length > 0) {
      const recentId = recentInvalidations[0].id as string;
      console.log(`[ct-watcher] INVALIDATION COOLDOWN triggered — prior invalidation ${recentId.slice(0, 8)} within ${invalidationMin}min, downgrading ALERT→FLAG conv=3`);
      const origGlance = toArray(claude.glance).filter(s => typeof s === 'string') as string[];
      const prefixedClaude: ClaudeJson = {
        ...claude,
        glance: ['[INVALIDATION COOLDOWN — downgraded from ALERT]', ...origGlance],
      };
      const cooldownNote = `[cooldown: thesis_invalidation suppressed within ${invalidationMin}min — see alert ${recentId}] ${asString(claude.memory_recall)}`.trim();
      const flagId = await writeFlag(supabase, userId, condensed, prefixedClaude, {
        convictionOverride: 3,
        memoryRecallOverride: cooldownNote,
        convergenceCount,
        triggerInfo,
      });
      return { alertId: null, demotedTo: 'flag', demotedEventId: flagId };
    }
  }

  // Check 2: Same-direction cooldown (same_direction_min, default 30m).
  // Only applies to bullish/bearish.
  if (direction === 'bullish' || direction === 'bearish') {
    const sameDirCutoff = new Date(Date.now() - sameDirectionMin * 60 * 1000).toISOString();
    const { data: recentSameDir, error: sdErr } = await supabase
      .from('ct_alerts')
      .select('id, created_at, instruments, direction')
      .gte('created_at', sameDirCutoff)
      .eq('direction', direction)
      .overlaps('instruments', instruments)
      .order('created_at', { ascending: false })
      .limit(1);

    if (sdErr) {
      console.warn('[ct-watcher] same-direction cooldown query failed:', sdErr.message);
    } else if (recentSameDir && recentSameDir.length > 0) {
      const recentId = recentSameDir[0].id as string;
      console.log(`[ct-watcher] SAME-DIRECTION COOLDOWN triggered — prior ${direction} alert ${recentId.slice(0, 8)} within ${sameDirectionMin}min, downgrading ALERT→OBSERVATION`);
      const origGlance = toArray(claude.glance).filter(s => typeof s === 'string') as string[];
      const prefixedClaude: ClaudeJson = {
        ...claude,
        glance: ['[COOLDOWN — suppressed conv=5 repeat]', ...origGlance],
      };
      const cooldownNote = `[cooldown: same-direction suppressed within ${sameDirectionMin}min — see alert ${recentId}] ${asString(claude.memory_recall)}`.trim();
      const obsId = await writeObservation(supabase, userId, condensed, prefixedClaude, cooldownNote, convergenceCount, triggerInfo);
      return { alertId: null, demotedTo: 'observation', demotedEventId: obsId };
    }
  }

  // ========================================================================
  // Evidence-diversity audit (v1.1). SOFT check — logs a warning when the
  // prompt's diversity rule appears violated, but does NOT block the insert.
  // Trust the prompt to self-police; hard-gate later once we see the data.
  // Rule: if prior ALERT on same instruments within 60min exists and >=2 of
  // its evidence_axes are present in the current ALERT's axes, that's a
  // repetition under the v1.1 rubric.
  // ========================================================================
  const currAxes = normalizeEvidenceAxes(claude.evidence_axes);
  try {
    const sixtyMinAgoDiv = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: priorAlerts, error: divErr } = await supabase
      .from('ct_alerts')
      .select('id, created_at, instruments, evidence_axes')
      .gte('created_at', sixtyMinAgoDiv)
      .overlaps('instruments', instruments)
      .order('created_at', { ascending: false })
      .limit(1);
    if (divErr) {
      console.warn('[ct-watcher] evidence-diversity query failed:', divErr.message);
    } else if (priorAlerts && priorAlerts.length > 0) {
      const prev = priorAlerts[0] as { id: string; evidence_axes?: string[] | null };
      const prevAxes = Array.isArray(prev.evidence_axes) ? prev.evidence_axes : [];
      const overlap = currAxes.filter(a => prevAxes.includes(a));
      if (prevAxes.length > 0 && overlap.length >= 2) {
        console.warn(
          `[ct-watcher] evidence-diversity check failed: prev=${JSON.stringify(prevAxes)} curr=${JSON.stringify(currAxes)} overlap=${JSON.stringify(overlap)} prior_alert=${prev.id.slice(0, 8)} instruments=${JSON.stringify(instruments)}`
        );
      }
      if (currAxes.length < 3) {
        console.warn(
          `[ct-watcher] evidence-diversity check: ALERT cited <3 axes (curr=${JSON.stringify(currAxes)}) — v1.1 prompt requires >=3`
        );
      }
    } else if (currAxes.length < 3) {
      console.warn(
        `[ct-watcher] evidence-diversity check: ALERT cited <3 axes (curr=${JSON.stringify(currAxes)}) — v1.1 prompt requires >=3`
      );
    }
  } catch (e) {
    console.warn('[ct-watcher] evidence-diversity audit threw:', e instanceof Error ? e.message : e);
  }

  // ========================================================================
  // No cooldown — proceed with normal ALERT insert.
  // ========================================================================

  const { data, error } = await supabase.from('ct_alerts').insert({
    user_id: userId,
    instruments,
    direction,
    conviction: 5,
    horizon,
    horizon_end: horizonEnd(horizon, nowIso),
    entry_prices: condensedPriceMap(condensed, instruments),
    up_case: asString(claude.up_case) || '(empty)',
    up_case_odds: claude.up_case_odds ?? 50,
    down_case: asString(claude.down_case) || '(empty)',
    down_case_odds: claude.down_case_odds ?? 50,
    watching: asString(claude.watching as string),
    full_reasoning: asString(claude.observation),
    glance: toArray(claude.glance).filter(s => typeof s === 'string'),
    memory_recall_used: { summary: asString(claude.memory_recall) },
    self_assessment: claude.self_assessment ?? null,
    trade_setup: claude.trade_setup ?? null,
    alert_trigger: trigger,
    evidence_axes: currAxes,
    expected_move: validateExpectedMove(claude.expected_move, `alert ${instruments.join(',')} ${direction} ${trigger}`),
    triggered_by: triggerInfo ?? null,
    prompt_version: CT_PROMPT_VERSION,
    attention_score: deriveWriteTimeAttention({
      state: 'ALERT',
      alertTrigger: trigger,
      convergenceCount,
      hasTradeSetup: !!claude.trade_setup,
    }),
  }).select('id').maybeSingle();

  if (error) {
    console.error('[ct-watcher] alert insert failed:', error.message);
    return { alertId: null, demotedTo: null, demotedEventId: null };
  }
  const id = data?.id ?? null;

  if (id) {
    const richText = buildCtRichText({
      state: 'ALERT',
      instruments,
      direction: claude.direction,
      conviction: 5,
      horizon,
      full_reasoning: asString(claude.observation),
      glance: toArray(claude.glance).filter(s => typeof s === 'string'),
    });
    await embedCtItem(supabase, {
      item_type: 'alert',
      item_id: id,
      text: richText,
      metadata: {
        instrument: instruments[0],
        instruments,
        direction: claude.direction,
        conviction: 5,
        horizon,
        trigger,
        created_at: nowIso,
      },
    });
  }
  return { alertId: id, demotedTo: null, demotedEventId: null };
}

async function applyThesisUpdates(
  supabase: SupabaseClient,
  userId: string | null,
  claude: ClaudeJson,
  triggeredById: string | null,
  triggeredByType: string | null
): Promise<number> {
  const updates = Array.isArray(claude.thesis_updates) ? claude.thesis_updates : [];
  let applied = 0;
  for (const u of updates) {
    if (!u?.instrument || !u?.new_direction || u?.new_conviction == null) continue;

    // Fetch current thesis for history audit
    const { data: prev } = await supabase
      .from('ct_theses')
      .select('direction, conviction')
      .eq('instrument', u.instrument)
      .maybeSingle();

    // Upsert current thesis
    const { error: upsertErr } = await supabase
      .from('ct_theses')
      .upsert({
        user_id: userId,
        instrument: u.instrument,
        direction: u.new_direction,
        conviction: u.new_conviction,
        up_case: u.new_up_case ?? '',
        down_case: u.new_down_case ?? '',
        watching: u.new_watching ?? null,
        rationale: u.reason,
        prompt_version: CT_PROMPT_VERSION,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,instrument' });

    if (upsertErr) {
      console.warn(`[ct-watcher] thesis upsert failed for ${u.instrument}:`, upsertErr.message);
      continue;
    }

    // History row
    await supabase.from('ct_thesis_history').insert({
      user_id: userId,
      instrument: u.instrument,
      previous_direction: prev?.direction ?? null,
      new_direction: u.new_direction,
      previous_conviction: prev?.conviction ?? null,
      new_conviction: u.new_conviction,
      reason: u.reason ?? '(no reason given)',
      triggered_by_type: triggeredByType,
      triggered_by_id: triggeredById,
      prompt_version: CT_PROMPT_VERSION,
    });

    applied++;
  }
  return applied;
}

// ============================================================================
// Main handler
// ============================================================================

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  // Parse event-trigger metadata (if present) — body params threaded from
  // _shared/watcherDispatch. A scheduled tick sends no body, so all fields
  // default to null and we behave exactly as before.
  let triggerInfo: TriggerInfo | null = null;
  try {
    const body = await req.json();
    if (body && typeof body === 'object' && typeof body.triggered_by === 'string') {
      const src = String(body.triggered_by);
      triggerInfo = {
        source: src,
        reason: typeof body.reason === 'string' ? body.reason : '',
        priority: typeof body.priority === 'string' ? body.priority : 'high',
        trigger_id: typeof body.trigger_id === 'string' ? body.trigger_id : null,
      };
      if (
        src === 'earnings_approach' &&
        typeof body.earnings_ticker === 'string' &&
        typeof body.earnings_report_date === 'string' &&
        typeof body.earnings_threshold_hours === 'number' &&
        typeof body.earnings_hours_remaining === 'number'
      ) {
        triggerInfo.earnings = {
          ticker: body.earnings_ticker,
          report_date: body.earnings_report_date,
          report_time: typeof body.earnings_report_time === 'string' ? body.earnings_report_time : null,
          threshold_hours: body.earnings_threshold_hours,
          hours_remaining: body.earnings_hours_remaining,
        };
      }
      console.log(`[ct-watcher] event-driven fire: source=${triggerInfo.source} priority=${triggerInfo.priority} reason=${triggerInfo.reason.slice(0, 200)}`);
    }
  } catch {
    /* empty body is fine */
  }

  // Kill switch — skip entire watcher tick if engaged. <15s stale-cache lag
  // tolerated; the next isolate to cold-start reads fresh.
  if (await isKillSwitchActive(supabase)) {
    return killSwitchSkipResponse(supabase, 'ct-watcher', corsHeaders);
  }

  const clock = clockNow();
  const startedAt = Date.now();

  try {
    // Pull tunable thresholds from ct_config (60s cache TTL, defaults preserve
    // legacy behavior if the row is missing or the RPC errors). Cooldowns feed
    // writeAlert's demotion logic.
    const [sameDirectionMin, invalidationMin] = await Promise.all([
      getConfig<number>('cooldown.same_direction_min', 30),
      getConfig<number>('cooldown.invalidation_min', 60),
    ]);
    console.log(`[ct-watcher] cooldowns: same_direction=${sameDirectionMin}min invalidation=${invalidationMin}min`);

    // 1. Single-user: fetch James's user_id
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    // 2. Pull live UW state
    const rawState = await pullWatcherState();

    // 2a. Look up prior-session VIX close for change_pct. Defensive: missing
    // table, no rows, or query error → prevClose = null and change_pct stays
    // null in the condensed snapshot. Never crashes the cycle.
    let vixPrevClose: number | null = null;
    try {
      const { data: priorVix } = await supabase
        .from('ct_vix_history')
        .select('level, date')
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (priorVix?.level != null && Number.isFinite(Number(priorVix.level))) {
        vixPrevClose = Number(priorVix.level);
      }
    } catch (e) {
      console.warn('[ct-watcher] ct_vix_history lookup threw:', e instanceof Error ? e.message : e);
    }

    const condensed = condenseWatcherState(rawState, clock.iso, vixPrevClose);

    // 2b. Write full-strike gamma landscape to ct_gex_timeseries for heatmap
    // history. Uses greek-exposure raw data (wider strike range than spot).
    try {
      const gexRows: Array<Record<string, unknown>> = [];
      const writeGex = (ticker: string, rawSpot: unknown, rawGreek: unknown) => {
        const price = (rawSpot && typeof rawSpot === 'object')
          ? (() => {
              const data = (rawSpot as { data?: unknown }).data;
              if (Array.isArray(data) && data.length > 0) {
                const p = (data[0] as Record<string, unknown>).price;
                return typeof p === 'number' ? p : parseFloat(String(p));
              }
              return null;
            })()
          : null;
        const greekData = (rawGreek && typeof rawGreek === 'object') ? (rawGreek as { data?: unknown }).data : null;
        if (!Array.isArray(greekData)) return;
        const low = price ? price * 0.9 : null;
        const high = price ? price * 1.1 : null;
        for (const r of greekData as Array<Record<string, unknown>>) {
          const strike = parseFloat(String(r.strike));
          const callGex = parseFloat(String(r.call_gex ?? 0));
          const putGex = parseFloat(String(r.put_gex ?? 0));
          if (!Number.isFinite(strike)) continue;
          const isAtm = low !== null && high !== null ? strike >= low && strike <= high : false;
          gexRows.push({
            ticker,
            snapshot_at: clock.iso,
            strike,
            call_gex: Number.isFinite(callGex) ? callGex : null,
            put_gex: Number.isFinite(putGex) ? putGex : null,
            net_gex: (Number.isFinite(callGex) ? callGex : 0) + (Number.isFinite(putGex) ? putGex : 0),
            underlying_price: price ?? null,
            is_atm_band: isAtm,
          });
        }
      };
      for (const t of WATCHLIST) writeGex(t, rawState.spot_gex[t], rawState.greek_exposure[t]);
      writeGex('SPX', rawState.spx_spot_gex, rawState.spx_greek_exposure);
      if (gexRows.length > 0) {
        // Batch in chunks of 500 to keep payloads reasonable
        for (let i = 0; i < gexRows.length; i += 500) {
          const chunk = gexRows.slice(i, i + 500);
          const { error: gexErr } = await supabase
            .from('ct_gex_timeseries')
            .upsert(chunk, { onConflict: 'ticker,snapshot_at,strike', ignoreDuplicates: true });
          if (gexErr) console.warn('[ct-watcher] gex_timeseries chunk failed:', gexErr.message);
        }
        console.log(`[ct-watcher] gex_timeseries wrote ${gexRows.length} rows`);
      }
    } catch (e) {
      console.warn('[ct-watcher] gex_timeseries write threw:', e instanceof Error ? e.message : e);
    }

    // 3. Build memory bundle (thesis + recent + similar + lessons per instrument)
    const liveStateByInstrument: Record<string, Record<string, unknown>> = {};
    for (const t of WATCHLIST) {
      liveStateByInstrument[t] = {
        spot_gex: rawState.spot_gex[t],
        options_volume: rawState.options_volume[t],
      };
    }
    const [memory, selfCorrections, activeBiases, activePlaybooksRes] = await Promise.all([
      buildMemoryBundle(supabase, WATCHLIST, liveStateByInstrument),
      getRecentSelfCorrections(supabase, 5),
      getActiveBiases(supabase, 3),
      // Top-5 active playbooks by quality score (win_rate × sample_size).
      // Curated weekly by ct-playbook-curator. Trimmed to fields Claude needs
      // to pattern-match against current tape.
      supabase
        .from('ct_playbooks')
        .select('id, name, description, setup_criteria, historical_win_rate, sample_size, avg_return_pct, avg_r_multiple, last_confirmed_at')
        .eq('status', 'active')
        .not('historical_win_rate', 'is', null)
        .gt('sample_size', 0)
        // Postgres can't order by a computed product directly via PostgREST,
        // so sort by sample_size desc then win_rate desc — near-equivalent
        // for quality ranking and cheap (no RPC needed). If it matters later
        // we'll promote this to an RPC with the real composite.
        .order('sample_size', { ascending: false })
        .order('historical_win_rate', { ascending: false })
        .limit(5),
    ]);
    const activePlaybooks = activePlaybooksRes?.data ?? [];

    // 3b. Recent flow + dark pool + NOPE + top movers + sweeps + net-prem ticks
    // + max pain + greek flow + iv rank. Claude reasons over real whale activity,
    // regime classifier, dealer hedging flow, pin-risk, vol regime, and watchlist
    // contagion — all in one shot.
    const flowCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const topMoversCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    // Net-prem stream writes every ~3 min during market hours only — allow a
    // 90-min lookback so after-hours cycles still see the last intraday reading.
    const netPremCutoff = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    // Greek-flow only writes during market hours — 60-min lookback for same reason.
    const greekFlowCutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const todayStr = new Date().toISOString().slice(0, 10);
    const ivRankSince = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    const [
      flowRecent,
      dpRecent,
      nopeRecent,
      topMovers,
      sweeps,
      netPremRecent,
      maxPainRecent,
      greekFlowRecent,
      ivRankRecent,
    ] = await Promise.all([
      // Watchlist-only, high-premium flow — dropped from 25 wide to 25 filtered
      supabase
        .from('ct_flow_alerts')
        .select('ticker, side, strike, expiry, is_otm, is_ask, size, premium, size_gt_oi, executed_at, ingested_at')
        .gte('ingested_at', flowCutoff)
        .gte('premium', 250_000)
        .in('ticker', WATCHLIST as unknown as string[])
        .order('premium', { ascending: false })
        .limit(25),
      // Dark pool: 25 -> 10 (biggest)
      supabase
        .from('ct_dark_pool_prints')
        .select('ticker, size, price, notional_value, executed_at, ingested_at')
        .gte('ingested_at', flowCutoff)
        .order('notional_value', { ascending: false })
        .limit(10),
      supabase
        .from('ct_nope_minute')
        .select('ticker, nope, tick_timestamp')
        .gte('tick_timestamp', new Date(Date.now() - 15 * 60 * 1000).toISOString())
        .order('tick_timestamp', { ascending: false })
        .limit(15),
      // Top movers: 20 -> 10
      supabase
        .from('ct_top_movers')
        .select('ticker, side, rank, net_premium, snapshot_at')
        .gte('snapshot_at', topMoversCutoff)
        .order('snapshot_at', { ascending: false })
        .order('rank', { ascending: true })
        .limit(10),
      supabase
        .from('ct_sweeps')
        .select('ticker, type, strike, expiry, premium, volume, open_interest, sweep_ratio, snapshot_at')
        .gte('snapshot_at', topMoversCutoff)
        .order('premium', { ascending: false })
        .limit(15),
      // Net-premium ticks, last 35min — enough to compute a 30min-ago anchor
      supabase
        .from('ct_net_premium_ticks')
        .select('ticker, tick_timestamp, net_call_premium, net_put_premium, net_call_volume, net_put_volume')
        .gte('tick_timestamp', netPremCutoff)
        .order('tick_timestamp', { ascending: false }),
      // Max pain — today, all expiries for watchlist
      supabase
        .from('ct_max_pain_daily')
        .select('ticker, expiry, max_pain_strike')
        .gte('date', todayStr)
        .order('expiry', { ascending: true }),
      // Greek flow — last 10 min for SPY/QQQ/IWM
      supabase
        .from('ct_greek_flow_minute')
        .select('ticker, tick_timestamp, total_delta_flow, total_vega_flow, underlying_price')
        .in('ticker', ['SPY', 'QQQ', 'IWM'])
        .gte('tick_timestamp', greekFlowCutoff)
        .order('tick_timestamp', { ascending: false }),
      // IV rank — last 2 days, pick latest per ticker downstream
      supabase
        .from('ct_iv_rank_daily')
        .select('ticker, iv_rank, iv_30d, date')
        .gte('date', ivRankSince)
        .order('date', { ascending: false }),
    ]);

    // --- Reduce raw payloads to per-ticker summaries ---

    // a) net_prem_per_ticker_30min — latest row per ticker + 30min delta anchor
    type NPRow = { ticker: string; tick_timestamp: string; net_call_premium: number | null; net_put_premium: number | null; net_call_volume: number | null; net_put_volume: number | null };
    const npRows = (netPremRecent.data ?? []) as NPRow[];
    const latestByTicker = new Map<string, NPRow>();
    const anchorByTicker = new Map<string, NPRow>();
    const thirtyMinAgo = Date.now() - 30 * 60 * 1000;
    for (const r of npRows) {
      if (!latestByTicker.has(r.ticker)) latestByTicker.set(r.ticker, r);
      // First row at or before 30min ago becomes the anchor (rows are desc)
      const ts = Date.parse(r.tick_timestamp);
      if (ts <= thirtyMinAgo && !anchorByTicker.has(r.ticker)) {
        anchorByTicker.set(r.ticker, r);
      }
    }
    const netPremPerTicker30min = Array.from(latestByTicker.entries()).map(([ticker, latest]) => {
      const anchor = anchorByTicker.get(ticker);
      return {
        ticker,
        net_call_premium: latest.net_call_premium,
        net_put_premium: latest.net_put_premium,
        delta_call_30min: anchor != null ? Number(latest.net_call_premium ?? 0) - Number(anchor.net_call_premium ?? 0) : null,
        delta_put_30min: anchor != null ? Number(latest.net_put_premium ?? 0) - Number(anchor.net_put_premium ?? 0) : null,
      };
    });

    // b) max_pain_per_ticker — nearest expiry per ticker
    type MPRow = { ticker: string; expiry: string | null; max_pain_strike: number | null };
    const maxPainPerTicker: Record<string, { strike: number | null; expiry: string | null }> = {};
    for (const r of (maxPainRecent.data ?? []) as MPRow[]) {
      if (!maxPainPerTicker[r.ticker]) {
        maxPainPerTicker[r.ticker] = { strike: r.max_pain_strike, expiry: r.expiry };
      }
    }

    // c) greek_flow_latest — latest row per SPY/QQQ/IWM
    type GFRow = { ticker: string; tick_timestamp: string; total_delta_flow: number | null; total_vega_flow: number | null; underlying_price: number | null };
    const gfRows = (greekFlowRecent.data ?? []) as GFRow[];
    const latestGreek = new Map<string, GFRow>();
    for (const r of gfRows) if (!latestGreek.has(r.ticker)) latestGreek.set(r.ticker, r);
    const greekFlowLatest = Array.from(latestGreek.values()).map(r => ({
      ticker: r.ticker,
      dir_delta_flow: r.total_delta_flow,
      dir_vega_flow: r.total_vega_flow,
      underlying_price: r.underlying_price,
      ts: r.tick_timestamp,
    }));

    // d) iv_rank_per_ticker — latest row per ticker
    type IVRow = { ticker: string; iv_rank: number | null; iv_30d: number | null; date: string };
    const ivRows = (ivRankRecent.data ?? []) as IVRow[];
    const ivLatest = new Map<string, IVRow>();
    for (const r of ivRows) if (!ivLatest.has(r.ticker)) ivLatest.set(r.ticker, r);
    const ivRankPerTicker: Record<string, { rank: number | null; iv_30d: number | null }> = {};
    for (const [ticker, r] of ivLatest.entries()) {
      ivRankPerTicker[ticker] = { rank: r.iv_rank, iv_30d: r.iv_30d };
    }

    // 3b2. News sentiment net score per ticker (last 24h). Evidence axis E.
    // Net <= -3 = bearish catalyst bias; net >= +3 = bullish catalyst bias.
    // Watcher system prompt references this explicitly. Defensive: returns
    // zeroed map on query error — never crashes the cycle.
    const newsSentiment24h = await getNewsSentimentNet(supabase, WATCHLIST as unknown as string[], 24);

    // 3c. CONVERGENCE DETECTOR — count independent signals pointing same
    // direction in the last 15min. ≥3 converging signals forces ALERT even
    // if Claude's conviction is low. Bypasses gun-shyness on clear setups.
    const convergence = (() => {
      let bullish = 0, bearish = 0;
      const signals: string[] = [];
      // Signal 1: NOPE direction across SPY/QQQ/IWM (latest tick)
      const nopeRows = (nopeRecent.data ?? []) as Array<{ ticker: string; nope: number | null }>;
      const latestNope = new Map<string, number>();
      for (const r of nopeRows) if (!latestNope.has(r.ticker) && r.nope != null) latestNope.set(r.ticker, r.nope);
      const avgNope = Array.from(latestNope.values()).reduce((a, b) => a + b, 0) / (latestNope.size || 1);
      if (avgNope > 0.5) { bullish++; signals.push(`NOPE positive ${avgNope.toFixed(2)}`); }
      else if (avgNope < -0.5) { bearish++; signals.push(`NOPE negative ${avgNope.toFixed(2)}`); }
      // Signal 2: Net premium flow direction last 30min (watchlist aggregate)
      const npArr = netPremPerTicker30min as Array<{ delta_call_prem_30min?: number; delta_put_prem_30min?: number }>;
      const callDelta = npArr.reduce((a, r) => a + (r.delta_call_prem_30min ?? 0), 0);
      const putDelta = npArr.reduce((a, r) => a + (r.delta_put_prem_30min ?? 0), 0);
      if (callDelta > 5_000_000 && callDelta > putDelta * 2) { bullish++; signals.push(`call flow +$${(callDelta/1e6).toFixed(1)}M last 30min`); }
      else if (putDelta > 5_000_000 && putDelta > callDelta * 2) { bearish++; signals.push(`put flow +$${(putDelta/1e6).toFixed(1)}M last 30min`); }
      // Signal 3: Dark pool dominance (large prints same direction)
      const dpRows = (dpRecent.data ?? []) as Array<{ ticker: string; notional_value?: number }>;
      const dpTotalNotional = dpRows.reduce((a, r) => a + (r.notional_value ?? 0), 0);
      if (dpTotalNotional > 200_000_000) { bullish++; signals.push(`DP accumulation $${(dpTotalNotional/1e6).toFixed(0)}M last 10min`); }
      // Signal 4: Greek flow (dir_delta_flow cumulative)
      const totalDeltaFlow = greekFlowLatest.reduce((a, r) => a + (r.dir_delta_flow ?? 0), 0);
      if (totalDeltaFlow > 5000) { bullish++; signals.push(`delta flow +${totalDeltaFlow.toFixed(0)}`); }
      else if (totalDeltaFlow < -5000) { bearish++; signals.push(`delta flow ${totalDeltaFlow.toFixed(0)}`); }
      // Signal 5: Big whale print on watchlist
      const bigWhales = (flowRecent.data ?? []).filter((r: Record<string, unknown>) => (r.premium as number | undefined ?? 0) >= 1_000_000);
      const whaleCalls = bigWhales.filter((r: Record<string, unknown>) => r.side === 'call').length;
      const whalePuts = bigWhales.filter((r: Record<string, unknown>) => r.side === 'put').length;
      if (whaleCalls >= 3 && whaleCalls > whalePuts * 2) { bullish++; signals.push(`${whaleCalls} whale calls >$1M`); }
      else if (whalePuts >= 3 && whalePuts > whaleCalls * 2) { bearish++; signals.push(`${whalePuts} whale puts >$1M`); }

      const direction = bullish > bearish ? 'bullish' : bearish > bullish ? 'bearish' : 'neutral';
      const count = Math.max(bullish, bearish);
      return { count, direction, signals, bullish, bearish };
    })();

    // 4. Assemble Claude user message — condensed, under ~6K tokens
    const userMessage = JSON.stringify({
      timestamp_utc: clock.iso,
      timestamp_et: clock.datetime,
      market_state: condensed,
      memory,
      self_corrections_72h: selfCorrections,
      known_biases: activeBiases,
      active_playbooks: activePlaybooks,
      convergence,
      recent_flow_alerts: flowRecent.data ?? [],
      recent_dark_pool_prints: dpRecent.data ?? [],
      nope_recent: nopeRecent.data ?? [],
      top_movers_30min: topMovers.data ?? [],
      unusual_sweeps_30min: sweeps.data ?? [],
      net_prem_per_ticker_30min: netPremPerTicker30min,
      max_pain_per_ticker: maxPainPerTicker,
      greek_flow_latest: greekFlowLatest,
      iv_rank_per_ticker: ivRankPerTicker,
      news_sentiment_24h_per_ticker: newsSentiment24h,
      proxy_mapping: {
        GLD: 'gold ETF — used as proxy for gold futures (GC) flow and positioning',
        USO: 'oil ETF — used as proxy for oil futures (CL) flow and positioning',
        SPX: 'cash S&P 500 index — used as proxy for ES futures macro regime read',
      },
      note: `UW does not cover futures directly; treat the proxies above as their futures equivalents for reasoning.
self_corrections_72h: your OWN hindsight from the self-grader on recent calls. "what_i_got_wrong" = the specific error pattern. "how_id_rewrite" = the corrected read. BEFORE emitting FLAG/ALERT, check if you're about to repeat a pattern flagged here. Cite the correction if relevant (e.g. "regraded myself 2h ago — called 'imminent' too hot; this time holding OBSERVATION until acceleration confirms"). This is your memory of your own mistakes — use it or repeat them.
known_biases: structural patterns extracted by the weekly bias-booth. Identity-level blindspots (not tactical rules). If any bias here applies to the current setup, explicitly counter-weight: if bias says "overweights put flow in low-VIX tape," and today is low-VIX + put-flow-heavy, demote any bearish FLAG to OBSERVATION unless flow is >2σ above your usual threshold.
active_playbooks: curated setup signatures you've won on repeatedly. Each row has a setup_criteria object (regime, session, evidence_axes, catalyst, iv_tier, instruments, direction). If current tape MATCHES a playbook's criteria (regime tag aligns, session window aligns, required evidence_axes are present, instrument in scope, catalyst matches), WEIGHT HEAVILY toward that playbook's direction — this is your proven edge, distilled from N+ graded outcomes with a stated win_rate. Cite the playbook name in your glance when it fires (e.g. "Monday gamma+ breadth setup — playbook win rate 68% n=11"). If no playbook matches, ignore this field.
recent_flow_alerts: WATCHLIST-only, premium ≥\$250K, last 10min — cite specific prints when material.
recent_dark_pool_prints: top-10 by notional, last 10min. Prints >\$50M = institutional positioning.
nope_recent: Net Options Pricing Effect per minute for SPY/QQQ/IWM. NOPE < 0 = dealers short gamma = momentum / trending regime. NOPE > 0 = dealers long gamma = mean-revert / vol-compressed. Use latest readings to validate or contradict the regime inference from gamma flip.
top_movers_30min: top-10 bull+bear by net premium across the market. Surfaces tickers OUTSIDE the 12-ticker watchlist.
unusual_sweeps_30min: canonical "unusual sweep" screen (OTM, sweep ratio >70%, vol > OI, premium ≥\$100K).
net_prem_per_ticker_30min: TRUE UW tick-stream net call/put premium per ticker + 30min delta. Cleaner than cumsumming flow_alerts — this IS the UW-side intraday sentiment signal. If delta_call rising + delta_put falling, bullish bias accumulating. Cite the delta magnitudes when flagging.
max_pain_per_ticker: nearest-expiry max-pain strike per ticker. At 0DTE/1DTE, max-pain has pin gravity — if spot within 1% of max-pain approaching expiry, flag "pin risk."
greek_flow_latest: signed dealer hedging flow for SPY/QQQ/IWM. A sharp sign flip (dir_delta_flow crossing zero) often LEADS price by minutes. Call it out when it diverges from price.
iv_rank_per_ticker: rank 80+ = premium-selling regime favored, 20- = premium-buying favored. Influences which strategies are "cheap" and whether vol-expansion is likely vs already priced.
news_sentiment_24h_per_ticker: per-ticker structured news sentiment over the last 24h. net_score = Σ signed magnitudes (positive = +magnitude, negative = -magnitude, neutral = 0). This is EVIDENCE AXIS E (catalyst). If net_score <= -3, lean bearish on that ticker unless axes A (structural) or C (dealer flow) clearly contradict. If net_score >= +3, the opposite. Cite the specific count when flagging (e.g. "MSFT news -4: 3 neg magnitudes 2,2,1 vs 0 pos"). Stale sentiment (scored=0) = no catalyst signal, ignore.
Decide ONE state for this cycle and emit the JSON per the schema in the system prompt. Return ONLY the JSON.`,
    });

    // 5. Call Claude — Haiku for Day 2 (cost-efficient workhorse). UW MCP
    // attached for mid-turn drill-downs when the scheduled snapshot is
    // insufficient (e.g. sweep cites a strike outside the near-ATM window,
    // news headline names a non-watchlist ticker). Budget: WATCHER_MCP_BUDGET
    // per tick — soft-enforced via prompt + post-hoc audit.
    let claudeText = '';
    let claudeError: string | null = null;
    let mcpCalls = 0;
    const uwKey = Deno.env.get('UW_API_KEY');
    const claudeCallStart = Date.now();
    // If this tick was fired by an approaching earnings report, tack an
    // addendum onto the system prompt — Haiku should tilt sizing smaller,
    // stops tighter, and favor shorter-horizon framing in the narrative.
    const earningsAddendum = (triggerInfo?.source === 'earnings_approach' && triggerInfo.earnings)
      ? `\n\n--- EARNINGS ADDENDUM (event-driven fire) ---
Earnings in ${triggerInfo.earnings.hours_remaining.toFixed(1)}h for ${triggerInfo.earnings.ticker} (${triggerInfo.earnings.report_date}${triggerInfo.earnings.report_time ? ` ${triggerInfo.earnings.report_time.toUpperCase()}` : ''}). IV typically expands 20–40% leading in; vol is priced to the known event, so long-premium setups into the print are expensive and directional conviction should be LOWER than flow alone suggests. Size trades on ${triggerInfo.earnings.ticker} smaller, tighter stops, consider shorter horizons or explicit defined-risk structures. Advisory only — do NOT auto-close anything. When surfacing reads on ${triggerInfo.earnings.ticker} in this tick, cite the earnings proximity in the glance.`
      : '';

    try {
      const response = await callClaude({
        model: CLAUDE_MODELS.haiku,
        system: earningsAddendum ? CT_SYSTEM_PROMPT_V1 + earningsAddendum : CT_SYSTEM_PROMPT_V1,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 3000,
        temperature: 0.2,
        mcp_servers: uwKey ? [{
          type: 'url',
          url: 'https://api.unusualwhales.com/api/mcp',
          name: 'unusual-whales',
          authorization_token: uwKey,
        }] : undefined,
        beta: uwKey ? ['mcp-client-2025-04-04'] : undefined,
      });
      claudeText = parseTextContent(response);

      // Count + audit MCP calls — always log, warn if over budget.
      mcpCalls = countMcpCalls(response);
      if (mcpCalls > 0) {
        logMcpCalls(supabase, 'watcher', response as unknown as { content?: unknown }, { user_id: userId })
          .catch((e) => console.warn('[ct-watcher] mcpLog failed:', e));
      }
      if (mcpCalls > WATCHER_MCP_BUDGET) {
        console.warn(`[ct-watcher] BUDGET EXCEEDED: claimed ${mcpCalls} MCP calls (max ${WATCHER_MCP_BUDGET})`);
      }

      // Unified Claude cost log — every watcher tick now lands in ct_claude_usage.
      logClaudeUsage(supabase, {
        source: 'ct-watcher',
        model: CLAUDE_MODELS.haiku,
        usage: response.usage,
        duration_ms: Date.now() - claudeCallStart,
        mcp_calls: mcpCalls,
        metadata: { user_id: userId },
      });
    } catch (e) {
      claudeError = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
      console.error('[ct-watcher] Claude call failed:', claudeError);
    }

    // 6. Parse Claude response
    const parsed = claudeText ? parseClaudeJson(claudeText) : null;

    // 7. Dispatch by state — ALWAYS end with at least a heartbeat row
    let heartbeatId: string | null = null;
    let eventType: CtState = 'HEARTBEAT';
    let eventId: string | null = null;

    if (!parsed) {
      // Claude failed or returned unparsable — write a fallback heartbeat
      const fallback = claudeError
        ? `Claude error: ${claudeError}`
        : `Claude returned unparsable output (${claudeText.length} chars)`;
      heartbeatId = await writeHeartbeat(supabase, condensed, { state: 'HEARTBEAT', watching: condensedWatching(condensed) } as ClaudeJson, fallback, triggerInfo);
    } else {
      eventType = parsed.state;
      switch (parsed.state) {
        case 'HEARTBEAT':
          heartbeatId = await writeHeartbeat(supabase, condensed, parsed, null, triggerInfo);
          break;
        case 'OBSERVATION':
          eventId = await writeObservation(supabase, userId, condensed, parsed, undefined, convergence.count, triggerInfo);
          // Also write a heartbeat to keep the pulse row
          heartbeatId = await writeHeartbeat(
            supabase,
            condensed,
            { state: 'HEARTBEAT', status_line: `observation written: ${eventId?.slice(0, 8) ?? 'err'}`, watching: condensedWatching(condensed) } as ClaudeJson,
            null,
            triggerInfo,
          );
          break;
        case 'FLAG':
          eventId = await writeFlag(supabase, userId, condensed, parsed, { convergenceCount: convergence.count, triggerInfo });
          heartbeatId = await writeHeartbeat(
            supabase,
            condensed,
            { state: 'HEARTBEAT', status_line: `flag written: ${eventId?.slice(0, 8) ?? 'err'} conv ${parsed.conviction} ${parsed.direction}`, watching: condensedWatching(condensed) } as ClaudeJson,
            null,
            triggerInfo,
          );
          break;
        case 'ALERT': {
          const alertResult = await writeAlert(supabase, userId, condensed, parsed, convergence.count, { sameDirectionMin, invalidationMin }, triggerInfo);
          let hbStatus: string;
          if (alertResult.alertId) {
            eventId = alertResult.alertId;
            hbStatus = `ALERT written: ${eventId.slice(0, 8)} ${parsed.alert_trigger} ${parsed.direction}`;
          } else if (alertResult.demotedTo) {
            // Demotion happened — reflect the true event type for Slack + thesis logic
            eventId = alertResult.demotedEventId;
            eventType = alertResult.demotedTo === 'flag' ? 'FLAG' : 'OBSERVATION';
            hbStatus = `ALERT demoted to ${alertResult.demotedTo.toUpperCase()}: ${alertResult.demotedEventId?.slice(0, 8) ?? 'err'} (cooldown) ${parsed.alert_trigger} ${parsed.direction}`;
          } else {
            hbStatus = `ALERT write failed: ${parsed.alert_trigger} ${parsed.direction}`;
          }
          heartbeatId = await writeHeartbeat(
            supabase,
            condensed,
            { state: 'HEARTBEAT', status_line: hbStatus, watching: condensedWatching(condensed) } as ClaudeJson,
            null,
            triggerInfo,
          );
          break;
        }
        default:
          heartbeatId = await writeHeartbeat(supabase, condensed, { state: 'HEARTBEAT', watching: condensedWatching(condensed) } as ClaudeJson, `unknown state: ${parsed.state}`, triggerInfo);
      }
    }

    // Backfill heartbeat_id on the audit row so operators can join the
    // watcher cycle to its trigger. Best-effort; failure is not fatal.
    if (triggerInfo?.trigger_id && heartbeatId) {
      try {
        await supabase
          .from('ct_watcher_event_triggers')
          .update({ heartbeat_id: heartbeatId })
          .eq('id', triggerInfo.trigger_id);
      } catch (e) {
        console.warn('[ct-watcher] heartbeat backfill to event-trigger row failed:', e instanceof Error ? e.message : e);
      }
    }

    // 8. Apply any thesis updates
    let thesisUpdatesApplied = 0;
    if (parsed?.thesis_updates) {
      thesisUpdatesApplied = await applyThesisUpdates(
        supabase,
        userId,
        parsed,
        eventId,
        eventType === 'HEARTBEAT' ? null : eventType.toLowerCase(),
      );
    }

    // 9. Slack push — any FLAG (conv≥2), any ALERT, OR OBSERVATION whose
    // glance[0] is a THESIS INVALIDATION (actionable "old trade dead" signal
    // even without a new directional commit). The invalidation case is the
    // highest-value silent signal today — James wants to know when his
    // position is fighting the tape.
    if (userId && parsed) {
      const glanceArr = toArray(parsed.glance).filter((s): s is string => typeof s === 'string');
      const instruments = toArray(parsed.instruments).filter(Boolean) as string[];
      const isInvalidation = glanceArr[0]?.toUpperCase().startsWith('THESIS INVALIDATED') ?? false;

      // Gate on eventType (post-demotion truth) rather than parsed.state so a
      // cooldown-demoted ALERT doesn't fire a full-volume ALERT Slack push.
      if (eventType === 'FLAG' && (parsed.conviction ?? 0) >= 2) {
        await ctSlackPush(supabase, userId, {
          state: 'FLAG', instruments, glance: glanceArr,
          conviction: parsed.conviction, horizon: parsed.horizon,
          direction: parsed.direction, alert_trigger: parsed.alert_trigger,
          convergence_count: convergence.count, event_id: eventId ?? undefined,
        });
      } else if (eventType === 'ALERT') {
        await ctSlackPush(supabase, userId, {
          state: 'ALERT', instruments, glance: glanceArr,
          conviction: 5, horizon: parsed.horizon, alert_trigger: parsed.alert_trigger,
          direction: parsed.direction,
          convergence_count: convergence.count, event_id: eventId ?? undefined,
        });
      } else if (eventType === 'OBSERVATION' && isInvalidation) {
        await ctSlackPush(supabase, userId, {
          state: 'FLAG', instruments, glance: glanceArr,
          conviction: 2, horizon: parsed.horizon ?? '4h',
          direction: parsed.direction,
          alert_trigger: 'thesis_invalidation',
          event_id: eventId ?? undefined,
        });
      }
    }

    const durationMs = Date.now() - startedAt;

    return new Response(JSON.stringify({
      success: true,
      state: eventType,
      event_id: eventId,
      heartbeat_id: heartbeatId,
      thesis_updates_applied: thesisUpdatesApplied,
      claude_ok: !!parsed,
      uw_errors: rawState.errors.length,
      duration_ms: durationMs,
      prompt_version: CT_PROMPT_VERSION,
      mcp_calls: mcpCalls,
      mcp_budget_breach: mcpCalls > WATCHER_MCP_BUDGET,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[ct-watcher] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'watcher failed',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
