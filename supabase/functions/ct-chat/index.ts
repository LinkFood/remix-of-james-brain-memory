/**
 * ct-chat — conversational interface for James to talk to Claude about
 * the tape. Called from the frontend ChatBox with user JWT auth.
 *
 * Input:
 *   { message: string, history: Array<{role: 'user'|'assistant', content: string}> }
 *
 * Pulls: latest heartbeat (condensed state), all theses, recent events
 * (last 10 obs/flags/alerts), and hands it all to Claude along with
 * chat history + new message.
 *
 * Output: { response: string, duration_ms: number }
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { extractUserId, isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, ClaudeError } from '../_shared/anthropic.ts';
import { CT_CHAT_SYSTEM } from '../_shared/chatPromptV1.ts';
import { logMcpCalls } from '../_shared/mcpLog.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Parse and execute a commit-trade command from chat.
 * Grammars accepted:
 *   commit SPY long 15% stop 708 target 712 [thesis: "..."]
 *   commit SPY 710C 4/18 long 5 @1.25 [stop 0.8 target 2.5] [thesis: "..."]
 */
async function handleCommitCommand(
  supabase: ReturnType<typeof createClient>,
  args: string,
): Promise<{ response: string; trade_id: string | null }> {
  const thesisMatch = args.match(/thesis[:\s]+"([^"]+)"|thesis[:\s]+(.+)$/i);
  const thesis = thesisMatch ? (thesisMatch[1] ?? thesisMatch[2] ?? '').trim() : '';
  const bare = thesisMatch ? args.replace(thesisMatch[0], '').trim() : args.trim();

  const tokens = bare.split(/\s+/);
  if (tokens.length < 3) {
    return { response: `commit parse error — usage: "commit SPY long 15% stop 708 target 712 thesis: '...'" or "commit SPY 710C 4/18 long 5 @1.25 thesis: '...'"`, trade_id: null };
  }

  const instrument = tokens[0].toUpperCase();
  // Detect option: token like 710C or 710P or 710c 4/18
  const optMatch = tokens[1].match(/^(\d+(?:\.\d+)?)([CPcp])$/);
  let rpcArgs: Record<string, unknown>;

  if (optMatch) {
    // Option trade: commit SPY 710C 4/18 long 5 @1.25
    const strike = parseFloat(optMatch[1]);
    const contractType = optMatch[2].toLowerCase() === 'c' ? 'call' : 'put';
    const exp = tokens[2]; // 4/18 or 2026-04-18
    const year = new Date().getUTCFullYear();
    let expiry: string;
    if (exp.includes('-')) expiry = exp;
    else if (exp.includes('/')) {
      const [m, d] = exp.split('/');
      expiry = `${year}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    } else {
      return { response: 'option expiry must be M/D or YYYY-MM-DD', trade_id: null };
    }
    const side = tokens[3]?.toLowerCase() === 'long' || tokens[3]?.toLowerCase() === 'short' ? tokens[3].toLowerCase() : 'long';
    const contracts = parseInt(tokens[4] ?? '1', 10);
    const premMatch = args.match(/@\s*(\d+(?:\.\d+)?)/);
    const entryPremium = premMatch ? parseFloat(premMatch[1]) : null;
    if (!entryPremium) return { response: 'option trade needs entry premium: @1.25', trade_id: null };
    const stopMatch = args.match(/stop\s+(\d+(?:\.\d+)?)/i);
    const targetMatch = args.match(/target\s+(\d+(?:\.\d+)?)/i);
    rpcArgs = {
      p_instrument: instrument,
      p_side: side,
      p_size_pct: 0,
      p_contract_type: contractType,
      p_strike: strike,
      p_expiry: expiry,
      p_contracts: contracts,
      p_entry_premium: entryPremium,
      p_entry_price: null,
      p_stop_price: stopMatch ? parseFloat(stopMatch[1]) : null,
      p_target_price: targetMatch ? parseFloat(targetMatch[1]) : null,
      p_thesis: thesis || `manual commit: ${instrument} ${strike}${optMatch[2].toUpperCase()} ${expiry}`,
      p_horizon: 'intraday',
      p_conviction: 3,
    };
  } else {
    // Underlying trade: commit SPY long 15% stop 708 target 712
    const side = tokens[1]?.toLowerCase();
    if (side !== 'long' && side !== 'short') {
      return { response: `second token must be 'long' or 'short'`, trade_id: null };
    }
    const sizeMatch = args.match(/(\d+(?:\.\d+)?)\s*%/);
    const sizePct = sizeMatch ? parseFloat(sizeMatch[1]) : 10;
    const stopMatch = args.match(/stop\s+(\d+(?:\.\d+)?)/i);
    const targetMatch = args.match(/target\s+(\d+(?:\.\d+)?)/i);
    rpcArgs = {
      p_instrument: instrument,
      p_side: side,
      p_size_pct: sizePct,
      p_contract_type: 'underlying',
      p_strike: null,
      p_expiry: null,
      p_contracts: null,
      p_entry_premium: null,
      p_entry_price: null, // book-manager will fill at current price on next tick
      p_stop_price: stopMatch ? parseFloat(stopMatch[1]) : null,
      p_target_price: targetMatch ? parseFloat(targetMatch[1]) : null,
      p_thesis: thesis || `manual ${side} ${instrument} ${sizePct}%`,
      p_horizon: 'intraday',
      p_conviction: 3,
    };
  }

  const { data, error } = await supabase.rpc('commit_manual_trade', rpcArgs);
  if (error) {
    return { response: `commit failed: ${error.message}`, trade_id: null };
  }
  const tradeId = (data as unknown) as string;
  const summary = optMatch
    ? `✓ committed ${instrument} ${rpcArgs.p_strike}${(rpcArgs.p_contract_type as string).toUpperCase()} ${rpcArgs.p_expiry} ${rpcArgs.p_side} ${rpcArgs.p_contracts} @${rpcArgs.p_entry_premium}`
    : `✓ committed ${instrument} ${rpcArgs.p_side} ${rpcArgs.p_size_pct}% stop=${rpcArgs.p_stop_price ?? '—'} target=${rpcArgs.p_target_price ?? '—'}`;
  return { response: `${summary}\ntrade_id: ${tradeId}\nbook-manager will manage on next :15 tick`, trade_id: tradeId };
}

/**
 * Detect whether the user's query is asking about very recent events.
 * Keyword heuristic — keeps things fast and cheap (no extra LLM call).
 */
const RECENT_QUERY_PATTERNS = [
  /\brecent(?:ly)?\b/i,
  /\bjust now\b/i,
  /\bjust happened\b/i,
  /\bright now\b/i,
  /\b\d+\s*min(?:ute)?s?\s+ago\b/i,
  /\bin the last\s+(?:hour|\d+\s*min(?:ute)?s?)\b/i,
  /\bpast\s+(?:hour|\d+\s*min(?:ute)?s?)\b/i,
  /\blast few (?:min(?:ute)?s|minutes)\b/i,
  /\bthis hour\b/i,
];

function isRecentQuery(message: string): boolean {
  return RECENT_QUERY_PATTERNS.some((rx) => rx.test(message));
}

/**
 * Extract likely instrument tickers from the user's message (uppercase 1–5 char
 * tokens). Used to scope the ct_similar_items RPC, which requires p_instrument.
 * Falls back to a small default set so general queries still recall.
 */
const DEFAULT_RECALL_INSTRUMENTS = ['SPY', 'QQQ'] as const;
const TICKER_STOPWORDS = new Set([
  'I', 'A', 'AM', 'PM', 'ET', 'UTC', 'OK', 'NO', 'YES', 'THE', 'AND', 'OR',
  'IF', 'IS', 'IT', 'TO', 'OF', 'ON', 'IN', 'AT', 'BY', 'DO', 'GO', 'MY',
  'ALL', 'ANY', 'SO', 'US', 'WE', 'UP', 'OUT', 'ARE', 'WAS', 'BE', 'ASK',
  'NOW', 'GET', 'SEE', 'HAS', 'HAD', 'CAN', 'WHY', 'HOW', 'WHO', 'BUT',
  'ITM', 'OTM', 'ATM', 'IV', 'OI', 'UW', 'AI', 'ML', 'ETF', 'PR', 'LLM',
]);

function extractInstruments(message: string): string[] {
  const matches = message.match(/\b[A-Z]{1,5}\b/g) ?? [];
  const out: string[] = [];
  for (const m of matches) {
    if (TICKER_STOPWORDS.has(m)) continue;
    if (!out.includes(m)) out.push(m);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Semantic recall over ct_embeddings via the ct_similar_items RPC.
 * Matches the call style in _shared/memoryRecall.ts#getSimilarPastSetups.
 * Best-effort — returns [] on any failure (never throws).
 *
 * Time-floor heuristic:
 *   - If message reads like "recently / just now / 10 min ago / in the last hour"
 *     → include rows from the last 60 min only.
 *   - Otherwise no time floor (so "what happened 10 min ago?" can actually recall
 *     fresh rows), with result count capped to avoid context bloat.
 */
async function recentSemanticHits(
  supabase: ReturnType<typeof createClient>,
  message: string,
): Promise<{ hits: Array<Record<string, unknown>>; timeFloorApplied: 'none' | '60min' }> {
  try {
    const queryEmb = await voyageEmbed(message, 'query');
    const instruments = extractInstruments(message);
    const targets = instruments.length > 0 ? instruments : [...DEFAULT_RECALL_INSTRUMENTS];

    const recent = isRecentQuery(message);
    const timeFloorApplied: 'none' | '60min' = recent ? '60min' : 'none';
    const cutoffIso = recent ? new Date(Date.now() - 60 * 60 * 1000).toISOString() : null;

    // Per-instrument RPC calls run in parallel. Shape matches
    // getSimilarPastSetups in _shared/memoryRecall.ts.
    const perInstrumentLimit = 6;
    const rpcResults = await Promise.all(targets.map(async (instrument) => {
      const { data, error } = await supabase.rpc('ct_similar_items', {
        p_instrument: instrument,
        p_query_embedding: queryEmb as unknown as string,
        p_limit: perInstrumentLimit,
      });
      if (error) {
        console.warn(`[ct-chat] ct_similar_items RPC failed for ${instrument}:`, error.message);
        return [] as Array<Record<string, unknown>>;
      }
      return (data ?? []) as Array<Record<string, unknown>>;
    }));

    // Merge, dedupe by (type:id), apply recent-window floor if heuristic fired,
    // sort by distance, cap at 7 so context doesn't bloat.
    const merged = new Map<string, Record<string, unknown>>();
    for (const rows of rpcResults) {
      for (const row of rows) {
        if (cutoffIso && typeof row.created_at === 'string' && row.created_at < cutoffIso) continue;
        const key = `${row.type}:${row.id}`;
        const prev = merged.get(key);
        if (!prev || (row.distance as number) < (prev.distance as number)) {
          merged.set(key, row);
        }
      }
    }

    const hits = [...merged.values()]
      .sort((a, b) => (a.distance as number) - (b.distance as number))
      .slice(0, 7)
      .map((r) => ({
        type: r.type,
        id: r.id,
        distance: typeof r.distance === 'number' ? Number((r.distance as number).toFixed(4)) : r.distance,
        timestamp: r.created_at,
        instrument: r.instrument ?? null,
        direction: r.claimed_direction ?? null,
        conviction: r.conviction ?? null,
        grade: r.verdict
          ? { verdict: r.verdict, actual_return_pct: r.actual_return_pct ?? null }
          : null,
      }));

    return { hits, timeFloorApplied };
  } catch (e) {
    console.warn('[ct-chat] recentSemanticHits failed:', e instanceof Error ? e.message : e);
    return { hits: [], timeFloorApplied: 'none' };
  }
}

async function buildContext(supabase: ReturnType<typeof createClient>) {
  const flowCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  const [heartbeat, theses, obs, flags, alerts, flow, dp, news] = await Promise.all([
    supabase.from('ct_heartbeats').select('status_line, current_reads, watching, created_at').order('created_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('ct_theses').select('instrument, direction, conviction, up_case, down_case, watching, rationale, updated_at'),
    supabase.from('ct_observations').select('id, instruments, direction, glance, created_at').order('created_at', { ascending: false }).limit(6),
    supabase.from('ct_flags').select('id, instruments, direction, conviction, horizon, glance, created_at').order('created_at', { ascending: false }).limit(6),
    supabase.from('ct_alerts').select('id, instruments, direction, conviction, horizon, alert_trigger, glance, created_at').order('created_at', { ascending: false }).limit(3),
    supabase.from('ct_flow_alerts').select('ticker, side, strike, expiry, is_otm, is_ask, size, premium, size_gt_oi, executed_at').gte('ingested_at', flowCutoff).order('premium', { ascending: false }).limit(25),
    supabase.from('ct_dark_pool_prints').select('ticker, size, price, notional_value, executed_at').gte('ingested_at', flowCutoff).order('notional_value', { ascending: false }).limit(25),
    supabase.from('ct_news_analyses').select('instrument, news_headline, impact, significance, claude_take, created_at').gte('significance', 3).order('created_at', { ascending: false }).limit(10),
  ]);

  // Condense heartbeat current_reads — only send the _snapshot (condensed state),
  // not the _macro blob with raw per-strike Greek vectors.
  const hb = heartbeat.data as { status_line?: string; current_reads?: Record<string, unknown>; created_at?: string } | null;
  const snapshot = hb?.current_reads?._snapshot ?? null;

  return {
    latest_status: hb?.status_line ?? null,
    latest_pulse_at: hb?.created_at ?? null,
    market_state: snapshot,
    theses: theses.data ?? [],
    recent_observations: obs.data ?? [],
    recent_flags: flags.data ?? [],
    recent_alerts: alerts.data ?? [],
    recent_flow_alerts_30min: flow.data ?? [],
    recent_dark_pool_prints_30min: dp.data ?? [],
    recent_significant_news: news.data ?? [],
  };
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  // Accept either authenticated user JWT or service role (for testing).
  let authorized = false;
  if (isServiceRoleRequest(req)) {
    authorized = true;
  } else {
    const { userId } = await extractUserId(req);
    if (userId) authorized = true;
  }
  if (!authorized) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const startedAt = Date.now();

  try {
    const body = await req.json().catch(() => ({}));
    const message = typeof body?.message === 'string' ? body.message.trim() : '';
    const history = Array.isArray(body?.history) ? (body.history as ChatMessage[]).slice(-10) : [];

    if (!message) {
      return new Response(JSON.stringify({ error: 'message required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Commit-trade slash command. Two grammars:
    //   commit SPY long 15% stop 708 target 712 [thesis: text]
    //   commit SPY 710C 4/18 long 5 @1.25 [stop 0.8 target 2.5] [thesis: text]
    const commitMatch = message.match(/^\s*\/?commit\s+(.*)$/i);
    if (commitMatch) {
      const args = commitMatch[1];
      const out = await handleCommitCommand(supabase, args);
      return new Response(JSON.stringify({ response: out.response, trade_id: out.trade_id, commit: true, duration_ms: 0 }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const [context, recall] = await Promise.all([
      buildContext(supabase),
      recentSemanticHits(supabase, message),
    ]);
    (context as Record<string, unknown>).recent_semantic_hits = recall.hits;
    const recallDebug = {
      query: message.slice(0, 200),
      semantic_hit_count: recall.hits.length,
      time_floor_applied: recall.timeFloorApplied,
    };

    // Prepend a context block as the first user turn so Claude sees live state
    // before any conversation history. Then real conversation, then new message.
    const contextBlock = `[LIVE STATE — injected by system, not a user message]\n${JSON.stringify(context, null, 2)}\n\n[END LIVE STATE]`;

    const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
      { role: 'user', content: contextBlock },
      { role: 'assistant', content: 'Got it. I have the current state loaded. What do you want to talk about?' },
      ...history,
      { role: 'user', content: message },
    ];

    let responseText = '';
    try {
      const uwKey = Deno.env.get('UW_API_KEY');
      const res = await callClaude({
        model: CLAUDE_MODELS.sonnet,   // better conversational reasoning than Haiku
        system: CT_CHAT_SYSTEM,
        messages,
        max_tokens: 1500,
        temperature: 0.4,
        // Live UW MCP — Claude can query any of UW's endpoints on demand during
        // the turn. Pairs our cached state with full-surface UW access.
        mcp_servers: uwKey ? [{
          type: 'url',
          url: 'https://api.unusualwhales.com/api/mcp',
          name: 'unusual-whales',
          authorization_token: uwKey,
        }] : undefined,
        beta: uwKey ? ['mcp-client-2025-04-04'] : undefined,
      });
      responseText = parseTextContent(res).trim();
      // Log every MCP call Claude made during this turn — user can audit.
      logMcpCalls(supabase, 'chat', res as unknown as { content?: unknown }, { user_id: null }).catch(() => { /* non-blocking */ });

      // Record cost + usage. Chat doesn't use agent_tasks, so write direct
      // to ct_chat_tokens. Fire-and-forget — never blocks the response.
      try {
        const usage = (res as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
        const content = (res as { content?: unknown[] }).content ?? [];
        const mcpCount = Array.isArray(content)
          ? content.filter((b) => (b as { type?: string }).type === 'mcp_tool_use').length
          : 0;
        const inTok = usage?.input_tokens ?? 0;
        const outTok = usage?.output_tokens ?? 0;
        // Sonnet 4: $3/M in, $15/M out.
        const cost = (inTok / 1_000_000) * 3 + (outTok / 1_000_000) * 15;
        supabase.from('ct_chat_tokens').insert({
          user_id: userId,
          model: 'sonnet',
          tokens_in: inTok,
          tokens_out: outTok,
          cost_usd: Number(cost.toFixed(6)),
          duration_ms: Date.now() - startedAt,
          mcp_calls: mcpCount,
          user_message: message.slice(0, 500),
          response_chars: responseText.length,
        }).then(() => { /* fire-and-forget */ });
      } catch (_e) { /* ignore token logging errors */ }
    } catch (e) {
      const detail = e instanceof ClaudeError ? `Claude ${e.status}` : String(e);
      console.error('[ct-chat] Claude failed:', detail);
      return new Response(JSON.stringify({ error: 'Claude call failed', detail }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      response: responseText || '(empty response)',
      duration_ms: Date.now() - startedAt,
      recall_debug: recallDebug,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ct-chat] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'chat failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
