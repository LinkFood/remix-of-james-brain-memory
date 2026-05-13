/**
 * ct-daily-brief — Sonnet's morning PM-tier world-view.
 *
 * Wave F of the Claude Co-Trader Phase 1 build. One authoritative brief per
 * session-morning (7am ET on weekdays) plus urgent re-briefs when Tavily picks
 * up a severity>=4 event. Every brief carries per-ticker cards that
 * DECOMPOSE narrative_view + tape_view + alignment — this decomposition is
 * the lesson the engine needs most (tape-vs-narrative resolution).
 *
 * Flow:
 *   1. Load context via buildClaudeContext (heartbeat, open hypotheses,
 *      Claude's own closed trades, grades, open ideas, news, principles).
 *   2. Additionally pull:
 *      - Last 24h ct_breaking_news WHERE severity >= 3
 *      - Upcoming ct_events (next 7d)
 *      - Latest ct_ticker_snapshots per watchlist ticker (if populated)
 *      - Last session Claude closed trades for "yesterday recap"
 *   3. Call Claude Sonnet with forced tool-use `emit_brief(...)`.
 *   4. Persist one ct_daily_briefs row. If body.supersedes_id is set (or a
 *      re-brief is in progress), brief_version = prior.version + 1 and
 *      urgency 'high' (or 'acute' for severity-5 triggers).
 *   5. Log a ct_claude_decisions row (decision_type = brief_generated |
 *      brief_rebriefed).
 *
 * Body: { triggered_by?: 'scheduled' | 'breaking_news' | 'manual' | 'regime_shift',
 *         reason?: string,
 *         supersedes_id?: string }
 *
 * Auth: service role only. Called by pg_cron and ct-tavily-news-watcher.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import {
  callClaude,
  CLAUDE_MODELS,
  parseToolUse,
  parseTextContent,
  ClaudeError,
  calculateCost,
} from '../_shared/anthropic.ts';
import { logClaudeUsage } from '../_shared/claudeUsageLog.ts';
import { getConfig } from '../_shared/configCache.ts';
import { getWatchlist } from '../_shared/watchlist.ts';
import {
  buildClaudeContext,
  claudeSystemPromptPreamble,
} from '../_shared/claudeReadSurface.ts';
import { ctSlackPushDirect } from '../_shared/ctSlack.ts';
import { now as clockNow, dayNameInTz, relativeDayTag, dateInTz } from '../_shared/clock.ts';
import { getTemporalContext } from '../_shared/temporalContext.ts';
import { validateTemporalCoherence } from '../_shared/temporalValidator.ts';
import { getFlowHeatmapContext } from '../_shared/flowHeatmapContext.ts';

type Triggered = 'scheduled' | 'breaking_news' | 'manual' | 'regime_shift';

interface TickerCard {
  ticker: string;
  regime?: string;
  tilt?: string;                   // 'long_lean' | 'short_lean' | 'neutral' | ...
  catalysts?: string[];
  focus?: number;                  // 1 (ignore) .. 5 (primary)
  avoid_today?: boolean;
  narrative_view?: string;         // what the story / flow / macro says
  tape_view?: string;              // what price / gamma / flow-of-funds says
  alignment?: 'aligned' | 'conflict' | 'partial' | 'insufficient_data';
  confidence_multiplier?: number;  // 0.5 .. 1.5 applied downstream to idea sizing
  rationale?: string;
}

interface HighConvictionIdea {
  instrument: string;
  direction: 'long' | 'short';
  entry_zone: string;
  stop: string;
  target: string;
  size_pct: number;
  rationale: string;
  hypothesis_id?: string | null;
}

interface BriefPayload {
  macro_narrative: string;
  macro_regime?: string;
  breaking_events?: Array<{ headline: string; severity: number; source?: string; time?: string }>;
  overnight_action?: string;
  recent_prints?: Array<{ name: string; value: string | number; delta?: string; at?: string }>;
  per_ticker: TickerCard[];
  convergent_view: string;
  high_conviction_ideas?: HighConvictionIdea[];
  watchlist_focus?: string[];
  skip_today?: string[];
}

// ---------------------------------------------------------------------------
// Tool schema — forced tool-use guarantees a structured response.
// ---------------------------------------------------------------------------
const EMIT_BRIEF_TOOL = {
  name: 'emit_brief',
  description: 'Emit the structured morning brief. You MUST call this tool exactly once. Do not respond in prose.',
  input_schema: {
    type: 'object',
    required: ['macro_narrative', 'per_ticker', 'convergent_view'],
    properties: {
      macro_narrative: {
        type: 'string',
        description: 'One-paragraph world-view for the day (5-8 sentences). Set the scene: macro regime, positioning, what the overnight tape says.',
      },
      macro_regime: {
        type: 'string',
        description: "Short label: 'risk-off' | 'risk-on' | 'chop' | 'pre-fed' | 'vol-expansion' | 'vol-contraction' | 'breadth-divergence' | etc.",
      },
      breaking_events: {
        type: 'array',
        description: 'Top 1-5 breaking events from the last 24h that matter to the watchlist today.',
        items: {
          type: 'object',
          properties: {
            headline: { type: 'string' },
            severity: { type: 'integer', minimum: 1, maximum: 5 },
            source: { type: 'string' },
            time: { type: 'string' },
          },
          required: ['headline', 'severity'],
        },
      },
      overnight_action: {
        type: 'string',
        description: 'Short paragraph summarizing futures, fx, commodities, and overnight news tone.',
      },
      recent_prints: {
        type: 'array',
        description: 'Recent macro prints (CPI, NFP, ISM) with value + delta-vs-consensus if available.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            value: { type: 'string' },
            delta: { type: 'string' },
            at: { type: 'string' },
          },
          required: ['name', 'value'],
        },
      },
      per_ticker: {
        type: 'array',
        description: 'One card per watchlist ticker. MUST separately enumerate narrative_view, tape_view, and alignment. This decomposition is mandatory — it is how the engine learns tape-vs-narrative resolution.',
        items: {
          type: 'object',
          required: ['ticker', 'narrative_view', 'tape_view', 'alignment'],
          properties: {
            ticker:                { type: 'string' },
            regime:                { type: 'string' },
            tilt:                  { type: 'string', description: "'long_lean' | 'short_lean' | 'neutral' | 'avoid'" },
            catalysts:             { type: 'array', items: { type: 'string' } },
            focus:                 { type: 'integer', minimum: 1, maximum: 5 },
            avoid_today:           { type: 'boolean' },
            narrative_view:        { type: 'string', description: 'What the story / flow / macro say about this ticker today.' },
            tape_view:             { type: 'string', description: 'What price / gamma / positioning / flow-of-funds say.' },
            alignment:             { type: 'string', enum: ['aligned', 'conflict', 'partial', 'insufficient_data'] },
            confidence_multiplier: { type: 'number', minimum: 0.5, maximum: 1.5, description: 'Downstream size multiplier. 1.0 neutral. Higher = more conviction, lower = fade.' },
            rationale:             { type: 'string' },
          },
        },
      },
      convergent_view: {
        type: 'string',
        description: 'The one-paragraph convergent read: where narrative and tape agree, where they disagree, and which way you are leaning today overall.',
      },
      high_conviction_ideas: {
        type: 'array',
        description: '0-3 actionable ideas. Zero is valid — better to pass than force.',
        items: {
          type: 'object',
          required: ['instrument', 'direction', 'entry_zone', 'stop', 'target', 'size_pct', 'rationale'],
          properties: {
            instrument:    { type: 'string' },
            direction:     { type: 'string', enum: ['long', 'short'] },
            entry_zone:    { type: 'string' },
            stop:          { type: 'string' },
            target:        { type: 'string' },
            size_pct:      { type: 'number', minimum: 0, maximum: 10 },
            rationale:     { type: 'string' },
            hypothesis_id: { type: 'string', description: 'Optional — link to an open ct_hypotheses row if this trade tests one.' },
          },
        },
      },
      watchlist_focus: {
        type: 'array',
        description: 'Tickers to lean into today.',
        items: { type: 'string' },
      },
      skip_today: {
        type: 'array',
        description: 'Tickers to avoid today.',
        items: { type: 'string' },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Context pulls that buildClaudeContext doesn't cover
// ---------------------------------------------------------------------------
async function pullBreakingNews(supabase: SupabaseClient) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('ct_breaking_news')
    .select('id, headline, url, source, severity, sentiment, tickers_affected, macro_wide, category, summary, ingested_at, published_at')
    .gte('ingested_at', since)
    .gte('severity', 3)
    .order('severity', { ascending: false })
    .order('ingested_at', { ascending: false })
    .limit(40);
  return data ?? [];
}

async function pullUpcomingEvents(supabase: SupabaseClient, todayYmd: string) {
  // Horizon = today + 7 calendar days, anchored in ET (matches todayYmd).
  const horizonDate = new Date(`${todayYmd}T12:00:00Z`);
  horizonDate.setUTCDate(horizonDate.getUTCDate() + 7);
  const horizonYmd = horizonDate.toISOString().slice(0, 10);
  // ct_events schema varies slightly by release; select a wide superset via *
  const { data, error } = await supabase
    .from('ct_events')
    .select('*')
    .gte('event_date', todayYmd)
    .lte('event_date', horizonYmd)
    .order('event_date', { ascending: true })
    .limit(50);
  if (error) {
    console.warn('[daily-brief] ct_events pull failed:', error.message);
    return [];
  }
  return data ?? [];
}

async function pullTickerSnapshots(supabase: SupabaseClient, watchlist: string[]) {
  const { data } = await supabase
    .from('ct_ticker_snapshots')
    .select('*')
    .in('ticker', watchlist);
  return data ?? [];
}

async function pullYesterdayClosedTrades(supabase: SupabaseClient) {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data } = await supabase
    .from('ct_trades')
    .select('id, instrument, side, size_pct, entry_price, stop_price, target_price, thesis, status, realized_pnl, opened_at, closed_at')
    .eq('trader', 'claude')
    .eq('status', 'closed')
    .gte('closed_at', since)
    .order('closed_at', { ascending: false })
    .limit(20);
  return data ?? [];
}

async function findPriorBriefToday(
  supabase: SupabaseClient,
  sessionDate: string,
): Promise<{ id: string; brief_version: number; urgency: string } | null> {
  const { data } = await supabase
    .from('ct_daily_briefs')
    .select('id, brief_version, urgency')
    .eq('session_date', sessionDate)
    .order('brief_version', { ascending: false })
    .limit(1);
  return (data?.[0] as { id: string; brief_version: number; urgency: string } | undefined) ?? null;
}

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

  // Parse body (optional)
  let triggeredBy: Triggered = 'scheduled';
  let reason: string | undefined;
  let supersedesIdHint: string | undefined;
  try {
    const body = await req.json();
    const t = body?.triggered_by;
    if (t === 'scheduled' || t === 'breaking_news' || t === 'manual' || t === 'regime_shift') {
      triggeredBy = t;
    }
    if (typeof body?.reason === 'string') reason = body.reason.slice(0, 500);
    if (typeof body?.supersedes_id === 'string') supersedesIdHint = body.supersedes_id;
  } catch { /* empty body is fine */ }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  try {
    // Anchor today in ET FIRST — every downstream date computation (event window,
    // relative-time tagging, persisted session_date) keys off this. UTC slice
    // rolls over hours before midnight ET and off-by-ones the session date late
    // afternoon. The brief fires at 7 AM ET; ET is the unambiguous frame.
    const etNow = clockNow('America/New_York');
    const sessionDate = etNow.date;             // YYYY-MM-DD in ET
    const sessionDayName = dayNameInTz(sessionDate);
    const etTimeStr = etNow.time;               // HH:MM in ET
    const utcTimeStr = etNow.iso.slice(11, 16); // HH:MM in UTC

    // ------- CONTEXT -------
    const watchlist = await getWatchlist(supabase);
    const ttlHours = Number(await getConfig<number>('claude_brief_ttl_hours', 8));

    const [ctx, breakingNews, upcomingEvents, snapshots, recentClosed, flowHeatmapContext] = await Promise.all([
      buildClaudeContext(supabase, {
        audience: 'cotrader',
        consumerName: 'ct-daily-brief',
        heartbeatLimit: 3,
        openHypothesisLimit: 25,
        hypothesisEventLimit: 30,
        closedTradeLimit: 20,
        gradeLimit: 15,
      }),
      pullBreakingNews(supabase),
      pullUpcomingEvents(supabase, sessionDate),
      pullTickerSnapshots(supabase, watchlist),
      pullYesterdayClosedTrades(supabase),
      getFlowHeatmapContext(supabase, watchlist, { consumerName: 'ct-daily-brief' }),
    ]);

    // Temporal anchor — tool-use JSON consumer, so use the SHORT variant.
    // The full preamble has narrative-style instructions that confuse models
    // asked for strict tool-use JSON (proven on hypothesis-health-check).
    // See _shared/temporalContext.ts.
    const tctx = getTemporalContext();

    // Figure out urgency before calling Claude.
    let urgency: 'normal' | 'elevated' | 'high' | 'acute' = 'normal';
    if (triggeredBy === 'breaking_news' || triggeredBy === 'regime_shift' || supersedesIdHint) {
      const maxSev = breakingNews.reduce((m: number, r: { severity?: number }) => Math.max(m, Number(r.severity) || 0), 0);
      urgency = maxSev >= 5 ? 'acute' : 'high';
    }

    // Provisional brief_version + supersedes_id for the Claude context snapshot.
    // The PERSISTED values come from ct_insert_daily_brief_locked under an
    // advisory lock — the lock and atomic SELECT-MAX-then-INSERT live in the
    // RPC so they can fence a same-second race that supabase-js can't fence
    // across separate statements. If a concurrent fire races between this
    // provisional read and the locked INSERT, the model sees a slightly stale
    // prior_brief_version; the persisted chain stays correct.
    let supersedesId: string | null = supersedesIdHint ?? null;
    let briefVersion = 1;
    const provisionalPrior = await findPriorBriefToday(supabase, sessionDate);
    if (provisionalPrior) {
      briefVersion = provisionalPrior.brief_version + 1;
      if (supersedesId === null) supersedesId = provisionalPrior.id;
    }

    // ------- PRE-RESOLVE EVENT DATES TO RELATIVE-TIME TAGS -------
    // The model must NEVER receive a raw `event_date` again — it sees a pre-baked
    // relative-time descriptor. This makes "tomorrow vs today" hallucination
    // structurally impossible: there's nothing for the model to compute.
    type RawEvent = {
      event_type?: string | null;
      ticker?: string | null;
      event_date?: string | null;
      event_time?: string | null;       // 'HH:MM:SS+TZ' or null
      title?: string | null;
      importance?: number | null;
      report_time?: string | null;      // 'bmo' | 'amc' | 'intraday' | null
    };
    const formatEventTime = (e: RawEvent): string => {
      // Earnings: prefer report_time bucket label.
      if (e.event_type === 'earnings') {
        if (e.report_time === 'bmo')      return 'pre-open';
        if (e.report_time === 'amc')      return 'post-close';
        if (e.report_time === 'intraday') return 'intraday';
      }
      // Otherwise: extract HH:MM from event_time if present and label as ET
      // (UW/econ calendar publishes in ET).
      if (e.event_time) {
        const m = /^(\d{2}):(\d{2})/.exec(e.event_time);
        if (m) return `${m[1]}:${m[2]} ET`;
      }
      return '';
    };
    const taggedUpcomingEvents = (upcomingEvents as RawEvent[]).map((e) => {
      const ymd = (e.event_date ?? '').slice(0, 10);
      const dayTag = ymd ? relativeDayTag(ymd, sessionDate) : 'UNKNOWN_DATE';
      const timeTag = formatEventTime(e);
      const when = timeTag ? `**${dayTag} ${timeTag}**` : `**${dayTag}**`;
      return {
        when,                          // pre-tagged: the only date the model should reason from
        day_tag: dayTag,               // 'TODAY' | 'TOMORROW' | '+5 days' | etc
        time_tag: timeTag || null,     // 'pre-open' | 'post-close' | '14:00 ET' | null
        event_type: e.event_type ?? null,
        ticker: e.ticker ?? null,
        title: e.title ?? null,
        importance: e.importance ?? null,
      };
    });

    // Pre-resolve breaking-news timestamps too. published_at can be hours-old or
    // days-old; ingested_at is the floor. We tag both with relative-day labels so
    // the LLM never has to reason "is this published_at today?".
    type RawNews = {
      id?: string;
      headline?: string | null;
      url?: string | null;
      source?: string | null;
      severity?: number | null;
      sentiment?: string | null;
      tickers_affected?: string[] | null;
      macro_wide?: boolean | null;
      category?: string | null;
      summary?: string | null;
      ingested_at?: string | null;
      published_at?: string | null;
    };
    const tagIso = (iso: string | null | undefined): string => {
      if (!iso) return 'UNKNOWN_TIME';
      const ymd = dateInTz(iso, 'America/New_York');
      const dayTag = relativeDayTag(ymd, sessionDate);
      const hhmm = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', hour12: false,
      }).format(new Date(iso));
      return `**${dayTag} ${hhmm} ET**`;
    };
    const taggedBreakingNews = (breakingNews as RawNews[]).slice(0, 25).map((n) => ({
      when: tagIso(n.published_at ?? n.ingested_at ?? null),
      headline: n.headline ?? null,
      severity: n.severity ?? null,
      source: n.source ?? null,
      sentiment: n.sentiment ?? null,
      tickers_affected: n.tickers_affected ?? null,
      macro_wide: n.macro_wide ?? null,
      category: n.category ?? null,
      summary: n.summary ?? null,
      url: n.url ?? null,
    }));

    // ------- PROMPT -------
    const preamble = claudeSystemPromptPreamble(ctx);
    const system = [
      tctx.temporalAnchorShort,
      '',
      preamble,
      '',
      `**Today is ${sessionDate} (${sessionDayName}).** Current time: ${etTimeStr} ET (${utcTimeStr} UTC).`,
      'All event dates that match today are TODAY. Tomorrow = today + 1 day. Yesterday = today - 1 day.',
      'Every event in `upcoming_events_7d` and `breaking_news_24h` already carries a pre-resolved `when` field tagged **TODAY** / **TOMORROW** / **YESTERDAY** / **+N days** / **-N days**. Use that tag verbatim in your prose. Do NOT compute relative dates from raw timestamps — the tag is authoritative.',
      'Per-ticker `catalysts` strings MUST also reference these tags (e.g. "**TODAY** earnings post-close", not "Earnings tomorrow").',
      '',
      'ROLE: You are the Morning PM. Produce today\'s world-view, per-ticker cards, and a convergent view with 0-3 high-conviction ideas.',
      '',
      'RULES:',
      '  - You MUST emit your output via the `emit_brief` tool. Do not reply in prose.',
      '  - The per_ticker array MUST include one card per watchlist ticker. Every card MUST separately name narrative_view, tape_view, and alignment. This decomposition is how the engine learns tape-vs-narrative resolution — do not collapse them into one field.',
      '  - Zero high_conviction_ideas is a valid answer. Better to pass than force a weak trade.',
      '  - Be specific. Cite levels (spot, gamma flip, call/put walls) from the per-ticker snapshots when available.',
      '  - When narrative and tape disagree, say so explicitly in `alignment` and let convergent_view explain which you are leaning with and why.',
      triggeredBy !== 'scheduled'
        ? `  - THIS IS A ${urgency.toUpperCase()} RE-BRIEF triggered by ${triggeredBy}${reason ? ` — ${reason}` : ''}. Weight the new information heavily; re-score any ideas that are now stale.`
        : '  - This is the scheduled morning brief.',
    ].join('\n');

    // Trim the payload to keep context bounded — Claude doesn't need everything.
    const contextPayload = {
      triggered_by: triggeredBy,
      reason: reason ?? null,
      urgency,
      session_date: sessionDate,
      session_day_name: sessionDayName,
      now_et: etTimeStr,
      now_utc: utcTimeStr,
      watchlist,
      // Wave J: quote the most recent CIO weekly review into brief context.
      // Claude should weave tactical_notes into macro_narrative and lean
      // watchlist_focus toward focus_tickers / skip_today toward avoid_tickers.
      latest_weekly_review: ctx.latestWeeklyReview,
      latest_heartbeat: ctx.latestHeartbeat,
      recent_heartbeats: ctx.recentHeartbeats,
      open_hypotheses: ctx.openHypotheses.slice(0, 20).map((h) => ({
        id: h.id,
        claim: h.claim,
        horizon: h.horizon,
        tickers: h.tickers,
        confidence: h.confidence,
        elo: h.elo,
      })),
      recent_claude_grades: (ctx as unknown as { recentGrades?: unknown }).recentGrades ?? null,
      claude_closed_trades_48h: recentClosed,
      // PRE-TAGGED — every entry carries a `when` field anchored against today.
      // Raw event_date / published_at deliberately NOT included; the LLM should
      // never see them and never have to compute relative time.
      breaking_news_24h: taggedBreakingNews,
      upcoming_events_7d: taggedUpcomingEvents,
      ticker_snapshots: snapshots,
      // Flow heatmap — POSITIONING REGIME (168h, aggressive-directional decay).
      // Top 3 expiry-week stacks per watchlist ticker by abs(value). Mirrors
      // ct-eod-summary / ct-eod-report wires.
      flow_heatmap_per_ticker: flowHeatmapContext.per_ticker,
      flow_heatmap_meta: {
        generated_at: flowHeatmapContext.generated_at,
        lookback_hours: flowHeatmapContext.lookback_hours,
        math_mode: flowHeatmapContext.math_mode,
      },
      supersedes_id: supersedesId,
      prior_brief_version: briefVersion - 1,
    };

    // ------- CLAUDE CALL -------
    const claudeStart = Date.now();
    let response;
    try {
      response = await callClaude({
        model: CLAUDE_MODELS.sonnet,
        system,
        messages: [{ role: 'user', content: JSON.stringify(contextPayload) }],
        tools: [EMIT_BRIEF_TOOL as unknown as Record<string, unknown>],
        tool_choice: { type: 'tool', name: 'emit_brief' },
        max_tokens: 4096,
        temperature: 0.3,
      });
    } catch (e) {
      const msg = e instanceof ClaudeError ? `Claude ${e.status}: ${e.message}` : String(e);
      console.error('[daily-brief] Claude call failed:', msg);
      return new Response(JSON.stringify({ error: 'claude_failed', detail: msg }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const tool = parseToolUse(response);
    if (!tool || tool.name !== 'emit_brief') {
      const fallbackText = parseTextContent(response);
      console.error('[daily-brief] no tool_use block. Fallback text:', fallbackText.slice(0, 300));
      return new Response(JSON.stringify({ error: 'no_tool_use', text: fallbackText.slice(0, 500) }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const payload = tool.input as unknown as BriefPayload;

    // Light validation
    if (!payload?.macro_narrative || !Array.isArray(payload.per_ticker) || !payload.convergent_view) {
      console.error('[daily-brief] payload missing required fields');
      return new Response(JSON.stringify({ error: 'invalid_payload', payload }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Scrub & normalize
    const scrubTickerCard = (c: TickerCard): TickerCard => ({
      ...c,
      ticker: String(c.ticker || '').toUpperCase(),
      focus: c.focus != null ? Math.max(1, Math.min(5, Math.round(Number(c.focus)))) : undefined,
      confidence_multiplier: c.confidence_multiplier != null
        ? Math.max(0.5, Math.min(1.5, Number(c.confidence_multiplier)))
        : undefined,
    });
    const perTicker = (payload.per_ticker ?? []).map(scrubTickerCard);
    const ideas = (payload.high_conviction_ideas ?? []).slice(0, 5);

    // ------- TEMPORAL VALIDATOR (best-effort) -------
    // Validate the narrative strings (macro_narrative + convergent_view +
    // per_ticker rationales) against session_date. Critical contradictions log
    // a warning and ride along on ct_claude_decisions.context_snapshot.
    let validatorOk = true;
    let validatorContradictions: Array<{ quote: string; issue: string; severity: 'critical' | 'warning' }> = [];
    const narrativeForValidation = [
      payload.macro_narrative ?? '',
      payload.convergent_view ?? '',
      payload.overnight_action ?? '',
      ...perTicker.map(c => `${c.ticker}: ${c.narrative_view ?? ''} ${c.tape_view ?? ''} ${c.rationale ?? ''}`),
    ].filter(s => typeof s === 'string' && s.trim().length > 0).join('\n\n---\n\n');
    if (narrativeForValidation) {
      try {
        const validation = await validateTemporalCoherence(narrativeForValidation, tctx.session_date);
        validatorOk = validation.ok;
        validatorContradictions = validation.contradictions;
        const critical = validation.contradictions.filter(c => c.severity === 'critical');
        if (critical.length > 0) {
          console.warn(
            `[ct-daily-brief] temporal validator flagged ${critical.length} CRITICAL contradiction(s) for session ${tctx.session_date}:`,
            JSON.stringify(critical),
          );
        } else if (!validation.ok && validation.contradictions.length > 0) {
          console.warn(
            `[ct-daily-brief] temporal validator flagged ${validation.contradictions.length} warning(s):`,
            JSON.stringify(validation.contradictions),
          );
        }
      } catch (e) {
        console.warn('[ct-daily-brief] temporal validator threw (non-blocking):', String(e));
      }
    }
    const temporalValidatorWarnings = {
      ok: validatorOk,
      session_date: tctx.session_date,
      contradiction_count: validatorContradictions.length,
      critical_count: validatorContradictions.filter(c => c.severity === 'critical').length,
      contradictions: validatorContradictions,
    };

    // ------- PERSIST -------
    // Single RPC fences the race: pg_advisory_xact_lock on session_date,
    // SELECT MAX(brief_version), INSERT — all in one transaction. UNIQUE
    // (session_date, brief_version) is the DB-layer backstop.
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
    const { data: insertedRows, error: insertErr } = await supabase.rpc(
      'ct_insert_daily_brief_locked',
      {
        p_session_date: sessionDate,
        p_triggered_by: triggeredBy,
        p_urgency: urgency,
        p_supersedes_id_hint: supersedesIdHint ?? null,
        p_payload: {
          macro_narrative: payload.macro_narrative,
          macro_regime: payload.macro_regime ?? null,
          breaking_events: payload.breaking_events ?? [],
          overnight_action: payload.overnight_action ?? null,
          recent_prints: payload.recent_prints ?? [],
          per_ticker: perTicker,
          convergent_view: payload.convergent_view,
          high_conviction_ideas: ideas,
          watchlist_focus: payload.watchlist_focus ?? [],
          skip_today: payload.skip_today ?? [],
          generated_by_model: 'sonnet',
          ttl_hours: ttlHours,
          expires_at: expiresAt,
        },
      },
    );

    const inserted = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;
    if (insertErr || !inserted) {
      console.error('[daily-brief] insert failed:', insertErr?.message);
      return new Response(JSON.stringify({ error: 'insert_failed', detail: insertErr?.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Persisted values may differ from provisional if a concurrent fire raced.
    briefVersion = inserted.brief_version;
    supersedesId = inserted.supersedes_id ?? null;

    // Claude usage log
    const tokensIn = response.usage?.input_tokens ?? 0;
    const tokensOut = response.usage?.output_tokens ?? 0;
    const costUsd = calculateCost(CLAUDE_MODELS.sonnet, { input_tokens: tokensIn, output_tokens: tokensOut });
    logClaudeUsage({
      source: 'ct-daily-brief',
      model: CLAUDE_MODELS.sonnet,
      usage: { input_tokens: tokensIn, output_tokens: tokensOut },
      duration_ms: Date.now() - claudeStart,
      metadata: {
        brief_id: inserted.id,
        brief_version: inserted.brief_version,
        triggered_by: triggeredBy,
        urgency,
      },
    }, supabase as unknown as { from: (t: string) => { insert: (r: Record<string, unknown>) => Promise<unknown> } });

    // Decision journal
    try {
      await supabase.from('ct_claude_decisions').insert({
        decision_type: briefVersion === 1 ? 'brief_generated' : 'brief_rebriefed',
        model_tier: 'sonnet',
        context_snapshot: {
          triggered_by: triggeredBy,
          reason: reason ?? null,
          brief_version: briefVersion,
          urgency,
          supersedes_id: supersedesId,
          watchlist_count: watchlist.length,
          breaking_news_count: breakingNews.length,
          upcoming_events_count: upcomingEvents.length,
          snapshots_count: snapshots.length,
          closed_trades_48h: recentClosed.length,
          flow_heatmap_per_ticker: flowHeatmapContext.per_ticker,
          flow_heatmap_meta: {
            generated_at: flowHeatmapContext.generated_at,
            lookback_hours: flowHeatmapContext.lookback_hours,
            math_mode: flowHeatmapContext.math_mode,
          },
          temporal_validator_warnings: temporalValidatorWarnings,
        },
        reasoning: `Generated ${urgency} brief v${briefVersion} for ${sessionDate} (triggered_by=${triggeredBy})${reason ? ` — ${reason}` : ''}. per_ticker=${perTicker.length} ideas=${ideas.length}`,
        outcome: `brief_id=${inserted.id} version=${briefVersion} ideas=${ideas.length}`,
        linked_brief_id: inserted.id,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
      });
    } catch (e) {
      console.warn('[daily-brief] decision journal insert failed:', String(e));
    }

    // If this was a re-brief, link the breaking-news row that triggered it
    // back to the new brief so we can trace (reason-headline → rebrief_id).
    if ((triggeredBy === 'breaking_news' || triggeredBy === 'regime_shift') && reason) {
      try {
        await supabase
          .from('ct_breaking_news')
          .update({ rebrief_id: inserted.id })
          .eq('triggers_rebrief', true)
          .is('rebrief_id', null)
          .ilike('headline', `%${reason.slice(0, 100)}%`);
      } catch {
        /* best effort */
      }
    }

    // ----- Slack push (best-effort, never throws) ------------------------------
    // Fires once per fresh insert (v1 scheduled + every rebrief). Brief is
    // already persisted above — Slack failure must not regress the save.
    let slackOutcome: 'sent' | 'skipped_no_user' | 'error' = 'skipped_no_user';
    try {
      const { data: users } = await supabase.from('profiles').select('id').limit(1);
      const userId = users?.[0]?.id as string | undefined;

      if (userId) {
        const regimeStr = payload.macro_regime ?? 'unspecified';
        const versionTag = briefVersion > 1 ? ` · v${briefVersion}` : '';
        const urgencyTag = urgency !== 'normal' ? ` · ${urgency.toUpperCase()}` : '';
        // v1 scheduled = morning brief. v1 manual / v2+ rebriefs get distinct labels
        // so the Slack title doesn't say "Morning Brief" at 2pm when a breaking-news
        // rebrief fires.
        const titleNoun =
          briefVersion === 1 && triggeredBy === 'scheduled' ? 'Morning Brief'
          : triggeredBy === 'breaking_news' ? 'Rebrief — Breaking News'
          : triggeredBy === 'regime_shift' ? 'Rebrief — Regime Shift'
          : briefVersion > 1 ? 'Rebrief'
          : 'Brief';
        const headerText = `Co-Trader ${titleNoun} · ${sessionDate} · ${regimeStr}${versionTag}${urgencyTag}`;

        // Macro narrative — single mrkdwn section, Slack truncates ~3000 chars.
        const macroText = String(payload.macro_narrative || '').slice(0, 2800);

        const breakingLines = (payload.breaking_events ?? [])
          .slice(0, 6)
          .map((e) => {
            const sev = Number(e?.severity ?? 0);
            const headline = String(e?.headline ?? '').slice(0, 240);
            return `• ${headline} (sev ${sev})`;
          })
          .join('\n');

        const ideasLines = (ideas as HighConvictionIdea[])
          .slice(0, 5)
          .map((i) => {
            const dir = String(i?.direction ?? '').toUpperCase();
            const inst = String(i?.instrument ?? '').slice(0, 80);
            const entry = String(i?.entry_zone ?? '').slice(0, 80);
            const target = String(i?.target ?? '').slice(0, 80);
            const stop = String(i?.stop ?? '').slice(0, 80);
            const size = Number(i?.size_pct ?? 0);
            const rationale = String(i?.rationale ?? '').slice(0, 320);
            return `• *${dir} ${inst}* · entry ${entry} · target ${target} · stop ${stop} · ${size}% — ${rationale}`;
          })
          .join('\n');

        const focusChips = (payload.watchlist_focus ?? []).slice(0, 12).join(' · ') || '—';
        const skipChips = (payload.skip_today ?? []).slice(0, 12).join(' · ') || '—';

        const convergentText = String(payload.convergent_view || '').slice(0, 2400);

        const expiresShort = expiresAt.slice(0, 16).replace('T', ' ') + 'Z';
        const footerText = `Generated by ${'sonnet'}${reason ? ` · ${reason.slice(0, 80)}` : ''} · expires ${expiresShort} · <https://www.linkjac.cloud/morning-brief|/morning-brief>`;

        const blocks: Array<Record<string, unknown>> = [
          { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
        ];

        if (macroText.length > 0) {
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:newspaper: *Macro*\n${macroText}` } });
        }

        if (breakingLines.length > 0) {
          blocks.push({ type: 'divider' });
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:rotating_light: *Breaking events (24h)*\n${breakingLines}` } });
        }

        if (ideasLines.length > 0) {
          blocks.push({ type: 'divider' });
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:dart: *High-conviction ideas*\n${ideasLines}` } });
        } else {
          blocks.push({ type: 'divider' });
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:dart: *High-conviction ideas*\n_None — pass-day call._` } });
        }

        blocks.push({ type: 'divider' });
        blocks.push({
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Watchlist focus*\n${focusChips}` },
            { type: 'mrkdwn', text: `*Skip today*\n${skipChips}` },
          ],
        });

        if (convergentText.length > 0) {
          blocks.push({ type: 'divider' });
          blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `:thought_balloon: *Convergent view*\n${convergentText}` } });
        }

        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: footerText }],
        });

        const fallbackText = `Co-Trader ${titleNoun} ${sessionDate} · ${regimeStr}${versionTag}${urgencyTag} · ${ideas.length} ideas`;
        await ctSlackPushDirect(supabase, userId, fallbackText, 'daily-brief', blocks);
        slackOutcome = 'sent';
      }
    } catch (e) {
      slackOutcome = 'error';
      console.warn('[daily-brief] slack push failed (non-blocking):', e instanceof Error ? e.message : String(e));
    }

    return new Response(
      JSON.stringify({
        ok: true,
        brief_id: inserted.id,
        session_date: inserted.session_date,
        brief_version: inserted.brief_version,
        urgency: inserted.urgency,
        triggered_by: inserted.triggered_by,
        supersedes_id: supersedesId,
        per_ticker_count: perTicker.length,
        high_conviction_ideas_count: ideas.length,
        convergent_view_preview: payload.convergent_view.slice(0, 240),
        slack: slackOutcome,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        cost_usd: costUsd,
        duration_ms: Date.now() - startedAt,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('[daily-brief] fatal:', e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
