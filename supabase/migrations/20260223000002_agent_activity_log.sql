-- JAC Agent OS: Safe patch for agent_activity_log
-- Lovable migration 20260222064727 already created the table.
-- This adds constraints and policies that were missing.

-- Add CHECK constraint on status column
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_activity_log_status_check') THEN
    ALTER TABLE public.agent_activity_log
      ADD CONSTRAINT agent_activity_log_status_check
      CHECK (status IN ('started','completed','failed','skipped'));
  END IF;
END $$;

-- Add UPDATE policy if missing
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Users can update own activity logs'
      AND tablename = 'agent_activity_log'
  ) THEN
    CREATE POLICY "Users can update own activity logs"
      ON public.agent_activity_log FOR UPDATE
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- Add DELETE policy if missing
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Users can delete own activity logs'
      AND tablename = 'agent_activity_log'
  ) THEN
    CREATE POLICY "Users can delete own activity logs"
      ON public.agent_activity_log FOR DELETE
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- Add descending index on user_id if missing (Lovable has ASC)
CREATE INDEX IF NOT EXISTS idx_activity_log_user_desc
  ON public.agent_activity_log(user_id, created_at DESC);
