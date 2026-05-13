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
import { addTradingHours } from './marketClock.ts';
import { fetchSignatureEdgeForTicker } from './signatureMemory.ts';
import {
  loadDteEligibility,
  ticker0DteEligibleOn,
  nextEligible0DteDate,
  nextFridayOn,
} from './dteEligibility.ts';
import { readPulseContext } from './pulseContext.ts';
import { getTemporalContext, tagIsoTimestamp } from './temporalContext.ts';
import { validateTemporalCoherence } from './temporalValidator.ts';
import { validateTickerCoherence } from './tickerCoherenceValidator.ts';
import { buildClaudeContext } from './claudeReadSurface.ts';
import { voyageEmbed } from './ctEmbed.ts';
import type {
  FlowHeatmapResult,
} from './flowHeatmapContext.ts';
import type { TapeContextResult } from './tapeContext.ts';
import type { DetectorContextResult } from './detectorContext.ts';
import type { NewsCausalityResult, NewsItem } from './newsCausalityContext.ts';
import type { SpecialistRecallResult, RecallEntry, RecallStats } from './specialistRecallContext.ts';

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
  invalidation_price?: number | null;
  horizon_hours: number;
  target_price?: number | null;
  score?: number | null;
  source_flow_ids?: string[];
}

interface CurrentRead {
  direction_lean: 'bullish' | 'bearish' | 'neutral' | 'mixed';
  conviction: number;
  read_text: string;
}

interface ClaudeVerdict {
  flags: FlagDecision[];
  pass_reason?: string | null;
  current_read: CurrentRead | null;
  current_read_failure?: string | null;
}

const GENERIC_PROMPT_FALLBACK = `You are a per-ticker options-flow specialist in Co-Trader v2.
Your job: given recent scored flow events on this ticker plus your own graded history,
decide whether any setup warrants issuing a flag. You must PASS most of the time.

Return JSON: { "flags": [...], "pass_reason": string|null }.
Each flag: { option_symbol, direction, tags[], thesis, invalidation, horizon_hours, target_price, score }.
Max 3 flags per wakeup. Score 60-100. Every flag needs thesis + invalidation + horizon.`;

// Appended to every specialist's system prompt — cross-facet reasoning
// contract. Keeps per-ticker config portable while guaranteeing all
// specialists reason against the three new anchors.
const CROSS_FACET_PROMPT_SUFFIX = `

You now see three cross-facet signals:
- TAPE-READER'S CURRENT READ: the floor-level macro narrative. Use as macro anchor.
- YOUR TICKER'S LEAN SCORE: your ticker's composite direction. Flag direction should align OR you must justify contrarian.
- PEER SPECIALIST FLAGS: what your siblings just did. If peers are heavily bearish and you're bullish, say why.

Your job is still ticker-specific, but you must reason against these anchors before firing.

In addition to \`flags\` and \`pass_reason\`, you MUST return a \`current_read\` object on every wakeup:
  {
    "direction_lean": "bullish" | "bearish" | "neutral" | "mixed",
    "conviction": 0-100 ("how close were you to writing a flag — 0=quiet day, 100=you DID flag"),
    "read_text": "2-3 sentences describing what the ticker is doing right now, what you'd need to see to flag, and your current confidence."
  }
This read surfaces on the ticker card even when you pass. It's your running commentary — make it specific and actionable.`;

const DEFAULT_COOLDOWN_MIN = 15;
const DEFAULT_WAKEUP_THRESHOLD = 60;
const DEFAULT_MAX_FLAGS_PER_DAY = 10;
const CANDIDATE_WINDOW_MIN = 30;

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/**
 * Build the SYSTEM CONTEXT line prepended to every specialist prompt.
 * Tells the specialist what calendar day it is and whether 0DTE is even
 * a possibility for this ticker today. Without it, NVDA on a Tuesday will
 * happily theorize about 0DTE plays that can't structurally exist.
 */

// ---------------------------------------------------------------------------
// formatRecallBlock — render the recall organ as a compact, structured
// system-prompt block. Three-state outcome rendering per the build spec:
//   → win/loss/partial      flagged + graded
//   → pending               flagged + not yet graded
//   —                       unflagged
// Visually distinct so the specialist does not mis-read pending as no-signal.
//
// Format choices (locked in):
//   - structured fields only — NO read_text excerpt (Claude's own past prose,
//     don't pay tokens to re-inject it).
//   - explicit anti-streak-bias clause — the recall is provenance, not a
//     directional driver. lean must come from current flow, not from streak.
//   - relative timestamps for compactness ("4h ago", "2d ago") — the absolute
//     ts is in `ts` if Claude needs it, but compact reads better at glance.
// ---------------------------------------------------------------------------
function relativeAge(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '?';
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

function formatRecallEntry(e: RecallEntry, nowMs: number): string {
  const age = relativeAge(e.ts, nowMs).padEnd(8, ' ');
  const lean = (e.direction_lean ?? 'unknown').padEnd(7, ' ');
  const conviction = e.conviction == null ? '--' : String(e.conviction).padStart(2, ' ');
  if (!e.flagged) {
    return `- ${age} ${lean} ${conviction} —`;
  }
  const label = e.flag_label ?? 'flag';
  if (e.outcome === 'pending') {
    return `- ${age} ${lean} ${conviction} · ${label} → pending`;
  }
  const alphaStr = e.alpha_pct == null
    ? ''
    : ` alpha ${e.alpha_pct >= 0 ? '+' : ''}${e.alpha_pct.toFixed(2)}%`;
  return `- ${age} ${lean} ${conviction} · ${label} → ${e.outcome}${alphaStr}`;
}

function pct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  return `${Math.round(v * 100)}%`;
}

function formatStatsLine(stats: RecallStats): string {
  if (stats.flagged_total === 0) {
    return 'Stats: 0 flagged · no track record yet.';
  }
  const hr = stats.hit_rate_when_graded == null
    ? 'n/a'
    : `${Math.round(stats.hit_rate_when_graded * 100)}%`;
  const streak = stats.current_streak_kind === 'none'
    ? 'none'
    : `${stats.current_streak_kind} ×${stats.current_streak_length}`;
  return (
    `Stats: ${stats.flagged_total} flagged ` +
    `(${stats.flagged_graded} graded, ${stats.flagged_pending} pending) ` +
    `· hit-rate when graded: ${hr} · current streak: ${streak}`
  );
}

/**
 * v2 enrichment lines for the recall block. Terse — Claude consumers don't
 * need essays. Each block is one line; missing sources are omitted (no fake
 * "n/a" rows). Returns [] when no v2 fields populated.
 */
