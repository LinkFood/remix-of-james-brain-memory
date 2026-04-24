/**
 * specialistRunner — shared logic for all 10 Co-Trader v2 per-ticker specialists.
 *
 * Each specialist edge function (ct-specialist-NVDA, ct-specialist-AAPL, ...) is
 * a thin wrapper that constructs a SupabaseClient + ticker and calls
 * runSpecialistWakeup(). All heavy lifting — config load, cooldown check,
 * candidate scoring filter, memory + hit-rate recall, Claude call, flag write,
 * decision journal, usage logging — lives here.
 *
 * Contract:
 *   - Service-role supabase client passed by caller.
 *   - Never throws on Claude errors / bad JSON — returns ok:false with
 *     skip_reason. Callers can forward the result as JSON.
 *   - Writes 0-3 flags per wakeup. Flags are written one at a time so one
 *     failure doesn't poison the batch.
 *
 * See CO_TRADER_V2_SCOPE.md § "Specialist framework".
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from './anthropic.ts';
import { logClaudeUsage } from './claudeUsageLog.ts';
import { isKillSwitchActive } from './killSwitch.ts';
import { recordDecision } from './decisionJournal.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpecialistContext {
  ticker: string;
  prompt: string;
  wakeupThreshold: number;
  cooldownMinutes: number;
  maxFlagsPerDay: number;
}

export interface SpecialistWakeupArgs {
  supabase: SupabaseClient;
  ticker: string;
  reason: 'scheduled' | 'event_driven' | 'manual';
  forcedEventIds?: string[];
}

export interface SpecialistWakeupResult {
  ok: boolean;
  ticker: string;
  reason: string;
  skip_reason?: string;
  events_considered: number;
  flags_written: number;
  flag_ids: string[];
  cost_usd: number;
  elapsed_ms: number;
  error?: string;
}

interface FlagDecision {
  option_symbol?: string | null;
  direction: 'bullish' | 'bearish' | 'neutral';
  tags: string[];
  thesis: string;
  invalidation: string;
  horizon_hours: number;
  target_price?: number | null;
  score?: number | null;
  source_flow_ids?: string[];
}

interface ClaudeVerdict {
  flags: FlagDecision[];
  pass_reason?: string | null;
}

const GENERIC_PROMPT_FALLBACK = `You are a per-ticker options-flow specialist in Co-Trader v2.
Your job: given recent scored flow events on this ticker plus your own graded history,
decide whether any setup warrants issuing a flag. You must PASS most of the time.

Return JSON: { "flags": [...], "pass_reason": string|null }.
Each flag: { option_symbol, direction, tags[], thesis, invalidation, horizon_hours, target_price, score }.
Max 3 flags per wakeup. Score 60-100. Every flag needs thesis + invalidation + horizon.`;

const DEFAULT_COOLDOWN_MIN = 15;
const DEFAULT_WAKEUP_THRESHOLD = 60;
const DEFAULT_MAX_FLAGS_PER_DAY = 10;
const CANDIDATE_WINDOW_MIN = 30;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConfigValue<T>(
  supabase: SupabaseClient,
  key: string,
  fallback: T,
): Promise<T> {
  try {
    const { data, error } = await supabase.rpc('ct_config_get', { p_key: key });
    if (error || data === null || data === undefined) return fallback;
    return data as T;
  } catch {
    return fallback;
  }
}

function stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
}

function parseClaudeVerdict(raw: string): ClaudeVerdict | { error: string } {
  const body = stripFences(raw).trim();
  if (!body) return { error: 'empty response' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const match = body.match(/\{[\s\S]*\}/);
    if (!match) return { error: 'no JSON found' };
    try { parsed = JSON.parse(match[0]); }
    catch { return { error: 'JSON parse failed' }; }
  }

  const p = parsed as Record<string, unknown>;
  const flagsRaw = Array.isArray(p.flags) ? p.flags : [];
  const flags: FlagDecision[] = [];

  for (const f of flagsRaw.slice(0, 3)) {
    const r = f as Record<string, unknown>;
    const direction = String(r.direction ?? '').toLowerCase();
    if (!['bullish', 'bearish', 'neutral'].includes(direction)) continue;
    const thesis = typeof r.thesis === 'string' ? r.thesis.trim() : '';
    const invalidation = typeof r.invalidation === 'string' ? r.invalidation.trim() : '';
    const horizonHours = Number(r.horizon_hours);
    if (!thesis || !invalidation || !Number.isFinite(horizonHours) || horizonHours <= 0) continue;

    const tagsRaw = Array.isArray(r.tags) ? r.tags : [];
    const tags = tagsRaw.map(t => String(t)).slice(0, 12);

    flags.push({
      option_symbol: typeof r.option_symbol === 'string' ? r.option_symbol : null,
      direction: direction as 'bullish' | 'bearish' | 'neutral',
      tags,
      thesis: thesis.slice(0, 2000),
      invalidation: invalidation.slice(0, 1000),
      horizon_hours: Math.min(720, Math.max(1, Math.round(horizonHours))),
      target_price: Number.isFinite(Number(r.target_price)) ? Number(r.target_price) : null,
      score: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
    });
  }

  return {
    flags,
    pass_reason: typeof p.pass_reason === 'string' ? p.pass_reason.slice(0, 500) : null,
  };
}

// ---------------------------------------------------------------------------
// Context loaders
// ---------------------------------------------------------------------------

async function loadCandidateEvents(
  supabase: SupabaseClient,
  ticker: string,
  wakeupThreshold: number,
  forcedEventIds?: string[],
) {
  if (forcedEventIds && forcedEventIds.length > 0) {
    const { data, error } = await supabase
      .from('ct_scored_flow')
      .select('id, ticker, option_symbol, event_ts, classification, direction, score, raw_score, score_breakdown, penalty_breakdown, strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc, iv_rank_at_event')
      .in('id', forcedEventIds);
    if (error) {
      console.warn('[specialistRunner] forced events load failed:', error.message);
      return [];
    }
    return data ?? [];
  }

  const cutoff = new Date(Date.now() - CANDIDATE_WINDOW_MIN * 60_000).toISOString();
  const { data, error } = await supabase
    .from('ct_scored_flow')
    .select('id, ticker, option_symbol, event_ts, classification, direction, score, raw_score, score_breakdown, penalty_breakdown, strike, expiry, dte, delta_est, premium, volume, open_interest, ask_side_perc, iv_rank_at_event')
    .eq('ticker', ticker)
    .gte('score', wakeupThreshold)
    .gte('event_ts', cutoff)
    .order('score', { ascending: false })
    .limit(15);
  if (error) {
    console.warn('[specialistRunner] candidate events load failed:', error.message);
    return [];
  }
  return data ?? [];
}

async function loadTickerSnapshot(supabase: SupabaseClient, ticker: string) {
  const { data } = await supabase
    .from('ct_ticker_snapshots')
    .select('ticker, spot, iv_rank, iv_percentile, gamma_flip, call_wall, put_wall, net_gamma, regime, next_earnings_date, earnings_expected_move, nope_latest, put_call_ratio')
    .eq('ticker', ticker)
    .maybeSingle();
  return data ?? null;
}

async function loadNextEarnings(supabase: SupabaseClient, ticker: string) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('ct_events')
    .select('event_type, event_date, title')
    .eq('event_type', 'earnings')
    .eq('ticker', ticker)
    .gte('event_date', today)
    .order('event_date', { ascending: true })
    .limit(1);
  return data?.[0] ?? null;
}

async function loadRecentOiBuilds(supabase: SupabaseClient, ticker: string) {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600_000).toISOString().slice(0, 10);
  const { data } = await supabase
    .from('ct_oi_snapshots')
    .select('option_symbol, strike, expiry, side, oi, oi_delta_1d, oi_delta_5d, snap_date, snap_slot')
    .eq('ticker', ticker)
    .gte('snap_date', twoDaysAgo)
    .gt('oi_delta_1d', 10000)
    .order('oi_delta_1d', { ascending: false })
    .limit(10);
  return data ?? [];
}

/**
 * Load recent news affecting this ticker from ct_breaking_news (Tavily
 * sweep + macro watcher). Last 6 hours, severity >= 2 OR tagged for this
 * ticker. News moves stocks; options front-run news — specialists need
 * to see the catalyst backdrop when proposing flags.
 */
