

# Apply Commit afe07d1 — JAC Agent OS Critical Fixes

## Overview

This plan applies all changes from the commit: a new migration, a new shared logger utility, auth fixes across 4 edge functions, dispatcher/research-agent logging, and frontend activity log support.

## Step 1: Database Migration — `agent_activity_log` table

Create the `agent_activity_log` table with RLS and realtime:

```sql
CREATE TABLE public.agent_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL,
  user_id uuid NOT NULL,
  agent text NOT NULL,
  step text NOT NULL,
  status text NOT NULL DEFAULT 'started',
  detail jsonb NOT NULL DEFAULT '{}',
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own activity logs"
  ON public.agent_activity_log FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Service role can insert activity logs"
  ON public.agent_activity_log FOR INSERT
  WITH CHECK (true);

CREATE INDEX idx_activity_log_task ON public.agent_activity_log (task_id, created_at);
CREATE INDEX idx_activity_log_user ON public.agent_activity_log (user_id, created_at);

ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_activity_log;
```

## Step 2: Create `supabase/functions/_shared/logger.ts`

A shared `createAgentLogger()` utility that agents call to log steps with duration tracking. Each call to `log.step('step_name')` inserts a row into `agent_activity_log` with status `started` and returns a `done(detail?)` function that updates the row with `completed` status and `duration_ms`.

## Step 3: Update `supabase/functions/_shared/auth.ts`

Add `extractUserIdWithServiceRole()` function. This is already defined in the useful-context but missing from the actual file. It checks if the request uses the service role key first (reads `userId` from the body), then falls back to JWT auth via `extractUserId()`.

## Step 4: Update Edge Functions (4 files)

### `search-memory/index.ts`
- Replace the `service_role_internal` pattern with `extractUserIdWithServiceRole(req, body)`
- Parse body first (needed for auth), then reuse it
- Skip rate limit for internal agent calls using `isServiceRoleRequest()`

### `jac-web-search/index.ts`
- Same pattern: switch to `extractUserIdWithServiceRole(req, body)`
- Parse body early, reuse downstream
- Skip rate limit for service role calls

### `smart-save/index.ts`
- Switch from `extractUserId(req)` to `extractUserIdWithServiceRole(req, body)`
- Parse body early, reuse it downstream

### `jac-dispatcher/index.ts`
- Add logger import and log `intent_parsed` and `worker_dispatched` steps

### `jac-research-agent/index.ts`
- Add full step logging: `web_search`, `brain_search`, `ai_synthesis`, `save_to_brain`, `slack_notify`
- Pass `userId` in body for all inter-function calls (search-memory, jac-web-search, smart-save)

## Step 5: Update Frontend Types

### `src/types/agent.ts`
- Add `ActivityLogEntry` and `LogStatus` types (already present in file)

## Step 6: Update Frontend Components

### `src/hooks/useJacAgent.ts`
- Add `activityLogs` state (Map keyed by taskId)
- Add realtime subscription on `agent_activity_log` table
- Add `loadTaskLogs()` function for on-demand log loading
- Export `activityLogs` and `loadTaskLogs`

### `src/components/jac/TaskCard.tsx`
- Accept `activityLogs` and `onExpand` props
- Show live step timeline when expanded
- Auto-expand running tasks
- Show duration per step

### `src/components/jac/ActivityFeed.tsx`
- Pass `activityLogs` and `onExpandTask` callback to TaskCard

### `src/pages/Jac.tsx`
- Wire `activityLogs` and `loadTaskLogs` from the hook through to ActivityFeed

## Step 7: Redeploy Edge Functions

Deploy all 5 modified edge functions: `search-memory`, `jac-web-search`, `smart-save`, `jac-dispatcher`, `jac-research-agent`

## Summary of Files Changed

| File | Action |
|------|--------|
| Migration (agent_activity_log) | Create |
| `supabase/functions/_shared/logger.ts` | Create |
| `supabase/functions/_shared/auth.ts` | Already correct (verify) |
| `supabase/functions/search-memory/index.ts` | Update |
| `supabase/functions/jac-web-search/index.ts` | Update |
| `supabase/functions/smart-save/index.ts` | Update |
| `supabase/functions/jac-dispatcher/index.ts` | Update |
| `supabase/functions/jac-research-agent/index.ts` | Update |
| `src/hooks/useJacAgent.ts` | Update |
| `src/components/jac/TaskCard.tsx` | Update |
| `src/components/jac/ActivityFeed.tsx` | Update |
| `src/pages/Jac.tsx` | Update |

