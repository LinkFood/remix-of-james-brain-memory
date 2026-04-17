-- ============================================================================
-- Morning Brief — spoken daily brief from Claude, narrated by ElevenLabs
-- Stores script + audio URL. Cron fires weekday pre-market.
-- ============================================================================
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS ct_morning_briefs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  for_date         date NOT NULL UNIQUE,
  script           text NOT NULL,
  audio_url        text,
  duration_seconds numeric,
  prompt_version   text NOT NULL DEFAULT 'v1',
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ct_morning_briefs_for_date_idx
  ON ct_morning_briefs (for_date DESC);

ALTER TABLE ct_morning_briefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_morning_briefs_authenticated_read
  ON ct_morning_briefs FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_morning_briefs_service_role_all
  ON ct_morning_briefs FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================================
-- Storage bucket for generated audio (public read for single-user simplicity)
-- ============================================================================
INSERT INTO storage.buckets (id, name, public)
VALUES ('ct-audio', 'ct-audio', true)
ON CONFLICT (id) DO NOTHING;

-- Service role uploads; anyone can read (bucket is public)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'ct_audio_service_role_all'
  ) THEN
    CREATE POLICY ct_audio_service_role_all
      ON storage.objects FOR ALL TO service_role
      USING (bucket_id = 'ct-audio')
      WITH CHECK (bucket_id = 'ct-audio');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'storage' AND tablename = 'objects'
      AND policyname = 'ct_audio_public_read'
  ) THEN
    CREATE POLICY ct_audio_public_read
      ON storage.objects FOR SELECT TO anon, authenticated
      USING (bucket_id = 'ct-audio');
  END IF;
END $$;
