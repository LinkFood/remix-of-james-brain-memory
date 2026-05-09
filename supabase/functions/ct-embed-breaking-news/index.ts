/**
 * ct-embed-breaking-news — backlog drainer for ct_breaking_news embedding
 * (Phase 2, fusion ground-truth audit Section B gap on Tavily firehose).
 *
 * Cron-only pattern (no producer edits) — accepts ~5-min embed latency in
 * exchange for not touching ct-news-sweep + ct-tavily-news-watcher producer
 * code paths. Acceptable: breaking-news semantic recall is "find similar
 * past news days" not "embed within 1 second of insert."
 *
 * Picks rows with NULL embedding (newest-first), builds rich_text matching
 * the documented cluster axis, voyageEmbeds + UPDATEs.
 *
 * Returns { ok, embedded, skipped, errors[], remaining_estimate }.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { voyageEmbed } from '../_shared/ctEmbed.ts';

interface BreakingNewsRow {
  id: string;
  ingested_at: string;
  source: string | null;
  headline: string | null;
  summary: string | null;
  severity: number | null;
  sentiment: string | null;
  category: string | null;
  tickers_affected: string[] | null;
  macro_wide: boolean | null;
}

const VOYAGE_BATCH_LIMIT = 20;

function buildRichText(r: BreakingNewsRow): string {
  const sev = r.severity ?? 0;
  const sent = r.sentiment ?? 'na';
  const cat = r.category ?? 'na';
  const tickers = (r.tickers_affected ?? []).join(',') || '-';
  const macro = r.macro_wide ? 'true' : 'false';
  return [
    `BREAKING_NEWS | sev:${sev} sent:${sent} cat:${cat} tickers:[${tickers}] macro:${macro}`,
    r.headline ?? '',
    r.summary ?? '',
  ].filter((s) => s.length > 0).join('\n');
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error: selectErr } = await (supabase.from('ct_breaking_news' as never) as any)
    .select('id,ingested_at,source,headline,summary,severity,sentiment,category,tickers_affected,macro_wide')
    .is('embedding', null)
    .order('ingested_at', { ascending: false })
    .limit(requested);

  if (selectErr) {
    return new Response(JSON.stringify({ ok: false, error: selectErr.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  const rows: BreakingNewsRow[] = data ?? [];
  if (rows.length === 0) {
    return new Response(JSON.stringify({
      ok: true, embedded: 0, skipped: 0, errors: [], remaining_estimate: 0,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { count: remainingCount } = await (supabase
    .from('ct_breaking_news' as never) as any)
    .select('id', { count: 'exact', head: true })
    .is('embedding', null);

  let embedded = 0;
  let skipped = 0;
  const errors: Array<{ id: string; error: string }> = [];

  for (let i = 0; i < rows.length; i += VOYAGE_BATCH_LIMIT) {
    const chunk = rows.slice(i, i + VOYAGE_BATCH_LIMIT);
    for (const row of chunk) {
      const richText = buildRichText(row);
      if (richText.trim().length === 0) {
        skipped += 1;
        continue;
      }
      try {
        const embedding = await voyageEmbed(richText, 'document');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const { error: updateErr } = await (supabase.from('ct_breaking_news' as never) as any)
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
