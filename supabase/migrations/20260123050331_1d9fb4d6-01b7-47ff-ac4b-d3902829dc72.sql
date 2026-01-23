-- Add missing UPDATE policy for brain_reports table
CREATE POLICY "Users can update their own reports"
  ON public.brain_reports
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);