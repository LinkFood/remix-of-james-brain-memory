/**
 * find-related-entries — The Connect Layer
 *
 * GOAL: Given an entry, find semantically related entries from the user's brain.
 *
 * Uses vector similarity (embeddings) plus relationship table.
 * Returns related entries with similarity scores.
 * Also returns pattern insights about the user's content.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.84.0";
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { extractUserId } from '../_shared/auth.ts';
import { checkRateLimit, RATE_LIMIT_CONFIGS, getRateLimitHeaders } from '../_shared/rateLimit.ts';
import { successResponse, errorResponse, serverErrorResponse } from '../_shared/response.ts';
import { parseJsonBody } from '../_shared/validation.ts';

interface FindRelatedRequest {
  entryId: string;
  limit?: number;
}

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    const { userId, error: authError } = await extractUserId(req);
    if (authError || !userId) {
      return errorResponse(req, authError ?? 'Unauthorized', 401);
    }

    const rateLimit = checkRateLimit(userId, RATE_LIMIT_CONFIGS.search);
    if (!rateLimit.allowed) {
      return new Response(
        JSON.stringify({ error: 'Rate limit exceeded', retryAfter: Math.ceil(rateLimit.resetIn / 1000) }),
        { status: 429, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', ...getRateLimitHeaders(rateLimit) } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data: body, error: parseError } = await parseJsonBody<FindRelatedRequest>(req);
    if (parseError || !body) {
      return errorResponse(req, parseError ?? 'Invalid request body', 400);
    }

    const { entryId, limit = 5 } = body;

    if (!entryId) {
      return errorResponse(req, 'entryId is required', 400);
    }

    // Fetch the source entry
    const { data: sourceEntry, error: fetchError } = await supabase
      .from('entries')
      .select('id, content, title, content_type, tags, embedding, user_id')
      .eq('id', entryId)
      .eq('user_id', userId)
      .single();

    if (fetchError || !sourceEntry) {
      return errorResponse(req, 'Entry not found', 404);
    }

    let relatedEntries: any[] = [];

    // Strategy 1: Use pre-computed relationships from entry_relationships table (bidirectional)
    const [{ data: forwardRelations }, { data: reverseRelations }] = await Promise.all([
      supabase
        .from('entry_relationships')
        .select(`
          related_entry_id,
          similarity_score,
          relationship_type,
          related_entry:entries!entry_relationships_related_entry_id_fkey (
            id, content, title, content_type, content_subtype, tags,
            importance_score, created_at, image_url, starred
          )
        `)
        .eq('entry_id', entryId)
        .eq('user_id', userId)
        .order('similarity_score', { ascending: false })
        .limit(limit),
      supabase
        .from('entry_relationships')
        .select(`
          entry_id,
          similarity_score,
          relationship_type,
          source_entry:entries!entry_relationships_entry_id_fkey (
            id, content, title, content_type, content_subtype, tags,
            importance_score, created_at, image_url, starred
          )
        `)
        .eq('related_entry_id', entryId)
        .eq('user_id', userId)
        .order('similarity_score', { ascending: false })
        .limit(limit),
    ]);

    const seenRelIds = new Set<string>();
    if (forwardRelations) {
      for (const r of forwardRelations as any[]) {
        if (r.related_entry && !seenRelIds.has(r.related_entry.id)) {
          seenRelIds.add(r.related_entry.id);
          relatedEntries.push({
            ...r.related_entry,
            similarity: r.similarity_score,
            relationship_type: r.relationship_type,
          });
        }
      }
    }
    if (reverseRelations) {
      for (const r of reverseRelations as any[]) {
        if (r.source_entry && !seenRelIds.has(r.source_entry.id)) {
          seenRelIds.add(r.source_entry.id);
          relatedEntries.push({
            ...r.source_entry,
            similarity: r.similarity_score,
            relationship_type: r.relationship_type,
          });
        }
      }
    }
    // Sort combined results by similarity descending
    relatedEntries.sort((a: any, b: any) => (b.similarity || 0) - (a.similarity || 0));

    // Strategy 2: If not enough stored relationships and entry has embedding, do live vector search
    if (relatedEntries.length < limit && sourceEntry.embedding) {
      try {
        const { data: vectorResults } = await supabase.rpc('search_entries_by_embedding', {
          query_embedding: sourceEntry.embedding,
          match_threshold: 0.55,
          match_count: limit + 1,
          filter_user_id: userId,
        });

        if (vectorResults) {
          const existingIds = new Set(relatedEntries.map((e: any) => e.id));
          existingIds.add(entryId); // Exclude self

          for (const result of vectorResults) {
            if (!existingIds.has(result.id) && relatedEntries.length < limit) {
              relatedEntries.push({
                ...result,
                relationship_type: 'semantic_live',
              });
            }
          }
        }
      } catch (err) {
        console.warn('Vector search failed:', err);
      }
    }

    // Strategy 3: Tag-based fallback if still not enough
    if (relatedEntries.length < limit && sourceEntry.tags && sourceEntry.tags.length > 0) {
      const existingIds = new Set(relatedEntries.map((e: any) => e.id));
      existingIds.add(entryId);

      const { data: tagResults } = await supabase
        .from('entries')
        .select('id, content, title, content_type, content_subtype, tags, importance_score, created_at, image_url, starred')
        .eq('user_id', userId)
        .eq('archived', false)
        .overlaps('tags', sourceEntry.tags)
        .neq('id', entryId)
        .order('importance_score', { ascending: false, nullsFirst: false })
        .limit(limit);

      if (tagResults) {
        for (const result of tagResults) {
          if (!existingIds.has(result.id) && relatedEntries.length < limit) {
            // Calculate tag overlap score
            const sharedTags = result.tags.filter((t: string) => sourceEntry.tags.includes(t));
            relatedEntries.push({
              ...result,
              similarity: sharedTags.length / Math.max(sourceEntry.tags.length, result.tags.length),
              relationship_type: 'tag_overlap',
            });
          }
        }
      }
    }

    // Compute pattern insights
    const patterns: any = {};
    if (relatedEntries.length > 0) {
      // Tag frequency across related entries
      const tagCounts: Record<string, number> = {};
      for (const entry of relatedEntries) {
        for (const tag of entry.tags || []) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      }
      patterns.commonTags = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([tag, count]) => ({ tag, count }));

      // Content type distribution
      const typeCounts: Record<string, number> = {};
      for (const entry of relatedEntries) {
        typeCounts[entry.content_type] = (typeCounts[entry.content_type] || 0) + 1;
      }
      patterns.typeDistribution = typeCounts;

      // Time span of related entries
      const dates = relatedEntries.map((e: any) => new Date(e.created_at).getTime()).filter(Boolean);
      if (dates.length > 1) {
        const earliest = new Date(Math.min(...dates));
        const latest = new Date(Math.max(...dates));
        patterns.timeSpan = {
          earliest: earliest.toISOString(),
          latest: latest.toISOString(),
          daySpan: Math.ceil((latest.getTime() - earliest.getTime()) / (1000 * 60 * 60 * 24)),
        };
      }
    }

    return successResponse(req, {
      entryId,
      related: relatedEntries.slice(0, limit),
      patterns,
      total: relatedEntries.length,
    }, 200, rateLimit);

  } catch (error) {
    console.error('Error in find-related-entries:', error);
    return serverErrorResponse(req, error instanceof Error ? error : new Error('Unknown error'));
  }
});
