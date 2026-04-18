-- Allow authenticated users to UPDATE ct_biases so the BiasesPanel's
-- retire button works without routing through an edge function.
-- Single-user app so a broad auth policy is fine; if we ever multi-user
-- this, narrow to user_id ownership.
SET search_path = public, extensions;

DROP POLICY IF EXISTS ct_biases_retire ON ct_biases;
CREATE POLICY ct_biases_retire ON ct_biases
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (true);
