-- =============================================================================
-- 20260502000100_ct_eod_reports_flow_recap.sql
--
-- Adds three flow-recap columns to ct_eod_reports so today's option flow
-- gets dedicated real-estate in the EOD report instead of being squeezed
-- into per_ticker_close.carryover_thesis (one sentence) or the script
-- (180-word narrative).
--
-- - flow_recap     — biggest scored flows of the day (premium DESC)
-- - stack_recap    — contracts that stacked most aggressively today
-- - realized_recap — top realized peak% on tracks first-printed today
--
-- All optional, default empty array. Existing rows backfill empty; no
-- consumer code requires them.
-- =============================================================================
SET search_path = public, extensions;

ALTER TABLE public.ct_eod_reports
  ADD COLUMN IF NOT EXISTS flow_recap     jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS stack_recap    jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS realized_recap jsonb DEFAULT '[]'::jsonb;
