/**
 * ct-attention-backfill — one-shot backfill of attention_score for the
 * last 7 days of ct_observations / ct_flags / ct_alerts / ct_heartbeats.
 *
 * For each kind, walks rows with attention_score IS NULL in batches of 100,
 * derives a score using deriveWriteTimeAttention(), and updates in place.
 *
 * We do NOT run the full LinkGex ticker-score engine during backfill — that
 * would require per-ticker UW contract pulls for every historical row, which
 * is both costly and retrospectively meaningless (the snapshot is gone).
 * Instead we use the same cheap derivation ct-watcher uses at write time so
 * the historical timeline sorts consistently with the live stream.
 *
 * Auth: service role only. Returns counts by kind.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { deriveWriteTimeAttention } from '../_shared/attentionScore.ts';

const BATCH_SIZE = 100;
const LOOKBACK_DAYS = 7;

type Kind = 'observation' | 'flag' | 'alert' | 'heartbeat';

interface BackfillCounts {
  scanned: number;
  updated: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Row-to-score mappers (per table)
// ---------------------------------------------------------------------------

function scoreHeartbeat(): number {
  return deriveWriteTimeAttention({ state: 'HEARTBEAT' });
}

function scoreObservation(row: Record<string, unknown>): number {
  const glance = Array.isArray(row.glance) ? (row.glance as string[]) : [];
  const isInvalidation = typeof glance[0] === 'string' && glance[0].toUpperCase().startsWith('THESIS INVALIDAT');
  return deriveWriteTimeAttention({
    state: 'OBSERVATION',
    isInvalidation,
  });
}

function scoreFlag(row: Record<string, unknown>): number {
  const conviction = Number(row.conviction) || 2;
  const hasTradeSetup = !!row.trade_setup && typeof row.trade_setup === 'object';
  return deriveWriteTimeAttention({
    state: 'FLAG',
    conviction,
    hasTradeSetup,
  });
}

function scoreAlert(row: Record<string, unknown>): number {
  const alertTrigger = typeof row.alert_trigger === 'string' ? row.alert_trigger : null;
  const hasTradeSetup = !!row.trade_setup && typeof row.trade_setup === 'object';
  // convergence_count is computed live in the watcher — not persisted on the
  // alert row. Backfill treats historical rows as convergence_count=0 (the
  // live scorer already captured the true count at write time for new rows).
  return deriveWriteTimeAttention({
    state: 'ALERT',
    alertTrigger,
    convergenceCount: 0,
    hasTradeSetup,
  });
}

// ---------------------------------------------------------------------------
// Batch walker — generic shape so we can reuse it per table
// ---------------------------------------------------------------------------

async function backfillTable(
  supabase: SupabaseClient,
  table: string,
  columns: string,
  sinceIso: string,
  scorer: (row: Record<string, unknown>) => number,
): Promise<BackfillCounts> {
  let scanned = 0;
  let updated = 0;
  let errors  = 0;

  // Loop: fetch BATCH_SIZE nulls, update each, repeat until none remain.
  // We always re-query (rather than paginate by offset) because each UPDATE
  // removes rows from the "attention_score IS NULL" set, so offset would
  // start skipping over work.
  while (true) {
    const { data: rows, error: selErr } = await supabase
      .from(table)
      .select(columns)
      .is('attention_score', null)
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(BATCH_SIZE);

    if (selErr) {
      console.error(`[ct-attention-backfill] ${table} select failed:`, selErr.message);
      errors++;
      break;
    }
    if (!rows || rows.length === 0) break;

    scanned += rows.length;

    // Update each row with its derived score. We can't batch-update with
    // per-row values via PostgREST, so we fire BATCH_SIZE updates in
    // parallel — fast, and bounded by BATCH_SIZE.
    const updates = await Promise.all(
      (rows as Record<string, unknown>[]).map(async (row) => {
        try {
          const score = scorer(row);
          const { error: upErr } = await supabase
            .from(table)
            .update({ attention_score: score })
            .eq('id', row.id as string);
          if (upErr) {
            console.warn(`[ct-attention-backfill] ${table} update ${String(row.id).slice(0, 8)} failed:`, upErr.message);
            return false;
          }
          return true;
        } catch (e) {
          console.warn(`[ct-attention-backfill] ${table} scorer threw:`, e instanceof Error ? e.message : e);
          return false;
        }
      }),
    );
    const updatedThisBatch = updates.filter(Boolean).length;
    updated += updatedThisBatch;
    errors  += updates.length - updatedThisBatch;

    // Safety: if we somehow failed to update any row in the batch, break
    // rather than loop forever.
    if (updatedThisBatch === 0) break;
  }

  return { scanned, updated, errors };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceRoleKey);

  const sinceIso = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const startedAt = Date.now();

  try {
    const results: Record<Kind, BackfillCounts> = {
      observation: await backfillTable(
        supabase,
        'ct_observations',
        'id, glance',
        sinceIso,
        scoreObservation,
      ),
      flag: await backfillTable(
        supabase,
        'ct_flags',
        'id, conviction, trade_setup',
        sinceIso,
        scoreFlag,
      ),
      alert: await backfillTable(
        supabase,
        'ct_alerts',
        'id, alert_trigger, trade_setup',
        sinceIso,
        scoreAlert,
      ),
      heartbeat: await backfillTable(
        supabase,
        'ct_heartbeats',
        'id',
        sinceIso,
        scoreHeartbeat,
      ),
    };

    const totalScanned = Object.values(results).reduce((a, r) => a + r.scanned, 0);
    const totalUpdated = Object.values(results).reduce((a, r) => a + r.updated, 0);
    const totalErrors  = Object.values(results).reduce((a, r) => a + r.errors, 0);

    return new Response(JSON.stringify({
      success: true,
      since: sinceIso,
      lookback_days: LOOKBACK_DAYS,
      batch_size: BATCH_SIZE,
      counts: results,
      totals: {
        scanned: totalScanned,
        updated: totalUpdated,
        errors: totalErrors,
      },
      duration_ms: Date.now() - startedAt,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('[ct-attention-backfill] fatal:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'backfill failed',
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
