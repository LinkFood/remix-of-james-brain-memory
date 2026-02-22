-- Code Workspace: Projects + Sessions tables for jac-code-agent
-- Enables autonomous coding: read repos, plan, write code, commit, open PRs

-- ============================================================
-- code_projects — Project registry
-- ============================================================
CREATE TABLE public.code_projects (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL,
  repo_full_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT 'main',
  description TEXT,
  tech_stack TEXT[],
  last_synced_at TIMESTAMPTZ,
  file_tree_cache JSONB,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_code_projects_user_id ON public.code_projects(user_id);
CREATE INDEX idx_code_projects_active ON public.code_projects(user_id, active);

ALTER TABLE public.code_projects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own projects"
  ON public.code_projects FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own projects"
  ON public.code_projects FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own projects"
  ON public.code_projects FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own projects"
  ON public.code_projects FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to code_projects"
  ON public.code_projects FOR ALL
  USING (auth.role() = 'service_role');

ALTER PUBLICATION supabase_realtime ADD TABLE public.code_projects;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.update_code_projects_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_code_projects_updated_at
  BEFORE UPDATE ON public.code_projects
  FOR EACH ROW
  EXECUTE FUNCTION public.update_code_projects_updated_at();

-- ============================================================
-- code_sessions — Coding session state
-- ============================================================
CREATE TABLE public.code_sessions (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  project_id UUID NOT NULL REFERENCES public.code_projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES public.agent_tasks(id) ON DELETE SET NULL,
  branch_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'failed', 'awaiting_ci')),
  intent TEXT NOT NULL,
  files_read TEXT[],
  files_written TEXT[],
  commits TEXT[],
  pr_number INTEGER,
  pr_url TEXT,
  ci_status TEXT,
  iteration_count INTEGER DEFAULT 0,
  max_iterations INTEGER DEFAULT 3,
  context JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_code_sessions_user_id ON public.code_sessions(user_id);
CREATE INDEX idx_code_sessions_project_id ON public.code_sessions(project_id);
CREATE INDEX idx_code_sessions_task_id ON public.code_sessions(task_id);
CREATE INDEX idx_code_sessions_status ON public.code_sessions(user_id, status);

ALTER TABLE public.code_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own sessions"
  ON public.code_sessions FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own sessions"
  ON public.code_sessions FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own sessions"
  ON public.code_sessions FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own sessions"
  ON public.code_sessions FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to code_sessions"
  ON public.code_sessions FOR ALL
  USING (auth.role() = 'service_role');

ALTER PUBLICATION supabase_realtime ADD TABLE public.code_sessions;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.update_code_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_code_sessions_updated_at
  BEFORE UPDATE ON public.code_sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.update_code_sessions_updated_at();