function formatV2EnrichmentLines(stats: RecallStats): string[] {
  const lines: string[] = [];

  const ma = stats.multi_axis_stats;
  if (ma) {
    lines.push(
      `Multi-axis: premium ${pct(ma.hit_rate_premium)} / 4h ${pct(ma.hit_rate_underlying_4h)} / 1d ${pct(ma.hit_rate_underlying_1d)} / 3d ${pct(ma.hit_rate_underlying_3d)} / blended ${pct(ma.hit_rate_blended)} (n=${ma.n_graded} graded)`,
    );
    if (ma.drift_slope_7d != null && Number.isFinite(ma.drift_slope_7d)) {
      const sign = ma.drift_slope_7d >= 0 ? '+' : '';
      lines.push(`Drift ${sign}${ma.drift_slope_7d.toFixed(1)}pp/wk over 30d`);
    }
  }

  if (stats.regime_conditional && stats.regime_conditional.length > 0) {
    const parts = stats.regime_conditional.map(
      (r) => `${r.regime} ${pct(r.hit_rate_blended)} (n=${r.n_graded})`,
    );
    lines.push(`Regime-cond: ${parts.join(', ')}`);
  }

  if (stats.conviction_calibration_curve && stats.conviction_calibration_curve.length > 0) {
    const parts = stats.conviction_calibration_curve.map(
      (c) => `${c.bucket} ${pct(c.hit_rate)} (${c.is_per_specialist ? 'per' : 'cross'})`,
    );
    lines.push(`Conviction: ${parts.join(', ')}`);
  }

  const lc = stats.lifecycle;
  if (lc) {
    lines.push(`Lifecycle: ${lc.prompt_version} ${lc.status.toUpperCase()} · current ${pct(lc.hit_rate_current)}`);
  }

  return lines;
}

function formatRecallBlock(ticker: string, recall: SpecialistRecallResult): string {
  if (recall.reads.length === 0) {
    return `[YOUR LAST READS ON ${ticker}]\n(no prior reads in window — fresh ticker or fresh week.)\n\n`;
  }
  const nowMs = Date.now();
  const lines = recall.reads.map((e) => formatRecallEntry(e, nowMs));
  const v2Lines = formatV2EnrichmentLines(recall.stats);
  return [
    `[YOUR LAST READS ON ${ticker} — facts. Quote verbatim if referenced; do not restate with different numbers.`,
    `STREAK IS PROVENANCE, NOT SIGNAL. If you have been bearish 3 fires in a row, that does not make this fire bearish — let current flow + state drive lean. Streak only tells you to inspect whether you are right or are repeating yourself.]`,
    formatStatsLine(recall.stats),
    ...v2Lines,
    '',
    ...lines,
    '',
  ].join('\n') + '\n';
}

async function buildSystemContextHeader(
  supabase: SupabaseClient,
  ticker: string,
  now: Date,
): Promise<string> {
  const eligibility = await loadDteEligibility(supabase);
  const cfg = eligibility[ticker];
  const dayName = DAY_NAMES[now.getUTCDay()];
  const dateStr = now.toISOString().slice(0, 10);

  if (!cfg) {
    return `SYSTEM CONTEXT: Today is ${dayName} (${dateStr}). No 0DTE eligibility config for ${ticker} — treat any 0DTE flag as suspect.`;
  }

  const eligible = ticker0DteEligibleOn(ticker, eligibility, now);
  const label = cfg.label;

  if (eligible) {
    return `SYSTEM CONTEXT: Today is ${dayName} (${dateStr}). Your ticker ${ticker} 0DTE eligibility today: ${label}. 0DTE eligible — daily expiry available.`;
  }

  // Not eligible — point Claude at the next tradable date.
  const nextElig = nextEligible0DteDate(ticker, eligibility, now);
  if (nextElig) {
    const nextStr = nextElig.toISOString().slice(0, 10);
    return `SYSTEM CONTEXT: Today is ${dayName} (${dateStr}). Your ticker ${ticker} 0DTE eligibility today: ${label}. 0DTE flags from you today must be REJECTED — earliest tradable 0DTE for ${ticker} is Friday ${nextStr}.`;
  }

  // Never eligible — point at next Friday weekly expiry instead.
  const fri = nextFridayOn(now).toISOString().slice(0, 10);
  return `SYSTEM CONTEXT: Today is ${dayName} (${dateStr}). Your ticker ${ticker} 0DTE eligibility today: ${label}. 0DTE flags from you must be REJECTED — ${ticker} is weekly minimum, earliest expiry is Friday ${fri}.`;
}

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

/**
 * Load the active prompt for a specialist via the new versioned
 * ct_specialist_prompts table. Falls back to legacy ct_config row on miss
 * so the table migration is non-breaking. See migration
 * 20260424000064_specialist_prompts_table.sql.
 */
async function loadSpecialistPrompt(
  supabase: SupabaseClient,
  ticker: string,
): Promise<string> {
  // Primary: versioned prompts table.
  try {
    const { data, error } = await supabase.rpc('ct_specialist_prompt_active', {
      p_ticker: ticker,
    });
    if (!error && typeof data === 'string' && data.trim().length > 0) {
      return data;
    }
  } catch (e) {
    console.warn(`[specialistRunner] ${ticker} active-prompt RPC threw:`, String(e));
  }

  // Fallback: legacy ct_config row (one-cycle backwards compat).
  try {
    const legacy = await getConfigValue<string>(
      supabase,
      `specialist.${ticker}.prompt`,
      '',
    );
    if (legacy && legacy.trim().length > 0) {
      console.warn(`[specialistRunner] ${ticker} using legacy ct_config prompt — migrate to ct_specialist_prompts`);
      return legacy;
    }
  } catch (e) {
    console.warn(`[specialistRunner] ${ticker} legacy prompt fetch threw:`, String(e));
  }

  console.warn(`[specialistRunner] ${ticker} no prompt found — using generic fallback`);
  return GENERIC_PROMPT_FALLBACK;
}

/**
 * Build the bias-audit context block: the specialist's last 5 flags with
 * direction + outcome counts. Injected so the prompt's "BIAS AUDIT" section
 * has something concrete to reason against. Returns a formatted string;
 * empty means no prior flags.
 */
