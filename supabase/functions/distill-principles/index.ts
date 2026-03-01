/**
 * distill-principles — Weekly Principle Extraction for JAC Agent OS
 *
 * Cron: weekly, Sunday 3 AM UTC. Analyzes recent reflections and
 * extracts/updates/retires strategic principles that guide JAC's behavior.
 *
 * Auth: Service role only (cron call).
 * Model: Claude Sonnet (strategic analysis needs quality).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse } from '../_shared/anthropic.ts';

const DISTILL_PRINCIPLES_TOOL = {
  name: 'distill_principles',
  description: 'Extract, update, or retire strategic principles based on recent reflections.',
  input_schema: {
    type: 'object' as const,
    properties: {
      principles: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            principle: { type: 'string' },
            confidence: {
              type: 'number',
              minimum: 0,
              maximum: 1,
            },
            action: {
              type: 'string',
              enum: ['create', 'update', 'retire'],
            },
            existingId: {
              type: 'string',
              description: 'ID of existing principle for update/retire',
            },
          },
          required: ['principle', 'confidence', 'action'],
        },
      },
    },
    required: ['principles'],
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
    // 1. Get all users from profiles
    const { data: users, error: usersError } = await supabase
      .from('profiles')
      .select('id');

    if (usersError || !users || users.length === 0) {
      console.log('[distill-principles] No users found');
      return new Response(JSON.stringify({ message: 'No users found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const results: Array<{ userId: string; created: number; updated: number; retired: number }> = [];

    for (const user of users) {
      const userId = user.id as string;

      // 2a. Load last 50 reflections
      const { data: reflections } = await supabase
        .from('jac_reflections')
        .select('task_type, intent, summary, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(50);

      if (!reflections || reflections.length === 0) {
        console.log(`[distill-principles] No reflections for user ${userId}, skipping`);
        continue;
      }

      // 2b. Load existing principles
      const { data: existingPrinciples } = await supabase
        .from('brain_principles')
        .select('id, principle, confidence, last_validated')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      const principles = existingPrinciples || [];

      // Build context
      const reflectionContext = reflections
        .map((r: { task_type: string; intent: string | null; summary: string; created_at: string }) =>
          `- [${r.created_at.split('T')[0]}] ${r.intent || r.task_type}: ${r.summary}`
        )
        .join('\n');

      const principleContext = principles.length > 0
        ? principles
            .map((p: { id: string; principle: string; confidence: number; last_validated: string | null }) =>
              `- [${p.id}] "${p.principle}" (confidence: ${p.confidence}, last validated: ${p.last_validated || 'never'})`
            )
            .join('\n')
        : 'No existing principles.';

      // 3. Claude Sonnet: analyze and distill
      const claudeResponse = await callClaude({
        model: CLAUDE_MODELS.sonnet,
        system: `You are JAC's principle distillation engine. Analyze the user's recent reflections and extract strategic principles — recurring patterns of behavior, decision-making heuristics, or learned lessons that should guide future actions.

Rules:
- Create new principles when you see a clear, repeated pattern across multiple reflections
- Update existing principles when new evidence strengthens or refines them (bump confidence)
- Retire existing principles that are contradicted by recent behavior or no longer relevant
- Each principle should be a clear, actionable statement (e.g., "Parallel execution of independent tasks significantly reduces total completion time")
- Confidence: 0.0-0.3 = emerging pattern, 0.4-0.6 = moderate evidence, 0.7-1.0 = strong/validated
- For updates and retires, you MUST include the existingId field
- Aim for quality over quantity — 1-5 principles per cycle
- Don't create principles that are too generic (e.g., "Be organized") — they must be specific to this user's actual patterns`,
        messages: [{
          role: 'user',
          content: `RECENT REFLECTIONS (last 50):\n${reflectionContext}\n\nEXISTING PRINCIPLES:\n${principleContext}\n\nDistill principles from these reflections. Create new ones, update existing ones with new evidence, or retire contradicted ones.`,
        }],
        tools: [DISTILL_PRINCIPLES_TOOL],
        tool_choice: { type: 'tool', name: 'distill_principles' },
        max_tokens: 2048,
        temperature: 0.3,
      });

      const toolResult = parseToolUse(claudeResponse);
      const rawPrinciples = toolResult?.input?.principles;
      // Claude Haiku ignores type: "array" ~80% of the time — always guard (even with Sonnet, be safe)
      const distilled: Array<{
        principle: string;
        confidence: number;
        action: string;
        existingId?: string;
      }> = Array.isArray(rawPrinciples) ? rawPrinciples : [];

      let created = 0;
      let updated = 0;
      let retired = 0;

      for (const item of distilled) {
        if (item.action === 'create') {
          // Generate embedding for new principle
          let embedding: number[] | null = null;
          try {
            const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${serviceKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                text: item.principle,
                input_type: 'document',
              }),
            });

            if (embRes.ok) {
              const embData = await embRes.json();
              embedding = embData.embedding || null;
            } else {
              console.warn(`[distill-principles] Embedding failed for principle:`, embRes.status);
            }
          } catch (err) {
            console.warn(`[distill-principles] Embedding fetch error:`, err);
          }

          const { error: insertError } = await supabase
            .from('brain_principles')
            .insert({
              user_id: userId,
              principle: item.principle,
              confidence: item.confidence,
              last_validated: new Date().toISOString(),
              embedding: embedding ? JSON.stringify(embedding) : null,
            });

          if (insertError) {
            console.warn(`[distill-principles] Insert error:`, insertError.message);
          } else {
            created++;
          }

        } else if (item.action === 'update' && item.existingId) {
          // Re-generate embedding for updated principle
          let embedding: number[] | null = null;
          try {
            const embRes = await fetch(`${supabaseUrl}/functions/v1/generate-embedding`, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${serviceKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                text: item.principle,
                input_type: 'document',
              }),
            });

            if (embRes.ok) {
              const embData = await embRes.json();
              embedding = embData.embedding || null;
            } else {
              console.warn(`[distill-principles] Embedding failed for updated principle:`, embRes.status);
            }
          } catch (err) {
            console.warn(`[distill-principles] Embedding fetch error:`, err);
          }

          const updateData: Record<string, unknown> = {
            principle: item.principle,
            confidence: item.confidence,
            last_validated: new Date().toISOString(),
          };
          if (embedding) {
            updateData.embedding = JSON.stringify(embedding);
          }

          const { error: updateError } = await supabase
            .from('brain_principles')
            .update(updateData)
            .eq('id', item.existingId)
            .eq('user_id', userId);

          if (updateError) {
            console.warn(`[distill-principles] Update error for ${item.existingId}:`, updateError.message);
          } else {
            updated++;
          }

        } else if (item.action === 'retire' && item.existingId) {
          const { error: deleteError } = await supabase
            .from('brain_principles')
            .delete()
            .eq('id', item.existingId)
            .eq('user_id', userId);

          if (deleteError) {
            console.warn(`[distill-principles] Delete error for ${item.existingId}:`, deleteError.message);
          } else {
            retired++;
          }
        }
      }

      console.log(`[distill-principles] User ${userId}: ${created} created, ${updated} updated, ${retired} retired`);
      results.push({ userId, created, updated, retired });
    }

    console.log(`[distill-principles] Done: processed ${results.length} users`);

    return new Response(JSON.stringify({
      success: true,
      results,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[distill-principles] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Principle distillation failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
