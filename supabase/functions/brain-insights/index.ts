/**
 * brain-insights — AI-powered insight generation
 *
 * Cron-triggered (twice daily). Analyzes recent entries, detects patterns,
 * surfaces stale items, provides suggestions. Writes to brain_insights table.
 *
 * Deploy with --no-verify-jwt. Invoked via pg_cron.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { handleCors, getCorsHeaders } from '../_shared/cors.ts';
import { callClaude, CLAUDE_MODELS, parseToolUse } from '../_shared/anthropic.ts';

const INSIGHT_TOOL = {
  name: 'generate_insights',
  description: 'Generate proactive insights about the user\'s brain entries.',
  input_schema: {
    type: 'object' as const,
    properties: {
      insights: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['pattern', 'overdue', 'stale', 'schedule', 'suggestion'],
              description: 'pattern = recurring theme detected. overdue = past-due items. stale = high-importance entries not touched recently. schedule = upcoming event prep. suggestion = actionable recommendation.',
            },
            title: { type: 'string', description: 'Short title (under 60 chars)' },
            body: { type: 'string', description: 'One paragraph explanation' },
            priority: { type: 'number', enum: [1, 2, 3], description: '1 = high, 2 = medium, 3 = low' },
            entry_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'IDs of entries related to this insight',
            },
          },
          required: ['type', 'title', 'body', 'priority', 'entry_ids'],
        },
        description: 'List of insights (max 5)',
      },
    },
    required: ['insights'],
  },
};

serve(async (req) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  const corsHeaders = getCorsHeaders(req);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // Get all users with entries (single-user system, but future-proof)
    const { data: users } = await supabase
      .from('entries')
      .select('user_id')
      .eq('archived', false)
      .limit(1);

    if (!users || users.length === 0) {
      return new Response(JSON.stringify({ message: 'No users with entries' }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const userId = users[0].user_id as string;
    let totalInsights = 0;

    // 1. Recent entries (7 days)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentEntries } = await supabase
      .from('entries')
      .select('id, title, content_type, tags, importance_score, event_date, created_at')
      .eq('user_id', userId)
      .eq('archived', false)
      .gte('created_at', weekAgo)
      .order('created_at', { ascending: false })
      .limit(30);

    // 2. Overdue entries
    const today = new Date().toISOString().split('T')[0];
    const { data: overdueEntries } = await supabase
      .from('entries')
      .select('id, title, content_type, event_date')
      .eq('user_id', userId)
      .eq('archived', false)
      .lt('event_date', today)
      .in('content_type', ['reminder', 'event'])
      .limit(10);

    // 3. Stale high-importance entries (not updated in 14+ days, importance >= 7)
    const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data: staleEntries } = await supabase
      .from('entries')
      .select('id, title, content_type, importance_score, updated_at')
      .eq('user_id', userId)
      .eq('archived', false)
      .gte('importance_score', 7)
      .lt('updated_at', twoWeeksAgo)
      .order('importance_score', { ascending: false })
      .limit(10);

    // 4. Tag distribution (from recent entries)
    const tagCounts: Record<string, number> = {};
    for (const e of (recentEntries || [])) {
      for (const tag of ((e.tags as string[]) || [])) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
    const topTags = Object.entries(tagCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => `${tag} (${count})`);

    // 5. Upcoming events (next 3 days)
    const threeDaysOut = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const { data: upcomingEntries } = await supabase
      .from('entries')
      .select('id, title, content_type, event_date, event_time')
      .eq('user_id', userId)
      .eq('archived', false)
      .gte('event_date', today)
      .lte('event_date', threeDaysOut)
      .order('event_date', { ascending: true })
      .limit(10);

    // Build context for Claude
    const contextParts: string[] = [];

    if (recentEntries && recentEntries.length > 0) {
      contextParts.push(`RECENT ENTRIES (past 7 days, ${recentEntries.length} total):`);
      for (const e of recentEntries.slice(0, 15)) {
        contextParts.push(`  [${e.id}] "${e.title || 'Untitled'}" (${e.content_type}, importance: ${e.importance_score ?? '?'}, tags: ${((e.tags as string[]) || []).join(', ') || 'none'}, created: ${e.created_at})`);
      }
    }

    if (overdueEntries && overdueEntries.length > 0) {
      contextParts.push(`\nOVERDUE ITEMS (${overdueEntries.length}):`);
      for (const e of overdueEntries) {
        contextParts.push(`  [${e.id}] "${e.title || 'Untitled'}" (${e.content_type}, due: ${e.event_date})`);
      }
    }

    if (staleEntries && staleEntries.length > 0) {
      contextParts.push(`\nSTALE HIGH-IMPORTANCE (${staleEntries.length}, not touched in 14+ days):`);
      for (const e of staleEntries) {
        contextParts.push(`  [${e.id}] "${e.title || 'Untitled'}" (importance: ${e.importance_score}, last updated: ${e.updated_at})`);
      }
    }

    if (topTags.length > 0) {
      contextParts.push(`\nTOP TAGS (last 7 days): ${topTags.join(', ')}`);
    }

    if (upcomingEntries && upcomingEntries.length > 0) {
      contextParts.push(`\nUPCOMING (next 3 days):`);
      for (const e of upcomingEntries) {
        contextParts.push(`  [${e.id}] "${e.title || 'Untitled'}" (${e.event_date}${e.event_time ? ' at ' + e.event_time : ''})`);
      }
    }

    if (contextParts.length === 0) {
      return new Response(JSON.stringify({ message: 'Not enough data for insights', insights: 0 }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Call Claude Haiku with forced tool use
    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.haiku,
      system: `You are Jac's brain insight engine. Analyze the user's saved entries and generate useful, actionable insights.

Rules:
- Generate 1-5 insights, prioritized by importance
- Each insight must reference specific entry IDs
- Types: "pattern" (recurring themes/behaviors), "overdue" (past-due items needing attention), "stale" (important but forgotten items), "schedule" (upcoming event preparation), "suggestion" (actionable recommendation)
- Be specific, not generic. "You have 3 overdue items" is better than "Stay organized"
- For patterns: look for recurring tags, types, or themes across recent entries
- For suggestions: recommend actions based on what the user has been saving
- Priority 1 = urgent (overdue, upcoming), 2 = useful (patterns, stale), 3 = nice-to-know (suggestions)
- Keep titles under 60 chars, body to one paragraph
- Today's date: ${today}`,
      messages: [{
        role: 'user',
        content: contextParts.join('\n'),
      }],
      tools: [INSIGHT_TOOL],
      tool_choice: { type: 'tool', name: 'generate_insights' },
      max_tokens: 2048,
      temperature: 0.4,
    });

    const toolResult = parseToolUse(claudeResponse);
    const insights = (toolResult?.input?.insights as any[]) || [];

    if (insights.length > 0) {
      // Delete previous insights for this user
      await supabase
        .from('brain_insights')
        .delete()
        .eq('user_id', userId);

      // Insert new insights with 3-day expiry
      const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
      const rows = insights.slice(0, 5).map((insight: any) => ({
        user_id: userId,
        type: insight.type,
        title: insight.title,
        body: insight.body,
        priority: insight.priority,
        entry_ids: insight.entry_ids || [],
        dismissed: false,
        expires_at: expiresAt,
      }));

      const { error: insertError } = await supabase
        .from('brain_insights')
        .insert(rows);

      if (insertError) {
        console.error('brain-insights insert error:', insertError);
      } else {
        totalInsights = rows.length;
      }
    }

    console.log(`brain-insights: generated ${totalInsights} insights for user ${userId}`);

    return new Response(JSON.stringify({
      insights: totalInsights,
      userId,
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('brain-insights error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
