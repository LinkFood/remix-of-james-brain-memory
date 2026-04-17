/**
 * ct-disagreement-materializer — find james_view ≠ claude_flag collisions
 *
 * Runs every 10 min during weekday market hours.
 *
 * For each active ct_james_views (horizon_end > now, no disagreement row yet),
 * scan ct_flags on the SAME instrument + horizon with a DIFFERENT direction
 * created within the last 4 hours. If found → insert ct_disagreements row.
 *
 * Unique constraint (james_view_id, claude_flag_id) prevents dupes.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';

serve(async (_req) => {
  const t0 = Date.now();
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const sb = createClient(supabaseUrl, serviceKey);

    const nowIso = new Date().toISOString();
    const fourHoursAgo = new Date(Date.now() - 4 * 3600 * 1000).toISOString();

    // 1. Active james_views (horizon still open)
    const { data: views, error: vErr } = await sb
      .from('ct_james_views')
      .select('id, user_id, instrument, direction, horizon, horizon_end, created_at')
      .gt('horizon_end', nowIso)
      .order('created_at', { ascending: false })
      .limit(200);

    if (vErr) {
      console.error('[disagreement-materializer] views query failed:', vErr);
      return new Response(JSON.stringify({ error: vErr.message }), { status: 500 });
    }

    if (!views || views.length === 0) {
      return new Response(JSON.stringify({ ok: true, views_scanned: 0, inserted: 0, ms: Date.now() - t0 }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Collect already-materialized (james_view_id, claude_flag_id) pairs so we
    //    don't hammer the unique constraint. Single query over the candidate ids.
    const viewIds = views.map(v => v.id as string);
    const { data: existing } = await sb
      .from('ct_disagreements')
      .select('james_view_id, claude_flag_id')
      .in('james_view_id', viewIds);

    const seen = new Set<string>();
    for (const r of (existing ?? []) as Array<{ james_view_id: string; claude_flag_id: string }>) {
      seen.add(`${r.james_view_id}:${r.claude_flag_id}`);
    }

    // 3. For each view, scan recent flags on same instrument + horizon w/ opposing direction
    let inserted = 0;
    let scanned = 0;

    for (const v of views as Array<{
      id: string;
      user_id: string | null;
      instrument: string;
      direction: string;
      horizon: string;
      horizon_end: string;
      created_at: string;
    }>) {
      scanned++;

      const { data: flags, error: fErr } = await sb
        .from('ct_flags')
        .select('id, instruments, direction, horizon, horizon_end, created_at')
        .contains('instruments', [v.instrument])
        .eq('horizon', v.horizon)
        .neq('direction', v.direction)
        .gte('created_at', fourHoursAgo)
        .order('created_at', { ascending: false })
        .limit(50);

      if (fErr) {
        console.warn('[disagreement-materializer] flags query failed for view', v.id, fErr.message);
        continue;
      }
      if (!flags || flags.length === 0) continue;

      for (const f of flags as Array<{
        id: string;
        direction: string;
        horizon_end: string;
      }>) {
        const key = `${v.id}:${f.id}`;
        if (seen.has(key)) continue;

        const { error: insErr } = await sb.from('ct_disagreements').insert({
          user_id: v.user_id,
          instrument: v.instrument,
          horizon: v.horizon,
          // Use the later horizon_end (both should resolve by then)
          horizon_end: new Date(Math.max(
            new Date(v.horizon_end).getTime(),
            new Date(f.horizon_end).getTime()
          )).toISOString(),
          james_view_id: v.id,
          claude_flag_id: f.id,
          james_direction: v.direction,
          claude_direction: f.direction,
          resolution: 'pending',
        });

        if (insErr) {
          // Unique violation = race with another run; ignore
          if (!String(insErr.message).includes('duplicate key')) {
            console.warn('[disagreement-materializer] insert failed:', insErr.message);
          }
          continue;
        }
        seen.add(key);
        inserted++;
      }
    }

    return new Response(
      JSON.stringify({ ok: true, views_scanned: scanned, inserted, ms: Date.now() - t0 }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('[disagreement-materializer] fatal:', err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});
