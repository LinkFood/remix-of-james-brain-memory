/**
 * ct-eod-report — Forward-looking 5pm ET close-to-open handoff.
 *
 * Cron: 0 21 * * 1-5 (21:00 UTC weekdays). Fires 30 min after ct-eod-summary.
 *
 * Structurally distinct from ct-eod-summary (the journal):
 *   - Journal = backward-looking attribution.
 *   - Report  = forward-looking handoff + grades this morning's brief calls.
 *
 * Reads existing data ONLY (does not mutate journal or daily_briefs). Writes
 * exactly one row per session_date to ct_eod_reports (UNIQUE constraint).
 *
 * Verdicts are computed deterministically in code BEFORE Sonnet sees the
 * payload — Sonnet only writes the commentary strings. If Sonnet's echoed
 * verdicts diverge, code-side values overwrite. This is the contract that
 * keeps grading honest.
 *
 * Body (optional):
 *   { session_date?: 'YYYY-MM-DD',
 *     skip_slack?: boolean,
 *     triggered_by?: 'scheduled' | 'manual' | 'rerun' }
 *
 * NOTE: ct_claude_decisions.decision_type CHECK constraint does not include
 * 'eod_report_generated' (the spec's intended value). Until the constraint is
 * extended in a separate migration, we record under 'reflection' (closest
 * semantic match in the allowed list — the report reflects on the day) and
 * stamp the actual decision shape in context_snapshot.kind = 'eod_report'.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse, ClaudeError, calculateCost } from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { getConfig } from '../_shared/configCache.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { EOD_REPORT_SYSTEM, EOD_REPORT_REQUIRED_KEYS, PROMPT_VERSION } from '../_shared/eodReportPrompt.ts';
import { getFlowHeatmapContext } from '../_shared/flowHeatmapContext.ts';
import { getTemporalContext, tagIsoTimestamp } from '../_shared/temporalContext.ts';
import { validateTemporalCoherence } from '../_shared/temporalValidator.ts';

// ---------------------------------------------------------------------------
// Types — every read is best-effort; missing rows do NOT block the report.
// ---------------------------------------------------------------------------

type Triggered = 'scheduled' | 'manual' | 'rerun';
type Verdict = 'win' | 'partial' | 'neutral' | 'loss';

interface EodSummaryRow {
  id: number;
  market_stats: Record<string, unknown> | null;
  specialist_scorecard: Record<string, unknown> | null;
  edge_attribution: Record<string, unknown> | null;
  top_print_grades: Array<Record<string, unknown>> | null;
  top_realized_tracks: Array<Record<string, unknown>> | null;
  regime_tag: string | null;
  snapshot_hit_rate: number | null;
  ticker_stats: Record<string, unknown> | null;
}

interface DailyBriefRow {
  id: string;
  brief_version: number | null;
  macro_narrative: string | null;
  macro_regime: string | null;
  urgency: string | null;
  per_ticker: Array<Record<string, unknown>> | null;
  watchlist_focus: string[] | null;
  skip_today: string[] | null;
  accuracy_score: number | null;
}

interface PriceBarRow { ticker: string; ts: string; timeframe: string; open: number | string; high: number | string; low: number | string; close: number | string; }
interface FlowPulseTickRow { tick_time: string; ticker: string; premium_net: number | string; call_put_ratio: number | string | null; is_unusual: boolean; }
interface SpecialistReadRow { ticker: string; direction_lean: string | null; conviction: number | null; read_text: string | null; flagged: boolean; updated_at: string; }
interface BreakingNewsRow { id: string; headline: string; source: string | null; severity: number; sentiment: string | null; category: string | null; summary: string | null; ingested_at: string; }
interface EventRow { event_type: string | null; ticker: string | null; event_date: string; event_time: string | null; title: string | null; importance: number | null; raw: Record<string, unknown> | null; }
interface TickerSnapshotRow { ticker: string; spot: number | null; gamma_flip: number | null; call_wall: number | null; put_wall: number | null; iv_rank: number | null; regime: string | null; }

interface ScorecardRow {
  ticker: string;
  morning_call: string;
  morning_thesis: string;
  actual_outcome: string;
  verdict: Verdict;
  alpha_pct: number | null;
}

interface ScorecardSummary { wins: number; partials: number; neutrals: number; losses: number; score_pct: number | null; }

interface PerTickerCloseRow {
  ticker: string;
  open_tilt: string | null;
  session_pct: number | null;
  session_range_pct: number | null;
  flow_close_summary: string;
  specialist_close_read: string;
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

function nyDateToday(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const yyyy = parts.find(p => p.type === 'year')?.value ?? '1970';
  const mm = parts.find(p => p.type === 'month')?.value ?? '01';
  const dd = parts.find(p => p.type === 'day')?.value ?? '01';
  return `${yyyy}-${mm}-${dd}`;
}

function dayNameFromYmd(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
}

// Format a ct_events row's time as ET-tagged human string.
function formatEventTime(e: EventRow): string {
  if (e.event_type === 'earnings') {
    const rt = (e.raw as Record<string, unknown> | null)?.report_time;
    if (rt === 'bmo') return 'pre-open';
    if (rt === 'amc') return 'post-close';
    if (rt === 'intraday') return 'intraday';
  }
  if (e.event_time) {
    const m = /^(\d{2}):(\d{2})/.exec(e.event_time);
    if (m) return `${m[1]}:${m[2]} ET`;
  }
  return '';
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const sign = v >= 0 ? '+' : '-';
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

// ---------------------------------------------------------------------------
// Verdict — DETERMINISTIC. Computed before Sonnet sees the payload.
// Sonnet must echo verdicts back; if it diverges, code-side wins.
// ---------------------------------------------------------------------------

function computeVerdict(
  morningTilt: string | null,
  sessionPct: number | null,
  sessionRangePct: number | null,
  thresholds: {
    leanWinPct: number;
    neutralLossPct: number;
    avoidChopRangePct: number;
  },
): Verdict {
  // Missing data → neutral by default.
  if (sessionPct == null || !Number.isFinite(Number(sessionPct))) return 'neutral';
  const pct = Number(sessionPct);
  const range = Number(sessionRangePct ?? 0);
  const tilt = (morningTilt ?? 'neutral').toLowerCase();

  if (tilt === 'long_lean' || tilt === 'long' || tilt === 'long lean') {
    if (pct >= thresholds.leanWinPct) return 'win';
    if (pct <= -thresholds.leanWinPct) return 'loss';
    return 'partial';
  }
  if (tilt === 'short_lean' || tilt === 'short' || tilt === 'short lean') {
    if (pct <= -thresholds.leanWinPct) return 'win';
    if (pct >= thresholds.leanWinPct) return 'loss';
    return 'partial';
  }
  if (tilt === 'avoid' || tilt === 'avoid_today') {
    const choppy = range >= thresholds.avoidChopRangePct
      && Math.abs(pct) < thresholds.neutralLossPct;
    if (choppy) return 'win';
    if (Math.abs(pct) >= thresholds.neutralLossPct) return 'loss';
    return 'neutral';
  }
  // Default ('neutral' or unrecognized).
  if (Math.abs(pct) < thresholds.leanWinPct) return 'win';
  if (Math.abs(pct) >= thresholds.neutralLossPct) return 'loss';
  return 'partial';
}

function summarizeScorecard(rows: ScorecardRow[]): ScorecardSummary {
  let wins = 0, partials = 0, neutrals = 0, losses = 0;
  for (const r of rows) {
    if (r.verdict === 'win') wins++;
    else if (r.verdict === 'partial') partials++;
    else if (r.verdict === 'neutral') neutrals++;
    else if (r.verdict === 'loss') losses++;
  }
  const denom = wins + partials + neutrals + losses;
  // Score = wins + 0.5*partials, normalized. Neutrals don't move the dial.
  const scorePct = denom > 0
    ? Math.round(((wins + 0.5 * partials) / denom) * 100)
    : null;
  return { wins, partials, neutrals, losses, score_pct: scorePct };
}

// ---------------------------------------------------------------------------
// Tool schema — forced tool-use guarantees a structured response. Mirrors
// the morning brief's emit_brief pattern. Sonnet must call this tool exactly
// once; the SDK's tool_choice forces it.
// ---------------------------------------------------------------------------
const EMIT_EOD_REPORT_TOOL = {
  name: 'emit_eod_report',
  description: 'Emit the structured EOD report. You MUST call this tool exactly once. Do not respond in prose.',
  input_schema: {
    type: 'object',
    required: ['session_summary', 'per_ticker_close', 'morning_brief_scorecard', 'carryover_themes', 'tomorrow_watchlist', 'lessons_today', 'script'],
    properties: {
      session_summary: { type: 'string', description: '2-3 sentence headline of the day (regime, top story, top mover).' },
      regime_close: { type: 'string', description: 'Regime tag at close, e.g. trend_down_low_vol.' },
      regime_shift_today: { type: 'string', description: 'How regime moved open-to-close. Examples: "stable", "open trend_up → close trend_down", "open neutral → close trend_up_high_vol".' },
      per_ticker_close: {
        type: 'array',
        description: 'One card per watchlist ticker (10 items). Forward-looking close-of-day read for each.',
        items: {
          type: 'object',
          required: ['ticker', 'close_tilt', 'alignment', 'carryover_thesis'],
          properties: {
            ticker:                 { type: 'string' },
            open_tilt:              { type: 'string' },
            close_tilt:             { type: 'string', description: "'long_lean' | 'short_lean' | 'neutral' | 'avoid'" },
            alignment:              { type: 'string', enum: ['aligned', 'partial', 'missed'], description: 'How well the day matched the morning call.' },
            session_pct:            { type: 'number' },
            flow_close:             { type: 'string' },
            specialist_close_read:  { type: 'string' },
            carryover_thesis:       { type: 'string', description: '1 sentence: what this ticker means going into tomorrow.' },
            confidence_close:       { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
      morning_brief_scorecard: {
        type: 'array',
        description: 'Per-ticker grade of this morning\'s brief calls. Echo verdict + alpha_pct EXACTLY from input. Only commentary is yours to write.',
        items: {
          type: 'object',
          required: ['ticker', 'verdict', 'commentary'],
          properties: {
            ticker:         { type: 'string' },
            morning_call:   { type: 'string' },
            morning_thesis: { type: 'string' },
            actual_outcome: { type: 'string' },
            verdict:        { type: 'string', enum: ['win', 'partial', 'neutral', 'loss'], description: 'Pre-computed by code; echo verbatim.' },
            alpha_pct:      { type: 'number' },
            commentary:     { type: 'string', description: '1 sentence WHY the call hit/missed. Reference specific data.' },
          },
        },
      },
      scorecard_summary: {
        type: 'object',
        description: 'Echo wins/partials/neutrals/losses/score_pct from the pre-computed input. Do not recount.',
        properties: {
          wins:      { type: 'integer' },
          partials:  { type: 'integer' },
          neutrals:  { type: 'integer' },
          losses:    { type: 'integer' },
          score_pct: { type: ['number', 'null'] },
        },
      },
      carryover_themes: {
        type: 'array',
        description: '3-5 strings. Structural signals at close still active tomorrow morning. Specific levels, signatures, regime states. No generic "watch follow-through".',
        items: { type: 'string' },
      },
      overnight_catalysts: {
        type: 'array',
        description: 'Tomorrow / overnight catalysts that matter. Echo from input where supplied, never invent.',
        items: {
          type: 'object',
          required: ['when', 'event'],
          properties: {
            when:    { type: 'string', description: 'e.g. "tonight 4:30 PM ET" or "tomorrow 8:30 AM ET"' },
            event:   { type: 'string' },
            tickers: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      breaking_events_today: {
        type: 'array',
        description: 'Echo severity >=3 breaking events from input. Never invent.',
        items: {
          type: 'object',
          required: ['headline'],
          properties: {
            headline: { type: 'string' },
            severity: { type: 'integer', minimum: 1, maximum: 5 },
            source:   { type: 'string' },
          },
        },
      },
      tomorrow_watchlist: {
        type: 'array',
        description: '3-5 tickers to focus tomorrow with priority + specific reason.',
        items: {
          type: 'object',
          required: ['ticker', 'reason', 'priority'],
          properties: {
            ticker:   { type: 'string' },
            reason:   { type: 'string', description: '1-2 sentences with specific data. No "looks interesting".' },
            priority: { type: 'string', enum: ['high', 'medium'] },
          },
        },
      },
      skip_tomorrow: {
        type: 'array',
        description: 'Tickers to avoid tomorrow with reason.',
        items: {
          type: 'object',
          required: ['ticker', 'reason'],
          properties: {
            ticker: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
      lessons_today: {
        type: 'array',
        description: '1-3 strings, 1 sentence each. What was learned today. Feeds JAC reflection layer.',
        items: { type: 'string' },
      },
      script: {
        type: 'string',
        description: 'Narratable version, ~180 words, plain prose. Lead with the day\'s verdict, top 2-3 carryover themes, end with EXACTLY: "That\'s your wrap."',
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const startedAt = Date.now();

  // ----- Body parsing ---------------------------------------------------------
  let bodyParsed: { session_date?: string; skip_slack?: boolean; triggered_by?: Triggered } = {};
  try {
    if (req.method === 'POST') {
      const text = await req.text();
      if (text && text.trim().length > 0) {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') {
          bodyParsed = parsed as typeof bodyParsed;
        }
      }
    }
  } catch {
    // ignore — defaults below
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Temporal anchor — pre-tag every date in the user-message JSON + prepend
  // preamble. See _shared/temporalContext.ts. For typical scheduled runs
  // tctx.session_date === sessionDate (5pm ET cron). For reruns of older
  // session_dates, the preamble still anchors Claude on "now" but
  // tagIsoTimestamp() is called with the target sessionDate so per-row tags
  // resolve correctly.
  const tctx = getTemporalContext();

  const now = new Date();
  const sessionDate = (typeof bodyParsed.session_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(bodyParsed.session_date))
    ? bodyParsed.session_date
    : nyDateToday(now);
  const skipSlack = bodyParsed.skip_slack === true;
  const triggeredBy: Triggered =
    bodyParsed.triggered_by === 'manual' ? 'manual'
    : bodyParsed.triggered_by === 'rerun' ? 'rerun'
    : 'scheduled';

  // Day window in UTC for filtering created_at columns. NY day midnight ≈ 04:00
  // or 05:00 UTC depending on DST; the 04:00 floor catches both.
  const dayStartIso = `${sessionDate}T04:00:00Z`;
  const dayEndIso = now.toISOString();

  // ----- Config thresholds ----------------------------------------------------
  const [
    leanWinPct,
    neutralLossPct,
    avoidChopRangePct,
    carryoverLookbackHours,
    slackEnabled,
  ] = await Promise.all([
    getConfig<number>('eod_report_verdict_lean_win_pct', 0.4),
    getConfig<number>('eod_report_verdict_neutral_loss_pct', 0.8),
    getConfig<number>('eod_report_verdict_avoid_chop_range_pct', 1.5),
    getConfig<number>('eod_report_carryover_lookback_hours', 1),
    getConfig<boolean>('eod_report_slack_enabled', true),
  ]);

  const thresholds = {
    leanWinPct: Number(leanWinPct) || 0.4,
    neutralLossPct: Number(neutralLossPct) || 0.8,
    avoidChopRangePct: Number(avoidChopRangePct) || 1.5,
  };

  // ----- Watchlist + cutoffs --------------------------------------------------
  const watchlist = await getWatchlist(supabase);
  // Flow-heatmap regime context — top 3 expiry-week stacks per ticker (168h
  // lookback, aggressive_directional_decay). Best-effort; helper returns empty
  // per_ticker on failure so the report never blocks.
  const flowHeatmapContext = await getFlowHeatmapContext(supabase, watchlist);
  const carryoverSinceIso = new Date(
    now.getTime() - Math.max(0.25, Number(carryoverLookbackHours) || 1) * 3600_000,
  ).toISOString();
  const tomorrowYmd = (() => {
    const d = new Date(`${sessionDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();

  // ===========================================================================
  // STEP 3 — Parallel data pull. Every fetch is best-effort and degrades to
  // empty/null on failure. None of these are blockers for the report.
  // ===========================================================================
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb: any = supabase;

  const [
    journalRes,
    morningBriefRes,
    barsRes,
    pulseRes,
    readsRes,
    breakingRes,
    eventsRes,
    snapshotsRes,
  ] = await Promise.all([
    sb.from('ct_eod_summaries')
      .select('id, market_stats, ticker_stats, specialist_scorecard, edge_attribution, top_print_grades, top_realized_tracks, regime_tag, snapshot_hit_rate')
      .eq('session_date', sessionDate)
      .maybeSingle(),
    sb.from('ct_daily_briefs')
      .select('id, session_date, brief_version, macro_narrative, macro_regime, urgency, per_ticker, watchlist_focus, skip_today, accuracy_score')
      .eq('session_date', sessionDate)
      .order('brief_version', { ascending: false })
      .limit(1)
      .maybeSingle(),
    sb.from('ct_price_bars')
      .select('ticker, ts, timeframe, open, high, low, close')
      .in('ticker', watchlist)
      .in('timeframe', ['1m', '5m'])
      .gte('ts', dayStartIso)
      .lte('ts', dayEndIso)
      .order('ts', { ascending: true })
      .limit(8000),
    sb.from('ct_flow_pulse_ticks')
      .select('tick_time, ticker, premium_net, call_put_ratio, is_unusual')
      .in('ticker', watchlist)
      .gte('tick_time', carryoverSinceIso)
      .order('tick_time', { ascending: true })
      .limit(2000),
    sb.from('ct_specialist_reads')
      .select('ticker, direction_lean, conviction, read_text, flagged, updated_at')
      .gte('updated_at', dayStartIso)
      .lte('updated_at', dayEndIso)
      .in('ticker', watchlist)
      .order('updated_at', { ascending: false })
      .limit(500),
    sb.from('ct_breaking_news')
      .select('id, headline, source, severity, sentiment, category, summary, ingested_at')
      .gte('ingested_at', dayStartIso)
      .lte('ingested_at', dayEndIso)
      .gte('severity', 3)
      .order('severity', { ascending: false })
      .order('ingested_at', { ascending: false })
      .limit(40),
    sb.from('ct_events')
      .select('event_type, ticker, event_date, event_time, title, importance, raw')
      .gte('event_date', sessionDate)
      .lte('event_date', tomorrowYmd)
      .order('event_date', { ascending: true })
      .limit(60),
    sb.from('ct_ticker_snapshots')
      .select('ticker, spot, gamma_flip, call_wall, put_wall, iv_rank, regime')
      .in('ticker', watchlist),
  ]);

  const fetchWarnings: string[] = [];
  if (journalRes.error) fetchWarnings.push(`eod_summary: ${journalRes.error.message}`);
  if (morningBriefRes.error) fetchWarnings.push(`daily_brief: ${morningBriefRes.error.message}`);
  if (barsRes.error) fetchWarnings.push(`price_bars: ${barsRes.error.message}`);
  if (pulseRes.error) fetchWarnings.push(`pulse: ${pulseRes.error.message}`);
  if (readsRes.error) fetchWarnings.push(`specialist_reads: ${readsRes.error.message}`);
  if (breakingRes.error) fetchWarnings.push(`breaking_news: ${breakingRes.error.message}`);
  if (eventsRes.error) fetchWarnings.push(`events: ${eventsRes.error.message}`);
  if (snapshotsRes.error) fetchWarnings.push(`ticker_snapshots: ${snapshotsRes.error.message}`);

  const journal = (journalRes.data ?? null) as EodSummaryRow | null;
  const morningBrief = (morningBriefRes.data ?? null) as DailyBriefRow | null;
  const bars = (barsRes.data ?? []) as PriceBarRow[];
  const pulse = (pulseRes.data ?? []) as FlowPulseTickRow[];
  const reads = (readsRes.data ?? []) as SpecialistReadRow[];
  const breakingAll = (breakingRes.data ?? []) as BreakingNewsRow[];
  const events = (eventsRes.data ?? []) as EventRow[];
  const snapshots = (snapshotsRes.data ?? []) as TickerSnapshotRow[];

  // ===========================================================================
  // STEP 4 — Per-ticker close data + verdict computation.
  // ===========================================================================

  // Bars → first/last/range per ticker.
  const tickerBars = new Map<string, PriceBarRow[]>();
  for (const b of bars) {
    const arr = tickerBars.get(b.ticker) ?? [];
    arr.push(b);
    tickerBars.set(b.ticker, arr);
  }

  function dailyMoveFromBars(rows: PriceBarRow[] | undefined): {
    open: number | null;
    close: number | null;
    high: number | null;
    low: number | null;
    pct: number | null;
    rangePct: number | null;
  } {
    if (!rows || rows.length === 0) {
      return { open: null, close: null, high: null, low: null, pct: null, rangePct: null };
    }
    const first = rows[0];
    const last = rows[rows.length - 1];
    const o = Number(first.open);
    const c = Number(last.close);
    let hi = -Infinity, lo = Infinity;
    for (const r of rows) {
      const h = Number(r.high), l = Number(r.low);
      if (Number.isFinite(h) && h > hi) hi = h;
      if (Number.isFinite(l) && l < lo) lo = l;
    }
    if (!Number.isFinite(hi)) hi = c;
    if (!Number.isFinite(lo)) lo = c;
    const pct = (Number.isFinite(o) && Number.isFinite(c) && o !== 0)
      ? ((c - o) / o) * 100 : null;
    const rangePct = (Number.isFinite(hi) && Number.isFinite(lo) && o !== 0 && Number.isFinite(o))
      ? ((hi - lo) / o) * 100 : null;
    return {
      open: Number.isFinite(o) ? o : null,
      close: Number.isFinite(c) ? c : null,
      high: Number.isFinite(hi) ? hi : null,
      low: Number.isFinite(lo) ? lo : null,
      pct: pct != null ? Math.round(pct * 100) / 100 : null,
      rangePct: rangePct != null ? Math.round(rangePct * 100) / 100 : null,
    };
  }

  // Latest pulse tick per ticker.
  const latestPulse = new Map<string, FlowPulseTickRow>();
  for (const t of pulse) {
    latestPulse.set(t.ticker, t); // ASC order — last write wins
  }

  // Latest specialist read per ticker.
  const latestRead = new Map<string, SpecialistReadRow>();
  for (const r of reads) {
    if (!latestRead.has(r.ticker)) latestRead.set(r.ticker, r); // DESC order — first wins
  }

  // Morning brief tilt per ticker.
  const morningTiltByTicker = new Map<string, { tilt: string | null; thesis: string | null; focus: number | null }>();
  if (morningBrief?.per_ticker) {
    for (const card of morningBrief.per_ticker) {
      const t = String((card.ticker as string) ?? '').toUpperCase();
      if (!t) continue;
      morningTiltByTicker.set(t, {
        tilt: (card.tilt as string) ?? null,
        thesis: (card.rationale as string) ?? (card.narrative_view as string) ?? null,
        focus: card.focus != null ? Number(card.focus) : null,
      });
    }
  }

  // Per-ticker close + scorecard pre-compute.
  const perTickerClose: Array<PerTickerCloseRow & {
    open: number | null;
    close: number | null;
    high: number | null;
    low: number | null;
  }> = [];
  const scorecardRows: ScorecardRow[] = [];

  for (const ticker of watchlist) {
    const move = dailyMoveFromBars(tickerBars.get(ticker));
    const tiltCard = morningTiltByTicker.get(ticker);
    const openTilt = tiltCard?.tilt ?? null;

    const pulseTick = latestPulse.get(ticker);
    const flowSummary = pulseTick
      ? (() => {
          const net = Number(pulseTick.premium_net);
          const dir = net > 0 ? 'bull' : net < 0 ? 'bear' : 'flat';
          return `${dir} ${fmtUsd(net)}`;
        })()
      : 'no pulse';

    const readRow = latestRead.get(ticker);
    const specialistRead = readRow
      ? `${readRow.direction_lean ?? 'neutral'}${readRow.conviction != null ? ` (conv ${readRow.conviction})` : ''}`
      : 'no read';

    perTickerClose.push({
      ticker,
      open_tilt: openTilt,
      session_pct: move.pct,
      session_range_pct: move.rangePct,
      flow_close_summary: flowSummary,
      specialist_close_read: specialistRead,
      open: move.open, close: move.close, high: move.high, low: move.low,
    });

    if (morningBrief && tiltCard) {
      const verdict = computeVerdict(openTilt, move.pct, move.rangePct, thresholds);
      const focusStr = tiltCard.focus != null ? ` (focus ${tiltCard.focus})` : '';
      const morningCall = `${openTilt ?? 'neutral'}${focusStr}`;
      const thesisSlice = (tiltCard.thesis ?? '').slice(0, 200);
      const outcomeSlice = move.pct != null
        ? `closed ${move.pct >= 0 ? '+' : ''}${move.pct.toFixed(2)}% · ${flowSummary}`
        : `no price data · ${flowSummary}`;
      scorecardRows.push({
        ticker,
        morning_call: morningCall,
        morning_thesis: thesisSlice,
        actual_outcome: outcomeSlice,
        verdict,
        alpha_pct: move.pct,
      });
    }
  }

  const scorecardSummary: ScorecardSummary = morningBrief
    ? summarizeScorecard(scorecardRows)
    : { wins: 0, partials: 0, neutrals: 0, losses: 0, score_pct: null };

  // ===========================================================================
  // STEP 5 — Build Sonnet input JSON.
  // ===========================================================================

  // Regime open vs close from journal.market_stats if available.
  const marketStats = (journal?.market_stats ?? {}) as Record<string, unknown>;
  const mktPremOpen = marketStats.market_premium_open != null ? Number(marketStats.market_premium_open) : null;
  const mktPremClose = marketStats.market_premium_close != null ? Number(marketStats.market_premium_close) : null;
  const mktPremDelta = (mktPremOpen != null && mktPremClose != null) ? (mktPremClose - mktPremOpen) : null;

  const regimeClose = journal?.regime_tag ?? null;

  // Carryover signals.
  const tapeFirst = (marketStats.tape_first as string) ?? null;
  const tapeLast = (marketStats.tape_last as string) ?? tapeFirst;
  const topActiveStacks = (() => {
    const ts = journal?.ticker_stats as Record<string, unknown> | null;
    if (!ts) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const ticker of watchlist) {
      const row = ts[ticker] as Record<string, unknown> | undefined;
      const stack = row?.top_stack as Record<string, unknown> | undefined;
      if (stack) out.push({ ticker, ...stack });
    }
    return out
      .sort((a, b) => Number(b.premium ?? 0) - Number(a.premium ?? 0))
      .slice(0, 3);
  })();

  const pulseCloseByTicker = (() => {
    const out: Record<string, { premium_net: number; call_put_ratio: number | null; is_unusual: boolean } > = {};
    for (const ticker of watchlist) {
      const tick = latestPulse.get(ticker);
      if (!tick) continue;
      out[ticker] = {
        premium_net: Number(tick.premium_net),
        call_put_ratio: tick.call_put_ratio != null ? Number(tick.call_put_ratio) : null,
        is_unusual: !!tick.is_unusual,
      };
    }
    return out;
  })();

  const snapshotsByTicker = (() => {
    const out: Record<string, Record<string, unknown>> = {};
    for (const s of snapshots) {
      out[s.ticker] = {
        spot: s.spot,
        gamma_flip: s.gamma_flip,
        call_wall: s.call_wall,
        put_wall: s.put_wall,
        iv_rank: s.iv_rank,
        regime: s.regime,
      };
    }
    return out;
  })();

  // Overnight catalysts — events between today and tomorrow (skip today's
  // events whose time has passed, but err on the side of including).
  // event_date_tag pins the calendar day relative to sessionDate so Sonnet
  // doesn't drift on day-name framing for cross-day catalysts.
  const overnightCatalystsRaw = events
    .filter(e => e.event_date >= sessionDate && e.event_date <= tomorrowYmd)
    .map(e => {
      const dayLabel = e.event_date === sessionDate ? 'tonight' : 'tomorrow';
      const t = formatEventTime(e);
      const when = t ? `${dayLabel} ${t}` : dayLabel;
      const tickers: string[] = e.ticker ? [e.ticker.toUpperCase()] : [];
      return {
        when,
        event_date: e.event_date,
        event_date_tag: tagIsoTimestamp(`${e.event_date}T17:00:00Z`, sessionDate),
        event: e.title ?? `${e.event_type ?? 'event'} ${e.ticker ?? ''}`.trim(),
        tickers,
        event_type: e.event_type,
        importance: e.importance,
      };
    });

  const breakingEventsToday = breakingAll.map(b => ({
    headline: b.headline,
    severity: b.severity,
    source: b.source ?? 'unknown',
    sentiment: b.sentiment,
    category: b.category,
    summary: (b.summary ?? '').slice(0, 320),
    when: tagIsoTimestamp(b.ingested_at, sessionDate),
  }));

  // Pre-tag every timestamp in the journal payload so Sonnet anchors prints
  // to today/yesterday/N-days-ago instead of pattern-completing on raw ISO.
  // Rows are spread + tag-injected; original ISO retained for downstream
  // consumers that haven't been wired yet.
  const tagPrintGradeRow = (r: Record<string, unknown>): Record<string, unknown> => ({
    ...r,
    print_time_tag: typeof r.print_time === 'string' ? tagIsoTimestamp(r.print_time, sessionDate) : null,
    graded_at_tag: typeof r.graded_at === 'string' ? tagIsoTimestamp(r.graded_at, sessionDate) : null,
  });
  const tagRealizedTrackRow = (r: Record<string, unknown>): Record<string, unknown> => ({
    ...r,
    print_time_tag: typeof r.print_time === 'string' ? tagIsoTimestamp(r.print_time, sessionDate) : null,
    peak_favorable_at_tag: typeof r.peak_favorable_at === 'string' ? tagIsoTimestamp(r.peak_favorable_at, sessionDate) : null,
    realized_at_tag: typeof r.realized_at === 'string' ? tagIsoTimestamp(r.realized_at, sessionDate) : null,
  });

  const journalAttribution = journal
    ? {
        top_print_grades: (journal.top_print_grades ?? []).slice(0, 5).map(tagPrintGradeRow),
        top_realized_tracks: (journal.top_realized_tracks ?? []).slice(0, 3).map(tagRealizedTrackRow),
        grade_breakdown: (journal.market_stats as Record<string, unknown> | null)?.grade_breakdown ?? null,
        specialist_scorecard: journal.specialist_scorecard ?? null,
        snapshot_hit_rate: journal.snapshot_hit_rate ?? null,
        regime_tag: journal.regime_tag ?? null,
        edge_attribution: journal.edge_attribution ?? null,
      }
    : null;

  const userMessage = {
    session_date: sessionDate,
    session_day_name: dayNameFromYmd(sessionDate),
    triggered_by: triggeredBy,

    // Temporal anchor — relative-day reference for the model. Authoritative
    // tags on every per-row timestamp below resolve against session_date.
    temporal_anchor: {
      session_date: sessionDate,
      session_day_name: dayNameFromYmd(sessionDate),
      generated_at_utc: tctx.now_utc,
      generated_at_et: tctx.now_et,
      tomorrow_date: tomorrowYmd,
    },

    regime_close: regimeClose,
    regime_shift_open_to_close: {
      open_premium: mktPremOpen,
      close_premium: mktPremClose,
      delta: mktPremDelta,
    },

    morning_brief: morningBrief
      ? {
          id: morningBrief.id,
          brief_version: morningBrief.brief_version,
          macro_narrative: morningBrief.macro_narrative,
          macro_regime: morningBrief.macro_regime,
          urgency: morningBrief.urgency,
          accuracy_score: morningBrief.accuracy_score,
          watchlist_focus: morningBrief.watchlist_focus ?? [],
          skip_today: morningBrief.skip_today ?? [],
          per_ticker: morningBrief.per_ticker ?? [],
        }
      : null,

    per_ticker_close_data: perTickerClose.map(p => ({
      ticker: p.ticker,
      open_tilt: p.open_tilt,
      session_pct: p.session_pct,
      session_range_pct: p.session_range_pct,
      open: p.open,
      close: p.close,
      high: p.high,
      low: p.low,
      flow_close_summary: p.flow_close_summary,
      specialist_close_read: p.specialist_close_read,
    })),

    scorecard_pre_computed: scorecardRows,
    scorecard_summary_pre_computed: scorecardSummary,

    carryover_signals: {
      last_tape_commentary: tapeLast,
      first_tape_commentary: tapeFirst,
      top_active_stacks: topActiveStacks,
      pulse_close_per_ticker: pulseCloseByTicker,
      snapshots_per_ticker: snapshotsByTicker,
    },

    // Positioning regime — top 3 expiry-week stacks per ticker. Used as
    // forward-looking context for tomorrow's setup (carryover_themes,
    // tomorrow_watchlist). No typed schema field on the tool — Sonnet
    // consumes via free-text reasoning.
    flow_heatmap_per_ticker: flowHeatmapContext.per_ticker,
    flow_heatmap_meta: {
      generated_at: flowHeatmapContext.generated_at,
      lookback_hours: flowHeatmapContext.lookback_hours,
      math_mode: flowHeatmapContext.math_mode,
    },

    overnight_catalysts_raw: overnightCatalystsRaw,
    breaking_events_today: breakingEventsToday,

    journal_attribution: journalAttribution,

    config_thresholds: thresholds,
    prompt_version: PROMPT_VERSION,
  };

  // ===========================================================================
  // STEP 6 — Sonnet call.
  // ===========================================================================

  const claudeStart = Date.now();
  let claudeResp;
  let claudeError: string | null = null;
  try {
    claudeResp = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: tctx.temporalAnchorPreamble + '\n\n' + EOD_REPORT_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(userMessage) }],
      max_tokens: 6000,
      temperature: 0.3,
      tools: [EMIT_EOD_REPORT_TOOL as unknown as Record<string, unknown>],
      tool_choice: { type: 'tool', name: 'emit_eod_report' },
    });
  } catch (e) {
    claudeError = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : (e instanceof Error ? e.message : String(e));
  }

  // Best-effort early-failure decision-journal writer (claude_failed, parse_failed, validation_failed).
  const recordEarlyFailure = async (
    outcome: string,
    reasoning: string,
    extraContext: Record<string, unknown>,
    tokens?: { in: number; out: number; cost: number },
  ) => {
    try {
      await sb.from('ct_claude_decisions').insert({
        decision_type: 'eod_report_generated',
        model_tier: 'sonnet',
        context_snapshot: {
          kind: 'eod_report',
          session_date: sessionDate,
          triggered_by: triggeredBy,
          journal_present: !!journal,
          morning_brief_present: !!morningBrief,
          ticker_count: watchlist.length,
          ...extraContext,
        },
        reasoning,
        outcome,
        tokens_in: tokens?.in ?? null,
        tokens_out: tokens?.out ?? null,
        cost_usd: tokens?.cost ?? null,
      });
    } catch { /* swallow */ }
  };

  if (!claudeResp) {
    await recordEarlyFailure(
      'claude_failed',
      `EOD report Sonnet call failed for ${sessionDate}: ${claudeError ?? 'unknown'}`,
      {},
    );
    return new Response(JSON.stringify({
      ok: false, error: 'claude_failed', detail: claudeError, session_date: sessionDate,
    }), { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const tokensIn = claudeResp.usage?.input_tokens ?? 0;
  const tokensOut = claudeResp.usage?.output_tokens ?? 0;
  const costUsd = calculateCost(CLAUDE_MODELS.sonnet, { input_tokens: tokensIn, output_tokens: tokensOut });
  const claudeDurationMs = Date.now() - claudeStart;

  // Log Claude usage (fire-and-forget).
  logClaudeUsage(supabase as unknown as { from: (t: string) => { insert: (r: Record<string, unknown>) => Promise<unknown> } }, {
    source: 'ct-eod-report',
    model: CLAUDE_MODELS.sonnet,
    usage: { input_tokens: tokensIn, output_tokens: tokensOut },
    duration_ms: claudeDurationMs,
    metadata: {
      session_date: sessionDate,
      triggered_by: triggeredBy,
      journal_present: !!journal,
      morning_brief_present: !!morningBrief,
    },
  });

  // ===========================================================================
  // STEP 7 — Validate parsed output.
  // ===========================================================================

  const tool = parseToolUse(claudeResp);
  if (!tool || tool.name !== 'emit_eod_report' || !tool.input || typeof tool.input !== 'object') {
    await recordEarlyFailure(
      'parse_failed',
      `EOD report tool-use failed for ${sessionDate}: tool=${tool?.name ?? 'none'}`,
      { tool_name: tool?.name ?? null, has_input: !!tool?.input },
      { in: tokensIn, out: tokensOut, cost: costUsd },
    );
    return new Response(JSON.stringify({
      ok: false, error: 'parse_failed', detail: `tool=${tool?.name ?? 'none'}`, session_date: sessionDate,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const sonnetOut = tool.input as Record<string, unknown>;
  const missingKeys = EOD_REPORT_REQUIRED_KEYS.filter(k => !(k in sonnetOut));
  if (missingKeys.length > 0) {
    await recordEarlyFailure(
      'validation_failed',
      `EOD report missing required keys for ${sessionDate}: ${missingKeys.join(',')}`,
      { missing_keys: missingKeys, present_keys: Object.keys(sonnetOut) },
      { in: tokensIn, out: tokensOut, cost: costUsd },
    );
    return new Response(JSON.stringify({
      ok: false, error: 'missing_keys', missing: missingKeys, session_date: sessionDate,
    }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Echo-validate: overwrite Sonnet's scorecard verdicts/summary with the
  // pre-computed values so any drift is silently corrected. This is the
  // contract — Sonnet writes commentary, code owns the grade.
  const sonnetScorecard = Array.isArray(sonnetOut.morning_brief_scorecard)
    ? (sonnetOut.morning_brief_scorecard as Array<Record<string, unknown>>)
    : [];

  const verdictByTicker = new Map<string, ScorecardRow>();
  for (const r of scorecardRows) verdictByTicker.set(r.ticker, r);

  const correctedScorecard = sonnetScorecard.map(row => {
    const t = String((row.ticker as string) ?? '').toUpperCase();
    const truth = verdictByTicker.get(t);
    if (!truth) return row; // Sonnet emitted a row we didn't expect — pass through.
    return {
      ...row,
      ticker: t,
      morning_call: truth.morning_call,
      morning_thesis: truth.morning_thesis,
      actual_outcome: truth.actual_outcome,
      verdict: truth.verdict,
      alpha_pct: truth.alpha_pct,
      // commentary kept from Sonnet
      commentary: typeof row.commentary === 'string' ? row.commentary : '',
    };
  });

  // If Sonnet returned fewer rows than scorecardRows (or none), append the
  // missing tickers so downstream UI sees the full table.
  const sonnetTickers = new Set(correctedScorecard.map(r => String((r as { ticker?: string }).ticker ?? '').toUpperCase()));
  for (const r of scorecardRows) {
    if (!sonnetTickers.has(r.ticker)) {
      correctedScorecard.push({
        ...r,
        commentary: '',
      });
    }
  }

  // ===========================================================================
  // STEP 8 — UPSERT to ct_eod_reports.
  // ===========================================================================

  const reportRow = {
    session_date: sessionDate,
    generated_at: new Date().toISOString(),
    generated_by_model: CLAUDE_MODELS.sonnet,

    session_summary: typeof sonnetOut.session_summary === 'string' ? sonnetOut.session_summary : null,
    regime_close: typeof sonnetOut.regime_close === 'string' ? sonnetOut.regime_close : regimeClose,
    regime_shift_today: typeof sonnetOut.regime_shift_today === 'string' ? sonnetOut.regime_shift_today : 'stable',

    per_ticker_close: Array.isArray(sonnetOut.per_ticker_close) ? sonnetOut.per_ticker_close : [],
    morning_brief_scorecard: correctedScorecard,
    scorecard_summary: scorecardSummary,
    carryover_themes: Array.isArray(sonnetOut.carryover_themes) ? sonnetOut.carryover_themes : [],
    overnight_catalysts: Array.isArray(sonnetOut.overnight_catalysts) ? sonnetOut.overnight_catalysts : [],
    breaking_events_today: Array.isArray(sonnetOut.breaking_events_today) ? sonnetOut.breaking_events_today : [],
    tomorrow_watchlist: Array.isArray(sonnetOut.tomorrow_watchlist) ? sonnetOut.tomorrow_watchlist : [],
    skip_tomorrow: Array.isArray(sonnetOut.skip_tomorrow) ? sonnetOut.skip_tomorrow : [],
    lessons_today: Array.isArray(sonnetOut.lessons_today) ? sonnetOut.lessons_today : [],
    script: typeof sonnetOut.script === 'string' ? sonnetOut.script : null,

    morning_brief_id: morningBrief?.id ?? null,
    eod_summary_id: journal?.id ?? null,

    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    triggered_by: triggeredBy,
  };

  // ----- Temporal-coherence validator (best-effort) -------------------------
  // Validate session_summary + script. Critical contradictions log + ride
  // along on ct_claude_decisions.context_snapshot.temporal_validator_warnings.
  let validatorOk = true;
  let validatorContradictions: Array<{ quote: string; issue: string; severity: 'critical' | 'warning' }> = [];
  const sessionSummaryText = typeof sonnetOut.session_summary === 'string' ? sonnetOut.session_summary : '';
  const scriptText = typeof sonnetOut.script === 'string' ? sonnetOut.script : '';
  const validatorTarget = [sessionSummaryText, scriptText].filter(Boolean).join('\n\n---\n\n');
  if (validatorTarget) {
    try {
      const validation = await validateTemporalCoherence(validatorTarget, sessionDate);
      validatorOk = validation.ok;
      validatorContradictions = validation.contradictions;
      const critical = validation.contradictions.filter(c => c.severity === 'critical');
      if (critical.length > 0) {
        console.warn(
          `[ct-eod-report] temporal validator flagged ${critical.length} CRITICAL contradiction(s) for session ${sessionDate}:`,
          JSON.stringify(critical),
        );
      } else if (!validation.ok && validation.contradictions.length > 0) {
        console.warn(
          `[ct-eod-report] temporal validator flagged ${validation.contradictions.length} warning(s) for session ${sessionDate}:`,
          JSON.stringify(validation.contradictions),
        );
      }
    } catch (e) {
      console.warn('[ct-eod-report] temporal validator threw (non-blocking):', String(e));
    }
  }

  const { data: upserted, error: upsertErr } = await sb
    .from('ct_eod_reports')
    .upsert(reportRow, { onConflict: 'session_date' })
    .select('id, session_date, generated_at, triggered_by')
    .single();

  // Decision journal (separate from upsert success — even on UPSERT err we
  // want a record).
  const reportOutcome: 'inserted' | 'rerun' | 'no_data' =
    triggeredBy === 'rerun' ? 'rerun'
    : (!journal && !morningBrief) ? 'no_data'
    : 'inserted';

  try {
    await sb.from('ct_claude_decisions').insert({
      decision_type: 'eod_report_generated',
      model_tier: 'sonnet',
      context_snapshot: {
        kind: 'eod_report',
        session_date: sessionDate,
        triggered_by: triggeredBy,
        journal_present: !!journal,
        morning_brief_present: !!morningBrief,
        ticker_count: watchlist.length,
        scorecard_summary: scorecardSummary,
        prompt_version: PROMPT_VERSION,
        upsert_error: upsertErr?.message ?? null,
        fetch_warnings: fetchWarnings,
        flow_heatmap_per_ticker: flowHeatmapContext.per_ticker,
        flow_heatmap_meta: {
          generated_at: flowHeatmapContext.generated_at,
          lookback_hours: flowHeatmapContext.lookback_hours,
          math_mode: flowHeatmapContext.math_mode,
        },
        temporal_validator_warnings: {
          ok: validatorOk,
          session_date: sessionDate,
          contradiction_count: validatorContradictions.length,
          critical_count: validatorContradictions.filter(c => c.severity === 'critical').length,
          contradictions: validatorContradictions,
        },
      },
      reasoning: `EOD report v${PROMPT_VERSION} for ${sessionDate} (triggered_by=${triggeredBy}). `
        + `morning_brief=${morningBrief ? 'yes' : 'no'} journal=${journal ? 'yes' : 'no'} `
        + `scorecard ${scorecardSummary.wins}W/${scorecardSummary.partials}P/${scorecardSummary.neutrals}N/${scorecardSummary.losses}L`,
      outcome: upsertErr ? `upsert_failed:${upsertErr.message.slice(0, 80)}` : reportOutcome,
      linked_brief_id: morningBrief?.id ?? null,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: costUsd,
    });
  } catch (e) {
    console.warn('[ct-eod-report] decision journal insert failed:', String(e));
  }

  if (upsertErr) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'upsert_failed',
      detail: upsertErr.message,
      session_date: sessionDate,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // ===========================================================================
  // STEP 9 — Slack push (best-effort).
  // ===========================================================================

  let slackPushed = false;
  let slackError: string | null = null;

  if (!skipSlack && slackEnabled !== false) {
    try {
      const { data: users } = await sb.from('profiles').select('id').limit(1);
      const userId = users?.[0]?.id as string | undefined;
      if (userId) {
        const ss = scorecardSummary;
        const total = ss.wins + ss.partials + ss.neutrals + ss.losses;
        const regime = (reportRow.regime_close as string) ?? 'untagged';
        const shift = reportRow.regime_shift_today ?? 'stable';
        const regimeLine = !shift || shift === 'stable' ? regime : `${regime} (${shift})`;
        const scorecardLine = total > 0
          ? `Morning brief ${ss.wins + ss.partials}/${total} ✓ — ${ss.wins}W ${ss.partials}P ${ss.losses}L ${ss.neutrals}N`
          : 'No morning brief to grade';

        const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
        const carryLines = arr(reportRow.carryover_themes).slice(0, 3)
          .map(t => `• ${String(t).slice(0, 280)}`).join('\n');
        const overnightLines = (arr(reportRow.overnight_catalysts) as Array<Record<string, unknown>>).slice(0, 3)
          .map(c => {
            const tickers = Array.isArray(c.tickers) ? (c.tickers as string[]).join(', ') : '';
            return `:bell: ${String(c.when ?? '').slice(0, 60)}: ${String(c.event ?? '').slice(0, 200)}${tickers ? ` · ${tickers}` : ''}`;
          }).join('\n');
        const watchlistLine = (arr(reportRow.tomorrow_watchlist) as Array<Record<string, unknown>>).slice(0, 6)
          .map(w => {
            const t = String(w.ticker ?? '').toUpperCase();
            const p = String(w.priority ?? '').toLowerCase();
            return p === 'high' ? `*${t}*` : p === 'low' ? `_${t}_` : t;
          }).join(' · ') || '—';
        const skipLine = (arr(reportRow.skip_tomorrow) as Array<Record<string, unknown>>).slice(0, 6)
          .map(s => String(s.ticker ?? '').toUpperCase()).filter(Boolean).join(', ') || '—';
        const lessonsLines = arr(reportRow.lessons_today).slice(0, 3)
          .map(l => `• ${String(l).slice(0, 280)}`).join('\n');

        const blocks: Array<Record<string, unknown>> = [
          { type: 'header', text: { type: 'plain_text', text: `EOD Wrap · ${dayNameFromYmd(sessionDate)} ${sessionDate}`, emoji: true } },
          { type: 'divider' },
          { type: 'section', fields: [
            { type: 'mrkdwn', text: `*Regime*\n${regimeLine}` },
            { type: 'mrkdwn', text: `*Scorecard*\n${scorecardLine}` },
          ]},
        ];
        if (carryLines) blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `:link: *Carryover*\n${carryLines}` } });
        if (overnightLines) blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `*Overnight*\n${overnightLines}` } });
        blocks.push({ type: 'divider' }, { type: 'section', fields: [
          { type: 'mrkdwn', text: `*Tomorrow*\n${watchlistLine}` },
          { type: 'mrkdwn', text: `*Skip*\n${skipLine}` },
        ]});
        if (lessonsLines) blocks.push({ type: 'divider' }, { type: 'section', text: { type: 'mrkdwn', text: `:brain: *Lessons*\n${lessonsLines}` } });
        blocks.push({ type: 'actions', elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'View report', emoji: true },
          url: 'https://www.linkjac.cloud/eod-report',
          action_id: 'view_eod_report',
        }]});
        blocks.push({ type: 'context', elements: [
          { type: 'mrkdwn', text: `model: ${CLAUDE_MODELS.sonnet} · $${reportRow.cost_usd.toFixed(4)} · ${PROMPT_VERSION}` },
        ]});

        const fallbackText = `EOD Wrap ${sessionDate}: ${regimeLine} · ${scorecardLine}`;
        await ctSlackPushDirect(supabase, userId, fallbackText, `eod_report_${sessionDate}`, blocks);
        slackPushed = true;
      }
    } catch (e) {
      slackError = e instanceof Error ? e.message : String(e);
      console.warn('[ct-eod-report] slack push failed (non-blocking):', slackError);
    }
  }

  // ===========================================================================
  // STEP 10 — Return body.
  // ===========================================================================

  const carryoverCount = Array.isArray(reportRow.carryover_themes) ? reportRow.carryover_themes.length : 0;
  const catalystCount = Array.isArray(reportRow.overnight_catalysts) ? reportRow.overnight_catalysts.length : 0;
  const watchlistCount = Array.isArray(reportRow.tomorrow_watchlist) ? reportRow.tomorrow_watchlist.length : 0;
  const skipCount = Array.isArray(reportRow.skip_tomorrow) ? reportRow.skip_tomorrow.length : 0;

  return new Response(JSON.stringify({
    ok: true,
    session_date: sessionDate,
    report_id: upserted?.id ?? null,
    triggered_by: triggeredBy,
    morning_brief_present: !!morningBrief,
    journal_present: !!journal,
    scorecard_summary: scorecardSummary,
    carryover_count: carryoverCount,
    catalyst_count: catalystCount,
    watchlist_count: watchlistCount,
    skip_count: skipCount,
    cost_usd: reportRow.cost_usd,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    duration_ms: Date.now() - startedAt,
    slack_pushed: slackPushed,
    slack_error: slackError,
    fetch_warnings: fetchWarnings,
    prompt_version: PROMPT_VERSION,
    temporal_validator: {
      ok: validatorOk,
      contradiction_count: validatorContradictions.length,
      critical_count: validatorContradictions.filter(c => c.severity === 'critical').length,
    },
  }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
