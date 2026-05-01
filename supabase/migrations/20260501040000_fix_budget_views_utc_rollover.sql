-- =============================================================================
-- 20260501040000_fix_budget_views_utc_rollover.sql
--
-- Fix UTC-rollover display bugs in both budget badges.
--
-- Symptom (caught 2026-04-30 night, ~10:30 PM ET):
--   - UW badge showed 0.8% (169/20000) when actual day's peak was 20,000 (100%)
--   - Tavily badge showed 0/4000 when April had 158 credits used (4%)
--   Both badges looked "reset". Underlying ct_uw_usage + ct_tavily_usage data
--   was intact — the views just snapped to wrong window at UTC midnight.
--
-- Root cause (UW):
--   ct_uw_usage_latest uses DISTINCT ON (session_date) ORDER BY ... observed_at DESC.
--   UW's server-side daily_count resets at UTC midnight. When UTC ticks past 0
--   during an ET session (8 PM ET in EDT), the next call's daily_count is fresh
--   (e.g. 1, 2, 169...). The view picks that as the "latest" for the session
--   and the badge shows the post-reset value instead of the day's high-water mark.
--
-- Root cause (Tavily):
--   ct_tavily_usage_monthly + ct_tavily_budget_tier filter
--   `observed_at >= date_trunc('month', now())`. now() is UTC. At UTC midnight
--   on the 1st, the window jumps forward and excludes the previous month's data.
--   This happened to fire 1.5 hours before this fix, hiding April's 158 credits.
--
-- Fix:
--   1. UW: rebuild ct_uw_usage_latest to use MAX(daily_count) within
--      session_date. The day's high-water mark — what we actually care about.
--      All other columns (observed_at, minute_*) come from the latest row.
--   2. Tavily: rebuild both the view and the RPC to use ET-month boundaries
--      via `(now() AT TIME ZONE 'America/New_York')`. Month rollover happens
--      at midnight ET, not midnight UTC.
--
-- Class kill, not patch: any future budget view follows the same pattern —
-- ET session day, ET month, MAX value within bucket. Not "latest observed_at"
-- and not "now() in UTC".
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) UW — rebuild ct_uw_usage_latest using MAX(daily_count) per session_date.
-- ----------------------------------------------------------------------------
DROP VIEW IF EXISTS public.ct_uw_usage_latest;
CREATE VIEW public.ct_uw_usage_latest AS
WITH peak AS (
  SELECT
    session_date,
    MAX(daily_count)                             AS daily_count,
    MAX(daily_limit)                             AS daily_limit
  FROM public.ct_uw_usage
  WHERE daily_count IS NOT NULL
  GROUP BY session_date
),
latest AS (
  SELECT DISTINCT ON (session_date)
    session_date,
    observed_at,
    minute_counter,
    minute_remaining,
    minute_reset_at
  FROM public.ct_uw_usage
  WHERE daily_count IS NOT NULL
  ORDER BY session_date DESC, observed_at DESC
)
SELECT
  peak.session_date,
  latest.observed_at,
  peak.daily_count,
  peak.daily_limit,
  CASE
    WHEN peak.daily_limit > 0
    THEN ROUND(peak.daily_count::numeric / peak.daily_limit::numeric * 100, 1)
    ELSE NULL
  END                                             AS pct,
  latest.minute_counter,
  latest.minute_remaining,
  latest.minute_reset_at
FROM peak
JOIN latest USING (session_date);

GRANT SELECT ON public.ct_uw_usage_latest TO authenticated;

COMMENT ON VIEW public.ct_uw_usage_latest IS
  'Per-session UW budget snapshot. daily_count is the session high-water mark (MAX), which survives UTC-midnight resets of UW server-side counter. observed_at + minute_* come from the latest row — the live tail.';

