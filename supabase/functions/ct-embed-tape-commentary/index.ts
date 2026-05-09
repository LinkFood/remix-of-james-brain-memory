/**
 * ct-embed-tape-commentary — backlog drainer for the ct_tape_commentary
 * embedding gate (Phase 1, fusion ground-truth audit Section B gap #2).
 *
 * Picks rows with NULL embedding, builds rich_text matching the producer's
 * pattern, voyageEmbeds, and UPDATEs. Idempotent — re-running is safe.
 *
 * Two roles:
 *   1) Initial backfill drain (manual invoke with batch_size=100) for
 *      historical rows pre-Phase-1.
 *   2) Steady-state miss recovery (cron every 30 min RTH) for any
 *      write-time embed failures (Voyage 5xx, transient outages).
 *
 * Returns { ok, embedded, skipped, errors[], remaining_estimate }.
 *
 * NEVER batches more than 20 per Voyage call per the CLAUDE.md gotcha.
 * Caller can request batch_size up to 100; we chunk internally to 20.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';

interface CommentaryRow {
  id: number;
  created_at: string;
  session_date: string;
  commentary: string;
  market_tide: string | null;
  vix_level: number | null;
  flow_ids: number[] | null;
  flag_ids: string[] | null;
}

const VOYAGE_BATCH_LIMIT = 20;

function buildRichText(r: CommentaryRow): string {
  const tide = r.market_tide ?? 'na';
  const vix = r.vix_level != null ? Number(r.vix_level).toFixed(2) : 'na';
  const flagCount = r.flag_ids?.length ?? 0;
  const flowCount = r.flow_ids?.length ?? 0;
  return [
    `TAPE_COMMENTARY | tide:${tide} vix:${vix} flags:${flagCount} flow:${flowCount} | session:${r.session_date}`,
    r.commentary,
  ].join('\n');
}

serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }),
      { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const body = await req.json().catch(() => ({})) as { batch_size?: number };
  const requested = Math.min(Math.max(body.batch_size ?? 20, 1), 100);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Atomic claim via FOR UPDATE SKIP LOCKED RPC. Concurrent callers get
  // disjoint slices; sentinel-zero-vector marks claimed rows so subsequent
  // calls skip them. Newest-first so backfill keeps recent substrate fresh.
  // See migration 20260510100000.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: selectErr } = await (supabase as any)
    .rpc('claim_unembedded_tape_commentary', { p_batch_size: requested });

  if (selectErr) {
    return new Response(JSON.stringify({ ok: false, error: selectErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const rows: CommentaryRow[] = data ?? [];
  if (rows.length === 0) {
    return new Response(JSON.stringify({
      ok: true, embedded: 0, skipped: 0, errors: [], remaining_estimate: 0,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // Get rough remaining count (separate count query so we report progress).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: remainingCount } = await (supabase
    .from('ct_tape_commentary' as never) as any)
    .select('id', { count: 'exact', head: true })
    .is('embedding', null);

  // Process in chunks of VOYAGE_BATCH_LIMIT (CLAUDE.md gotcha — never embed
  // more than 20 in a single batch). Voyage call is per-row anyway in
  // voyageEmbed; the chunking guards future batched implementations.
  let embedded = 0;
  let skipped = 0;
  const errors: Array<{ id: number; error: string }> = [];

  for (let i = 0; i < rows.length; i += VOYAGE_BATCH_LIMIT) {
    const chunk = rows.slice(i, i + VOYAGE_BATCH_LIMIT);
    for (const row of chunk) {
      if (!row.commentary || row.commentary.trim().length === 0) {
        skipped += 1;
        continue;
      }
      const richText = buildRichText(row);
      try {
        const embedding = await voyageEmbed(richText, 'document');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: updateErr } = await (supabase.from('ct_tape_commentary' as never) as any)
          .update({
            embedding: embedding as unknown as string,
            rich_text: richText,
          })
          .eq('id', row.id);
        if (updateErr) {
          errors.push({ id: row.id, error: updateErr.message });
        } else {
          embedded += 1;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push({ id: row.id, error: msg });
      }
    }
  }

  return new Response(JSON.stringify({
    ok: errors.length === 0,
    embedded,
    skipped,
    errors,
    remaining_estimate: Math.max(0, (remainingCount ?? 0) - embedded),
  }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
});
