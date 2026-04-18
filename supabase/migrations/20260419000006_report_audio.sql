-- ============================================================================
-- Report audio — attach narrated audio to ct_reports rows (morning_brief etc.)
-- Keeps the audio reference on the report itself rather than a sibling table,
-- so any future report_type can carry narration. Storage lives in ct-audio
-- bucket (created in 20260416000015_ct_morning_brief.sql).
-- ============================================================================
SET search_path = public, extensions;

ALTER TABLE ct_reports
  ADD COLUMN IF NOT EXISTS audio_url         text,
  ADD COLUMN IF NOT EXISTS audio_duration_ms integer;

COMMENT ON COLUMN ct_reports.audio_url IS
  'Public URL to the ElevenLabs-narrated MP3 in the ct-audio Storage bucket. NULL if TTS was skipped or failed.';
COMMENT ON COLUMN ct_reports.audio_duration_ms IS
  'Estimated narration duration in milliseconds (derived from script word count at 155 wpm).';