-- ----------------------------------------------------------------------------
-- 2) Tavily — rebuild ct_tavily_usage_monthly with ET-month boundaries.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.ct_tavily_usage_monthly AS
WITH cfg AS (
  SELECT
    COALESCE((SELECT (value)::int FROM ct_config WHERE key = 'tavily_monthly_limit'), 4000) AS monthly_limit
),
et_month_start AS (
  -- Month boundary in ET, then converted back to UTC for filtering observed_at.
  -- Example: 2026-05-01 02:24 UTC = 2026-04-30 22:24 ET → ET month is April,
  -- so window starts 2026-04-01 00:00 ET = 2026-04-01 04:00 UTC.
  SELECT (date_trunc('month', (now() AT TIME ZONE 'America/New_York'))
          AT TIME ZONE 'America/New_York') AS start_utc
),
charged AS (
  SELECT
    to_char(date_trunc('month', (now() AT TIME ZONE 'America/New_York')), 'YYYY-MM') AS month,
    COALESCE(SUM(credits_charged), 0)::bigint AS monthly_count
  FROM ct_tavily_usage, et_month_start
  WHERE observed_at >= et_month_start.start_utc
    AND status >= 200 AND status < 300
)
SELECT
  charged.month,
  charged.monthly_count,
  cfg.monthly_limit,
  ROUND((charged.monthly_count::numeric / NULLIF(cfg.monthly_limit, 0)) * 100, 1) AS pct,
  (SELECT MAX(observed_at) FROM ct_tavily_usage, et_month_start
   WHERE observed_at >= et_month_start.start_utc) AS last_call_at
FROM charged, cfg;

GRANT SELECT ON public.ct_tavily_usage_monthly TO authenticated, service_role;

COMMENT ON VIEW public.ct_tavily_usage_monthly IS
  'Tavily month-to-date credit counter. Month boundary is ET (America/New_York), not UTC — so the badge does not "reset" during evening trading hours when UTC ticks into the next month while ET is still in the previous one.';

-- ----------------------------------------------------------------------------
-- 3) Tavily — rebuild ct_tavily_budget_tier() with ET-month boundaries.
--    Same window logic as the view above.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.ct_tavily_budget_tier()
RETURNS TABLE (
  tier            text,
  monthly_count   bigint,
  monthly_limit   int,
  pct_used        numeric
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
  WITH cfg AS (
    SELECT
      COALESCE((SELECT (value)::int     FROM ct_config WHERE key = 'tavily_monthly_limit'),  4000) AS monthly_limit,
      COALESCE((SELECT (value)::numeric FROM ct_config WHERE key = 'tavily_tighten_pct'),    0.70) AS tighten,
      COALESCE((SELECT (value)::numeric FROM ct_config WHERE key = 'tavily_critical_pct'),   0.90) AS critical_,
      COALESCE((SELECT (value)::numeric FROM ct_config WHERE key = 'tavily_exhausted_pct'),  0.95) AS exhausted
  ),
  et_month_start AS (
    SELECT (date_trunc('month', (now() AT TIME ZONE 'America/New_York'))
            AT TIME ZONE 'America/New_York') AS start_utc
  ),
  used AS (
    SELECT COALESCE(SUM(credits_charged), 0)::bigint AS cnt
    FROM ct_tavily_usage, et_month_start
    WHERE observed_at >= et_month_start.start_utc
      AND status >= 200 AND status < 300
  )
  SELECT
    CASE
      WHEN cfg.monthly_limit <= 0 THEN 'unrestricted'
      WHEN (used.cnt::numeric / cfg.monthly_limit) >= cfg.exhausted THEN 'exhausted'
      WHEN (used.cnt::numeric / cfg.monthly_limit) >= cfg.critical_ THEN 'critical'
      WHEN (used.cnt::numeric / cfg.monthly_limit) >= cfg.tighten   THEN 'tightened'
      ELSE 'unrestricted'
    END                                                   AS tier,
    used.cnt                                              AS monthly_count,
    cfg.monthly_limit                                     AS monthly_limit,
    ROUND((used.cnt::numeric / NULLIF(cfg.monthly_limit, 0)) * 100, 1) AS pct_used
  FROM cfg, used;
$$;

GRANT EXECUTE ON FUNCTION public.ct_tavily_budget_tier() TO authenticated, service_role;

COMMENT ON FUNCTION public.ct_tavily_budget_tier() IS
  'Returns current Tavily monthly budget tier. Counts successful (2xx) calls in current ET-calendar month against tavily_monthly_limit config. ET boundary (not UTC) so the tier does not flip during evening trading hours. Used by tavilyClient + UI badge.';
