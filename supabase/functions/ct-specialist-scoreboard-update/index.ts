/**
 * ct-specialist-scoreboard-update — nightly outcome-Elo snapshot.
 *
 * Calls ct_specialist_outcome_stats(7) and upserts one ct_specialist_scoreboard
 * row per specialist for today's date. Idempotent — safe to re-fire same day.
 *
 * Why nightly + 7-day window: 7d smooths out the per-day noise on a thin
 * dataset while staying responsive to recent performance. The daily snap
 * lets the UI chart Elo evolution over time without recomputing on every
 * page load.
 *
 * Auth: service_role only.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';

const WINDOW_DAYS = 7;

interface OutcomeRow {
  specialist_name: string;
  flags_total: number;
  flags_with_track: number;
  wins: number;
  losses: number;
  flat: number;
  working: number;
  hit_rate: number | null;
  median_peak_pct: number | null;
  expected_peak_pct: number | null;
  top_pick: string | null;
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
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

  const startedAt = Date.now();

  // Snap-date is today in UTC — matches the cron's UTC schedule (23:00).
  const snapDate = new Date().toISOString().slice(0, 10);

  const { data: stats, error: rpcErr } = await supabase
    .rpc('ct_specialist_outcome_stats', { p_since_days: WINDOW_DAYS });

  if (rpcErr) {
    return new Response(JSON.stringify({ error: 'rpc_failed', detail: rpcErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rows = (stats ?? []) as OutcomeRow[];
  if (rows.length === 0) {
    return new Response(JSON.stringify({
      ok: true, snap_date: snapDate, upserted: 0, ms: Date.now() - startedAt,
      note: 'no specialists with flags in window',
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Build upsert payload. computed_at left to default (now()).
  const payload = rows.map((r) => ({
    specialist_name: r.specialist_name,
    snap_date: snapDate,
    flags_total: Number(r.flags_total ?? 0),
    flags_with_track: Number(r.flags_with_track ?? 0),
    wins: Number(r.wins ?? 0),
    losses: Number(r.losses ?? 0),
    flat: Number(r.flat ?? 0),
    hit_rate: r.hit_rate,
    median_peak_pct: r.median_peak_pct,
    expected_peak_pct: r.expected_peak_pct,
    top_pick: r.top_pick,
  }));

  const { error: upErr } = await supabase
    .from('ct_specialist_scoreboard')
    .upsert(payload, { onConflict: 'specialist_name,snap_date' });

  if (upErr) {
    return new Response(JSON.stringify({ error: 'upsert_failed', detail: upErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    ok: true,
    snap_date: snapDate,
    window_days: WINDOW_DAYS,
    specialists: payload.length,
    upserted: payload.length,
    sample: payload.slice(0, 3).map((p) => ({
      name: p.specialist_name,
      hit_rate: p.hit_rate,
      flags_total: p.flags_total,
      top_pick: p.top_pick,
    })),
    ms: Date.now() - startedAt,
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
