
-- ============================================
-- agent_tasks: Tracks all agent task executions
-- ============================================
CREATE TABLE public.agent_tasks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  parent_task_id UUID REFERENCES public.agent_tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'general',
  status TEXT NOT NULL DEFAULT 'pending',
  intent TEXT NOT NULL,
  agent TEXT,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  error TEXT,
  cost_usd NUMERIC(10,6) DEFAULT 0,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cron_expression TEXT,
  cron_active BOOLEAN DEFAULT false,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX idx_agent_tasks_user_status ON public.agent_tasks(user_id, status);
CREATE INDEX idx_agent_tasks_user_cron ON public.agent_tasks(user_id, cron_active) WHERE cron_active = true;
CREATE INDEX idx_agent_tasks_next_run ON public.agent_tasks(next_run_at) WHERE next_run_at IS NOT NULL AND cron_active = true;

-- RLS
ALTER TABLE public.agent_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own tasks"
  ON public.agent_tasks FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own tasks"
  ON public.agent_tasks FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own tasks"
  ON public.agent_tasks FOR UPDATE
  USING (auth.uid() = user_id);

-- updated_at trigger
CREATE TRIGGER update_agent_tasks_updated_at
  BEFORE UPDATE ON public.agent_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_tasks;

-- ============================================
-- user_settings: Per-user preferences & limits
-- ============================================
CREATE TABLE public.user_settings (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL UNIQUE,
  preferred_model TEXT DEFAULT 'claude-sonnet-4-20250514',
  daily_task_limit INTEGER DEFAULT 200,
  max_concurrent_tasks INTEGER DEFAULT 10,
  settings JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own settings"
  ON public.user_settings FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create their own settings"
  ON public.user_settings FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own settings"
  ON public.user_settings FOR UPDATE
  USING (auth.uid() = user_id);

-- updated_at trigger
CREATE TRIGGER update_user_settings_updated_at
  BEFORE UPDATE ON public.user_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();
