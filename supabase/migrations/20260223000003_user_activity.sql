-- JAC Agent OS: Safe patch for user_activity
-- Lovable migration 20260222065313 already created the table.
-- This adds the event-level index that was missing.

CREATE INDEX IF NOT EXISTS idx_user_activity_event
  ON public.user_activity(event, created_at DESC);
