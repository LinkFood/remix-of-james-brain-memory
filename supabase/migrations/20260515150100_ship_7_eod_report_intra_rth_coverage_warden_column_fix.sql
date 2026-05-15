-- Ship 7 α — eod_report_bars_intra_rth_coverage column fix
--
-- First-tick error: ct_eod_reports has `generated_at`, not `created_at`.
-- Replace query_sql with corrected column reference. Single-SELECT shape +
-- $inv$ delimiters preserved.

UPDATE public.ct_invariants
SET query_sql = $inv$WITH latest AS (SELECT id, session_date, per_ticker_close FROM public.ct_eod_reports WHERE generated_at >= now() - interval '24 hours' AND per_ticker_close IS NOT NULL ORDER BY generated_at DESC LIMIT 1), active AS (SELECT EXISTS(SELECT 1 FROM latest) AS is_active), tickers AS (SELECT (elem->>'ticker') AS ticker, l.session_date FROM latest l, jsonb_array_elements(l.per_ticker_close) elem WHERE elem ? 'ticker'), gaps AS (SELECT COUNT(*) AS n FROM tickers t WHERE NOT EXISTS (SELECT 1 FROM public.ct_price_bars b WHERE b.ticker = t.ticker AND b.timeframe IN ('1m','5m') AND b.ts >= (t.session_date::timestamp + interval '13 hours 30 minutes') AT TIME ZONE 'UTC' AND b.ts <= (t.session_date::timestamp + interval '20 hours') AT TIME ZONE 'UTC')) SELECT CASE WHEN active.is_active THEN gaps.n::numeric ELSE 0::numeric END AS metric_value, CASE WHEN NOT active.is_active THEN 'eod_report_bars_intra_rth_coverage dormant — no ct_eod_reports row in last 24h' WHEN gaps.n = 0 THEN 'all tickers in latest EOD report have intra-RTH bar coverage' ELSE 'COVERAGE GAP — ' || gaps.n || ' tickers in latest EOD report have ZERO ct_price_bars rows at-or-after 13:30 UTC, window-shift class regression suspected' END AS message FROM active, gaps$inv$
WHERE name = 'eod_report_bars_intra_rth_coverage';
