-- brain_insights table: AI-generated insights from brain analysis
CREATE TABLE IF NOT EXISTS public.brain_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('pattern', 'overdue', 'stale', 'schedule', 'suggestion')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  entry_ids UUID[] DEFAULT '{}',
  dismissed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_brain_insights_user ON public.brain_insights(user_id, dismissed, expires_at);

-- RLS: users read/update their own insights, service role writes
ALTER TABLE public.brain_insights ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own insights"
  ON public.brain_insights FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can dismiss own insights"
  ON public.brain_insights FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Service role full access"
  ON public.brain_insights FOR ALL
  USING (auth.role() = 'service_role');

-- Cron: brain-insights twice daily (10 AM + 8 PM Central = 16:00 + 02:00 UTC)
SELECT cron.unschedule('brain-insights-morning')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brain-insights-morning');

SELECT cron.schedule(
  'brain-insights-morning',
  '0 16 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1) || '/functions/v1/brain-insights',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.unschedule('brain-insights-evening')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brain-insights-evening');

SELECT cron.schedule(
  'brain-insights-evening',
  '0 2 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url' LIMIT 1) || '/functions/v1/brain-insights',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Auto-cleanup expired insights daily at 3 AM UTC
SELECT cron.unschedule('brain-insights-cleanup')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'brain-insights-cleanup');

SELECT cron.schedule(
  'brain-insights-cleanup',
  '0 3 * * *',
  $$DELETE FROM public.brain_insights WHERE expires_at < now();$$
);
