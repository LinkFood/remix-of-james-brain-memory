-- =============================================================================
-- 20260506120000_flow_heatmap_config_and_warden.sql
--
-- Phase B for the 2026-05-06 flow-heatmap front-week buckets audit.
-- Phase A: docs/audit/2026-05-06-flow-heatmap-front-week-buckets-phase-a.md
--
-- Two tightly-coupled changes that must ship together:
--
-- C. Lift the helper's hardcoded magic numbers (p_include_0dte=false, cap=3,
--    p_min_premium=100k, p_max_expiry_days=180, p_lookback_hours=168,
--    p_math_mode='aggressive_directional_decay') into ct_config with both
--    global defaults and per-consumer overrides. Tenet 16: every number
--    tunable, config in ct_config, no hardcoded thresholds.
--
--    Global defaults are CAPTAIN-CORRECT (include_0dte=true, cap=6) so any
--    consumer that doesn't have a specific override gets full front-week
--    visibility. Per-consumer overrides PRESERVE existing behavior for the
--    4 cron consumers + ct-chat that were running before this PR. Only
--    cotrader-mcp (no override row) inherits the new captain-correct
--    defaults.
--
-- D. New warden invariant: flow_heatmap_front_week_coverage. Watchlist
--    tickers with > threshold of premium expiring in the next 7 days MUST
--    appear with a front-week bucket in the heatmap output (under global
--    config defaults). Detects regressions: if the helper or RPC silently
--    starts dropping front-week data again, we surface within 30 min instead
--    of in a trading-session post-hoc. Severity: warn. Threshold itself is
--    in ct_config (Tenet 16 recursion).
-- =============================================================================

SET search_path = public, extensions;

-- -----------------------------------------------------------------------------
-- C: ct_config rows for flow_heatmap.*
-- -----------------------------------------------------------------------------