async function loadRecentNews(supabase: SupabaseClient, ticker: string) {
  const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data } = await (supabase.from('ct_breaking_news' as never) as any)
    .select('headline,source,severity,sentiment,category,macro_wide,summary,tickers_affected,ingested_at,published_at')
    .gte('ingested_at', sixHoursAgo)
    .order('ingested_at', { ascending: false })
    .limit(50);
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  // Keep rows that mention this ticker OR are macro-wide (affect all watchlist).
  return rows
    .filter((r) => {
      const tickers = (r.tickers_affected as string[] | null) ?? [];
      return tickers.includes(ticker) || r.macro_wide === true;
    })
    .slice(0, 8)
    .map((r) => ({
      headline: r.headline,
      source: r.source,
      severity: r.severity,
      sentiment: r.sentiment,
      category: r.category,
      macro_wide: r.macro_wide,
      summary: r.summary,
      ingested_at: r.ingested_at,
    }));
}

async function loadSpecialistMemory(supabase: SupabaseClient, ticker: string) {
  // Last 10 graded flags for this specialist joined with grades. We fetch the
  // grades and pull each flag inline rather than relying on a Postgres join —
  // Supabase's implicit fk-join needs a named FK we can't guarantee yet.
  const { data: grades } = await supabase
    .from('ct_flag_grades')
    .select('flag_id, outcome, alpha_pct, price_change_pct, graded_at, notes')
    .eq('specialist_ticker', ticker)
    .order('graded_at', { ascending: false })
    .limit(10);

  if (!grades || grades.length === 0) return [];

  const flagIds = grades.map(g => g.flag_id).filter(Boolean);
  if (flagIds.length === 0) return [];

  const { data: flags } = await supabase
    .from('ct_flags')
    .select('id, direction, tags, thesis, horizon_hours, score')
    .in('id', flagIds);

  const flagMap = new Map<string, Record<string, unknown>>();
  for (const f of (flags ?? [])) {
    flagMap.set(f.id as string, f as Record<string, unknown>);
  }

  return grades.map(g => {
    const f = flagMap.get(g.flag_id as string);
    return {
      outcome: g.outcome,
      alpha_pct: g.alpha_pct,
      price_change_pct: g.price_change_pct,
      graded_at: g.graded_at,
      direction: f?.direction ?? null,
      tags: f?.tags ?? [],
      thesis_slice: typeof f?.thesis === 'string' ? (f.thesis as string).slice(0, 240) : null,
      horizon_hours: f?.horizon_hours ?? null,
      score: f?.score ?? null,
    };
  });
}

