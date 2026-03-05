-- Code Agent 3-Tier Upgrade: add merge_sha, iteration_count, ci_status to code_sessions
ALTER TABLE code_sessions ADD COLUMN IF NOT EXISTS merge_sha TEXT;
ALTER TABLE code_sessions ADD COLUMN IF NOT EXISTS iteration_count INTEGER DEFAULT 0;
ALTER TABLE code_sessions ADD COLUMN IF NOT EXISTS ci_status TEXT;
