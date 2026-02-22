-- JAC Agent OS: Conversation history + task extensions
-- Phase 1: Schema for boss agent conversation tracking

-- Conversation history for JAC boss agent
CREATE TABLE public.agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  task_ids UUID[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.agent_conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their conversations"
  ON public.agent_conversations
  FOR ALL
  USING (auth.uid() = user_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_conversations;

CREATE INDEX idx_agent_convos_user
  ON public.agent_conversations(user_id, created_at DESC);

-- Extend agent_tasks with notification tracking + completion timestamp
ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS slack_notified BOOLEAN DEFAULT false;
ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
