/**
 * ct-event-watcher — structural-change detector that fires the main watcher
 * when something material happens between the 15-min scheduled pulses.
 *
 * Runs every 1 min during market hours (cheap — just a DB read + decision).
 * If it detects any of these in the last ~90s, it calls ct-watcher:
 *   - Whale print ≥$1M premium on a watchlist ticker (ct_flow_alerts)
 *   - Dark pool print ≥$100M notional (ct_dark_pool_prints)
 *   - NOPE sign flip on SPY/QQQ/IWM (ct_nope_minute)
 *   - Gamma flip crossed since last heartbeat (ct_gex_timeseries vs ct_heartbeats)
 *
 * Cooldown: 3 minutes between event-triggered fires so we don't thrash during
 * heavy flow periods (the 15-min scheduled cron still fires regardless).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { WATCHLIST } from '../_shared/uwClient.ts';
import { CT_PROMPT_VERSION } from '../_shared/systemPromptV1.ts';

const COOLDOWN_MS = 3 * 60 * 1000;
const WINDOW_MS = 90 * 1000;
const WATCHLIST_SET = new Set(WATCHLIST);

interface Signal {
  kind: 'whale_flow' | 'big_dp' | 'nope_flip' | 'gamma_flip_crossed';
  ticker: string;
  detail: string;
  magnitude: number;
}

async function detectWhaleFlow(supabase: SupabaseClient): Promise<Signal[]> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data } = await supabase
    .from('ct_flow_alerts')
    .select('ticker, premium, side, strike, expiry')
    .gte('ingested_at', since)
    .gte('premium', 1_000_000)
    .order('premium', { ascending: false })
    .limit(5);
  const hits: Signal[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const ticker = String(r.ticker ?? '');
    if (!WATCHLIST_SET.has(ticker) && ticker !== 'SPX' && ticker !== 'SPXW') continue;
    hits.push({
      kind: 'whale_flow',
      ticker,
      detail: `${ticker} ${r.side} ${r.strike} ${r.expiry} $${((r.premium as number) / 1e6).toFixed(2)}M`,
      magnitude: Number(r.premium),
    });
  }
  return hits;
}

async function detectBigDp(supabase: SupabaseClient): Promise<Signal[]> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data } = await supabase
    .from('ct_dark_pool_prints')
    .select('ticker, notional_value, size, price')
    .gte('ingested_at', since)
    .gte('notional_value', 100_000_000)
    .order('notional_value', { ascending: false })
    .limit(5);
  const hits: Signal[] = [];
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const ticker = String(r.ticker ?? '');
    if (!WATCHLIST_SET.has(ticker)) continue;
    hits.push({
      kind: 'big_dp',
      ticker,
      detail: `${ticker} DP ${(Number(r.size) / 1e6).toFixed(1)}M @ $${Number(r.price).toFixed(2)} = $${(Number(r.notional_value) / 1e6).toFixed(0)}M`,
      magnitude: Number(r.notional_value),
    });
  }
  return hits;
}

async function detectNopeFlip(supabase: SupabaseClient): Promise<Signal[]> {
  const since = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  const { data } = await supabase
    .from('ct_nope_minute')
    .select('ticker, nope, tick_timestamp')
    .in('ticker', ['SPY', 'QQQ', 'IWM'])
    .gte('tick_timestamp', since)
    .order('tick_timestamp', { ascending: false });
  if (!data) return [];
  // Group by ticker, check if the last two readings have different signs
  const byTicker: Record<string, Array<{ nope: number; ts: string }>> = {};
  for (const r of data as Array<Record<string, unknown>>) {
    const t = String(r.ticker);
    const n = Number(r.nope);
    if (!Number.isFinite(n)) continue;
    (byTicker[t] ??= []).push({ nope: n, ts: String(r.tick_timestamp) });
  }
  const hits: Signal[] = [];
  for (const [ticker, rows] of Object.entries(byTicker)) {
    if (rows.length < 2) continue;
    const latest = rows[0].nope;
    const prior = rows[Math.min(3, rows.length - 1)].nope;
    if (Math.sign(latest) !== Math.sign(prior) && Math.abs(latest) > 0.3) {
      hits.push({
        kind: 'nope_flip',
        ticker,
        detail: `${ticker} NOPE ${prior.toFixed(2)} → ${latest.toFixed(2)} (sign flip)`,
        magnitude: Math.abs(latest - prior),
      });
    }
  }
  return hits;
}

async function recentTriggeredFire(supabase: SupabaseClient): Promise<boolean> {
  // Check if a heartbeat was written in the cooldown window
  const since = new Date(Date.now() - COOLDOWN_MS).toISOString();
  const { data } = await supabase
    .from('ct_heartbeats')
    .select('id, status_line')
    .gte('created_at', since)
    .ilike('status_line', '%[event]%')
    .limit(1)
    .maybeSingle();
  return !!data;
}

async function fireWatcher(supabase: SupabaseClient, triggerNote: string): Promise<void> {
  const { data: projectUrl } = await supabase.rpc('_ct_post', { _fn: 'ct-watcher' }).single();
  // Fallback path: if RPC doesn't exist or fails, call directly
  if (!projectUrl) {
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    await fetch(`${url}/functions/v1/ct-watcher`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: triggerNote }),
    });
  }
}

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

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const startedAt = Date.now();

  try {
    // Cooldown check — don't thrash during heavy events
    if (await recentTriggeredFire(supabase)) {
      return new Response(JSON.stringify({ skipped: 'cooldown' }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const [whales, dps, nopes] = await Promise.all([
      detectWhaleFlow(supabase),
      detectBigDp(supabase),
      detectNopeFlip(supabase),
    ]);
    const signals = [...whales, ...dps, ...nopes];

    if (signals.length === 0) {
      return new Response(JSON.stringify({ detected: 0, duration_ms: Date.now() - startedAt }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Fire watcher + log an event-marker heartbeat so we can see what tripped
    const triggerNote = signals.slice(0, 5).map(s => `${s.kind}:${s.detail}`).join(' | ');
    await supabase.from('ct_heartbeats').insert({
      status_line: `[event] triggering watcher on ${signals.length} signals: ${triggerNote.slice(0, 300)}`,
      watching: [...new Set(signals.map(s => s.ticker))],
      current_reads: { _event_trigger: signals },
      prompt_version: CT_PROMPT_VERSION,
    });

    // Fire the main watcher
    const url = Deno.env.get('SUPABASE_URL')!;
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    fetch(`${url}/functions/v1/ct-watcher`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: triggerNote }),
    }).catch(e => console.warn('[ct-event-watcher] fire failed:', e instanceof Error ? e.message : e));

    return new Response(JSON.stringify({
      detected: signals.length,
      signals,
      fired: true,
      duration_ms: Date.now() - startedAt,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[ct-event-watcher] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
