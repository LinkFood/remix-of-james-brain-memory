CREATE TABLE public.user_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event text NOT NULL,
  category text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  entry_id uuid,
  session_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.user_activity ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own activity"
  ON public.user_activity FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own activity"
  ON public.user_activity FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_user_activity_user_date ON public.user_activity (user_id, created_at);
CREATE INDEX idx_user_activity_category ON public.user_activity (user_id, category, created_at);

ALTER PUBLICATION supabase_realtime ADD TABLE public.user_activity;