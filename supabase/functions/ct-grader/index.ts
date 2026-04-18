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
import { gradeSubjects, normalizeExpectedMove, type Direction, type ExpectedMove } from '../_shared/ctGrader.ts';
import { readTiltSnapshot, type StreakDot } from '../_shared/streakRead.ts';
import { ctSlackPushTiltTransition } from '../_shared/ctSlack.ts';

type SubjectType = 'flag' | 'alert' | 'james_view';

interface DueSubject {
  subject_type: SubjectType;
  subject_id: string;
  instrument: string;
  direction: Direction;
  odds_up: number | null;
  odds_down: number | null;
  entry_price: number;
  /** v1.3+ only; null for pre-v1.3 rows and all james_views. */
  expected_move: ExpectedMove | null;
}

async function fetchDueSubjects(supabase: ReturnType<typeof createClient>): Promise<DueSubject[]> {
  const nowIso = new Date().toISOString();
  const results: DueSubject[] = [];

  // Flags
  const { data: flags, error: flagErr } = await supabase
    .from('ct_flags')
    .select('id, instruments, direction, up_case_odds, down_case_odds, entry_prices, expected_move')
    .is('grade_id', null)
    .lt('horizon_end', nowIso)
    .limit(50);
  if (flagErr) console.warn('[ct-grader] flag fetch:', flagErr.message);
  for (const row of flags ?? []) {
    const instruments = Array.isArray(row.instruments) ? row.instruments : [];
    const entryPrices = (row.entry_prices ?? {}) as Record<string, number | null>;
    const band = normalizeExpectedMove(row.expected_move);
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
          expected_move: band,
        });
      }
    }
  }

  // Alerts
  const { data: alerts, error: alertErr } = await supabase
    .from('ct_alerts')
    .select('id, instruments, direction, up_case_odds, down_case_odds, entry_prices, expected_move')
    .is('grade_id', null)
    .lt('horizon_end', nowIso)
    .limit(50);
  if (alertErr) console.warn('[ct-grader] alert fetch:', alertErr.message);
  for (const row of alerts ?? []) {
    const instruments = Array.isArray(row.instruments) ? row.instruments : [];
    const entryPrices = (row.entry_prices ?? {}) as Record<string, number | null>;
    const band = normalizeExpectedMove(row.expected_move);
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
          expected_move: band,
        });
      }
    }
  }

  // James views — no expected_move on this table, always null.
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
        expected_move: null,
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

    // Capture the PRIOR tilt snapshot before we write new grades. We need
    // the prior wrong-streak to detect a true transition (push only when
    // crossing from <3 to >=3). readTiltSnapshot is defensive — a failure
    // returns zero-state, which just means priorWrongStreak=0 and we'll
    // end up pushing if POST crosses 3. Acceptable worst case.
    const priorTilt = await readTiltSnapshot(supabase);

    const results = await gradeSubjects(supabase, subjects);
    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    const verdicts: Record<string, number> = {};
    for (const r of results) {
      if (r.verdict) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
    }

    console.log(`[ct-grader] graded ${ok}/${subjects.length} (${failed} failed) verdicts=${JSON.stringify(verdicts)}`);

    // Tilt transition Slack push. Fire only when we just wrote at least
    // one 'wrong' verdict AND the post-batch wrong streak newly crosses 3.
    // ctSlackPushTiltTransition internally dedupes on 24h. Best-effort —
    // any failure is logged but never blocks the grader response.
    try {
      const wroteAWrong = (verdicts.wrong ?? 0) > 0;
      if (wroteAWrong) {
        const postTilt = await readTiltSnapshot(supabase);
        if (postTilt.current_wrong_streak >= 3 && priorTilt.current_wrong_streak < 3) {
          const { data: profileRow } = await supabase
            .from('profiles').select('id').limit(1).maybeSingle();
          const userId = (profileRow?.id as string | undefined) ?? null;
          if (userId) {
            const rec = await historicalRecoveryRate(supabase, postTilt.current_wrong_streak);
            await ctSlackPushTiltTransition(supabase, userId, {
              wrongStreak: postTilt.current_wrong_streak,
              priorWrongStreak: priorTilt.current_wrong_streak,
              recoveryRate: rec.rate,
              recoveryHits: rec.hits,
              recoveryN: rec.hits,
              tickers: postTilt.wrong_streak_tickers,
            });
          }
        }
      }
    } catch (e) {
      console.warn('[ct-grader] tilt transition push failed:', e instanceof Error ? e.message : e);
    }

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

/**
 * Historical recovery rate: of every prior N-wrong streak in the 30d
 * window, how often did the next graded outcome come back 'right'?
 * Mirrors nextOutcomeAfterNWrong in the frontend hook — the Slack copy
 * and the StreakPanel copy stay in sync.
 */
// Loose client type — matches the rest of this file's usage and avoids the
// esm.sh SupabaseClient generic tag mismatch.
// deno-lint-ignore no-explicit-any
async function historicalRecoveryRate(
  supabase: any,
  n: number,
): Promise<{ hits: number; rate: number | null }> {
  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const [gradesRes, tradesRes] = await Promise.all([
      supabase
        .from('ct_grades')
        .select('verdict, graded_at')
        .gte('graded_at', since)
        .order('graded_at', { ascending: true })
        .limit(500),
      supabase
        .from('ct_trades')
        .select('realized_pnl_pct, closed_at')
        .eq('status', 'closed')
        .not('closed_at', 'is', null)
        .gte('closed_at', since)
        .order('closed_at', { ascending: true })
        .limit(500),
    ]);
    const dots: StreakDot[] = [];
    for (const r of (gradesRes.data ?? []) as Array<{ verdict: string; graded_at: string }>) {
      dots.push({
        verdict: (['right', 'partial', 'wrong', 'ambiguous'] as const).includes(r.verdict as 'right')
          ? (r.verdict as StreakDot['verdict'])
          : 'ambiguous',
        ts: r.graded_at,
        instrument: null,
        source: 'grade',
      });
    }
    for (const r of (tradesRes.data ?? []) as Array<{ realized_pnl_pct: number | null; closed_at: string | null }>) {
      if (r.realized_pnl_pct == null || !r.closed_at) continue;
      const pnl = r.realized_pnl_pct;
      const v = pnl > 0.1 ? 'right' : pnl < -0.1 ? 'wrong' : 'partial';
      dots.push({ verdict: v, ts: r.closed_at, instrument: null, source: 'trade' });
    }
    dots.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    let hits = 0;
    let nextWin = 0;
    for (let i = 0; i + n < dots.length; i++) {
      let streak = true;
      for (let k = 0; k < n; k++) {
        if (dots[i + k].verdict !== 'wrong') { streak = false; break; }
      }
      if (!streak) continue;
      const next = dots[i + n];
      if (next.verdict === 'ambiguous') continue;
      hits += 1;
      if (next.verdict === 'right') nextWin += 1;
      i += n - 1;
    }
    return { hits, rate: hits > 0 ? nextWin / hits : null };
  } catch (e) {
    console.warn('[ct-grader] historicalRecoveryRate failed:', e instanceof Error ? e.message : e);
    return { hits: 0, rate: null };
  }
}
