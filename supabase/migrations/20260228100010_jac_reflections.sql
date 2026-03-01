CREATE TABLE jac_reflections (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  task_id UUID REFERENCES agent_tasks(id) ON DELETE SET NULL,
  task_type TEXT NOT NULL,
  intent TEXT,
  summary TEXT NOT NULL,
  connections TEXT[],
  embedding extensions.vector(512),
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE jac_reflections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users own reflections" ON jac_reflections
  FOR ALL USING (auth.uid() = user_id);

CREATE INDEX idx_jac_reflections_user_created ON jac_reflections(user_id, created_at DESC);
CREATE INDEX idx_jac_reflections_embedding ON jac_reflections
  USING hnsw (embedding extensions.vector_cosine_ops) WITH (m = 16, ef_construction = 64);
