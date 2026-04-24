-- ============================================================================
-- Co-Trader v2 — EOD Summaries
-- ============================================================================
-- Daily 4:30pm ET narrative report card. Aggregates the day's flags + grades
-- + reads + flow events + stacking + tape commentary into a Sonnet-tier
-- written summary. Powers the /eod archive page and the daily Slack push.
--
-- Why this exists: every other surface (flags, reads, tape, stacks) is a
-- moment-in-time signal. EOD is the day's coherent arc — what worked, what
-- didn't, where the surprises were. THE LEDGER. Without it there is no
-- framework for "is the system getting better over time?" (See
-- project_co_trader_eod_summary_weekend.md.)
--
-- Tenets — meta-layer eats its own outputs (17), real-time contextual
-- awareness (10), every number tunable (7). EOD is the grading mirror.
-- ============================================================================

SET search_path = public, extensions;

CREATE TABLE IF NOT EXISTS public.ct_eod_summaries (
  id               BIGSERIAL PRIMARY KEY,
  session_date     DATE UNIQUE NOT NULL,
  summary_text     TEXT NOT NULL,
  specialist_stats JSONB NOT NULL DEFAULT '{}'::jsonb,
  ticker_stats     JSONB NOT NULL DEFAULT '{}'::jsonb,
  market_stats     JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at     TIMESTAMPTZ DEFAULT now(),
  model            TEXT,
  cost_usd         NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_ct_eod_summaries_session_date
  ON public.ct_eod_summaries (session_date DESC);

ALTER TABLE public.ct_eod_summaries ENABLE ROW LEVEL SECURITY;

CREATE POLICY ct_eod_summaries_read ON public.ct_eod_summaries
  FOR SELECT TO authenticated USING (true);

CREATE POLICY ct_eod_summaries_service ON public.ct_eod_summaries
  FOR ALL TO service_role USING (true) WITH CHECK (true);

COMMENT ON TABLE public.ct_eod_summaries IS
  'V2 end-of-day narrative + grades. One row per trading day. Generated 30 min after RTH close (20:30 UTC weekdays) by ct-eod-summary edge function. Sonnet-tier write.';
COMMENT ON COLUMN public.ct_eod_summaries.specialist_stats IS
  'Per-specialist daily metrics: {flags_count, bull_count, bear_count, mixed_count, avg_conviction, reads_count, grade_breakdown}.';
COMMENT ON COLUMN public.ct_eod_summaries.ticker_stats IS
  'Per-ticker daily metrics: {open_spot, close_spot, day_pct_change, top_flow, top_stack, flow_pulse_open, flow_pulse_close, regime_shift}.';
COMMENT ON COLUMN public.ct_eod_summaries.market_stats IS
  'Market-wide daily metrics: {tape_first, tape_last, market_premium_open, market_premium_close, market_premium_delta, total_flags, total_reads, total_stacks, unusual_pulse_count}.';

-- ----------------------------------------------------------------------------
-- Cron: 30 20 * * 1-5  (20:30 UTC, weekdays — 30 min after RTH close 4:00 ET)
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  PERFORM cron.unschedule('ct-eod-summary');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'ct-eod-summary',
  '30 20 * * 1-5',
  $cron$
    SELECT net.http_post(
      url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/ct-eod-summary',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
      ),
      body := '{}'::jsonb
    ) AS request_id;
  $cron$
);
