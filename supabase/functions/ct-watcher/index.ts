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
import { pullWatcherState, WATCHLIST } from '../_shared/uwClient.ts';
import { now as clockNow } from '../_shared/clock.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { CT_SYSTEM_PROMPT_V1, CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';
import { buildMemoryBundle } from '../_shared/memoryRecall.ts';
import { embedCtItem, buildCtRichText } from '../_shared/ctEmbed.ts';
import { condenseWatcherState, type CondensedState } from '../_shared/ctStateCondense.ts';
import { ctSlackPush } from '../_shared/ctSlack.ts';

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

function horizonEnd(horizon: string, fromIso: string): string {
  const from = new Date(fromIso);
  switch (horizon) {
    case '1h':        from.setHours(from.getHours() + 1); break;
    case '4h':        from.setHours(from.getHours() + 4); break;
    case 'EOD':
      // 20:00 UTC (4pm ET during EDT). If already past, next day.
      from.setUTCHours(20, 0, 0, 0);
      if (from.getTime() <= Date.parse(fromIso)) from.setUTCDate(from.getUTCDate() + 1);
      break;
    case 'next-day':  from.setUTCDate(from.getUTCDate() + 1); break;
    case 'weekly':    from.setUTCDate(from.getUTCDate() + 7); break;
    default:          from.setHours(from.getHours() + 4);
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

async function writeHeartbeat(
  supabase: SupabaseClient,
  condensed: CondensedState,
  claude: ClaudeJson,
  fallbackReason: string | null
): Promise<string | null> {
  const statusLine = asString(claude?.status_line) || fallbackReason || 'watcher cycle — claude output unparsable, wrote fallback heartbeat';
  const watching = toArray(claude?.watching as string | string[]).filter(s => typeof s === 'string') as string[];
  const current_reads = claude?.current_reads && typeof claude.current_reads === 'object' ? claude.current_reads : {};

  const { data, error } = await supabase.from('ct_heartbeats').insert({
    status_line: statusLine,
    watching: watching.length > 0 ? watching : condensedWatching(condensed),
    current_reads: { ...current_reads, _snapshot: condensed },
    prompt_version: CT_PROMPT_VERSION,
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
  claude: ClaudeJson
): Promise<string | null> {
  const instruments = toArray(claude.instruments).filter(Boolean) as string[];
  if (instruments.length === 0) {
    console.warn('[ct-watcher] OBSERVATION missing instruments');
    return null;
  }

  const { data, error } = await supabase.from('ct_observations').insert({
    user_id: userId,
    instruments,
    observation: asString(claude.observation) || '(empty)',
    glance: toArray(claude.glance).filter(s => typeof s === 'string'),
    up_case: asString(claude.up_case),
    up_case_odds: claude.up_case_odds ?? null,
    down_case: asString(claude.down_case),
    down_case_odds: claude.down_case_odds ?? null,
    direction: claude.direction ?? null,
    prior_read: asString(claude.prior_read),
    update_note: asString(claude.update_note),
    watching: asString(claude.memory_recall || claude.watching as string),
    memory_recall_used: { summary: asString(claude.memory_recall) },
    prompt_version: CT_PROMPT_VERSION,
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
  claude: ClaudeJson
): Promise<string | null> {
  const instruments = toArray(claude.instruments).filter(Boolean) as string[];
  if (instruments.length === 0) {
    console.warn('[ct-watcher] FLAG missing instruments');
    return null;
  }
  const conviction = Math.max(1, Math.min(4, Number(claude.conviction) || 2));
  const horizon = claude.horizon ?? '4h';
  const nowIso = new Date().toISOString();

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
    memory_recall_used: { summary: asString(claude.memory_recall) },
    prompt_version: CT_PROMPT_VERSION,
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

async function writeAlert(
  supabase: SupabaseClient,
  userId: string | null,
  condensed: CondensedState,
  claude: ClaudeJson
): Promise<string | null> {
  const instruments = toArray(claude.instruments).filter(Boolean) as string[];
  if (instruments.length === 0) {
    console.warn('[ct-watcher] ALERT missing instruments');
    return null;
  }
  const horizon = claude.horizon ?? '4h';
  const nowIso = new Date().toISOString();
  const trigger = claude.alert_trigger ?? 'other';

  const { data, error } = await supabase.from('ct_alerts').insert({
    user_id: userId,
    instruments,
    direction: claude.direction ?? 'neutral',
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
    alert_trigger: trigger,
    prompt_version: CT_PROMPT_VERSION,
  }).select('id').maybeSingle();

  if (error) {
    console.error('[ct-watcher] alert insert failed:', error.message);
    return null;
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
  return id;
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

  const clock = clockNow();
  const startedAt = Date.now();

  try {
    // 1. Single-user: fetch James's user_id
    const { data: users } = await supabase.from('profiles').select('id').limit(1);
    const userId = (users?.[0]?.id as string | undefined) ?? null;

    // 2. Pull live UW state
    const rawState = await pullWatcherState();
    const condensed = condenseWatcherState(rawState, clock.iso);

    // 3. Build memory bundle (thesis + recent + similar + lessons per instrument)
    const liveStateByInstrument: Record<string, Record<string, unknown>> = {};
    for (const t of WATCHLIST) {
      liveStateByInstrument[t] = {
        spot_gex: rawState.spot_gex[t],
        options_volume: rawState.options_volume[t],
      };
    }
    const memory = await buildMemoryBundle(supabase, WATCHLIST, liveStateByInstrument);

    // 4. Assemble Claude user message — condensed, under ~6K tokens
    const userMessage = JSON.stringify({
      timestamp_utc: clock.iso,
      timestamp_et: clock.datetime,
      market_state: condensed,
      memory,
      proxy_mapping: {
        GLD: 'gold ETF — used as proxy for gold futures (GC) flow and positioning',
        USO: 'oil ETF — used as proxy for oil futures (CL) flow and positioning',
        SPX: 'cash S&P 500 index — used as proxy for ES futures macro regime read',
      },
      note: 'UW does not cover futures directly; treat the proxies above as their futures equivalents for reasoning. Decide ONE state for this cycle and emit the JSON per the schema in the system prompt. Return ONLY the JSON.',
    });

    // 5. Call Claude — Haiku for Day 2 (cost-efficient workhorse)
    let claudeText = '';
    let claudeError: string | null = null;
    try {
      const response = await callClaude({
        model: CLAUDE_MODELS.haiku,
        system: CT_SYSTEM_PROMPT_V1,
        messages: [{ role: 'user', content: userMessage }],
        max_tokens: 3000,
        temperature: 0.2,
      });
      claudeText = parseTextContent(response);
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
      heartbeatId = await writeHeartbeat(supabase, condensed, { state: 'HEARTBEAT', watching: condensedWatching(condensed) } as ClaudeJson, fallback);
    } else {
      eventType = parsed.state;
      switch (parsed.state) {
        case 'HEARTBEAT':
          heartbeatId = await writeHeartbeat(supabase, condensed, parsed, null);
          break;
        case 'OBSERVATION':
          eventId = await writeObservation(supabase, userId, condensed, parsed);
          // Also write a heartbeat to keep the pulse row
          heartbeatId = await writeHeartbeat(
            supabase,
            condensed,
            { state: 'HEARTBEAT', status_line: `observation written: ${eventId?.slice(0, 8) ?? 'err'}`, watching: condensedWatching(condensed) } as ClaudeJson,
            null,
          );
          break;
        case 'FLAG':
          eventId = await writeFlag(supabase, userId, condensed, parsed);
          heartbeatId = await writeHeartbeat(
            supabase,
            condensed,
            { state: 'HEARTBEAT', status_line: `flag written: ${eventId?.slice(0, 8) ?? 'err'} conv ${parsed.conviction} ${parsed.direction}`, watching: condensedWatching(condensed) } as ClaudeJson,
            null,
          );
          break;
        case 'ALERT':
          eventId = await writeAlert(supabase, userId, condensed, parsed);
          heartbeatId = await writeHeartbeat(
            supabase,
            condensed,
            { state: 'HEARTBEAT', status_line: `ALERT written: ${eventId?.slice(0, 8) ?? 'err'} ${parsed.alert_trigger} ${parsed.direction}`, watching: condensedWatching(condensed) } as ClaudeJson,
            null,
          );
          break;
        default:
          heartbeatId = await writeHeartbeat(supabase, condensed, { state: 'HEARTBEAT', watching: condensedWatching(condensed) } as ClaudeJson, `unknown state: ${parsed.state}`);
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

    // 9. Slack push for FLAG conv ≥ 3 or ALERT
    if (userId && parsed) {
      if (parsed.state === 'FLAG' && (parsed.conviction ?? 0) >= 3) {
        await ctSlackPush(supabase, userId, {
          state: 'FLAG',
          instruments: toArray(parsed.instruments).filter(Boolean) as string[],
          glance: toArray(parsed.glance).filter(s => typeof s === 'string'),
          conviction: parsed.conviction,
          horizon: parsed.horizon,
        });
      } else if (parsed.state === 'ALERT') {
        await ctSlackPush(supabase, userId, {
          state: 'ALERT',
          instruments: toArray(parsed.instruments).filter(Boolean) as string[],
          glance: toArray(parsed.glance).filter(s => typeof s === 'string'),
          conviction: 5,
          horizon: parsed.horizon,
          alert_trigger: parsed.alert_trigger,
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
