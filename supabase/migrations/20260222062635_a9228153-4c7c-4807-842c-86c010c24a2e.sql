
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
