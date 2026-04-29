-- =============================================================================
-- 20260429240000_ct_eod_reports.sql
--
-- ct_eod_reports — forward-looking close-to-open handoff. Mirror of
-- ct_daily_briefs in shape; complements ct_eod_summaries (the journal).
--
-- The journal (ct_eod_summaries) attributes today's P&L. The report grades
-- this morning's brief vs reality + compiles tomorrow's setup. Every row
-- has UNIQUE on session_date so re-fires UPSERT cleanly.
--
-- Loop closure: tomorrow's morning brief reads yesterday's report for
-- carryover_themes, tomorrow_watchlist, skip_tomorrow, lessons_today.
-- Wiring brief→report consumption is deferred (Phase 5 — punch list).
-- =============================================================================
SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.ct_eod_reports (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_date                date NOT NULL UNIQUE,
  generated_at                timestamptz NOT NULL DEFAULT now(),
  generated_by_model          text,

  -- Forward-looking sections (Sonnet-written, structured JSON for UI cards)
  session_summary             text,
  regime_close                text,
  regime_shift_today          text,
  per_ticker_close            jsonb DEFAULT '[]'::jsonb,
  morning_brief_scorecard     jsonb DEFAULT '[]'::jsonb,
  scorecard_summary           jsonb DEFAULT '{}'::jsonb,
  carryover_themes            jsonb DEFAULT '[]'::jsonb,
  overnight_catalysts         jsonb DEFAULT '[]'::jsonb,
  breaking_events_today       jsonb DEFAULT '[]'::jsonb,
  tomorrow_watchlist          jsonb DEFAULT '[]'::jsonb,
  skip_tomorrow               jsonb DEFAULT '[]'::jsonb,
  lessons_today               jsonb DEFAULT '[]'::jsonb,
  script                      text,

  -- Loop attribution — what we built on / what we graded
  morning_brief_id            uuid REFERENCES public.ct_daily_briefs(id) ON DELETE SET NULL,
  eod_summary_id              bigint REFERENCES public.ct_eod_summaries(id) ON DELETE SET NULL,

  -- Cost / TTL bookkeeping
  cost_usd                    numeric,
  tokens_in                   int,
  tokens_out                  int,
  triggered_by                text DEFAULT 'scheduled',  -- scheduled | manual | rerun
  ttl_hours                   int DEFAULT 48
);

CREATE INDEX IF NOT EXISTS idx_ct_eod_reports_session_date
  ON public.ct_eod_reports (session_date DESC);
CREATE INDEX IF NOT EXISTS idx_ct_eod_reports_generated_at
  ON public.ct_eod_reports (generated_at DESC);

ALTER TABLE public.ct_eod_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_eod_reports_read ON public.ct_eod_reports;
CREATE POLICY ct_eod_reports_read ON public.ct_eod_reports
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_eod_reports_svc ON public.ct_eod_reports;
CREATE POLICY ct_eod_reports_svc ON public.ct_eod_reports
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- ct_config keys — verdict thresholds (tunable without redeploy).
-- ----------------------------------------------------------------------------
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('eod_report_verdict_lean_win_pct', '0.4'::jsonb,
    'long_lean / short_lean: |session_pct| >= this means win-on-direction.',
    'eod_report', '0.4'::jsonb),
  ('eod_report_verdict_neutral_loss_pct', '0.8'::jsonb,
    'neutral call: |session_pct| >= this means we missed a clean trend (loss).',
    'eod_report', '0.8'::jsonb),
  ('eod_report_verdict_avoid_chop_range_pct', '1.5'::jsonb,
    'avoid call: |session_range_pct| >= this AND |session_pct| < neutral_loss = vindicated chop (win).',
    'eod_report', '1.5'::jsonb),
  ('eod_report_carryover_lookback_hours', '1'::jsonb,
    'How many hours of pulse / specialist data to read for "close" view.',
    'eod_report', '1'::jsonb),
  ('eod_report_slack_enabled', 'true'::jsonb,
    'Master switch for the EOD report Slack push.',
    'eod_report', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE public.ct_eod_reports IS
  'Forward-looking EOD pack — close-to-open handoff. Mirror of ct_daily_briefs in shape; loop-closes against today''s morning brief.';
