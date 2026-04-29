-- =============================================================================
-- 20260429230000_tavily_budget_tracking.sql
--
-- Local Tavily usage tracking + monthly budget tier guard. Tavily exposes no
-- API for remaining-credits, so we count successful (2xx) calls ourselves and
-- compare against a configured monthly_limit. Same shape as the UW budget
-- system (ct_uw_usage / ct_uw_budget_ok / ct_uw_alarm_state).
--
-- Pricing reference (verified 2026-04-29 from docs.tavily.com):
--   Search basic     = 1 credit / call
--   Search advanced  = 2 credits / call
--   Project plan     = 4,000 credits / month at $30
--   Counter resets   = calendar month rollover
--
-- Audit at 96/4000 used (2026-04-29) projected ~10,140 credits/month at status
-- quo. New architecture targets ~1,704 credits/month (43% of budget).
-- =============================================================================
SET search_path = public, extensions;

-- ----------------------------------------------------------------------------
-- 1) ct_tavily_usage — per-call log. Successful 2xx calls bill against budget.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_tavily_usage (
  id              bigserial PRIMARY KEY,
  observed_at     timestamptz NOT NULL DEFAULT now(),
  caller          text,                          -- ct-news-sweep / ct-tavily-news-watcher / jac-web-search
  query           text,                          -- search query (trimmed to 500 chars by client)
  search_depth    text,                          -- 'basic' | 'advanced'
  topic           text,                          -- 'news' | 'general' | null
  results_count   int,
  credits_charged int  NOT NULL DEFAULT 1,       -- basic=1, advanced=2; client decides
  status          int,                           -- HTTP status (2xx=billed, others=free)
  error           text,
  ms              int
);

CREATE INDEX IF NOT EXISTS idx_ct_tavily_usage_observed
  ON public.ct_tavily_usage (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_tavily_usage_caller_observed
  ON public.ct_tavily_usage (caller, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ct_tavily_usage_status_observed
  ON public.ct_tavily_usage (status, observed_at DESC);

ALTER TABLE public.ct_tavily_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_tavily_usage_read ON public.ct_tavily_usage;
CREATE POLICY ct_tavily_usage_read ON public.ct_tavily_usage
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_tavily_usage_svc ON public.ct_tavily_usage;
CREATE POLICY ct_tavily_usage_svc ON public.ct_tavily_usage
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 2) ct_tavily_alarm_state — one-fire-per-month-per-tier Slack alarm tracking.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ct_tavily_alarm_state (
  id                            integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_tightened_alarm_month    text,    -- YYYY-MM
  last_critical_alarm_month     text,
  last_exhausted_alarm_month    text,
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.ct_tavily_alarm_state (id) VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE public.ct_tavily_alarm_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ct_tavily_alarm_state_read ON public.ct_tavily_alarm_state;
CREATE POLICY ct_tavily_alarm_state_read ON public.ct_tavily_alarm_state
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS ct_tavily_alarm_state_svc ON public.ct_tavily_alarm_state;
CREATE POLICY ct_tavily_alarm_state_svc ON public.ct_tavily_alarm_state
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- 3) ct_config keys — monthly limit + tier thresholds + per-caller kill flags.
-- ----------------------------------------------------------------------------
INSERT INTO ct_config (key, value, description, category, default_value) VALUES
  ('tavily_monthly_limit', '4000'::jsonb,
    'Tavily monthly credit allotment (Project tier = 4000).',
    'tavily_budget', '4000'::jsonb),
  ('tavily_tighten_pct', '0.70'::jsonb,
    'Tier: drop news-sweep to top 5 hot tickers at this fraction of monthly cap.',
    'tavily_budget', '0.70'::jsonb),
  ('tavily_critical_pct', '0.90'::jsonb,
    'Tier: critical — news-sweep top 2 hot tickers, jac-web-search refuses.',
    'tavily_budget', '0.90'::jsonb),
  ('tavily_exhausted_pct', '0.95'::jsonb,
    'Tier: halt all Tavily callers until month rollover.',
    'tavily_budget', '0.95'::jsonb),
  ('news_sweep_hot_ticker_lookback_min', '30'::jsonb,
    'How far back ct-news-sweep looks at ct_flags for hot-ticker selection.',
    'tavily_budget', '30'::jsonb),
  ('tavily_caller.ct-news-sweep.enabled', 'true'::jsonb,
    'Kill switch — set false to disable ct-news-sweep without redeploy.',
    'tavily_budget', 'true'::jsonb),
  ('tavily_caller.ct-tavily-news-watcher.enabled', 'true'::jsonb,
    'Kill switch — set false to disable ct-tavily-news-watcher without redeploy.',
    'tavily_budget', 'true'::jsonb),
  ('tavily_caller.jac-web-search.enabled', 'true'::jsonb,
    'Kill switch — set false to disable jac-web-search without redeploy.',
    'tavily_budget', 'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 4) ct_tavily_usage_monthly view — month-to-date counter. Resets automatically
--    on calendar month rollover via date_trunc.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.ct_tavily_usage_monthly AS
WITH cfg AS (
  SELECT
    COALESCE((SELECT (value)::int FROM ct_config WHERE key = 'tavily_monthly_limit'), 4000) AS monthly_limit
),
charged AS (
  SELECT
    to_char(date_trunc('month', now()), 'YYYY-MM') AS month,
    COALESCE(SUM(credits_charged), 0)::bigint      AS monthly_count
  FROM ct_tavily_usage
  WHERE observed_at >= date_trunc('month', now())
    AND status >= 200 AND status < 300
)
SELECT
  charged.month,
  charged.monthly_count,
  cfg.monthly_limit,
  ROUND((charged.monthly_count::numeric / NULLIF(cfg.monthly_limit, 0)) * 100, 1) AS pct,
  (SELECT MAX(observed_at) FROM ct_tavily_usage WHERE observed_at >= date_trunc('month', now())) AS last_call_at
FROM charged, cfg;

GRANT SELECT ON public.ct_tavily_usage_monthly TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 5) ct_tavily_budget_tier() — single-call tier check, used by every caller.
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
  used AS (
    SELECT COALESCE(SUM(credits_charged), 0)::bigint AS cnt
    FROM ct_tavily_usage
    WHERE observed_at >= date_trunc('month', now())
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
  'Returns current Tavily monthly budget tier. Counts successful (2xx) calls in current calendar month against tavily_monthly_limit config. Used by tavilyClient + UI badge.';
