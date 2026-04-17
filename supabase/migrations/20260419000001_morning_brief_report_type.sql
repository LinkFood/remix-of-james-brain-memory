-- Widen ct_reports.report_type to include 'morning_brief'.
-- The morning brief is a distinct report_type from 'eod' and 'midday':
-- it bridges the overnight / weekend gap and is consumed at 6:45 AM ET
-- by the trader before the open. Track it as a first-class report so
-- the reports hub + scorecard can filter on it.
SET search_path = public, extensions;

ALTER TABLE ct_reports
  DROP CONSTRAINT IF EXISTS ct_reports_report_type_check;

ALTER TABLE ct_reports
  ADD CONSTRAINT ct_reports_report_type_check
  CHECK (report_type IN ('eod','midday','morning_brief','weekly','quarterly'));
