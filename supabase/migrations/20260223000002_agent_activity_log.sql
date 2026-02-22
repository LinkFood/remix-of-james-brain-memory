-- JAC Agent OS: End-to-end activity logging
-- Every agent step is recorded for full observability

CREATE TABLE public.agent_activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES public.agent_tasks(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  agent TEXT NOT NULL,
  step TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started','completed','failed','skipped')),
  detail JSONB DEFAULT '{}',
  duration_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.agent_activity_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users see their own logs"
  ON public.agent_activity_log
  FOR ALL
  USING (auth.uid() = user_id);

ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_activity_log;

CREATE INDEX idx_activity_log_task ON public.agent_activity_log(task_id, created_at);
CREATE INDEX idx_activity_log_user ON public.agent_activity_log(user_id, created_at DESC);
