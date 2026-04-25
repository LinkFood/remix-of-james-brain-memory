-- Replay-mode audit field on the signature alarm log.
--
-- ct-signature-watcher accepts {"replay_mode": true} body to re-process a
-- historical window. Tagging the log row makes those replay fires
-- filterable / bulk-deletable without touching the live operational data.

SET search_path = public, extensions;

ALTER TABLE public.ct_signature_alarm_log
  ADD COLUMN IF NOT EXISTS replay_run boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_alarm_log_replay
  ON public.ct_signature_alarm_log (replay_run, fired_at DESC);
