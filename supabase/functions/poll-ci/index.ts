/**
 * poll-ci — Async CI status polling for code agent
 *
 * Separated from jac-code-agent because CI polling can take up to 5 min,
 * exceeding Deno edge function timeout if done inline.
 *
 * Flow:
 * 1. Polls getCheckRuns every 10s, max 30 polls (5 min)
 * 2. If 0 check runs → no CI configured, skip gracefully
 * 3. Records results in code_validations
 * 4. Updates code_sessions.ci_status
 * 5. If CI fails on JAC repo → calls revertCommit
 * 6. Slack notification with CI result
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.84.0';
import { isServiceRoleRequest } from '../_shared/auth.ts';
import { getCheckRuns, revertCommit } from '../_shared/github.ts';
import { notifySlack } from '../_shared/slack.ts';

const MAX_POLLS = 30;
const POLL_INTERVAL_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 });
  }

  if (!isServiceRoleRequest(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, serviceKey);

  try {
    const body = await req.json();
    const { userId, taskId, owner, repo, ref, defaultBranch, repoFull, sessionId } = body;

    if (!owner || !repo || !ref) {
      return new Response(JSON.stringify({ error: 'Missing owner, repo, or ref' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const isJacRepo = (repoFull || '').toLowerCase().includes('remix-of-james-brain-memory') ||
                      (repoFull || '').toLowerCase().includes('jac-agent-os');

    console.log(`[poll-ci] Starting CI poll for ${owner}/${repo}@${ref.slice(0, 8)}`);

    let ciResult: { passed: boolean; details: string; reverted: boolean } | null = null;

    for (let i = 0; i < MAX_POLLS; i++) {
      const checks = await getCheckRuns(owner, repo, ref);

      // No CI configured — skip gracefully
      if (checks.total_count === 0) {
        console.log('[poll-ci] No check runs found — no CI configured, skipping');
        ciResult = { passed: true, details: 'No CI configured', reverted: false };
        break;
      }

      // Check if all runs are completed
      const completed = checks.check_runs.filter(cr => cr.status === 'completed');
      if (completed.length === checks.total_count) {
        const failed = completed.filter(cr => cr.conclusion !== 'success' && cr.conclusion !== 'skipped');
        const passed = failed.length === 0;

        const details = completed
          .map(cr => `${cr.name}: ${cr.conclusion}`)
          .join(', ');

        let reverted = false;

        if (!passed && isJacRepo) {
          // Verify merge commit is still HEAD before reverting
          try {
            const headRes = await fetch(
              `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(defaultBranch || 'main')}`,
              {
                headers: {
                  'Authorization': `Bearer ${Deno.env.get('GITHUB_PAT')}`,
                  'Accept': 'application/vnd.github+json',
                  'X-GitHub-Api-Version': '2022-11-28',
                },
              }
            );

            if (headRes.ok) {
              const headData = await headRes.json();
              if (headData.object.sha === ref) {
                console.log(`[poll-ci] CI failed and merge commit is HEAD — reverting ${ref.slice(0, 8)}`);
                await revertCommit(owner, repo, ref, defaultBranch || 'main', `Revert: CI failed for ${ref.slice(0, 8)}`);
                reverted = true;
              } else {
                console.log(`[poll-ci] CI failed but merge commit is NOT HEAD — skipping revert (other commits landed)`);
              }
            }
          } catch (revertErr) {
            console.error('[poll-ci] Revert failed:', revertErr);
          }
        }

        ciResult = { passed, details, reverted };
        break;
      }

      // Still in progress — wait and poll again
      if (i < MAX_POLLS - 1) {
        await sleep(POLL_INTERVAL_MS);
      }
    }

    // Timeout — treat as unknown
    if (!ciResult) {
      ciResult = { passed: false, details: 'CI polling timed out after 5 minutes', reverted: false };
    }

    // Record in code_validations
    if (sessionId) {
      try {
        await supabase
          .from('code_validations')
          .insert({
            session_id: sessionId,
            validation_type: 'ci',
            passed: ciResult.passed,
            output: `${ciResult.details}${ciResult.reverted ? ' — REVERTED' : ''}`,
            duration_ms: 0,
          });

        // Update code_sessions.ci_status
        await supabase
          .from('code_sessions')
          .update({
            ci_status: ciResult.passed ? 'passed' : ciResult.reverted ? 'reverted' : 'failed',
            validated: ciResult.passed,
          })
          .eq('id', sessionId);
      } catch (dbErr) {
        console.error('[poll-ci] DB update failed:', dbErr);
      }
    }

    // Slack notification
    if (userId) {
      try {
        const emoji = ciResult.passed ? '✅' : ciResult.reverted ? '🔄' : '❌';
        const summary = ciResult.reverted
          ? `${emoji} CI FAILED — auto-reverted commit ${ref.slice(0, 8)}\n${ciResult.details}`
          : `${emoji} CI ${ciResult.passed ? 'passed' : 'failed'}: ${ciResult.details}`;

        await notifySlack(supabase, userId, {
          taskId: taskId || 'poll-ci',
          taskType: 'code',
          summary,
        });
      } catch (slackErr) {
        console.warn('[poll-ci] Slack notification failed:', slackErr);
      }
    }

    console.log(`[poll-ci] Done: passed=${ciResult.passed}, reverted=${ciResult.reverted}`);

    return new Response(JSON.stringify({
      success: true,
      ciPassed: ciResult.passed,
      ciDetails: ciResult.details,
      reverted: ciResult.reverted,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('[poll-ci] Error:', error);
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'poll-ci failed',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
