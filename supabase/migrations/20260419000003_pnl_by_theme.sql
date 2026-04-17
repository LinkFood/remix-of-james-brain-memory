-- ct_pnl_by_theme — P&L aggregation grouped by the classified thesis theme.
--
-- Themes are assigned at trade-insert time (or via ct-classify-themes backfill)
-- by supabase/functions/_shared/thesisClassifier.ts. This migration adds the
-- column and two reporting views (all-time + last 7 days).
--
-- Views are SECURITY INVOKER (default) — RLS on ct_trades still applies.

-- 1. Column — nullable so older rows stay queryable; backfill populates later.
ALTER TABLE public.ct_trades
  ADD COLUMN IF NOT EXISTS thesis_theme text;

CREATE INDEX IF NOT EXISTS ct_trades_thesis_theme_idx
  ON public.ct_trades (thesis_theme)
  WHERE thesis_theme IS NOT NULL;

-- 2. All-time P&L by theme (closed trades only).
CREATE OR REPLACE VIEW public.ct_pnl_by_theme AS
SELECT
  COALESCE(thesis_theme, 'other')                                  AS thesis_theme,
  COUNT(*)                                                          AS trade_count,
  SUM(COALESCE(realized_pnl_usd, 0))                                AS total_pnl_usd,
  AVG(realized_pnl_pct)                                             AS avg_pnl_pct,
  AVG(realized_pnl_usd)                                             AS avg_pnl_usd,
  COUNT(*) FILTER (WHERE realized_pnl_pct > 0)                      AS wins,
  COUNT(*) FILTER (WHERE realized_pnl_pct < 0)                      AS losses,
  CASE
    WHEN COUNT(*) FILTER (WHERE realized_pnl_pct IS NOT NULL AND realized_pnl_pct <> 0) > 0
    THEN (COUNT(*) FILTER (WHERE realized_pnl_pct > 0))::numeric
       / COUNT(*) FILTER (WHERE realized_pnl_pct IS NOT NULL AND realized_pnl_pct <> 0)
    ELSE NULL
  END                                                               AS win_rate
FROM public.ct_trades
WHERE status = 'closed'
GROUP BY COALESCE(thesis_theme, 'other');

-- 3. Last 7 days window — same shape, filtered by session_date.
CREATE OR REPLACE VIEW public.ct_pnl_by_theme_7d AS
SELECT
  COALESCE(thesis_theme, 'other')                                  AS thesis_theme,
  COUNT(*)                                                          AS trade_count,
  SUM(COALESCE(realized_pnl_usd, 0))                                AS total_pnl_usd,
  AVG(realized_pnl_pct)                                             AS avg_pnl_pct,
  AVG(realized_pnl_usd)                                             AS avg_pnl_usd,
  COUNT(*) FILTER (WHERE realized_pnl_pct > 0)                      AS wins,
  COUNT(*) FILTER (WHERE realized_pnl_pct < 0)                      AS losses,
  CASE
    WHEN COUNT(*) FILTER (WHERE realized_pnl_pct IS NOT NULL AND realized_pnl_pct <> 0) > 0
    THEN (COUNT(*) FILTER (WHERE realized_pnl_pct > 0))::numeric
       / COUNT(*) FILTER (WHERE realized_pnl_pct IS NOT NULL AND realized_pnl_pct <> 0)
    ELSE NULL
  END                                                               AS win_rate
FROM public.ct_trades
WHERE status = 'closed'
  AND session_date >= (CURRENT_DATE - INTERVAL '7 days')
GROUP BY COALESCE(thesis_theme, 'other');

COMMENT ON COLUMN public.ct_trades.thesis_theme IS
  'Regex-classified theme: convergence | structural_tightness | gap | news_driven | regime_flip | thesis_invalidation | other. Populated by _shared/thesisClassifier.ts.';
COMMENT ON VIEW public.ct_pnl_by_theme    IS 'All-time P&L grouped by thesis_theme (closed trades only).';
COMMENT ON VIEW public.ct_pnl_by_theme_7d IS 'Last-7-days P&L grouped by thesis_theme (closed trades only).';
