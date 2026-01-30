-- Add reminder_minutes column to entries for scheduling reminders
ALTER TABLE public.entries
ADD COLUMN reminder_minutes integer DEFAULT NULL;

-- Add index for efficient reminder queries
CREATE INDEX idx_entries_event_date_reminder ON public.entries(event_date, reminder_minutes) WHERE event_date IS NOT NULL;