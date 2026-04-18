/**
 * ct-hypothesis-confidence-update — Elo + confidence update triggered by a graded outcome.
 *
 * Invoked by a Postgres AFTER INSERT trigger on ct_grades (trigger in the
 * accompanying migration). Body: { grade_id }.
 *
 * Flow:
 *   1. Load the grade row.
 *   2. If hypothesis_id is null, exit gracefully (this is an un-linked grade).
 *   3. Decide win/loss from verdict + claimed_direction/actual_return_pct.
 *   4. Compute K-factor: k = max(floor, initial - sample_count) where
 *      sample_count = count of ct_hypothesis_evidence rows with
 *      evidence_type='grade' for this hypothesis (its track record so far).
 *   5. Elo expected = 1 / (1 + 10^((1500 - elo) / 400)) vs a 1500 "par."
 *      Delta: win -> +K * (1 - expected), loss -> -K * expected.
 *   6. Confidence nudge: win -> +0.05, loss -> -0.05.
 *   7. RPC: update_hypothesis_confidence(...) with event_type='elo_update'.
 *   8. Insert a ct_hypothesis_evidence row (evidence_type='grade').
 *   9. Auto-promote check: wins >= min_wins AND winrate >= min_winrate AND
 *      elo > 1500 AND not already promoted -> insert into ct_playbooks
 *      (best-effort, swallow unique-conflict).
 *
 * Auth: service role only. The trigger fires under service_role via _ct_post.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { getConfig } from '../_shared/configCache.ts';

interface GradeRow {
  id: string;
  hypothesis_id: string | null;
  subject_type: string;
  subject_id: string;
  instrument: string;
  claimed_direction: string;
  actual_return_pct: number;
  actual_direction: string;
  verdict: string;
  notes: string | null;
}

interface HypothesisRow {
  id: string;
  claim: string;
  because: string[];
  invalidate_if: string;
  horizon: string;
  confidence: number;
  elo: number;
  tickers: string[];
  status: string;
}

function expectedScore(elo: number, par: number = 1500): number {
  return 1 / (1 + Math.pow(10, (par - elo) / 400));
}

/**
 * Decide if this grade counts as a win or a loss for the hypothesis.
 * - verdict='right' is always a win.
 * - verdict='wrong' is always a loss.
 * - verdict='partial' is a fractional win (counts as win for promotion math
 *   but gets smaller deltas — return 'win' and let weight halving handle it).
 * - verdict='ambiguous' returns null -> skip.
 * Fallback: sign-of-actual-return matches claimed_direction -> win.
 */
function classifyOutcome(grade: GradeRow): { outcome: 'win' | 'loss' | null; weight: number } {
  if (grade.verdict === 'right') return { outcome: 'win', weight: 1.0 };
  if (grade.verdict === 'wrong') return { outcome: 'loss', weight: 1.0 };
  if (grade.verdict === 'partial') return { outcome: 'win', weight: 0.5 };
  if (grade.verdict === 'ambiguous') return { outcome: null, weight: 0 };
  // Unknown verdict string — fall back to claimed vs actual direction.
  const claimed = (grade.claimed_direction || '').toLowerCase();
  const actual = (grade.actual_direction || '').toLowerCase();
  if (!claimed || !actual) return { outcome: null, weight: 0 };
  if (claimed === actual) return { outcome: 'win', weight: 0.75 };
  return { outcome: 'loss', weight: 0.75 };
}

