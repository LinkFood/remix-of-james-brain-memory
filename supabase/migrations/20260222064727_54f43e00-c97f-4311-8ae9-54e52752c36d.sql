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