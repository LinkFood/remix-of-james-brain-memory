/**
 * ct-tape-reader — Claude's running read of the tape.
 *
 * Scheduled every 10 minutes during RTH, plus event-driven interrupts when
 * specialists fire high-conviction (score >= 80) flags. Reads the last 10
 * minutes of scored flow + VIX + market tide + active flags, asks Claude
 * Haiku for a 2-3 sentence tape read, writes to ct_tape_commentary.
 *
 * The /tape banner shows the latest row; /tape-reader shows the day timeline.
 * Intentional design for self-improvement: commentary stores flow_ids +
 * flag_ids referenced + window bounds so we can later ask "what did the
 * reader say at 10:30 and what actually happened by 11:30?".
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, CLAUDE_RATES, ClaudeError } from '../_shared/anthropic.ts';

const WATCHLIST = ['SPY','QQQ','IWM','AAPL','MSFT','GOOGL','AMZN','META','NVDA','TSLA'];
const DEFAULT_WINDOW_MIN = 10;

interface ScoredFlowRow {
  id: number;
  ticker: string;
  option_symbol: string | null;
  event_ts: string;
  classification: string | null;
  direction: string | null;
  score: number | null;
  strike: number | null;
  expiry: string | null;
  dte: number | null;
  premium: number | null;
  volume: number | null;
  open_interest: number | null;
  ask_side_perc: number | null;
}

interface FlagRow {
  id: string;
  specialist_ticker: string;
  direction: string;
  score: number;
  thesis: string;
  status: string;
  option_symbol: string | null;
  created_at: string;
}

interface PriceBarRow {
  ticker: string;
  close: number | null;
  ts: string;
}

function parseOccSide(sym: string | null | undefined): string {
  if (!sym || sym.length < 9) return '';
  const ch = sym.charAt(sym.length - 9);
  if (ch === 'C' || ch === 'c') return 'C';
  if (ch === 'P' || ch === 'p') return 'P';
  return '';
}

function fmtContract(r: { ticker: string; option_symbol: string | null; strike: number | null; expiry: string | null }): string {
  const side = parseOccSide(r.option_symbol);
  const k = r.strike != null ? `$${r.strike}` : '?';
  const e = r.expiry ? r.expiry.slice(5).replace('-', '/') : '?';
  return `${r.ticker} ${k}${side} ${e}`;
}

function fmtPremium(n: number | null): string {
  if (n == null) return '?';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n}`;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const body = await req.json().catch(() => ({})) as {
    trigger_kind?: 'scheduled' | 'flag_interrupt' | 'manual';
    window_minutes?: number;
    flag_id?: string;
  };
  const trigger_kind = body.trigger_kind ?? 'scheduled';
  const windowMin = Math.min(Math.max(body.window_minutes ?? DEFAULT_WINDOW_MIN, 1), 60);

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMin * 60_000);

  // --- Pull context ------------------------------------------------------

  // Scored flow in window — top 15 by score DESC, then premium DESC
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: scoredRaw } = await (supabase.from('ct_scored_flow' as never) as any)
    .select('id,ticker,option_symbol,event_ts,classification,direction,score,strike,expiry,dte,premium,volume,open_interest,ask_side_perc')
    .gte('event_ts', windowStart.toISOString())
    .in('ticker', WATCHLIST)
    .order('score', { ascending: false })
    .order('premium', { ascending: false })
    .limit(15);
  const scored = (scoredRaw ?? []) as ScoredFlowRow[];

  // Recent flags (active / conviction) in last 30 min
  const flagsWindowStart = new Date(now.getTime() - 30 * 60_000);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: flagsRaw } = await (supabase.from('ct_flags' as never) as any)
    .select('id,specialist_ticker,direction,score,thesis,status,option_symbol,created_at')
    .in('status', ['active', 'conviction'])
    .gte('created_at', flagsWindowStart.toISOString())
    .order('created_at', { ascending: false })
    .limit(10);
  const flags = (flagsRaw ?? []) as FlagRow[];

  // Latest spot price per watchlist ticker
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: barsRaw } = await (supabase.from('ct_price_bars' as never) as any)
    .select('ticker,close,ts')
    .in('ticker', [...WATCHLIST, 'VIX'])
    .order('ts', { ascending: false })
    .limit(80);
  const bars = (barsRaw ?? []) as PriceBarRow[];
  const spotMap = new Map<string, number>();
  for (const b of bars) {
    if (b.close != null && !spotMap.has(b.ticker)) spotMap.set(b.ticker, b.close);
  }
  const vixLevel = spotMap.get('VIX') ?? null;

  // Market tide: sum of today's net_call_premium - net_put_premium across watchlist
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: tideRaw } = await (supabase.from('ct_net_premium_ticks' as never) as any)
    .select('ticker,net_call_premium,net_put_premium,tick_timestamp')
    .gte('tick_timestamp', todayStart.toISOString())
    .in('ticker', WATCHLIST);
  let netPrem = 0;
  for (const t of ((tideRaw ?? []) as Array<{ net_call_premium: number | null; net_put_premium: number | null }>)) {
    netPrem += (t.net_call_premium ?? 0) + (t.net_put_premium ?? 0);
  }
  const marketTide = netPrem > 5_000_000 ? 'bullish' : netPrem < -5_000_000 ? 'bearish' : 'flat';

  // --- Build prompt ------------------------------------------------------

  const lines: string[] = [];
  lines.push(`Window: ${windowMin} min ending ${now.toISOString()}`);
  lines.push(`VIX: ${vixLevel != null ? vixLevel.toFixed(2) : 'n/a'} | Tide: ${marketTide} (net ${fmtPremium(netPrem)})`);
  lines.push('');
  lines.push(`SPOT (latest close): ${WATCHLIST.map((t) => `${t} ${spotMap.get(t)?.toFixed(2) ?? '?'}`).join('  ')}`);
  lines.push('');

  if (scored.length > 0) {
    lines.push('TOP SCORED FLOW (score desc):');
    for (const r of scored) {
      const cls = r.classification ? ` ${r.classification}` : '';
      const dir = r.direction ? ` ${r.direction}` : '';
      const ask = r.ask_side_perc != null ? ` ask${Math.round(r.ask_side_perc)}%` : '';
      const vOi = (r.volume && r.open_interest) ? ` V/OI ${(r.volume / r.open_interest).toFixed(1)}x` : '';
      lines.push(`  ${fmtContract(r)} | score ${r.score ?? '?'}${dir}${cls} | ${fmtPremium(r.premium)}${vOi}${ask}`);
    }
  } else {
    lines.push('TOP SCORED FLOW: (nothing in window)');
  }

  if (flags.length > 0) {
    lines.push('');
    lines.push('ACTIVE SPECIALIST FLAGS (last 30 min):');
    for (const f of flags) {
      lines.push(`  ${f.specialist_ticker} ${f.direction} score ${Math.round(f.score)} [${f.status}]: ${f.thesis.slice(0, 160)}`);
    }
  }

  const system = `You are a senior options flow reader looking over a day trader's shoulder. You read the tape for the Mag-7 + major indexes. Write 2-3 sentences describing what's happening right now. No hedging, no disclaimers, no "this is not financial advice." If the tape is quiet, say "Quiet tape." and note what would change that. If something is unusual, name it specifically — ticker, contract, pattern. Every sentence must say something.`;

  const userMsg = lines.join('\n');

  // --- Call Claude -------------------------------------------------------

  let commentary = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let modelUsed = CLAUDE_MODELS.haiku;
  let apiError: string | null = null;

  try {
    const resp = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system,
      messages: [{ role: 'user', content: userMsg }],
      max_tokens: 400,
      temperature: 0.3,
    });
    const textBlock = resp.content.find((b) => b.type === 'text' && b.text);
    commentary = (textBlock?.text ?? '').trim();
    inputTokens = resp.usage?.input_tokens ?? 0;
    outputTokens = resp.usage?.output_tokens ?? 0;
    modelUsed = resp.model ?? modelUsed;
  } catch (e) {
    apiError = e instanceof ClaudeError ? `${e.status}: ${e.message}` : (e instanceof Error ? e.message : String(e));
    commentary = `[reader offline] ${apiError.slice(0, 200)}`;
  }

  // Cost
  const rate = CLAUDE_RATES[modelUsed as keyof typeof CLAUDE_RATES] ?? CLAUDE_RATES[CLAUDE_MODELS.haiku];
  const costUsd = (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;

  // --- Persist -----------------------------------------------------------

  const row = {
    trigger_kind,
    commentary,
    flow_ids: scored.map((r) => r.id),
    flag_ids: flags.map((f) => f.id),
    vix_level: vixLevel,
    market_tide: marketTide,
    window_start: windowStart.toISOString(),
    window_end: now.toISOString(),
    model: modelUsed,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from('ct_tape_commentary')
    .insert(row)
    .select('id,created_at')
    .single();

  return new Response(JSON.stringify({
    ok: !apiError,
    trigger_kind,
    id: inserted?.id,
    created_at: inserted?.created_at,
    commentary,
    flow_count: scored.length,
    flag_count: flags.length,
    vix_level: vixLevel,
    market_tide: marketTide,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cost_usd: row.cost_usd,
    model: modelUsed,
    api_error: apiError,
    insert_error: insertErr?.message ?? null,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
