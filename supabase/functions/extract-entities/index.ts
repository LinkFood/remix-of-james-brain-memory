/**
 * extract-entities — Named Entity Extraction for JAC Agent OS
 *
 * Called fire-and-forget by smart-save and jac-reflect after content is saved.
 * Extracts named entities from content via Claude Haiku, upserts into
 * brain_entities, and creates entity_mentions linking entity to source.
 *
 * Auth: Service role only (internal agent call).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse } from '../_shared/anthropic.ts';

const EXTRACT_ENTITIES_TOOL = {
  name: 'extract_entities',
  description: 'Extract named entities from the provided content.',
  input_schema: {
    type: 'object' as const,
    properties: {
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: {
              type: 'string',
              enum: ['person', 'project', 'place', 'concept', 'organization'],
            },
            context_snippet: {
              type: 'string',
              description: '1-2 sentence context of how this entity appears',
            },
          },
          required: ['name', 'type', 'context_snippet'],
        },
      },
    },
    required: ['entities'],
  },
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized — service role required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json();
    const userId = body.userId as string;
    const content = body.content as string;
    const sourceEntryId = body.sourceEntryId as string | undefined;
    const sourceReflectionId = body.sourceReflectionId as string | undefined;

    if (!userId || !content) {
      return new Response(JSON.stringify({ error: 'Missing userId or content' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Truncate content to avoid blowing up token usage
    const truncatedContent = content.slice(0, 4000);

    // 1. Call Claude Haiku to extract entities
    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: `You are an entity extraction engine. Extract all named entities (people, projects, places, concepts, organizations) from the provided content. Only extract entities that are clearly named or referenced — do not invent entities. If there are no entities, return an empty array.`,
      messages: [{
        role: 'user',
        content: truncatedContent,
      }],
      tools: [EXTRACT_ENTITIES_TOOL],
      tool_choice: { type: 'tool', name: 'extract_entities' },
      max_tokens: 1024,
      temperature: 0.2,
    });

    const toolResult = parseToolUse(claudeResponse);
    const rawEntities = toolResult?.input?.entities;
    // Claude Haiku ignores type: "array" ~80% of the time — always guard
    const entities: Array<{ name: string; type: string; context_snippet: string }> =
      Array.isArray(rawEntities) ? rawEntities : [];

    if (entities.length === 0) {
      console.log(`[extract-entities] No entities found in content for user ${userId}`);
      return new Response(JSON.stringify({ success: true, entities: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    console.log(`[extract-entities] Found ${entities.length} entities for user ${userId}`);

    let created = 0;
    let updated = 0;

    for (const entity of entities) {
      const normalizedName = entity.name.trim();
      if (!normalizedName) continue;

      // 2. Check if entity already exists for this user
      const { data: existing } = await supabase
        .from('brain_entities')
        .select('id, mention_count')
        .eq('user_id', userId)
        .eq('name', normalizedName)
        .single();

      let entityId: string;

      if (existing) {
        // 3a. Entity exists — bump mention_count and update last_seen
        const { error: updateError } = await supabase
          .from('brain_entities')
          .update({
            mention_count: (existing.mention_count || 0) + 1,
            last_seen: new Date().toISOString(),
          })
          .eq('id', existing.id);

        if (updateError) {
          console.warn(`[extract-entities] Failed to update entity "${normalizedName}":`, updateError.message);
          continue;
        }

        entityId = existing.id;
        updated++;
      } else {
        // 3b. New entity — insert + generate embedding
        let embedding: number[] | null = null;
        try {
          const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${serviceKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              text: `${normalizedName} | ${entity.type} | ${entity.context_snippet}`,
              input_type: 'document',
            }),
          });

          if (embRes.ok) {
            const embData = await embRes.json();
            embedding = embData.embedding || null;
          } else {
            console.warn(`[extract-entities] Embedding generation failed for "${normalizedName}":`, embRes.status);
          }
        } catch (err) {
          console.warn(`[extract-entities] Embedding fetch error for "${normalizedName}":`, err);
        }

        const { data: newEntity, error: insertError } = await supabase
          .from('brain_entities')
          .insert({
            user_id: userId,
            name: normalizedName,
            entity_type: entity.type,
            context_snippet: entity.context_snippet,
            mention_count: 1,
            last_seen: new Date().toISOString(),
            embedding: embedding ? JSON.stringify(embedding) : null,
          })
          .select('id')
          .single();

        if (insertError) {
          console.warn(`[extract-entities] Failed to insert entity "${normalizedName}":`, insertError.message);
          continue;
        }

        entityId = newEntity.id;
        created++;
      }

      // 4. Create entity_mention linking entity to source
      const mentionData: Record<string, unknown> = {
        entity_id: entityId,
        user_id: userId,
        context_snippet: entity.context_snippet,
      };
      if (sourceEntryId) mentionData.source_entry_id = sourceEntryId;
      if (sourceReflectionId) mentionData.source_reflection_id = sourceReflectionId;

      const { error: mentionError } = await supabase
        .from('entity_mentions')
        .insert(mentionData);

      if (mentionError) {
        console.warn(`[extract-entities] Failed to create mention for "${normalizedName}":`, mentionError.message);
      }
    }

    console.log(`[extract-entities] Done: ${created} created, ${updated} updated for user ${userId}`);

    return new Response(JSON.stringify({
      success: true,
      entities: entities.length,
      created,
      updated,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[extract-entities] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Entity extraction failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
