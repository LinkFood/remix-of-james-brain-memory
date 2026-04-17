/**
 * ct-pre-bell-grader — resolves pre-bell predictions against reality.
 *
 * Cron: every 30min during market hours. For each ungraded prediction
 * whose resolution time has passed, compute verdict + calibration delta
 * and update the row.
 *
 * Resolution logic:
 *   - spy_10am (14:00 UTC): SPY direction vs reference price, threshold ±0.15%
 *   - unusual_flow (20:00 UTC close): any ct_flow_alerts row today for the
 *     predicted ticker with premium > $5M → right, else wrong
 *   - lagging_sector (20:00 UTC close): sector ETF %delta < SPY %delta − 0.5% → right
 *
 * Calibration delta: confidence(1-5) normalized to 0.2-1.0 compared with
 * right(1.0) / partial(0.5) / wrong(0.0). Delta = stated - actual.
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getCurrentPrice } from '../_shared/ctGrader.ts';

type Slot = 'spy_10am' | 'unusual_flow' | 'lagging_sector';
type Verdict = 'right' | 'wrong' | 'partial' | 'ambiguous';

interface PredictionRow {
  id: string;
  session_date: string;
  prediction_slot: Slot;
  prediction: Record<string, unknown>;
  confidence: number;
  committed_at: string;
}

const SPY_THRESHOLD = 0.15;         // percent
const FLOW_PREMIUM_MIN = 5_000_000; // $5M
const SECTOR_LAG_THRESHOLD = 0.5;   // percent

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function nowUtcMins(): number {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function scoreToPct(v: Verdict): number {
  return v === 'right' ? 1.0 : v === 'partial' ? 0.5 : 0.0;
}

function calibrationDelta(confidence: number, verdict: Verdict): number {
  const stated = Math.max(0, Math.min(1, (confidence - 1) / 4));
  return +(stated - scoreToPct(verdict)).toFixed(3);
}

async function gradeSpy10am(
  supabase: SupabaseClient,
  row: PredictionRow,
): Promise<{ verdict: Verdict; actual_outcome: Record<string, unknown> } | null> {
  // Only grade after 14:00 UTC on or after session_date
  const mins = nowUtcMins();
  if (row.session_date !== todayDate() || mins < 14 * 60) return null;

  const ref = row.prediction.reference_price;
  if (typeof ref !== 'number' || !Number.isFinite(ref)) {
    return { verdict: 'ambiguous', actual_outcome: { reason: 'no reference price' } };
  }
  const current = await getCurrentPrice('SPY');
  if (current == null) return null;
  const pct = ((current - ref) / ref) * 100;
  const direction = pct >= SPY_THRESHOLD ? 'up' : pct <= -SPY_THRESHOLD ? 'down' : 'flat';
  const claimed = typeof row.prediction.direction === 'string' ? row.prediction.direction : null;
  const verdict: Verdict = claimed === direction ? 'right' : 'wrong';
  return {
    verdict,
    actual_outcome: { spy_ref: ref, spy_current: current, pct: +pct.toFixed(3), actual_direction: direction },
  };
}

async function gradeUnusualFlow(
  supabase: SupabaseClient,
  row: PredictionRow,
): Promise<{ verdict: Verdict; actual_outcome: Record<string, unknown> } | null> {
  // Only grade after 20:00 UTC on or after session_date
  const mins = nowUtcMins();
  if (row.session_date !== todayDate() || mins < 20 * 60) return null;

  const ticker = typeof row.prediction.ticker === 'string' ? row.prediction.ticker : null;
  if (!ticker) return { verdict: 'ambiguous', actual_outcome: { reason: 'no ticker in prediction' } };

  const sessionStart = `${row.session_date}T13:30:00Z`;
  const { data: hits } = await supabase
    .from('ct_flow_alerts')
    .select('premium, side, strike, expiry')
    .eq('ticker', ticker)
    .gte('ingested_at', sessionStart)
    .gte('premium', FLOW_PREMIUM_MIN)
    .order('premium', { ascending: false })
    .limit(3);

  const verdict: Verdict = hits && hits.length > 0 ? 'right' : 'wrong';
  return {
    verdict,
    actual_outcome: { ticker, hits_ge_5M: hits?.length ?? 0, top_prints: hits ?? [] },
  };
}

async function gradeLaggingSector(
  supabase: SupabaseClient,
  row: PredictionRow,
): Promise<{ verdict: Verdict; actual_outcome: Record<string, unknown> } | null> {
  const mins = nowUtcMins();
  if (row.session_date !== todayDate() || mins < 20 * 60) return null;

  const etf = typeof row.prediction.sector_etf === 'string' ? row.prediction.sector_etf : null;
  const spyRef = row.prediction.reference_spy;
  const sectorRef = row.prediction.reference_sector;
  if (!etf || typeof spyRef !== 'number' || typeof sectorRef !== 'number') {
    return { verdict: 'ambiguous', actual_outcome: { reason: 'missing refs' } };
  }
  const [spyNow, sectorNow] = await Promise.all([
    getCurrentPrice('SPY'),
    getCurrentPrice(etf),
  ]);
  if (spyNow == null || sectorNow == null) return null;
  const spyPct = ((spyNow - spyRef) / spyRef) * 100;
  const sectorPct = ((sectorNow - sectorRef) / sectorRef) * 100;
  const lag = spyPct - sectorPct;
  const verdict: Verdict = lag >= SECTOR_LAG_THRESHOLD ? 'right' : lag >= 0 ? 'partial' : 'wrong';
  return {
    verdict,
    actual_outcome: {
      etf, spy_pct: +spyPct.toFixed(3), sector_pct: +sectorPct.toFixed(3), lag: +lag.toFixed(3),
    },
  };
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

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: rows, error: fetchErr } = await supabase
    .from('ct_pre_bell_predictions')
    .select('id, session_date, prediction_slot, prediction, confidence, committed_at')
    .is('verdict', null)
    .eq('session_date', todayDate())
    .limit(20);

  if (fetchErr) {
    return new Response(JSON.stringify({ error: fetchErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  let graded = 0;
  const results: Array<{ slot: Slot; verdict: Verdict }> = [];

  for (const row of (rows ?? []) as PredictionRow[]) {
    let resolution: { verdict: Verdict; actual_outcome: Record<string, unknown> } | null = null;
    try {
      if (row.prediction_slot === 'spy_10am') resolution = await gradeSpy10am(supabase, row);
      else if (row.prediction_slot === 'unusual_flow') resolution = await gradeUnusualFlow(supabase, row);
      else if (row.prediction_slot === 'lagging_sector') resolution = await gradeLaggingSector(supabase, row);
    } catch (e) {
      console.warn('[ct-pre-bell-grader] grade failed:', e instanceof Error ? e.message : e);
    }
    if (!resolution) continue;

    const delta = calibrationDelta(row.confidence, resolution.verdict);
    const { error: updErr } = await supabase
      .from('ct_pre_bell_predictions')
      .update({
        verdict: resolution.verdict,
        actual_outcome: resolution.actual_outcome,
        calibration_delta: delta,
        graded_at: new Date().toISOString(),
      })
      .eq('id', row.id);
    if (updErr) {
      console.warn('[ct-pre-bell-grader] update failed:', updErr.message);
      continue;
    }
    graded++;
    results.push({ slot: row.prediction_slot, verdict: resolution.verdict });
  }

  return new Response(JSON.stringify({ ok: true, graded, results }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
