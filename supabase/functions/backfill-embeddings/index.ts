/**
 * backfill-embeddings — Batch embedding generation for entries missing vectors
 *
 * Queries entries WHERE embedding IS NULL, calls generate-embedding for each
 * using rich text (title | type | tags | content), updates the entry,
 * then creates entry_relationships via semantic similarity.
 *
 * Processes in batches of 20 (kept small to avoid edge function timeout).
 *
 * No auth gate — this is an internal batch job that uses service role internally.
 * Deploy with --no-verify-jwt. Invoke manually or via cron.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { isServiceRoleRequest } from '../_shared/auth.ts';

const BATCH_SIZE = 20;

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  // Auth gate: only service-role calls (pg_cron, internal) allowed
  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Optional: filter to a specific user if passed in body
    let filterUserId: string | null = null;
    try {
      const body = await req.clone().json();
      if (body?.userId && typeof body.userId === 'string') {
        filterUserId = body.userId;
      }
    } catch {}

    // Query entries missing embeddings — include metadata for rich text
    let query = supabase
      .from('entries')
      .select('id, content, title, content_type, tags, user_id')
      .is('embedding', null)
      .eq('archived', false)
      .order('created_at', { ascending: false })
      .limit(BATCH_SIZE);

    if (filterUserId) {
      query = query.eq('user_id', filterUserId);
    }

    const { data: entries, error: queryError } = await query;

    if (queryError) {
      console.error('backfill-embeddings query error:', queryError);
      return new Response(JSON.stringify({ error: 'Query failed' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!entries || entries.length === 0) {
      return new Response(JSON.stringify({
        message: 'No entries need embedding backfill',
        processed: 0, failed: 0, remaining: 0, hasMore: false,
      }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    console.log(`backfill-embeddings: processing ${entries.length} entries`);

    let processed = 0;
    let failed = 0;
    let relationshipsCreated = 0;

    for (const entry of entries) {
      // Construct rich embedding text (matches smart-save format)
      const title = (entry.title as string) || '';
      const contentType = (entry.content_type as string) || 'note';
      const tags = (entry.tags as string[]) || [];
      const content = (entry.content as string) || '';
      const richText = `${title} | ${contentType} | ${tags.join(', ')} | ${content}`.slice(0, 8000);

      if (richText.length < 10) {
        failed++;
        continue;
      }

      try {
        const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ text: richText }),
        });

        if (!embRes.ok) {
          console.warn(`backfill: embedding failed for ${entry.id}: HTTP ${embRes.status}`);
          failed++;
          continue;
        }

        const embData = await embRes.json();
        if (!embData.embedding) {
          failed++;
          continue;
        }

        const { error: updateError } = await supabase
          .from('entries')
          .update({ embedding: JSON.stringify(embData.embedding) })
          .eq('id', entry.id);

        if (updateError) {
          console.warn(`backfill: update failed for ${entry.id}:`, updateError);
          failed++;
          continue;
        }

        processed++;

        // Create entry_relationships via semantic similarity
        try {
          const userId = entry.user_id as string;
          const { data: related } = await supabase.rpc('search_entries_by_embedding', {
            query_embedding: JSON.stringify(embData.embedding),
            match_threshold: 0.65,
            match_count: 6,
            filter_user_id: userId,
          });

          if (related && related.length > 0) {
            const relationships = related
              .filter((r: any) => r.id !== entry.id)
              .slice(0, 5)
              .map((r: any) => ({
                entry_id: entry.id,
                related_entry_id: r.id,
                user_id: userId,
                similarity_score: r.similarity,
                relationship_type: 'semantic',
              }));

            if (relationships.length > 0) {
              // Delete existing relationships for this entry first (re-embed = re-relate)
              await supabase
                .from('entry_relationships')
                .delete()
                .eq('entry_id', entry.id);

              await supabase.from('entry_relationships').insert(relationships);
              relationshipsCreated += relationships.length;
            }
          }
        } catch (relErr) {
          console.warn(`backfill: relationships failed for ${entry.id}:`, relErr);
        }
      } catch (err) {
        console.warn(`backfill: error for ${entry.id}:`, err);
        failed++;
      }
    }

    // Check if more entries remain
    let remainingQuery = supabase
      .from('entries')
      .select('id', { count: 'exact', head: true })
      .is('embedding', null)
      .eq('archived', false);

    if (filterUserId) {
      remainingQuery = remainingQuery.eq('user_id', filterUserId);
    }

    const { count: remaining } = await remainingQuery;

    console.log(`backfill-embeddings: processed=${processed}, failed=${failed}, relationships=${relationshipsCreated}, remaining=${remaining}`);

    return new Response(JSON.stringify({
      processed,
      failed,
      relationshipsCreated,
      remaining: remaining ?? 0,
      hasMore: (remaining ?? 0) > 0,
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('backfill-embeddings error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
