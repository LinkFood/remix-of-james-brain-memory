-- JAC Principles: strategic learnings distilled from reflections
-- Weekly cron extracts patterns into reusable operating principles

CREATE TABLE jac_principles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  principle TEXT NOT NULL,
  source_reflection_ids UUID[],
  confidence FLOAT DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  times_applied INT DEFAULT 0,
  embedding vector(512),
  created_at TIMESTAMPTZ DEFAULT now(),
  last_validated TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE jac_principles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own principles"
  ON jac_principles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users insert own principles"
  ON jac_principles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users update own principles"
  ON jac_principles FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Service role full access to jac_principles"
  ON jac_principles FOR ALL
  USING (auth.role() = 'service_role');

-- Indices
CREATE INDEX idx_jac_principles_user_id ON jac_principles(user_id);
CREATE INDEX idx_jac_principles_confidence ON jac_principles(user_id, confidence DESC);
CREATE INDEX idx_jac_principles_embedding ON jac_principles
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
