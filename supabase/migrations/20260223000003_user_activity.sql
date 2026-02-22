-- JAC Agent OS: Universal user activity log
-- The intelligence gathering layer. Every meaningful interaction is captured.
-- An optimization agent reads this daily to learn patterns and improve.
--
-- MILITARY METAPHOR:
--   user_activity     = Field intelligence (what the user does)
--   agent_activity_log = Operator comms (what agents do)
--   agent_conversations = Command channel (user <-> JAC dialogue)
--   agent_tasks        = Mission tracker (task lifecycle)

CREATE TABLE public.user_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  event TEXT NOT NULL,
  category TEXT NOT NULL,
  detail JSONB DEFAULT '{}',
  entry_id UUID,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.user_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their activity"
  ON public.user_activity
  FOR ALL
  USING (auth.uid() = user_id);

-- Index for the daily optimization agent scan
CREATE INDEX idx_user_activity_user_date ON public.user_activity(user_id, created_at DESC);
CREATE INDEX idx_user_activity_event ON public.user_activity(event, created_at DESC);
CREATE INDEX idx_user_activity_category ON public.user_activity(category, user_id, created_at DESC);

-- Realtime so agents can react to live activity
ALTER PUBLICATION supabase_realtime ADD TABLE public.user_activity;

-- Cleanup: auto-delete activity older than 90 days (keep storage lean)
-- This would be a pg_cron job in production:
-- SELECT cron.schedule('cleanup-old-activity', '0 3 * * *',
--   $$DELETE FROM public.user_activity WHERE created_at < now() - interval '90 days'$$
-- );