async function loadLast5FlagsContext(
  supabase: SupabaseClient,
  ticker: string,
): Promise<string> {
  try {
    const { data: flags, error: flagsErr } = await supabase
      .from('ct_flags')
      .select('id, direction, score, thesis, created_at')
      .eq('specialist_ticker', ticker)
      .order('created_at', { ascending: false })
      .limit(5);
    if (flagsErr) {
      console.warn(`[specialistRunner] ${ticker} last-5 flags load failed:`, flagsErr.message);
      return `[YOUR LAST 5 FLAGS — none yet OR load failed]`;
    }
    const flagRows = (flags ?? []) as Array<Record<string, unknown>>;
    if (flagRows.length === 0) {
      return `[YOUR LAST 5 FLAGS — none yet for ${ticker}; no bias-audit baseline]`;
    }

    const flagIds = flagRows.map(f => f.id as string).filter(Boolean);
    const { data: grades } = await supabase
      .from('ct_flag_grades')
      .select('flag_id, outcome')
      .in('flag_id', flagIds);
    const gradeByFlagId = new Map<string, string>();
    for (const g of (grades ?? [])) {
      gradeByFlagId.set(g.flag_id as string, g.outcome as string);
    }

    let bullCount = 0, bearCount = 0, neutCount = 0;
    let bullW = 0, bullL = 0, bullPending = 0;
    let bearW = 0, bearL = 0, bearPending = 0;

    const lines: string[] = [];
    for (const f of flagRows) {
      const dir = String(f.direction ?? '');
      const fid = f.id as string;
      const outcome = gradeByFlagId.get(fid) ?? 'pending';
      const dt = String(f.created_at ?? '').slice(0, 16).replace('T', ' ');

      if (dir === 'bullish') {
        bullCount++;
        if (outcome === 'win' || outcome === 'partial') bullW++;
        else if (outcome === 'loss' || outcome === 'invalidated_early') bullL++;
        else bullPending++;
      } else if (dir === 'bearish') {
        bearCount++;
        if (outcome === 'win' || outcome === 'partial') bearW++;
        else if (outcome === 'loss' || outcome === 'invalidated_early') bearL++;
        else bearPending++;
      } else {
        neutCount++;
      }

      lines.push(`  ${dt} UTC · ${dir} · score ${f.score ?? '?'} · ${outcome}`);
    }

    const summary =
      `${bullCount} bullish (${bullW}W/${bullL}L/${bullPending}pending) · ` +
      `${bearCount} bearish (${bearW}W/${bearL}L/${bearPending}pending)` +
      (neutCount > 0 ? ` · ${neutCount} neutral` : '');

    return [
      `[YOUR LAST 5 FLAGS — bias-audit baseline]`,
      `Direction split: ${summary}`,
      `Most recent first:`,
      ...lines,
      `(If your last 5 are all one direction with no wins, ask: am I seeing flow that justifies this OR defaulting? Articulate the difference or pass.)`,
    ].join('\n');
  } catch (e) {
    console.warn(`[specialistRunner] ${ticker} last-5 context build threw:`, String(e));
    return `[YOUR LAST 5 FLAGS — load error, bias-audit baseline unavailable]`;
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

    const invalidationPriceRaw = Number(r.invalidation_price);
    const invalidationPrice = Number.isFinite(invalidationPriceRaw) && invalidationPriceRaw > 0
      ? invalidationPriceRaw
      : null;

    flags.push({
      option_symbol: typeof r.option_symbol === 'string' ? r.option_symbol : null,
      direction: direction as 'bullish' | 'bearish' | 'neutral',
      tags,
      thesis: thesis.slice(0, 2000),
      invalidation: invalidation.slice(0, 1000),
      invalidation_price: invalidationPrice,
      horizon_hours: Math.min(720, Math.max(1, Math.round(horizonHours))),
      target_price: Number.isFinite(Number(r.target_price)) ? Number(r.target_price) : null,
      score: Number.isFinite(Number(r.score)) ? Number(r.score) : null,
    });
  }

  // Parse current_read. Missing or malformed → null + failure reason captured
  // for the wakeup-log diagnostic ledger (ct_specialist_wakeup_log).
  let currentRead: CurrentRead | null = null;
  let currentReadFailure: string | null = null;
  const crRaw = p.current_read as Record<string, unknown> | undefined;
  if (!crRaw) {
    currentReadFailure = 'missing';
  } else if (typeof crRaw !== 'object') {
    currentReadFailure = 'not_object';
  } else {
    const lean = String(crRaw.direction_lean ?? '').toLowerCase();
    const conv = Number(crRaw.conviction);
    const text = typeof crRaw.read_text === 'string' ? crRaw.read_text.trim() : '';
    if (!['bullish', 'bearish', 'neutral', 'mixed'].includes(lean)) {
      currentReadFailure = `invalid_lean:${lean.slice(0, 32)}`;
    } else if (!Number.isFinite(conv)) {
      currentReadFailure = `invalid_conviction:${String(crRaw.conviction).slice(0, 32)}`;
    } else if (text.length === 0) {
      currentReadFailure = 'empty_text';
    } else {
      currentRead = {
        direction_lean: lean as CurrentRead['direction_lean'],
        conviction: Math.max(0, Math.min(100, Math.round(conv))),
        read_text: text.slice(0, 2000),
      };
    }
  }

  return {
    flags,
    pass_reason: typeof p.pass_reason === 'string' ? p.pass_reason.slice(0, 500) : null,
    current_read: currentRead,
    current_read_failure: currentReadFailure,
  };
}

/** Cluster-axis rich text for ct_specialist_reads embedding (Phase 7a).
 *  Format: SPECIALIST_READ | ticker:X lean:Y conv:N flagged:b flag:f | session:YYYY-MM-DD\n<read_text>
 *  Mirrors the drainer's buildRichText so write-time and backfill paths produce
 *  identical embeddings for the same row. */
function buildSpecialistRichText(args: {
  ticker: string;
  read: CurrentRead;
  flagged: boolean;
  flagId: string | null;
  sessionDate: string;
}): string {
  const flag = args.flagId ? args.flagId.slice(0, 8) : '-';
  return [
    `SPECIALIST_READ | ticker:${args.ticker} lean:${args.read.direction_lean} conv:${args.read.conviction} flagged:${args.flagged ? 'true' : 'false'} flag:${flag} | session:${args.sessionDate}`,
    args.read.read_text ?? '',
  ].join('\n');
}

