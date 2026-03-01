-- Code Validations: track build/test/lint results for code sessions
-- Makes self-modification safe by recording pass/fail status

CREATE TABLE code_validations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES code_sessions ON DELETE CASCADE,
  validation_type TEXT NOT NULL CHECK (validation_type IN ('build', 'test', 'lint', 'syntax')),
  passed BOOLEAN NOT NULL,
  output TEXT,
  duration_ms INT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS via join to code_sessions
ALTER TABLE code_validations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own code validations"
  ON code_validations FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM code_sessions
      WHERE code_sessions.id = code_validations.session_id
      AND code_sessions.user_id = auth.uid()
    )
  );

CREATE POLICY "Service role full access to code_validations"
  ON code_validations FOR ALL
  USING (auth.role() = 'service_role');

-- Index
CREATE INDEX idx_code_validations_session_id ON code_validations(session_id);

-- Add validated column to code_sessions
ALTER TABLE code_sessions ADD COLUMN IF NOT EXISTS validated BOOLEAN DEFAULT NULL;
