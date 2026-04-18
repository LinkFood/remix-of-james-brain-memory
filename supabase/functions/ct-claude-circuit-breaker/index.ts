/**
 * ct-claude-circuit-breaker — intra-day safety layer for Claude's autonomous
 * book. Every 5 min during RTH we evaluate three halt conditions and write a
 * ct_claude_circuit_breakers row when any trip.  Gated functions
 * (ct-trade-idea-generator + ct-claude-book-writer) consult
 * is_claude_trading_halted() before doing work.  Exit-watcher is NOT gated —
 * existing positions must still close on stops/targets.
 *
 * Breakers:
 *   1) session_loss         — (realized + unrealized) / starting_balance * 100
 *                             <= claude_session_loss_halt_pct (negative)
 *   2) hallucination_rate   — ct_claude_decisions.hallucination_flag=true count
 *                             in the last hour >= claude_max_hallucinations_per_hour
 *   3) concurrent_cascade   — ct_trades with trader='claude' AND
 *                             close_reason='stopped_out' AND opened_at > now-30m
 *                             count >= 3
 *
 * Auto-clear: at the start of each run we sweep any open breaker rows whose
 * session_date < today and flip them to cleared (auto_cleared=true).
 *
 * Every trip also writes a ct_claude_decisions row with
 * decision_type='circuit_breaker_tripped' so the thought-stream shows Claude
 * knew it was halted.
 *
 * Auth: service role only. Called by pg_cron every 5 min during RTH.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getConfig } from '../_shared/configCache.ts';

type BreakerType = 'session_loss' | 'hallucination_rate' | 'concurrent_cascade';

interface BreakerTrip {
  tripped: boolean;
  trigger_value?: number;
  threshold?: number;
  reason?: string;
}

/** Today's America/New_York date as YYYY-MM-DD — matches ct_book seeding. */
function nySessionDate(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
}

/** Pull latest spot from heartbeats → gex_timeseries fallback. */
async function resolveSpot(supabase: SupabaseClient, ticker: string): Promise<number | null> {
  const { data: hbRows } = await supabase
    .from('ct_heartbeats')
    .select('current_reads')
    .order('created_at', { ascending: false })
    .limit(1);
  const reads = hbRows?.[0]?.current_reads as Record<string, unknown> | null | undefined;
  if (reads && typeof reads === 'object') {
    const per = reads[ticker] as Record<string, unknown> | undefined;
    const spot = per && typeof per === 'object' ? (per.spot ?? per.price ?? per.underlying_price) : undefined;
    const p = typeof spot === 'number' ? spot : typeof spot === 'string' ? parseFloat(spot) : NaN;
    if (Number.isFinite(p)) return p;
  }
  const { data: gex } = await supabase
    .from('ct_ticker_snapshots')
    .select('spot')
    .eq('ticker', ticker)
    .maybeSingle();
  if (typeof gex?.spot === 'number' && Number.isFinite(gex.spot)) return gex.spot;
  const { data: g2 } = await supabase
    .from('ct_gex_timeseries')
    .select('underlying_price')
    .eq('ticker', ticker)
    .order('snapshot_at', { ascending: false })
    .limit(1);
  const up = g2?.[0]?.underlying_price;
  if (typeof up === 'number' && Number.isFinite(up)) return up;
  return null;
}

/** Check if an open breaker already exists for today for this breaker_type. */
async function hasActiveBreaker(
  supabase: SupabaseClient,
  sessionDate: string,
  breakerType: BreakerType | 'heartbeat_stale' | 'manual_halt' | 'session_loss',
): Promise<boolean> {
  const { count, error } = await supabase
    .from('ct_claude_circuit_breakers')
    .select('id', { count: 'exact', head: true })
    .eq('session_date', sessionDate)
    .eq('breaker_type', breakerType)
    .is('cleared_at', null);
  if (error) {
    console.warn('[ct-claude-circuit-breaker] hasActiveBreaker error:', error.message);
    return false;
  }
  return (count ?? 0) > 0;
}

