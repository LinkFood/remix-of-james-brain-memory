-- Deploy Infrastructure: Environments + Operations tables for jac-deploy-agent
-- Enables autonomous deployment: deploy functions, apply migrations, generate types

-- ============================================================
-- deploy_environments — Maps names to Supabase project refs
-- ============================================================
CREATE TABLE public.deploy_environments (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (name IN ('staging', 'production')),
  project_ref TEXT NOT NULL,
  supabase_url TEXT,
  is_production BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE INDEX idx_deploy_environments_user_id ON public.deploy_environments(user_id);
CREATE INDEX idx_deploy_environments_active ON public.deploy_environments(user_id, active);

ALTER TABLE public.deploy_environments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own environments"
  ON public.deploy_environments FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own environments"
  ON public.deploy_environments FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own environments"
  ON public.deploy_environments FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own environments"
  ON public.deploy_environments FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to deploy_environments"
  ON public.deploy_environments FOR ALL
  USING (auth.role() = 'service_role');

ALTER PUBLICATION supabase_realtime ADD TABLE public.deploy_environments;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.update_deploy_environments_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_deploy_environments_updated_at
  BEFORE UPDATE ON public.deploy_environments
  FOR EACH ROW
  EXECUTE FUNCTION public.update_deploy_environments_updated_at();

-- ============================================================
-- deploy_operations — Tracks every deploy/migration action
-- ============================================================
CREATE TABLE public.deploy_operations (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL,
  task_id UUID REFERENCES public.agent_tasks(id) ON DELETE SET NULL,
  project_ref TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('staging', 'production')),
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'deploy_function', 'bulk_deploy', 'migration', 'type_gen'
  )),
  target_slug TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'completed', 'failed', 'awaiting_approval'
  )),
  input JSONB DEFAULT '{}'::jsonb,
  output JSONB DEFAULT '{}'::jsonb,
  error TEXT,
  duration_ms INTEGER,
  git_sha TEXT,
  git_branch TEXT,
  promoted_from UUID REFERENCES public.deploy_operations(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deploy_operations_user_id ON public.deploy_operations(user_id);
CREATE INDEX idx_deploy_operations_task_id ON public.deploy_operations(task_id);
CREATE INDEX idx_deploy_operations_status ON public.deploy_operations(user_id, status);
CREATE INDEX idx_deploy_operations_environment ON public.deploy_operations(environment, status);
CREATE INDEX idx_deploy_operations_created ON public.deploy_operations(created_at DESC);

ALTER TABLE public.deploy_operations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own operations"
  ON public.deploy_operations FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own operations"
  ON public.deploy_operations FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own operations"
  ON public.deploy_operations FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own operations"
  ON public.deploy_operations FOR DELETE
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to deploy_operations"
  ON public.deploy_operations FOR ALL
  USING (auth.role() = 'service_role');

ALTER PUBLICATION supabase_realtime ADD TABLE public.deploy_operations;

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.update_deploy_operations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_deploy_operations_updated_at
  BEFORE UPDATE ON public.deploy_operations
  FOR EACH ROW
  EXECUTE FUNCTION public.update_deploy_operations_updated_at();
