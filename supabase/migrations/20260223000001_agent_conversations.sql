-- JAC Agent OS: Patch agent_conversations + agent_tasks
-- Fixes gaps from auto-generated Lovable migration (20260222062635)
-- Safe: all IF NOT EXISTS / DO $$ blocks

-- Add role CHECK constraint if not present
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agent_conversations_role_check'
  ) THEN
    ALTER TABLE public.agent_conversations
      ADD CONSTRAINT agent_conversations_role_check
      CHECK (role IN ('user', 'assistant'));
  END IF;
END $$;

-- Add UPDATE policy (Lovable migration only has SELECT + INSERT)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'agent_conversations' AND policyname = 'Users can update own conversations'
  ) THEN
    CREATE POLICY "Users can update own conversations"
      ON public.agent_conversations FOR UPDATE
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- Add DELETE policy
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'agent_conversations' AND policyname = 'Users can delete own conversations'
  ) THEN
    CREATE POLICY "Users can delete own conversations"
      ON public.agent_conversations FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- Extend agent_tasks (IF NOT EXISTS handles idempotency)
ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS slack_notified BOOLEAN DEFAULT false;
ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
