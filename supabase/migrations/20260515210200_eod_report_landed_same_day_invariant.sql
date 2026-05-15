-- Warden invariant: eod_report_landed_same_day
--
-- 2026-05-15 incident: the scheduled 21:00 UTC ct-eod-report run produced no
-- ct_eod_reports row. The existing eod_report_yesterday_landed invariant did
-- NOT catch it — it checks the PRIOR business day with a 4-day lookback and
-- gates off before 09:00 ET, so a same-day 21:00 miss stays invisible until
-- the next morning. This invariant closes that gap.
--
-- Shape: window-gated, sibling of cron_fire_rate_within_empirical_band. Returns
-- metric_value 1 (healthy) when dormant — i.e. outside the window or on a
-- weekend — and only fails (0) when it IS a weekday, current UTC time is past
-- 21:35 (after the 21:00 scheduled write plus a buffer), and no ct_eod_reports
-- row exists for today's ET session_date. The catch-up cron re-fires every
-- 20 min 21:00-22:59 UTC, so a warn here means the catch-up loop is also not
-- landing a row.
--
-- Authoring per docs/runbooks/ct_invariants_sql_authoring.md — single SELECT,
-- no inline comments, no semicolons inside string literals (warden parser is
-- semicolon-blind — separators are ' — ' and ','), terminal semicolon only.
--
-- category data_freshness — matches eod_report_yesterday_landed. severity warn.

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path)
VALUES
  ('eod_report_landed_same_day',
   'data_freshness',
   'Same-day EOD report freshness — fails when it is a weekday, current time is past 21:35 UTC (after the 21:00 scheduled write plus buffer), and no ct_eod_reports row exists for today ET session_date. Window-gated, dormant on weekends and before 21:35 UTC. Closes the gap eod_report_yesterday_landed leaves open (prior-day check only). Added 2026-05-15.',
   $inv$WITH gate AS (SELECT EXTRACT(DOW FROM (now() AT TIME ZONE 'UTC'))::int BETWEEN 1 AND 5 AND ((now() AT TIME ZONE 'UTC')::time >= '21:35'::time) AS in_window), landed AS (SELECT EXISTS(SELECT 1 FROM public.ct_eod_reports WHERE session_date = (now() AT TIME ZONE 'America/New_York')::date) AS has_row) SELECT CASE WHEN NOT gate.in_window THEN 1::numeric WHEN landed.has_row THEN 1::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT gate.in_window THEN 'dormant — outside the same-day EOD check window (weekday after 21:35 UTC)' WHEN landed.has_row THEN 'today ET session_date EOD report row exists' ELSE 'MISSING — no ct_eod_reports row for today ET session_date past 21:35 UTC, scheduled 21:00 run and the catch-up cron both failed to land a row' END AS message FROM gate, landed$inv$,
   1, NULL, NULL, 'warn', 'docs/runbooks/eod_pipeline.md');
