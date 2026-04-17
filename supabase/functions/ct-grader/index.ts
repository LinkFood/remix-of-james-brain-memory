/**
 * ct-grader — scores co-trader calls against outcomes
 *
 * Cron: every 15 min. Picks up any ct_flags / ct_alerts / ct_james_views
 * with horizon_end < now() AND grade_id IS NULL. For each subject, pulls
 * current underlying price, computes verdict + calibration delta, writes
 * ct_grades row, updates subject.grade_id.
 *
 * The referee IS the intelligence (Duck Countdown lesson applied here).
 * Over time, grades enrich the embedding metadata so memory recall
 * naturally surfaces "similar setups that resolved the way I claimed."
 *
 * Auth: service role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { gradeSubjects, type Direction } from '../_shared/ctGrader.ts';

type SubjectType = 'flag' | 'alert' | 'james_view';

async function fetchDueSubjects(supabase: ReturnType<typeof createClient>): Promise<Array<{
  subject_type: SubjectType;
  subject_id: string;
  instrument: string;
  direction: Direction;
  odds_up: number | null;
  odds_down: number | null;
  entry_price: number;
}>> {
  const nowIso = new Date().toISOString();
  const results: Array<{
    subject_type: SubjectType;
    subject_id: string;
    instrument: string;
    direction: Direction;
    odds_up: number | null;
    odds_down: number | null;
    entry_price: number;
  }> = [];

  // Flags
  const { data: flags, error: flagErr } = await supabase
    .from('ct_flags')
    .select('id, instruments, direction, up_case_odds, down_case_odds, entry_prices')
    .is('grade_id', null)
    .lt('horizon_end', nowIso)
    .limit(50);
  if (flagErr) console.warn('[ct-grader] flag fetch:', flagErr.message);
  for (const row of flags ?? []) {
    const instruments = Array.isArray(row.instruments) ? row.instruments : [];
    const entryPrices = (row.entry_prices ?? {}) as Record<string, number | null>;
    for (const instrument of instruments) {
      const entry = entryPrices[instrument];
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        results.push({
          subject_type: 'flag',
          subject_id: row.id as string,
          instrument,
          direction: row.direction as Direction,
          odds_up: (row.up_case_odds as number | null) ?? null,
          odds_down: (row.down_case_odds as number | null) ?? null,
          entry_price: entry,
        });
      }
    }
  }

  // Alerts
  const { data: alerts, error: alertErr } = await supabase
    .from('ct_alerts')
    .select('id, instruments, direction, up_case_odds, down_case_odds, entry_prices')
    .is('grade_id', null)
    .lt('horizon_end', nowIso)
    .limit(50);
  if (alertErr) console.warn('[ct-grader] alert fetch:', alertErr.message);
  for (const row of alerts ?? []) {
    const instruments = Array.isArray(row.instruments) ? row.instruments : [];
    const entryPrices = (row.entry_prices ?? {}) as Record<string, number | null>;
    for (const instrument of instruments) {
      const entry = entryPrices[instrument];
      if (typeof entry === 'number' && Number.isFinite(entry)) {
        results.push({
          subject_type: 'alert',
          subject_id: row.id as string,
          instrument,
          direction: row.direction as Direction,
          odds_up: (row.up_case_odds as number | null) ?? null,
          odds_down: (row.down_case_odds as number | null) ?? null,
          entry_price: entry,
        });
      }
    }
  }

  // James views
  const { data: jviews, error: jvErr } = await supabase
    .from('ct_james_views')
    .select('id, instrument, direction, entry_price')
    .is('grade_id', null)
    .lt('horizon_end', nowIso)
    .limit(50);
  if (jvErr) console.warn('[ct-grader] james_view fetch:', jvErr.message);
  for (const row of jviews ?? []) {
    if (typeof row.entry_price === 'number' && Number.isFinite(row.entry_price)) {
      results.push({
        subject_type: 'james_view',
        subject_id: row.id as string,
        instrument: row.instrument as string,
        direction: row.direction as Direction,
        odds_up: null,
        odds_down: null,
        entry_price: row.entry_price,
      });
    }
  }

  return results;
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
    const subjects = await fetchDueSubjects(supabase);
    if (subjects.length === 0) {
      return new Response(JSON.stringify({ success: true, graded: 0, duration_ms: Date.now() - startedAt }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const results = await gradeSubjects(supabase, subjects);
    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    const verdicts: Record<string, number> = {};
    for (const r of results) {
      if (r.verdict) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    }

    console.log(`[ct-grader] graded ${ok}/${subjects.length} (${failed} failed) verdicts=${JSON.stringify(verdicts)}`);

    return new Response(JSON.stringify({
      success: true,
      graded: ok,
      failed,
      verdicts,
      duration_ms: Date.now() - startedAt,
      errors: results.filter(r => !r.ok).map(r => ({ id: r.subject_id, error: r.error })).slice(0, 10),
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[ct-grader] fatal:', error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'grader failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
