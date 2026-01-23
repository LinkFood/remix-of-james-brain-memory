-- Add calendar/time tracking fields to entries table
ALTER TABLE public.entries ADD COLUMN IF NOT EXISTS event_date DATE;
ALTER TABLE public.entries ADD COLUMN IF NOT EXISTS event_time TIME;
ALTER TABLE public.entries ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN DEFAULT false;
ALTER TABLE public.entries ADD COLUMN IF NOT EXISTS recurrence_pattern TEXT;

-- Create index for efficient querying of upcoming events
CREATE INDEX IF NOT EXISTS idx_entries_event_date ON public.entries(event_date) WHERE event_date IS NOT NULL;

COMMENT ON COLUMN public.entries.event_date IS 'Date for events, reminders, appointments';
COMMENT ON COLUMN public.entries.event_time IS 'Time for events if specified';
COMMENT ON COLUMN public.entries.is_recurring IS 'Whether this is a recurring event';
COMMENT ON COLUMN public.entries.recurrence_pattern IS 'Pattern: daily, weekly, monthly, yearly';