/** Trip a breaker: insert breaker row + decision journal row. */
async function tripBreaker(
  supabase: SupabaseClient,
  sessionDate: string,
  breakerType: BreakerType,
  trip: BreakerTrip,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const reason = trip.reason ?? `${breakerType} tripped`;
  const { data, error } = await supabase
    .from('ct_claude_circuit_breakers')
    .insert({
      session_date:  sessionDate,
      breaker_type:  breakerType,
      trigger_value: trip.trigger_value ?? null,
      threshold:     trip.threshold ?? null,
      reason,
    })
    .select('id')
    .single();
  if (error || !data) {
    return { ok: false, error: error?.message ?? 'insert failed' };
  }
  // Thought-stream row so Claude "knew" it was halted.
  await supabase.from('ct_claude_decisions').insert({
    decision_type: 'circuit_breaker_tripped',
    model_tier:    'none',
    reasoning:     reason,
    outcome:       `breaker=${breakerType} trigger=${trip.trigger_value ?? 'n/a'} threshold=${trip.threshold ?? 'n/a'}`,
    context_snapshot: {
      breaker_type:  breakerType,
      session_date:  sessionDate,
      trigger_value: trip.trigger_value,
      threshold:     trip.threshold,
    },
  });
  return { ok: true, id: data.id as string };
}

/** Auto-clear any still-open breaker rows from prior sessions. */
async function autoClearStaleBreakers(supabase: SupabaseClient, today: string): Promise<number> {
  const { data, error } = await supabase
    .from('ct_claude_circuit_breakers')
    .update({ cleared_at: new Date().toISOString(), auto_cleared: true })
    .is('cleared_at', null)
    .lt('session_date', today)
    .select('id');
  if (error) {
    console.warn('[ct-claude-circuit-breaker] autoClear error:', error.message);
    return 0;
  }
  const n = data?.length ?? 0;
  if (n > 0) {
    await supabase.from('ct_claude_decisions').insert({
      decision_type: 'circuit_breaker_cleared',
      model_tier:    'none',
      reasoning:     `auto-cleared ${n} stale breaker row(s) from prior session(s)`,
      outcome:       `cleared=${n}`,
    });
  }
  return n;
}

/** Compute Claude's session P&L % (realized + unrealized, intra-day). */
async function computeSessionPnlPct(
  supabase: SupabaseClient,
  sessionDate: string,
): Promise<{ total_pct: number | null; realized: number; unrealized: number; starting_balance: number | null }> {
  // Book row for today.
  const { data: bookRow } = await supabase
    .from('ct_book')
    .select('starting_balance, realized_pnl, ending_balance')
    .eq('trader', 'claude')
    .eq('session_date', sessionDate)
    .maybeSingle();
  const starting = (bookRow?.starting_balance as number | undefined) ?? null;
  const realized = (bookRow?.realized_pnl as number | undefined) ?? 0;

  if (starting == null || starting <= 0) {
    return { total_pct: null, realized, unrealized: 0, starting_balance: starting };
  }

  // Unrealized: sum across open Claude trades.
  const { data: openTrades } = await supabase
    .from('ct_trades')
    .select('id, instrument, side, entry_price, size_usd')
    .eq('trader', 'claude')
    .eq('status', 'open');

  let unrealized = 0;
  for (const t of openTrades ?? []) {
    const spot = await resolveSpot(supabase, t.instrument as string);
    if (spot == null) continue;
    const entry = Number(t.entry_price);
    const sizeUsd = Number(t.size_usd);
    if (!Number.isFinite(entry) || !Number.isFinite(sizeUsd) || entry <= 0) continue;
    const moveFrac = t.side === 'long' ? (spot - entry) / entry : (entry - spot) / entry;
    unrealized += sizeUsd * moveFrac;
  }

  const totalPct = ((realized + unrealized) / starting) * 100;
  return {
    total_pct: Number.isFinite(totalPct) ? +totalPct.toFixed(4) : null,
    realized,
    unrealized: +unrealized.toFixed(2),
    starting_balance: starting,
  };
}

/** Session-loss breaker check. Halt threshold is NEGATIVE. */
async function checkSessionLoss(
  supabase: SupabaseClient,
  sessionDate: string,
  haltPct: number,
): Promise<{ status: 'no_book' | 'insufficient_data' | 'ok' | 'tripped'; detail: Record<string, unknown> }> {
  const pnl = await computeSessionPnlPct(supabase, sessionDate);
  if (pnl.starting_balance == null) {
    return { status: 'no_book', detail: { ...pnl } };
  }
  if (pnl.total_pct == null) {
    return { status: 'insufficient_data', detail: { ...pnl } };
  }
  if (pnl.total_pct <= haltPct) {
    const reason = `session loss ${pnl.total_pct.toFixed(2)}% exceeds ${haltPct}% halt threshold ` +
      `(realized=${pnl.realized.toFixed(2)} unrealized=${pnl.unrealized.toFixed(2)} starting=${pnl.starting_balance})`;
    const result = await tripBreaker(supabase, sessionDate, 'session_loss', {
      tripped:       true,
      trigger_value: pnl.total_pct,
      threshold:     haltPct,
      reason,
    });
    return { status: 'tripped', detail: { ...pnl, breaker_insert: result } };
  }
  return { status: 'ok', detail: { ...pnl, threshold: haltPct } };
}