async function attemptPromote(
  supabase: SupabaseClient,
  h: HypothesisRow,
  minWins: number,
  minWinRate: number,
): Promise<{ promoted: boolean; reason: string }> {
  if (h.elo <= 1500) return { promoted: false, reason: 'elo <= par' };

  const { data, error } = await supabase
    .from('ct_hypothesis_evidence')
    .select('polarity, weight')
    .eq('hypothesis_id', h.id)
    .eq('evidence_type', 'grade');
  if (error || !data) return { promoted: false, reason: `evidence query: ${error?.message ?? 'no rows'}` };

  const total = data.length;
  const wins = data.filter((r) => r.polarity === 'for').length;
  if (wins < minWins) return { promoted: false, reason: `wins ${wins} < ${minWins}` };
  const winRate = total > 0 ? wins / total : 0;
  if (winRate < minWinRate) return { promoted: false, reason: `winrate ${winRate.toFixed(2)} < ${minWinRate}` };

  // Build deterministic name so unique(name) on ct_playbooks dedupes naturally.
  const name = `hypothesis:${h.id.slice(0, 8)}`;
  const { error: insertErr } = await supabase
    .from('ct_playbooks')
    .insert({
      name,
      description: h.claim.slice(0, 500),
      setup_criteria: {
        hypothesis_id: h.id,
        because: h.because,
        invalidate_if: h.invalidate_if,
        tickers: h.tickers,
        horizon: h.horizon,
      },
      historical_win_rate: winRate,
      sample_size: total,
      status: 'active',
    });
  if (insertErr) {
    // Unique conflict on name — already promoted. Not an error.
    if (insertErr.code === '23505' || insertErr.message?.includes('duplicate')) {
      return { promoted: false, reason: 'already promoted (unique conflict)' };
    }
    return { promoted: false, reason: `insert: ${insertErr.message}` };
  }

  // Log the promotion event.
  await supabase.from('ct_hypothesis_events').insert({
    hypothesis_id: h.id,
    event_type: 'promoted',
    reason: `auto-promoted to playbook: ${wins}/${total} wins, winrate ${winRate.toFixed(2)}, elo ${h.elo}`,
    created_by: 'cron',
  });

  return { promoted: true, reason: `${wins}/${total} @ ${(winRate * 100).toFixed(0)}%` };
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

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — we just won't have a grade_id
  }
  const gradeId = body?.grade_id as string | undefined;
  if (!gradeId) {
    return new Response(JSON.stringify({ ok: false, skipped: 'no grade_id' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
  const startedAt = Date.now();

  const { data: grade, error: gradeErr } = await supabase
    .from('ct_grades')
    .select('id, hypothesis_id, subject_type, subject_id, instrument, claimed_direction, actual_return_pct, actual_direction, verdict, notes')
    .eq('id', gradeId)
    .maybeSingle();

  if (gradeErr) {
    return new Response(JSON.stringify({ ok: false, error: gradeErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (!grade) {
    return new Response(JSON.stringify({ ok: true, skipped: 'grade not found', grade_id: gradeId }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const g = grade as GradeRow;
  if (!g.hypothesis_id) {
    return new Response(JSON.stringify({ ok: true, skipped: 'no hypothesis_id' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: hyp, error: hypErr } = await supabase
    .from('ct_hypotheses')
    .select('id, claim, because, invalidate_if, horizon, confidence, elo, tickers, status')
    .eq('id', g.hypothesis_id)
    .maybeSingle();

  if (hypErr || !hyp) {
    return new Response(JSON.stringify({ ok: false, error: `hypothesis load: ${hypErr?.message ?? 'not found'}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const h = hyp as HypothesisRow;

  const { outcome, weight } = classifyOutcome(g);
  if (!outcome) {
    return new Response(JSON.stringify({ ok: true, skipped: `verdict=${g.verdict} (ambiguous/unclassifiable)` }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Sample count = graded evidence already on file BEFORE this new row.
  const { count: existingCount } = await supabase
    .from('ct_hypothesis_evidence')
    .select('id', { count: 'estimated', head: true })
    .eq('hypothesis_id', h.id)
    .eq('evidence_type', 'grade');

  const kInitial = Number(await getConfig<number>('hypothesis_elo_k_initial', 32));
  const kFloor = Number(await getConfig<number>('hypothesis_elo_k_floor', 12));
  const minWins = Number(await getConfig<number>('hypothesis_auto_promote_min_wins', 5));
  const minWinRate = Number(await getConfig<number>('hypothesis_auto_promote_min_winrate', 0.60));

  const sampleCount = existingCount ?? 0;
  const k = Math.max(kFloor, kInitial - sampleCount);
  const expected = expectedScore(h.elo);
  const eloDelta = outcome === 'win'
    ? Math.round(k * (1 - expected) * weight)
    : -Math.round(k * expected * weight);

  const confidenceBase = 0.05;
  const confDelta = (outcome === 'win' ? +confidenceBase : -confidenceBase) * weight;

  const reason = `grade ${g.verdict}: ${g.claimed_direction} vs actual ${g.actual_direction} (${g.actual_return_pct?.toFixed?.(2) ?? g.actual_return_pct}%)`;

  const { data: rpcRes, error: rpcErr } = await supabase.rpc('update_hypothesis_confidence', {
    p_hypothesis_id: h.id,
    p_confidence_delta: confDelta,
    p_elo_delta: eloDelta,
    p_reason: reason.slice(0, 500),
    p_linked_grade_id: g.id,
    p_event_type: 'elo_update',
  });
  if (rpcErr) {
    return new Response(JSON.stringify({ ok: false, error: `rpc: ${rpcErr.message}` }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  // Write evidence row — polarity reflects win/loss.
  const { error: evErr } = await supabase
    .from('ct_hypothesis_evidence')
    .insert({
      hypothesis_id: h.id,
      evidence_type: 'grade',
      source_id: g.id,
      polarity: outcome === 'win' ? 'for' : 'against',
      weight: Math.min(1, Math.max(0, 0.5 * weight + 0.25)),
      summary: (g.notes ?? reason).slice(0, 500),
      added_by: 'cron',
    });
  if (evErr) {
    console.warn(`[ct-hypothesis-confidence-update] evidence insert failed: ${evErr.message}`);
  }

  // Attempt promotion using the post-update hypothesis state.
  const { data: refreshed } = await supabase
    .from('ct_hypotheses')
    .select('id, claim, because, invalidate_if, horizon, confidence, elo, tickers, status')
    .eq('id', h.id)
    .maybeSingle();

  let promotion = { promoted: false, reason: 'skipped (no refreshed hypothesis)' };
  if (refreshed) {
    promotion = await attemptPromote(supabase, refreshed as HypothesisRow, minWins, minWinRate);
  }

  const respBody = {
    ok: true,
    hypothesis_id: h.id,
    grade_id: g.id,
    outcome,
    weight,
    k_factor: k,
    elo_delta: eloDelta,
    confidence_delta: confDelta,
    rpc: rpcRes,
    promotion,
    duration_ms: Date.now() - startedAt,
  };
  console.log('[ct-hypothesis-confidence-update]', JSON.stringify(respBody));
  return new Response(JSON.stringify(respBody), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
