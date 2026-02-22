

# Code Workspace End-to-End Fix and Test Plan

## Summary

The Code Workspace UI is wired up, the edge functions are deployed, and the database tables exist. However, there is a **critical bug** in the dispatcher that will prevent the code agent from working: the worker dispatch call does not forward project context fields (`projectId`, `projectName`, `repoFullName`) to the code agent. We need to fix this and then test end-to-end in batches.

---

## Batch 1: Fix the Dispatcher Bug (Critical)

**Problem:** The `jac-dispatcher` stores `projectId`/`projectName`/`repoFullName` in the child task's `input` column (lines 415-419), but the fire-and-forget `fetch()` call to the worker (lines 447-456) does NOT include these fields in its body. The `jac-code-agent` requires `projectId` in the request body (line 62) and will fail with "Missing required fields".

**Fix:** Update `supabase/functions/jac-dispatcher/index.ts` to include code project context in the worker dispatch body:

```text
// In the worker dispatch body (line 447), add:
...(intent === 'code' && codeProject ? {
  projectId: codeProject.id,
  projectName: codeProject.name,
  repoFullName: codeProject.repo_full_name,
} : {}),
```

Also, the `useCodeWorkspace.sendCodeCommand` sends a `context` object with project info, but the dispatcher ignores it. The dispatcher instead does its own project lookup by name matching from the message text. This is fine for Slack/general use, but for the Code Workspace UI we should also accept explicit project context from the body. 

**Fix:** In the dispatcher, after the Claude intent parse, if `body.context?.projectId` is provided and intent is `code`, use that directly instead of the name-match lookup.

**Redeploy:** `jac-dispatcher`

---

## Batch 2: Register Test Repo + Verify UI

After the dispatcher fix is deployed:

1. Navigate to `/code`
2. Click "+ Add Project"
3. Enter:
   - Repo: `LinkFood/jac-test-sandbox`
   - Name: `jac-test-sandbox`
   - Tech Stack: `react, typescript, vite`
4. Verify the project appears in the sidebar
5. Click the project -- the file tree should populate (the code agent caches it, but initially it will be empty since no agent has fetched it yet)

---

## Batch 3: End-to-End Code Agent Test

With `jac-test-sandbox` selected in the Code Workspace:

1. Send: **"Wire up the delete button -- deleteTask exists in the hook but is never passed to TaskCard"**
2. Watch the Agent Terminal for live steps: `resolve_project` -> `fetch_tree` -> `plan` -> `read_files` -> `write_code` -> `create_branch` -> `commit` -> `open_pr`
3. Verify a PR appears at `https://github.com/LinkFood/jac-test-sandbox/pulls`
4. Check Session History tab shows the session with branch name and PR link
5. Check Slack for notification (if configured)

**If it fails:** Check `agent_activity_log` and `agent_tasks` tables for error details. Common issues:
- GITHUB_PAT scope problems (needs `repo` scope)
- Rate limiting from the loop detector (5+ tasks in 60s)
- Claude API errors

---

## Batch 4: Verify PR Quality

On GitHub, check the PR:
- Branch name follows `jac/<slug>-<hex>` pattern (not main)
- Code changes make sense (passing `deleteTask` to `TaskCard`)
- Commit message is descriptive
- PR body explains what and why

---

## Batch 5: Additional Test Prompts (Optional)

If Batch 3 succeeds, try:
- "Add a completion percentage to the stats display"
- "Add local storage persistence so tasks survive page refresh"

---

## Technical Details

### Files to modify

| File | Change |
|------|--------|
| `supabase/functions/jac-dispatcher/index.ts` | Add code project fields to worker dispatch body; accept explicit `context.projectId` from request body |

### Debugging queries (if needed)

```sql
-- Check recent code tasks
SELECT id, status, intent, agent, error, created_at 
FROM agent_tasks WHERE type = 'code' ORDER BY created_at DESC LIMIT 10;

-- Check activity logs for the code agent
SELECT step, status, detail, created_at 
FROM agent_activity_log WHERE agent = 'jac-code-agent' ORDER BY created_at DESC LIMIT 20;

-- Check code_projects
SELECT id, name, repo_full_name, file_tree_cache IS NOT NULL as has_tree 
FROM code_projects;

-- Check code_sessions
SELECT id, branch_name, status, pr_url, intent 
FROM code_sessions ORDER BY created_at DESC LIMIT 10;
```

