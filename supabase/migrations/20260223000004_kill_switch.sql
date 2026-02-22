-- Kill switch infrastructure: cancelled status, loop detection index, cancellable tasks index

ALTER TABLE public.agent_tasks ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_agent_tasks_loop_detect
  ON public.agent_tasks(user_id, agent, created_at DESC)
  WHERE status IN ('running', 'queued', 'completed');

CREATE INDEX IF NOT EXISTS idx_agent_tasks_cancellable
  ON public.agent_tasks(user_id, status)
  WHERE status IN ('running', 'queued', 'pending');
