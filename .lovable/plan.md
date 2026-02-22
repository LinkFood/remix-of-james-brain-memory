

# Kill Switch Deployment (commit dcd31fd)

## Summary
All code files are already synced. Two things remain: a database migration and edge function deployments.

## Steps

### 1. Database Migration
Add the `cancelled_at` column and two indexes to `agent_tasks`:
- `cancelled_at` (timestamptz, nullable) on `agent_tasks`
- Index on `(user_id, created_at)` for loop detection queries
- Index on `(user_id, status)` for cancellable task lookups

This fixes the build error where the TypeScript `AgentTask` type expects `cancelled_at` but the database column doesn't exist yet.

### 2. Deploy Edge Functions
Deploy all 6 affected functions:
- `jac-kill-switch` (new)
- `jac-dispatcher` (loop detection + stale cleanup guard)
- `jac-research-agent` (soft-kill guard)
- `jac-save-agent` (soft-kill guard)
- `jac-search-agent` (soft-kill guard)
- `slack-incoming` (stop/halt/cancel/kill interception)

### 3. No Other Changes
All frontend files (types, hooks, components, pages) are already in place with the correct code.

## Technical Details

Migration SQL:
```text
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_created ON agent_tasks(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_status ON agent_tasks(user_id, status);
```