/** YYYY-MM-DD in ET (America/New_York) from a timestamptz string or Date. */
function etDateStr(ts: string | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .formatToParts(d)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value;
      return acc;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function writeSpecialistRead(
  supabase: SupabaseClient,
  args: {
    ticker: string;
    read: CurrentRead;
    flagged: boolean;
    flagId: string | null;
    sourceFlowIds: number[];
  },
): Promise<void> {
  try {
    const { data, error } = await supabase
      .from('ct_specialist_reads')
      .insert({
        ticker: args.ticker,
        direction_lean: args.read.direction_lean,
        conviction: args.read.conviction,
        read_text: args.read.read_text,
        flagged: args.flagged,
        flag_id: args.flagId,
        source_flow_ids: args.sourceFlowIds.length > 0 ? args.sourceFlowIds : null,
      })
      .select('id, updated_at')
      .single();
    if (error || !data) {
      console.warn(`[specialistRunner] ${args.ticker} current_read write failed:`, error?.message);
      return;
    }

    // Fire-and-forget embed — never block the specialist wakeup response.
    // Drainer (ct-embed-specialist-reads-rth cron) backstops failures within
    // 5 min. Tenet 26: autonomous-mode producer, autonomous-mode embed.
    (async () => {
      try {
        const sessionDate = etDateStr(data.updated_at);
        const richText = buildSpecialistRichText({
          ticker: args.ticker,
          read: args.read,
          flagged: args.flagged,
          flagId: args.flagId,
          sessionDate,
        });
        const embedding = await voyageEmbed(richText, 'document');
        const { error: updateErr } = await supabase
          .from('ct_specialist_reads')
          .update({
            embedding: embedding as unknown as string,
            rich_text: richText,
          })
          .eq('id', data.id);
        if (updateErr) {
          console.warn(`[specialistRunner] ${args.ticker} embed UPDATE failed (drainer will retry):`, updateErr.message);
        }
      } catch (e) {
        console.warn(`[specialistRunner] ${args.ticker} embed threw (drainer will retry):`, String(e));
      }
    })();
  } catch (e) {
    console.warn(`[specialistRunner] ${args.ticker} current_read write threw:`, String(e));
  }
}

// Diagnostic ledger captured per wakeup. Best-effort write — never throws.
// Born from 2026-05-05 NVDA 4-day silent freeze. Closes the silent-failure
// observability gap (writeSpecialistRead errors were console.warn-only).
interface WakeupDiag {
  parse_ok: boolean | null;
  current_read_present: boolean | null;
  current_read_failure: string | null;
  claude_output_preview: string | null;
}

async function logWakeup(
  supabase: SupabaseClient,
  args: {
    ticker: string;
    reason: string;
    result: SpecialistWakeupResult;
    diag: WakeupDiag;
  },
): Promise<void> {
  try {
    await supabase.from('ct_specialist_wakeup_log').insert({
      ticker: args.ticker,
      reason: args.reason,
      skip_reason: args.result.skip_reason ?? null,
      events_considered: args.result.events_considered,
      flags_written: args.result.flags_written,
      parse_ok: args.diag.parse_ok,
      current_read_present: args.diag.current_read_present,
      current_read_failure: args.diag.current_read_failure,
      claude_output_preview: args.diag.claude_output_preview,
      cost_usd: args.result.cost_usd,
      elapsed_ms: args.result.elapsed_ms,
      error: args.result.error ?? null,
    });
  } catch (e) {
    // Never let logging failure break the wakeup.
    console.warn(`[specialistRunner] ${args.ticker} wakeup_log write threw:`, String(e));
  }
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
 * Load aggregate directional imbalance for this ticker via the ct_flow_pulse
 * RPC. 6h window (RTH session) with 30d baseline deviation — shows the
 * specialist the REGIME, not just individual prints. Unusual skew (2x or
 * 0.5x baseline) is one of the strongest floor-level signals.
 */
async function loadFlowPulse(supabase: SupabaseClient, ticker: string) {
  const { data, error } = await supabase.rpc('ct_flow_pulse', {
    p_window_min: 360,
    p_ticker: ticker,
  });
  if (error) {
    console.warn(`[specialistRunner] ${ticker} flow pulse load failed:`, error.message);
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return (row ?? null) as Record<string, unknown> | null;
}

function formatFlowPulseBlock(ticker: string, row: Record<string, unknown> | null): string {
  if (!row) {
    return `[FLOW PULSE — no directional flow detected in 6h window]`;
  }
  const calls = Number(row.calls_count ?? 0);
  const puts = Number(row.puts_count ?? 0);
  if (calls === 0 && puts === 0) {
    return `[FLOW PULSE — no directional flow detected in 6h window]`;
  }
  const callsOtm = Number(row.calls_otm_count ?? 0);
  const callsItm = Number(row.calls_itm_count ?? 0);
  const putsOtm = Number(row.puts_otm_count ?? 0);
  const putsItm = Number(row.puts_itm_count ?? 0);
  const callsPrem = Number(row.calls_premium ?? 0);
  const putsPrem = Number(row.puts_premium ?? 0);
  const ratio = Number(row.call_put_ratio ?? 0);
  const baseline = row.cp_ratio_baseline_30d === null || row.cp_ratio_baseline_30d === undefined
    ? null
    : Number(row.cp_ratio_baseline_30d);
  const deviation = row.cp_ratio_deviation === null || row.cp_ratio_deviation === undefined
    ? null
    : Number(row.cp_ratio_deviation);
  const premNet = Number(row.premium_net ?? 0);
  const isUnusual = row.is_unusual === true;

  const callsPremM = (callsPrem / 1e6).toFixed(1);
  const putsPremM = (putsPrem / 1e6).toFixed(1);
  const premNetM = (premNet / 1e6);
  const premNetStr = `${premNetM >= 0 ? '+' : ''}${premNetM.toFixed(1)}M`;
  const leanStr = premNetM >= 0 ? 'bullish' : 'bearish';
  const baselineStr = baseline !== null && Number.isFinite(baseline)
    ? `30d baseline ${baseline.toFixed(2)}x`
    : `30d baseline n/a`;
  const deviationStr = deviation !== null && Number.isFinite(deviation)
    ? `${deviation.toFixed(1)}x today`
    : `deviation n/a`;
  const unusualStr = isUnusual
    ? '⚠ UNUSUAL direction skew vs 30d baseline'
    : 'within normal range';

  return [
    `[FLOW PULSE — current ${ticker} directional imbalance, 6h window]`,
    `  Calls: ${calls} prints ($${callsPremM}M) — ${callsOtm} OTM / ${callsItm} ITM`,
    `  Puts:  ${puts} prints ($${putsPremM}M) — ${putsOtm} OTM / ${putsItm} ITM`,
    `  Call:Put ratio = ${ratio.toFixed(2)}x  (${baselineStr} — ${deviationStr})`,
    `  Net premium bias = ${premNetStr} (${leanStr} lean)`,
    `  ${unusualStr}`,
  ].join('\n');
}

/**
 * Load the top overnight OI shifts for this ticker via the ct_top_oi_shifts
 * RPC. Returns the biggest |oi_delta_1d| contracts between yesterday's
 * close and this morning's open, with dollars-at-risk and distance-from-spot.
 * Academic consensus (Lakonishok et al., Augustin et al.): positions held
 * overnight cost margin and reveal conviction in a way intraday flow cannot.
 */
async function loadOvernightPositioning(supabase: SupabaseClient, ticker: string) {
  const { data, error } = await supabase.rpc('ct_top_oi_shifts', {
    p_limit: 10,
    p_ticker: ticker,
  });
  if (error) {
    console.warn(`[specialistRunner] ${ticker} overnight positioning load failed:`, error.message);
    return [];
  }
  return (data ?? []) as Array<Record<string, unknown>>;
}

function formatOvernightPositioningBlock(ticker: string, rows: Array<Record<string, unknown>>): string {
  if (!rows || rows.length === 0) {
    return `[OVERNIGHT POSITIONING — no significant OI shifts detected overnight in ${ticker}]`;
  }
  const lines: string[] = [];
  for (const r of rows) {
    const sideRaw = String(r.side ?? '').toUpperCase();
    const sideCode = sideRaw.startsWith('C') ? 'C' : sideRaw.startsWith('P') ? 'P' : '?';
    const strike = Number(r.strike ?? 0);
    const expiry = String(r.expiry ?? '');
    const expiryShort = expiry.length >= 10 ? expiry.slice(5) : expiry; // MM-DD
    const delta = Number(r.delta_contracts ?? 0);
    const deltaSign = delta > 0 ? `+${delta.toLocaleString()}` : delta.toLocaleString();
    const dollars = Number(r.dollars_at_risk ?? 0);
    const dollarsM = (dollars / 1e6).toFixed(1);
    const distPct = Number(r.distance_from_spot_pct ?? 0);
    const distSign = distPct >= 0 ? `+${distPct.toFixed(1)}` : distPct.toFixed(1);
    lines.push(
      `  - ${sideCode} ${strike} ${expiryShort}: ${deltaSign} OI ($${dollarsM}M, ${distSign}% from spot)`,
    );
  }
  return [
    `[OVERNIGHT POSITIONING — what actually positioned in ${ticker} between yesterday's close and this morning's open]`,
    `Top OI shifts (|Δ1d|):`,
    ...lines,
    `(If delta_contracts > 0 and side=C, that's bullish accumulation. Side=P with +delta is bearish accumulation. Negative delta = unwind.)`,
  ].join('\n');
}

function relTimeFromNow(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'unknown';
  const diffMin = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const h = Math.floor(diffMin / 60);
  const m = diffMin % 60;
  return m === 0 ? `${h}h ago` : `${h}h${m}m ago`;
}

/**
 * Format the `tape` brain organ output as the TAPE-READER block. Replaces the
 * pre-Phase-4 inline loadTapeReaderReads + formatTapeReaderBlock pair. Reads
 * latest + prior commentary (organ default cap = 3 prior).
 */
function formatTapeReaderBlock(tape: TapeContextResult | null): string {
  if (!tape || (!tape.latest && tape.prior.length === 0)) {
    return `[TAPE-READER'S CURRENT READ — no commentary yet this session]`;
  }
  const lines: string[] = [`[TAPE-READER'S CURRENT READ — what the floor-level reader just said]`];
  const rows = [
    ...(tape.latest ? [tape.latest] : []),
    ...tape.prior.slice(0, 1), // keep the same 2-row footprint as the legacy path
  ];
  rows.forEach((r, i) => {
    const rel = relTimeFromNow(r.created_at);
    const tide = r.market_tide ?? 'n/a';
    const vix = r.vix_level == null ? 'n/a' : Number(r.vix_level).toFixed(1);
    const commentary = (r.commentary ?? '').slice(0, 600);
    const prefix = i === 0 ? rel : `${rel} earlier`;
    lines.push(`${prefix} (market_tide=${tide}, VIX ${vix}): ${commentary}`);
  });
  return lines.join('\n');
}

/**
 * Format peer specialists' flags from the `detector` brain organ. Filters to
 * other tickers' detector-flag activity in the lookback window. Replaces the
 * pre-Phase-4 inline loadPeerFlags + formatPeerFlagsBlock pair.
 */
function formatPeerFlagsBlockFromDetector(
  ticker: string,
  detector: DetectorContextResult | null,
): string {
  const flags = detector?.flags ?? [];
  // The detector organ is invoked WITHOUT tickerFocus (we want cross-book
  // visibility) — filter out this specialist's own ticker here.
  const peers = flags
    .filter((f) => (f.ticker ?? '').toUpperCase() !== ticker.toUpperCase())
    .slice(0, 10);
  if (peers.length === 0) {
    return `[PEER SPECIALIST FLAGS — no peer flags in last 60 min]`;
  }
  const lines: string[] = [`[PEER SPECIALIST FLAGS — other tickers last 60 min]`];
  for (const f of peers) {
    const tk = f.ticker ?? '?';
    const dir = f.direction ?? '?';
    const score = f.score == null ? '?' : String(f.score);
    const thesisShort = (f.thesis ?? '').slice(0, 80);
    lines.push(`  ${tk} ${dir} ${score}: ${thesisShort}`);
  }
  lines.push(`(If peers are heavily one-direction today, note whether your read aligns or diverges and why.)`);
  return lines.join('\n');
}

/**
 * Load recent signature alarms fired by ct-signature-watcher for this ticker.
 * 30-min window matches signature_alarm_dedupe_min default — captures freshest
 * patterns without stale clutter. Closes the cross-feedback loop: system
 * pattern detection feeds specialist judgment on the next wakeup.
 */
async function loadRecentSignatureAlarms(supabase: SupabaseClient, ticker: string) {
  try {
    const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    // ct_flags column is `instrument`, not `ticker` — signature_alarm rows are
    // written with specialist_ticker=null and instrument=ticker.
    const { data, error } = await supabase
      .from('ct_flags')
      .select('created_at, option_symbol, direction, thesis, tags')
      .eq('source', 'signature_alarm')
      .eq('instrument', ticker)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(5);
    if (error) {
      console.warn(`[specialistRunner] ${ticker} signature alarms load failed:`, error.message);
      return [];
    }
    return (data ?? []) as Array<Record<string, unknown>>;
  } catch (e) {
    console.warn(`[specialistRunner] ${ticker} signature alarms load threw:`, String(e));
    return [];
  }
}

function formatSignatureAlarmsBlock(ticker: string, rows: Array<Record<string, unknown>>): string {
  if (!rows || rows.length === 0) {
    return `RECENT SIGNATURE ALARMS FOR ${ticker} (last 30 min): None.`;
  }
  const lines: string[] = [`RECENT SIGNATURE ALARMS FOR ${ticker} (last 30 min):`];
  for (const r of rows) {
    const tags = Array.isArray(r.tags) ? (r.tags as string[]) : [];
    let tier = '⚠️';
    if (tags.includes('gold')) tier = '🥇';
    else if (tags.includes('silver')) tier = '🥈';
    else if (tags.includes('bronze')) tier = '🥉';

    // HH:MM ET — UW + alarms produce UTC; convert with America/New_York TZ.
    const iso = String(r.created_at ?? '');
    let hhmm = '??:??';
    try {
      const d = new Date(iso);
      hhmm = d.toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch { /* keep fallback */ }

    const sym = r.option_symbol ?? 'unknown_symbol';
    const dir = String(r.direction ?? '?');
    const thesis = String(r.thesis ?? '').slice(0, 120);
    lines.push(`- ${hhmm} ET ${tier} ${sym} ${dir} — ${thesis}`);
  }
  return lines.join('\n');
}

/**
 * Load the current Lean score for this ticker — the pre-computed composite
 * over flow + walls + news + OI momentum + IV. Specialist's flag direction
 * should be consistent with this Lean OR have a thesis justifying contrarian.
 */
async function loadTickerLean(supabase: SupabaseClient, ticker: string) {
  try {
    const { data, error } = await supabase
      .from('ct_ticker_lean_score')
      .select('ticker, score, lean, confidence, momentum_delta, breakdown, score_at')
      .eq('ticker', ticker)
      .order('score_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn(`[specialistRunner] ${ticker} lean score load failed:`, error.message);
      return null;
    }
    return (data ?? null) as Record<string, unknown> | null;
  } catch (e) {
    console.warn(`[specialistRunner] ${ticker} lean score load threw:`, String(e));
    return null;
  }
}

function formatLeanScoreBlock(ticker: string, row: Record<string, unknown> | null): string {
  if (!row) {
    return `[YOUR TICKER'S LEAN SCORE — no composite score yet for ${ticker}]`;
  }
  const score = row.score === null || row.score === undefined ? 'n/a' : Number(row.score).toFixed(1);
  const lean = row.lean ?? 'n/a';
  const conf = row.confidence ?? 'n/a';
  const delta = row.momentum_delta === null || row.momentum_delta === undefined
    ? 'n/a'
    : (Number(row.momentum_delta) >= 0 ? `+${Number(row.momentum_delta).toFixed(1)}` : Number(row.momentum_delta).toFixed(1));

  // Breakdown: each key has a .contribution number.
  const b = (row.breakdown ?? {}) as Record<string, { contribution?: number | null } | null>;
  const cmp = (k: string) => {
    const v = b?.[k]?.contribution;
    return v === null || v === undefined || !Number.isFinite(Number(v)) ? 'n/a' : Number(v).toFixed(1);
  };

  return [
    `[YOUR TICKER'S LEAN SCORE — pre-computed composite (flow + walls + news + oi + iv)]`,
    `${ticker}: Lean ${score}/100 · ${lean} · confidence ${conf} · momentum ${delta} vs 3h ago`,
    `Breakdown: flow ${cmp('flow')}, specialist ${cmp('specialist')}, news ${cmp('news')}, walls ${cmp('walls')}, oi_momentum ${cmp('oi_momentum')}, iv ${cmp('iv')}`,
    `(Your flag direction should be CONSISTENT with this Lean OR have a thesis explaining why you're contrarian.)`,
  ].join('\n');
}

/**
 * Reduce the `news_causality` brain organ to the same shape the legacy inline
 * loader produced — keeps downstream prompt formatting unchanged. Combines
 * per-ticker hits with market-wide rows, capped at 8.
 */
function newsItemsForTicker(
  ticker: string,
  news: NewsCausalityResult | null,
): Array<{
  headline: string;
  source: string | null;
  severity: number;
  sentiment: string | null;
  category: string | null;
  macro_wide: boolean;
  summary: string | null;
  ingested_at: string;
}> {
  if (!news) return [];
  const tickerUpper = ticker.toUpperCase();
  const perTickerHits = news.per_ticker[tickerUpper] ?? [];
  const macroWide = news.market_wide ?? [];
  const seen = new Set<string>();
  const merged: NewsItem[] = [];
  for (const n of [...perTickerHits, ...macroWide]) {
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    merged.push(n);
    if (merged.length >= 8) break;
  }
  return merged.map((n) => ({
    headline: n.headline,
    source: n.news_source,
    severity: n.severity,
    sentiment: n.sentiment,
    category: n.category,
    macro_wide: (n.tickers_affected ?? []).length === 0 || n.tickers_affected.includes('*'),
    summary: n.summary,
    ingested_at: n.ingested_at,
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

// Public wrapper — catches every return path and writes one row to
// ct_specialist_wakeup_log. Born from 2026-05-05 NVDA silent freeze; the
// inner function's many returns previously lost their diagnostic state to
// stderr-only console.warn. This wrapper makes silent failures visible at
// the data layer (where warden + James can see them).
export async function runSpecialistWakeup(
  args: SpecialistWakeupArgs,
): Promise<SpecialistWakeupResult> {
  const diag: WakeupDiag = {
    parse_ok: null,
    current_read_present: null,
    current_read_failure: null,
    claude_output_preview: null,
  };
  let result: SpecialistWakeupResult | undefined;
  try {
    result = await runSpecialistWakeupCore(args, diag);
    return result;
  } finally {
    if (result) {
      await logWakeup(args.supabase, {
        ticker: args.ticker,
        reason: args.reason,
        result,
        diag,
      });
    }
  }
}

async function runSpecialistWakeupCore(
  args: SpecialistWakeupArgs,
  diag: WakeupDiag,
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

  // 2-4. Load per-ticker config. Prompt comes from versioned table (with
  // ct_config legacy fallback inside the loader).
  const prompt = await loadSpecialistPrompt(supabase, ticker);
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

  // Temporal anchor — every Claude consumer gets a session-date frame so
  // yesterday's news / day-name framing can't bleed into today's reasoning.
  // See _shared/temporalContext.ts. Specialists output narrative prose, so
  // the full temporalAnchorPreamble applies here.
  const tctx = getTemporalContext();

  // ---- Synthesis Phase 4 — single brain read scoped to this ticker. ------
  // Replaces five legacy inline pulls (flow heatmap, tape reader, peer-flags
  // detectors, news causality, event recency). The organs:
  //   • flow_heatmap   — positioning regime block (per-ticker stacks)
  //   • tape           — floor-level macro narrative (market-wide; tickerFocus
  //                       is ignored by the helper)
  //   • detector       — peer-flag visibility (NO tickerFocus so we see other
  //                       tickers' detector flags, then filter locally)
  //   • news_causality — recent news affecting this ticker + macro-wide
  //   • event_recency  — what just happened / today / upcoming (drives
  //                       ctx.preamble.whatJustHappened)
  //   • specialist     — peer-specialist current_reads (per-ticker uses focus
  //                       to scope to THIS ticker's last read for continuity)
  //   • pulse          — netPremium/slope regime (focused on this ticker)
  //   • james_flags    — gated to 'cotrader' audience inside the helper
  //
  // Per-ticker brain. The cross-book detector visibility uses a separate fetch
  // without tickerFocus.
  const [
    ctx,
    crossBookCtx,
    snapshot,
    nextEarnings,
    oiBuilds,
    memory,
    hitRate,
    overnight,
    flowPulse,
    leanScore,
    last5FlagsBlock,
    signatureEdgeBlock,
    signatureAlarms,
  ] = await Promise.all([
    buildClaudeContext(supabase, {
      audience: 'cotrader',
      consumerName: `ct-specialist-${ticker.toLowerCase()}`,
      tickerFocus: ticker,
      organs: ['flow_heatmap', 'specialist', 'pulse', 'tape', 'james_flags', 'news_causality', 'event_recency', 'specialist_recall'],
    }),
    // Cross-book detector visibility — no tickerFocus so we see PEER flags.
    buildClaudeContext(supabase, {
      audience: 'cotrader',
      consumerName: `ct-specialist-${ticker.toLowerCase()}/peers`,
      organs: ['detector'],
      perOrganOpts: { detector: { lookbackHours: 1, cap: 30 } },
    }),
    loadTickerSnapshot(supabase, ticker),
    loadNextEarnings(supabase, ticker),
    loadRecentOiBuilds(supabase, ticker),
    loadSpecialistMemory(supabase, ticker),
    loadHitRateByTag(supabase, ticker),
    loadOvernightPositioning(supabase, ticker),
    loadFlowPulse(supabase, ticker),
    loadTickerLean(supabase, ticker),
    loadLast5FlagsContext(supabase, ticker),
    fetchSignatureEdgeForTicker(supabase, ticker),
    loadRecentSignatureAlarms(supabase, ticker),
  ]);

  // Pull organ payloads with safe fallbacks — helpers never throw, but a
  // helper not in the requested set will be undefined.
  const flowHeatmap = (ctx.organs.flow_heatmap?.data as FlowHeatmapResult | undefined) ?? null;
  const tape = (ctx.organs.tape?.data as TapeContextResult | undefined) ?? null;
  const peerDetector = (crossBookCtx.organs.detector?.data as DetectorContextResult | undefined) ?? null;
  const newsCausality = (ctx.organs.news_causality?.data as NewsCausalityResult | undefined) ?? null;
  const news = newsItemsForTicker(ticker, newsCausality);

  const overnightBlock = formatOvernightPositioningBlock(ticker, overnight);
  const flowPulseBlock = formatFlowPulseBlock(ticker, flowPulse);
  const tapeReaderBlock = formatTapeReaderBlock(tape);
  const peerFlagsBlock = formatPeerFlagsBlockFromDetector(ticker, peerDetector);
  const leanScoreBlock = formatLeanScoreBlock(ticker, leanScore);
  const signatureAlarmsBlock = formatSignatureAlarmsBlock(ticker, signatureAlarms);

  // Flow heatmap — positioning regime block (168h decay, top 3 expiry-week
  // stacks for this ticker). Read from the brain instead of inline RPC.
  const heatmapRow = flowHeatmap?.per_ticker.find((p) => p.ticker === ticker);
  const flowHeatmapBlock = (heatmapRow && heatmapRow.stacks.length > 0)
    ? [
        `[FLOW HEATMAP — POSITIONING REGIME (168h, aggressive-directional decay)]`,
        ...heatmapRow.stacks.map((s) => `  - week ${s.expiry_bucket_week}: ${s.value >= 0 ? '+' : ''}${s.value.toFixed(0)} (n=${s.source_alert_count})`),
      ].join('\n')
    : `[FLOW HEATMAP — POSITIONING REGIME] no significant stacks for ${ticker} in 168h window`;

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

  // Pre-tag timestamp-bearing fields with relative-day labels so the model
  // never has to compute "is this today?". See _shared/temporalContext.ts.
  const taggedNews = (news ?? []).map(n => ({
    ...n,
    when: typeof n.ingested_at === 'string' ? tagIsoTimestamp(n.ingested_at, tctx.session_date) : '**UNKNOWN_TIME**',
  }));
  const taggedMemory = (memory ?? []).map(m => ({
    ...m,
    graded_at_tag: typeof m.graded_at === 'string' ? tagIsoTimestamp(m.graded_at, tctx.session_date) : null,
  }));
  const taggedOiBuilds = (oiBuilds ?? []).map(o => ({
    ...o,
    snap_date_tag: typeof o.snap_date === 'string' ? tagIsoTimestamp(`${o.snap_date}T17:00:00Z`, tctx.session_date) : null,
  }));
  const taggedEvents = (events ?? []).map(e => ({
    ...e,
    event_ts_tag: typeof e.event_ts === 'string' ? tagIsoTimestamp(e.event_ts, tctx.session_date) : null,
  }));

  // WHAT JUST HAPPENED preamble from the event_recency brain organ.
  // Structural complement to the temporal anchor: kills the "watching for
  // Powell speech today" hallucination class when the event already fired.
  const whatJustHappenedBlock = ctx.preamble.whatJustHappened?.trim()
    ? `[WHAT JUST HAPPENED — last 72h material events with outcomes]\n${ctx.preamble.whatJustHappened}`
    : `[WHAT JUST HAPPENED — no material events in the last 72h tracked by event_recency]`;

  const userPayload = `Session: ${tctx.session_date} (${tctx.session_day_name}) — now ${tctx.now_et}

${whatJustHappenedBlock}

${signatureAlarmsBlock}

${signatureEdgeBlock}

[TICKER CONTEXT]
${JSON.stringify(tickerContext, null, 2)}

${tapeReaderBlock}

${leanScoreBlock}

${flowPulseBlock}

${flowHeatmapBlock}

${overnightBlock}

${peerFlagsBlock}

${last5FlagsBlock}

[RECENT NEWS — last 6h affecting ${ticker} or macro-wide, Tavily + UW]
${JSON.stringify(taggedNews, null, 2)}

[YOUR LAST 10 GRADED FLAGS]
${JSON.stringify(taggedMemory, null, 2)}

[YOUR HIT RATE BY PATTERN SIGNATURE]
${JSON.stringify(hitRate, null, 2)}

[RECENT OI BUILDS — last 2 days, delta_1d > 10k]
${JSON.stringify(taggedOiBuilds, null, 2)}

[CANDIDATE FLOW EVENTS — last ${CANDIDATE_WINDOW_MIN}min, score >= ${wakeupThreshold}]
${JSON.stringify(taggedEvents, null, 2)}

[WAKEUP REASON] ${reason}
[FLAGS WRITTEN TODAY] ${flagsToday} / cap ${maxFlagsPerDay}

Decide: 0-3 flags OR pass cleanly. Return JSON only:
{
  "flags": [
    { "option_symbol": "...", "direction": "bullish|bearish|neutral", "tags": [...],
      "thesis": "...", "invalidation": "...", "horizon_hours": 48,
      "target_price": 185.5, "score": 72 }
  ],
  "pass_reason": null | "why you passed",
  "current_read": {
    "direction_lean": "bullish|bearish|neutral|mixed",
    "conviction": 0-100,
    "read_text": "2-3 sentences — what ${ticker} is doing now, what you'd need to flag, current confidence."
  }
}
\`current_read\` is REQUIRED on every wakeup, flag or pass.`;

  // 14. Claude call (Haiku).
  // SYSTEM CONTEXT prepended so the specialist always knows what day it is
  // and whether 0DTE is even structurally possible for this ticker today —
  // see _shared/dteEligibility.ts.
  const systemContextHeader = await buildSystemContextHeader(supabase, ticker, new Date());

  // 14a. RECALL block — first install of the per-entity self-awareness
  // property. Pulls the specialist's own last 5 flagged reads + last 5 days
  // of unflagged-with-conviction-≥50 reads on this ticker, with grades
  // joined where available. See _shared/specialistRecallContext.ts for the
  // organ definition and N-pin rationale. cotrader audience only.
  const recallOrgan = ctx.organs.specialist_recall as
    | { data: SpecialistRecallResult }
    | undefined;
  const recallBlock = recallOrgan ? formatRecallBlock(ticker, recallOrgan.data) : '';

  const model = CLAUDE_MODELS.haiku;
  const claudeStart = Date.now();
  let claudeRes: Awaited<ReturnType<typeof callClaude>> | null = null;
  let responseText = '';
  try {
    claudeRes = await callClaude({
      model,
      // Phase 4: temporal anchor sourced from the brain preamble (same string
      // contents, sourced through buildClaudeContext for unified provenance).
      // Phase B (specialist recall): recallBlock injects between system
      // context and the JSON-shape prompt — so the specialist sees its own
      // history before being asked to decide.
      system: `${ctx.preamble.temporalAnchor}\n\n${systemContextHeader}\n\n${recallBlock}${prompt}${CROSS_FACET_PROMPT_SUFFIX}`,
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
  diag.claude_output_preview = responseText.slice(0, 500);
  const parsed = parseClaudeVerdict(responseText);
  if ('error' in parsed) {
    diag.parse_ok = false;
    console.warn(`[specialistRunner] ${ticker} parse error:`, parsed.error, 'raw:', responseText.slice(0, 400));
    return {
      ...baseResult,
      ok: false,
      skip_reason: 'parse_error',
      error: parsed.error,
      elapsed_ms: Date.now() - started,
    };
  }
  diag.parse_ok = true;
  diag.current_read_present = !!parsed.current_read;
  diag.current_read_failure = parsed.current_read_failure ?? null;

  // 15b. Temporal-coherence validator (best-effort). Validates the narrative
  // strings (current_read + each flag's thesis/invalidation) against the
  // session date. Critical contradictions log + persist on every downstream
  // ct_claude_decisions.context_snapshot.temporal_validator_warnings via the
  // recordDecision call sites below. See _shared/temporalValidator.ts.
  const narrativeForValidation = [
    parsed.current_read?.read_text ?? '',
    ...parsed.flags.map(f => `${f.thesis}\n${f.invalidation}`),
  ].filter(Boolean).join('\n\n---\n\n');
  let validatorOk = true;
  let validatorContradictions: Array<{ quote: string; issue: string; severity: 'critical' | 'warning' }> = [];
  if (narrativeForValidation) {
    try {
      const validation = await validateTemporalCoherence(narrativeForValidation, tctx.session_date, { tickerContext: ticker });
      validatorOk = validation.ok;
      validatorContradictions = validation.contradictions;
      const critical = validation.contradictions.filter(c => c.severity === 'critical');
      if (critical.length > 0) {
        console.warn(
          `[specialistRunner] ${ticker} temporal validator flagged ${critical.length} CRITICAL contradiction(s) for session ${tctx.session_date}:`,
          JSON.stringify(critical),
        );
      } else if (!validation.ok && validation.contradictions.length > 0) {
        console.warn(
          `[specialistRunner] ${ticker} temporal validator flagged ${validation.contradictions.length} warning(s):`,
          JSON.stringify(validation.contradictions),
        );
      }
    } catch (e) {
      console.warn(`[specialistRunner] ${ticker} temporal validator threw (non-blocking):`, String(e));
    }
  }
  const temporalValidatorWarnings = {
    ok: validatorOk,
    session_date: tctx.session_date,
    contradiction_count: validatorContradictions.length,
    critical_count: validatorContradictions.filter(c => c.severity === 'critical').length,
    contradictions: validatorContradictions,
  };

  // 15c. Ticker-coherence validator (best-effort). Catches the data-fabrication
  // hallucination class — specialists naming tickers outside the watchlist or
  // outside the supplied context. Mirrors the ct-chat wiring (commit 54ccaaf).
  // Same persistence pattern as temporal: warnings ride along on each
  // recordDecision context_snapshot below as ticker_validator_warnings.
  // No new column needed on ct_specialist_reads — the decision journal is the
  // canonical write target for specialist post-Claude validators.
  let tickerValidatorWarnings: {
    ok: boolean;
    warning_count: number;
    warnings: Array<{ ticker?: string; quote: string; issue: string; severity: string }>;
  } = { ok: true, warning_count: 0, warnings: [] };
  if (narrativeForValidation) {
    try {
      const tcr = await validateTickerCoherence(narrativeForValidation, ctx);
      tickerValidatorWarnings = {
        ok: tcr.ok,
        warning_count: tcr.warnings.length,
        warnings: tcr.warnings.map(w => ({
          quote: w.quote,
          issue: w.issue,
          severity: w.severity,
        })),
      };
      if (!tcr.ok && tcr.warnings.length > 0) {
        console.warn(
          `[specialistRunner] ${ticker} ticker_coherence flagged ${tcr.warnings.length} off-universe mention(s):`,
          tcr.warnings.map(w => w.issue).join(' | '),
        );
      }
    } catch (e) {
      console.warn(`[specialistRunner] ${ticker} ticker_coherence threw (non-blocking):`, String(e));
    }
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
    // Clean pass — journal it, write current_read, return.
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
        flow_heatmap_per_ticker: flowHeatmap?.per_ticker ?? [],
        flow_heatmap_meta: flowHeatmap
          ? {
              generated_at: flowHeatmap.generated_at,
              lookback_hours: flowHeatmap.lookback_hours,
              math_mode: flowHeatmap.math_mode,
            }
          : null,
        brain_consumer: `ct-specialist-${ticker.toLowerCase()}`,
        brain_organs_invoked: Object.keys(ctx.organs ?? {}),
        temporal_validator_warnings: temporalValidatorWarnings,
        ticker_validator_warnings: tickerValidatorWarnings,
      },
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    });
    if (parsed.current_read) {
      await writeSpecialistRead(supabase, {
        ticker,
        read: parsed.current_read,
        flagged: false,
        flagId: null,
        sourceFlowIds,
      });
    } else {
      // Fix D fallback: write a placeholder row so freshness invariants pass
      // and the parse failure is visible at the data layer. Diagnostic detail
      // lives in ct_specialist_wakeup_log (full reason + Claude output preview).
      console.warn(`[specialistRunner] ${ticker} passed without current_read — failure=${parsed.current_read_failure}`);
      await writeSpecialistRead(supabase, {
        ticker,
        read: {
          direction_lean: 'mixed',
          conviction: 0,
          read_text: `[parse_fail: ${parsed.current_read_failure ?? 'unknown'}] ${responseText.slice(0, 400)}`,
        },
        flagged: false,
        flagId: null,
        sourceFlowIds,
      });
    }
    return {
      ...baseResult,
      ok: true,
      skip_reason: 'passed',
      elapsed_ms: Date.now() - started,
    };
  }

  // Pulse-at-fire-time — read once per wakeup; all flags from this batch
  // share the same regime context (tenet 9, 2026-04-25).
  const pulse = await readPulseContext(supabase, ticker);

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

    // horizon_ts is computed via the trading clock (skips weekends + overnight).
    // The DB trigger _ct_flags_compute_horizon_ts only fills horizon_ts when
    // NULL, so passing it explicitly here wins. Pre-clock code let calendar
    // hours count, producing flag horizons that landed Saturday with frozen
    // Friday-close spot — see migration 20260424000060 for the primitive
    // and 20260424000062 for the trigger backfill.
    const horizonTs = addTradingHours(new Date(), decision.horizon_hours).toISOString();

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
      invalidation_price: decision.invalidation_price ?? null,
      horizon_hours: decision.horizon_hours,
      horizon_ts: horizonTs,
      entry_price: entryPrice,
      target_price: decision.target_price,
      status: 'active',
      source_flow_ids: sourceFlowIds.length > 0 ? sourceFlowIds : null,
      pulse_net_premium_at_fire: pulse.netPremium,
      pulse_slope_5min_at_fire: pulse.slope5min,
      pulse_regime_at_fire: pulse.regime,
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
        flow_heatmap_per_ticker: flowHeatmap?.per_ticker ?? [],
        flow_heatmap_meta: flowHeatmap
          ? {
              generated_at: flowHeatmap.generated_at,
              lookback_hours: flowHeatmap.lookback_hours,
              math_mode: flowHeatmap.math_mode,
            }
          : null,
        brain_consumer: `ct-specialist-${ticker.toLowerCase()}`,
        brain_organs_invoked: Object.keys(ctx.organs ?? {}),
        temporal_validator_warnings: temporalValidatorWarnings,
        ticker_validator_warnings: tickerValidatorWarnings,
      },
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    });
  }

  // Write running commentary AFTER flag inserts so flag_id can link.
  if (parsed.current_read) {
    await writeSpecialistRead(supabase, {
      ticker,
      read: parsed.current_read,
      flagged: writtenIds.length > 0,
      flagId: writtenIds[0] ?? null,
      sourceFlowIds,
    });
  } else {
    // Fix D fallback (flagged path): write placeholder so freshness holds.
    // Diagnostic in ct_specialist_wakeup_log.
    console.warn(`[specialistRunner] ${ticker} flagged without current_read — failure=${parsed.current_read_failure}`);
    await writeSpecialistRead(supabase, {
      ticker,
      read: {
        direction_lean: 'mixed',
        conviction: 0,
        read_text: `[parse_fail: ${parsed.current_read_failure ?? 'unknown'}] ${responseText.slice(0, 400)}`,
      },
      flagged: writtenIds.length > 0,
      flagId: writtenIds[0] ?? null,
      sourceFlowIds,
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
