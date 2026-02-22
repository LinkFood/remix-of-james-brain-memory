
-- code_projects table
CREATE TABLE IF NOT EXISTS public.code_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  repo_full_name text NOT NULL,
  default_branch text NOT NULL DEFAULT 'main',
  description text,
  tech_stack text[] DEFAULT '{}',
  last_synced_at timestamptz,
  file_tree_cache text[],
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- code_sessions table
CREATE TABLE IF NOT EXISTS public.code_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  project_id uuid REFERENCES public.code_projects(id) ON DELETE CASCADE NOT NULL,
  task_id uuid,
  branch_name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  intent text NOT NULL DEFAULT '',
  query text,
  plan text,
  commit_sha text,
  files_read text[],
  files_written text[],
  files_changed text[],
  file_count integer DEFAULT 0,
  commits text[],
  pr_number integer,
  pr_url text,
  ci_status text,
  iteration_count integer NOT NULL DEFAULT 0,
  max_iterations integer NOT NULL DEFAULT 3,
  total_cost_usd numeric DEFAULT 0,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- RLS
ALTER TABLE public.code_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.code_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own projects" ON public.code_projects FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own projects" ON public.code_projects FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own projects" ON public.code_projects FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own projects" ON public.code_projects FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "Users can view own sessions" ON public.code_sessions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create own sessions" ON public.code_sessions FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own sessions" ON public.code_sessions FOR UPDATE USING (auth.uid() = user_id);

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.code_projects;
ALTER PUBLICATION supabase_realtime ADD TABLE public.code_sessions;

-- Indexes
CREATE INDEX idx_code_projects_user ON public.code_projects(user_id);
CREATE INDEX idx_code_sessions_user ON public.code_sessions(user_id);
CREATE INDEX idx_code_sessions_project ON public.code_sessions(project_id);

-- Updated_at triggers
CREATE TRIGGER code_projects_updated_at BEFORE UPDATE ON public.code_projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER code_sessions_updated_at BEFORE UPDATE ON public.code_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