/** Hallucination-rate breaker check — 1h rolling window. */
async function checkHallucinationRate(
  supabase: SupabaseClient,
  sessionDate: string,
  maxPerHour: number,
): Promise<{ status: 'ok' | 'tripped'; detail: Record<string, unknown> }> {
  const oneHourAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  const { count, error } = await supabase
    .from('ct_claude_decisions')
    .select('id', { count: 'exact', head: true })
    .eq('hallucination_flag', true)
    .gte('created_at', oneHourAgo);
  if (error) {
    console.warn('[ct-claude-circuit-breaker] hallucination query error:', error.message);
    return { status: 'ok', detail: { error: error.message } };
  }
  const n = count ?? 0;
  if (n >= maxPerHour) {
    const reason = `hallucinations in last 1h = ${n}, threshold = ${maxPerHour}`;
    const result = await tripBreaker(supabase, sessionDate, 'hallucination_rate', {
      tripped:       true,
      trigger_value: n,
      threshold:     maxPerHour,
      reason,
    });
    return { status: 'tripped', detail: { count: n, threshold: maxPerHour, breaker_insert: result } };
  }
  return { status: 'ok', detail: { count: n, threshold: maxPerHour } };
}

/** Concurrent-cascade breaker — 3+ stop-outs in the last 30m. */
async function checkConcurrentCascade(
  supabase: SupabaseClient,
  sessionDate: string,
): Promise<{ status: 'ok' | 'tripped'; detail: Record<string, unknown> }> {
  const threshold = 3;
  const cutoff = new Date(Date.now() - 30 * 60_000).toISOString();
  const { count, error } = await supabase
    .from('ct_trades')
    .select('id', { count: 'exact', head: true })
    .eq('trader', 'claude')
    .eq('close_reason', 'stopped_out')
    .gt('opened_at', cutoff);
  if (error) {
    console.warn('[ct-claude-circuit-breaker] cascade query error:', error.message);
    return { status: 'ok', detail: { error: error.message } };
  }
  const n = count ?? 0;
  if (n >= threshold) {
    const reason = `concurrent cascade: ${n} stopped_out trades in last 30m (threshold ${threshold})`;
    const result = await tripBreaker(supabase, sessionDate, 'concurrent_cascade', {
      tripped:       true,
      trigger_value: n,
      threshold,
      reason,
    });
    return { status: 'tripped', detail: { count: n, threshold, breaker_insert: result } };
  }
  return { status: 'ok', detail: { count: n, threshold } };
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Service role required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  const sessionDate = nySessionDate();

  // 0) Auto-clear prior-session open breakers first.
  const autoCleared = await autoClearStaleBreakers(supabase, sessionDate);

  // Load thresholds (cached).
  const haltPct    = Number(await getConfig<number>('claude_session_loss_halt_pct', -2.0));
  const hallucMax  = Number(await getConfig<number>('claude_max_hallucinations_per_hour', 3));

  // Short-circuit: each breaker only trips once per session. Skip if already active.
  const report: Record<string, unknown> = {
    session_date: sessionDate,
    auto_cleared: autoCleared,
    breakers: {} as Record<string, unknown>,
  };

  // 1) session_loss
  if (await hasActiveBreaker(supabase, sessionDate, 'session_loss')) {
    (report.breakers as Record<string, unknown>).session_loss = { status: 'already_tripped' };
  } else {
    (report.breakers as Record<string, unknown>).session_loss =
      await checkSessionLoss(supabase, sessionDate, haltPct);
  }

  // 2) hallucination_rate
  if (await hasActiveBreaker(supabase, sessionDate, 'hallucination_rate')) {
    (report.breakers as Record<string, unknown>).hallucination_rate = { status: 'already_tripped' };
  } else {
    (report.breakers as Record<string, unknown>).hallucination_rate =
      await checkHallucinationRate(supabase, sessionDate, hallucMax);
  }

  // 3) concurrent_cascade
  if (await hasActiveBreaker(supabase, sessionDate, 'concurrent_cascade')) {
    (report.breakers as Record<string, unknown>).concurrent_cascade = { status: 'already_tripped' };
  } else {
    (report.breakers as Record<string, unknown>).concurrent_cascade =
      await checkConcurrentCascade(supabase, sessionDate);
  }

  const body = {
    ok: true,
    ...report,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-claude-circuit-breaker]', JSON.stringify(body));
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
