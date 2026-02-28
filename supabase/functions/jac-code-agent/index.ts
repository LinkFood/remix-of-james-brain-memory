/**
 * jac-code-agent — Code Worker for JAC Agent OS
 *
 * Called by jac-dispatcher via service role fetch. Does real work:
 * 1. Load project from code_projects
 * 2. Fetch repo file tree via GitHub API
 * 3. Claude Sonnet plans changes (which files to read, what to change)
 * 4. Read relevant files from repo
 * 5. Claude Sonnet writes code
 * 6. Create branch, commit files, open PR
 * 7. Save summary to brain via smart-save
 * 8. Slack notification
 * 9. Update task status
 *
 * Every step is logged to agent_activity_log for full observability.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { callClaude, CLAUDE_MODELS, parseTextContent, parseToolUse, calculateCost, recordTokenUsage, resolveModel } from '../_shared/anthropic.ts';
import type { ModelTier } from '../_shared/anthropic.ts';
import { notifySlack } from '../_shared/slack.ts';
import { createAgentLogger } from '../_shared/logger.ts';
import { getRepoTree, getFileContent, createBranch, commitFiles, createPR, isSecretFile } from '../_shared/github.ts';
import type { FileChange } from '../_shared/github.ts';

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
    const projectId = body.projectId as string;
    const projectName = (body.projectName as string) || '';
    const repoFullName = (body.repoFullName as string) || '';
    slackChannel = body.slack_channel as string | undefined;
    slackThinkingTs = body.slack_thinking_ts as string | undefined;
    const brainContext = (body.brainContext as string) || '';
    const modelTier = (body.modelTier as ModelTier) || 'sonnet';
    const codeModel = resolveModel(modelTier);

    const missingFields = [
      ...(!taskId ? ['taskId'] : []),
      ...(!userId ? ['userId'] : []),
      ...(!query ? ['query'] : []),
      ...(!projectId ? ['projectId'] : []),
    ];
    if (missingFields.length > 0) {
      return new Response(JSON.stringify({ error: `Missing required fields: ${missingFields.join(', ')}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Initialize logger
    const log = createAgentLogger(supabase, taskId, userId, 'jac-code-agent');

    // 1. Update task → running
    await supabase
      .from('agent_tasks')
      .update({ status: 'running', updated_at: new Date().toISOString() })
      .eq('id', taskId);

    await log.info('task_started', { query, projectId, projectName, modelTier });

    // ─── Step 1: resolve_project ───
    const projectStep = await log.step('resolve_project', { projectId });
    const { data: project, error: projectError } = await supabase
      .from('code_projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projectError || !project) {
      await projectStep.fail(projectError?.message || 'Project not found');
      throw new Error(`Project not found: ${projectId}`);
    }

    const repoFull = (project.repo_full_name as string) || repoFullName;
    const defaultBranch = (project.default_branch as string) || 'main';
    const [owner, repo] = repoFull.split('/');

    if (!owner || !repo) {
      await projectStep.fail(`Invalid repo_full_name: ${repoFull}`);
      throw new Error(`Invalid repo_full_name: ${repoFull}`);
    }

    await projectStep({ repoFull, defaultBranch });

    // ─── Step 2: fetch_tree ───
    const treeStep = await log.step('fetch_tree', { repoFull, defaultBranch });
    const rawTree = await getRepoTree(owner, repo, defaultBranch);
    const fileTree = rawTree.filter(f => !isSecretFile(f));
    await treeStep({ totalFiles: rawTree.length, filteredFiles: fileTree.length });

    // Cache tree on project
    await supabase
      .from('code_projects')
      .update({ file_tree_cache: fileTree, updated_at: new Date().toISOString() })
      .eq('id', projectId);

    // ─── Kill switch check ───
    async function checkCancelled(): Promise<boolean> {
      const { data } = await supabase
        .from('agent_tasks')
        .select('status')
        .eq('id', taskId!)
        .single();
      return data?.status === 'cancelled';
    }

    if (await checkCancelled()) {
      await log.info('task_cancelled', { step: 'before_plan' });
      return new Response(JSON.stringify({ cancelled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ─── Step 2b: load past sessions for this project ───
    let pastSessionsBlock = '';
    try {
      const { data: pastSessions } = await supabase
        .from('code_sessions')
        .select('branch_name, intent, files_changed, created_at')
        .eq('project_id', projectId)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .limit(3);

      if (pastSessions && pastSessions.length > 0) {
        pastSessionsBlock = '\n=== RECENT SESSIONS (this project) ===\n' +
          pastSessions.map((s: { branch_name: string; intent: string; files_changed: string[]; created_at: string }) =>
            `- ${s.created_at.slice(0, 10)}: "${s.intent}" → branch ${s.branch_name}, changed: ${(s.files_changed || []).join(', ')}`
          ).join('\n');
      }
    } catch (err) {
      console.warn('[code-agent] Past sessions lookup failed (non-blocking):', err);
    }

    // ─── Step 3: plan ───
    const planStep = await log.step('plan', { query, fileCount: fileTree.length });

    const planTools = [
      {
        name: 'submit_plan',
        description: 'Submit the implementation plan',
        input_schema: {
          type: 'object',
          properties: {
            filesToRead: {
              type: 'array',
              items: { type: 'string' },
              description: 'File paths to read for context (max 10)',
            },
            plan: {
              type: 'string',
              description: 'Step-by-step plan of what changes to make',
            },
            branchSlug: {
              type: 'string',
              description: 'Short slug for branch name, e.g. fix-auth-bug',
            },
          },
          required: ['filesToRead', 'plan', 'branchSlug'],
        },
      },
    ];

    const techStack = (project.tech_stack as string[] | null) || [];
    const projectDescription = (project.description as string) || '';

    const planPrompt = `You are an autonomous coding agent. Analyze the user's request and the repo file tree, then plan what changes to make.

PROJECT: ${projectName || repoFull}
REPO: ${repoFull}
${techStack.length > 0 ? `TECH STACK: ${techStack.join(', ')}` : ''}
${projectDescription ? `DESCRIPTION: ${projectDescription}` : ''}

USER REQUEST: ${query}
${brainContext ? `\n=== USER'S BRAIN CONTEXT ===\nThese are related notes, decisions, and past work from the user's brain:\n${brainContext}\n` : ''}${pastSessionsBlock}
FILE TREE (${fileTree.length} files):
${fileTree.join('\n')}

Instructions:
- Select up to 10 files you need to read for context
- Write a clear step-by-step plan of what to change
- Generate a short branch slug (lowercase, hyphens, no spaces) like "fix-auth-bug" or "add-dark-mode"
- Be specific about which files to create/modify and what changes to make
- Use the submit_plan tool to return your plan`;

    const planResponse = await callClaude({
      model: codeModel,
      system: 'You are a precise coding agent. Plan changes carefully. Use the submit_plan tool.',
      messages: [{ role: 'user', content: planPrompt }],
      tools: planTools,
      tool_choice: { type: 'tool', name: 'submit_plan' },
      max_tokens: 4096,
      temperature: 0.3,
    });

    const planResult = parseToolUse(planResponse);
    if (!planResult || !planResult.input) {
      await planStep.fail('Claude did not return a plan');
      throw new Error('Claude did not return a plan via tool use');
    }

    const rawFilesToRead = planResult.input.filesToRead;
    const filesToRead = (Array.isArray(rawFilesToRead) ? rawFilesToRead : rawFilesToRead ? [rawFilesToRead] : []).slice(0, 10) as string[];
    const plan = (planResult.input.plan as string) || '';
    const branchSlug = (planResult.input.branchSlug as string) || 'code-change';

    await planStep({
      filesToRead: filesToRead.length,
      planLength: plan.length,
      branchSlug,
      inputTokens: planResponse.usage?.input_tokens,
      outputTokens: planResponse.usage?.output_tokens,
    });

    // ─── Step 4: read_files ───
    const readStep = await log.step('read_files', { count: filesToRead.length });
    const fileContents: Array<{ path: string; content: string }> = [];
    const readErrors: string[] = [];

    const readResults = await Promise.all(
      filesToRead.map(async (filePath) => {
        try {
          const file = await getFileContent(owner, repo, filePath, defaultBranch);
          return { ok: true as const, path: file.path, content: file.content };
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          return { ok: false as const, error: `${filePath}: ${msg}` };
        }
      })
    );
    for (const r of readResults) {
      if (r.ok) fileContents.push({ path: r.path, content: r.content });
      else readErrors.push(r.error);
    }

    await readStep({ read: fileContents.length, errors: readErrors.length });

    // ─── Kill switch check ───
    if (await checkCancelled()) {
      await log.info('task_cancelled', { step: 'before_write_code' });
      return new Response(JSON.stringify({ cancelled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ─── Step 5: write_code ───
    const writeStep = await log.step('write_code', { filesRead: fileContents.length, planLength: plan.length });

    const codeTools = [
      {
        name: 'submit_code',
        description: 'Submit the code changes',
        input_schema: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'File path relative to repo root' },
                  content: { type: 'string', description: 'Complete file content' },
                },
                required: ['path', 'content'],
              },
              description: 'Files to create or modify (max 10)',
            },
            commitMessage: {
              type: 'string',
              description: 'Git commit message',
            },
            prTitle: {
              type: 'string',
              description: 'Pull request title',
            },
            prBody: {
              type: 'string',
              description: 'Pull request description in markdown',
            },
          },
          required: ['files', 'commitMessage', 'prTitle', 'prBody'],
        },
      },
    ];

    const fileContextBlock = fileContents
      .map(f => `--- ${f.path} ---\n${f.content}`)
      .join('\n\n');

    const codePrompt = `You are an autonomous coding agent. Implement the plan below by writing complete file contents.

PROJECT: ${projectName || repoFull}
REPO: ${repoFull}

USER REQUEST: ${query}

PLAN:
${plan}

${readErrors.length > 0 ? `FILES THAT COULD NOT BE READ:\n${readErrors.join('\n')}\n` : ''}
FILE CONTENTS:
${fileContextBlock}

Instructions:
- Write complete file contents for each file you need to create or modify
- Do NOT include partial files — every file must be the full content
- Write clean, production-quality code that follows existing patterns
- Commit message should be concise and descriptive
- PR title should be short (under 70 chars)
- PR body should explain what changed and why
- Use the submit_code tool to return your changes`;

    const codeResponse = await callClaude({
      model: codeModel,
      system: 'You are a precise coding agent. Write complete, working code. Use the submit_code tool.',
      messages: [{ role: 'user', content: codePrompt }],
      tools: codeTools,
      tool_choice: { type: 'tool', name: 'submit_code' },
      max_tokens: 8192,
      temperature: 0.2,
    });

    const codeResult = parseToolUse(codeResponse);
    if (!codeResult || !codeResult.input) {
      await writeStep.fail('Claude did not return code');
      throw new Error('Claude did not return code via tool use');
    }

    const rawFiles = codeResult.input.files;
    const codeFiles = (Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : []) as Array<{ path: string; content: string }>;
    const commitMessage = (codeResult.input.commitMessage as string) || 'Code changes by jac-code-agent';
    const prTitle = (codeResult.input.prTitle as string) || `JAC: ${query.slice(0, 50)}`;
    const prBody = (codeResult.input.prBody as string) || '';

    if (codeFiles.length === 0) {
      await writeStep.fail('No files returned');
      throw new Error('Claude returned zero files to commit');
    }

    const totalCost = calculateCost(codeModel, planResponse.usage) +
      calculateCost(codeModel, codeResponse.usage);

    // Record combined token usage for both plan + code calls
    const combinedUsage = {
      input_tokens: (planResponse.usage?.input_tokens || 0) + (codeResponse.usage?.input_tokens || 0),
      output_tokens: (planResponse.usage?.output_tokens || 0) + (codeResponse.usage?.output_tokens || 0),
    };
    await recordTokenUsage(supabase, taskId, codeModel, combinedUsage);

    await writeStep({
      fileCount: codeFiles.length,
      commitMessage,
      prTitle,
      inputTokens: codeResponse.usage?.input_tokens,
      outputTokens: codeResponse.usage?.output_tokens,
      totalCostUsd: totalCost,
    });

    // ─── Kill switch check ───
    if (await checkCancelled()) {
      await log.info('task_cancelled', { step: 'before_create_branch' });
      return new Response(JSON.stringify({ cancelled: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ─── Step 6: create_branch ───
    const randomHex = Math.random().toString(16).slice(2, 6);
    const branchName = `jac/${branchSlug}-${randomHex}`;
    const branchStep = await log.step('create_branch', { branchName, baseBranch: defaultBranch });
    await createBranch(owner, repo, defaultBranch, branchName);
    await branchStep();

    // ─── Step 7: commit ───
    const commitStep = await log.step('commit', { branchName, fileCount: codeFiles.length });
    const fileChanges: FileChange[] = codeFiles.map(f => ({ path: f.path, content: f.content }));
    const commitSha = await commitFiles(owner, repo, branchName, fileChanges, commitMessage);
    await commitStep({ commitSha });

    // ─── Step 8: open_pr ───
    const prStep = await log.step('open_pr', { head: branchName, base: defaultBranch });
    const pr = await createPR(owner, repo, branchName, defaultBranch, prTitle, prBody);
    await prStep({ prNumber: pr.number, prUrl: pr.url });

    // ─── Step 8b: trigger codebase sync (fire-and-forget) ───
    fetch(`${supabaseUrl}/functions/v1/sync-codebase`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectId,
        userId,
        paths: codeFiles.map(f => f.path),
      }),
    }).catch(err => console.warn('[code-agent] sync-codebase fire-and-forget failed:', err));

    // ─── Step 9: save_session ───
    const sessionStep = await log.step('save_session');
    const { data: session } = await supabase
      .from('code_sessions')
      .insert({
        user_id: userId,
        project_id: projectId,
        task_id: taskId,
        query,
        plan,
        intent: query.slice(0, 200),
        branch_name: branchName,
        commit_sha: commitSha,
        pr_number: pr.number,
        pr_url: pr.url,
        files_read: filesToRead,
        files_written: codeFiles.map(f => f.path),
        files_changed: codeFiles.map(f => f.path),
        file_count: codeFiles.length,
        total_cost_usd: totalCost,
        status: 'completed',
      })
      .select('id')
      .single();
    await sessionStep({ sessionId: session?.id });

    // ─── Step 10: save_to_brain ───
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
          content: `Code: ${query}\n\nRepo: ${repoFull}\nBranch: ${branchName}\nPR: ${pr.url}\n\nPlan:\n${plan}\n\nFiles changed: ${codeFiles.map(f => f.path).join(', ')}\nCommit: ${commitSha.slice(0, 8)}`,
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

    // ─── Update task → completed (guard: only if still running) ───
    await supabase
      .from('agent_tasks')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        output: {
          prUrl: pr.url,
          prNumber: pr.number,
          branchName,
          commitSha,
          filesChanged: codeFiles.map(f => f.path),
          fileCount: codeFiles.length,
          plan: plan.slice(0, 2000),
          brainEntryId,
          totalCostUsd: totalCost,
          durationMs: duration,
        },
      })
      .eq('id', taskId)
      .in('status', ['running']);

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
          .eq('id', parentTaskId)
          .in('status', ['running']);
      }
    }

    // ─── Step 11: slack_notify ───
    const slackStep = await log.step('slack_notify');
    await notifySlack(supabase, userId, {
      taskId,
      taskType: 'code',
      summary: `Coded: "${query.slice(0, 60)}"\n<${pr.url}|PR #${pr.number}> on \`${branchName}\`\nFiles: ${codeFiles.map(f => f.path).join(', ')}`,
      brainEntryId,
      duration,
      slackChannel,
      slackThinkingTs,
    });
    await slackStep();

    // Store result as assistant message in conversation
    const { error: convoError } = await supabase.from('agent_conversations').insert({
      user_id: userId,
      role: 'assistant',
      content: `Code complete: ${query}\n\nPR: ${pr.url}\nBranch: ${branchName}\nFiles changed: ${codeFiles.map(f => f.path).join(', ')}${brainEntryId ? `\n\nSaved to brain.` : ''}`,
      task_ids: [taskId],
    });
    if (convoError) {
      console.warn('[code-agent] Failed to insert conversation:', convoError.message);
    }

    await log.info('task_completed', {
      durationMs: duration,
      brainEntryId,
      prUrl: pr.url,
      fileCount: codeFiles.length,
      totalCostUsd: totalCost,
    });

    return new Response(JSON.stringify({
      success: true,
      prUrl: pr.url,
      prNumber: pr.number,
      branchName,
      commitSha,
      fileCount: codeFiles.length,
      brainEntryId,
      durationMs: duration,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[code-agent] Error:', error);

    if (taskId) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await supabase
        .from('agent_tasks')
        .update({
          status: 'failed',
          error: errorMessage,
          updated_at: new Date().toISOString(),
        })
        .eq('id', taskId)
        .in('status', ['running', 'queued']);

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
          .eq('id', parentTaskId)
          .in('status', ['running', 'queued']);
      }

      if (userId) {
        // Log the failure
        const log = createAgentLogger(supabase, taskId, userId, 'jac-code-agent');
        await log.info('task_failed', { error: errorMessage, durationMs: Date.now() - startTime });

        await notifySlack(supabase, userId, {
          taskId,
          taskType: 'code',
          summary: '',
          error: errorMessage,
          duration: Date.now() - startTime,
          slackChannel,
          slackThinkingTs,
        });
      }
    }

    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Code agent failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