-- Global defaults — captain-correct. Consumers without a specific override
-- inherit these. cotrader-mcp falls into this bucket → MCP captain finally
-- sees front-week 0DTE flow.
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('flow_heatmap.include_0dte', 'true'::jsonb,
    'Whether ct_flow_heatmap_live includes 0DTE expiry rows. Global default true (captain-correct). Per-consumer overrides at flow_heatmap.consumer.<name>.include_0dte preserve pre-2026-05-06 behavior.',
    'flow_heatmap', NULL, NULL, 'true'::jsonb),
  ('flow_heatmap.cap', '6'::jsonb,
    'Max stacks per ticker in heatmap output, sorted by abs(value) desc. Global default 6 — front-week visibility for tickers where 5/8 ranks #4-5 today. Old default 3.',
    'flow_heatmap', 1, 20, '6'::jsonb),
  ('flow_heatmap.min_premium', '100000'::jsonb,
    'Minimum |aggregate value| for a (ticker, expiry_bucket_week) cell to survive into heatmap output. Was hardcoded $100k.',
    'flow_heatmap', 1000, 100000000, '100000'::jsonb),
  ('flow_heatmap.max_expiry_days', '180'::jsonb,
    'Furthest expiry days to consider. RPC default is 365; helper passed 180. Default 180 matches helper.',
    'flow_heatmap', 7, 365, '180'::jsonb),
  ('flow_heatmap.lookback_hours', '168'::jsonb,
    'Window of ct_flow_alerts to scan, in hours. Default 168h = 7d.',
    'flow_heatmap', 1, 720, '168'::jsonb),
  ('flow_heatmap.math_mode', '"aggressive_directional_decay"'::jsonb,
    'Math mode the heatmap RPC computes. One of: total, net_signed, aggressive_directional_raw, aggressive_directional_decay (default), voi_unusual.',
    'flow_heatmap', NULL, NULL, '"aggressive_directional_decay"'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- D-related: warden threshold for the new invariant.
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('flow_heatmap.warden.front_week_premium_threshold', '100000'::jsonb,
    'Per-ticker premium threshold for the flow_heatmap_front_week_coverage warden invariant. If a watchlist ticker has > this premium of source flow with expiry in next 7 days but the heatmap output does not contain a bucket within 7 days for that ticker, the invariant fires (warn). Tunable via ct_config to avoid false-tripping in low-flow windows.',
    'flow_heatmap', 1000, 100000000, '100000'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Per-consumer overrides — preserve existing behavior for the 5 known consumers
-- that were running pre-2026-05-06. Each consumer gets explicit include_0dte
-- and cap rows. They can be flipped to NULL or removed later to opt into the
-- new captain-correct defaults.
INSERT INTO public.ct_config (key, value, description, category, min_value, max_value, default_value) VALUES
  ('flow_heatmap.consumer.ct-eod-report.include_0dte', 'false'::jsonb,
    'Per-consumer override preserving pre-2026-05-06 ct-eod-report behavior. Set NULL or delete to inherit global default.',
    'flow_heatmap', NULL, NULL, 'false'::jsonb),
  ('flow_heatmap.consumer.ct-eod-report.cap', '3'::jsonb,
    'Per-consumer override preserving pre-2026-05-06 ct-eod-report behavior.',
    'flow_heatmap', 1, 20, '3'::jsonb),

  ('flow_heatmap.consumer.ct-eod-summary.include_0dte', 'false'::jsonb,
    'Per-consumer override preserving pre-2026-05-06 ct-eod-summary behavior.',
    'flow_heatmap', NULL, NULL, 'false'::jsonb),
  ('flow_heatmap.consumer.ct-eod-summary.cap', '3'::jsonb,
    'Per-consumer override preserving pre-2026-05-06 ct-eod-summary behavior.',
    'flow_heatmap', 1, 20, '3'::jsonb),

  ('flow_heatmap.consumer.ct-daily-brief.include_0dte', 'false'::jsonb,
    'Per-consumer override preserving pre-2026-05-06 ct-daily-brief behavior.',
    'flow_heatmap', NULL, NULL, 'false'::jsonb),
  ('flow_heatmap.consumer.ct-daily-brief.cap', '3'::jsonb,
    'Per-consumer override preserving pre-2026-05-06 ct-daily-brief behavior.',
    'flow_heatmap', 1, 20, '3'::jsonb),

  ('flow_heatmap.consumer.ct-trade-idea-generator.include_0dte', 'false'::jsonb,
    'Per-consumer override preserving pre-2026-05-06 ct-trade-idea-generator behavior.',
    'flow_heatmap', NULL, NULL, 'false'::jsonb),
  ('flow_heatmap.consumer.ct-trade-idea-generator.cap', '3'::jsonb,
    'Per-consumer override preserving pre-2026-05-06 ct-trade-idea-generator behavior.',
    'flow_heatmap', 1, 20, '3'::jsonb),

  ('flow_heatmap.consumer.ct-chat.include_0dte', 'false'::jsonb,
    'Per-consumer override preserving pre-2026-05-06 ct-chat behavior. ct-chat reads the legacy flat-fields path in claudeReadSurface.ts which is also config-driven post-this-migration.',
    'flow_heatmap', NULL, NULL, 'false'::jsonb),
  ('flow_heatmap.consumer.ct-chat.cap', '3'::jsonb,
    'Per-consumer override preserving pre-2026-05-06 ct-chat behavior.',
    'flow_heatmap', 1, 20, '3'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- -----------------------------------------------------------------------------
-- D: warden invariant flow_heatmap_front_week_coverage
-- -----------------------------------------------------------------------------
--
-- Detects: watchlist tickers with material front-week premium in source flow
-- (next 7 days expiry, last 168h ingest, premium > config threshold) that do
-- NOT appear with any front-week bucket (expiry_bucket_week <= today + 7) in
-- ct_flow_heatmap_live's output under the global config defaults.
--
-- metric_value = count of tickers in the gap. expected_max = 0.
-- Severity: warn (won't false-trip in low-flow windows because the threshold
-- itself filters out tickers with no material premium).
-- -----------------------------------------------------------------------------

INSERT INTO public.ct_invariants (name, category, description, query_sql, expected_min, expected_max, expected_bool, severity, runbook_path) VALUES
  ('flow_heatmap_front_week_coverage',
   'synthesis',
   'Watchlist tickers with > flow_heatmap.warden.front_week_premium_threshold of source flow expiring in next 7 days must appear with a front-week bucket in ct_flow_heatmap_live output under global config defaults. Catches regressions where the helper or RPC silently starts dropping front-week data.',
$$
WITH source_front_week AS (
  SELECT
    a.ticker,
    SUM(a.premium) AS prem
  FROM public.ct_flow_alerts a
  WHERE a.ticker = ANY(ARRAY['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','QQQ','SPY','IWM'])
    AND a.expiry IS NOT NULL
    AND a.expiry::date >= CURRENT_DATE
    AND a.expiry::date <= CURRENT_DATE + 7
    AND a.premium IS NOT NULL
    AND a.premium > 0
    AND a.ingested_at >= now() - interval '168 hours'
  GROUP BY a.ticker
  HAVING SUM(a.premium) > (
    SELECT (value::text)::numeric
    FROM public.ct_config
    WHERE key = 'flow_heatmap.warden.front_week_premium_threshold'
  )
),
heatmap_front_week AS (
  SELECT DISTINCT ticker
  FROM public.ct_flow_heatmap_live(
    ARRAY['NVDA','AAPL','MSFT','GOOGL','AMZN','META','TSLA','QQQ','SPY','IWM'],
    (SELECT trim(both '"' FROM (value)::text) FROM public.ct_config WHERE key = 'flow_heatmap.math_mode'),
    (SELECT (value::text)::numeric FROM public.ct_config WHERE key = 'flow_heatmap.min_premium'),
    (SELECT (value::text)::boolean FROM public.ct_config WHERE key = 'flow_heatmap.include_0dte'),
    (SELECT (value::text)::int     FROM public.ct_config WHERE key = 'flow_heatmap.max_expiry_days'),
    (SELECT (value::text)::int     FROM public.ct_config WHERE key = 'flow_heatmap.lookback_hours')
  )
  WHERE expiry_bucket_week <= CURRENT_DATE + 7
)
SELECT
  COUNT(*)::numeric AS metric_value,
  COALESCE(
    'tickers_with_premium_but_no_heatmap_front_week: ' || string_agg(s.ticker, ',' ORDER BY s.prem DESC),
    'all_tickers_with_front_week_premium_have_heatmap_coverage'
  ) AS message
FROM source_front_week s
LEFT JOIN heatmap_front_week h USING (ticker)
WHERE h.ticker IS NULL
$$,
   NULL,                                                          -- expected_min
   0,                                                             -- expected_max
   NULL,                                                          -- expected_bool
   'warn',                                                        -- severity
   'docs/audit/2026-05-06-flow-heatmap-front-week-buckets-phase-a.md')
ON CONFLICT (name) DO UPDATE
  SET query_sql      = EXCLUDED.query_sql,
      description    = EXCLUDED.description,
      expected_min   = EXCLUDED.expected_min,
      expected_max   = EXCLUDED.expected_max,
      severity       = EXCLUDED.severity,
      runbook_path   = EXCLUDED.runbook_path,
      category       = EXCLUDED.category;
