

# Integrate JAC Code Agent Feature

## What needs to happen

Your commit added 18 files with the Code Agent feature, but three things need to be set up in Lovable for it to work:

### 1. Create database tables (migration)

The `code_projects` and `code_sessions` tables don't exist yet. We need to run the migration to create them with:
- `code_projects` table: stores registered GitHub repos (name, repo_full_name, default_branch, tech_stack, file_tree_cache, active flag)
- `code_sessions` table: stores coding session results (branch_name, pr_url, pr_number, files_changed, status, plan, commit_sha, cost tracking)
- RLS policies so only authenticated users can access their own data
- Realtime enabled on both tables
- Indexes and updated_at triggers

### 2. Register the edge function in config

The `jac-code-agent` function needs to be added to `supabase/config.toml` with `verify_jwt = false` (it uses service-role auth like the other agents).

### 3. Deploy the edge function

Deploy `jac-code-agent` and redeploy `jac-dispatcher` (which was updated to route code intent).

### 4. Set up GITHUB_PAT secret

The code agent needs a GitHub Personal Access Token with `repo` scope to read files, create branches, commit code, and open PRs. You'll need to provide this secret.

---

## Technical Details

### Migration SQL

```sql
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

-- Service role insert policies (for edge functions)
CREATE POLICY "Service role insert projects" ON public.code_projects FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service role insert sessions" ON public.code_sessions FOR INSERT TO service_role WITH CHECK (true);
CREATE POLICY "Service role update projects" ON public.code_projects FOR UPDATE TO service_role USING (true);
CREATE POLICY "Service role update sessions" ON public.code_sessions FOR UPDATE TO service_role USING (true);

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
```

### Config change

Add to `supabase/config.toml`:
```toml
[functions.jac-code-agent]
verify_jwt = false
```

### Deploy

Deploy both `jac-code-agent` and `jac-dispatcher`.

### Secret

Request `GITHUB_PAT` -- a GitHub Personal Access Token with `repo` scope. You can create one at GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens. Grant it read/write access to Contents, Pull Requests, and Metadata for the repos you want the agent to work with.

## Sequence

1. Run migration (create tables)
2. Update config.toml (register function)
3. Request GITHUB_PAT secret from you
4. Deploy edge functions
5. Navigate to /code and verify the workspace loads

