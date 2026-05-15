-- Ship 7 α — eod_report_bars_intra_rth_coverage warden invariant
--
-- Catches the class killed by the producer fix in ct-eod-report (commit
-- e50b374): PostgREST's 1000-row hard cap silently window-shifted the bars
-- query to the first ~5h41m of pre-market. Producer fan-out fixes the live
-- path; this invariant detects future regressions or any new EOD-style
-- consumer that re-introduces the same shape.
--
-- Shape: for the latest ct_eod_reports row in the last 24h, fail if ANY
-- ticker in per_ticker_close has ZERO ct_price_bars rows with ts at or after
-- 13:30 UTC (09:30 ET) on its session_date. EXISTS guard keeps the invariant
-- dormant until the first post-fix EOD report writes, then auto-engages.
--
-- Authoring per docs/runbooks/ct_invariants_sql_authoring.md (PR #55):
--   single SELECT, no inline comments, terminal semicolon only, no
--   semicolons inside string literals (warden parser is semicolon-blind).
--
-- See also: ~/.claude/agent-memory/core-logic-builder/MEMORY.md
--   warden_dormant_until_active pattern.

INSERT INTO public.ct_invariants
  (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path)
VALUES
  ('eod_report_bars_intra_rth_coverage',
   'data_quality',
   'Ship 7 α — for the latest ct_eod_reports row in the last 24h, fails when any ticker in per_ticker_close has zero ct_price_bars rows at or after 13:30 UTC on the session_date. Dormant until first post-fix EOD report writes. Catches PostgREST 1000-row cap regression class (cascade #49).',
   $inv$WITH latest AS (SELECT id, session_date, per_ticker_close FROM public.ct_eod_reports WHERE created_at >= now() - interval '24 hours' AND per_ticker_close IS NOT NULL ORDER BY created_at DESC LIMIT 1), active AS (SELECT EXISTS(SELECT 1 FROM latest) AS is_active), tickers AS (SELECT (elem->>'ticker') AS ticker, l.session_date FROM latest l, jsonb_array_elements(l.per_ticker_close) elem WHERE elem ? 'ticker'), gaps AS (SELECT COUNT(*) AS n FROM tickers t WHERE NOT EXISTS (SELECT 1 FROM public.ct_price_bars b WHERE b.ticker = t.ticker AND b.timeframe IN ('1m','5m') AND b.ts >= (t.session_date::timestamp + interval '13 hours 30 minutes') AT TIME ZONE 'UTC' AND b.ts <= (t.session_date::timestamp + interval '20 hours') AT TIME ZONE 'UTC')) SELECT CASE WHEN active.is_active THEN gaps.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'eod_report_bars_intra_rth_coverage dormant — no ct_eod_reports row in last 24h' WHEN gaps.n = 0 THEN 'all tickers in latest EOD report have intra-RTH bar coverage' ELSE 'COVERAGE GAP — ' || gaps.n || ' tickers in latest EOD report have ZERO ct_price_bars rows at-or-after 13:30 UTC, window-shift class regression suspected' END AS message FROM active, gaps$inv$,
   NULL, 0, NULL, 'warn', 'docs/system-map/eod-report-window-coverage.md');