async function loadHitRateByTag(supabase: SupabaseClient, ticker: string) {
  const { data } = await supabase
    .from('ct_flag_patterns')
    .select('signature_hash, signature, n_observations, n_wins, n_partials, n_losses, hit_rate, avg_alpha_pct')
    .eq('specialist_ticker', ticker)
    .gte('n_observations', 3)
    .order('hit_rate', { ascending: false })
    .limit(10);
  return data ?? [];
}

async function isWithinCooldown(
  supabase: SupabaseClient,
  ticker: string,
  cooldownMinutes: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();
  const { data, error } = await supabase
    .from('ct_flags')
    .select('id')
    .eq('specialist_ticker', ticker)
    .gte('created_at', cutoff)
    .limit(1);
  if (error) {
    console.warn('[specialistRunner] cooldown check failed:', error.message);
    return false;
  }
  return (data?.length ?? 0) > 0;
}

async function countFlagsWrittenToday(
  supabase: SupabaseClient,
  ticker: string,
): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const { count, error } = await supabase
    .from('ct_flags')
    .select('id', { count: 'exact', head: true })
    .eq('specialist_ticker', ticker)
    .gte('created_at', startOfDay.toISOString());
  if (error) {
    console.warn('[specialistRunner] daily-cap count failed:', error.message);
    return 0;
  }
  return count ?? 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runSpecialistWakeup(
  args: SpecialistWakeupArgs,
): Promise<SpecialistWakeupResult> {
  const started = Date.now();
  const { supabase, ticker, reason, forcedEventIds } = args;

  const baseResult: Omit<SpecialistWakeupResult, 'ok'> = {
    ticker,
    reason,
    events_considered: 0,
    flags_written: 0,
    flag_ids: [],
    cost_usd: 0,
    elapsed_ms: 0,
  };

  // 1. Kill-switch.
  if (await isKillSwitchActive(supabase)) {
    return {
      ...baseResult,
      ok: false,
      skip_reason: 'kill_switch',
      elapsed_ms: Date.now() - started,
    };
  }

  // 2-4. Load per-ticker config.
  const prompt = await getConfigValue<string>(
    supabase,
    `specialist.${ticker}.prompt`,
    GENERIC_PROMPT_FALLBACK,
  );
  const wakeupThreshold = Number(await getConfigValue<number>(
    supabase,
    `specialist.${ticker}.wakeup_threshold`,
    DEFAULT_WAKEUP_THRESHOLD,
  )) || DEFAULT_WAKEUP_THRESHOLD;
  const cooldownMinutes = Number(await getConfigValue<number>(
    supabase,
    'specialist.cooldown_minutes',
    DEFAULT_COOLDOWN_MIN,
  )) || DEFAULT_COOLDOWN_MIN;
  const maxFlagsPerDay = Number(await getConfigValue<number>(
    supabase,
    `specialist.${ticker}.max_flags_per_day`,
    DEFAULT_MAX_FLAGS_PER_DAY,
  )) || DEFAULT_MAX_FLAGS_PER_DAY;

  // 5. Cooldown (skipped for manual).
  if (reason !== 'manual' && await isWithinCooldown(supabase, ticker, cooldownMinutes)) {
    return {
      ...baseResult,
      ok: true,
      skip_reason: 'cooldown',
      elapsed_ms: Date.now() - started,
    };
  }

  // 6. Candidate events.
  const events = await loadCandidateEvents(supabase, ticker, wakeupThreshold, forcedEventIds);
  baseResult.events_considered = events.length;

  if (events.length === 0) {
    return {
      ...baseResult,
      ok: true,
      skip_reason: 'no_events',
      elapsed_ms: Date.now() - started,
    };
  }

  // 13. Daily cap (checked early, before the Claude spend).
  const flagsToday = await countFlagsWrittenToday(supabase, ticker);
  if (flagsToday >= maxFlagsPerDay) {
    return {
      ...baseResult,
      ok: true,
      skip_reason: 'daily_cap',
      elapsed_ms: Date.now() - started,
    };
  }

  // 8-12. Context for Claude.
  const [snapshot, nextEarnings, oiBuilds, memory, hitRate, news] = await Promise.all([
    loadTickerSnapshot(supabase, ticker),
    loadNextEarnings(supabase, ticker),
    loadRecentOiBuilds(supabase, ticker),
    loadSpecialistMemory(supabase, ticker),
    loadHitRateByTag(supabase, ticker),
    loadRecentNews(supabase, ticker),
  ]);

  const tickerContext = {
    ticker,
    spot: snapshot?.spot ?? null,
    iv_rank: snapshot?.iv_rank ?? null,
    gamma_flip: snapshot?.gamma_flip ?? null,
    call_wall: snapshot?.call_wall ?? null,
    put_wall: snapshot?.put_wall ?? null,
    net_gamma: snapshot?.net_gamma ?? null,
    regime: snapshot?.regime ?? null,
    next_earnings_date: nextEarnings?.event_date ?? snapshot?.next_earnings_date ?? null,
    earnings_title: nextEarnings?.title ?? null,
  };

  const userPayload = `[TICKER CONTEXT]
${JSON.stringify(tickerContext, null, 2)}

[RECENT NEWS — last 6h affecting ${ticker} or macro-wide, Tavily + UW]
${JSON.stringify(news, null, 2)}

[CANDIDATE FLOW EVENTS — last ${CANDIDATE_WINDOW_MIN}min, score >= ${wakeupThreshold}]
${JSON.stringify(events, null, 2)}

[RECENT OI BUILDS — last 2 days, delta_1d > 10k]
${JSON.stringify(oiBuilds, null, 2)}

[YOUR LAST 10 GRADED FLAGS]
${JSON.stringify(memory, null, 2)}

[YOUR HIT RATE BY PATTERN SIGNATURE]
${JSON.stringify(hitRate, null, 2)}

[WAKEUP REASON] ${reason}
[FLAGS WRITTEN TODAY] ${flagsToday} / cap ${maxFlagsPerDay}

Decide: 0-3 flags OR pass cleanly. Return JSON only:
{
  "flags": [
    { "option_symbol": "...", "direction": "bullish|bearish|neutral", "tags": [...],
      "thesis": "...", "invalidation": "...", "horizon_hours": 48,
      "target_price": 185.5, "score": 72 }
  ],
  "pass_reason": null | "why you passed"
}`;

  // 14. Claude call (Haiku).
  const model = CLAUDE_MODELS.haiku;
  const claudeStart = Date.now();
  let claudeRes: Awaited<ReturnType<typeof callClaude>> | null = null;
  let responseText = '';
  try {
    claudeRes = await callClaude({
      model,
      system: prompt,
      messages: [{ role: 'user', content: userPayload }],
      max_tokens: 2000,
      temperature: 0.2,
    });
    responseText = parseTextContent(claudeRes).trim();
  } catch (e) {
    const detail = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
    console.error(`[specialistRunner] ${ticker} Claude call failed:`, detail);
    return {
      ...baseResult,
      ok: false,
      skip_reason: 'claude_error',
      error: detail.slice(0, 400),
      elapsed_ms: Date.now() - started,
    };
  }

  // Cost logging — fire-and-forget.
  const usage = claudeRes?.usage ?? null;
  const tokensIn = usage?.input_tokens ?? 0;
  const tokensOut = usage?.output_tokens ?? 0;
  const costUsd = Number((((tokensIn / 1_000_000) * 0.80) + ((tokensOut / 1_000_000) * 4.0)).toFixed(6));
  logClaudeUsage(supabase, {
    source: `ct-specialist-${ticker}`,
    model,
    usage,
    duration_ms: Date.now() - claudeStart,
    metadata: { reason, events_considered: events.length },
  });

  baseResult.cost_usd = costUsd;

  // 15. Parse.
  const parsed = parseClaudeVerdict(responseText);
  if ('error' in parsed) {
    console.warn(`[specialistRunner] ${ticker} parse error:`, parsed.error, 'raw:', responseText.slice(0, 400));
    return {
      ...baseResult,
      ok: false,
      skip_reason: 'parse_error',
      error: parsed.error,
      elapsed_ms: Date.now() - started,
    };
  }

  // 16. Insert flags.
  // ct_scored_flow.id is bigint; ct_flags.source_flow_ids is BIGINT[] (retyped
  // in migration 20260423000035). Keep numeric — don't coerce to string.
  const sourceFlowIds = events
    .map(e => (typeof e.id === 'number' ? e.id : Number(e.id)))
    .filter(n => Number.isFinite(n)) as number[];
  const topEvent = events[0];
  const entryPrice = snapshot?.spot ?? null;

  const writtenIds: string[] = [];

  if (parsed.flags.length === 0) {
    // Clean pass — journal it and return.
    await recordDecision(supabase, {
      decision_type: 'no_trade',
      model_tier: 'haiku',
      reasoning: `specialist.${ticker} wakeup: ${parsed.pass_reason ?? 'no pass_reason given'}`,
      outcome: 'no_flag',
      context_snapshot: {
        ticker,
        reason,
        events_considered: events.length,
        wakeup_threshold: wakeupThreshold,
      },
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    });
    return {
      ...baseResult,
      ok: true,
      skip_reason: 'passed',
      elapsed_ms: Date.now() - started,
    };
  }

  for (const decision of parsed.flags) {
    // Flag score: Claude's self-assigned score wins, else top event's score,
    // else average of the event scores. Clamped to [0,100].
    let score = typeof decision.score === 'number' && Number.isFinite(decision.score)
      ? decision.score
      : (typeof topEvent?.score === 'number' ? Number(topEvent.score) : 0);
    const avgEventScore = events.length > 0
      ? events.reduce((acc, e) => acc + (Number(e.score) || 0), 0) / events.length
      : 0;
    if (!score || score <= 0) score = avgEventScore;
    score = Math.max(0, Math.min(100, Math.round(score)));

    // Direction → option side mapping (for reference, not enforced — Claude
    // may flag a put ticket on a bearish thesis).
    const scoreBreakdown = topEvent?.score_breakdown ?? null;

    // Parse option_symbol → strike + expiry + side if matches OCC pattern.
    const occMatch = decision.option_symbol?.match(/^([A-Z.]+)(\d{6})([CP])(\d{8})$/);
    let strike: number | null = null;
    let expiry: string | null = null;
    let side: 'call' | 'put' | null = null;
    if (occMatch) {
      const yy = occMatch[2].slice(0, 2);
      const mm = occMatch[2].slice(2, 4);
      const dd = occMatch[2].slice(4, 6);
      expiry = `20${yy}-${mm}-${dd}`;
      side = occMatch[3] === 'C' ? 'call' : 'put';
      strike = Number(occMatch[4]) / 1000;
    }

    const row = {
      specialist_ticker: ticker,
      instrument: ticker,
      option_symbol: decision.option_symbol ?? null,
      strike,
      expiry,
      side,
      direction: decision.direction,
      score,
      score_breakdown: scoreBreakdown,
      tags: decision.tags,
      thesis: decision.thesis,
      invalidation: decision.invalidation,
      horizon_hours: decision.horizon_hours,
      entry_price: entryPrice,
      target_price: decision.target_price,
      status: 'active',
      source_flow_ids: sourceFlowIds.length > 0 ? sourceFlowIds : null,
    };

    const { data: inserted, error: insErr } = await supabase
      .from('ct_flags')
      .insert(row)
      .select('id')
      .single();

    if (insErr || !inserted) {
      console.error(`[specialistRunner] ${ticker} flag insert failed:`, insErr?.message);
      continue;
    }
    const flagId = inserted.id as string;
    writtenIds.push(flagId);

    // Journal one decision per flag. Note: we do NOT set linked_trade_idea_id
    // — that column's FK still points at the legacy ct_trade_ideas table, not
    // v2 ct_flags. Flag ID is preserved in outcome + context_snapshot.
    await recordDecision(supabase, {
      decision_type: 'arm_trade_idea',
      model_tier: 'haiku',
      reasoning: decision.thesis,
      outcome: `flag:${flagId}`,
      context_snapshot: {
        ticker,
        reason,
        flag_id: flagId,
        events_considered: events.length,
        wakeup_threshold: wakeupThreshold,
        score,
        direction: decision.direction,
        tags: decision.tags,
        horizon_hours: decision.horizon_hours,
      },
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    });
  }

  return {
    ok: true,
    ticker,
    reason,
    events_considered: events.length,
    flags_written: writtenIds.length,
    flag_ids: writtenIds,
    cost_usd: costUsd,
    elapsed_ms: Date.now() - started,
  };
}
