

# Fix Build Errors: Apply JAC Agent OS Migration

## Problem
The code pushed from CLI references two things that don't exist in the database yet:
1. **`agent_conversations` table** -- completely missing
2. **`agent_tasks`** is missing `slack_notified` (boolean) and `completed_at` (timestamptz) columns

This causes TypeScript type errors because the auto-generated Supabase types don't include these, so the Supabase client rejects queries against `agent_conversations` and the `AgentTask` type doesn't align with the DB schema.

## Fix: Single Database Migration

Apply one migration that:

1. **Creates `agent_conversations` table** with columns: `id`, `user_id`, `role`, `content`, `task_ids` (text array), `created_at`
   - RLS enabled with policies for users to read/insert their own conversations
   - Enable realtime on the table
   - Index on `user_id` + `created_at`

2. **Adds missing columns to `agent_tasks`**:
   - `slack_notified boolean DEFAULT false`
   - `completed_at timestamptz`

3. **Enable realtime on `agent_tasks`** (needed for live task updates in the UI)

Once the migration runs, the auto-generated types will update, and all build errors will resolve -- no code changes needed.

## Technical Details

```sql
-- 1. Create agent_conversations table
CREATE TABLE public.agent_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  task_ids text[] DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own conversations"
  ON public.agent_conversations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own conversations"
  ON public.agent_conversations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_agent_conversations_user_created
  ON public.agent_conversations (user_id, created_at);

ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_conversations;

-- 2. Add missing columns to agent_tasks
ALTER TABLE public.agent_tasks
  ADD COLUMN IF NOT EXISTS slack_notified boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- 3. Enable realtime on agent_tasks
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_tasks;
```

After this, no code files need editing -- the build errors all stem from the missing DB schema.
