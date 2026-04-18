-- Ensure ct_reports.report_type allows 'weekly'.
--
-- Verified at write time (2026-04-20): 20260419000001_morning_brief_report_type.sql
-- ALREADY widened the CHECK constraint to include 'weekly' (and 'quarterly').
-- This migration is a safety-net re-assertion so the ct-weekly-reflection build
-- order is independent of earlier migration state (defensive on fresh DBs and
-- partial rollbacks).
SET search_path = public, extensions;

ALTER TABLE ct_reports
  DROP CONSTRAINT IF EXISTS ct_reports_report_type_check;

ALTER TABLE ct_reports
  ADD CONSTRAINT ct_reports_report_type_check
  CHECK (report_type IN ('eod','midday','morning_brief','weekly','quarterly'));
