
ALTER TABLE public.entries
ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_entries_pending_reminders
ON public.entries(event_date, reminder_minutes)
WHERE event_date IS NOT NULL
  AND reminder_minutes IS NOT NULL
  AND reminder_sent = false;

CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
