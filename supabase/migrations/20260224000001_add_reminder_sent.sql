-- Add reminder_sent column for tracking which reminders have been delivered
ALTER TABLE public.entries
ADD COLUMN IF NOT EXISTS reminder_sent BOOLEAN DEFAULT false;

-- Partial index for efficient polling: only rows with pending reminders
CREATE INDEX IF NOT EXISTS idx_entries_pending_reminders
ON public.entries(event_date, reminder_minutes)
WHERE event_date IS NOT NULL
  AND reminder_minutes IS NOT NULL
  AND reminder_sent = false;

-- pg_cron schedules for reminder delivery
-- Morning check (8:00 AM UTC)
SELECT cron.schedule(
  'reminder-morning',
  '0 8 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/calendar-reminder-check',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );$$
);

-- Evening check (6:00 PM UTC)
SELECT cron.schedule(
  'reminder-evening',
  '0 18 * * *',
  $$SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/calendar-reminder-check',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );$$
);

-- Frequent check for time-specific reminders (every 15 min)
SELECT cron.schedule(
  'reminder-timed',
  '*/15 * * * *',
  $$SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/calendar-reminder-check',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{"timed_only": true}'::jsonb
  );$$
);
