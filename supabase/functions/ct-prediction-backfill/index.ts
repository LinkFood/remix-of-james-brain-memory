/**
 * ct-prediction-backfill — one-shot rewrite of `predicted_direction` and
 * `predicted_source` on every existing row of `ct_contract_tracks` and
 * `ct_print_tracks` using the current shared `inferDirection`.
 *
 * Why: commit 05792c0 fixed inferDirection to classify aggressive
 * accumulation prints (UW RepeatedHits rule, no explicit aggressor flag)
 * as bullish-on-call instead of `aggressive_bid_call`. The fix only applies
 * to NEW track creation. Existing rows still carry stale predictions, which
 * pollute `ct_signature_magnitude_stats` — the alarm-tier evaluator's
 * baseline. Until backfilled, calibration runs against wrong baselines.
 *
 * Idempotent: a second run produces zero updates because it uses the same
 * inference function over the same source flow alerts.
 *
 * Body params (all optional):
 *   { dry_run?: boolean,            // log only, no writes (default false)
 *     continuation_offset?: number, // resume from contract-tracks page (default 0)
 *     phase?: 'contract' | 'print' } // start phase (default 'contract')
 *
 * Returns done:false + next_phase + next_offset when it stops short of the
 * 150s wall so the caller can drive it to completion in a loop.
 *
 * Auth: service_role only.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { inferDirection, type FlowAlertRow } from '../_shared/directionInference.ts';

// ---------------------------------------------------------------------------
// Tunables — sized for 150s edge wall with safety margin.
// PostgREST hard-caps responses at 1000 rows, so PAGE_SIZE > 1000 is a no-op.
// Update batches stay small (100) because each is its own roundtrip.
// ---------------------------------------------------------------------------
const PAGE_SIZE = 1000;                  // PostgREST max per response
const ALERT_FETCH_CHUNK = 200;           // .in('alert_id', ...) batch size
const UPDATE_BATCH_SIZE = 100;           // updates fired sequentially per page
const SOFT_DEADLINE_MS = 120_000;        // bail at 120s of 150s wall

type Phase = 'contract' | 'print';

interface PhaseStats {
  table: string;
  total_scanned: number;
  unchanged: number;
  updated: number;
  bullish_to_bearish: number;
  bearish_to_bullish: number;
  null_to_set: number;
  set_to_null: number;
  errors: number;
  pages_processed: number;
  alert_fetch_failures: number;
}

interface TrackRow {
  id: string;
  alert_id: string;
  predicted_direction: string | null;
  predicted_source: string | null;
}

function newPhaseStats(table: string): PhaseStats {
  return {
    table,
    total_scanned: 0,
    unchanged: 0,
    updated: 0,
    bullish_to_bearish: 0,
    bearish_to_bullish: 0,
    null_to_set: 0,
    set_to_null: 0,
    errors: 0,
    pages_processed: 0,
    alert_fetch_failures: 0,
  };
}

interface UpdatePlan {
  id: string;
  alert_id: string;
  newDirection: string | null;
  newSource: string | null;
  oldDirection: string | null;
  oldSource: string | null;
}

// ---------------------------------------------------------------------------
// Process one page of a tracks table. Returns the page length so the caller
// knows when to break (last page short-circuit).
// ---------------------------------------------------------------------------
async function processPage(
  supabase: SupabaseClient,
  table: 'ct_contract_tracks' | 'ct_print_tracks',
  offset: number,
  pageSize: number,
  dryRun: boolean,
  stats: PhaseStats,
): Promise<{ pageLen: number; error: string | null }> {
  const end = offset + pageSize - 1;
  const { data: rows, error } = await supabase
    .from(table)
    .select('id, alert_id, predicted_direction, predicted_source')
    .order('id', { ascending: true })
    .range(offset, end);

  if (error) {
    stats.errors++;
    return { pageLen: 0, error: error.message };
  }
  if (!rows || rows.length === 0) {
    return { pageLen: 0, error: null };
  }

  const tracks = rows as TrackRow[];
  stats.total_scanned += tracks.length;
  stats.pages_processed++;

  // Bulk-fetch the source flow alerts for this page in chunks of 200.
  const alertById = new Map<string, FlowAlertRow>();
  const alertIds = tracks.map((t) => t.alert_id);
  for (let i = 0; i < alertIds.length; i += ALERT_FETCH_CHUNK) {
    const chunk = alertIds.slice(i, i + ALERT_FETCH_CHUNK);
    const { data: alerts, error: alertErr } = await supabase
      .from('ct_flow_alerts')
      .select('alert_id, ticker, side, is_ask, is_bid, strike, expiry, executed_at, ingested_at, raw')
      .in('alert_id', chunk);
    if (alertErr) {
      stats.alert_fetch_failures++;
      stats.errors++;
      continue;
    }
    for (const a of (alerts ?? []) as FlowAlertRow[]) {
      alertById.set(a.alert_id, a);
    }
  }

  // Plan updates by re-running inferDirection.
  const updates: UpdatePlan[] = [];
  for (const t of tracks) {
    const alert = alertById.get(t.alert_id);
    if (!alert) {
      // Source alert missing — leave row alone, don't write null over a value.
      stats.alert_fetch_failures++;
      continue;
    }
    const inf = inferDirection(alert);
    const newDirection = inf?.direction ?? null;
    const newSource = inf?.source ?? null;
    if (newDirection === t.predicted_direction && newSource === t.predicted_source) {
      stats.unchanged++;
      continue;
    }
    updates.push({
      id: t.id,
      alert_id: t.alert_id,
      newDirection,
      newSource,
      oldDirection: t.predicted_direction,
      oldSource: t.predicted_source,
    });
  }

  // Tally transition types upfront — same accounting whether dry_run or live.
  for (const u of updates) {
    if (u.oldDirection === null && u.newDirection !== null) stats.null_to_set++;
    else if (u.oldDirection !== null && u.newDirection === null) stats.set_to_null++;
    else if (u.oldDirection === 'up' && u.newDirection === 'down') stats.bullish_to_bearish++;
    else if (u.oldDirection === 'down' && u.newDirection === 'up') stats.bearish_to_bullish++;
  }

  if (dryRun) {
    stats.updated += updates.length;
    return { pageLen: tracks.length, error: null };
  }

  // Apply updates. NOT NULL constraint on tracks tables means we can't write
  // null over an existing value; skip those (rare — an alert that was once
  // inferable but no longer is would mean source data changed).
  for (let i = 0; i < updates.length; i += UPDATE_BATCH_SIZE) {
    const batch = updates.slice(i, i + UPDATE_BATCH_SIZE);
    for (const u of batch) {
      if (u.newDirection === null || u.newSource === null) {
        // Schema is NOT NULL — skip rather than fail loudly. Counts as error.
        stats.errors++;
        continue;
      }
      const { error: upErr } = await supabase
        .from(table)
        .update({
          predicted_direction: u.newDirection,
          predicted_source: u.newSource,
        })
        .eq('id', u.id);
      if (upErr) {
        stats.errors++;
        continue;
      }
      stats.updated++;
    }
  }

  return { pageLen: tracks.length, error: null };
}

// ---------------------------------------------------------------------------
// Walk an entire table from `offset` until exhausted or the soft deadline
// trips. Returns where we stopped so the caller can resume.
// ---------------------------------------------------------------------------
async function walkTable(
  supabase: SupabaseClient,
  table: 'ct_contract_tracks' | 'ct_print_tracks',
  startOffset: number,
  dryRun: boolean,
  startedAt: number,
): Promise<{ stats: PhaseStats; nextOffset: number; done: boolean }> {
  const stats = newPhaseStats(table);
  let offset = startOffset;
  while (true) {
    if (Date.now() - startedAt > SOFT_DEADLINE_MS) {
      return { stats, nextOffset: offset, done: false };
    }
    const { pageLen, error } = await processPage(
      supabase, table, offset, PAGE_SIZE, dryRun, stats,
    );
    if (error) {
      // Bubble up by stopping; caller can re-fire same offset.
      return { stats, nextOffset: offset, done: false };
    }
    if (pageLen === 0) {
      return { stats, nextOffset: offset, done: true };
    }
    offset += pageLen;
    if (pageLen < PAGE_SIZE) {
      // Last page short-circuit per postgrest pagination memory.
      return { stats, nextOffset: offset, done: true };
    }
  }
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;
  const corsHeaders = getCorsHeaders(req);
  const jsonHeaders = { ...corsHeaders, 'Content-Type': 'application/json' };

  const startedAt = Date.now();

  let body: Record<string, unknown> = {};
  try {
    if (req.method === 'POST') {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    }
  } catch {
    body = {};
  }

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'service_role required' }), {
      status: 401,
      headers: jsonHeaders,
    });
  }

  const dryRun = body.dry_run === true;
  const startPhase: Phase = (body.phase === 'print' ? 'print' : 'contract');
  const startOffset = typeof body.continuation_offset === 'number' ? body.continuation_offset : 0;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  const out: { contract?: PhaseStats; print?: PhaseStats } = {};
  let phase: Phase = startPhase;
  let offset = startOffset;
  let nextPhase: Phase | null = null;
  let nextOffset = 0;
  let done = true;

  if (phase === 'contract') {
    const r = await walkTable(supabase, 'ct_contract_tracks', offset, dryRun, startedAt);
    out.contract = r.stats;
    if (!r.done) {
      nextPhase = 'contract';
      nextOffset = r.nextOffset;
      done = false;
    } else {
      // Move to print phase.
      phase = 'print';
      offset = 0;
    }
  }

  if (done && phase === 'print') {
    const r = await walkTable(supabase, 'ct_print_tracks', offset, dryRun, startedAt);
    out.print = r.stats;
    if (!r.done) {
      nextPhase = 'print';
      nextOffset = r.nextOffset;
      done = false;
    }
  }

  return new Response(JSON.stringify({
    done,
    next_phase: nextPhase,
    next_offset: nextOffset,
    elapsed_ms: Date.now() - startedAt,
    dry_run: dryRun,
    stats: out,
  }, null, 2), { headers: jsonHeaders });
});
