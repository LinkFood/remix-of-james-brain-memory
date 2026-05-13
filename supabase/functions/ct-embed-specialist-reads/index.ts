/**
 * ct-embed-specialist-reads — backlog drainer for the ct_specialist_reads
 * embedding gate (Phase 7a, fusion ground-truth audit doc Section 11).
 *
 * Picks rows with NULL embedding via claim_unembedded_specialist_reads (FOR
 * UPDATE SKIP LOCKED + zero-vector sentinel — cascade #45 class-kill),
 * builds rich_text matching the producer's pattern, voyageEmbeds, and
 * UPDATEs. Idempotent — re-running is safe.
 *
 * Two roles:
 *   1) Initial backfill drain (manual invoke with batch_size=100) for the
 *      ~741+ historical rows pre-Phase-7a.
 *   2) Steady-state miss recovery (cron every 5 min RTH) for any write-time
 *      embed failures (Voyage 5xx, transient outages).
 *
 * NEVER batches more than 20 per Voyage call per the CLAUDE.md gotcha.
 * Caller can request batch_size up to 100; we chunk internally to 20.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';

interface SpecialistReadRow {
  id: number;
  updated_at: string;
  ticker: string;
  direction_lean: string | null;
  conviction: number | null;
  flagged: boolean | null;
  flag_id: string | null;
  read_text: string | null;
  session_date: string;
}

const VOYAGE_BATCH_LIMIT = 20;

function buildRichText(r: SpecialistReadRow): string {
  const lean = r.direction_lean ?? 'na';
  const conv = r.conviction ?? 0;
  const flagged = r.flagged ? 'true' : 'false';
  const flag = r.flag_id ? r.flag_id.slice(0, 8) : '-';
  return [
    `SPECIALIST_READ | ticker:${r.ticker} lean:${lean} conv:${conv} flagged:${flagged} flag:${flag} | session:${r.session_date}`,
    r.read_text ?? '',
  ].join('\n');
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  const corsHeaders = getCorsHeaders(req);
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const body = (await req.json().catch(() => ({}))) as { batch_size?: number };
  const requested = Math.min(Math.max(body.batch_size ?? 50, 1), 100);

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Atomic claim via FOR UPDATE SKIP LOCKED RPC (migration 20260513180100).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: selectErr } = await (supabase as any)
    .rpc('claim_unembedded_specialist_reads', { p_batch_size: requested });

  if (selectErr) {
    return new Response(JSON.stringify({ ok: false, error: selectErr.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const rows: SpecialistReadRow[] = data ?? [];
  if (rows.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, embedded: 0, skipped: 0, errors: [], remaining_estimate: 0 }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }

  // Rough remaining count for progress reporting.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: remainingCount } = await (supabase
    .from('ct_specialist_reads' as never) as any)
    .select('id', { count: 'exact', head: true })
    .is('embedding', null);

  let embedded = 0;
  let skipped = 0;
  const errors: Array<{ id: number; error: string }> = [];

  for (let i = 0; i < rows.length; i += VOYAGE_BATCH_LIMIT) {
    const chunk = rows.slice(i, i + VOYAGE_BATCH_LIMIT);
    for (const row of chunk) {
      if (!row.read_text || row.read_text.trim().length === 0) {
        skipped += 1;
        continue;
      }
      const richText = buildRichText(row);
      try {
        const embedding = await voyageEmbed(richText, 'document');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: updateErr } = await (supabase.from('ct_specialist_reads' as never) as any)
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

  return new Response(
    JSON.stringify({
      ok: errors.length === 0,
      embedded,
      skipped,
      errors,
      remaining_estimate: Math.max(0, (remainingCount ?? 0) - embedded),
    }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
