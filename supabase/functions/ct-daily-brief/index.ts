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

async function pullUpcomingEvents(supabase: SupabaseClient) {
  const today = new Date().toISOString().slice(0, 10);
  const horizonIso = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  // ct_events schema varies slightly by release; select a wide superset via *
  const { data, error } = await supabase
    .from('ct_events')
    .select('*')
    .gte('event_date', today)
    .lte('event_date', horizonIso)
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
    // ------- CONTEXT -------
    const watchlist = await getWatchlist(supabase);
    const ttlHours = Number(await getConfig<number>('claude_brief_ttl_hours', 8));

    const [ctx, breakingNews, upcomingEvents, snapshots, recentClosed] = await Promise.all([
      buildClaudeContext(supabase, {
        heartbeatLimit: 3,
        openHypothesisLimit: 25,
        hypothesisEventLimit: 30,
        closedTradeLimit: 20,
        gradeLimit: 15,
      }),
      pullBreakingNews(supabase),
      pullUpcomingEvents(supabase),
      pullTickerSnapshots(supabase, watchlist),
      pullYesterdayClosedTrades(supabase),
    ]);

    const sessionDate = new Date().toISOString().slice(0, 10);

    // Figure out versioning + urgency before calling Claude.
    let supersedesId: string | null = supersedesIdHint ?? null;
    let briefVersion = 1;
    let urgency: 'normal' | 'elevated' | 'high' | 'acute' = 'normal';

    if (triggeredBy === 'breaking_news' || triggeredBy === 'regime_shift' || supersedesIdHint) {
      const prior = await findPriorBriefToday(supabase, sessionDate);
      if (prior) {
        supersedesId = supersedesId ?? prior.id;
        briefVersion = prior.brief_version + 1;
      }
      // Severity from recent breaking news drives urgency when relevant.
      const maxSev = breakingNews.reduce((m: number, r: { severity?: number }) => Math.max(m, Number(r.severity) || 0), 0);
      urgency = maxSev >= 5 ? 'acute' : 'high';
    }

    // ------- PROMPT -------
    const preamble = claudeSystemPromptPreamble(ctx);
    const system = [
      preamble,
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
      watchlist,
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
      breaking_news_24h: breakingNews.slice(0, 25),
      upcoming_events_7d: upcomingEvents,
      ticker_snapshots: snapshots,
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

    // ------- PERSIST -------
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
    const { data: inserted, error: insertErr } = await supabase
      .from('ct_daily_briefs')
      .insert({
        session_date: sessionDate,
        brief_version: briefVersion,
        triggered_by: triggeredBy,
        supersedes_id: supersedesId,
        urgency,
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
      })
      .select('id, brief_version, urgency, session_date, triggered_by')
      .maybeSingle();

    if (insertErr || !inserted) {
      console.error('[daily-brief] insert failed:', insertErr?.message);
      return new Response(JSON.stringify({ error: 'insert_failed', detail: insertErr?.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

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
