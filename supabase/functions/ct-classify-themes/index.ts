/**
 * ct-classify-themes — one-shot + idempotent backfill that populates
 * ct_trades.thesis_theme using the regex classifier in
 * _shared/thesisClassifier.ts.
 *
 * Scope: every ct_trades row where thesis_theme IS NULL AND thesis IS NOT NULL.
 * Re-running is a no-op (the WHERE filter evicts already-classified rows).
 *
 * Rows with NULL thesis are left alone — insert-time classification in
 * ct-claude-trade-open and ct-alert-book-commit handles new rows, and we
 * don't want to write 'other' on top of a future LLM-classified scheme if
 * one lands later.
 *
 * Auth: service role only. Returns { updated, scanned, by_theme }.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { classifyThesis, type ThesisTheme } from '../_shared/thesisClassifier.ts';

const PAGE_SIZE = 500;

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

  const byTheme: Record<ThesisTheme, number> = {
    convergence: 0,
    structural_tightness: 0,
    gap: 0,
    news_driven: 0,
    regime_flip: 0,
    thesis_invalidation: 0,
    other: 0,
  };

  let scanned = 0;
  let updated = 0;
  let pageFailed = false;
  let failMsg: string | null = null;

  // Paginate through candidate rows. After each UPDATE, the .is('thesis_theme', null)
  // filter no longer matches those rows, so we always pull from offset 0.
  for (let safety = 0; safety < 200; safety++) {
    const { data: rows, error } = await supabase
      .from('ct_trades')
      .select('id, thesis')
      .is('thesis_theme', null)
      .not('thesis', 'is', null)
      .order('session_date', { ascending: false })
      .limit(PAGE_SIZE);

    if (error) {
      pageFailed = true;
      failMsg = error.message;
      break;
    }
    if (!rows || rows.length === 0) break;

    scanned += rows.length;

    // Classify in-memory, then UPDATE per row. These are cheap regex calls;
    // one UPDATE per row keeps the write path dumb and restartable.
    for (const r of rows) {
      const theme = classifyThesis(r.thesis as string | null);
      byTheme[theme] = (byTheme[theme] ?? 0) + 1;
      const { error: upErr } = await supabase
        .from('ct_trades')
        .update({ thesis_theme: theme })
        .eq('id', r.id);
      if (!upErr) updated += 1;
    }

    // Short page -> we've drained the queue.
    if (rows.length < PAGE_SIZE) break;
  }

  return new Response(JSON.stringify({
    ok: !pageFailed,
    scanned,
    updated,
    by_theme: byTheme,
    error: failMsg,
  }), {
    status: pageFailed ? 500 : 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
