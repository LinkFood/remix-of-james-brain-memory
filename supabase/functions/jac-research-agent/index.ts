/**
 * jac-research-agent — Research Worker for JAC Agent OS
 *
 * Called by jac-dispatcher via service role fetch. Does real work:
 * 1. Web search via jac-web-search (Tavily)
 * 2. Brain cross-reference via search-memory
 * 3. Claude Sonnet synthesis into a research brief
 * 4. Save brief to brain via smart-save
 * 5. Slack notification
 * 6. Update task status
 *
 * Every step is logged to agent_activity_log for full observability.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent } from '../_shared/anthropic.ts';
import { notifySlack } from '../_shared/slack.ts';
import { createAgentLogger } from '../_shared/logger.ts';

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

  let taskId: string | undefined;
  let parentTaskId: string | undefined;
  let userId: string | undefined;
  let slackChannel: string | undefined;
  let slackThinkingTs: string | undefined;
  const startTime = Date.now();

  try {
    const body = await req.json();
    taskId = body.taskId;
    parentTaskId = body.parentTaskId;
    userId = body.userId;
    const query = body.query as string;
    const brainContext = (body.brainContext as string) || '';
    slackChannel = body.slack_channel as string | undefined;
    slackThinkingTs = body.slack_thinking_ts as string | undefined;

    if (!taskId || !userId || !query) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Initialize logger
    const log = createAgentLogger(supabase, taskId, userId, 'jac-research-agent');

    // 1. Update task → running
    await supabase
      .from('agent_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', taskId);

    await log.info('task_started', { query, hasContext: !!brainContext });

    // 2. Web search via jac-web-search (pass userId for service role auth)
    let webResults = '';
    let webSources: Array<{ title: string; url: string }> = [];
    const webStep = await log.step('web_search', { query });
    try {
      const webRes = await fetch(`${supabaseUrl}/functions/v1/jac-web-search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          query,
          brainContext: brainContext.slice(0, 500),
          searchDepth: 'advanced',
          maxResults: 8,
          includeAnswer: true,
        }),
      });

      if (webRes.ok) {
        const webData = await webRes.json();
        webResults = webData.contextForLLM || '';
        webSources = (webData.results || []).map((r: { title: string; url: string }) => ({
          title: r.title,
          url: r.url,
        }));
        await webStep({ resultCount: webSources.length });
      } else {
        const errText = await webRes.text();
        await webStep.fail(`HTTP ${webRes.status}: ${errText.slice(0, 200)}`);
      }
    } catch (err) {
      await webStep.fail(err instanceof Error ? err.message : 'Unknown error');
    }

    // 3. Brain cross-reference via search-memory (pass userId for service role auth)
    let brainResults = '';
    let brainMatchCount = 0;
    const brainStep = await log.step('brain_search', { query });
    try {
      const memRes = await fetch(`${supabaseUrl}/functions/v1/search-memory`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId, query, limit: 5 }),
      });

      if (memRes.ok) {
        const memData = await memRes.json();
        if (memData.results && memData.results.length > 0) {
          brainResults = memData.results
            .map((r: { title?: string; content: string }) =>
              `[${r.title || 'Untitled'}]: ${r.content.slice(0, 300)}`
            )
            .join('\n');
          brainMatchCount = memData.results.length;
          await brainStep({ matchCount: brainMatchCount });
        } else {
          await brainStep({ matchCount: 0 });
        }
      } else {
        const errText = await memRes.text();
        await brainStep.fail(`HTTP ${memRes.status}: ${errText.slice(0, 200)}`);
      }
    } catch (err) {
      await brainStep.fail(err instanceof Error ? err.message : 'Unknown error');
    }

    // 4. Synthesize with Claude Sonnet
    const synthesisStep = await log.step('ai_synthesis', {
      webSourceCount: webSources.length,
      brainMatchCount,
    });

    const synthesisPrompt = `You are a research assistant. Synthesize a clear, actionable research brief based on the query and sources below.

QUERY: ${query}

${webResults ? `WEB RESULTS:\n${webResults}\n` : 'No web results available.\n'}
${brainResults ? `USER'S BRAIN (existing knowledge):\n${brainResults}\n` : ''}
${brainContext ? `ADDITIONAL CONTEXT:\n${brainContext}\n` : ''}

Instructions:
- Write a structured research brief (300-600 words)
- Lead with key findings and insights
- Note connections to the user's existing brain entries if relevant
- Include source URLs as references
- Be specific with facts, numbers, and actionable recommendations
- Format with markdown headers and bullet points`;

    const claudeResponse = await callClaude({
      model: CLAUDE_MODELS.sonnet,
      system: 'You are a thorough research assistant that produces clear, well-structured briefs.',
      messages: [{ role: 'user', content: synthesisPrompt }],
      max_tokens: 2048,
      temperature: 0.4,
    });

    const brief = parseTextContent(claudeResponse);

    if (!brief) {
      await synthesisStep.fail('Claude returned empty response');
      throw new Error('Claude returned empty response');
    }

    await synthesisStep({
      briefLength: brief.length,
      inputTokens: claudeResponse.usage?.input_tokens,
      outputTokens: claudeResponse.usage?.output_tokens,
    });

    // 5. Save brief to brain via smart-save (pass userId for service role auth)
    let brainEntryId: string | undefined;
    const saveStep = await log.step('save_to_brain');
    try {
      const saveRes = await fetch(`${supabaseUrl}/functions/v1/smart-save`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          userId,
          content: `# Research: ${query}\n\n${brief}\n\n---\nSources: ${webSources.map(s => `[${s.title}](${s.url})`).join(', ')}`,
          source: 'jac-agent',
        }),
      });

      if (saveRes.ok) {
        const saveData = await saveRes.json();
        brainEntryId = saveData.entry?.id;
        await saveStep({ brainEntryId });
      } else {
        const errText = await saveRes.text();
        await saveStep.fail(`HTTP ${saveRes.status}: ${errText.slice(0, 200)}`);
      }
    } catch (err) {
      await saveStep.fail(err instanceof Error ? err.message : 'Unknown error');
    }

    const duration = Date.now() - startTime;

    // 6. Update task → completed
    await supabase
      .from('agent_tasks')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        output: {
          brief: brief.slice(0, 5000),
          sources: webSources,
          brainEntryId,
          brainMatchCount,
          durationMs: duration,
        },
      })
      .eq('id', taskId);

    // Check if parent task should be completed
    if (parentTaskId) {
      const { count: pendingChildren } = await supabase
        .from('agent_tasks')
        .select('id', { count: 'exact', head: true })
        .eq('parent_task_id', parentTaskId)
        .in('status', ['queued', 'running']);

      if ((pendingChildren ?? 0) === 0) {
        await supabase
          .from('agent_tasks')
          .update({
            status: 'completed',
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', parentTaskId);
      }
    }

    // 7. Slack notification
    const slackStep = await log.step('slack_notify');
    await notifySlack(supabase, userId, {
      taskId,
      taskType: 'research',
      summary: `Researched: "${query.slice(0, 60)}"\n${brief.slice(0, 200)}...`,
      brainEntryId,
      duration,
      slackChannel,
      slackThinkingTs,
    });
    await slackStep();

    // Store result as assistant message in conversation
    await supabase.from('agent_conversations').insert({
      user_id: userId,
      role: 'assistant',
      content: `Research complete: ${query}\n\n${brief.slice(0, 500)}...${brainEntryId ? `\n\nSaved to brain.` : ''}`,
      task_ids: [taskId],
    });

    await log.info('task_completed', { durationMs: duration, brainEntryId, sourceCount: webSources.length });

    return new Response(JSON.stringify({
      success: true,
      brief: brief.slice(0, 1000),
      brainEntryId,
      durationMs: duration,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[research-agent] Error:', error);

    if (taskId) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await supabase
        .from('agent_tasks')
        .update({
          status: 'failed',
          error: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', taskId);

      // Also mark parent task as failed so it doesn't stay stuck at "running"
      if (parentTaskId) {
        await supabase
          .from('agent_tasks')
          .update({
            status: 'failed',
            error: `Child task failed: ${errorMessage}`,
            completed_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', parentTaskId);
      }

      if (userId) {
        // Log the failure
        const log = createAgentLogger(supabase, taskId, userId, 'jac-research-agent');
        await log.info('task_failed', { error: errorMessage, durationMs: Date.now() - startTime });

        await notifySlack(supabase, userId, {
          taskId,
          taskType: 'research',
          summary: '',
          error: errorMessage,
          duration: Date.now() - startTime,
          slackChannel,
          slackThinkingTs,
        });
      }
    }

    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Research agent failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
