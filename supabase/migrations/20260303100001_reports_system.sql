-- Reports System: expand brain_reports as unified report index
-- All producers (morning brief, research, market snapshot, generate-brain-report) write here

-- Expand report_type CHECK for all producers
ALTER TABLE public.brain_reports DROP CONSTRAINT IF EXISTS brain_reports_report_type_check;
ALTER TABLE public.brain_reports ADD CONSTRAINT brain_reports_report_type_check
  CHECK (report_type IN ('daily', 'weekly', 'monthly', 'morning_brief', 'research', 'market_snapshot'));

-- New columns for universal report storage
ALTER TABLE public.brain_reports
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS body_markdown TEXT,
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'generate-brain-report',
  ADD COLUMN IF NOT EXISTS entry_id UUID REFERENCES public.entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS task_id UUID;

-- Make date columns nullable (research/market reports are point-in-time)
ALTER TABLE public.brain_reports ALTER COLUMN start_date DROP NOT NULL;
ALTER TABLE public.brain_reports ALTER COLUMN end_date DROP NOT NULL;
ALTER TABLE public.brain_reports ALTER COLUMN summary DROP NOT NULL;

-- Indexes for filtered queries
CREATE INDEX IF NOT EXISTS idx_brain_reports_type ON public.brain_reports(user_id, report_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_brain_reports_source ON public.brain_reports(user_id, source, created_at DESC);
