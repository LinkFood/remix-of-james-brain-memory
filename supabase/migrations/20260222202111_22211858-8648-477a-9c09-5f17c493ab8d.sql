ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_created ON agent_tasks(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_user_status ON agent_tasks(user_id, status);