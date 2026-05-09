-- ============================================================================
-- Phase 5 (audit-driven loop, fusion ground-truth Section E #1):
-- get_news_causality_hit_rates RPC.
--
-- The ct_news_causality schema comment says:
--   "Per-source hit rates become a novel derived signal
--    ('Bloomberg moves NVDA flow 68% of the time, Tradex 12%')."
--
-- That signal has never been surfaced. This RPC + the /alpha News Causality
-- Matrix component (Phase 5 of the audit-driven loop) renders it.
--
-- Returns rows of (news_source, ticker, total_n, moved_count, hit_pct,
-- moved_flow_pct, moved_dp_pct) for the requested lookback window. Filters
-- by minimum N (default 3) to avoid single-fluke noise. Caller is expected
-- to filter further to a watchlist of interest.
-- ============================================================================
SET search_path = public, extensions;

CREATE OR REPLACE FUNCTION public.get_news_causality_hit_rates(
  p_lookback_days int   DEFAULT 7,
  p_min_n         int   DEFAULT 3,
  p_tickers       text[] DEFAULT NULL    -- NULL = all tickers; array = filter
)
RETURNS TABLE (
  news_source       text,
  ticker            text,
  total_n           int,
  moved_count       int,
  hit_pct           numeric,
  flow_moved_count  int,
  dp_moved_count    int,
  total_flow_premium numeric,
  total_dp_notional  numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions
AS $fn$
  SELECT
    COALESCE(c.news_source, '(unknown)')                   AS news_source,
    c.ticker                                                AS ticker,
    COUNT(*)::int                                           AS total_n,
    SUM(CASE WHEN c.moved THEN 1 ELSE 0 END)::int           AS moved_count,
    ROUND(100.0 * SUM(CASE WHEN c.moved THEN 1 ELSE 0 END) / NULLIF(COUNT(*), 0), 1) AS hit_pct,
    SUM(CASE WHEN c.flow_premium_15min > 0 THEN 1 ELSE 0 END)::int        AS flow_moved_count,
    SUM(CASE WHEN c.dp_notional_15min >= 10000000 THEN 1 ELSE 0 END)::int AS dp_moved_count,
    SUM(COALESCE(c.flow_premium_15min, 0))::numeric         AS total_flow_premium,
    SUM(COALESCE(c.dp_notional_15min, 0))::numeric          AS total_dp_notional
  FROM public.ct_news_causality c
  WHERE c.news_at >= now() - (p_lookback_days * interval '1 day')
    AND (p_tickers IS NULL OR c.ticker = ANY(p_tickers))
  GROUP BY COALESCE(c.news_source, '(unknown)'), c.ticker
  HAVING COUNT(*) >= p_min_n
  ORDER BY total_n DESC, hit_pct DESC;
$fn$;

GRANT EXECUTE ON FUNCTION public.get_news_causality_hit_rates(int, int, text[])
  TO authenticated, service_role;

COMMENT ON FUNCTION public.get_news_causality_hit_rates IS
  'Per-source x per-ticker news causality hit rates over a lookback window. Returns rows where total_n >= p_min_n. Used by /alpha NewsCausalityMatrix component (Phase 5). Implements the "Bloomberg moves NVDA flow 68% of the time" derived signal documented in ct_news_causality.sql but never surfaced until now.';
